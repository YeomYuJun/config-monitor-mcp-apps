// src/mcp-app.ts - Config Monitor UI (iframe side). Talks to host via App bridge.
//   get_config       -> collapsible config sections (with source path)
//   get_tracked      -> tracked file rows (click -> history)
//   get_file_history -> revision timeline
//   get_diff         -> from->to unified diff
//   config_*/config_restore/watcher_* -> inline edit / restore / watcher control
//   updateModelContext -> inject what the user is viewing into Claude context
import { app, STANDALONE, callTool, jparse, jparseLast } from "./ui/bridge";
import { t, getLang, setLang, errText } from "./ui/i18n";
import { $, esc, openReasonModal, flashToast } from "./ui/widgets";
import {
  selectedPath, currentRevs, setDetailOpen, collapsed, secIds, libProjectTargets, setLibTarget,
  setScopeFilter, setRefreshApp, setCatSecEl, sectionPrefs,
} from "./ui/state";
import { renderConfig, applySectionPrefs, wireSectionPrefs } from "./ui/config";
import { selectFile, renderHistory, renderDiffFor, applyDetailState } from "./ui/detail";
import { renderCatalog } from "./ui/market";
import { renderTracked } from "./ui/tracked";
import { refreshLibrary } from "./ui/library";
import { INSTANCE_ID, persistView } from "./ui/view";
// ----- load / refresh -----
function showErr(hostId: string, label: string, e: unknown): void {
  console.error(`[config-monitor] ${label}`, e);
  $(hostId).innerHTML = `<div class="empty err">${esc(label)} ${esc(t("fetchFail"))}: ${esc(String(e))}</div>`;
}

// 재진입 가드: 진행 중 refresh 위에 겹치면 wrap 밖에 append 되는 Library/카탈로그 섹션이
// 두 벌 그려진다(설치 액션의 refreshApp 과 새로고침 클릭이 겹치는 경우). 겹친 요청은
// 버리지 않고 끝난 뒤 한 번 더 돌아 마지막 상태를 반영한다.
let refreshBusy = false;
let refreshQueued = false;
async function refresh(): Promise<void> {
  if (refreshBusy) { refreshQueued = true; return; }
  refreshBusy = true;
  try {
    await refreshInner();
  } finally {
    refreshBusy = false;
    if (refreshQueued) { refreshQueued = false; void refresh(); }
  }
}

