// src/ui/helpers.ts - 경로·출처·입력 판별용 순수 헬퍼. **아무것도 import 하지 않는다.**
// 여러 섹션이 공유하므로 섹션 모듈보다 아래층에 둔다 - 여기서 위를 참조하면 순환이 된다.
// 카드 값 종류 구분: 서술형 key 는 sans+줄클램프, 그 외(command/args/env/path/tools 등)는 mono 코드형.
const DESC_KEYS = new Set(["desc", "description", "설명", "summary"]);
export const valClass = (k: string) => (DESC_KEYS.has(String(k).toLowerCase()) ? "desc" : "code");

export const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
export const dirname = (p: string) => { const a = p.split(/[\\/]/); a.pop(); return a.join("\\"); };

// 출처 origin 을 사람이 읽는 짧은 라벨로. 캐시 경로(.../markets/<id>/plugins/<name>/<sha12>)는
// 화면에 그대로 쓸 수 없고, 여러 라이브러리가 같은 이름의 항목을 줄 때 행을 구분하는 유일한 단서다.
function originLabel(origin: string): string {
  const o = String(origin || "");
  if (o.startsWith("market:")) return o.slice("market:".length);   // <market>/<plugin>
  if (o.startsWith("remote:")) return o.slice("remote:".length);
  if (o.startsWith("local:")) return basename(o.slice("local:".length));
  return o;
}

// 절대경로만 허용하는 자리(추적 추가)의 판정. ./ ../ 는 일부러 뺀다 - 서버 cwd 기준으로
// 풀려 사용자가 예측할 수 없다. ~ 는 홈이라 예측 가능하므로 허용한다.
export const ABS_PATH_RE = /^([A-Za-z]:[\\/]|[\\/]|~[\\/])/;

// config_edit._safe_name 과 같은 규칙: 경로 구분자도 상대참조도 없는 단일 세그먼트.
export const safeSegment = (n: string): boolean =>
  !!n && n !== "." && n !== ".." && !/[\\/]/.test(n);

// 권한 규칙의 **형태**만 본다: `Tool` 또는 `Tool(...)`. 규칙의 의미까지 검증하지 않는다 -
// 문법의 주인은 Claude Code 이고 우리가 흉내 내면 멀쩡한 규칙을 막게 된다.
// 여기서 걸러내는 건 괄호가 안 닫혔거나 도구명이 비어 오타가 확실한 것들뿐이다.
const PERM_RULE_RE = /^[A-Za-z][A-Za-z0-9_-]*(\(.*\))?$/;
export const looksLikePermRule = (v: string): boolean => {
  if (!PERM_RULE_RE.test(v)) return false;
  const open = (v.match(/\(/g) || []).length, close = (v.match(/\)/g) || []).length;
  return open === close;
};

// 출처 안에서의 짧은 이름(마켓이면 플러그인 세그먼트, 원격이면 id, 로컬이면 디렉토리명).
// originLabel 이 "어디"라면 이쪽은 "무엇"이다 - 유닛 행은 둘을 각각 다른 칸에 쓴다.
export function originShort(origin: string): string {
  const o = String(origin || "");
  if (o.startsWith("market:")) {
    const rest = o.slice("market:".length);
    const i = rest.indexOf("/");
    return i < 0 ? rest : rest.slice(i + 1);
  }
  return originLabel(o);
}

// 항목/유닛 행의 출처 태그. 라벨은 짧게, 전체 경로는 title 로.
export function mkSrcTag(origin: string, path?: string): HTMLElement {
  const s = document.createElement("span");
  s.className = "libsrc";
  s.textContent = originLabel(origin);
  s.title = path ? `${origin}\n${path}` : origin;
  return s;
}
