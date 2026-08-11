// src/mcp-app.ts - Config Monitor UI (iframe side). Talks to host via App bridge.
//   get_config       -> collapsible config sections (with source path)
//   get_tracked      -> tracked file rows (click -> history)
//   get_file_history -> revision timeline
//   get_diff         -> from->to unified diff
//   config_*/config_restore/watcher_* -> inline edit / restore / watcher control
//   updateModelContext -> inject what the user is viewing into Claude context
import { app, STANDALONE, callTool, pushCtx, jparse, jparseLast } from "./ui/bridge";
import { t, getLang, setLang } from "./ui/i18n";
import { $, esc, setPending, clearPending, openModal, mkNotice, openReasonModal, modalActions, flashToast } from "./ui/widgets";
import {
  selectedPath, setSelectedPath, currentRevs, setCurrentRevs, fromRev, setFromRev, toRev, setToRev,
  detailOpen, setDetailOpen, collapsed, ccPlugins, ccMarkets, ccCatalog, setCcCatalog,
  knownProjects, setKnownProjects, cmMarketUrls, cmMarketsNoUrl, OFFICIAL_MARKET_URL, normUrl,
  secTitles, collapsedInit, setCollapsedInit, showPlugin, setShowPlugin, showBuiltin, setShowBuiltin,
  libGroupOpen, ROOT_GROUP_KEY, libChecked, libOpen, libProjectTargets, setLibProjectTargets,
  libTarget, setLibTarget, libSelBarUpdate, setLibSelBarUpdate, scopeFilter, setScopeFilter,
  srcOpen, lastConfigSections, setLastConfigSections, refreshApp, setRefreshApp, catOpen,
  catSecEl, setCatSecEl,
} from "./ui/state";
import { valClass, basename, dirname, ABS_PATH_RE, safeSegment, looksLikePermRule, originShort, mkSrcTag } from "./ui/helpers";
import { renderConfig } from "./ui/config";
import { selectFile, renderHistory, renderDiffFor, applyDetailState } from "./ui/detail";
import { renderCatalog } from "./ui/market";
import { openMarketAdd, openLibAdd } from "./ui/libmarket";
import { renderTracked } from "./ui/tracked";

// ----- Library section (라이브러리 토글: /plugin 식 설치/제거) -----
const libStatus = (s: string): [string, string] =>
  (({ not_installed: [t("libNotInstalled"), ""], installed: [t("libInstalled"), "ok"],
      modified: [t("libModified"), "warn"], conflict: [t("libConflict"), "err"] } as Record<string, [string, string]>)[s] || [s, ""]);

// 라이브러리 등록 진입점. 입력칸을 섹션 본문에 상주시키지 않고 Marketplace 와 같은
// 버튼 -> 모달 흐름으로 맞춘다(openMarketAdd 참고). 전송 방식(로컬/원격)은 사용자가 고르는
// 것이 아니라 입력에서 판별하므로 칸도 하나다.
function buildLibAdder(): HTMLElement {
  const b = document.createElement("button");
  b.className = "addbtn";
  b.textContent = "＋ " + t("libAdd");
  b.addEventListener("click", () => openLibAdd(""));
  return b;
}

// 항목(스킬/에이전트/커맨드) 액션 버튼: 상태별 설치/동기화/제거. 설치는 relpath(가변 깊이) + lib 로 지정.
function mkItemActions(it: any): HTMLElement {
  const act = document.createElement("div");
  act.className = "edit";
  const mk = (txt: string, run: () => Promise<string>, confirmTxt?: string) => {
    const b = document.createElement("button");
    b.className = "addbtn";
    b.textContent = txt;
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirmTxt && b.textContent !== confirmTxt) { b.textContent = confirmTxt; return; } // 2-click 확인
      setPending(b);
      try {
        const r = jparse(await run());
        if (r && r.ok === false) {
          // 행 하나짜리 동작이라 인라인 슬롯을 둘 자리가 없다. 토스트로 알리되 사유를
          // 버튼 title 에도 남긴다 - 토스트가 사라진 뒤에도 되짚어 읽을 수 있어야 한다.
          const msg = r.message || t("failed");
          flashToast(msg);
          clearPending(b, t("failed"));
          b.title = msg;
          return;
        }
        b.title = "";
        flashToast(`${txt} ${t("done")} · ${it.name}`);
        await refreshApp?.();
      } catch (err) {
        clearPending(b, t("failed"));
        b.title = String(err);
        flashToast(String(err));
        console.error("[config-monitor] library", err);
      }
    });
    return b;
  };
  const doInstall = () => callTool("library_install", { category: it.category, path: it.relpath, lib: it.lib, origin: it.origin, targetDir: libTarget || undefined });
  const doRemove = () => callTool("library_uninstall", { category: it.category, name: it.name, origin: it.origin, targetDir: libTarget || undefined });
  if (it.status === "not_installed") act.appendChild(mk(t("libInstall"), doInstall));
  if (it.status === "modified") act.appendChild(mk(t("libSync"), doInstall, t("libSyncConfirm")));
  if (it.status === "conflict") {
    // 소유자가 다르다. 동기화가 아니라 명시적 덮어쓰기이고, 누구 것을 덮는지 보여준다.
    const b = mk(t("libConflictOverwrite"), doInstall, t("libConflictConfirm"));
    if (it.owner) b.title = `${t("libOwnedBy")}: ${it.owner}`;
    act.appendChild(b);
  }
  if (it.status !== "not_installed") act.appendChild(mk(t("remove"), doRemove, t("libUninstallConfirm")));
  return act;
}

const libKey = (it: any): string => `${it.lib}|${it.category}|${it.relpath}`;

