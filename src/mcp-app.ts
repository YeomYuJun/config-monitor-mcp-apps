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
  srcOpen, lastConfigSections, setLastConfigSections, refreshApp, setRefreshApp,
} from "./ui/state";
import { valClass, basename, dirname, ABS_PATH_RE, safeSegment, looksLikePermRule, originShort, mkSrcTag } from "./ui/helpers";
import { renderConfig } from "./ui/config";
import { selectFile, renderHistory, renderDiffFor, applyDetailState } from "./ui/detail";

// ----- tracked file rows -----
// 파일 상태 배지 라벨(현재 lang 반영). 상태값 new/deleted 는 i18n 키 newFile/deleted 에 매핑된다(키 이름이 상태값과 다름).
const statusLabel = (st: string): string =>
  (({ new: t("newFile"), modified: t("modified"), deleted: t("deleted"), unchanged: t("unchanged") } as Record<string, string>)[st] || st);
// 경로 추가 입력행: 프로젝트 폴더/.claude/파일 경로 -> config_track(프리셋 자동 감지).
// extra = 입력/추가 버튼과 같은 행에 놓을 부가 버튼(프로젝트에서 추가 토글).
function buildTrackAdder(extra?: HTMLElement): HTMLElement {
  const wrap = document.createElement("div");
  const adder = document.createElement("div");
  adder.className = "adder";
  const input = document.createElement("input");
  input.placeholder = t("trackPathPlaceholder");
  const btn = document.createElement("button");
  btn.className = "addbtn";
  btn.textContent = t("trackAdd");
  const notice = mkNotice(input);
  const submit = async () => {
    const v = input.value.trim();
    if (!v) return;
    // 상대경로는 서버 프로세스의 cwd 기준으로 풀린다 - 사용자가 예측할 수 없는 폴더에 걸리고,
    // 그래도 track 은 성공으로 끝나므로 조용한 오작동이 된다. 여기서 먼저 막는다.
    if (!ABS_PATH_RE.test(v) && !/[*?[\]]/.test(v)) {
      notice.show(t("trackRelPath"));
      input.focus();
      return;
    }
    notice.clear();
    setPending(btn);
    try {
      const r = jparse(await callTool("config_track", { path: v }));
      if (r && r.ok === false) {
        notice.show(r.message || t("failed"));
        clearPending(btn, t("trackAdd"));
        return;
      }
      const added: string[] = (r && r.added) || [];
      const already: string[] = (r && r.already) || [];
      const missing: string[] = (r && r.not_found) || [];
      clearPending(btn, t("trackAdd"));
      if (!added.length && !already.length) {
        // 폴더는 맞는데 프리셋이 하나도 없는 경우다. 무엇을 찾았는지 적어 준다.
        notice.show(t("trackNoPreset"));
        return;
      }
      const parts: string[] = [];
      if (added.length) parts.push(`${t("trackAddedN")} ${added.length}`);
      if (already.length) parts.push(`${t("trackAlreadyN")} ${already.length}`);
      if (missing.length) {
        parts.push(`${t("trackNotFoundN")} ${missing.length}`);
        notice.show(`${parts.join(" · ")}\n${missing.join("\n")}\n${t("trackNotFoundHint")}`, "warn");
      } else {
        notice.show(`${parts.join(" · ")}\n${(added.length ? added : already).join("\n")}`, "ok");
      }
      input.value = "";
      await refreshApp?.();
    } catch (e) {
      notice.show(String(e));
      clearPending(btn, t("failed"));
      console.error("[config-monitor] track add", e);
    }
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
  adder.append(input, btn);
  if (extra) adder.appendChild(extra);
  wrap.append(adder, notice.el);
  return wrap;
}

// 프로젝트(전역 아님) 행에만 붙는 추적 해제(×) 버튼. 2-click 확인. 파일 자체는 안 지움.
function buildUntrackBtn(p: string): HTMLElement {
  const b = document.createElement("button");
  b.className = "untrackbtn";
  b.textContent = "×";
  b.title = t("untrack");
  b.addEventListener("click", async (e) => {
    e.stopPropagation();                         // 행 클릭(패널 열기)과 분리
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = t("untrackConfirm"); return; }
    setPending(b);
    try {
      const r = jparse(await callTool("config_untrack", { path: p }));
      if (r && r.ok === false) {
        // 아이콘 버튼 하나뿐인 자리라 인라인 슬롯을 둘 수 없다. 사유는 모달에 남긴다.
        clearPending(b, "×");
        openReasonModal(t("failed"), r.message || t("failed"));
        return;
      }
      flashToast(t("untracked"));
      await refreshApp?.();
    } catch (err) {
      clearPending(b, t("failed"));
      openReasonModal(t("failed"), String(err));
      console.error("[config-monitor] untrack", err);
    }
  });
  return b;
}

// 프로젝트에서 추가: .claude.json 의 projects 중 .claude 있는 것을 원클릭 track(config_track).
// 지연 로드(펼칠 때 list_projects 호출). 이미 추적 중인 프로젝트는 비활성 표시.
// toggle 은 '추적 추가' 옆(.adder 행), list 는 그 아래 행에 놓이므로 호출측이 각각 배치한다.
function buildProjectPicker(): { toggle: HTMLElement; list: HTMLElement } {
  const toggle = document.createElement("button");
  toggle.className = "projpicktoggle";
  toggle.textContent = t("projPickOpen");
  const list = document.createElement("div");
  list.className = "projpicklist";
  list.hidden = true;
  let loaded = false;
  toggle.addEventListener("click", async () => {
    list.hidden = !list.hidden;
    toggle.classList.toggle("on", !list.hidden);   // 열림 상태를 버튼에 반영(토글 버튼)
    if (list.hidden || loaded) return;
    loaded = true;
    list.innerHTML = `<div class="empty">${esc(t("loading"))}</div>`;
    try {
      const res = jparse(await callTool("list_projects"));
      const projs = (res && Array.isArray(res.projects) ? res.projects : []).filter((p: any) => p.has_claude);
      // 이미 추적 중(라이브러리 후보 = 추적된 프로젝트 .claude dir)인지 비교.
      const trackedNorm = new Set(libProjectTargets.map((c) => c.replace(/\\/g, "/").toLowerCase()));
      list.innerHTML = "";
      if (!projs.length) { list.innerHTML = `<div class="empty">${esc(t("projPickEmpty"))}</div>`; return; }
      for (const p of projs) {
        const already = trackedNorm.has(String(p.claude_dir).replace(/\\/g, "/").toLowerCase());
        const row = document.createElement("button");
        row.className = "projpickrow" + (already ? " tracked" : "");
        row.disabled = already;
        row.innerHTML =
          `<span class="pnm">${esc(p.name)}</span><span class="ppath">${esc(p.claude_dir)}</span>` +
          (already ? `<span class="ptag">${esc(t("projPickTracked"))}</span>` : "");
        if (!already) row.addEventListener("click", async () => {
          // 도구 실패는 예외가 아니라 ok:false 로 온다(callTool 이 두 전송을 그렇게 정규화한다).
          // catch 만 두면 실패해도 아래 성공 토스트가 뜬다 - 행 하나뿐이라 슬롯이 없어 사유는 모달로.
          try {
            const r = jparse(await callTool("config_track", { path: p.claude_dir }));
            if (r && r.ok === false) { openReasonModal(t("failed"), r.message || t("failed")); return; }
            flashToast(`${t("trackAdd")} · ${p.name}`);
            await refreshApp?.();
          } catch (e) { flashToast(t("failed")); console.error("[config-monitor] project track", e); }
        });
        list.appendChild(row);
      }
    } catch (e) { list.innerHTML = `<div class="empty">${esc(t("failed"))}</div>`; console.error("[config-monitor] list_projects", e); }
  });
  return { toggle, list };
}

