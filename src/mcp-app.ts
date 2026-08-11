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
import { refreshLibrary } from "./ui/library";
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
  try {
    const r = jparse(await callTool("open_in_browser"));
    if (r && r.ok === false) { openReasonModal(t("toastOpenFail"), r.message || t("failed")); return; }
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