// 여러 항목 순차 설치 후 1회 새로고침(설치마다 새로고침하면 100+개에서 폭주).
// 설치 대상은 공용 상태 libTarget("" 이면 전역 ~/.claude). done: 완료 토스트 빌더(그룹/선택 설치가 서로 다른 문구).
interface InstallOpts { done?: (ok: number, fail: number) => string; }
async function installMany(items: any[], opts: InstallOpts = {}): Promise<void> {
  let ok = 0;
  // 실패는 개수만 세지 않는다 - "3 실패"만으로는 무엇을 다시 시도해야 하는지 알 수 없어
  // 사용자가 100개짜리 목록을 눈으로 훑어야 한다. 어느 항목이 왜 실패했는지 모아 둔다.
  const failures: string[] = [];
  for (const it of items) {
    const args: Record<string, unknown> = { category: it.category, path: it.relpath, lib: it.lib };
    if (libTarget) args.targetDir = libTarget;
    try {
      const r = jparse(await callTool("library_install", args));
      if (r && r.ok === false) failures.push(`${it.name} — ${r.message || t("failed")}`);
      else ok++;
    } catch (e) { failures.push(`${it.name} — ${String(e)}`); }
  }
  libChecked.clear();
  const fail = failures.length;
  const failSfx = fail ? ` · ${fail} ${t("failed")}` : "";
  flashToast((opts.done ? opts.done(ok, fail) : `${t("libInstall")} ${ok} ${t("done")}`) + failSfx);
  await refreshApp?.();
  if (fail) openReasonModal(t("installFailTitle"), `${fail} / ${items.length}`, failures);
}

// 콤팩트 항목 행: [체크박스] name [배지] [설치/동기화/제거]. 전 카테고리(agents/commands/skills) 공용.
function mkLibRow(it: any): HTMLElement {
  const [label, cls] = libStatus(it.status);
  const row = document.createElement("div");
  row.className = "libskill librow";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "libcb";
  cb.checked = libChecked.has(libKey(it));
  cb.addEventListener("change", () => {
    if (cb.checked) libChecked.add(libKey(it)); else libChecked.delete(libKey(it));
    libSelBarUpdate?.();
  });
  const nm = document.createElement("span");
  nm.className = "sknm";
  nm.textContent = it.name;
  const bd = document.createElement("span");
  bd.className = "badge libstat" + (cls ? " " + cls : "");
  bd.textContent = label + (it.kit_ref ? " · " + t("kitRef") : "");
  if (it.status === "conflict" && it.owner) bd.title = `${t("libOwnedBy")}: ${it.owner}`;
  // 칸 순서는 이름 -> 출처 -> 상태. 찾는 단서는 이름이므로 목록을 훑을 때 먼저 와야 한다.
  // 예전에는 출처가 첫 칸이었다. 꼬리에 달면 남는 폭이 없어 매번 말줄임으로 잘렸기 때문인데,
  // 그건 순서 탓이 아니라 flex 탓이었다 - 이름이 basis 0(flex:1)이라 폭이 모자랄 때 basis auto 인
  // 출처 칸이 먼저 줄어들었다. .libskill .libsrc 를 shrink 0 으로 고정해 이름이 대신 줄바꿈되게
  // 바꿨으므로(dashboard.html), 이제 뒤에 두어도 출처가 잘리지 않는다.
  row.append(cb, nm, mkSrcTag(it.origin, it.lib), bd, mkItemActions(it));
  return row;
}