function renderTracked(status: any): number {
  const host = $("tracked");
  host.innerHTML = "";
  // 입력 + [추적 추가] + [프로젝트에서 추가] 가 한 행, 펼친 목록은 그 아래 행.
  const picker = buildProjectPicker();
  host.appendChild(buildTrackAdder(picker.toggle));
  host.appendChild(picker.list);
  // status.defaults = 전역(기본 추적) 대상 경로 목록 -> 전역(editable) vs 프로젝트(view-only) 구분.
  const defaults = new Set<string>(Array.isArray(status.defaults) ? status.defaults : []);
  const list = document.createElement("div");
  list.className = "files";
  const rows: [string, string][] = [];
  for (const st of ["modified", "new", "deleted", "unchanged"]) {
    for (const p of status[st] || []) rows.push([p, st]);
  }
  // 설치 대상 후보 = 추적 중인 프로젝트(전역 아님, 삭제 아님)의 .claude 폴더. 라이브러리 설치 대상 select 옵션으로 노출.
  const seenT = new Set<string>();
  setLibProjectTargets([]);
  for (const [p, st] of rows) {
    if (st === "deleted" || defaults.has(p)) continue;
    const d = dirname(p);
    if (basename(d).toLowerCase() === ".claude" && !seenT.has(d)) { seenT.add(d); libProjectTargets.push(d); }
  }
  if (!rows.length) {
    list.innerHTML = `<div class="empty">${esc(t("emptyTracked"))}</div>`;
  }
  for (const [p, st] of rows) {
    const global = defaults.has(p);
    const row = document.createElement("div");
    row.className = "file" + (p === selectedPath ? " sel" : "");
    row.dataset.path = p;   // 선택 강조를 full path 로 매칭(같은 basename 파일 오강조 방지)
    row.innerHTML =
      `<span class="fbadge ${st}">${esc(statusLabel(st))}</span>` +
      `<span class="kind ${global ? "kglobal" : "kproject"}">${esc(global ? t("kindGlobal") : t("kindProject"))}</span>` +
      `<div class="fmeta"><div class="fname">${esc(basename(p))}</div>` +
      `<div class="fdir">${esc(dirname(p))}</div></div>`;
    row.addEventListener("click", () => selectFile(p));
    // 프로젝트 행: 추적 해제(×). 전역 행: 열기 화살표(기본 감시 대상이라 제거 불가).
    if (global) {
      const chev = document.createElement("span");
      chev.className = "chev";
      chev.textContent = "›";
      row.appendChild(chev);
    } else {
      row.appendChild(buildUntrackBtn(p));
    }
    list.appendChild(row);
  }
  host.appendChild(list);
  return rows.length;
}

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

// ----- 마켓플레이스 카탈로그 (Library 칸과 다른 뷰) -----
// Library 칸 = 가져온 것. 카탈로그 = 가져올 수 있는 것.
// renderLibrary 로 그리지 않는다 - 매 새로고침마다 전 항목을 eager 렌더하므로 278행이 들어오면 못 쓴다.
let catQuery = "", catCategory = "";
const CAT_PAGE = 40;
const CAT_SEC = "Marketplace";                 // 접힘 상태 키(collapsed/secTitles 공용). t() 와 무관 - 언어를 바꿔도 접힘이 유지된다.
let catSecEl: HTMLElement | null = null;       // 제자리 교체용 현재 섹션 노드
// 페이징은 마켓별로 따로 센다. 합친 목록 하나를 넘기면 A 마켓 끝 페이지에서 B 마켓이 이어붙어
// "7페이지부터 다른 마켓이 나오는" 목록이 된다 - 마켓은 서로 다른 출처지 한 목록의 뒷부분이 아니다.
const catOffsets: Record<string, number> = {};
const catOpen = new Set<string>();             // 펼친 마켓 id(기본 접힘 - 마켓 하나가 278개다)

async function renderCatalog(host: HTMLElement): Promise<void> {
  catSecEl = await buildCatalog();
  host.appendChild(catSecEl);
}

// 페이지 이동/검색은 카탈로그 섹션만 제자리에서 갈아끼운다. 전체 refresh 를 부르면 설정·Library 까지
// 다시 그려지면서 스크롤이 맨 위로 튄다("새로고침 된 것 같다"의 정체).
async function reloadCatalog(): Promise<void> {
  const scroller = document.querySelector<HTMLElement>(".left");
  const top = scroller ? scroller.scrollTop : 0;
  const wasSearching = document.activeElement === document.getElementById("cat-q");
  const sec = await buildCatalog();
  if (catSecEl && catSecEl.parentNode) catSecEl.replaceWith(sec);
  else $("config").appendChild(sec);
  catSecEl = sec;
  if (scroller) scroller.scrollTop = top;
  // 검색 입력은 노드째 교체되므로 포커스가 날아간다 - 검색 중이었으면 캐럿까지 되돌린다.
  if (wasSearching) {
    const q = document.getElementById("cat-q") as HTMLInputElement | null;
    if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }
}

