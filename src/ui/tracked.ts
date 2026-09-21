// src/ui/tracked.ts - 왼쪽 추적 파일 목록과 그 위의 경로 추가 입력행 · 프로젝트 피커.
// 행을 누르면 detail 패널을 연다(selectFile) - 반대 방향 의존은 없다.
import { t } from "./i18n";
import { callTool, jparse } from "./bridge";
import { $, esc, setPending, clearPending, mkNotice, openReasonModal, flashToast } from "./widgets";
import { basename, dirname, ABS_PATH_RE } from "./helpers";
import { selectedPath, libProjectTargets, refreshApp, setLibProjectTargets, sectionPrefs } from "./state";
import { selectFile } from "./detail";

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
    toggle.classList.toggle("on", !list.hidden);
    if (list.hidden || loaded) return;
    list.innerHTML = `<div class="empty">${esc(t("loading"))}</div>`;
    try {
      const res = jparse(await callTool("list_projects", { includeMissing: sectionPrefs.includeMissingProjects }));
      // 실패를 성공처럼 캐시하면 닫았다 열어도 재시도가 없다 - 성공했을 때만 loaded 를 세운다.
      if (res && res.ok === false) { list.innerHTML = `<div class="empty">${esc(res.message || t("failed"))}</div>`; return; }
      loaded = true;
      const projs = res && Array.isArray(res.projects) ? res.projects : [];
      const trackedNorm = new Set(libProjectTargets.map((c) => c.replace(/\\/g, "/").toLowerCase()));
      list.innerHTML = "";
      if (!projs.length) { list.innerHTML = `<div class="empty">${esc(t("projPickEmpty"))}</div>`; return; }
      for (const p of projs) {
        const already = trackedNorm.has(String(p.claude_dir).replace(/\\/g, "/").toLowerCase());
        // .claude 가 없으면 추적할 파일이 없다 - 눌러도 실패할 행은 비활성으로 보여만 준다.
        const tag = already ? t("projPickTracked") : p.has_claude ? "" : t("projPickNoClaude");
        const row = document.createElement("button");
        row.className = "projpickrow" + (tag ? " tracked" : "");
        row.disabled = !!tag;
        row.innerHTML =
          `<span class="pnm">${esc(p.name)}</span><span class="ppath">${esc(p.claude_dir)}</span>` +
          (tag ? `<span class="ptag">${esc(tag)}</span>` : "");
        if (!tag) row.addEventListener("click", async () => {
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

export function renderTracked(status: any): number {
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
