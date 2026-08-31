// src/ui/market.ts - Marketplace 카탈로그: 마켓별 그룹 · 검색 · 페이징 · 플러그인 상세와 설치.
// Library 칸이 "가져온 것"이라면 여기는 "가져올 수 있는 것"이다.
// 등록 모달은 libmarket.ts 가 갖는다 - Library 쪽과 공유하므로 여기 두면 순환이 된다.
import { t } from "./i18n";
import { callTool, jparse } from "./bridge";
import { $, esc, setPending, clearPending, openModal, openReasonModal, flashToast } from "./widgets";
import {
  collapsed, ccPlugins, ccMarkets, ccCatalog, knownProjects, cmMarketUrls, cmMarketsNoUrl,
  normUrl, secIds, refreshApp, catOpen, catSecEl, setCcCatalog, setCatSecEl,
} from "./state";
import { openMarketAdd } from "./libmarket";

// Library 칸 = 가져온 것. 카탈로그 = 가져올 수 있는 것.
// renderLibrary 로 그리지 않는다 - 매 새로고침마다 전 항목을 eager 렌더하므로 278행이 들어오면 못 쓴다.
let catQuery = "", catCategory = "";
const CAT_PAGE = 40;
const CAT_SEC = "marketplace";                 // 접힘 상태 키(collapsed/secIds 공용). t() 와 무관 - 언어를 바꿔도 접힘이 유지된다.
// 페이징은 마켓별로 따로 센다. 합친 목록 하나를 넘기면 A 마켓 끝 페이지에서 B 마켓이 이어붙어
// "7페이지부터 다른 마켓이 나오는" 목록이 된다 - 마켓은 서로 다른 출처지 한 목록의 뒷부분이 아니다.
const catOffsets: Record<string, number> = {};

export async function renderCatalog(host: HTMLElement): Promise<void> {
  const sec = await buildCatalog();
  setCatSecEl(sec);
  host.appendChild(sec);
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
  setCatSecEl(sec);
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
  secIds.add(CAT_SEC);
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

// ----- 카탈로그 행 · 플러그인 상세 · 설치 스코프 -----

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