async function buildCatalog(): Promise<HTMLElement> {
  // limit -1 = 요약만(마켓 목록 + 분류 집계). 행은 마켓 구획을 펼칠 때 그 마켓 것만 받는다.
  let res: any = { ok: true, total: 0, rows: [], categories: {}, marketplaces: [] };
  try {
    const parsed = jparse(await callTool("library_catalog", {
      query: catQuery || undefined, category: catCategory || undefined, limit: -1,
    }));
    if (parsed && parsed.ok !== false) res = parsed;
  } catch (e) { console.error("[config-monitor] catalog", e); }
  // Claude Code 가 아는 마켓 이름을 채운다. 파일 하나 읽는 조회라 네트워크를 타지 않는다.
  // 실패해도 카탈로그는 그대로 뜬다 - 그 경우 '플러그인 설치' 버튼만 비활성으로 남는다.
  try {
    const d = jparse(await callTool("library_market_discover", {}));
    if (d && d.ok !== false) {
      ccMarkets.clear();
      for (const m of [...(d.both || []), ...(d.new || [])]) if (m.name) ccMarkets.add(m.name);
    }
  } catch (e) { console.error("[config-monitor] market discover", e); }
  try {
    const s = jparse(await callTool("plugin_catalog_summary", {}));
    if (s && s.ok !== false) setCcCatalog(s.entries || {});
  } catch (e) { console.error("[config-monitor] catalog summary", e); }
  cmMarketUrls.clear();
  cmMarketsNoUrl.clear();
  for (const m of (res.marketplaces || [])) {
    if (m.url) cmMarketUrls.add(normUrl(m.url));
    else if (m.name || m.id) cmMarketsNoUrl.add(m.name || m.id);
  }
  // 등록된 마켓이 없으면 접힌 채로 두지 않는다: "마켓 등록"은 이 섹션 본문 안에만 있어서,
  // 기본 접힘(기동 시 전 섹션 접힘)과 겹치면 처음 쓰는 사람에게 진입점이 아예 안 보인다.
  if (!(res.marketplaces || []).length) collapsed.delete(CAT_SEC);

  const sec = document.createElement("section");
  sec.className = "sec" + (collapsed.has(CAT_SEC) ? " collapsed" : "");
  sec.dataset.col = "1";                        // "전부 접기"(#config .sec[data-col]) 대상에 포함
  secTitles.add(CAT_SEC);
  const head = document.createElement("div");
  head.className = "sechead";
  head.innerHTML =
    `<div class="secrow"><span class="chev2">▾</span>` +
    `<span class="sectitle">${esc(t("catTitle"))}</span>` +
    `<span class="seccount" title="${esc(catFilterTip())}">` +
    `${esc(countLabel(res.total, res.total_all))}</span></div>`;
  head.addEventListener("click", () => {
    if (collapsed.has(CAT_SEC)) collapsed.delete(CAT_SEC); else collapsed.add(CAT_SEC);
    sec.classList.toggle("collapsed");
  });
  sec.appendChild(head);

  const body = document.createElement("div");
  body.className = "secbody libbody";           // 마켓 구획이 세로로 쌓이도록 그리드 해제

  const bar = document.createElement("div");
  bar.className = "adder";
  const q = document.createElement("input");
  q.id = "cat-q";
  q.placeholder = t("catSearch");
  q.value = catQuery;
  q.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key !== "Enter") return;
    catQuery = q.value.trim();
    resetCatOffsets();          // 검색 결과 위에서는 옛 페이지 번호가 의미를 잃는다
    reloadCatalog();
  });
  const sel = document.createElement("select");
  sel.className = "catsel";
  const cats = ["", ...Object.keys(res.categories || {}).filter(Boolean).sort()];
  for (const c of cats) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c || t("catAll");
    if (c === catCategory) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => { catCategory = sel.value; resetCatOffsets(); reloadCatalog(); });
  bar.append(q, sel);
  body.appendChild(bar);

  const markets: any[] = res.marketplaces || [];
  if (!markets.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = t("catEmpty");
    body.appendChild(empty);
  }
  // 마켓마다 자기 영역 + 자기 페이저. 검색/분류만 전 마켓에 공통으로 걸린다.
  for (const m of markets) body.appendChild(mkMarketGroup(m));

  const mBtn = document.createElement("button");
  mBtn.className = "addbtn";
  mBtn.style.marginTop = "12px";
  mBtn.textContent = "＋ " + t("catMarketAdd");
  mBtn.addEventListener("click", () => openMarketAdd(""));
  body.appendChild(mBtn);

  sec.appendChild(body);
  return sec;
}

function resetCatOffsets(): void {
  for (const k of Object.keys(catOffsets)) delete catOffsets[k];
}

// 검색/분류가 걸려 있으면 "2 / 284" 로 전체 대비 몇 개인지 함께 보여준다.
// 필터 후 개수만 그리면 접힌 섹션에서는 왜 2개인지 알 수가 없고, 필터가 남아 있다는 사실
// 자체가 사라진다 - 검색어는 접힌 본문 안에 있어 보이지 않는다.
function countLabel(total: number, totalAll?: number): string {
  const all = typeof totalAll === "number" ? totalAll : total;
  return catFiltering() && all !== total ? `${total} / ${all}` : String(all);
}
const catFiltering = (): boolean => !!(catQuery || catCategory);

// 접힌 상태에서도 무엇이 걸려 있는지 알 수 있게 개수 pill 의 title 에 조건을 적어 둔다.
function catFilterTip(): string {
  const parts: string[] = [];
  if (catQuery) parts.push(`${t("catSearchTip")}: ${catQuery}`);
  if (catCategory) parts.push(`${t("catCategoryTip")}: ${catCategory}`);
  return parts.join(" · ");
}

// 마켓 1구획: 헤더(토글 + 이름 + 개수 + URL) + 지연 로드 본문.
// 접혀 있으면 그 마켓의 행을 아예 받지 않는다 - 마켓 하나가 278개다.
function mkMarketGroup(m: any): HTMLElement {
  const grp = document.createElement("div");
  grp.className = "catgrp" + (catOpen.has(m.id) ? "" : " collapsed");
  const head = document.createElement("div");
  head.className = "catgrphead";
  head.innerHTML =
    `<span class="chev2">▾</span>` +
    `<span class="mname">${esc(m.name || m.id || "")}</span>` +
    `<span class="seccount" title="${esc(catFilterTip())}">` +
    `${esc(countLabel(m.total, m.total_all))}</span>` +
    `<span class="murl">${esc(m.url || t("catNoUrl"))}</span>`;
  head.appendChild(mkMarketCcActions(m));
  const gbody = document.createElement("div");
  gbody.className = "catgrpbody";
  head.addEventListener("click", () => {
    if (catOpen.has(m.id)) { catOpen.delete(m.id); grp.classList.add("collapsed"); return; }
    catOpen.add(m.id);
    grp.classList.remove("collapsed");
    if (!gbody.dataset.loaded) fillMarketBody(gbody, m);
  });
  if (catOpen.has(m.id)) fillMarketBody(gbody, m);
  grp.append(head, gbody);
  return grp;
}