async function refreshInner(): Promise<void> {
  // 설치/제거 후의 재렌더로 스크롤이 맨 위로 튀면 작업하던 행을 매번 다시 찾아가야 한다.
  // 목록 길이가 크게 바뀌면 어차피 어긋나지만, 같은 자리에서 이어 작업하는 경우가 압도적이다.
  const scroller = document.querySelector<HTMLElement>(".left");
  const scrollTop = scroller ? scroller.scrollTop : 0;
  setCatSecEl(null);
  $("config").innerHTML = `<div class="empty">${esc(t("loading"))}</div>`;
  $("tracked").innerHTML = `<div class="empty">${esc(t("loading"))}</div>`;
  let trackedCount = 0;
  try {
    const trk = jparseLast(await callTool("get_tracked", { phase: booted ? "refresh" : "boot", instance: INSTANCE_ID }));
    if (trk && trk.ok !== false) {
      trackedCount = renderTracked(trk);
      lastTrk = trk;   // 폴링의 변화 판별 기준점(재렌더 직후 상태)
      // 여기서 흡수하면 이 UI 자신의 편집(도구 호출 -> refresh)은 폴링을 다시 깨우지 않는다.
      if (trk.change && trk.change.seq !== undefined) lastChangeSeq = trk.change.seq;
    } else $("tracked").innerHTML = `<div class="empty">${esc(errText(trk, t("emptyTrackedResp")))}</div>`;
  } catch (e) {
    showErr("tracked", t("trackedStatus"), e);
  }
  let restoreView: any = null;
  try {
    const pf = jparse(await callTool("get_prefs"));
    if (pf && pf.ok !== false) {
      applySectionPrefs(pf.ui);
      // 첫 부트에서만 보던 자리를 되살린다. 이후 refresh 는 현재 화면 상태가 진실이다.
      if (!booted && pf.ui && pf.ui.view) restoreView = pf.ui.view;
    }
  } catch (e) { console.error("[config-monitor] prefs", e); }
  if (restoreView) {
    if (typeof restoreView.scope === "string") setScopeFilter(restoreView.scope);
    if (typeof restoreView.libTarget === "string") setLibTarget(restoreView.libTarget);
    if (typeof restoreView.detailOpen === "boolean") { setDetailOpen(restoreView.detailOpen); applyDetailState(); }
  }
  booted = true;
  try {
    // libProjectTargets(추적 프로젝트 .claude 경로들)는 앞선 renderTracked 에서 채워짐 -> 프로젝트 스코프 설정 포함.
    const cfg = jparse(await callTool("get_config", { projects: libProjectTargets, includeMissing: sectionPrefs.includeMissingProjects }));
    if (cfg && cfg.ok !== false) {
      renderConfig(cfg.sections || []);
      // settingsHint 앞자리 숫자만 실제 카테고리 수로 치환해 라이브 카운트 유지.
      $("config-hint").textContent = t("settingsHint").replace(/^\d+/, String((cfg.sections || []).length));
    } else $("config").innerHTML = `<div class="empty">${esc(errText(cfg, t("emptyConfigResp")))}</div>`;
  } catch (e) {
    showErr("config", t("settings"), e);
  }
  try { await refreshLibrary(); } catch (e) { console.error("[config-monitor] library", e); }
  try { await renderCatalog($("config")); } catch (e) { console.error("[config-monitor] catalog", e); }
  const now = new Date().toTimeString().slice(0, 8);
  $("subtitle").textContent = `${t("generatedPrefix")}${trackedCount}${t("generatedMid")}${now}`;
  if (scroller) scroller.scrollTop = scrollTop;
  refreshWatcher();
  // 되살릴 파일이 아직 추적 중일 때만 연다(추적 해제된 경로면 빈 패널 대신 그냥 지나간다).
  if (restoreView && restoreView.selectedPath && lastTrk && bucketOf(lastTrk, restoreView.selectedPath)) {
    void selectFile(restoreView.selectedPath);
  }
  if (pollTimer === undefined) pollTimer = window.setInterval(pollStatus, POLL_MS);
}
let booted = false;
// 선언 직후 등록한다 - 모듈 최상위라 어떤 이벤트 핸들러보다 먼저 실행된다.
setRefreshApp(refresh);

// ----- watcher status badge + toggle -----
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let watcherRunning = false;

function renderWatcherState(st: any): void {
  const dot = $("watcher-dot");
  const label = $("watcher-label");
  const btn = $("watcher-toggle") as HTMLButtonElement;
  const failed = st?.ok === false;
  watcherRunning = !failed && !!(st && st.running);
  dot.className = "wdot" + (watcherRunning ? " on" : "");
  // 파싱/상태 오류는 '정지'로 뭉개지 않고 명시한다 (침묵 실패가 디버깅을 막았던 회귀 가드).
  label.textContent = watcherRunning ? t("watcherOn")
    : (failed || st?.error) ? t("watcherErr")
    : st?.stale ? t("watcherStale")
    : t("watcherOff");
  btn.title = watcherRunning
    ? `pid ${st.pid} · ${(st.dirs || []).length} dirs · ${Math.round(st.age_sec || 0)}s ${t("ago")}`
    : ((st?.message && errText(st)) || st?.error || (st?.stale ? `${t("watcherStaleTip")}: ${st.heartbeat}` : st?.reason) || t("stopped"));
}

async function refreshWatcher(): Promise<boolean> {
  try {
    renderWatcherState(jparse(await callTool("watcher_status")));
  } catch (e) {
    watcherRunning = false;
    $("watcher-dot").className = "wdot";
    $("watcher-label").textContent = "watcher ?";
    ($("watcher-toggle") as HTMLButtonElement).title = String(e);
  }
  return watcherRunning;
}

let watcherBusy = false;   // 토글 진행 중이면 폴링이 배지를 stale 상태로 되돌리지 않게

