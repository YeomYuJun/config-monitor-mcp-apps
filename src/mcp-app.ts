// src/mcp-app.ts - Config Monitor UI (iframe side). Talks to host via App bridge.
//   get_config       -> collapsible config sections (with source path)
//   get_tracked      -> tracked file rows (click -> history)
//   get_file_history -> revision timeline
//   get_diff         -> from->to unified diff
//   config_*/config_restore/watcher_* -> inline edit / restore / watcher control
//   updateModelContext -> inject what the user is viewing into Claude context
import { App } from "@modelcontextprotocol/ext-apps";
import { t, getLang, setLang } from "./ui/i18n";

const app = new App({ name: "Config Monitor", version: "0.1.0" });

// 브라우저(standalone) 모드: server.ts 가 주입한 플래그. true 면 MCP 브리지 대신 HTTP REST 사용.
const STANDALONE = !!(window as any).__CONFIG_MONITOR_HTTP__;

const $ = (id: string) => document.getElementById(id)!;
// 따옴표까지 막는다: esc 의 결과는 태그 사이뿐 아니라 title="..." 같은 **속성값**에도 들어가고,
// 그 자리에는 검색어·스냅샷 메시지처럼 사용자가 쓴 문자열이 온다. 따옴표를 남겨두면 속성을
// 빠져나가 마크업이 깨지거나 다른 속성이 끼어든다. 텍스트 자리에서는 브라우저가 엔티티를
// 원래 문자로 되돌려 그리므로 부작용이 없다(이 함수의 결과는 항상 innerHTML 로만 들어간다).
const ESC_MAP: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

// 카드 값 종류 구분: 서술형 key 는 sans+줄클램프, 그 외(command/args/env/path/tools 등)는 mono 코드형.
const DESC_KEYS = new Set(["desc", "description", "설명", "summary"]);
const valClass = (k: string) => (DESC_KEYS.has(String(k).toLowerCase()) ? "desc" : "code");