// 마켓 헤더의 Claude Code 쪽 액션. 이 섹션이 나열하는 건 **config-monitor 스토어**의 마켓이고,
// 같은 레포가 Claude Code 에도 등록돼 있을 수 있다(ccMarkets). 두 등록은 캐시를 각자 유지하는
// 별개의 것이라 합치지 않고, 어느 쪽 조작인지 그룹 라벨로 못 박은 뒤 나란히 둔다.
//   Claude Code 에 없으면  -> 등록(export)
//   Claude Code 에 있으면  -> 갱신 / 해제
// 그 뒤 구분선 하나를 두고 config-monitor 스토어의 제거가 온다.
// auto-update 는 없다: TUI 에만 있고 CLI 서브커맨드도 저장 흔적도 없어 키를 추측해야 한다.
function mkMarketCcActions(m: any): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "mkacts";
  const name = m.name || m.id;
  const stop = (b: HTMLElement) =>
    b.addEventListener("click", (e) => e.stopPropagation());   // 헤더 클릭 = 접기/펼치기
  const call = async (btn: HTMLButtonElement, tool: string, args: any) => {
    setPending(btn);
    try {
      const rr = jparse(await callTool(tool, args));
      if (rr && rr.ok === false) { clearPending(btn, t("failed")); flashToast(rr.message || t("failed")); return; }
      flashToast(rr?.message || t("done"));
      await reloadCatalog();
    } catch (e) { clearPending(btn, t("failed")); console.error("[config-monitor] " + tool, e); }
  };
  const mk = (label: string, tip: string, cls: string, onClick: (b: HTMLButtonElement) => void) => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = label;
    b.title = tip;
    stop(b);
    b.addEventListener("click", () => onClick(b));
    wrap.appendChild(b);
    return b;
  };
  // 확인을 한 번 받고 실행하는 파괴적 액션. 되돌리려면 다시 등록+fetch 해야 한다.
  const confirmThen = (run: (b: HTMLButtonElement) => void) => () => {
    const restore = [...wrap.children];      // 확인 UI 로 갈아끼우기 전의 버튼들
    const ok = document.createElement("button");
    ok.className = "ok";
    ok.textContent = t("delConfirm");
    const no = document.createElement("button");
    no.className = "no";
    no.textContent = t("cancel");
    stop(ok); stop(no);
    wrap.replaceChildren(ok, no);
    no.addEventListener("click", () => wrap.replaceChildren(...restore));
    ok.addEventListener("click", () => run(ok));
  };

  // 어느 쪽 등록을 다루는 버튼인지는 라벨 하나로 한 번만 말한다. 버튼마다 "Claude Code" 를
  // 반복하면 헤더 폭을 잡아먹는다 - 이 행은 인라인(위젯) 폭에서도 URL 과 자리를 나눠 쓴다.
  const ccExists = ccMarkets.has(name);
  const hasCcAction = ccExists || !!m.url;
  if (hasCcAction) {
    const lbl = document.createElement("span");
    lbl.className = "mklbl";
    lbl.textContent = t("mkCcGroup");
    lbl.title = t("mkCcGroupTip");
    stop(lbl);              // 툴팁 읽으려 올렸다가 누르면 마켓이 접히는 일이 없게
    wrap.appendChild(lbl);
  }
  if (!ccExists) {
    if (m.url) {
      mk(t("mkExport"), t("mkExportTip"), "addbtn",
        (b) => call(b, "claude_marketplace_add", { source: m.url, scope: "user" }));
    }
  } else {
    mk(t("mkCcUpdate"), t("mkCcUpdateTip"), "addbtn",
      (b) => call(b, "claude_marketplace_update", { name }));
    mk(t("mkCcRemove"), t("mkCcRemoveTip"), "cx",
       confirmThen((b) => call(b, "claude_marketplace_remove", { name })));
  }

  // config-monitor 자기 스토어에서의 해제. 위 Claude Code 액션과 **다른 등록**을 지운다 - 둘은
  // 캐시를 각자 유지하므로 한쪽을 지워도 다른 쪽은 남는다. 라벨만으로는 두 축이 한 묶음처럼
  // 읽히므로 구분선을 넣어 갈라 둔다.
  if (hasCcAction) {
    const sep = document.createElement("span");
    sep.className = "mksep";
    wrap.appendChild(sep);
  }
  // library_unregister 는 원장이 그 캐시를 참조 중이면 거부하고 무엇이 붙들고 있는지
  // 알려준다(held_by) - 강제 옵션은 두지 않는다.
  mk(t("mkRemove"), t("mkRemoveTip"), "cx", confirmThen(async (b) => {
    setPending(b);
    try {
      const r = jparse(await callTool("library_unregister", { origin: `market:${m.id}` }));
      if (r && r.ok === false) {
        clearPending(b, t("failed"));
        openReasonModal(t("heldTitle"), r.message || t("failed"), r.held_by || []);
        return;
      }
      flashToast(r?.message || t("done"));
      await refreshApp?.();                        // Library 패널도 같이 바뀐다
    } catch (e) { clearPending(b, t("failed")); console.error("[config-monitor] market unregister", e); }
  }));
  return wrap;
}

// 한 마켓의 현재 페이지만 받아 그 본문만 갈아끼운다 - 섹션 전체를 다시 그리지 않으므로
// 다른 마켓의 펼침/페이지 상태와 스크롤 위치가 그대로 남는다.
async function fillMarketBody(body: HTMLElement, m: any): Promise<void> {
  body.dataset.loaded = "1";
  body.innerHTML = `<div class="empty">${esc(t("loading"))}</div>`;
  const off = catOffsets[m.id] || 0;
  let res: any = { rows: [], total: m.total || 0, offset: off };
  try {
    const parsed = jparse(await callTool("library_catalog", {
      marketplace: m.id, query: catQuery || undefined, category: catCategory || undefined,
      limit: CAT_PAGE, offset: off,
    }));
    if (parsed && parsed.ok !== false) res = parsed;
  } catch (e) { console.error("[config-monitor] catalog rows", e); }
  // 필터로 total 이 줄면 백엔드가 offset 을 마지막 페이지로 당긴다 - 그 값을 그대로 따라간다.
  catOffsets[m.id] = typeof res.offset === "number" ? res.offset : off;

  body.innerHTML = "";
  if (!res.rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = t("catNoPlugins");
    body.appendChild(empty);
  }
  for (const row of res.rows) body.appendChild(mkCatalogRow(row));
  if (res.total > CAT_PAGE) {
    body.appendChild(mkPager(res.total, catOffsets[m.id], (next) => {
      catOffsets[m.id] = next;
      fillMarketBody(body, m);
    }));
  }
}

function mkPager(total: number, offset: number, go: (offset: number) => void): HTMLElement {
  const pages = Math.max(1, Math.ceil(total / CAT_PAGE));
  const page = Math.min(pages, Math.floor(offset / CAT_PAGE) + 1);
  const pager = document.createElement("div");
  pager.className = "catpager";
  const prev = document.createElement("button");
  prev.className = "addbtn";
  prev.textContent = t("catPrev");
  prev.disabled = offset <= 0;
  prev.addEventListener("click", () => go(Math.max(0, offset - CAT_PAGE)));
  const next = document.createElement("button");
  next.className = "addbtn";
  next.textContent = t("catNext");
  next.disabled = offset + CAT_PAGE >= total;
  next.addEventListener("click", () => go(offset + CAT_PAGE));
  const info = document.createElement("span");
  info.className = "pinfo";
  info.textContent = `${t("catPageOf")} ${page} / ${pages} · ${total}`;
  pager.append(prev, info, next);
  return pager;
}

