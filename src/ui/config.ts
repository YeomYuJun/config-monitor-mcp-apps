// src/ui/config.ts - 설정 카드(8분류) 렌더와 인라인 편집(권한 · hooks · mcp · skill · agent · plugin).
// 밖으로 나가는 건 renderConfig 하나뿐이고, 재렌더는 refreshApp 훅으로 엔트리에 되묻는다.
import { t } from "./i18n";
import { callTool, jparse } from "./bridge";
import { $, esc, setPending, clearPending, mkNotice, openReasonModal, flashToast } from "./widgets";
import { valClass, basename, safeSegment, looksLikePermRule } from "./helpers";
import {
  collapsed, ccPlugins, secTitles, collapsedInit, showPlugin, showBuiltin, refreshApp,
  scopeFilter, srcOpen, lastConfigSections, setKnownProjects, setCollapsedInit,
  setShowPlugin, setShowBuiltin, setScopeFilter, setLastConfigSections,
} from "./state";

// 섹션 표시 이름(제목에서 ' · <개수>' 를 뗀 앞부분). 개수가 바뀌어도 정렬이 흔들리지 않게.
const secName = (title: string) => String(title).split(" · ")[0];

// 스코프 필터/출처 그룹/재정의 배지 지원. 설정 섹션은 #config 안의 #cfg-scoped 래퍼에 렌더.
// Library 섹션은 래퍼 밖 #config 에 append 되므로 칩/그룹 즉시 재렌더가 Library 를 지우지 않는다.
// (Library 가 래퍼 밖이라 아래 이름순 정렬과 무관하게 항상 맨 밑에 남는다.)
export function renderConfig(sections: any[]): void {
  const host = $("config");
  setLastConfigSections(sections);
  let wrap = document.getElementById("cfg-scoped") as HTMLElement | null;
  const freshMount = !wrap;
  if (freshMount) {
    host.innerHTML = "";
    wrap = document.createElement("div");
    wrap.id = "cfg-scoped";
    host.appendChild(wrap);
    secTitles.clear();   // 전체 새로고침 때만 초기화(재렌더 시엔 Library 타이틀 보존)
  } else {
    wrap!.innerHTML = "";
  }
  const w = wrap!;
  // 첫 렌더는 전부 접은 상태로 연다 - 8개 분류가 한꺼번에 펼쳐지면 훑을 수가 없다.
  if (!collapsedInit) {
    for (const sec of sections) collapsed.add(sec.title);
    setCollapsedInit(true);
  }
  // 스캔 결과의 distinct 프로젝트 경로(등장 순), 칩/필터의 유일 원천(카드 project 값과 동일 소스).
  const projects: string[] = [];
  const projSeen = new Set<string>();
  ccPlugins.clear();
  for (const sec of sections) for (const c of sec.cards || []) {
    if (c.scope === "project" && c.project && !projSeen.has(c.project)) { projSeen.add(c.project); projects.push(c.project); }
    // Plugins 섹션 카드만 플러그인 **자신**이다(합류 항목은 부모 플러그인의 id 를 달고 있어
    // 같은 id 가 여러 번 나온다). Set 이라 중복은 무해하고, 카탈로그가 "이미 설치됨"을
    // 판정하는 데 쓴다.
    if (c.plugin) ccPlugins.add(c.plugin);
  }
  // 플러그인 상세의 project/local 설치가 cwd 로 쓸 후보. 스코프 칩과 같은 원천이다.
  setKnownProjects(projects);
  if (scopeFilter !== "all" && scopeFilter !== "global" && !projSeen.has(scopeFilter)) setScopeFilter("all");
  if (projects.length) w.appendChild(buildScopeChips(projects));
  w.appendChild(buildOriginToggles());   // 스코프 칩과 달리 프로젝트가 없어도 항상 의미가 있다
  // 표시 순서만 이름 A-Z(원본 배열은 그대로 - lastConfigSections 캐시를 건드리지 않는다).
  const ordered = [...sections].sort((a, b) => secName(a.title).localeCompare(secName(b.title)));
  for (const sec of ordered) renderConfigSection(w, sec);
}

