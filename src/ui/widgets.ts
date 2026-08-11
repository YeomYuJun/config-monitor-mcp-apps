// src/ui/widgets.ts - DOM 조각만 만든다. 앱 상태를 읽지도 도구를 부르지도 않는다.
//   $ / esc     DOM 조회 · innerHTML 이스케이프
//   setPending  버튼 진행 표시
//   openModal · mkNotice · openReasonModal · modalActions · flashToast  안내 표면
// 의존은 ./i18n 한 방향뿐이다 - 여기서 앱 모듈을 import 하면 순환이 된다.
import { t } from "./i18n";

export const $ = (id: string) => document.getElementById(id)!;

// 따옴표까지 막는다: esc 의 결과는 태그 사이뿐 아니라 title="..." 같은 **속성값**에도 들어가고,
// 그 자리에는 검색어·스냅샷 메시지처럼 사용자가 쓴 문자열이 온다. 따옴표를 남겨두면 속성을
// 빠져나가 마크업이 깨지거나 다른 속성이 끼어든다. 텍스트 자리에서는 브라우저가 엔티티를
// 원래 문자로 되돌려 그리므로 부작용이 없다(이 함수의 결과는 항상 innerHTML 로만 들어간다).
const ESC_MAP: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

// 진행 중 표시. 버튼 모양을 유지하면 아직 누를 수 있는 것처럼 읽히므로 테두리/배경을 벗겨
// 단순 텍스트로 만들고 실제로도 못 누르게 막는다(중복 요청 방지).
export function setPending(b: HTMLButtonElement, txt = "…"): void {
  if (!b.classList.contains("pending")) b.dataset.label = b.textContent || "";
  b.textContent = txt;
  b.classList.add("pending");
  b.disabled = true;
}
export function clearPending(b: HTMLButtonElement, txt?: string): void {
  b.classList.remove("pending");
  b.disabled = false;
  b.textContent = txt ?? b.dataset.label ?? b.textContent ?? "";
}

// 화면 중앙 모달. 되돌릴 수 없는 등록/실행 앞에서는 인라인 경고보다 흐름을 끊는 확인이 맞다
// (인라인 경고는 같은 버튼의 라벨만 바뀌어 읽지 않고 두 번 누르기 쉽다).
// 배경 클릭과 Esc 로 닫히고, 위젯 iframe 안에서도 fixed 는 iframe 뷰포트 기준이라 중앙에 온다.
export function openModal(title: string, fill: (body: HTMLElement, close: () => void) => void): void {
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
type Notice = {
  el: HTMLElement;
  show(msg: string, kind?: "err" | "warn" | "ok"): void;
  clear(): void;
};
export function mkNotice(input?: HTMLInputElement): Notice {
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
export function openReasonModal(title: string, msg: string, items?: string[]): void {
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
export function modalActions(okLabel: string, onOk: (btn: HTMLButtonElement) => void,
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

let toastT: number | undefined;
export function flashToast(msg: string): void {
  const el = $("toast");
  el.textContent = msg;
  el.style.display = "block";
  if (toastT) clearTimeout(toastT);
  toastT = window.setTimeout(() => { el.style.display = "none"; }, 2900);
}