// 마켓 등록: URL 입력 모달 -> 경고 확인 모달 -> 그 다음에야 네트워크를 탄다.
// url 인자는 경고에서 취소하고 돌아왔을 때 입력을 되살리기 위한 것이다.
// 백엔드(remote_fetch._validate_url / marketplace._validate_source_url)의 허용 스킴과 같은 규율.
// 서버가 어차피 다시 검증하지만, 여기서 걸러야 오타 하나에 git clone 왕복을 태우지 않고
// "왜 안 되는지"를 입력칸 바로 아래에서 알려줄 수 있다.
const GIT_URL_RE = /^(https?|ssh|git|file):\/\/\S+$/i;
const SCP_URL_RE = /^[A-Za-z0-9_.~-]+@[A-Za-z0-9_.-]+:[A-Za-z0-9_./~-]\S*$/;
// owner/repo 축약: 슬래시 정확히 1개, 스킴도 콜론도 없음. '..' 은 세그먼트 문자 클래스에
// 걸리므로 따로 막는다(경로 이탈이 축약으로 위장하는 유일한 통로다).
const SHORTHAND_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// 로컬 경로: ./ ../ / ~/ 또는 Windows 드라이브(C:\ · C:/).
const LOCAL_PATH_RE = /^(\.\.?[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])/;
// **넓히는 방향으로만 틀려야 한다.** 서버가 최종 판정자이므로 여기서 통과시킨 뒤 거부되면
// 사용자는 이유가 담긴 메시지를 본다. 반대로 여기서 막으면 백엔드가 받아들이는 형식이
// 화면에서 아예 닿지 않는다 - 그게 더 나쁜 실패다.
const looksLikeMarketSource = (u: string): boolean =>
  GIT_URL_RE.test(u) || SCP_URL_RE.test(u) || LOCAL_PATH_RE.test(u) ||
  (SHORTHAND_RE.test(u) && !u.includes(".."));

function openMarketAdd(url: string): void {
  openModal(t("catMarketAdd"), (body, close) => {
    const hint = document.createElement("div");
    hint.className = "modaltext";
    hint.textContent = t("catMarketUrlHint");
    const input = document.createElement("input");
    input.className = "modalinput";
    input.placeholder = t("catMarketUrlPlaceholder");
    input.value = url;
    const err = document.createElement("div");
    err.className = "modalerr";
    err.hidden = true;
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      if (!looksLikeMarketSource(v)) {
        err.textContent = t("catBadUrl");
        err.hidden = false;
        input.focus();
        return;
      }
      close();
      openMarketWarn(v);
    };
    input.addEventListener("input", () => { err.hidden = true; });
    input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
    const disc = document.createElement("div");
    disc.className = "modaldisc";
    body.append(hint, input, err, disc, modalActions(t("catMarketSubmit"), submit, close));
    setTimeout(() => input.focus(), 0);
    // Claude Code 의 known_marketplaces.json 을 읽어 후보를 제안한다. **네트워크를 타지 않고**,
    // 고른 URL 도 아래 submit -> openMarketWarn 의 기존 경고 단계를 그대로 거친다.
    // 실패해도 조용히 넘긴다 - 등록 자체는 URL 직접 입력으로 항상 가능해야 한다.
    void (async () => {
      try {
        const r = jparse(await callTool("library_market_discover", {}));
        if (!r || r.ok === false) return;
        renderDiscover(disc, r, (u: string) => { input.value = u; err.hidden = true; input.focus(); });
      } catch (e) { console.error("[config-monitor] market discover", e); }
    })();
  });
}

// 후보 목록. new = 가져올 수 있는 것(누르면 URL 입력칸을 채움),
// both = 양쪽에 등록된 것. 두 도구가 같은 레포를 각자 캐시에 다른 시점으로 들고 있으므로
// 그 어긋남을 감추지 않고 sha / 갱신 시각을 나란히 적는다.
function renderDiscover(host: HTMLElement, r: any, pick: (u: string) => void): void {
  // 공식 마켓은 처음 쓰는 사람에게 유일한 진입점이라 목록보다 위에 프리셋으로 올린다.
  // 이미 스토어에 있으면 권하지 않는다.
  if (!cmMarketUrls.has(normUrl(OFFICIAL_MARKET_URL))) {
    const b = document.createElement("button");
    b.className = "chip pick";
    b.textContent = t("mkOfficialPreset");
    b.title = OFFICIAL_MARKET_URL;
    b.addEventListener("click", () => pick(OFFICIAL_MARKET_URL));
    host.appendChild(b);
  }
  const news: any[] = r.new || [], both: any[] = r.both || [];
  if (!news.length && !both.length) return;
  const h = document.createElement("div");
  h.className = "disclbl";
  h.textContent = t("plgDiscover");
  host.appendChild(h);
  for (const m of news) {
    const b = document.createElement("button");
    b.className = "chip pick";
    b.textContent = `${m.name} · ${m.repo || m.url}`;
    b.title = m.url;
    b.addEventListener("click", () => pick(m.url));
    host.appendChild(b);
  }
  if (!news.length) {
    const n = document.createElement("div");
    n.className = "modalnote";
    n.textContent = t("plgDiscoverNone");
    host.appendChild(n);
  }
  for (const m of both) {
    const n = document.createElement("div");
    n.className = "discboth";
    const head = document.createElement("div");
    head.className = "dbhead";
    const nm = document.createElement("span");
    nm.className = "dbname";
    nm.textContent = m.name || m.repo || m.url || "-";
    const tag = document.createElement("span");
    tag.className = "dbtag";
    tag.textContent = t("plgDiscoverBoth");
    head.append(nm, tag);
    const meta = document.createElement("div");
    meta.className = "dbmeta";
    meta.textContent = `${String(m.sha || "").slice(0, 12) || "-"} / Claude Code ` +
      `${String(m.claude_updated || "").slice(0, 10) || "-"}`;
    n.append(head, meta);
    host.appendChild(n);
  }
}

// ----- Library 등록 (Marketplace 와 같은 버튼 -> 모달 흐름) -----
// Library 와 Marketplace 를 가르는 축은 전송 방식이 아니라 `.claude-plugin/marketplace.json`
// 유무다. 그래서 입력칸을 로컬/원격으로 쪼개지 않고 하나만 두고, 전송 방식은 판별한다.
// owner/repo 축약은 remote_fetch._validate_url 이 스킴 없는 문자열을 거부하므로 여기서
// GitHub URL 로 편다(marketplace.py 의 축약 처리와 같은 규칙). 편 결과는 화면에 적어
// 무엇을 clone 하는지 누르기 전에 보이게 한다.
type LibSource = { kind: "local" | "git" | ""; url: string; expanded: boolean };
function classifyLibSource(raw: string): LibSource {
  const u = (raw || "").trim();
  if (!u) return { kind: "", url: "", expanded: false };
  if (LOCAL_PATH_RE.test(u)) return { kind: "local", url: u, expanded: false };
  if (GIT_URL_RE.test(u) || SCP_URL_RE.test(u)) return { kind: "git", url: u, expanded: false };
  if (SHORTHAND_RE.test(u) && !u.includes("..")) {
    return { kind: "git", url: `https://github.com/${u}.git`, expanded: true };
  }
  return { kind: "", url: u, expanded: false };
}

