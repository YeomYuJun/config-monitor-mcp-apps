// lib_store.ts - 라이브러리 스토어(store/config.json) 소유 모듈. src/lib_store.py 이식.
//
// 여기가 다루는 것:
//   - libraries[]      기존 로컬 경로 배열(문자열 그대로 - 형태 변경 금지)
//   - remotes[]        원격 git 레포 등록
//   - marketplaces[]   마켓 레포 등록 + fetch 된 플러그인
//   - installed{}      출처 원장. 키는 정규화된 타깃 루트, 그 아래 "<category>/<name>".
//
// 원장 키 방향이 중요하다: origin 으로 키를 잡으면 두 플러그인의 skills/code-review 가
// 각자 원장을 가져 conflict 가 영원히 발동하지 않는다. 타깃 경로 하나당 원장 항목 하나.
//
// 네트워크도 git 도 여기 없다(scan 경로에서 import 되므로).
// 환경변수(CLAUDE_SNAPSHOT_STORE, CLAUDE_CAS_LOCK_WAIT)는 import 시점이 아니라 호출 시점에 읽는다.
//
// 이 파일은 Python os.path(ntpath/posixpath)와 같은 결과를 내는 경로 함수도 담는다.
// 스토어 경로와 원장 키가 Python 판이 쓴 config.json 에 그대로 남으므로 node:path 의 정규화 규칙을 쓰지 않는다.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { compareCodePoints, pyDumps } from "./cli_result.ts";
import { expanduser } from "./paths.ts";

export const LOCK_STALE_SEC = 60.0;
export const LEGACY_WIN_STORE = "D:\\.claude-snapshot";

const WIN = process.platform === "win32";

/**
 * store/config.json 이 없어 영속화할 수 없음.
 *
 * 기존 _register_lib 은 이 상황에서 조용히 False 를 반환했고 호출부가 그걸 무시해
 * 'UI 는 등록됐다고 말하는데 실제로는 안 된' 상태를 만들었다. 예외로 바꿔 호출부가
 * ok:false 로 보고하게 강제한다.
 */
export class StoreNotInitialized extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreNotInitialized";
  }
}