// 도구 실패를 항상 jparse().ok===false 로 잡히는 문자열로 정규화한다(성공 텍스트는 그대로 통과).
// 두 전송(MCP isError / REST !res.ok) 모두 여기로 모아 기존 ~40개 호출부의 가드를 그대로 재사용한다.
function normalizeToolError(txt: string, fallback: string): string {
  try {
    const p = JSON.parse(txt);
    // ok:false 를 실제로 담은 페이로드만 그대로 통과시킨다(예: runPy 가 건져올린 out(False,...)).
    // 임의의 JSON 객체(예: {code,message} 형태의 프로토콜 에러)를 통과시키면 r.ok 가 undefined 가 되어
    // 가드를 그냥 지나쳐 다시 "성공" 취급될 수 있다 - 이번 라운드가 고치려는 결함과 같은 모양이 된다.
    if (p && typeof p === "object" && p.ok === false) return txt;
  } catch { /* 순수 에러 메시지 문자열 - 아래에서 감싼다 */ }
  return JSON.stringify({ ok: false, message: txt || fallback });
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  if (STANDALONE) {
    const res = await fetch(`/api/tool/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* 응답 본문이 JSON 아님(프록시/네트워크 오류 등) */ }
    if (!res.ok) {
      // /api/tool/:name 은 핸들러가 실제로 throw 했을 때만 비2xx({error})를 준다 - MCP 의 isError 와 동급.
      return normalizeToolError((body && body.error) || "", `REST ${name}: ${res.status}`);
    }
    return body?.text ?? "";
  }
  const r = await app.callServerTool({ name, arguments: args });
  const txt = (r.content?.find((c: any) => c.type === "text") as any)?.text ?? "";
  if (r.isError) return normalizeToolError(txt, t("failed"));
  return txt;
}

// MCP 브리지 전용 기능들은 standalone 에서 no-op.
function pushCtx(t: string): void {
  if (STANDALONE) return;
  app.updateModelContext({ content: [{ type: "text", text: t }] });
}
function jparse(t: string): any { try { return JSON.parse(t); } catch { return null; } }
function jparseLast(t: string): any {
  const lines = t.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) { const v = jparse(lines[i]); if (v) return v; }
  return null;
}

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const dirname = (p: string) => { const a = p.split(/[\\/]/); a.pop(); return a.join("\\"); };

// 진행 중 표시. 버튼 모양을 유지하면 아직 누를 수 있는 것처럼 읽히므로 테두리/배경을 벗겨
// 단순 텍스트로 만들고 실제로도 못 누르게 막는다(중복 요청 방지).
function setPending(b: HTMLButtonElement, txt = "…"): void {
  if (!b.classList.contains("pending")) b.dataset.label = b.textContent || "";
  b.textContent = txt;
  b.classList.add("pending");
  b.disabled = true;
}
function clearPending(b: HTMLButtonElement, txt?: string): void {
  b.classList.remove("pending");
  b.disabled = false;
  b.textContent = txt ?? b.dataset.label ?? b.textContent ?? "";
}

// 출처 origin 을 사람이 읽는 짧은 라벨로. 캐시 경로(.../markets/<id>/plugins/<name>/<sha12>)는
// 화면에 그대로 쓸 수 없고, 여러 라이브러리가 같은 이름의 항목을 줄 때 행을 구분하는 유일한 단서다.
function originLabel(origin: string): string {
  const o = String(origin || "");
  if (o.startsWith("market:")) return o.slice("market:".length);   // <market>/<plugin>
  if (o.startsWith("remote:")) return o.slice("remote:".length);
  if (o.startsWith("local:")) return basename(o.slice("local:".length));
  return o;
}

// 화면 중앙 모달. 되돌릴 수 없는 등록/실행 앞에서는 인라인 경고보다 흐름을 끊는 확인이 맞다
// (인라인 경고는 같은 버튼의 라벨만 바뀌어 읽지 않고 두 번 누르기 쉽다).
// 배경 클릭과 Esc 로 닫히고, 위젯 iframe 안에서도 fixed 는 iframe 뷰포트 기준이라 중앙에 온다.
function openModal(title: string, fill: (body: HTMLElement, close: () => void) => void): void {
  const back = document.createElement("div");
  back.className = "modalback";
  const panel = document.createElement("div");
  panel.className = "modal";
  const head = document.createElement("div");
  head.className = "modaltitle";
  head.textContent = title;
  const body = document.createElement("div");
  body.className = "modalbody";
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
  document.addEventListener("keydown", onKey);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  panel.append(head, body);
  back.appendChild(panel);
  document.body.appendChild(back);
  fill(body, close);
}

// 입력행 아래에 붙는 지속 안내 슬롯. 모달의 .modalerr 와 같은 규율을 인라인에도 준다:
// **실패 사유를 토스트로만 흘리지 않는다.** 토스트는 몇 초 만에 사라지는데 입력칸은 그대로
// 남아, 사용자는 무엇이 잘못됐는지 모른 채 같은 값을 다시 넣는다.
// 입력이 바뀌면 스스로 지워진다 - 고친 값 옆에 옛 오류가 남아 있으면 그게 또 거짓말이 된다.
// 절대경로만 허용하는 자리(추적 추가)의 판정. ./ ../ 는 일부러 뺀다 - 서버 cwd 기준으로
// 풀려 사용자가 예측할 수 없다. ~ 는 홈이라 예측 가능하므로 허용한다.
const ABS_PATH_RE = /^([A-Za-z]:[\\/]|[\\/]|~[\\/])/;

// 권한 규칙의 **형태**만 본다: `Tool` 또는 `Tool(...)`. 규칙의 의미까지 검증하지 않는다 -
// 문법의 주인은 Claude Code 이고 우리가 흉내 내면 멀쩡한 규칙을 막게 된다.
// 여기서 걸러내는 건 괄호가 안 닫혔거나 도구명이 비어 오타가 확실한 것들뿐이다.
// config_edit._safe_name 과 같은 규칙: 경로 구분자도 상대참조도 없는 단일 세그먼트.
const safeSegment = (n: string): boolean =>
  !!n && n !== "." && n !== ".." && !/[\\/]/.test(n);

const PERM_RULE_RE = /^[A-Za-z][A-Za-z0-9_-]*(\(.*\))?$/;
const looksLikePermRule = (v: string): boolean => {
  if (!PERM_RULE_RE.test(v)) return false;
  const open = (v.match(/\(/g) || []).length, close = (v.match(/\)/g) || []).length;
  return open === close;
};

type Notice = {
  el: HTMLElement;
  show(msg: string, kind?: "err" | "warn" | "ok"): void;
  clear(): void;
};
function mkNotice(input?: HTMLInputElement): Notice {
  const el = document.createElement("div");
  el.className = "anotice";
  el.hidden = true;
  const clear = () => { el.hidden = true; el.textContent = ""; };
  if (input) input.addEventListener("input", clear);
  return {
    el,
    show(msg: string, kind: "err" | "warn" | "ok" = "err") {
      el.textContent = msg;
      el.className = "anotice " + kind;
      el.hidden = false;
    },
    clear,
  };
}

// 거부 사유가 **목록**일 때(무엇이 붙들고 있는지 등)는 토스트에 이어붙이지 않는다 - 길어서
// 잘리고, 정작 그 목록이 사용자가 다음에 할 일을 정한다. 읽고 닫는 모달로 남긴다.
function openReasonModal(title: string, msg: string, items?: string[]): void {
  openModal(title, (body, close) => {
    const m = document.createElement("div");
    m.className = "modaltext";
    m.textContent = msg;
    body.appendChild(m);
    if (items && items.length) {
      const ul = document.createElement("div");
      ul.className = "reasonlist";
      for (const it of items) {
        const li = document.createElement("div");
        li.className = "reasonitem";
        li.textContent = it;
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }
    const row = document.createElement("div");
    row.className = "modalrow";
    const ok = document.createElement("button");
    ok.className = "addbtn primary";
    ok.textContent = t("close");
    ok.addEventListener("click", close);
    row.appendChild(ok);
    body.appendChild(row);
  });
}

// 모달 하단 버튼 행. 주 동작이 왼쪽, 취소가 오른쪽(대시보드의 인라인 확인과 같은 배치).
function modalActions(okLabel: string, onOk: (btn: HTMLButtonElement) => void,
                      onCancel: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "modalrow";
  const ok = document.createElement("button");
  ok.className = "addbtn primary";
  ok.textContent = okLabel;
  ok.addEventListener("click", () => onOk(ok));
  const no = document.createElement("button");
  no.textContent = t("cancel");
  no.addEventListener("click", onCancel);
  row.append(ok, no);
  return row;
}

// 출처 안에서의 짧은 이름(마켓이면 플러그인 세그먼트, 원격이면 id, 로컬이면 디렉토리명).
// originLabel 이 "어디"라면 이쪽은 "무엇"이다 - 유닛 행은 둘을 각각 다른 칸에 쓴다.
function originShort(origin: string): string {
  const o = String(origin || "");
  if (o.startsWith("market:")) {
    const rest = o.slice("market:".length);
    const i = rest.indexOf("/");
    return i < 0 ? rest : rest.slice(i + 1);
  }
  return originLabel(o);
}

// 항목/유닛 행의 출처 태그. 라벨은 짧게, 전체 경로는 title 로.
function mkSrcTag(origin: string, path?: string): HTMLElement {
  const s = document.createElement("span");
  s.className = "libsrc";
  s.textContent = originLabel(origin);
  s.title = path ? `${origin}\n${path}` : origin;
  return s;
}

// ----- state -----
let selectedPath = "";
let currentRevs: any[] = [];
let fromRev = "";
let toRev = "work";
// 기동 시 닫힘. 파일을 고르기 전에는 패널에 보여줄 게 없다(selectFile 이 열어 준다).
let detailOpen = false;
// 기동 시 전 섹션 접힘. Library/Marketplace 는 renderConfig 이후에 그려져 아래 collapsedInit
// 루프가 못 잡으므로 여기서 미리 넣어 둔다(사용자가 펼치면 그 상태가 세션 내내 유지된다).
const collapsed = new Set<string>(["Library", "Marketplace"]);   // 접힌 섹션 title
// Claude Code 쪽 상태 캐시. 카탈로그 행이 "이 플러그인을 통째로 설치할 수 있는가"를 판정한다.
//   ccPlugins  이미 Claude Code 에 설치된 플러그인 id (renderConfig 이 Plugins 카드에서 채움)
//   ccMarkets  Claude Code 가 아는 마켓 이름 (buildCatalog 이 market-discover 로 채움).
//              여기 없는 마켓의 플러그인은 `claude plugin install` 이 찾지 못한다 - 먼저
//              저쪽에 마켓을 등록해야 하므로 버튼을 비활성화하고 이유를 표시한다.
const ccPlugins = new Set<string>();
const ccMarkets = new Set<string>();
// Claude Code 가 미리 계산해 캐시해 둔 인벤토리 {id: {installs, components:{kind:n}, total}}.
// 이게 있으면 **fetch 하기 전에** "무엇이 설치되는지"를 말할 수 있다. 공식 마켓 전용이라
// 없는 행도 정상이다 - 그 경우 개수를 숨긴다(0 이라고 말하지 않는다. 모르는 것이다).
let ccCatalog: Record<string, any> = {};
// 추적 중인 프로젝트 경로. claude 는 scope=project/local 을 **cwd 로** 정하므로 설치 대상을
// 고르려면 이 목록이 필요하다(스코프 칩과 같은 원천 - renderConfig 이 채운다).
let knownProjects: string[] = [];
// config-monitor 스토어에 등록된 마켓 URL(정규화). 공식 마켓 프리셋을 이미 등록된 상태에서
// 다시 권하지 않기 위해서만 쓴다.
const cmMarketUrls = new Set<string>();
// URL 이 없는 스토어 마켓(로컬 경로로 등록된 것 - marketplace.py 의 kind local/str-path 는
// url:None 이다). 이런 마켓은 헤더에 'Claude Code 등록' 버튼이 아예 안 그려지므로,
// 카탈로그 행의 비활성 사유가 그 버튼을 가리키면 없는 것을 가리키게 된다.
// **없는 쪽을 모은다**: 이름을 못 찾으면 기본(버튼을 가리키는) 문구로 떨어져 기존 동작이 된다.
const cmMarketsNoUrl = new Set<string>();
// Claude Code 가 기본 내장하는 마켓. 처음 쓰는 사람에게 카탈로그가 텅 빈 채로 보이지 않도록
// 원클릭 프리셋으로 제공한다. 자동 등록은 하지 않는다 - 등록은 네트워크를 타는 행위이고,
// "요청하지 않으면 아무것도 받지 않는다"가 이 제품의 계약이다.
const OFFICIAL_MARKET_URL = "https://github.com/anthropics/claude-plugins-official.git";
const normUrl = (u: string): string => {
  const s = String(u || "").trim().replace(/\/+$/, "").toLowerCase();
  return s.endsWith(".git") ? s.slice(0, -4) : s;
};
const secTitles = new Set<string>();         // 접기 가능한 섹션 title (전부 접기 대상)
let collapsedInit = false;                    // 기본 접힘 1회만 적용
// 출처 표시 토글(스코프 필터와 독립). 기본은 둘 다 표시 - buildOriginToggles 주석 참고.
let showPlugin = true;                        // 플러그인이 넣은 항목
let showBuiltin = true;                       // 기본 제공(Desktop Skills creatorType=anthropic)
const libGroupOpen = new Set<string>();      // 펼친 라이브러리 스킬 그룹 경로(기본 접힘)
// 루트(폴더 없는) 항목 묶음의 예약 키. 폴더 경로에는 ':' 가 들어갈 수 없어 실제 경로와 겹치지 않는다.
const ROOT_GROUP_KEY = "::root";
const libChecked = new Set<string>();        // 선택 설치용 체크된 항목 key(카테고리 무관)
const libOpen = new Set<string>(["skills"]); // 펼친 카테고리(기본값: Skills 만)
let libProjectTargets: string[] = [];        // 설치 대상 후보(추적 중인 프로젝트 .claude 경로들). renderTracked 가 매 새로고침 갱신
let libTarget = "";                           // 선택된 라이브러리 설치 대상("" = 전역 ~/.claude, 아니면 프로젝트 .claude)
let libSelBarUpdate: (() => void) | null = null; // 체크박스 -> 상단 "선택 설치 (N)" 카운트 갱신 훅
let scopeFilter = "all";                      // 설정 스코프 필터: 'all' | 'global' | <projectPath>
const srcOpen: Record<string, boolean> = {};  // 출처 그룹 접힘 상태(키: `${secTitle}::g` | `${secTitle}::${project}`)
let lastConfigSections: any[] = [];           // 스코프 칩/그룹 즉시 재렌더용 최신 섹션 캐시

let toastT: number | undefined;
function flashToast(msg: string): void {
  const el = $("toast");
  el.textContent = msg;
  el.style.display = "block";
  if (toastT) clearTimeout(toastT);
  toastT = window.setTimeout(() => { el.style.display = "none"; }, 2900);
}

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
      await refresh();
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
      await refresh();
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
          try { await callTool("config_track", { path: p.claude_dir }); flashToast(`${t("trackAdd")} · ${p.name}`); await refresh(); }
          catch (e) { flashToast(t("failed")); console.error("[config-monitor] project track", e); }
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
  libProjectTargets = [];
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

// ----- config sections (collapsible, with source) -----
// 섹션 표시 이름(제목에서 ' · <개수>' 를 뗀 앞부분). 개수가 바뀌어도 정렬이 흔들리지 않게.
const secName = (title: string) => String(title).split(" · ")[0];

// 스코프 필터/출처 그룹/재정의 배지 지원. 설정 섹션은 #config 안의 #cfg-scoped 래퍼에 렌더.
// Library 섹션은 래퍼 밖 #config 에 append 되므로 칩/그룹 즉시 재렌더가 Library 를 지우지 않는다.
// (Library 가 래퍼 밖이라 아래 이름순 정렬과 무관하게 항상 맨 밑에 남는다.)
function renderConfig(sections: any[]): void {
  const host = $("config");
  lastConfigSections = sections;
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
    collapsedInit = true;
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
  knownProjects = projects;
  if (scopeFilter !== "all" && scopeFilter !== "global" && !projSeen.has(scopeFilter)) scopeFilter = "all";
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
    chip.addEventListener("click", () => { scopeFilter = val; renderConfig(lastConfigSections); });
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
  mk(showPlugin, t("orgPlugin"), t("orgPluginTip"), (v) => { showPlugin = v; });
  mk(showBuiltin, t("orgBuiltin"), t("orgBuiltinTip"), (v) => { showBuiltin = v; });
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

  // 출처 그룹 키: perm/hook 은 카드마다 실제 settings 파일(claude_config 가 source 로 붙임),
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
          await refresh();
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
      await refresh();
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
      await refresh();
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
      await refresh();
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
        await refresh();
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
      await refresh();
    } catch (e) { notice.show(String(e)); clearPending(add, t("failed")); console.error("[config-monitor] add", e); }
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
  adder.append(input, add);
  wrap.appendChild(adder);
  wrap.appendChild(notice.el);          // 안내는 입력행 **아래**다 - 위에 두면 폼이 밀린다
  return wrap;
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
        await refresh();
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
  await refresh();
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
  if (libTarget && !libProjectTargets.includes(libTarget)) libTarget = "";
  sel.innerHTML =
    `<option value="">${esc(t("targetGlobal"))}</option>` +
    libProjectTargets.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  sel.value = libTarget;
  sel.addEventListener("change", async () => { libTarget = sel.value; await refresh(); });
  const selBtn = document.createElement("button");
  selBtn.className = "addbtn selbtn";
  const update = () => {
    const n = allItems.filter((it) => libChecked.has(libKey(it))).length;
    selBtn.textContent = `${t("libInstallSelected")} (${n})`;
    (selBtn as HTMLButtonElement).disabled = n === 0;
    selBtn.style.opacity = n ? "1" : ".5";
  };
  libSelBarUpdate = update;
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
      await refresh();
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
        await refresh();
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
  libSelBarUpdate = null;  // 이전 렌더의 카운트 훅 무효화(새 설치 대상 바가 다시 설정)
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
          await refresh();
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
    if (s && s.ok !== false) ccCatalog = s.entries || {};
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
      await refresh();                        // Library 패널도 같이 바뀐다
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
        await refresh();
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
        await refresh();
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
        await refresh();
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
      await refresh();
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

// ----- detail panel: history + diff -----
const revTime = (r: any) => (r.time || "").replace("T", " ").slice(0, 19);
const revLabel = (id: string) => {
  const r = currentRevs.find((x) => x.snapshot === id);
  return r ? r.message || "(no message)" : id;
};

async function selectFile(p: string): Promise<void> {
  selectedPath = p;
  fromRev = "";
  toRev = "work";
  detailOpen = true;
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
  currentRevs = (h && h.revisions) || [];
  // 선택 행 다시 표시(refresh 없이 강조만). full path 로 매칭(같은 basename, 예: 여러 settings.json
  // 파일이 함께 강조되는 버그 방지).
  document.querySelectorAll<HTMLElement>(".file").forEach((el) => {
    if (el.dataset.path === p) el.classList.add("sel");
  });
  if (!currentRevs.length) {
    body.innerHTML = `<div class="empty">${esc(t("noHistory"))}</div>`;
    return;
  }
  if (currentRevs.length) fromRev = currentRevs[currentRevs.length - 1].snapshot;
  renderHistory();
  renderDiffFor();
}

function renderHistory(): void {
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
  sel.addEventListener("change", () => { toRev = sel.value; renderDiffFor(); });

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
      fromRev = r.snapshot;
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

async function renderDiffFor(): Promise<void> {
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
      if (res && res.ok) { flashToast(t("toastRestored")); await refresh(); await selectFile(selectedPath); }
      else box.innerHTML = `<span class="rmeta err">${esc(t("failed"))}: ${esc(res?.message || t("unknown"))}</span>`;
    } catch (err) {
      box.innerHTML = `<span class="rmeta err">${esc(t("failed"))}: ${esc(String(err))}</span>`;
    }
  });
}

// ----- detail panel open/close -----
function applyDetailState(): void {
  $("detail").classList.toggle("closed", !detailOpen);
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
  await callTool("snapshot_now", { message: t("snapshotMsg") });
  flashToast(t("toastSnapshot"));
  await refresh();
  if (selectedPath) selectFile(selectedPath);
});
$("report").addEventListener("click", async () => {
  flashToast(t("toastReport"));
  try { await callTool("open_report"); flashToast(t("toastReportOpened")); }
  catch (e) { flashToast(t("toastReportFail")); console.error("[config-monitor] report", e); }
});
$("panel-close").addEventListener("click", () => { detailOpen = false; applyDetailState(); });
$("panel-reopen").addEventListener("click", () => { detailOpen = true; applyDetailState(); });
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