const normLibPath = (p: string) =>
  String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// library_scan 은 등록만 하는 도구가 아니라 **전체 목록**을 돌려준다. 입력한 경로에
// 해당하는 행만 찾아 그 행의 marketplace 플래그를 읽는다(다른 라이브러리의 플래그를 보면 안 된다).
function scannedRowIsMarket(r: any, p: string): boolean {
  const rows: any[] = (r && Array.isArray(r.libraries)) ? r.libraries : [];
  const hit = rows.find((x) => normLibPath(x.lib) === normLibPath(p));
  return !!(hit && hit.marketplace);
}

// 등록이 끝난 뒤의 안내. 되돌리는 화면이 아니라 다음 걸음을 권하는 화면이므로
// 취소 자리는 '닫기'다 - '취소'로 두면 끝난 등록이 되돌려지는 것으로 읽힌다.
function showCrossOffer(body: HTMLElement, close: () => void,
                        msgKey: string, okKey: string, go: () => void): void {
  const msg = document.createElement("div");
  msg.className = "modaltext";
  msg.textContent = t(msgKey);
  const row = modalActions(t(okKey), () => { close(); go(); }, close);
  const btns = row.querySelectorAll("button");
  if (btns[1]) btns[1].textContent = t("close");
  body.replaceChildren(msg, row);
}

function openLibAdd(prefill: string): void {
  openModal(t("libAdd"), (body, close) => {
    const hint = document.createElement("div");
    hint.className = "modaltext";
    hint.textContent = t("libAddHint");
    const note = document.createElement("div");
    note.className = "modalnote";
    note.textContent = t("libAddMarketNote");
    const input = document.createElement("input");
    input.className = "modalinput";
    input.placeholder = t("libAddPlaceholder");
    input.value = prefill;
    // 판별 결과를 누르기 전에 보여준다: 어느 칸에 넣느냐가 곧 결정이던 구조를 없앴으므로
    // 무엇으로 해석됐는지는 화면이 말해야 한다.
    const kindLine = document.createElement("div");
    kindLine.className = "libkind";
    const warn = document.createElement("div");
    warn.className = "modalwarn";
    warn.hidden = true;
    warn.innerHTML = `<span class="ico">⚠</span><span>${esc(t("libRemoteWarn"))}</span>`;
    const err = document.createElement("div");
    err.className = "modalerr";
    err.hidden = true;

    const submit = async (ok: HTMLButtonElement) => {
      const s = classifyLibSource(input.value);
      if (!s.kind) {
        err.textContent = t("libBadSource");
        err.hidden = false;
        input.focus();
        return;
      }
      err.hidden = true;
      setPending(ok);
      try {
        const r = s.kind === "local"
          ? jparse(await callTool("library_scan", { lib: s.url }))
          : jparse(await callTool("library_remote_add", { url: s.url }));
        if (r && r.ok === false) {
          err.textContent = r.message || t("failed");
          err.hidden = false;
          clearPending(ok);
          return;
        }
        const isMarket = s.kind === "local" ? scannedRowIsMarket(r, s.url) : !!(r && r.marketplace);
        flashToast((r && r.message) || t("libRegistered"));
        await refreshApp?.();
        // 원격은 clone 이 끝나야 매니페스트 유무를 알 수 있어 사전 분기가 불가능하다.
        // 로컬도 같은 화면으로 맞춘다 - 등록은 유효하고, 반대편 등록만 이어서 권한다.
        if (isMarket) showCrossOffer(body, close, "libIsMarket", "libGoMarket",
                                     () => openMarketAdd(s.expanded ? s.url : input.value.trim()));
        else close();
      } catch (e) {
        clearPending(ok, t("failed"));
        console.error("[config-monitor] library add", e);
      }
    };

    const actions = modalActions(t("libAddSubmit"), (ok) => void submit(ok), close);
    const okBtn = actions.querySelector("button") as HTMLButtonElement;
    const sync = () => {
      const s = classifyLibSource(input.value);
      err.hidden = true;
      warn.hidden = s.kind !== "git";
      // git 이면 주 버튼 라벨 자체가 경고 확인이 된다. 경고가 화면에 떠 있는 채로만
      // 누를 수 있으므로 별도 확인 단계를 한 번 더 두지 않는다.
      okBtn.textContent = s.kind === "git" ? t("libRemoteWarnOk") : t("libAddSubmit");
      kindLine.textContent = !s.kind ? ""
        : s.kind === "local" ? t("libKindLocal")
        : s.expanded ? `${s.url} · ${t("libKindGit")}`
        : t("libKindGit");
    };
    input.addEventListener("input", sync);
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Enter") return;
      // 로컬 경로는 Enter 로 끝낸다. git 은 막는다 - 붙여넣고 바로 Enter 를 치면 심사하지
      // 않은 URL 을 clone 하면서 경고를 한 번도 읽지 않는다. 그 경로만 버튼 클릭을 요구해
      // 라벨(=경고 확인 문구)을 반드시 지나가게 한다.
      if (classifyLibSource(input.value).kind === "git") { okBtn.focus(); return; }
      void submit(okBtn);
    });
    body.append(hint, note, input, kindLine, warn, err, actions);
    sync();
    setTimeout(() => input.focus(), 0);
  });
}

function openMarketWarn(url: string): void {
  openModal(t("catWarnTitle"), (body, close) => {
    const warn = document.createElement("div");
    warn.className = "modalwarn";
    warn.innerHTML = `<span class="ico">⚠</span><span>${esc(t("libRemoteWarn"))}` +
      `<span class="em">${esc(url)}</span></span>`;
    // 실패 사유는 토스트로만 흘리지 않는다: git 오류 원문은 길고 몇 초 만에 사라지는데,
    // 모달은 열린 채로 남아 사용자는 무엇이 잘못됐는지 모른 채 같은 버튼을 다시 누르게 된다.
    const err = document.createElement("div");
    err.className = "modalerr";
    err.hidden = true;
    const actions = modalActions(t("libRemoteWarnOk"), async (ok) => {
      err.hidden = true;
      setPending(ok);
      try {
        const rr = jparse(await callTool("library_marketplace_add", { url }));
        if (rr && rr.ok === false) {
          // 매니페스트가 없어서 거절된 것뿐이면 막다른 길이 아니다 - Library 쪽이 받는
          // 모양일 수 있으므로 그리로 건너갈 길을 준다. 분기는 code 로만 한다
          // (message 는 백엔드가 한국어로 만든 문장이라 매칭하면 영어 UI 에서 깨진다).
          if (rr.code === "not_a_marketplace") {
            showCrossOffer(body, close, "libNotMarket", "libGoLibrary", () => openLibAdd(url));
            return;
          }
          err.textContent = rr.message || t("failed");
          err.hidden = false;
          clearPending(ok, t("libRemoteWarnOk"));
          return;
        }
        if (rr?.id) catOpen.add(rr.id);        // 새로 등록된 마켓은 펼친 채로 보여준다
        flashToast(rr?.message || t("done"));
        close();
        await refreshApp?.();
      } catch (e) {
        err.textContent = String(e);
        err.hidden = false;
        clearPending(ok, t("libRemoteWarnOk"));
        console.error("[config-monitor] market add", e);
      }
    }, () => { close(); openMarketAdd(url); });   // 취소하면 입력을 잃지 않게 URL 모달로 되돌린다
    body.append(warn, err, actions);
  });
}


