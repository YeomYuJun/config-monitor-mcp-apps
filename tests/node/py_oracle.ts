// Python 판이 같은 입력에서 낸 값을 고정 파일(tests/node/fixtures/python/<이름>.json)에서 돌려준다.
// 기록은 Python 판(src/*.py)이 저장소에 있던 때 CM_PY_RECORD=1 로 테스트를 돌려 만들었다. 지금은 읽기만 한다.
// 값과 키 안의 실행마다 바뀌는 경로(임시 폴더, 사용자 홈, 작업 폴더)는 자리표시자로 바꿔 저장하고, 읽을 때 되돌린다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "python");
const RECORD = process.env.CM_PY_RECORD === "1";

/** 자리표시자 -> 이 실행의 실제 문자열. */
export type Subst = Record<string, string>;

/** 실제 값의 원형, JSON 문자열 안 표기(역슬래시 두 겹), '/' 표기를 모두 바꾼다. 긴 것부터 바꿔 겹침을 막는다. */
function pairs(subst: Subst, toPlaceholder: boolean): [string, string][] {
  const out: [string, string][] = [];
  for (const [ph, real] of Object.entries(subst)) {
    if (!real) continue;
    const forms: [string, string][] = [
      [real.replace(/\\/g, "\\\\"), ph.replace(/>$/, ":J>")],
      [real, ph],
      [real.replace(/\\/g, "/"), ph.replace(/>$/, ":F>")],
    ];
    for (const [r, p] of forms) out.push(toPlaceholder ? [r, p] : [p, r]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

function swap(v: unknown, ps: [string, string][]): unknown {
  const s = (x: string) => ps.reduce((acc, [from, to]) => acc.split(from).join(to), x);
  if (typeof v === "string") return s(v);
  if (Array.isArray(v)) return v.map((x) => swap(x, ps));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [s(k), swap(x, ps)]));
  return v;
}

export interface Oracle {
  /** key 와 subst 로 찾은 기록. 기록 모드면 compute(Python 실행)의 결과를 기록하고 돌려준다. */
  <T>(key: string, subst: Subst, compute: () => T): T;
}

/** 테스트 파일마다 하나. node --test 는 파일마다 프로세스가 달라 파일을 나눠야 기록이 겹치지 않는다. */
export function pyOracle(name: string): Oracle {
  const file = path.join(DIR, `${name}.json`);
  let db: Record<string, unknown> = {};
  try {
    db = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    db = {};
  }
  return <T>(key: string, subst: Subst, compute: () => T): T => {
    const k = swap(key, pairs(subst, true)) as string;
    if (RECORD) {
      const v = compute();
      db[k] = swap(v, pairs(subst, true));
      fs.mkdirSync(DIR, { recursive: true });
      const sorted = Object.fromEntries(Object.keys(db).sort().map((x) => [x, db[x]]));
      fs.writeFileSync(file, JSON.stringify(sorted, null, 1) + "\n", "utf-8");
      return v;
    }
    if (!Object.prototype.hasOwnProperty.call(db, k)) throw new Error(`Python 판 기록이 없다(${name}): ${k.slice(0, 300)}`);
    return swap(db[k], pairs(subst, false)) as T;
  };
}

/** 파일 바이트를 기록용 문자열로. UTF-8 텍스트는 "txt:"(경로 자리표시자를 바꿀 수 있다), 그 밖은 "b64:". */
export function encodeBytes(b: Buffer): string {
  try {
    const s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
    if (!s.includes("\0")) return "txt:" + s;
  } catch {
    // 바이너리(압축 객체 등)
  }
  return "b64:" + b.toString("base64");
}

export function decodeBytes(s: string): Buffer {
  return s.startsWith("txt:") ? Buffer.from(s.slice(4), "utf-8") : Buffer.from(s.slice(4), "base64");
}

/** 폴더의 파일을 {상대경로('/'): encodeBytes} 로. 기록에 Python 이 쓴 파일을 담을 때 쓴다. */
export function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p).replace(/\\/g, "/")] = encodeBytes(fs.readFileSync(p));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/** readTree 의 결과를 root 아래에 다시 쓴다. */
export function writeTree(root: string, tree: Record<string, string>): void {
  for (const [rel, enc] of Object.entries(tree)) {
    const p = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, decodeBytes(enc));
  }
}