// 스킬을 group 경로(가변 깊이)로 트리화. 폴더 그룹은 접이식+그룹설치, 폴더 없는 루트 항목은 구분선 아래 나열.
function renderSkillTreeBody(skills: any[]): HTMLElement {
  interface Node { dirs: Map<string, Node>; skills: any[]; }
  const root: Node = { dirs: new Map(), skills: [] };
  for (const it of skills) {
    let node = root;
    for (const seg of it.group ? String(it.group).split("/") : []) {
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), skills: [] });
      node = node.dirs.get(seg)!;
    }
    node.skills.push(it);
  }
  const collect = (node: Node): any[] => {
    let out = node.skills.slice();
    for (const c of node.dirs.values()) out = out.concat(collect(c));
    return out;
  };
  // 폴더 그룹만 렌더(루트 loose 항목 제외). 그룹 내부는 renderNode 로 재귀(하위 그룹 + 그 폴더 직속 항목).
  const renderGroups = (node: Node, path: string): HTMLElement => {
    const box = document.createElement("div");
    for (const [seg, child] of node.dirs) {
      const gpath = path ? `${path}/${seg}` : seg;
      const all = collect(child);
      const installed = all.filter((s) => s.status === "installed").length;
      const grp = document.createElement("div");
      grp.className = "libgrp" + (libGroupOpen.has(gpath) ? " open" : "");
      const gh = document.createElement("div");
      gh.className = "libgrphead";
      gh.innerHTML =
        `<span class="chev4">▸</span><span class="gname">${esc(seg)}</span>` +
        `<span class="gcount">${all.length}</span>` +
        (installed ? `<span class="ginst">${installed} ${esc(t("libInstalled"))}</span>` : "");
      const gall = document.createElement("button");
      gall.className = "linkbtn gallbtn";
      gall.textContent = t("libInstallGroup");
      gall.title = t("libInstallGroupHint");
      gall.addEventListener("click", async (e) => {
        e.stopPropagation();
        const pending = all.filter((s) => s.status !== "installed");
        if (!pending.length) { flashToast(t("libAllInstalled")); return; }
        if (gall.textContent !== t("libInstallGroupConfirm")) { gall.textContent = t("libInstallGroupConfirm"); return; }
        await installMany(pending, { done: (n) => `${t("toastGroup")} · ${seg} · ${n}${t("cntUnit")}` });
      });
      gh.appendChild(gall);
      gh.addEventListener("click", () => {
        if (libGroupOpen.has(gpath)) libGroupOpen.delete(gpath); else libGroupOpen.add(gpath);
        grp.classList.toggle("open");
      });
      const gbody = document.createElement("div");
      gbody.className = "libgrpbody";
      gbody.appendChild(renderNode(child, gpath));
      grp.append(gh, gbody);
      box.appendChild(grp);
    }
    return box;
  };
  const renderNode = (node: Node, path: string): HTMLElement => {
    const box = document.createElement("div");
    box.appendChild(renderGroups(node, path));
    for (const it of node.skills) box.appendChild(mkLibRow(it));  // 이 폴더 직속 스킬
    return box;
  };

  const frag = document.createElement("div");
  frag.appendChild(renderGroups(root, ""));
  if (root.skills.length) {
    // 루트 항목도 폴더 그룹처럼 접힌다. 다만 .libgrp 박스로 감싸지 않는다 - 이건 폴더가
    // 아니라 "폴더에 안 들어간 나머지"라, 박스를 두르면 없는 폴더가 하나 있는 것처럼 읽힌다.
    // 구분선 자체가 헤더 역할을 하고, 상태는 그룹과 같은 Set 을 쓴다(경로에 ':' 는 못 들어가
    // 실제 폴더 경로와 키가 겹칠 수 없다).
    const div = document.createElement("div");
    div.className = "librootdiv" + (libGroupOpen.has(ROOT_GROUP_KEY) ? " open" : "");
    div.innerHTML =
      `<span class="rline"></span>` +
      `<span class="chev4">▸</span>` +
      `<span class="rlbl">${esc(t("rootItems"))} · ${root.skills.length}</span>` +
      `<span class="rline"></span>`;
    const rbody = document.createElement("div");
    rbody.className = "librootbody";
    for (const it of root.skills) rbody.appendChild(mkLibRow(it));
    div.addEventListener("click", () => {
      if (libGroupOpen.has(ROOT_GROUP_KEY)) libGroupOpen.delete(ROOT_GROUP_KEY);
      else libGroupOpen.add(ROOT_GROUP_KEY);
      const on = div.classList.toggle("open");
      rbody.classList.toggle("open", on);
    });
    if (libGroupOpen.has(ROOT_GROUP_KEY)) rbody.classList.add("open");
    frag.append(div, rbody);
  }
  return frag;
}

// 카테고리 토글 껍데기: 헤더(chevron + 제목 + 개수 pill + n 설치됨 + 우측 읽기패턴 힌트) + 접이식 본문.
// 본문 구성은 호출부가 넘긴다 - 항목 카테고리(agents/skills/commands)와 유닛 카테고리(hooks/MCP)가
// 행 모양은 달라도 토글·상태 표기 규율은 같아야 하므로 껍데기만 공유한다.
function libCatShell(cat: string, title: string, hint: string, count: number, installed: number,
                     fill: (body: HTMLElement) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "libcat" + (libOpen.has(cat) ? "" : " collapsed");
  const head = document.createElement("div");
  head.className = "libcathead";
  head.innerHTML =
    `<span class="chev2">▾</span><span class="ctitle">${esc(title)}</span>` +
    `<span class="seccount">${count}</span>` +
    (installed ? `<span class="cinst">${installed} ${esc(t("libInstalled"))}</span>` : "") +
    `<span class="chint">${esc(hint)}</span>`;
  head.addEventListener("click", () => {
    if (libOpen.has(cat)) libOpen.delete(cat); else libOpen.add(cat);
    wrap.classList.toggle("collapsed");
  });
  const body = document.createElement("div");
  body.className = "libcatbody";
  fill(body);
  wrap.append(head, body);
  return wrap;
}

function renderCategory(cat: string, items: any[], title: string, hint: string): HTMLElement {
  const installed = items.filter((i) => i.status === "installed").length;
  return libCatShell(cat, title, hint, items.length, installed, (body) => {
    if (!items.length) body.innerHTML = `<div class="empty">${esc(t("libEmpty"))}</div>`;
    else if (cat === "skills") body.appendChild(renderSkillTreeBody(items));
    else for (const it of items) body.appendChild(mkLibRow(it));
  });
}

// hooks/MCP 카테고리: 라이브러리(플러그인 루트) 단위 행. 항목 복사가 아니라 설정 파일 병합이라
// 체크박스 일괄 설치에 섞지 않는다 - 매 세션 실행되는 코드라 한 건씩 확인받아야 한다.
function renderUnitCategory(kind: "hooks" | "mcp", libs: any[], title: string, hint: string): HTMLElement {
  const installed = libs.filter((l) => (kind === "hooks" ? l.hooks_installed : l.mcp_installed)).length;
  return libCatShell(kind, title, hint, libs.length, installed, (body) => {
    if (!libs.length) body.innerHTML = `<div class="empty">${esc(t("unitEmpty"))}</div>`;
    else for (const l of libs) body.appendChild(mkUnitRow(l, kind));
  });
}

