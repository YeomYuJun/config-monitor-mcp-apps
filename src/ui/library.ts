// src/ui/library.ts - Library 섹션: 가져온 라이브러리의 skills · agents · commands 와 hooks/MCP 유닛,
// 그리고 그것들의 설치 · 동기화 · 제거. 설치 대상(전역 / 프로젝트 .claude)은 state 의 libTarget 이 정한다.
// 등록 모달은 libmarket.ts 가 갖는다 - Marketplace 쪽과 공유하므로 여기 두면 순환이 된다.
import { t } from "./i18n";
import { callTool, jparse } from "./bridge";
import { $, esc, setPending, clearPending, openReasonModal, flashToast } from "./widgets";
import { basename, originShort, mkSrcTag } from "./helpers";
import {
  collapsed, secTitles, libGroupOpen, ROOT_GROUP_KEY, libChecked, libOpen,
  libProjectTargets, libTarget, libSelBarUpdate, refreshApp, setLibTarget, setLibSelBarUpdate,
} from "./state";
import { openLibAdd } from "./libmarket";

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
    // 루트 항목도 폴더 그룹처럼 토글되지만 기본은 펼침(libGroupOpen 초기값). 다만 .libgrp
    // 박스로 감싸지 않는다 - 이건 폴더가 아니라 "폴더에 안 들어간 나머지"라, 박스를 두르면
    // 없는 폴더가 하나 있는 것처럼 읽힌다. 구분선 자체가 헤더 역할을 하고, 상태는 그룹과
    // 같은 Set 을 쓴다(경로에 ':' 는 못 들어가 실제 폴더 경로와 키가 겹칠 수 없다).
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

// hooks/MCP 유닛 = 라이브러리 루트 자체(플러그인 루트가 곧 라이브러리) + 그 하위 도구 디렉토리(units).
// 유닛은 부모의 칩(등록 해제 버튼)을 갖지 않으므로 행으로만 펼치고 라이브러리 목록에는 섞지 않는다.
function unitRows(libs: any[], kind: "hooks" | "mcp"): any[] {
  const flag = kind === "hooks" ? "has_hooks" : "has_mcp";
  const out: any[] = [];
  for (const l of libs) {
    if (l[flag]) out.push(l);
    for (const u of l.units || []) if (u[flag]) out.push({ ...u, source: l.source, parent_origin: l.origin });
  }
  return out;
}

// hooks/MCP 카테고리: 유닛(플러그인 루트) 단위 행. 항목 복사가 아니라 설정 파일 병합이라
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
  nm.textContent = l.name || originShort(l.origin);
  nm.title = l.lib;
  const bd = document.createElement("span");
  bd.className = "badge libstat" + (installed ? " ok" : "");
  bd.textContent = installed ? t("libInstalled") : t("libNotInstalled");
  const detail = kind === "hooks" ? (l.hooks_events || []) : (l.mcp_servers || []);
  if (installed && detail.length) bd.title = detail.join(", ");
  row.append(nm, mkSrcTag(l.parent_origin || l.origin, l.lib), bd, mkUnitActions(l, kind, installed));
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
    body.appendChild(renderUnitCategory("hooks", unitRows(libs, "hooks"), "Hooks", t("unitHooksHint")));
    body.appendChild(renderUnitCategory("mcp", unitRows(libs, "mcp"), "MCP", t("unitMcpHint")));
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

export async function refreshLibrary(): Promise<void> {
  const host = $("config");
  // 라이브러리 미설정/스캔 실패는 정상 상태: 빈 목록으로 renderLibrary 가 동일 섹션 구조 + 경로 등록 카드를 렌더.
  let res: any = { libraries: [] };
  try {
    const parsed = jparse(await callTool("library_scan", libTarget ? { targetDir: libTarget } : {}));
    if (parsed && parsed.ok !== false) res = parsed;
  } catch { /* 스캔 오류 -> 빈 목록(미등록)으로 진행 */ }
  renderLibrary(host, res);
}