// 스코프 필터 칩: 전체 / 전역 / 프로젝트별. 클릭 시 캐시 섹션으로 즉시 재렌더(서버 왕복 없음).
// TODO: 프로젝트가 수십 개가 되면 이 칩 행을 검색형 select 로 교체.
function buildScopeChips(projects: string[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "scopechips";
  const mk = (val: string, label: string, title?: string): HTMLElement => {
    const chip = document.createElement("button");
    chip.className = "scopechip" + (scopeFilter === val ? " on" : "");
    chip.textContent = label;
    if (title) chip.title = title;
    chip.addEventListener("click", () => { setScopeFilter(val); renderConfig(lastConfigSections); });
    return chip;
  };
  row.appendChild(mk("all", t("scopeAll")));
  row.appendChild(mk("global", t("kindGlobal")));
  for (const p of projects) row.appendChild(mk(p, basename(p), p));
  return row;
}

// 출처 토글. 스코프 칩과 **다른 축**이다: 스코프는 "어느 디렉토리의 설정인가"이고
// 이쪽은 "누가 넣은 항목인가"라서, 라디오로 묶지 않고 독립 스위치 두 개로 둔다.
// 기본은 둘 다 켬(표시). 기본으로 숨기면 "지금 실제로 적용된 게 뭔가"라는 이 대시보드의
// 존재 이유가 사라진다 - 줄이는 건 사용자가 고르는 것이지 기본값이 아니다.
function buildOriginToggles(): HTMLElement {
  const row = document.createElement("div");
  row.className = "orgtgls";
  const mk = (on: boolean, label: string, tip: string, set: (v: boolean) => void) => {
    const lb = document.createElement("label");
    lb.className = "tgl" + (on ? " on" : "");
    lb.title = tip;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    const ui = document.createElement("span");
    ui.className = "tglui";
    const tx = document.createElement("span");
    tx.className = "tgllbl";
    tx.textContent = label;
    cb.addEventListener("change", () => { set(cb.checked); renderConfig(lastConfigSections); });
    lb.append(cb, ui, tx);
    row.appendChild(lb);
  };
  mk(showPlugin, t("orgPlugin"), t("orgPluginTip"), (v) => { setShowPlugin(v); });
  mk(showBuiltin, t("orgBuiltin"), t("orgBuiltinTip"), (v) => { setShowBuiltin(v); });
  return row;
}

const isAddCard = (c: any): boolean => !!(c.edit && String(c.edit.kind || "").endsWith("-add"));

// 이름 충돌로 실제 적용되지 않는 카드에 붙일 배지. 어느 쪽이 가려지는지는 섹션마다 다르므로
// 호출부(renderConfigSection)가 판정해 넘긴다.
interface Shadow { label: string; tip: string; }

// 카드 1개 렌더. shadowOf 가 배지를 주면 점선+앰버 배지로 "이 항목은 적용 안 됨"을 표시.
function renderConfigCard(c: any, shadowOf: ((c: any) => Shadow | null) | null): HTMLElement {
  const card = document.createElement("div");
  card.className = "card";
  const sh = shadowOf ? shadowOf(c) : null;
  let shadowBadge = "";
  if (sh) {
    card.classList.add("shadowed");
    card.title = sh.tip;
    shadowBadge = `<span class="shbadge">${esc(sh.label)}</span>`;
  }
  // 플러그인 카드/항목의 배지: 출처 색(plg) + 비정상 상태는 warn. 배지 문자열만으로는
  // "stale 이 뭔데"가 되므로 tooltip 으로 이유를 붙인다.
  const plgTip: Record<string, string> =
    { stale: t("plgStaleTip"), missing: t("plgMissingTip") };
  const badgeCls = (c.ok ? "ok" : "") + (c.plugin ? " plg" : "") +
    (c.plugin && plgTip[c.badge] ? " warn" : "");
  const badgeTip = c.plugin ? (plgTip[c.badge] || "") : "";
  card.innerHTML =
    `<div class="cname"><span class="nm">${esc(c.name)}</span>` +
    `<span class="cbadges">${shadowBadge}` +
    (c.badge ? `<span class="badge ${badgeCls}"${badgeTip ? ` title="${esc(badgeTip)}"` : ""}>${esc(c.badge)}</span>` : "") +
    `</span></div>` +
    (c.kv || [])
      .map(([k, v]: [string, string]) =>
        `<div class="kv"><span class="k">${esc(k)}</span>` +
        `<span class="v ${valClass(k)}">${esc(v)}</span></div>`)
      .join("");
  if (c.edit) card.appendChild(buildEditUI(c.edit));
  return card;
}

// 출처 그룹 헤더(카드 그리드 full-width 행). 클릭 시 그룹 접기/펼치기(로컬 srcOpen) 후 재렌더.
function buildSrcGroupHeader(key: string, isGlobal: boolean, pathTxt: string, count: number): HTMLElement {
  const open = (key in srcOpen) ? srcOpen[key] : isGlobal;   // 기본: 전역 열림, 프로젝트 접힘
  const head = document.createElement("div");
  head.className = "srcgrp" + (open ? "" : " collapsed");
  head.innerHTML =
    `<span class="chev2">▾</span>` +
    `<span class="scopepill ${isGlobal ? "global" : "project"}">${esc(isGlobal ? t("kindGlobal") : t("kindProject"))}</span>` +
    `<span class="srcpath">${esc(pathTxt)}</span>` +
    `<span class="srccount">${count}</span><span class="srcline"></span>`;
  head.addEventListener("click", () => { srcOpen[key] = !open; renderConfig(lastConfigSections); });
  return head;
}

function renderConfigSection(host: HTMLElement, sec: any): void {
  const cards = sec.cards || [];
  const hasProject = cards.some((c: any) => c.scope === "project");
  // Plugins 섹션은 플러그인 **관리** 화면이라 출처 토글의 대상이 아니다. 여기까지 숨기면
  // 다시 켤 자리가 사라지고, 무엇을 껐는지도 확인할 수 없게 된다.
  const isPluginSec = String(sec.title || "").startsWith("Plugins");
  const inScope = (c: any) =>
    scopeFilter === "all" ? true
      : scopeFilter === "global" ? c.scope !== "project"
        : (c.scope === "project" && c.project === scopeFilter);
  const visible = cards.filter((c: any) =>
    (showPlugin || !c.plugin || isPluginSec) && (showBuiltin || !c.builtin) && inScope(c));
  // 필터 모드에서 결과 0개 섹션은 통째로 스킵. 아무 필터도 안 걸렸으면 항상 렌더.
  const filtering = scopeFilter !== "all" || !showPlugin || !showBuiltin;
  if (filtering && !visible.length) return;

  secTitles.add(sec.title);
  const secEl = document.createElement("div");
  secEl.className = "sec" + (collapsed.has(sec.title) ? " collapsed" : "");
  secEl.dataset.col = "1";

  const gCount = cards.filter((c: any) => c.scope !== "project").length;
  const pCount = cards.length - gCount;
  const summary = (scopeFilter === "all" && pCount)
    ? `<span class="secsum">${esc(t("kindGlobal"))} ${gCount} · ${esc(t("kindProject"))} ${pCount}</span>` : "";
  const srcHtml = sec.source
    ? `<div class="secsrc"><span class="lbl">${esc(t("source"))}</span><span class="val">${esc(sec.source)}</span></div>`
    : "";
  const head = document.createElement("div");
  head.className = "sechead";
  head.innerHTML =
    `<div class="secrow"><span class="chev2">▾</span>` +
    `<span class="sectitle">${esc(sec.title)}</span>` +
    `<span class="seccount">${visible.length}</span>${summary}</div>` + srcHtml;
  head.addEventListener("click", () => {
    if (collapsed.has(sec.title)) collapsed.delete(sec.title); else collapsed.add(sec.title);
    secEl.classList.toggle("collapsed");
  });
  secEl.appendChild(head);

  const body = document.createElement("div");
  body.className = "secbody";
  // 이름 충돌 시 우선순위는 종류마다 반대다(Claude Code 문서 기준).
  //   agents : .claude/agents(프로젝트)가 ~/.claude/agents(전역)를 덮어씀 -> 가려지는 쪽은 전역 카드
  //   skills : personal(전역)이 project 를 덮어씀 -> 가려지는 쪽은 프로젝트 카드
  // 판정은 필터와 무관하게 전체 카드 기준(전역 필터에서도 배지가 유지되어야 함).
  let shadowOf: ((c: any) => Shadow | null) | null = null;
  if (hasProject && /^Agents/.test(sec.title)) {
    const byName = new Map<string, string[]>();
    for (const c of cards) if (c.scope === "project" && c.project) {
      byName.set(c.name, (byName.get(c.name) || []).concat(c.project));
    }
    shadowOf = (c: any) => {
      if (c.scope === "project" || isAddCard(c)) return null;
      const ps = byName.get(c.name);
      if (!ps || !ps.length) return null;
      return {
        label: t("shadowed") + (ps.length > 1 ? ` ×${ps.length}` : ""),
        tip: t("shadowedTip") + ps.join(" · "),
      };
    };
  } else if (hasProject && /^Skills/.test(sec.title)) {
    const globalNames = new Set(cards.filter((c: any) => c.scope !== "project" && !isAddCard(c))
                                     .map((c: any) => c.name));
    shadowOf = (c: any) => {
      if (c.scope !== "project" || !globalNames.has(c.name)) return null;
      return { label: t("shadowedByGlobal"), tip: t("shadowedByGlobalTip") };
    };
  }

  // 출처 그룹 키: perm/hook/plugin 은 카드마다 실제 settings 파일(claude_config 가 source 로 붙임),
  // 그 외는 전역=섹션 출처 / 프로젝트=프로젝트 경로. 전역이라도 settings.json 과
  // settings.local.json 은 둘 다 적용되므로 같은 이름의 카드(allow 등)가 각각 나온다 -> 별도 그룹.
  const srcOf = (c: any) => c.source || (c.scope === "project" ? c.project : (sec.source || ""));
  const groups: { key: string; label: string; isGlobal: boolean; cards: any[] }[] = [];
  const gidx = new Map<string, number>();
  for (const c of cards) {
    const isGlobal = c.scope !== "project";
    const label = srcOf(c);
    const key = `${sec.title}::${isGlobal ? "g" : "p"}::${label}`;
    let i = gidx.get(key);
    if (i === undefined) {
      i = groups.length;
      gidx.set(key, i);
      groups.push({ key, label, isGlobal, cards: [] });
    }
    groups[i].cards.push(c);
  }

  // 출처가 둘 이상이면(프로젝트 있음 또는 전역 settings 2 파일) 그룹 모드.
  if (scopeFilter === "all" && (hasProject || groups.length > 1)) {
    // 그룹 모드: 출처별 그룹(등장 순 - 백엔드가 전역 카드를 앞에 둔다). 접힌 그룹은 카드 렌더 스킵(DOM 제외).
    for (const g of groups) {
      body.appendChild(buildSrcGroupHeader(g.key, g.isGlobal, g.label, g.cards.length));
      if ((g.key in srcOpen) ? srcOpen[g.key] : g.isGlobal) {
        for (const c of g.cards) body.appendChild(renderConfigCard(c, shadowOf));
      }
    }
  } else {
    // 평면 모드(출처 하나, 또는 필터 모드): 그룹 헤더 없이 카드만.
    if (!visible.length) body.innerHTML = `<div class="empty">${esc(t("emptyCards"))}</div>`;
    for (const c of visible) body.appendChild(renderConfigCard(c, shadowOf));
  }
  secEl.appendChild(body);
  host.appendChild(secEl);
}

// inline edit controls. edit meta is set by claude_config.py.
//   perm/hook            : 항목 chips + adder
//   mcp/skill/agent      : 카드 자체 제거 버튼 (인라인 확인)
//   mcp-add/skill-add/agent-add : adder 만 (입력 파싱 후 해당 add 도구 호출)
// removal uses inline confirm (window.confirm may be blocked in iframe sandbox).
function buildEditUI(edit: any): HTMLElement {
  if (edit.kind === "plugin") return buildPluginToggleUI(edit);
  if (["mcp", "skill", "agent"].includes(edit.kind)) return buildRemoveUI(edit);
  if (["mcp-add", "skill-add", "agent-add"].includes(edit.kind)) return buildAddUI(edit);
  const isPerm = edit.kind === "perm";
  const tgt = edit.settings ? { settings: edit.settings } : {};   // 프로젝트 카드면 그 프로젝트 settings 파일 대상
  const doRemove = (it: string) =>
    isPerm
      ? callTool("config_perm_remove", { kind: edit.permKind, rule: it, ...tgt })
      : callTool("config_hook_remove", { event: edit.event, needle: it, ...tgt });
  const doAdd = (v: string) =>
    isPerm
      ? callTool("config_perm_add", { kind: edit.permKind, rule: v, ...tgt })
      : callTool("config_hook_add", { event: edit.event, command: v, ...tgt });

  const wrap = document.createElement("div");
  wrap.className = "edit";
  // 칩 제거와 추가가 같은 슬롯을 쓴다 - 카드 하나에 안내가 둘이면 어느 쪽 결과인지 흐려진다.
  const notice = mkNotice();

  const chips = document.createElement("div");
  chips.className = "chips";
  for (const it of edit.items || []) {
    const chip = document.createElement("div");
    chip.className = "chip";
    const txt = document.createElement("span");
    txt.className = "ctxt";
    txt.textContent = it;
    const x = document.createElement("button");
    x.className = "cx";
    x.textContent = "✕";
    x.title = t("remove");
    x.addEventListener("click", () => {
      const ok = document.createElement("button");
      ok.className = "ok";
      ok.textContent = t("del");
      const no = document.createElement("button");
      no.className = "no";
      no.textContent = t("cancel");
      chip.replaceChildren(txt, ok, no);
      no.addEventListener("click", () => wrap.replaceWith(buildEditUI(edit)));
      ok.addEventListener("click", async () => {
        setPending(ok);
        // 응답을 버리면 안 된다: config_edit 은 "지울 게 없었다"를 ok:true + changed:false 로 알리는데,
        // 그걸 무시하고 무조건 "제거됨" 토스트를 띄우면 조용한 no-op 이 성공처럼 보인다
        // (hooks 제거가 오래 안 고쳐진 이유가 이 침묵이다).
        try {
          const res = jparse(await doRemove(it));
          if (res && (res.ok === false || res.changed === false)) {
            notice.show(res.message || t("failed"), res.ok === false ? "err" : "warn");
            clearPending(ok, t("failed"));
            return;
          }
          flashToast(t("toastRemoved") + " · " + it);
          await refreshApp?.();
        } catch (e) { notice.show(String(e)); clearPending(ok, t("failed")); console.error("[config-monitor] remove", e); }
      });
    });
    chip.append(txt, x);
    chips.appendChild(chip);
  }
  wrap.appendChild(chips);

  const adder = document.createElement("div");
  adder.className = "adder";
  const input = document.createElement("input");
  input.placeholder = isPerm ? t("permPlaceholder") : t("hookPlaceholder");
  const add = document.createElement("button");
  add.className = "addbtn";
  add.textContent = t("add");
  input.addEventListener("input", notice.clear);
  // hook 은 형식을 검증할 방법이 없다(임의 셸 명령이다). 검증하는 척하는 대신 무엇을 안 하는지
  // 상시로 적어 둔다 - 오타 하나가 매 세션 조용히 실패하는 hook 이 되는 게 이 자리의 위험이다.
  // notice 슬롯이 아니라 별도 줄이다: 입력하면 지워지는 자리에 두면 상시 경고가 못 된다.
  const hint = document.createElement("div");
  hint.className = "ahint";
  hint.textContent = t("hookNoVerify");
  hint.hidden = isPerm;
  const submit = async () => {
    const v = input.value.trim();
    if (!v) return;
    if (isPerm && !looksLikePermRule(v)) {
      notice.show(t("permBad"));
      input.focus();
      return;
    }
    notice.clear();
    setPending(add);
    try {
      const res = jparse(await doAdd(v));
      if (res && (res.ok === false || res.changed === false)) {
        // changed:false 는 오류가 아니라 "이미 있음" 같은 무변화다. 둘 다 조용히 넘기지 않는다.
        notice.show(res.message || t("failed"), res.ok === false ? "err" : "warn");
        clearPending(add, t("add"));
        return;
      }
      flashToast(t("toastAdded") + " · " + v);
      await refreshApp?.();
    } catch (e) { notice.show(String(e)); clearPending(add, t("failed")); console.error("[config-monitor] add", e); }
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
  adder.append(input, add);
  wrap.append(adder, hint, notice.el);
  return wrap;
}

// 플러그인 on/off. 확인 단계를 두지 않는다 - 파일도 설정도 지우지 않고 enabledPlugins 의
// bool 하나만 뒤집으며, 되돌리는 조작이 같은 버튼이기 때문이다(제거와 성질이 다르다).
// edit.settings 는 **그 값을 정한 파일**이다(plugin_state.enabled_from). 프로젝트에서 켠
// 플러그인을 전역 파일에서 끄면 안 먹으므로 카드가 들고 온 경로를 그대로 넘긴다.
function buildPluginToggleUI(edit: any): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "edit plgrow";
  const on = !!edit.on;
  const btn = document.createElement("button");
  btn.className = on ? "cx" : "ok";
  btn.textContent = on ? t("plgOff") : t("plgOn");
  btn.title = t("plgToggleTip") + (edit.settings ? ` · ${edit.settings}` : "");
  btn.addEventListener("click", async () => {
    setPending(btn);
    try {
      const res = jparse(await callTool("config_plugin_toggle", {
        id: edit.id, on: !on, ...(edit.settings ? { settings: edit.settings } : {}),
      }));
      if (res && (res.ok === false || res.changed === false)) {
        // changed:false 는 "이미 그 상태"다. 조용히 넘기면 토글이 먹은 것처럼 보인다.
        clearPending(btn, on ? t("plgOff") : t("plgOn"));
        openReasonModal(res.ok === false ? t("failed") : t("unchangedTitle"), res.message || t("failed"));
        return;
      }
      // 재시작 전까지는 세션에 반영되지 않는다 - 토글이 고장난 것처럼 보이지 않게 명시한다.
      flashToast(`${edit.id} · ${!on ? t("plgEnabled") : t("plgDisabled")} · ${t("plgRestart")}`);
      await refreshApp?.();
    } catch (e) { clearPending(btn, t("failed")); console.error("[config-monitor] plugin toggle", e); }
  });
  wrap.appendChild(btn);
  // 갱신/제거는 claude CLI 위임이라 저쪽에 설치된 플러그인에만 붙는다. stale(설정에만 남은
  // 키)/missing(캐시가 사라짐)에는 edit 자체가 없으므로 여기 도달하지 않는다.
  const [plugin, market] = splitPluginId(edit.id);
  if (market) {
    // **설치 스코프를 그대로 되돌려준다.** claude 는 scope=project/local 을 cwd 로 정하므로
    // 원장의 projectPath 도 같이 넘긴다. 기본값 user 로 흘리면 project 스코프로 설치된
    // 플러그인이 대시보드에서 제거 불가가 된다(실측: "is enabled at project scope" 거절).
    const scoped = { marketplace: market, plugin, scope: edit.scope || "user",
                     ...(edit.cwd ? { cwd: edit.cwd } : {}) };
    const where = edit.scope && edit.scope !== "user"
      ? ` (${edit.scope}${edit.cwd ? ` · ${edit.cwd}` : ""})` : "";
    wrap.appendChild(mkPluginCliBtn(t("plgUpdate"), t("plgUpdateTip") + where,
      "claude_plugin_update", scoped, false));
    wrap.appendChild(mkPluginCliBtn(t("plgUninstall"), t("plgUninstallTip") + where,
      "claude_plugin_uninstall", scoped, true));
  }
  const note = document.createElement("span");
  note.className = "plgnote";
  note.textContent = t("plgRestart");
  wrap.appendChild(note);
  return wrap;
}

// 'notion@claude-plugins-official' -> ['notion', 'claude-plugins-official'].
// 마지막 '@' 로 자른다 - 마켓 이름 쪽에 '@' 가 들어가는 게 플러그인 이름보다 흔하다.
function splitPluginId(id: string): [string, string] {
  const i = String(id || "").lastIndexOf("@");
  return i < 0 ? [String(id || ""), ""] : [id.slice(0, i), id.slice(i + 1)];
}

// claude CLI 위임 버튼 하나. destructive 면 인라인 확인을 한 번 받는다(제거는 되돌릴 수 없다 -
// 토글과 달리 같은 버튼으로 원상복구되지 않는다).
function mkPluginCliBtn(label: string, tip: string, tool: string, args: any,
                        destructive: boolean): HTMLElement {
  const btn = document.createElement("button");
  btn.className = destructive ? "cx" : "addbtn";
  btn.textContent = label;
  btn.title = tip;
  const go = async (target: HTMLButtonElement) => {
    setPending(target);
    try {
      const rr = jparse(await callTool(tool, args));
      if (rr && rr.ok === false) {
        // CLI 위임 실패는 원인이 길다(claude 미설치·마켓 미등록·권한 등). 토스트로 알리고
        // 사유는 모달에 남긴다 - 스쳐 지나가면 무엇을 고쳐야 하는지 알 수 없다.
        clearPending(target, t("failed"));
        openReasonModal(t("failed"), rr.message || t("failed"));
        return;
      }
      flashToast(rr?.message || t("done"));
      await refreshApp?.();
    } catch (e) {
      clearPending(target, t("failed"));
      openReasonModal(t("failed"), String(e));
      console.error("[config-monitor] " + tool, e);
    }
  };
  if (!destructive) {
    btn.addEventListener("click", () => go(btn));
    return btn;
  }
  const wrap = document.createElement("span");
  wrap.className = "inlineconfirm";
  btn.addEventListener("click", () => {
    const ok = document.createElement("button");
    ok.className = "ok";
    ok.textContent = t("delConfirm");
    const no = document.createElement("button");
    no.className = "no";
    no.textContent = t("cancel");
    wrap.replaceChildren(ok, no);
    no.addEventListener("click", () => wrap.replaceChildren(btn));
    ok.addEventListener("click", () => go(ok));
  });
  wrap.appendChild(btn);
  return wrap;
}

// 카드 단위 제거(mcp/skill/agent): 제거 버튼 -> 인라인 확인 -> 해당 remove 도구 호출.
function buildRemoveUI(edit: any): HTMLElement {
  // edit.dir = 프로젝트-로컬 항목의 skills/agents 디렉토리. 전역 카드는 미부여 -> 도구 기본값(~/.claude).
  const doRemove = () => {
    if (edit.kind === "mcp") return callTool("config_mcp_remove", { name: edit.name, scope: edit.scope });
    if (edit.kind === "skill")
      return callTool("config_skill_remove", { name: edit.name, ...(edit.dir ? { skillsDir: edit.dir } : {}) });
    return callTool("config_agent_remove", { name: edit.name, ...(edit.dir ? { agentsDir: edit.dir } : {}) });
  };
  const wrap = document.createElement("div");
  wrap.className = "edit";
  const notice = mkNotice();
  const btn = document.createElement("button");
  btn.className = "cx";
  // 라벨에 ✕ 를 붙이지 않는다 - 붉은 hover 가 파괴적 동작을 이미 말하고, 글리프까지 얹으면
  // 평상시에도 시선을 끈다. 추적 파일의 프로젝트 해제만 아이콘 전용이라 ✕ 를 유지한다.
  btn.textContent = t("remove");
  // 로컬 항목은 어느 프로젝트에서 지워지는지가 중요하므로 스코프+대상 디렉토리를 title 에 노출.
  // ('전역에 가려짐' 배지가 붙은 카드는 카드 title 이 그 설명이라 버튼 쪽에서 스코프를 다시 못박는다.)
  btn.title = edit.kind === "mcp" ? `mcpServers.${edit.name} ${t("remove")} (${edit.scope})`
    : edit.dir ? `${t("kindProject")} · ${edit.dir} · ${t("trashMoveHint")}` : t("trashMoveHint");
  btn.addEventListener("click", () => {
    const ok = document.createElement("button");
    ok.className = "ok";
    ok.textContent = t("delConfirm");
    const no = document.createElement("button");
    no.className = "no";
    no.textContent = t("cancel");
    wrap.replaceChildren(ok, no);
    no.addEventListener("click", () => wrap.replaceWith(buildRemoveUI(edit)));
    ok.addEventListener("click", async () => {
      setPending(ok);
      try {
        const res = jparse(await doRemove());
        if (res && (res.ok === false || res.changed === false)) {
          clearPending(ok, t("failed"));
          notice.show(res.message || t("failed"), res.ok === false ? "err" : "warn");
          return;
        }
        flashToast(t("toastRemoved") + " · " + edit.name);
        await refreshApp?.();
      } catch (e) { clearPending(ok, t("failed")); notice.show(String(e)); console.error("[config-monitor] remove", e); }
    });
  });
  wrap.append(btn, notice.el);
  return wrap;
}

// 추가 전용 카드(mcp-add/skill-add/agent-add).
//   mcp   입력: name {"command":...}   (첫 토큰=이름, 나머지=서버 JSON)
//   skill/agent 입력: name 설명…       (첫 토큰=이름, 나머지=description)
function buildAddUI(edit: any): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "edit";
  const adder = document.createElement("div");
  adder.className = "adder";
  const input = document.createElement("input");
  input.placeholder = edit.kind === "mcp-add" ? 'name {"command":"npx","args":[...]}' : t("addNamePlaceholder");
  const add = document.createElement("button");
  add.className = "addbtn";
  add.textContent = t("add");
  const notice = mkNotice(input);
  const submit = async () => {
    const v = input.value.trim();
    if (!v) return;
    const sp = v.indexOf(" ");
    const name = sp < 0 ? v : v.slice(0, sp);
    const rest = sp < 0 ? "" : v.slice(sp + 1).trim();
    // 서버 _safe_name(config_edit.py)과 **같은 규칙**을 여기서도 본다. 서버가 어차피 막지만
    // 그 거부는 토스트로만 흘러 사라진다 - 입력칸 옆에 남겨야 무엇이 틀렸는지 알 수 있다.
    if (!safeSegment(name)) {
      notice.show(t("nameBad"));
      input.focus();
      return;
    }
    if (edit.kind === "mcp-add") {
      if (!rest) { notice.show(t("needServerJson")); input.focus(); return; }
      // 깨진 JSON 을 서버까지 보내면 파서 오류 원문이 토스트로 스쳐 지나간다. 여기서 읽고
      // 어디가 잘못됐는지 그대로 보여준다.
      try { JSON.parse(rest); }
      catch (err) { notice.show(`${t("mcpBadJson")}: ${String(err)}`); input.focus(); return; }
    }
    notice.clear();
    setPending(add);
    try {
      let res: any;
      if (edit.kind === "mcp-add") {
        res = jparse(await callTool("config_mcp_add", { name, serverJson: rest, scope: edit.scope }));
      } else if (edit.kind === "skill-add") {
        res = jparse(await callTool("skill_scaffold", { name, desc: rest || undefined }));
      } else {
        res = jparse(await callTool("config_agent_add", { name, desc: rest || undefined }));
      }
      if (res && (res.ok === false || res.changed === false)) {
        notice.show(res.message || t("failed"), res.ok === false ? "err" : "warn");
        clearPending(add, t("add"));
        return;
      }
      flashToast(t("toastAdded") + " · " + name);
      await refreshApp?.();
    } catch (e) { notice.show(String(e)); clearPending(add, t("failed")); console.error("[config-monitor] add", e); }
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
  adder.append(input, add);
  wrap.appendChild(adder);
  wrap.appendChild(notice.el);          // 안내는 입력행 **아래**다 - 위에 두면 폼이 밀린다
  return wrap;
}