// 설치 대상 바(Library 본문 최상단): [설치 대상] [대상 select] ......... [선택 설치 (N)].
// 대상 select 옵션 = "전역(~/.claude)" + 추적 중인 프로젝트 .claude 경로들(libProjectTargets).
// 설치 대상은 추적 중인 경로만 노출한다: 추적되지 않는 경로에 설치하면 대시보드에서 되돌릴 방법이 없다.
// (프로젝트 추가는 추적 패널의 "프로젝트에서 추가" 피커로 한다.)
// 대상 변경 시 그 대상으로 재스캔(refresh) -> 설치됨/변경됨 배지가 대상 기준으로 갱신된다.
function buildTargetBar(allItems: any[]): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "libtbar";
  const lbl = document.createElement("span");
  lbl.className = "tlbl";
  lbl.textContent = t("installTarget");
  const sel = document.createElement("select");
  // 선택돼 있던 대상이 목록에서 사라졌으면(추적 해제) 전역으로 리셋.
  if (libTarget && !libProjectTargets.includes(libTarget)) setLibTarget("");
  sel.innerHTML =
    `<option value="">${esc(t("targetGlobal"))}</option>` +
    libProjectTargets.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  sel.value = libTarget;
  sel.addEventListener("change", async () => { setLibTarget(sel.value); await refreshApp?.(); });
  const selBtn = document.createElement("button");
  selBtn.className = "addbtn selbtn";
  const update = () => {
    const n = allItems.filter((it) => libChecked.has(libKey(it))).length;
    selBtn.textContent = `${t("libInstallSelected")} (${n})`;
    (selBtn as HTMLButtonElement).disabled = n === 0;
    selBtn.style.opacity = n ? "1" : ".5";
  };
  setLibSelBarUpdate(update);
  update();
  selBtn.addEventListener("click", async () => {
    const chosen = allItems.filter((it) => libChecked.has(libKey(it)));
    if (!chosen.length) return;
    await installMany(chosen, { done: (n) => `${t("toastSel")} · ${n}${t("cntUnit")}` });
  });
  bar.append(lbl, sel, selBtn);
  return bar;
}

// hooks/MCP 는 leaf 를 복사하는 항목이 아니라 캐시 경로를 참조하는 복합 유닛이다
// (${CLAUDE_PLUGIN_ROOT} 가 절대 캐시 경로로 치환돼 settings 에 들어간다 - 캐시가 load-bearing).
// 그래서 Library 안에 agents/skills 와 나란한 자체 카테고리로 두고, 설치 대상(libTarget)도 같이 탄다.
// 설치 = 매 세션 임의 코드 실행이므로 dryRun 으로 명령 원문을 먼저 보여주고 확인받는다.
function mkUnitActions(l: any, kind: "hooks" | "mcp", installed: boolean): HTMLElement {
  const act = document.createElement("div");
  act.className = "edit";
  const tool = kind === "hooks" ? "library_hooks_install" : "library_mcp_install";
  const unTool = kind === "hooks" ? "library_hooks_uninstall" : "library_mcp_uninstall";
  // 설치 대상은 항목 설치와 같은 값을 쓴다 - 이걸 빼면 프로젝트 대상을 골라도 전역 settings 에
  // 조용히 쓰고, 원장 키(타깃 루트)가 어긋나 설치됨 배지도 영영 켜지지 않는다.
  const tgt = libTarget ? { targetDir: libTarget } : {};

  const install = document.createElement("button");
  install.className = "addbtn";
  // 이미 설치돼 있으면 같은 도구가 재병합(멱등)이므로 "동기화"로 읽히는 게 정확하다.
  const label = installed ? t("libSync") : t("unitInstall");
  install.textContent = label;
  let confirmed = false;
  install.addEventListener("click", async () => {
    if (!confirmed) {
      setPending(install);
      try {
        const dry = jparse(await callTool(tool, { origin: l.origin, dryRun: true, ...tgt }));
        if (dry && dry.ok === false) {
          clearPending(install, label);
          openReasonModal(t("failed"), dry.message || t("failed"));
          return;
        }
        const cmds: string[] = dry?.commands || (dry?.servers || []);
        const warns: any[] = dry?.warnings || [];
        const warnTxt = warns.map((w) =>
          `${w.interp}: ${w.reason === "stub" ? t("unitInterpStub") : t("unitInterpWarn")}`).join(" · ");
        clearPending(install, t("unitConfirm"));
        install.title = `${t("unitCmdTitle")}\n${cmds.join("\n")}` + (warnTxt ? `\n\n⚠ ${warnTxt}` : "");
        if (warnTxt) flashToast("⚠ " + warnTxt);
        confirmed = true;
      } catch (e) { clearPending(install, t("failed")); console.error("[config-monitor] unit dry-run", e); }
      return;
    }
    setPending(install);
    try {
      const r = jparse(await callTool(tool, { origin: l.origin, ...tgt }));
      if (r && r.ok === false) {
        clearPending(install, label);
        confirmed = false;
        openReasonModal(t("failed"), r.message || t("failed"));
        return;
      }
      // 백엔드가 warning 을 담아 보내면(예: 스토어 미초기화로 출처를 기록 못함) 성공 메시지에 묻혀
      // 사라지면 안 된다 - "성공했지만 알아둬야 할 것" 을 그대로 보여준다.
      flashToast(r?.warning ? `${r?.message || t("done")} ⚠ ${r.warning}` : (r?.message || t("done")));
      await refreshApp?.();
    } catch (e) { clearPending(install, t("failed")); console.error("[config-monitor] unit install", e); }
  });
  act.appendChild(install);

  if (installed) {
    const rm = document.createElement("button");
    rm.className = "addbtn";
    rm.textContent = t("unitRemove");
    rm.addEventListener("click", async () => {
      if (rm.textContent !== t("unitRemoveConfirm")) { rm.textContent = t("unitRemoveConfirm"); return; }
      setPending(rm);
      try {
        const r = jparse(await callTool(unTool, { origin: l.origin, ...tgt }));
        if (r && r.ok === false) {
          clearPending(rm, t("unitRemove"));
          openReasonModal(t("failed"), r.message || t("failed"));
          return;
        }
        flashToast(r?.warning ? `${r?.message || t("done")} ⚠ ${r.warning}` : (r?.message || t("done")));
        await refreshApp?.();
      } catch (e) { clearPending(rm, t("failed")); console.error("[config-monitor] unit uninstall", e); }
    });
    act.appendChild(rm);
  }
  return act;
}

