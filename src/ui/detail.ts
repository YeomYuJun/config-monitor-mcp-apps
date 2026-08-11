// src/ui/detail.ts - 오른쪽 상세 패널: 선택 파일의 스냅샷 이력과 두 버전 사이 diff, 그리고 복원.
// 패널 열림 여부(detailOpen)는 state 가 들고 있고 여기서는 화면에 반영만 한다.
import { t } from "./i18n";
import { callTool, pushCtx, jparse, jparseLast } from "./bridge";
import { $, esc, flashToast } from "./widgets";
import { basename } from "./helpers";
import {
  selectedPath, currentRevs, fromRev, toRev, detailOpen, refreshApp,
  setSelectedPath, setCurrentRevs, setFromRev, setToRev, setDetailOpen,
} from "./state";

const revTime = (r: any) => (r.time || "").replace("T", " ").slice(0, 19);
const revLabel = (id: string) => {
  const r = currentRevs.find((x) => x.snapshot === id);
  return r ? r.message || "(no message)" : id;
};

export async function selectFile(p: string): Promise<void> {
  setSelectedPath(p);
  setFromRev("");
  setToRev("work");
  setDetailOpen(true);
  applyDetailState();
  $("sel-name").textContent = basename(p);
  $("sel-path").textContent = p;
  // 선택 강조 갱신
  document.querySelectorAll(".file").forEach((el) => el.classList.remove("sel"));
  pushCtx(`[Config Monitor] 사용자가 '${p}' 의 변경 이력을 보는 중.`);
  const body = $("panel-body");
  body.innerHTML = `<div class="empty">${esc(t("loading"))}</div>`;
  const h = jparseLast(await callTool("get_file_history", { path: p }));
  // 응답 도착 전에 사용자가 다른 파일을 골랐으면 이 응답은 버린다. 안 버리면 헤더는 새 파일인데
  // 타임라인은 이전 파일이 되고, 그 상태로 복원하면 엉뚱한 파일이 롤백된다.
  if (selectedPath !== p) return;
  setCurrentRevs((h && h.revisions) || []);
  // 선택 행 다시 표시(refresh 없이 강조만). full path 로 매칭(같은 basename, 예: 여러 settings.json
  // 파일이 함께 강조되는 버그 방지).
  document.querySelectorAll<HTMLElement>(".file").forEach((el) => {
    if (el.dataset.path === p) el.classList.add("sel");
  });
  if (!currentRevs.length) {
    body.innerHTML = `<div class="empty">${esc(t("noHistory"))}</div>`;
    return;
  }
  if (currentRevs.length) setFromRev(currentRevs[currentRevs.length - 1].snapshot);
  renderHistory();
  renderDiffFor();
}

export function renderHistory(): void {
  const body = $("panel-body");
  body.innerHTML = "";
  const revsDesc = currentRevs.slice().reverse();

  // 비교 대상 select
  const cmp = document.createElement("div");
  cmp.className = "cmpbar";
  const opts = [`<option value="work">${esc(t("working"))}</option>`]
    .concat(revsDesc.map((r) =>
      `<option value="${esc(r.snapshot)}">${esc(revTime(r).slice(5, 16))} · ${esc(r.message || "")}</option>`))
    .join("");
  cmp.innerHTML = `<span class="dlabel">${esc(t("compareTo"))}</span><select id="cmp-to">${opts}</select>`;
  body.appendChild(cmp);
  const sel = cmp.querySelector("#cmp-to") as HTMLSelectElement;
  sel.value = toRev;
  sel.addEventListener("change", () => { setToRev(sel.value); renderDiffFor(); });

  // 타임라인
  const hl = document.createElement("div");
  hl.className = "dlabel";
  hl.textContent = t("history");
  body.appendChild(hl);

  // 고정 높이 스크롤 컨테이너 > relative 트랙 (spine 이 스크롤 내용과 함께 늘어나도록)
  const list = document.createElement("div");
  list.className = "rev-list";
  const tl = document.createElement("div");
  tl.className = "rev-track";
  tl.innerHTML = `<div class="spine"></div>`;
  revsDesc.forEach((r) => {
    const item = document.createElement("div");
    item.className = "rev" + (r.snapshot === fromRev ? " sel" : "");
    item.innerHTML =
      `<span class="rdot"></span>` +
      `<div class="rbody"><div class="rmsg" title="${esc(r.message || "")}">${esc(r.message || "(no message)")}</div>` +
      `<div class="rmeta">${esc(revTime(r))} · ${esc(r.hash || t("deletedHash"))}</div></div>` +
      `<button class="rrestore" title="${esc(t("restoreTitle"))}">${esc(t("restore"))}</button>`;
    item.querySelector(".rbody")!.addEventListener("click", () => {
      // 선택만 바뀌면 renderHistory() 전체 재렌더(innerHTML 재구성)를 피한다 - 그러면
      // .rev-list 스크롤이 최상단으로 리셋된다. 강조 클래스만 교체 + diff 만 갱신
      // (비교 select 핸들러와 동일 패턴) -> 스크롤/펼침 상태 유지.
      setFromRev(r.snapshot);
      tl.querySelectorAll(".rev").forEach((el) => el.classList.remove("sel"));
      item.classList.add("sel");
      renderDiffFor();
    });
    item.querySelector(".rrestore")!.addEventListener("click", (e) => {
      e.stopPropagation(); inlineRestore(e.currentTarget as HTMLElement, r);
    });
    tl.appendChild(item);
  });
  list.appendChild(tl);
  body.appendChild(list);

  // Diff 접이식(현재 파일 내용 뷰어와 동일한 curwrap 패턴). 기본 펼침.
  const diffWrap = document.createElement("div");
  diffWrap.className = "curwrap open";
  diffWrap.innerHTML =
    `<div class="curhead"><span class="chev3">▸</span><span>Diff</span></div>` +
    `<div class="curbody"><div id="diff-area"></div></div>`;
  diffWrap.querySelector(".curhead")!.addEventListener("click", () => diffWrap.classList.toggle("open"));
  body.appendChild(diffWrap);

  // 현재 파일 내용 뷰어 — 기본 접힘, 첫 펼침 때 lazy 조회. 보기 전용(편집 아님).
  const cur = document.createElement("div");
  cur.className = "curwrap";
  cur.innerHTML =
    `<div class="curhead"><span class="chev3">▸</span><span>${esc(t("curFileTitle"))}</span>` +
    `<span class="rhint">${esc(t("readOnly"))}</span></div>` +
    `<div class="curbody"><pre>${esc(t("loading"))}</pre></div>`;
  let curLoaded = false;
  cur.querySelector(".curhead")!.addEventListener("click", async () => {
    const open = cur.classList.toggle("open");
    if (!open || curLoaded) return;
    const pre = cur.querySelector("pre")!;
    try {
      const content = await callTool("get_file_content", { path: selectedPath });
      pre.textContent = content || t("emptyFile");
      curLoaded = true;
    } catch (e) {
      pre.textContent = t("fetchFail") + ": " + String(e);
    }
  });
  body.appendChild(cur);
}

