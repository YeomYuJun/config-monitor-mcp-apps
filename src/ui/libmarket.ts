// src/ui/libmarket.ts - Library 와 Marketplace 가 **공유하는** 등록 흐름(입력 판별 · 경고 확인 · 교차 안내).
// 이름은 "Library 등록"이었지만 실제로는 양쪽을 다 아는 층이고, 그래서 어느 한쪽에 넣으면 순환이 된다.
// 여기서 library.ts / market.ts 를 import 하지 않는다 - 이 방향이 깨지면 그 순환이 되돌아온다.
import { t } from "./i18n";
import { callTool, jparse } from "./bridge";
import { esc, setPending, clearPending, openModal, modalActions, flashToast } from "./widgets";
import { cmMarketUrls, OFFICIAL_MARKET_URL, normUrl, refreshApp, catOpen } from "./state";

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

export function openMarketAdd(url: string): void {
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

export function openLibAdd(prefill: string): void {
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