// hooks/MCP 유닛 1행: 항목 행과 같은 칸 순서(이름 · 출처 · 상태 · 동작).
// 이름 칸에는 짧은 이름만 쓴다 - 출처 칸과 같은 문자열을 두 번 그리면 칸 하나를 낭비한다.
function mkUnitRow(l: any, kind: "hooks" | "mcp"): HTMLElement {
  const installed = kind === "hooks" ? !!l.hooks_installed : !!l.mcp_installed;
  const row = document.createElement("div");
  row.className = "libskill librow";
  const nm = document.createElement("span");
  nm.className = "sknm";
  nm.textContent = originShort(l.origin);
  nm.title = l.lib;
  const bd = document.createElement("span");
  bd.className = "badge libstat" + (installed ? " ok" : "");
  bd.textContent = installed ? t("libInstalled") : t("libNotInstalled");
  const detail = kind === "hooks" ? (l.hooks_events || []) : (l.mcp_servers || []);
  if (installed && detail.length) bd.title = detail.join(", ");
  row.append(nm, mkSrcTag(l.origin, l.lib), bd, mkUnitActions(l, kind, installed));
  return row;
}

function renderLibrary(host: HTMLElement, res: any): void {
  const libs = (res && res.libraries) || [];
  // 등록된 라이브러리가 없으면 접힌 채로 두지 않는다: "라이브러리 등록"은 이 섹션 본문
  // 안에만 있어서, 기본 접힘(기동 시 전 섹션 접힘)과 겹치면 처음 쓰는 사람에게 진입점이
  // 아예 안 보인다. Marketplace 가 같은 이유로 같은 처리를 한다.
  if (!libs.length) collapsed.delete("Library");
  const secEl = document.createElement("div");
  secEl.className = "sec" + (collapsed.has("Library") ? " collapsed" : "");
  secEl.dataset.col = "1";
  secTitles.add("Library");
  // 카테고리별 수집(agents/commands/skills). allItems 는 상단 "선택 설치" 카운트/설치 대상용.
  const byCat: Record<string, any[]> = { agents: [], commands: [], skills: [] };
  for (const l of libs) {
    for (const [cat, arr] of Object.entries(l.categories || {})) {
      const bucket = byCat[cat] || (byCat[cat] = []);
      for (const it of arr as any[]) bucket.push({ ...it, category: cat, lib: l.lib });
    }
  }
  const allItems = [...byCat.agents, ...byCat.commands, ...byCat.skills];
  setLibSelBarUpdate(null);  // 이전 렌더의 카운트 훅 무효화(새 설치 대상 바가 다시 설정)
  const head = document.createElement("div");
  head.className = "sechead";
  head.innerHTML =
    `<div class="secrow"><span class="chev2">▾</span>` +
    `<span class="sectitle">${esc(t("libSectionTitle"))}</span>` +
    `<span class="seccount">${allItems.length}</span></div>` +
    (libs.length ? `<div class="secsrc"><span class="lbl">${esc(t("source"))}</span><span class="val">${esc(libs.map((l: any) => l.lib).join(" · "))}</span></div>` : "");
  head.addEventListener("click", () => {
    if (collapsed.has("Library")) collapsed.delete("Library"); else collapsed.add("Library");
    secEl.classList.toggle("collapsed");
  });
  secEl.appendChild(head);

  const body = document.createElement("div");
  body.className = "secbody libbody";  // libbody: 카테고리 토글이 세로로 쌓이도록 그리드 해제
  // 미등록(라이브러리 0개)이라도 섹션 구조는 동일하게: 카테고리 자리에 "라이브러리 항목 없음" + 하단 경로 카드.
  if (!libs.length) {
    body.innerHTML = `<div class="empty">${esc(t("libEmpty"))}</div>`;
  } else {
    body.appendChild(buildTargetBar(allItems));
    body.appendChild(renderCategory("agents", byCat.agents, "Agents", "agents/*.md"));
    body.appendChild(renderCategory("commands", byCat.commands, "Commands", "commands/*.md"));
    body.appendChild(renderCategory("skills", byCat.skills, "Skills", "skills/<name>/SKILL.md"));
    body.appendChild(renderUnitCategory("hooks", libs.filter((l: any) => l.has_hooks),
                                        "Hooks", t("unitHooksHint")));
    body.appendChild(renderUnitCategory("mcp", libs.filter((l: any) => l.has_mcp),
                                        "MCP", t("unitMcpHint")));
  }
  // 다중 라이브러리 경로 관리(전체 폭): 등록된 경로 목록(제거 가능) + 신규 경로 등록 입력행.
  // env(CLAUDE_CONFIG_LIBRARIES) 지정 경로는 대시보드에서 제거 불가 -> env 태그만 표시.
  const mkPathChip = (l: any): HTMLElement => {
    const chip = document.createElement("div");
    chip.className = "chip";
    const txt = document.createElement("span");
    txt.className = "ctxt";
    txt.textContent = l.lib + (l.error ? ` · ${l.error}` : "");
    chip.appendChild(txt);
    if (l.source !== "registered") {
      const tag = document.createElement("span");
      tag.className = "libenv";
      tag.textContent = l.source === "env" ? t("libEnvTag")
        : l.source === "remote" ? t("libRemoteTag") : t("libMarketTag");
      if (l.source === "env") tag.title = t("libEnvHint");
      chip.appendChild(tag);
      if (l.sha) {
        const sha = document.createElement("span");
        sha.className = "libenv";
        sha.textContent = String(l.sha).slice(0, 7);       // 고정 sha 표시 - 자동 pull 이 없다는 신호
        sha.title = String(l.sha);
        chip.appendChild(sha);
      }
      if (l.source !== "env") {
        const age = document.createElement("span");
        age.className = "libenv";
        const days = l.fetched_at ? Math.floor((Date.now() - Date.parse(l.fetched_at)) / 86400000) : null;
        age.textContent = days === null || Number.isNaN(days) ? t("libNeverFetched") : `${days}${t("libStale")}`;
        chip.appendChild(age);
      }
      // env(CLAUDE_CONFIG_LIBRARIES) 지정 경로만 대시보드에서 제거 불가 -> ✕ 미표시.
      // remote/market 은 library_unregister --origin(Task 15) 이 캐시까지 정리하고, 원장이 그 캐시를
      // 참조 중이면 거부(held_by) 하므로 ✕ 를 그려도 안전하다 - 아래 공용 ✕ 로 흘려보낸다.
      if (l.source === "env") return chip;
    }
    const x = document.createElement("button");
    x.className = "cx";
    x.textContent = "✕";
    x.title = t("remove");
    x.addEventListener("click", () => {
      const ok = document.createElement("button");
      ok.className = "ok";
      ok.textContent = t("remove");
      const no = document.createElement("button");
      no.className = "no";
      no.textContent = t("cancel");
      chip.replaceChildren(txt, ok, no);
      no.addEventListener("click", () => chip.replaceWith(mkPathChip(l)));
      ok.addEventListener("click", async () => {
        setPending(ok);
        try {
          const args = l.source === "registered" ? { lib: l.lib } : { origin: l.origin };
          const r = jparse(await callTool("library_unregister", args));
          if (r && r.ok === false) {
            // 원장 가드 거부: 무엇이 캐시를 붙들고 있는지 보여준다(강제 옵션은 두지 않는다).
            // 목록을 토스트에 이어붙이면 길어서 잘리는데, 정작 그 목록이 다음에 할 일을 정한다.
            openReasonModal(t("heldTitle"), r.message || t("failed"), r.held_by || []);
            chip.replaceWith(mkPathChip(l));
            return;
          }
          flashToast(r?.message || (t("libPathRemoved") + " · " + basename(l.lib)));
          await refreshApp?.();
        } catch (e) { flashToast(t("failed")); console.error("[config-monitor] lib unregister", e); chip.replaceWith(mkPathChip(l)); }
      });
    });
    chip.appendChild(x);
    return chip;
  };
  const pathsWrap = document.createElement("div");
  pathsWrap.style.gridColumn = "1 / -1";
  const pathsLbl = document.createElement("div");
  pathsLbl.className = "dlabel";
  pathsLbl.style.margin = "2px 0 7px";
  pathsLbl.textContent = t("libPaths");
  const chipsBox = document.createElement("div");
  chipsBox.className = "chips";
  chipsBox.style.marginBottom = "9px";
  for (const l of libs) chipsBox.appendChild(mkPathChip(l));
  pathsWrap.append(pathsLbl, chipsBox, buildLibAdder());
  body.appendChild(pathsWrap);
  secEl.appendChild(body);
  host.appendChild(secEl);
}

