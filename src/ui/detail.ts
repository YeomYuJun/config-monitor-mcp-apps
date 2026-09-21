// src/ui/detail.ts - 오른쪽 상세 패널: 선택 파일의 스냅샷 이력과 두 버전 사이 diff, 그리고 복원.
// 패널 열림 여부(detailOpen)는 state 가 들고 있고 여기서는 화면에 반영만 한다.
import { t, errText } from "./i18n";
import { persistView } from "./view";
import { callTool, pushCtx, jparse, jparseLast } from "./bridge";
import { $, esc, flashToast } from "./widgets";
import { basename } from "./helpers";
import {
  selectedPath, currentRevs, fromRev, toRev, detailOpen, refreshApp,
  setSelectedPath, setCurrentRevs, setFromRev, setToRev, setDetailOpen,
} from "./state";

let rawDiff = false;   // 원문 diff 토글(무시 키 프로필 미적용). 파일을 바꿔도 유지
// cas 가 무시 키 변경을 알리는 문장의 접두어. UI 는 접두어만 번역하고 뒤의 키 목록은 그대로 보인다.
const IGNORED_ONLY = "무시 목록 항목만 다름";
const IGNORED_ALSO = "# 무시 목록 항목도 바뀜";

const revTime = (r: any) => (r.time || "").replace("T", " ").slice(0, 19);
const revLabel = (id: string) => {
  const r = currentRevs.find((x) => x.snapshot === id);
  return r ? r.message || "(no message)" : id;
};

export async function selectFile(p: string): Promise<void> {
  setSelectedPath(p);
  setFromRev("");
  setToRev("prev");
  setDetailOpen(true);
  applyDetailState();
  $("sel-name").textContent = basename(p);
  $("sel-path").textContent = p;
  // 선택 강조 갱신
  document.querySelectorAll(".file").forEach((el) => el.classList.remove("sel"));
  pushCtx(`[Config Monitor] 사용자가 '${p}' 의 변경 이력을 보는 중.`);
  persistView();
  const body = $("panel-body");
  body.innerHTML = `<div class="empty">${esc(t("loading"))}</div>`;
  const h = jparseLast(await callTool("get_file_history", { path: p }));
  // 응답 도착 전에 사용자가 다른 파일을 골랐으면 이 응답은 버린다. 안 버리면 헤더는 새 파일인데
  // 타임라인은 이전 파일이 되고, 그 상태로 복원하면 엉뚱한 파일이 롤백된다.
  if (selectedPath !== p) return;
  // 도구 실패({"ok":false})를 빈 이력으로 뭉개면 "스냅샷 없음" 이라는 거짓 안내가 된다.
  if (h && h.ok === false) {
    body.innerHTML = `<div class="empty err">${esc(t("fetchFail"))}: ${esc(errText(h, t("unknown")))}</div>`;
    return;
  }
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

  // 비교 대상 select. 기본은 '직전 리비전' - 후행 스냅샷 도입으로 리비전 하나 = 작업
  // 하나가 되었으므로, 리비전 클릭이 답할 질문은 "이 작업이 뭘 바꿨나"다.
  const cmp = document.createElement("div");
  cmp.className = "cmpbar";
  const opts = [`<option value="prev">${esc(t("cmpPrev"))}</option>`,
    `<option value="work">${esc(t("working"))}</option>`]
    .concat(revsDesc.map((r) =>
      `<option value="${esc(r.snapshot)}">${esc(revTime(r).slice(5, 16))} · ${esc(r.message || "")}</option>`))
    .join("");
  cmp.innerHTML = `<span class="dlabel">${esc(t("compareTo"))}</span><select id="cmp-to">${opts}</select>` +
    `<label class="rawtoggle"><input type="checkbox" id="raw-diff"${rawDiff ? " checked" : ""}>${esc(t("rawDiff"))}</label>`;
  body.appendChild(cmp);
  const sel = cmp.querySelector("#cmp-to") as HTMLSelectElement;
  sel.value = toRev;
  sel.addEventListener("change", () => { setToRev(sel.value); renderDiffFor(); });
  const rawBox = cmp.querySelector("#raw-diff") as HTMLInputElement;
  rawBox.addEventListener("change", () => { rawDiff = rawBox.checked; renderDiffFor(); });

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
    // 파일이 없던 시점의 리비전은 복원할 내용이 없다 - 눌러서 거절당하게 두지 않는다.
    const noFile = !r.hash;
    item.innerHTML =
      `<span class="rdot"></span>` +
      `<div class="rbody"><div class="rmsg" title="${esc(r.message || "")}">${esc(r.message || "(no message)")}</div>` +
      `<div class="rmeta">${esc(revTime(r))} · ${esc(r.hash || t("deletedHash"))}</div></div>` +
      `<button class="rrestore"${noFile ? " disabled" : ""} title="${esc(noFile ? t("restoreNoFile") : t("restoreTitle"))}">${esc(t("restore"))}</button>`;
    item.querySelector(".rbody")!.addEventListener("click", () => {
      // 선택만 바뀌면 renderHistory() 전체 재렌더(innerHTML 재구성)를 피한다 - 그러면
      // .rev-list 스크롤이 최상단으로 리셋된다. 강조 클래스만 교체 + diff 만 갱신
      // (비교 select 핸들러와 동일 패턴) -> 스크롤/펼침 상태 유지.
      setFromRev(r.snapshot);
      tl.querySelectorAll(".rev").forEach((el) => el.classList.remove("sel"));
      item.classList.add("sel");
      renderDiffFor();
    });
    if (!noFile) item.querySelector(".rrestore")!.addEventListener("click", (e) => {
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
      // 도구 실패는 {"ok":false} 문자열로 온다 - 파일 내용처럼 보여주고 캐시까지 하면
      // 닫았다 열어도 오류 원문이 내용 행세를 계속한다. 실패는 캐시하지 않는다.
      const err = jparse(content);
      if (err && err.ok === false) {
        pre.textContent = t("fetchFail") + ": " + errText(err, t("unknown"));
        return;
      }
      const fresh = err && err.ok === true && typeof err.content === "string";
      pre.textContent = (fresh ? err.content : content) || t("emptyFile");
      curLoaded = true;
    } catch (e) {
      pre.textContent = t("fetchFail") + ": " + String(e);
    }
  });
  body.appendChild(cur);
}