// 카탈로그 1행: 이름 + 분류 배지(항상) + 설치됨 배지(설치된 경우) + 설치 버튼.
// 분류 배지를 설치됨으로 갈아치우면 안 된다 - 설치하고 나면 그게 database 였는지 monitoring 이었는지
// 화면에서 사라져 목록을 훑을 수 없게 된다(설치 상태와 분류는 서로 다른 축이다).
function mkCatalogRow(row: any): HTMLElement {
  const r = document.createElement("div");
  r.className = "libskill";
  const nm = document.createElement("button");
  nm.className = "sknm asname";
  nm.textContent = row.display || row.name;
  nm.title = t("catDetailsTip");
  nm.addEventListener("click", () => openPluginDetails(row));
  const kind = document.createElement("span");
  kind.className = "badge";
  kind.textContent = row.category || row.kind;
  r.append(nm, kind);
  // 인벤토리가 있으면 여기서 이미 "무엇이 들어오는지"를 말할 수 있다(fetch 전에).
  // 없으면 아무것도 그리지 않는다 - 0 개라고 말하는 것과 모른다는 건 다르다.
  const inv = ccCatalog[`${row.name}@${row.market_name || row.marketplace}`];
  if (inv) {
    if (inv.total) {
      const c = document.createElement("span");
      c.className = "badge";
      c.textContent = String(inv.total);
      c.title = Object.entries(inv.components || {}).map(([k, v]) => `${k} ${v}`).join(" · ");
      r.appendChild(c);
    }
    if (inv.installs) {
      const i = document.createElement("span");
      i.className = "cinstalls";
      i.textContent = fmtInstalls(inv.installs);
      i.title = t("catInstallsTip");
      r.appendChild(i);
    }
  }
  if (row.fetched) {
    const done = document.createElement("span");
    done.className = "badge ok";
    done.textContent = t("catFetched");
    r.appendChild(done);
  }
  const act = document.createElement("div");
  act.className = "edit";
  if (!row.fetched) {
    const b = document.createElement("button");
    b.className = "addbtn";
    b.textContent = t("catFetch");
    b.addEventListener("click", async () => {
      setPending(b);
      try {
        const rr = jparse(await callTool("library_plugin_fetch",
          { marketplace: row.marketplace, plugin: row.name }));
        if (rr && rr.ok === false) {
          // 네트워크·매니페스트 오류라 원문이 길다. 토스트로 스치게 두지 않는다.
          clearPending(b, t("catFetch"));
          openReasonModal(t("failed"), rr.message || t("failed"));
          return;
        }
        // components_failed 가 있으면 개수는 "모름"이지 "0개"가 아니다 - warning 을 성공 메시지에
        // 묻어 버리면 "가져왔는데 텅 빔" 처럼 보인다(사실은 "가져왔는데 일부를 못 읽음").
        flashToast(rr?.warning ? `${rr?.message || t("done")} · ${row.name} ⚠ ${rr.warning}`
          : `${rr?.message || t("done")} · ${row.name}`);
        await refreshApp?.();
      } catch (e) { flashToast(t("failed")); clearPending(b, t("failed")); console.error("[config-monitor] plugin fetch", e); }
    });
    b.title = t("catFetchTip");
    act.appendChild(b);
  }
  act.appendChild(mkActivateBtn(row));
  r.appendChild(act);
  return r;
}

// 두 번째 액션: 플러그인을 **통째로** Claude Code 에 설치(claude plugin install 위임).
// 왼쪽 버튼(항목 설치)과 나란히 두는 이유 - 마켓플레이스는 두 설치 모델의 공통 출처일 뿐이고,
// 어느 쪽으로 넣을지는 사용자가 고르는 것이기 때문이다. 라벨과 tooltip 이 그 차이를 말한다.
//   항목 설치   ~/.claude 로 복사. 원하는 것만. 설치 전 diff·롤백 O. Desktop 가능
//   플러그인    캐시에 통째. <ns>:<item> 네임스페이스. 토글로 on/off. Code 전용
// 마켓 이름은 config-monitor 의 store id 가 아니라 매니페스트 name(row.market_name)을 쓴다 -
// Claude Code 의 마켓 키가 그것이다.
// 비활성 사유는 "무엇을 눌러야 풀리는지"를 말해야 하는데, 그 버튼은 마켓에 URL 이 있을 때만
// 그려진다. URL 이 없는 마켓에서는 대신 CLI 를 안내한다.
const noMarketTip = (market: string): string =>
  cmMarketsNoUrl.has(market) ? t("catActivateNoMarketLocal") : t("catActivateNoMarket");

function mkActivateBtn(row: any): HTMLElement {
  const market = row.market_name || row.marketplace;
  const pid = `${row.name}@${market}`;
  if (ccPlugins.has(pid)) {
    const done = document.createElement("span");
    done.className = "badge plg";
    done.textContent = t("catActivated");
    done.title = t("catActivatedTip");
    return done;
  }
  const b = document.createElement("button");
  b.className = "addbtn";
  b.textContent = t("catActivate");
  // 저쪽에 마켓이 없으면 install 이 못 찾는다. 눌러서 실패하게 두지 않고 이유를 먼저 말한다.
  if (!ccMarkets.has(market)) {
    b.disabled = true;
    b.title = noMarketTip(market);
    return b;
  }
  b.title = t("catActivateTip");
  b.addEventListener("click", () => openPluginDetails(row));
  return b;
}

// 404331 -> "404.3K". CLI 의 Discover 표기와 같은 자릿수로 맞춘다.
function fmtInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// 설치 **전에** 무엇이 들어오는지 보여주는 상세 화면. CLI 의 "Plugin details" 와 같은 내용을
// 같은 출처(~/.claude/plugins/plugin-catalog-cache.json)에서 읽는다 - fetch 도 네트워크도 없다.
// 인벤토리가 없는 마켓(공식 외)에서는 그 사실을 적고 설치 버튼은 그대로 둔다.
function openPluginDetails(row: any): void {
  const market = row.market_name || row.marketplace;
  const id = `${row.name}@${market}`;
  openModal(row.display || row.name, (body, close) => {
    const meta = document.createElement("div");
    meta.className = "modaltext";
    meta.textContent = `${t("catFrom")} ${market}`;
    const desc = document.createElement("div");
    desc.className = "modaltext";
    desc.textContent = row.description || "";
    const inv = document.createElement("div");
    inv.className = "modaldisc";
    inv.textContent = t("loading");
    // 신뢰 경고는 인벤토리 유무와 무관하게 항상 붙인다 - 플러그인은 임의 코드를 들여온다.
    const warn = document.createElement("div");
    warn.className = "modalwarn";
    warn.innerHTML = `<span class="ico">⚠</span><span>${esc(t("catTrustWarn"))}</span>`;
    body.append(meta, desc, inv, warn, mkInstallScopes(row, market, close));
    void (async () => {
      let d: any = null;
      try {
        const r = jparse(await callTool("plugin_catalog_details", { id }));
        if (r && r.ok !== false) d = r;
      } catch (e) { console.error("[config-monitor] plugin details", e); }
      renderInventory(inv, d, row);
    })();
  });
}