async function refreshLibrary(): Promise<void> {
  const host = $("config");
  // 라이브러리 미설정/스캔 실패는 정상 상태: 빈 목록으로 renderLibrary 가 동일 섹션 구조 + 경로 등록 카드를 렌더.
  let res: any = { libraries: [] };
  try {
    const parsed = jparse(await callTool("library_scan", libTarget ? { targetDir: libTarget } : {}));
    if (parsed && parsed.ok !== false) res = parsed;
  } catch { /* 스캔 오류 -> 빈 목록(미등록)으로 진행 */ }
  renderLibrary(host, res);
}

// ----- load / refresh -----
function showErr(hostId: string, label: string, e: unknown): void {
  console.error(`[config-monitor] ${label}`, e);
  $(hostId).innerHTML = `<div class="empty err">${esc(label)} ${esc(t("fetchFail"))}: ${esc(String(e))}</div>`;
}

async function refresh(): Promise<void> {
  // 설치/제거 후의 재렌더로 스크롤이 맨 위로 튀면 작업하던 행을 매번 다시 찾아가야 한다.
  // 목록 길이가 크게 바뀌면 어차피 어긋나지만, 같은 자리에서 이어 작업하는 경우가 압도적이다.
  const scroller = document.querySelector<HTMLElement>(".left");
  const scrollTop = scroller ? scroller.scrollTop : 0;
  setCatSecEl(null);
  $("config").innerHTML = `<div class="empty">${esc(t("loading"))}</div>`;
  $("tracked").innerHTML = `<div class="empty">${esc(t("loading"))}</div>`;
  let trackedCount = 0;
  try {
    const trk = jparseLast(await callTool("get_tracked"));
    if (trk && trk.ok !== false) trackedCount = renderTracked(trk);
    else $("tracked").innerHTML = `<div class="empty">${esc(trk?.message || t("emptyTrackedResp"))}</div>`;
  } catch (e) {
    showErr("tracked", t("trackedStatus"), e);
  }
  try {
    // libProjectTargets(추적 프로젝트 .claude 경로들)는 앞선 renderTracked 에서 채워짐 -> 프로젝트 스코프 설정 포함.
    const cfg = jparse(await callTool("get_config", { projects: libProjectTargets }));
    if (cfg && cfg.ok !== false) {
      renderConfig(cfg.sections || []);
      // settingsHint 앞자리 숫자만 실제 카테고리 수로 치환해 라이브 카운트 유지.
      $("config-hint").textContent = t("settingsHint").replace(/^\d+/, String((cfg.sections || []).length));
    } else $("config").innerHTML = `<div class="empty">${esc(cfg?.message || t("emptyConfigResp"))}</div>`;
  } catch (e) {
    showErr("config", t("settings"), e);
  }
  try { await refreshLibrary(); } catch (e) { console.error("[config-monitor] library", e); }
  try { await renderCatalog($("config")); } catch (e) { console.error("[config-monitor] catalog", e); }
  const now = new Date().toTimeString().slice(0, 8);
  $("subtitle").textContent = `${t("generatedPrefix")}${trackedCount}${t("generatedMid")}${now}`;
  if (scroller) scroller.scrollTop = scrollTop;
  refreshWatcher();
}
// 선언 직후 등록한다 - 모듈 최상위라 어떤 이벤트 핸들러보다 먼저 실행된다.
setRefreshApp(refresh);