$("watcher-toggle").addEventListener("click", async () => {
  const btn = $("watcher-toggle") as HTMLButtonElement;
  const label = $("watcher-label");
  btn.disabled = true;
  watcherBusy = true;
  label.textContent = "…";
  try {
    if (watcherRunning) {
      await callTool("watcher_stop");
      flashToast(t("toastWatcherStop"));
      await refreshWatcher();
    } else {
      // watcher.py 가 spawn 후 heartbeat 를 쓰기까지 1~2s 걸린다.
      // 시작 직후 status 는 아직 정지이므로 잠시 기다렸다가 재폴링한다.
      const r = jparse(await callTool("watcher_start"));
      if (r && r.ok === false) {
        // 기동 실패를 성공 토스트로 덮지 않는다 - 사유(권한/PATH)는 모달로 남긴다.
        openReasonModal(t("failed"), errText(r));
        await refreshWatcher();
      } else {
        flashToast(t("toastWatcherStart"));
        for (let i = 0; i < 5; i++) {
          await delay(900);
          if (await refreshWatcher()) { flashToast(t("watcherOn")); break; }
        }
      }
    }
  } catch (e) { console.error("[config-monitor] watcher toggle", e); await refreshWatcher(); }
  finally { btn.disabled = false; watcherBusy = false; }
});

// ----- 실시간성: 상태 폴링 -----
// MCP Apps 에는 서버->앱 푸시 채널이 없다(호스트발 ui/notifications/tool-* 는 이 앱을 띄운
// 도구 호출에 묶인다). 그래서 보일 때만 status 를 폴링하고, 실제 변화가 있을 때만 재렌더한다.
// status --json 은 stat fast-path(내용 해싱 없음) + watcher heartbeat 동봉이라 한 호출로 끝난다.
const POLL_MS = 5000;
let pollTimer: number | undefined;
let pollBusy = false;
let lastTrk: any = null;
let lastChangeSeq: number | null = null;

// heartbeat 는 매 틱 바뀌므로 watcher/last_snapshot 을 뺀 나머지로 변화를 판별한다.
const trackedCmp = (trk: any): string => {
  const { watcher: _w, last_snapshot: _s, ...rest } = trk || {};
  return JSON.stringify(rest);
};
const bucketOf = (trk: any, p: string): string => {
  for (const k of ["new", "modified", "deleted", "unchanged"]) if (((trk || {})[k] || []).includes(p)) return k;
  return "";
};

// 열린 이력 패널의 최신 리비전과 서버의 최신 리비전이 다른가(=선택 파일에 새 스냅샷이 붙었나).
async function selectedFileHasNewRevision(): Promise<boolean> {
  const h = jparseLast(await callTool("get_file_history", { path: selectedPath }));
  const revs: any[] = (h && h.revisions) || [];
  const latest = revs.length ? revs[revs.length - 1].snapshot : "";
  const curLatest = currentRevs.length ? currentRevs[currentRevs.length - 1].snapshot : "";
  return latest !== curLatest;
}