function renderInventory(host: HTMLElement, d: any, row: any): void {
  host.replaceChildren();
  const line = (cls: string, text: string, tip?: string) => {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    if (tip) el.title = tip;
    host.appendChild(el);
    return el;
  };
  if (!d) {
    // 공식 마켓 캐시에 없는 플러그인이다. "0개"가 아니라 "모른다"고 말한다.
    line("modalnote", t("catNoInventory"));
    if (row.homepage) mkHomepageLink(host, row.homepage);
    return;
  }
  if (d.author) line("modalnote", `${t("catAuthor")}: ${d.author}`);
  if (d.last_updated) line("modalnote", `${t("catUpdated")}: ${String(d.last_updated).slice(0, 10)}`);
  if (d.installs) line("modalnote", `${fmtInstalls(d.installs)} ${t("catInstalls")}`);
  const h = document.createElement("div");
  h.className = "modaltext";
  h.textContent = t("catWillInstall");
  host.appendChild(h);
  const counts = d.counts || {};
  if (!Object.keys(counts).length) line("modalnote", t("catInstallsNothing"));
  for (const [kindName, names] of Object.entries(d.components || {})) {
    const list = (names as any[]) || [];
    if (!list.length) continue;
    line("modalnote", `${kindName}: ${list.join(", ")}`);
  }
  // 토큰 비용: always_on 은 매 세션 상시 비용이라 on_invoke 보다 훨씬 중요하다. 먼저 적는다.
  for (const [model, tk] of Object.entries(d.tokens || {})) {
    const v: any = tk;
    line("modalnote", `${model}: always-on ${v.always_on ?? "-"} · on-invoke ${v.on_invoke ?? "-"} tok`,
      t("catTokensTip"));
  }
  if (d.homepage || row.homepage) mkHomepageLink(host, d.homepage || row.homepage);
}

function mkHomepageLink(host: HTMLElement, url: string): void {
  const a = document.createElement("a");
  a.className = "modallink";
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  a.textContent = t("catHomepage");
  host.appendChild(a);
}

// 설치 스코프 3종. project/local 은 claude 가 **cwd 로** 프로젝트를 정하므로 추적 중인
// 프로젝트를 골라 그 경로를 cwd 로 넘긴다. 추적 중인 프로젝트가 없으면 고를 대상이 없으므로
// 두 버튼을 비활성화하고 이유를 말한다(눌러서 엉뚱한 디렉토리에 설치되게 두지 않는다).
function mkInstallScopes(row: any, market: string, close: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "modalscopes";
  // 이미 저쪽에 설치돼 있으면 설치 버튼을 다시 주지 않는다 - 켜고 끄는 건 Plugins 섹션이다.
  if (ccPlugins.has(`${row.name}@${market}`)) {
    const n = document.createElement("div");
    n.className = "modalnote";
    n.textContent = t("catActivatedTip");
    wrap.appendChild(n);
    return wrap;
  }
  // 마켓이 Claude Code 에 없으면 install 이 해석되지 않는다. 눌러서 실패하게 두지 않는다.
  if (!ccMarkets.has(market)) {
    const n = document.createElement("div");
    n.className = "modalnote";
    n.textContent = noMarketTip(market);
    wrap.appendChild(n);
    return wrap;
  }
  const sel = document.createElement("select");
  sel.className = "catsel";
  for (const p of knownProjects) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p;
    sel.appendChild(o);
  }
  // 전역은 이 select 와 무관하다(claude_plugin_install 에 cwd 를 아예 안 보낸다). 그런데
  // 셋을 한 줄에 늘어놓고 그 위에 대상 프로젝트를 적으면 전역도 그 프로젝트로 가는 것처럼
  // 읽힌다. 그래서 전역은 위에 따로 두고, select 가 실제로 지배하는 둘만 한 구획에 담는다
  // - 담김 관계가 곧 적용 범위다.
  // select 는 그 구획 안에서도 **버튼보다 먼저**다. 뒤에 두면 어디에 설치되는지 모른 채
  // 누르게 되고, 실제로 그렇게 엉뚱한 경로(드라이브 루트)에 project 스코프로 설치되는 일이
  // 일어났다.
  const projBox = document.createElement("div");
  projBox.className = "scopeproj";
  if (knownProjects.length) {
    const row = document.createElement("div");
    row.className = "modalscoperow";
    const lb = document.createElement("span");
    lb.className = "modalnote";
    lb.textContent = t("catScopeTarget");
    row.append(lb, sel);
    projBox.appendChild(row);
  }
  const run = async (btn: HTMLButtonElement, scope: string) => {
    setPending(btn);
    try {
      const rr = jparse(await callTool("claude_plugin_install", {
        marketplace: market, plugin: row.name, scope,
        ...(scope === "user" ? {} : { cwd: sel.value }),
      }));
      if (rr && rr.ok === false) { flashToast(rr.message || t("failed")); clearPending(btn, scope); return; }
      close();
      flashToast(`${rr?.message || t("done")} · ${row.name}@${market}`);
      await refreshApp?.();
      await reloadCatalog();
    } catch (e) { clearPending(btn, scope); flashToast(t("failed")); console.error("[config-monitor] install scope", e); }
  };
  for (const [scope, label, tip] of [
    ["user", t("catScopeUser"), t("catScopeUserTip")],
    ["project", t("catScopeProject"), t("catScopeProjectTip")],
    ["local", t("catScopeLocal"), t("catScopeLocalTip")],
  ] as [string, string, string][]) {
    const b = document.createElement("button");
    b.className = "addbtn";
    b.textContent = label;
    b.title = tip;
    if (scope !== "user" && !knownProjects.length) {
      b.disabled = true;
      b.title = t("catScopeNoProject");
    } else {
      // 대상 경로를 tooltip 에도 적는다 - 위 select 를 못 본 채 눌러도 어디로 가는지 보인다.
      if (scope !== "user") b.title = `${tip}\n${t("catScopeTarget")} ${sel.value}`;
      b.addEventListener("click", () => run(b, scope));
      if (scope !== "user") sel.addEventListener("change", () => {
        b.title = `${tip}\n${t("catScopeTarget")} ${sel.value}`;
      });
    }
    (scope === "user" ? wrap : projBox).appendChild(b);
  }
  wrap.appendChild(projBox);
  return wrap;
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
  catSecEl = null;
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