// ----- watcher status badge + toggle -----
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function refreshWatcher(): Promise<boolean> {
  const dot = $("watcher-dot");
  const label = $("watcher-label");
  const btn = $("watcher-toggle") as HTMLButtonElement;
  let running = false;
  try {
    const st = jparse(await callTool("watcher_status"));
    running = !!(st && st.running);
    dot.className = "wdot" + (running ? " on" : "");
    // 파싱/상태 오류는 '정지'로 뭉개지 않고 명시한다 (침묵 실패가 디버깅을 막았던 회귀 가드).
    label.textContent = running ? t("watcherOn") : (st?.error ? t("watcherErr") : t("watcherOff"));
    btn.title = running
      ? `pid ${st.pid} · ${(st.dirs || []).length} dirs · ${Math.round(st.age_sec || 0)}s ${t("ago")}`
      : (st?.error || st?.reason || t("stopped"));
  } catch (e) {
    dot.className = "wdot";
    label.textContent = "watcher ?";
    btn.title = String(e);
  }
  btn.onclick = async () => {
    btn.disabled = true;
    label.textContent = "…";
    try {
      if (running) {
        await callTool("watcher_stop");
        flashToast(t("toastWatcherStop"));
        await refreshWatcher();
      } else {
        // watcher.ps1 가 spawn 후 heartbeat 를 쓰기까지 1~2s 걸린다.
        // 시작 직후 status 는 아직 정지이므로 잠시 기다렸다가 재폴링한다.
        await callTool("watcher_start");
        flashToast(t("toastWatcherStart"));
        for (let i = 0; i < 5; i++) {
          await delay(900);
          if (await refreshWatcher()) { flashToast(t("watcherOn")); break; }
        }
      }
    } catch (e) { console.error("[config-monitor] watcher toggle", e); await refreshWatcher(); }
    finally { btn.disabled = false; }
  };
  return running;
}

// ----- display mode -----
// MCP: 호스트 네이티브 requestDisplayMode. 브라우저(standalone): 네이티브 Fullscreen API.
// (localhost 직접 서빙이라 iframe 제약이 없어 requestFullscreen 이 동작한다.)
function fullscreenActive(): boolean {
  // standalone 은 항상 .app.fullscreen(100vh)이라 클래스로 판별 불가 -> 실제 브라우저 전체화면 상태로 판별.
  return STANDALONE ? !!document.fullscreenElement : $("app").classList.contains("fullscreen");
}
function syncFullscreenLabel(): void {
  const label = fullscreenActive() ? t("windowed") : t("fullscreen");
  $("fullscreen-label").textContent = label;
  ($("fullscreen") as HTMLButtonElement).title = label;
}
function applyDisplayMode(mode: string): void {
  $("app").classList.toggle("fullscreen", mode === "fullscreen");
  syncFullscreenLabel();
}
// 라이브 대시보드를 기본 브라우저에서 연다(서버 필요시 자동 기동). 브라우저에선 네이티브 전체화면 가능.
async function openInBrowser(): Promise<void> {
  flashToast(t("toastBrowser"));
  try { await callTool("open_in_browser"); flashToast(t("toastTabOpened")); }
  catch (e) { flashToast(t("toastOpenFail")); console.error("[config-monitor] open_in_browser", e); }
}
// 브라우저 전용 전체화면 토글(네이티브 Fullscreen API).
async function toggleBrowserFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (e) { console.error("[config-monitor] requestFullscreen", e); flashToast(t("displayModeFail")); }
}
// MCP 위젯 전체화면: 호스트에 requestDisplayMode 요청 -> 호스트가 iframe 을 키우면 .app.fullscreen(100vh)로 채움.
// (surface 별 지원 차이: 예) cowork=fullscreen 가능, code=inline 만 -> 후자는 조용히 inline 반환하여 무반응)
async function toggleFullscreen(): Promise<void> {
  const cur = (app.getHostContext() as any)?.displayMode || "inline";
  const next = cur === "fullscreen" ? "inline" : "fullscreen";
  try {
    const res: any = await app.requestDisplayMode({ mode: next as any });
    applyDisplayMode(res?.mode || next);
  } catch (e) {
    console.error("[config-monitor] requestDisplayMode", e);
    flashToast(t("displayModeFail"));
  }
}
// 전체화면 버튼은 항상 노출한다. 호스트가 fullscreen 모드를 지원하지 않으면 클릭 시 toast 로 안내.
function syncDisplayModeButton(): void {
  const ctx = app.getHostContext() as any;
  $("fullscreen").style.display = "";
  applyDisplayMode(ctx?.displayMode || "inline");
}