export async function renderDiffFor(): Promise<void> {
  if (!fromRev) return;
  pushCtx(`[Config Monitor] '${selectedPath}' diff ${fromRev} -> ${toRev}.`);
  const args: Record<string, unknown> = { path: selectedPath, from: fromRev };
  if (toRev && toRev !== "work") args.to = toRev;
  try {
    renderDiff(await callTool("get_diff", args));
  } catch (e) {
    const area = document.getElementById("diff-area");
    if (area) area.innerHTML = `<div class="empty err">${esc(t("diffFetchFail"))}: ${esc(String(e))}</div>`;
  }
}

function renderDiff(diff: string): void {
  const area = document.getElementById("diff-area");
  if (!area) return;
  if (!diff.trim() || diff.trim() === "텍스트 변경 없음") {
    area.innerHTML = `<div class="diffempty">${esc(t("noDiff"))}</div>`;
    return;
  }
  const fromLabel = revLabel(fromRev);
  const toLabel = toRev === "work" ? t("workingShort") : revLabel(toRev);
  // CRLF 파일의 diff 는 각 줄 끝에 \r 이 남는데, .dl 이 white-space:pre-wrap 이라
  // 그 \r 이 segment break 로 렌더돼 빈 줄처럼 보인다. 개행 종류와 무관하게 분리.
  const lines = diff.split(/\r?\n/).map((line) => {
    let cls = "";
    if (line.startsWith("+") && !line.startsWith("+++")) cls = "add";
    else if (line.startsWith("-") && !line.startsWith("---")) cls = "del";
    else if (line.startsWith("@@")) cls = "hunk";
    return `<div class="dl ${cls}">${esc(line) || "&nbsp;"}</div>`;
  }).join("");
  area.innerHTML =
    `<div class="diffwrap"><div class="diffhead">` +
    `<span>${esc(fromLabel)}</span><span class="arrow">→</span><span>${esc(toLabel)}</span></div>` +
    `<div class="difflines">${lines}</div></div>`;
}

// 복원: window.confirm 회피 위해 인라인 확인. 복원 전 자동 스냅샷+.bak 은 서버가 보장.
function inlineRestore(btn: HTMLElement, r: any): void {
  const box = document.createElement("span");
  box.className = "rconfirm";
  box.innerHTML = `<button class="ok" title="${esc(t("restoreNote"))}">${esc(t("restoreConfirm"))}</button><button class="no">${esc(t("cancel"))}</button>`;
  btn.replaceWith(box);
  box.querySelector(".no")!.addEventListener("click", (e) => { e.stopPropagation(); renderHistory(); });
  box.querySelector(".ok")!.addEventListener("click", async (e) => {
    e.stopPropagation();
    box.innerHTML = `<span class="rmeta">${esc(t("restoring"))}</span>`;
    try {
      const res = jparse(await callTool("config_restore", { path: selectedPath, from: r.snapshot }));
      if (res && res.ok) { flashToast(t("toastRestored")); await refreshApp?.(); await selectFile(selectedPath); }
      else box.innerHTML = `<span class="rmeta err">${esc(t("failed"))}: ${esc(res?.message || t("unknown"))}</span>`;
    } catch (err) {
      box.innerHTML = `<span class="rmeta err">${esc(t("failed"))}: ${esc(String(err))}</span>`;
    }
  });
}

// ----- detail panel open/close -----
export function applyDetailState(): void {
  $("detail").classList.toggle("closed", !detailOpen);
}