export async function renderDiffFor(): Promise<void> {
  if (!fromRev) return;
  const path = selectedPath, frm = fromRev, to = toRev, raw = rawDiff;
  // 기본 비교(prev)는 "이 리비전이 뭘 바꿨나" = 직전 리비전 -> 선택 리비전.
  // 직전이 없는 첫 리비전은 빈 내용(empty)과 비교해 파일 전체가 등장한 것으로 보인다.
  let reqFrom = frm;
  let reqTo: string | undefined = to !== "work" ? to : undefined;
  let fromLabel: string, toLabel: string;
  if (to === "prev") {
    const i = currentRevs.findIndex((r) => r.snapshot === frm);
    reqFrom = i > 0 ? currentRevs[i - 1].snapshot : "empty";
    reqTo = frm;
    fromLabel = i > 0 ? revLabel(reqFrom) : t("revNone");
    toLabel = revLabel(frm);
  } else {
    fromLabel = revLabel(frm);
    toLabel = to === "work" ? t("workingShort") : revLabel(to);
  }
  const args: Record<string, unknown> = { path, from: reqFrom };
  if (reqTo) args.to = reqTo;
  if (raw) args.raw = true;
  try {
    const diff = await callTool("get_diff", args);
    // 응답 대기 중 파일/리비전 선택이 바뀌었으면 버린다(selectFile 의 가드와 같은 근거 -
    // 안 버리면 강조는 새 리비전인데 diff 영역과 모델 컨텍스트는 이전 것으로 덮인다).
    if (path !== selectedPath || frm !== fromRev || to !== toRev || raw !== rawDiff) return;
    // 도구 실패는 {"ok":false} 문자열로 온다 - diff 본문으로 그리거나 컨텍스트에 넣지 않는다.
    const err = jparse(diff);
    if (err && err.ok === false) {
      const area = document.getElementById("diff-area");
      if (area) area.innerHTML = `<div class="empty err">${esc(t("diffFetchFail"))}: ${esc(errText(err, t("unknown")))}</div>`;
      return;
    }
    // 화면에 보이는 diff 를 모델 컨텍스트에도 얹는다(앞 2KB) - 사용자가 변경 내용을 물으면
    // 모델이 화면과 같은 근거로 답하게(updateModelContext, standalone 은 no-op).
    const fresh = err && err.ok === true && typeof err.kind === "string";
    const shown = fresh ? (err.kind === "diff" ? err.diff : err.message) : diff;
    pushCtx(`[Config Monitor] '${path}' diff ${reqFrom} -> ${reqTo || "work"}:\n${String(shown).slice(0, 2048)}`);
    if (fresh) renderDiffResult(err, fromLabel, toLabel);
    else renderDiff(diff, fromLabel, toLabel);
  } catch (e) {
    const area = document.getElementById("diff-area");
    if (area) area.innerHTML = `<div class="empty err">${esc(t("diffFetchFail"))}: ${esc(String(e))}</div>`;
  }
}

const KIND_KEY: Record<string, string> = {
  no_change: "noDiff", eol_or_bom_only: "eolOnlyDiff", whitespace_only: "formatOnlyDiff",
  no_snapshot: "noSnapshotDiff", both_absent: "bothAbsentDiff",
};