// ----- display settings popover (accent / 출처 표시 / desc 줄 수) -----
function wireSettings(): void {
  const btn = $("settings");
  const pop = $("setpop");
  const setOpen = (open: boolean) => {
    pop.hidden = !open;
    btn.classList.toggle("open", open);
    let bd = document.getElementById("setpop-backdrop");
    if (open && !bd) {
      bd = document.createElement("div");
      bd.id = "setpop-backdrop";
      bd.addEventListener("click", () => setOpen(false));
      document.body.appendChild(bd);
    } else if (!open && bd) bd.remove();
  };
  btn.addEventListener("click", () => setOpen(pop.hidden));
  pop.addEventListener("click", (e) => e.stopPropagation());
  document.querySelectorAll<HTMLElement>(".setpop .swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      document.documentElement.style.setProperty("--accent", sw.dataset.c!);
      document.querySelectorAll(".setpop .swatch").forEach((x) => x.classList.toggle("sel", x === sw));
    });
  });
  ($("opt-src") as HTMLInputElement).addEventListener("change", (e) =>
    document.body.classList.toggle("nosrc", !(e.target as HTMLInputElement).checked));
  const lines = $("opt-lines") as HTMLInputElement;
  lines.addEventListener("input", () => {
    document.documentElement.style.setProperty("--desc-lines", lines.value);
    $("opt-lines-val").textContent = lines.value + t("linesSuffix");
  });
}
wireSettings();

// ----- language toggle (ko/en) -----
// 정적 [data-i18n]/[data-i18n-title] 라벨 + 버튼/툴팁/슬라이더 접미사를 현재 lang 으로 적용.
// 동적 렌더(파일/설정/이력/토스트)는 각 렌더 함수가 t() 로 그리므로 여기서 다루지 않는다.
function applyLang(): void {
  document.documentElement.lang = getLang();
  $("lang-code").textContent = getLang().toUpperCase();
  ($("lang-toggle") as HTMLButtonElement).title = t("langTitle");
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n!); });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle!); });
  // refresh() 밖에서 세팅되는 라벨은 여기서 직접 갱신: 전체화면 툴팁(모드 의존) / 설명 줄 수 접미사(값+접미사).
  syncFullscreenLabel();
  const linesEl = document.getElementById("opt-lines") as HTMLInputElement | null;
  if (linesEl) $("opt-lines-val").textContent = linesEl.value + t("linesSuffix");
  // sel-name/sel-path 는 파일 선택 시 파일명/경로(데이터)로 덮이므로, 미선택 상태의 안내문일 때만 번역.
  if (!selectedPath) {
    $("sel-name").textContent = t("selectFilePrompt");
    $("sel-path").textContent = t("selectFileHint");
  }
}

$("lang-toggle").addEventListener("click", () => {
  setLang(getLang() === "ko" ? "en" : "ko");
  try { localStorage.setItem("cm.lang", getLang()); } catch { /* localStorage 차단 시 무시 */ }
  applyLang();
  // 동적 영역 재렌더 1회: 목록/설정/부제/watcher + (선택 시) 이력 패널.
  refresh();
  if (selectedPath && currentRevs.length) { renderHistory(); renderDiffFor(); }
});
applyLang(); // 초기 1회: 정적 라벨을 저장된 lang(기본 ko)으로 맞춘다.

// ----- wiring -----
$("collapse-all").addEventListener("click", () => {
  // 접기 가능(data-col) 섹션만 — 라이브러리 등록 UI 같은 헤더 토글 없는 블럭은 제외
  secTitles.forEach((t) => collapsed.add(t));
  document.querySelectorAll("#config .sec[data-col]").forEach((el) => el.classList.add("collapsed"));
});
$("refresh").addEventListener("click", () => { refresh(); flashToast(t("toastRefreshed")); });
$("snap").addEventListener("click", async () => {
  const r = jparse(await callTool("snapshot_now", { message: t("snapshotMsg") }));
  if (r && r.ok === false) { openReasonModal(t("failed"), r.message || t("failed")); return; }
  flashToast(t("toastSnapshot"));
  await refresh();
  if (selectedPath) selectFile(selectedPath);
});
$("report").addEventListener("click", async () => {
  flashToast(t("toastReport"));
  try {
    const r = jparse(await callTool("open_report"));
    if (r && r.ok === false) { openReasonModal(t("toastReportFail"), r.message || t("failed")); return; }
    flashToast(t("toastReportOpened"));
  } catch (e) { flashToast(t("toastReportFail")); console.error("[config-monitor] report", e); }
});
$("panel-close").addEventListener("click", () => { setDetailOpen(false); applyDetailState(); });
$("panel-reopen").addEventListener("click", () => { setDetailOpen(true); applyDetailState(); });
// 초기 상태도 마크업이 아니라 detailOpen 에서 온다 - 두 곳에 적으면 한쪽만 고쳐져 어긋난다.
applyDetailState();

if (STANDALONE) {
  // 이미 브라우저 안 -> 뷰포트 꽉 채움(고정 660px 대신 100vh). open-browser 는 불필요하므로 숨김.
  $("app").classList.add("fullscreen");
  $("open-browser").style.display = "none";
  // 브라우저에서도 전체화면 버튼 동작: 네이티브 Fullscreen API + 상태 변화 시 라벨 동기화.
  $("fullscreen").addEventListener("click", toggleBrowserFullscreen);
  document.addEventListener("fullscreenchange", syncFullscreenLabel);
  syncFullscreenLabel();
  refresh();
} else {
  $("fullscreen").addEventListener("click", toggleFullscreen);
  $("open-browser").addEventListener("click", openInBrowser);
  // 호스트 컨텍스트 변경(디스플레이 모드 등) 반영. connect 전에 등록.
  app.onhostcontextchanged = () => syncDisplayModeButton();
  app.connect()
    .then(() => { syncDisplayModeButton(); return refresh(); })
    .catch((e: unknown) => console.error("[config-monitor] connect failed", e));
}