/** Python 의 TimeoutError(file_lock 대기 초과). guard 코드표에서 lock_timeout 으로 바뀐다. */
export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** 스토어 config.json. 여러 모듈이 한 파일을 나눠 쓴다(키 목록은 docs/port-contract-2026-11-20.md 4.1절). */
export interface StoreConfig {
  version?: number;
  store?: string;
  tracked?: string[];
  libraries?: string[];
  remotes?: Record<string, unknown>[];
  marketplaces?: Record<string, unknown>[];
  installed?: Record<string, Record<string, Record<string, unknown>>>;
  ui?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LockHandle {
  /** 토큰이 자기 것일 때만 락 파일을 지운다. 오류는 삼킨다. */
  release(): void;
}

export interface LedgerRef {
  target: string;
  key: string;
  rec: Record<string, unknown>;
}

// ----- Python os.path 호환 -----

/** os.sep */
export const SEP = WIN ? "\\" : "/";

/** ntpath.splitroot(3.12). posix 에서는 posixpath.splitroot. */
export function splitroot(p: string): [string, string, string] {
  if (!WIN) {
    if (!p.startsWith("/")) return ["", "", p];
    if (!p.startsWith("//") || p.startsWith("///")) return ["", "/", p.slice(1)];
    return ["", "//", p.slice(2)];
  }
  const n = p.replace(/\//g, "\\");
  if (n.slice(0, 1) === "\\") {
    if (n.slice(1, 2) === "\\") {
      const start = n.slice(0, 8).toUpperCase() === "\\\\?\\UNC\\" ? 8 : 2;
      const i = n.indexOf("\\", start);
      if (i === -1) return [p, "", ""];
      const j = n.indexOf("\\", i + 1);
      if (j === -1) return [p, "", ""];
      return [p.slice(0, j), p.slice(j, j + 1), p.slice(j + 1)];
    }
    return ["", p.slice(0, 1), p.slice(1)];
  }
  if (n.slice(1, 2) === ":") {
    if (n.slice(2, 3) === "\\") return [p.slice(0, 2), p.slice(2, 3), p.slice(3)];
    return [p.slice(0, 2), "", p.slice(2)];
  }
  return ["", "", p];
}

/** os.path.join. node:path.join 과 달리 정규화하지 않는다. */
export function pjoin(first: string, ...rest: string[]): string {
  if (!WIN) {
    let out = first;
    for (const b of rest) {
      if (b.startsWith("/")) out = b;
      else if (!out || out.endsWith("/")) out += b;
      else out += "/" + b;
    }
    return out;
  }
  const seps = "\\/";
  let [rd, rr, rp] = splitroot(first);
  for (const p of rest) {
    const [pd, pr, pp] = splitroot(p);
    if (pr) {
      if (pd || !rd) rd = pd;
      rr = pr;
      rp = pp;
      continue;
    } else if (pd && pd !== rd) {
      if (pd.toLowerCase() !== rd.toLowerCase()) {
        rd = pd; rr = pr; rp = pp;
        continue;
      }
      rd = pd;
    }
    if (rp && !seps.includes(rp[rp.length - 1])) rp += "\\";
    rp += pp;
  }
  if (rp && !rr && rd && !(":" + seps).includes(rd.slice(-1))) return rd + "\\" + rp;
  return rd + rr + rp;
}

/** os.path.split. */
export function psplit(p: string): [string, string] {
  const seps = WIN ? "\\/" : "/";
  const [d, r, rest] = WIN ? splitroot(p) : ["", "", p];
  let i = rest.length;
  while (i && !seps.includes(rest[i - 1])) i--;
  const head = rest.slice(0, i), tail = rest.slice(i);
  if (WIN) return [d + r + rstripChars(head, seps), tail];
  const h = head && head !== "/".repeat(head.length) ? rstripChars(head, "/") : head;
  return [h, tail];
}

export function basename(p: string): string {
  return psplit(p)[1];
}

export function dirname(p: string): string {
  return psplit(p)[0];
}

function rstripChars(s: string, chars: string): string {
  let i = s.length;
  while (i && chars.includes(s[i - 1])) i--;
  return s.slice(0, i);
}

/** os.path.normpath. */
export function normpath(p: string): string {
  if (!WIN) {
    if (!p) return ".";
    const initial = p.startsWith("/") ? (p.startsWith("//") && !p.startsWith("///") ? 2 : 1) : 0;
    const out: string[] = [];
    for (const c of p.split("/")) {
      if (!c || c === ".") continue;
      if (c !== ".." || (!initial && !out.length) || (out.length && out[out.length - 1] === "..")) out.push(c);
      else if (out.length) out.pop();
    }
    const s = "/".repeat(initial) + out.join("/");
    return s || ".";
  }
  const q = p.replace(/\//g, "\\");
  const [drive, root, rest] = splitroot(q);
  const prefix = drive + root;
  const comps = rest.split("\\");
  let i = 0;
  while (i < comps.length) {
    if (!comps[i] || comps[i] === ".") comps.splice(i, 1);
    else if (comps[i] === "..") {
      if (i > 0 && comps[i - 1] !== "..") {
        comps.splice(i - 1, 2);
        i--;
      } else if (i === 0 && root) comps.splice(i, 1);
      else i++;
    } else i++;
  }
  if (!prefix && !comps.length) comps.push(".");
  return prefix + comps.join("\\");
}

/** os.path.normcase. Windows 에서 소문자 + 역슬래시, posix 에서는 그대로. */
export function normcase(p: string): string {
  return WIN ? p.replace(/\//g, "\\").toLowerCase() : p;
}

/**
 * os.path.abspath. Windows 의 Python 은 GetFullPathNameW 를 쓰므로 끝의 구분자와
 * 마지막 이름 끝의 점·공백을 지운다(node:path.resolve 는 점·공백을 남긴다).
 */
export function abspath(p: string): string {
  if (!WIN) return normpath(nodePath.posix.isAbsolute(p) ? p : pjoin(process.cwd(), p));
  let r = nodePath.win32.resolve(p);
  const [d, root, rest] = splitroot(r);
  if (rest) {
    const parts = rest.split("\\");
    const last = parts[parts.length - 1];
    if (last !== "." && last !== "..") {
      const stripped = last.replace(/[. ]+$/, "");
      parts[parts.length - 1] = stripped;
      r = d + root + (stripped ? parts.join("\\") : parts.slice(0, -1).join("\\"));
    }
  }
  return r;
}

/** Python 텍스트 모드 쓰기의 줄바꿈 변환(Windows 에서 \n -> \r\n). */
export function textModeNewlines(s: string): string {
  return WIN ? s.replace(/\n/g, "\r\n") : s;
}

/** utf-8-sig 디코드(errors="replace"): 앞의 BOM 하나를 뗀다. */
export function decodeUtf8Sig(b: Uint8Array): string {
  const s = Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Python 의 UnicodeDecodeError(ValueError 의 하위). */
export class UnicodeDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnicodeDecodeError";
  }
}

/** open(encoding="utf-8-sig") 읽기와 같다: 잘못된 바이트는 UnicodeDecodeError, 앞의 BOM 하나를 뗀다. */
export function decodeUtf8SigStrict(b: Uint8Array): string {
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    throw new UnicodeDecodeError("'utf-8' codec can't decode bytes: invalid utf-8");
  }
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** utf-8-sig 로 읽어 pyLoads 한다(json.load 와 같은 예외). */
export function readJsonFile(p: string, opts: LoadsOptions = {}): unknown {
  return pyLoads(decodeUtf8SigStrict(fs.readFileSync(p)), opts);
}

// ----- Python json.loads 호환 -----

/** Python json.JSONDecodeError(ValueError 의 하위). message 는 Python 과 같은 문장이다. */
export class JSONDecodeError extends Error {
  readonly msg: string;
  readonly pos: number;
  constructor(msg: string, doc: string, pos: number) {
    const before = doc.slice(0, pos);
    const lineno = before.split("\n").length;
    const nl = before.lastIndexOf("\n");
    const cp = (s: string) => [...s].length;
    const col = nl < 0 ? cp(before) + 1 : cp(before.slice(nl + 1)) + 1;
    super(`${msg}: line ${lineno} column ${col} (char ${cp(before)})`);
    this.name = "JSONDecodeError";
    this.msg = msg;
    this.pos = pos;
  }
}

/** Python float. floats 옵션으로 읽으면 소수점·지수가 있던 숫자가 이것이 된다(1.0 을 "1.0" 으로 다시 쓰기 위해). */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export interface LoadsOptions {
  /** true 면 소수점·지수가 있던 숫자를 PyFloat 로 돌려준다. 기본은 number. */
  floats?: boolean;
}

/** ValueError 계열(JSONDecodeError, UnicodeDecodeError 포함)인지. */
export function isValueError(e: unknown): boolean {
  return e instanceof JSONDecodeError || e instanceof UnicodeDecodeError || (e instanceof Error && e.name === "ValueError");
}

/** OSError 계열(node:fs 의 시스템 오류)인지. */
export function isOSError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code);
}

/** type(e).__name__ 에 해당하는 이름. node:fs 오류는 Python 의 OSError 하위 이름으로 바꾼다. */
export function pyErrorName(e: unknown): string {
  if (isOSError(e)) {
    const code = (e as NodeJS.ErrnoException).code;
    return ({ ENOENT: "FileNotFoundError", EEXIST: "FileExistsError", EACCES: "PermissionError", EPERM: "PermissionError",
      EISDIR: "IsADirectoryError", ENOTDIR: "NotADirectoryError" } as Record<string, string>)[code!] ?? "OSError";
  }
  return e instanceof Error ? e.name : "Exception";
}

/**
 * Python json.loads 와 같은 결과와 오류 문장. 2^53 을 넘는 정수는 bigint, NaN/Infinity 를 받는다.
 * 오류 위치는 Python 처럼 코드 포인트 단위로 센다.
 */
export function pyLoads(s: string, opts: LoadsOptions = {}): unknown {
  if (s.charCodeAt(0) === 0xfeff) throw new JSONDecodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)", s, 0);
  const n = s.length;
  const ws = (i: number) => {
    while (i < n && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
    return i;
  };
  const NUM = /(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/y;
  class Stop {
    constructor(readonly pos: number) {}
  }
  const float = (v: number) => (opts.floats ? new PyFloat(v) : v);
  const setKey = (o: Record<string, unknown>, k: string, v: unknown) => {
    if (k === "__proto__") Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
    else o[k] = v;
  };
  const str = (begin: number): [string, number] => {
    let out = "";
    let i = begin;
    for (;;) {
      let j = i;
      let c = "";
      while (j < n) {
        c = s[j];
        if (c === '"' || c === "\\") break;
        if (c.charCodeAt(0) <= 0x1f) throw new JSONDecodeError("Invalid control character at", s, j);
        j++;
      }
      if (j >= n) throw new JSONDecodeError("Unterminated string starting at", s, begin - 1);
      out += s.slice(i, j);
      if (c === '"') return [out, j + 1];
      j++;
      if (j >= n) throw new JSONDecodeError("Unterminated string starting at", s, begin - 1);
      const e = s[j];
      if (e !== "u") {
        const m = ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[e];
        if (m === undefined) throw new JSONDecodeError("Invalid \\escape", s, j - 1);
        out += m;
        i = j + 1;
      } else {
        const end = j + 5;
        if (end >= n) throw new JSONDecodeError("Invalid \\uXXXX escape", s, j);
        const hex = s.slice(j + 1, end);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JSONDecodeError("Invalid \\uXXXX escape", s, j);
        out += String.fromCharCode(parseInt(hex, 16));
        i = end;
      }
    }
  };
  const value = (i: number): [unknown, number] => {
    if (i >= n) throw new Stop(i);
    const c = s[i];
    if (c === '"') return str(i + 1);
    if (c === "{") return object(i + 1);
    if (c === "[") return array(i + 1);
    if (c === "n" && s.startsWith("null", i)) return [null, i + 4];
    if (c === "t" && s.startsWith("true", i)) return [true, i + 4];
    if (c === "f" && s.startsWith("false", i)) return [false, i + 5];
    NUM.lastIndex = i;
    const m = NUM.exec(s);
    if (m) {
      const end = i + m[0].length;
      if (m[2] || m[3]) return [float(Number(m[0])), end];
      const v = Number(m[1]);
      return [Number.isSafeInteger(v) ? (v === 0 ? 0 : v) : BigInt(m[1]), end];
    }
    if (c === "N" && s.startsWith("NaN", i)) return [float(NaN), i + 3];
    if (c === "I" && s.startsWith("Infinity", i)) return [float(Infinity), i + 8];
    if (c === "-" && s.startsWith("-Infinity", i)) return [float(-Infinity), i + 9];
    throw new Stop(i);
  };
  const object = (i: number): [unknown, number] => {
    const o: Record<string, unknown> = {};
    i = ws(i);
    if (i < n && s[i] === "}") return [o, i + 1];
    for (;;) {
      if (i >= n || s[i] !== '"') throw new JSONDecodeError("Expecting property name enclosed in double quotes", s, i);
      const [k, ki] = str(i + 1);
      i = ws(ki);
      if (i >= n || s[i] !== ":") throw new JSONDecodeError("Expecting ':' delimiter", s, i);
      i = ws(i + 1);
      const [v, vi] = value(i);
      setKey(o, k, v);
      i = ws(vi);
      if (i < n && s[i] === "}") return [o, i + 1];
      if (i >= n || s[i] !== ",") throw new JSONDecodeError("Expecting ',' delimiter", s, i);
      i = ws(i + 1);
    }
  };
  const array = (i: number): [unknown, number] => {
    const a: unknown[] = [];
    i = ws(i);
    if (i < n && s[i] === "]") return [a, i + 1];
    for (;;) {
      const [v, vi] = value(i);
      a.push(v);
      i = ws(vi);
      if (i < n && s[i] === "]") return [a, i + 1];
      if (i >= n || s[i] !== ",") throw new JSONDecodeError("Expecting ',' delimiter", s, i);
      i = ws(i + 1);
    }
  };
  let res: unknown, end: number;
  try {
    [res, end] = value(ws(0));
  } catch (e) {
    if (e instanceof Stop) throw new JSONDecodeError("Expecting value", s, e.pos);
    throw e;
  }
  end = ws(end);
  if (end !== n) throw new JSONDecodeError("Extra data", s, end);
  return res;
}

/** Python repr(float). */
export function pyFloatRepr(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
  const [mant, expS] = v.toExponential().split("e");
  const exp = Number(expS);
  if (exp < -4 || exp >= 16) return `${mant}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  // -4 <= exp < 16 에서 String(v) 는 지수 없이 최단 표기를 낸다.
  const s = String(v);
  return s.includes(".") ? s : s + ".0";
}

export interface DumpsExOptions {
  indent?: number | null;
  sortKeys?: boolean;
  separators?: readonly [string, string];
  ensureAscii?: boolean;
}

/** cli_result.pyDumps 와 같은 규칙에 PyFloat(Python float 표기)을 더한 것. */
export function pyDumpsEx(value: unknown, opts: DumpsExOptions = {}): string {
  const indent = opts.indent ?? null;
  const [itemSep, keySep] = opts.separators ?? (indent === null ? [", ", ": "] : [",", ": "]);
  const ascii = opts.ensureAscii ?? true;
  const walk = (v: unknown, level: number): string => {
    if (v instanceof PyFloat) return pyFloatRepr(v.value);
    if (v === null || v === undefined || typeof v !== "object") return pyDumps(v, { ensureAscii: ascii });
    const nl = indent === null ? "" : "\n" + " ".repeat(indent * (level + 1));
    const close = indent === null ? "" : "\n" + " ".repeat(indent * level);
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      return "[" + nl + v.map((x) => walk(x, level + 1)).join(itemSep + nl) + close + "]";
    }
    const o = v as Record<string, unknown>;
    let keys = Object.keys(o).filter((k) => o[k] !== undefined);
    if (opts.sortKeys) keys = keys.sort(compareCodePoints);
    if (!keys.length) return "{}";
    return "{" + nl + keys.map((k) => pyDumps(k, { ensureAscii: ascii }) + keySep + walk(o[k], level + 1)).join(itemSep + nl) + close + "}";
  };
  return walk(value, 0);
}

/** Python 의 == (dict 는 키 순서 무시, bool/int/float 은 값으로 비교, PyFloat 포함). */
export function pyEq(a: unknown, b: unknown): boolean {
  const num = (x: unknown): number | bigint | null =>
    x instanceof PyFloat ? x.value : typeof x === "number" || typeof x === "bigint" ? x : typeof x === "boolean" ? (x ? 1 : 0) : null;
  const na = num(a), nb = num(b);
  if (na !== null || nb !== null) {
    if (na === null || nb === null) return false;
    // eslint-disable-next-line eqeqeq
    return na == nb;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => pyEq(x, b[i]));
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && pyEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Python bool(x). */
export function pyTruthy(x: unknown): boolean {
  if (x instanceof PyFloat) return x.value !== 0;
  if (x === null || x === undefined || x === false || x === 0 || x === 0n || x === "") return false;
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === "object") return Object.keys(x).length > 0;
  return Boolean(x);
}

/** Python dict(JSON object) 인지. */
export function isDict(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x) && !(x instanceof PyFloat);
}

/** type(x).__name__ (JSON 값 기준). */
export function pyTypeName(x: unknown): string {
  if (x === null || x === undefined) return "NoneType";
  if (typeof x === "boolean") return "bool";
  if (typeof x === "bigint" || (typeof x === "number" && Number.isInteger(x))) return "int";
  if (typeof x === "number" || x instanceof PyFloat) return "float";
  if (typeof x === "string") return "str";
  if (Array.isArray(x)) return "list";
  return "dict";
}

/** Python 의 AttributeError("'list' object has no attribute 'get'"). */
export function attributeError(obj: unknown, attr: string): Error {
  const e = new Error(`'${pyTypeName(obj)}' object has no attribute '${attr}'`);
  e.name = "AttributeError";
  return e;
}

/** datetime.now() 한 시점: 로컬 Date 와 그 초 안의 마이크로초. */
export interface PyNow {
  date: Date;
  micro: number;
}

let lastMicros = 0n;

/**
 * 마이크로초 해상도의 현재 시각. Date 는 밀리초라 같은 밀리초에 찍은 두 스냅샷 id 가 겹치므로
 * performance 시계에서 밀리초 아래 자리만 빌리고, 한 프로세스 안에서는 앞 값보다 반드시 커지게 한다.
 * 밀리초 이상은 Date.now() 를 따른다: performance.timeOrigin 은 기동 시점에 고정돼 상주 프로세스(watcher)에서
 * 시스템 시계 조정을 놓치고, 다른 프로세스가 Date.now() 로 잰 heartbeat 나이와 스냅샷 id 순서가 어긋난다.
 */
export function pyNow(): PyNow {
  let us = BigInt(Date.now()) * 1000n + BigInt(Math.floor((performance.now() * 1000) % 1000));
  if (us <= lastMicros) us = lastMicros + 1n;
  lastMicros = us;
  return { date: new Date(Number(us / 1000n)), micro: Number(us % 1000000n) };
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** isoformat(): 로컬 시각, 마이크로초가 0 이면 생략. aware 면 astimezone() 처럼 +HH:MM 을 붙인다. */
export function isoLocal(t: PyNow, aware = false, timespec: "auto" | "seconds" = "auto"): string {
  const d = t.date;
  let s = `${String(d.getFullYear()).padStart(4, "0")}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  if (timespec === "auto" && t.micro) s += `.${String(t.micro).padStart(6, "0")}`;
  if (aware) {
    const off = -d.getTimezoneOffset();
    s += `${off < 0 ? "-" : "+"}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
  }
  return s;
}

/** strftime("%Y%m%d%H%M%S"), micro 가 true 면 "%Y%m%dT%H%M%S_%f". */
export function stamp(t: PyNow, micro = false): string {
  const d = t.date;
  const date = `${String(d.getFullYear()).padStart(4, "0")}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  const time = `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  return micro ? `${date}T${time}_${String(t.micro).padStart(6, "0")}` : date + time;
}

/** Python datetime.now().isoformat(). */
export function localIsoNow(): string {
  return isoLocal(pyNow());
}

/** Python 의 f"{x:.Nf}": 정확히 반인 값은 짝수 쪽으로 반올림한다(toFixed 는 올린다). */
export function pyFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return x > 0 ? "inf" : x < 0 ? "-inf" : "nan";
  const f = 10 ** digits;
  const fl = Math.floor(x * f);
  // (2*fl+1)/(2*f) 가 2진수로 정확히 표현될 때만(5^digits 가 분자를 나눌 때) x 가 진짜 반값일 수 있다.
  const odd = 2 * fl + 1;
  if (Number.isSafeInteger(odd) && odd % 5 ** digits === 0 && odd / (2 * f) === x) {
    const n = fl % 2 === 0 ? fl : fl + 1;
    return (n / f).toFixed(digits);
  }
  return x.toFixed(digits);
}

// ----- 스토어 -----

/** float(env CLAUDE_CAS_LOCK_WAIT or "8"). */
export function lockWaitSec(): number {
  const raw = process.env.CLAUDE_CAS_LOCK_WAIT ?? "8";
  const t = raw.trim().toLowerCase();
  const v = Number(t);
  if (t === "inf" || t === "+inf" || t === "infinity") return Infinity;
  if (t === "-inf" || t === "-infinity") return -Infinity;
  if (t === "" || Number.isNaN(v)) throw new Error(`could not convert string to float: '${raw}'`);
  return v;
}

/**
 * CLAUDE_SNAPSHOT_STORE > (Windows) 이미 있는 D:\.claude-snapshot > ~/.claude-snapshot.
 * D:\ 고정 기본값은 D: 드라이브가 없는 PC 에서 깨진다. 그 자리에 스토어가 이미 있는 설치만 계속 쓴다.
 */
export function defaultStore(): string {
  const env = process.env.CLAUDE_SNAPSHOT_STORE;
  if (env) return env;
  if (WIN && isDir(LEGACY_WIN_STORE)) return LEGACY_WIN_STORE;
  return pjoin(expanduser("~"), ".claude-snapshot");
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function storeConfigPath(store: string): string {
  return pjoin(store, "config.json");
}

/** 경로 비교용 정규화(대소문자/구분자/./.. 흡수). os.path.normcase(os.path.normpath(p)). library._norm 과 동일 규칙. */
export function norm(p: string): string {
  return normcase(normpath(p));
}

export function loadCfg(store: string): StoreConfig {
  const p = storeConfigPath(store);
  if (!fs.existsSync(p)) return {};
  // utf-8-sig: 윈도우에서 만들어진 config.json 에는 BOM 이 붙어 온다(BOM 없는 파일도 동일 처리).
  // 다시 쓸 때 Python 판과 같은 숫자 표기(1.0)를 지키려고 PyFloat 로 읽는다.
  return readJsonFile(p, { floats: true }) as StoreConfig;
}

/** 원자적 쓰기(.tmp -> replace). store 미초기화면 StoreNotInitialized. */
export function saveCfg(store: string, cfg: StoreConfig): void {
  const p = storeConfigPath(store);
  if (!fs.existsSync(p)) throw new StoreNotInitialized(`Store is not initialized: ${p}`);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, textModeNewlines(pyDumpsEx(cfg, { indent: 2, ensureAscii: false })), "utf8");
  fs.renameSync(tmp, p);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** O_CREAT|O_EXCL 락. 대기 초과 시 LockTimeoutError, staleSec 보다 오래된 락은 깨고 다시 잡는다. */
export async function fileLock(lock: string, waitSec: number, staleSec: number, busy: string): Promise<LockHandle> {
  const deadline = performance.now() + waitSec * 1000;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // 죽은 프로세스가 남긴 락은 나이로만 판정한다(pid 재사용을 신뢰하지 않는다).
      try {
        if (Date.now() / 1000 - fs.statSync(lock).mtimeMs / 1000 > staleSec) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        // 그 사이 남이 풀었다 - 다음 루프에서 재시도
      }
      if (performance.now() > deadline) throw new LockTimeoutError(`${busy} (waited ${pyFixed(waitSec, 0)}s): ${lock}`);
      await sleep(50);
    }
  }
  const token = randomBytes(16).toString("hex");
  const release = () => {
    // stale 로 판정돼 다른 프로세스가 가져간 락을 지우지 않는다
    try {
      const owner = (JSON.parse(decodeUtf8Sig(fs.readFileSync(lock))) as Record<string, unknown> | null)?.token;
      if (owner === token) fs.unlinkSync(lock);
    } catch {
      // OSError, ValueError, AttributeError 는 삼킨다
    }
  };
  try {
    fs.writeSync(fd, Buffer.from(pyDumps({ pid: process.pid, at: localIsoNow(), token })));
    fs.closeSync(fd);
    fd = null;
  } catch (e) {
    if (fd !== null) fs.closeSync(fd);
    release();
    throw e;
  }
  return { release };
}

export async function withFileLock<T>(lock: string, waitSec: number, staleSec: number, busy: string, fn: () => T | Promise<T>): Promise<T> {
  const h = await fileLock(lock, waitSec, staleSec, busy);
  try {
    return await fn();
  } finally {
    h.release();
  }
}

/** config.json 읽기-수정-쓰기 구간. 스냅샷 락과 함께 잡을 때는 항상 스냅샷 락이 먼저다. */
export async function configLock(store: string): Promise<LockHandle> {
  return fileLock(pjoin(store, "config.lock"), lockWaitSec(), LOCK_STALE_SEC, "Another operation is writing config.json");
}

/**
 * Python edit_cfg 컨텍스트 매니저. config.json 이 없으면 락 전에 StoreNotInitialized.
 * config.lock 안에서 cfg 를 읽어 fn 에 넘기고, fn 이 정상 종료하면 save_cfg 한다. fn 이 던지면(emit 포함) 저장하지 않는다.
 */
export async function withEditCfg<T>(store: string, fn: (cfg: StoreConfig) => T | Promise<T>): Promise<T> {
  if (!fs.existsSync(storeConfigPath(store))) throw new StoreNotInitialized(`Store is not initialized: ${storeConfigPath(store)}`);
  const h = await configLock(store);
  try {
    const cfg = loadCfg(store);
    const r = await fn(cfg);
    saveCfg(store, cfg);
    return r;
  } finally {
    h.release();
  }
}

// ----- 출처 원장 -----
// 구조: cfg["installed"][<정규화 타깃루트>]["<category>/<name>"] = {origin, src_hash, ...}
// category 는 agents/skills/commands 외에 hooks/mcp 도 온다(설치 단위가 다르지만 소유권 모델은 같다).

type Rows = Record<string, Record<string, unknown>>;

export function ledgerRootKey(targetRoot: string): string {
  return norm(targetRoot);
}

function rows(cfg: StoreConfig, targetRoot: string, create: boolean): Rows {
  const k = ledgerRootKey(targetRoot);
  if (create) {
    if (!("installed" in cfg)) cfg.installed = {};
    const inst = cfg.installed as Record<string, Rows>;
    if (!(k in inst)) inst[k] = {};
    return inst[k];
  }
  const inst = ("installed" in cfg ? cfg.installed : {}) as Record<string, Rows>;
  return k in inst ? inst[k] : {};
}

export function ledgerGet(cfg: StoreConfig, targetRoot: string, category: string, name: string): Record<string, unknown> | null {
  const r = rows(cfg, targetRoot, false);
  const key = `${category}/${name}`;
  return key in r ? r[key] : null;
}

export function ledgerPut(cfg: StoreConfig, targetRoot: string, category: string, name: string, rec: Record<string, unknown>): void {
  rows(cfg, targetRoot, true)[`${category}/${name}`] = rec;
}

export function ledgerDel(cfg: StoreConfig, targetRoot: string, category: string, name: string): void {
  delete rows(cfg, targetRoot, false)[`${category}/${name}`];
}

/**
 * cacheRoot 를 rec["root"] 로 붙잡고 있는 원장 항목 전부(그 아래도 포함).
 *
 * equality 만 보면 안 된다: 번들(str-path) 플러그인의 root 는
 * <market repo cache>/plugins/<name> 로 마켓 레포 캐시의 하위다.
 * unregister --origin market:<id> 는 <store>/lib-cache/markets/<id>/ 전체를
 * 지우므로, 그 상위 캐시 자체가 아니라 하위 root 를 붙잡은 hooks/MCP 원장도
 * 찾아내야 가드가 뚫리지 않는다. 접두 비교는 구분자를 붙여서 해
 * "...\abc" 가 "...\abcdef" 에 거짓 매치되지 않게 한다.
 *
 * unregister 가 캐시를 지워도 되는지 판단하는 유일한 근거다.
 */
export function ledgerRefsRoot(cfg: StoreConfig, cacheRoot: string): LedgerRef[] {
  const want = norm(cacheRoot);
  const pref = want.endsWith(SEP) ? want : want + SEP;
  const hits: LedgerRef[] = [];
  for (const [tgt, rs] of Object.entries((cfg.installed || {}) as Record<string, Rows>)) {
    for (const [key, rec] of Object.entries(rs)) {
      const r = rec.root;
      if (!r) continue;
      const n = norm(String(r));
      if (n === want || n.startsWith(pref)) hits.push({ target: tgt, key, rec });
    }
  }
  return hits;
}