function renderDiffResult(r: any, fromLabel: string, toLabel: string): void {
  if (r.kind === "diff") { renderDiff(r.diff, fromLabel, toLabel, r.ignored || ""); return; }
  const area = document.getElementById("diff-area");
  if (!area) return;
  const msg = r.kind === "ignored_only" ? `${t("ignoredOnlyDiff")}: ${r.ignored}`
    : KIND_KEY[r.kind] ? t(KIND_KEY[r.kind]) : r.message;
  area.innerHTML = `<div class="diffempty">${esc(msg || t("noDiff"))}</div>`;
}

function renderDiff(diff: string, fromLabel: string, toLabel: string, ignored = ""): void {
  const area = document.getElementById("diff-area");
  if (!area) return;
  // unified diff 는 항상 @@ 헌크를 가진다 - 없으면 diff 가 아니라 cas 의 안내 메시지
  // (변경 없음 / 개행·BOM 만 다름 / 스냅샷 없음 등)이므로 그대로 안내로 보여준다.
  if (!/^@@/m.test(diff)) {
    const msg = diff.trim();
    const mapped = msg === "텍스트 변경 없음" ? t("noDiff")
      : msg.startsWith("줄 내용 동일") ? t("eolOnlyDiff")
      : msg.startsWith("표기만 다름") ? t("formatOnlyDiff")
      : msg.startsWith(IGNORED_ONLY) ? t("ignoredOnlyDiff") + msg.slice(IGNORED_ONLY.length) : msg;
    area.innerHTML = `<div class="diffempty">${esc(mapped || t("noDiff"))}</div>`;
    return;
  }
  // CRLF 파일의 diff 는 각 줄 끝에 \r 이 남는데, .dl 이 white-space:pre-wrap 이라
  // 그 \r 이 segment break 로 렌더돼 빈 줄처럼 보인다. 개행 종류와 무관하게 분리.
  const raw = diff.split(/\r?\n/);
  const cls = raw.map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) return "add";
    if (line.startsWith("-") && !line.startsWith("---")) return "del";
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith(IGNORED_ALSO)) return "note";
    return "";
  });
  const html = raw.map((line, i) => {
    const text = cls[i] === "note" ? t("ignoredAlso") + line.slice(IGNORED_ALSO.length) : line;
    return `<div class="dl ${cls[i]}">${esc(text) || "&nbsp;"}</div>`;
  });
  if (ignored) html.push(`<div class="dl note">${esc(`${t("ignoredAlso")}: ${ignored}`)}</div>`);
  // 줄 안 하이라이트: 연속 del 묶음과 뒤따르는 add 묶음을 순서대로 짝지어, 공통 접두/접미를
  // 뺀 가운데만 강조한다. JSON 설정은 한 줄에서 값 하나가 바뀌는 경우가 대부분이라 이게
  // 판독 시간을 좌우한다. 줄 대부분이 바뀐 짝(80% 초과)은 전면 재작성이라 칠하지 않는다.
  for (let i = 0; i < raw.length; ) {
    if (cls[i] !== "del") { i++; continue; }
    const ds = i;
    while (i < raw.length && cls[i] === "del") i++;
    const as = i;
    while (i < raw.length && cls[i] === "add") i++;
    const pairs = Math.min(as - ds, i - as);
    for (let k = 0; k < pairs; k++) {
      const d = raw[ds + k].slice(1), a = raw[as + k].slice(1);
      let p = 0;
      while (p < d.length && p < a.length && d[p] === a[p]) p++;
      let s = 0;
      while (s < d.length - p && s < a.length - p && d[d.length - 1 - s] === a[a.length - 1 - s]) s++;
      const longest = Math.max(d.length, a.length);
      const mid = longest - p - s;
      if (mid <= 0 || mid > longest * 0.8) continue;
      const mk = (body: string, marker: string, klass: string) =>
        `<div class="dl ${klass}">${esc(marker)}${esc(body.slice(0, p))}` +
        `<span class="ichg">${esc(body.slice(p, body.length - s))}</span>` +
        `${esc(body.slice(body.length - s))}</div>`;
      html[ds + k] = mk(d, raw[ds + k][0], "del");
      html[as + k] = mk(a, raw[as + k][0], "add");
    }
  }
  area.innerHTML =
    `<div class="diffwrap"><div class="diffhead">` +
    `<span>${esc(fromLabel)}</span><span class="arrow">→</span><span>${esc(toLabel)}</span></div>` +
    `<div class="difflines">${html.join("")}</div></div>`;
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
      else box.innerHTML = `<span class="rmeta err">${esc(t("failed"))}: ${esc(errText(res, t("unknown")))}</span>`;
    } catch (err) {
      box.innerHTML = `<span class="rmeta err">${esc(t("failed"))}: ${esc(String(err))}</span>`;
    }
  });
}

// ----- detail panel open/close -----
export function applyDetailState(): void {
  $("detail").classList.toggle("closed", !detailOpen);
}