async function pollStatus(): Promise<void> {
  if (document.hidden || pollBusy) return;
  const host = document.getElementById("tracked");
  if (!host) return;
  // 입력값/포커스/펼친 프로젝트 목록이 있는 동안 재렌더하면 작업 중인 상태가 날아간다 - 건너뛴다.
  const input = host.querySelector<HTMLInputElement>(".adder input");
  if ((input && input.value) || host.contains(document.activeElement) ||
      host.querySelector(".projpicklist:not([hidden])")) return;
  pollBusy = true;
  try {
    const trk = jparseLast(await callTool("get_tracked", { phase: "poll", instance: INSTANCE_ID }));
    if (!trk || trk.ok === false) return;
    if (trk.watcher && !watcherBusy) renderWatcherState(trk.watcher);
    const changed = trackedCmp(trk) !== trackedCmp(lastTrk);
    const snapMoved = !!lastTrk && trk.last_snapshot !== lastTrk.last_snapshot;
    const selBucketChanged = !!selectedPath && bucketOf(trk, selectedPath) !== bucketOf(lastTrk, selectedPath);
    lastTrk = trk;
    // 다른 클라이언트(대화 중인 Claude, 다른 창)의 편집 도구 호출은 서버가 change.seq 로 알린다.
    // 추적 파일 밖의 변화(스킬 폴더 제거 등)는 tracked 비교로는 안 보이므로 여기서 전체 refresh.
    const seq = trk.change ? trk.change.seq : undefined;
    if (seq !== undefined && lastChangeSeq !== null && seq !== lastChangeSeq) {
      lastChangeSeq = seq;
      await refresh();
      return;
    }
    if (seq !== undefined) lastChangeSeq = seq;
    if (changed) {
      const scroller = document.querySelector<HTMLElement>(".left");
      const st = scroller ? scroller.scrollTop : 0;
      renderTracked(trk);
      if (scroller) scroller.scrollTop = st;
    }
    // 선택 파일이 실제로 움직였을 때만 열린 이력/diff 를 다시 읽는다(비교 선택이 리셋되므로).
    if (selectedPath && (selBucketChanged || (snapMoved && await selectedFileHasNewRevision()))) {
      await selectFile(selectedPath);
    }
  } catch { /* 폴링 실패는 다음 틱에 자연 회복 */ }
  finally { pollBusy = false; }
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
  try {
    const r = jparse(await callTool("open_in_browser"));
    if (r && r.ok === false) { openReasonModal(t("toastOpenFail"), errText(r)); return; }
    flashToast(t("toastTabOpened"));
  } catch (e) { flashToast(t("toastOpenFail")); console.error("[config-monitor] open_in_browser", e); }
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
  // 스냅샷 저장소 정리: 1클릭 = dry-run 으로 대상 계산만, 같은 버튼 재클릭 = 실행.
  // 파괴적 동작이라 숫자를 먼저 보여주고 두 번째 클릭을 받는다. 팝오버가 닫히면 해제.
  const gcBtn = $("opt-gc") as HTMLButtonElement;
  const gcRes = $("gc-result");
  const resetGc = () => { gcArmed = false; gcBtn.textContent = t("gcScan"); gcBtn.classList.remove("danger"); };
  let gcArmed = false;
  gcBtn.addEventListener("click", async () => {
    gcBtn.disabled = true;
    try {
      const r = jparse(await callTool("snapshot_gc", { dryRun: !gcArmed }));
      gcRes.hidden = false;
      if (!r || r.ok === false) { gcRes.textContent = errText(r); resetGc(); return; }
      const line = `${t("gcSnaps")} ${r.removed_snapshots} · ${t("gcObjs")} ${r.removed_objects} · ${(r.freed_bytes / 1048576).toFixed(1)} MB`;
      if (!gcArmed) {
        if (!r.removed_snapshots && !r.removed_objects) { gcRes.textContent = t("gcNothing"); resetGc(); return; }
        // 계산 결과는 완료 보고와 같은 모양이라 접두 없이는 이미 지운 것으로 읽힌다.
        gcRes.textContent = `${t("gcPlan")} · ${line}`;
        gcArmed = true;
        gcBtn.textContent = `${t("gcRun")} (${r.removed_snapshots + r.removed_objects})`;
        gcBtn.classList.add("danger");
      } else {
        gcRes.textContent = `${t("gcDone")} · ${line}`;
        flashToast(t("gcDone"));
        resetGc();
        if (selectedPath) selectFile(selectedPath);   // 타임라인이 줄었을 수 있다
      }
    } catch (e) { gcRes.hidden = false; gcRes.textContent = String(e); resetGc(); }
    finally { gcBtn.disabled = false; }
  });
  wireSectionPrefs();
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
  secIds.forEach((id) => collapsed.add(id));
  document.querySelectorAll("#config .sec[data-col]").forEach((el) => el.classList.add("collapsed"));
});
$("refresh").addEventListener("click", () => { refresh(); flashToast(t("toastRefreshed")); });
$("snap").addEventListener("click", async () => {
  const raw = await callTool("snapshot_now", { message: t("snapshotMsg") });
  const r = jparse(raw);
  if (r && r.ok === false) { openReasonModal(t("failed"), errText(r)); return; }
  // 변경이 없어 생략된 경우까지 "생성됨" 토스트를 띄우지 않는다. 평문은 재시작 전 서버의 응답이다.
  if (r?.ok === true ? r.code === "noop" : raw.trim().startsWith("변경 없음")) { flashToast(t("snapNoChange")); return; }
  flashToast(t("toastSnapshot"));
  await refresh();
  if (selectedPath) selectFile(selectedPath);
});
$("panel-close").addEventListener("click", () => { setDetailOpen(false); applyDetailState(); persistView(); });
$("panel-reopen").addEventListener("click", () => { setDetailOpen(true); applyDetailState(); persistView(); });
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
