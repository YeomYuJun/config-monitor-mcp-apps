// cli_result.ts - 이식 모듈 진입 함수의 결과 계약(src/cli_result.py 이식).
//
// 결과는 JSON 문서 하나: {ok, code, message, [target], [detail], <도구별 필드>}.
// ok:true 는 exit 0, ok:false 는 exit 1. code 가 UI 분기와 번역의 유일한 기준이다.
// Python 판은 emit 이 출력하고 프로세스를 끝낸다. TS 판은 같은 프로세스 안에서 불리므로
// emit 이 CliExit 를 던지고 guard 가 그것을 받아 문서로 돌려준다(출력과 종료는 runMain 만 한다).

export const RESERVED: ReadonlySet<string> = new Set(["ok", "code", "message", "target", "detail"]);

export interface CliDoc {
  ok: boolean;
  code: string;
  message: string;
  target?: string;
  detail?: string;
  [field: string]: unknown;
}

export interface EmitExtra {
  target?: unknown;
  detail?: unknown;
  indent?: number | null;
  [field: string]: unknown;
}

/** 도구별 필드가 예약 키를 덮지 못하게 한다(레코드를 최상위로 펴는 호출부용). */
export function checkFields<T extends Record<string, unknown>>(fields: T): T {
  const clash = Object.keys(fields).filter((k) => RESERVED.has(k)).sort();
  if (clash.length) {
    throw new Error(`Fields clash with reserved keys: [${clash.map((k) => `'${k}'`).join(", ")}]`);
  }
  return fields;
}

/** emit 이 던지는 값. guard 가 받아 doc 을 돌려준다. */
export class CliExit extends Error {
  readonly doc: CliDoc;
  readonly indent: number | null;
  constructor(doc: CliDoc, indent: number | null = null) {
    super(`${doc.code}: ${doc.message}`);
    this.name = "CliExit";
    this.doc = doc;
    this.indent = indent;
  }
}

/** emit 과 같은 키 순서의 문서를 만든다. target/detail 은 null·undefined 면 넣지 않고 문자열로 바꾼다. */
export function makeDoc(ok: unknown, code: string, message: string, extra: EmitExtra = {}): CliDoc {
  const { target, detail, indent: _indent, ...fields } = extra;
  const doc: CliDoc = { ok: Boolean(ok), code, message };
  if (target !== undefined && target !== null) doc.target = pyStr(target);
  if (detail !== undefined && detail !== null) doc.detail = pyStr(detail);
  Object.assign(doc, checkFields(fields));
  return doc;
}

/** Python emit 과 같은 문서를 만들어 CliExit 로 던진다. */
export function emit(ok: unknown, code: string, message: string, extra: EmitExtra = {}): never {
  throw new CliExit(makeDoc(ok, code, message, extra), extra.indent ?? null);
}

export function exitCode(doc: CliDoc): 0 | 1 {
  return doc.ok ? 0 : 1;
}

export type ErrorClass = abstract new (...args: any[]) => Error;
export type CodeMap = ReadonlyArray<readonly [ErrorClass, string]>;

export interface Outcome {
  doc: CliDoc;
  indent: number | null;
}

/**
 * main 을 실행하고 문서를 돌려준다. emit(CliExit)은 그 문서, 그 밖의 예외는 codes 의 첫 instanceof
 * 일치(없으면 internal) 문서가 된다. main 이 emit 없이 문서를 return 해도 받는다.
 */
export async function guardOutcome(
  main: () => unknown | Promise<unknown>,
  codes?: CodeMap,
  cleanup?: () => void | Promise<void>,
): Promise<Outcome> {
  try {
    const r = await main();
    if (isDoc(r)) return { doc: r, indent: null };
    throw new Error("Entry function returned without calling emit");
  } catch (e) {
    if (e instanceof CliExit) return { doc: e.doc, indent: e.indent };
    if (cleanup) await cleanup();
    const err = e instanceof Error ? e : new Error(String(e));
    const code = (codes ?? []).find(([cls]) => err instanceof cls)?.[1] ?? "internal";
    return { doc: makeDoc(false, code, `${err.name}: ${err.message}`, { detail: err.message }), indent: null };
  }
}

export async function guard(
  main: () => unknown | Promise<unknown>,
  codes?: CodeMap,
  cleanup?: () => void | Promise<void>,
): Promise<CliDoc> {
  return (await guardOutcome(main, codes, cleanup)).doc;
}

/** CLI 로 실행될 때만 쓴다: 문서를 한 줄 JSON 으로 stdout 에 쓰고 종료 코드를 정한다. */
export async function runMain(main: () => unknown | Promise<unknown>, codes?: CodeMap): Promise<void> {
  const { doc, indent } = await guardOutcome(main, codes);
  process.stdout.write(pyDumps(doc, { indent, ensureAscii: false }) + "\n");
  process.exitCode = exitCode(doc);
}

function isDoc(v: unknown): v is CliDoc {
  return !!v && typeof v === "object" && typeof (v as CliDoc).ok === "boolean" && typeof (v as CliDoc).code === "string";
}

// ----- Python str() / json.dumps 호환 -----

/** Python str() 와 같은 문자열. None/True/False 표기만 맞춘다. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

export interface DumpsOptions {
  indent?: number | null;
  sortKeys?: boolean;
  /** [item, key]. 생략 시 Python 기본값: indent 가 없으면 [", ", ": "], 있으면 [",", ": "]. */
  separators?: readonly [string, string];
  ensureAscii?: boolean;
}

/**
 * Python json.dumps 와 같은 바이트를 만든다(해시 계산과 디스크 형식용).
 * 한계: JS 숫자는 int 와 float 를 구분하지 못해 Python 의 1.0 은 "1" 로 나온다.
 * 정수 모양 키는 JS 객체에서 앞으로 옮겨지므로 키 순서가 중요한 입력은 JSON.parse 결과를 그대로 넘기지 않는다.
 */
export function pyDumps(value: unknown, opts: DumpsOptions = {}): string {
  const indent = opts.indent ?? null;
  const [itemSep, keySep] = opts.separators ?? (indent === null ? [", ", ": "] : [",", ": "]);
  const ascii = opts.ensureAscii ?? true;
  const enc = (s: string) => encodeString(s, ascii);
  const walk = (v: unknown, level: number): string => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "number") {
      if (Number.isNaN(v)) return "NaN";
      if (v === Infinity) return "Infinity";
      if (v === -Infinity) return "-Infinity";
      return pyNumber(v);
    }
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") return enc(v);
    const nl = indent === null ? "" : "\n" + " ".repeat(indent * (level + 1));
    const close = indent === null ? "" : "\n" + " ".repeat(indent * level);
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      return "[" + nl + v.map((x) => walk(x, level + 1)).join(itemSep + nl) + close + "]";
    }
    if (typeof v === "object") {
      let keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined);
      if (opts.sortKeys) keys = keys.sort(compareCodePoints);
      if (!keys.length) return "{}";
      return "{" + nl + keys.map((k) => enc(k) + keySep + walk((v as Record<string, unknown>)[k], level + 1)).join(itemSep + nl) + close + "}";
    }
    return enc(String(v));
  };
  return walk(value, 0);
}

/**
 * 숫자 표기. 안전 정수 범위의 정수 값은 int 로 쓴다(JSON.parse 결과에서 1.0 과 1 을 구분할 수 없어서).
 * 나머지는 Python float repr: 가장 짧은 왕복 자릿수, 십진 지수가 -4 미만이거나 16 이상이면
 * 지수 표기(e-05, e+16 처럼 부호와 두 자리 이상), 아니면 고정 소수점(정수로 떨어지면 ".0").
 * 2^53 을 넘는 정수 값은 JS 에서 정확한 int 자릿수를 알 수 없으므로 float 로 본다.
 */
export function pyNumber(v: number): string {
  if (Number.isSafeInteger(v)) return String(v);
  const [mant, expStr] = v.toExponential().split("e");
  const exp = Number(expStr);
  const neg = mant.startsWith("-");
  const digits = mant.replace(/^-/, "").replace(".", "");
  const sign = neg ? "-" : "";
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = String(Math.abs(exp)).padStart(2, "0");
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${e}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  const intLen = exp + 1;
  if (digits.length <= intLen) return `${sign}${digits}${"0".repeat(intLen - digits.length)}.0`;
  return `${sign}${digits.slice(0, intLen)}.${digits.slice(intLen)}`;
}

// str.isprintable() 이 거짓인 문자(공백 ' ' 은 인쇄 가능). repr 은 이것들을 \x, \u, \U 로 쓴다.
const NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Python repr(str): 작은따옴표가 있고 큰따옴표가 없으면 큰따옴표로 감싼다. */
function reprStr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch !== " " && NON_PRINTABLE_RE.test(ch)) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x100) out += "\\x" + cp.toString(16).padStart(2, "0");
      else if (cp < 0x10000) out += "\\u" + cp.toString(16).padStart(4, "0");
      else out += "\\U" + cp.toString(16).padStart(8, "0");
    } else out += ch;
  }
  return out + q;
}

/** Python repr(): str, None/True/False, 숫자, list, dict(JSON 값 기준). */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return reprStr(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") return "{" + Object.entries(v as Record<string, unknown>).map(([k, x]) => `${reprStr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  return String(v);
}

/** str.casefold() 근사. 대문자로 올렸다 내리면 ß -> ss, ſ -> s 처럼 casefold 와 같은 결과가 된다. */
export function casefold(s: string): string {
  return s.toUpperCase().toLowerCase();
}

/** Python 의 str 정렬(코드 포인트 순). */
export function compareCodePoints(a: string, b: string): number {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

const SHORT_ESC: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };

function encodeString(s: string, ascii: boolean): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.charCodeAt(i);
    if (SHORT_ESC[ch]) out += SHORT_ESC[ch];
    else if (c < 0x20 || (ascii && c > 0x7e)) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

// ----- JsonArgumentParser: argparse 의 쓰는 부분만 옮긴 파서 -----
// 지원: 부모 옵션 + 서브커맨드(dest, required), 위치 인자(nargs ?,*,+), 옵션(store, store_true,
// nargs *,+), type str/int/float, choices, required, default, SUPPRESS, 옵션 접두어 축약,
// --opt=value, 짧은 옵션에 붙인 값(-mfoo), "--" 이후는 위치 인자. 옵션/값 판정은 classify.
// 오류는 invalid_arg 문서로 던지고 문구는 argparse 와 같다.
// 지원하지 않음: -h/--help, 짧은 옵션 묶음(-abc), 상호 배타 그룹.
// 다른 점: 옵션 사이에 끊겨 들어온 위치 인자를 이어 붙인다(argparse 는 nargs + 를 연속 구간 하나로만 채운다).

export const SUPPRESS = Symbol("SUPPRESS");

export interface ArgSpec {
  dest?: string;
  type?: "str" | "int" | "float";
  action?: "store" | "store_true";
  nargs?: "?" | "*" | "+";
  default?: unknown;
  required?: boolean;
  choices?: readonly string[];
  metavar?: string;
}

interface OptDef extends ArgSpec { flags: string[]; dest: string; positional: false }
interface PosDef extends ArgSpec { name: string; dest: string; positional: true }

export type Namespace = Record<string, unknown>;

const NEG_NUMBER = /^-\d+$|^-\d*\.\d+$/;

export class JsonArgumentParser {
  readonly prog: string;
  private opts: OptDef[] = [];
  private pos: PosDef[] = [];
  private sub: { dest: string; required: boolean; parsers: Map<string, JsonArgumentParser> } | null = null;

  constructor(prog: string) {
    this.prog = prog;
  }

  error(message: string): never {
    emit(false, "invalid_arg", `${this.prog}: ${message}`);
  }

  addArgument(...args: [...string[], ArgSpec] | string[]): this {
    const last = args[args.length - 1];
    const spec: ArgSpec = typeof last === "object" ? (last as ArgSpec) : {};
    const names = (typeof last === "object" ? args.slice(0, -1) : args) as string[];
    if (names[0].startsWith("-")) {
      const long = names.find((n) => n.startsWith("--")) ?? names[0];
      const dest = spec.dest ?? long.replace(/^-+/, "").replace(/-/g, "_");
      this.opts.push({ ...spec, flags: names, dest, positional: false });
    } else {
      this.pos.push({ ...spec, name: names[0], dest: spec.dest ?? names[0], positional: true });
    }
    return this;
  }

  addSubparsers(o: { dest: string; required?: boolean }): { addParser: (name: string) => JsonArgumentParser } {
    this.sub = { dest: o.dest, required: !!o.required, parsers: new Map() };
    const s = this.sub;
    return {
      addParser: (name: string) => {
        const p = new JsonArgumentParser(`${this.prog} ${name}`);
        s.parsers.set(name, p);
        return p;
      },
    };
  }

  parse(argv: readonly string[]): Namespace {
    const ns: Namespace = {};
    const rest = this.parseInto(argv, ns);
    if (rest.length) this.error(`unrecognized arguments: ${rest.join(" ")}`);
    return ns;
  }

  private optByFlag(flag: string): OptDef | undefined {
    return this.opts.find((o) => o.flags.includes(flag));
  }

  /**
   * CPython 3.12 argparse _parse_optional / _get_option_tuples 와 같은 판정.
   * null 이면 위치 인자 값(A), 아니면 옵션(O). def 가 null 이면 이 파서에 없는 옵션 모양이다.
   */
  private classify(tok: string): { def: OptDef | null; explicit: string | null } | null {
    if (!tok || tok[0] !== "-") return null;
    const exact = this.optByFlag(tok);
    if (exact) return { def: exact, explicit: null };
    if (tok.length === 1) return null;
    const eq = tok.indexOf("=");
    if (eq >= 0) {
      const d = this.optByFlag(tok.slice(0, eq));
      if (d) return { def: d, explicit: tok.slice(eq + 1) };
    }
    const prefix = eq >= 0 ? tok.slice(0, eq) : tok;
    const explicit = eq >= 0 ? tok.slice(eq + 1) : null;
    const hits: { def: OptDef; flag: string; explicit: string | null }[] = [];
    const flags = this.opts.flatMap((o) => o.flags.map((f) => ({ def: o, flag: f })));
    if (tok[1] === "-") {
      for (const { def, flag } of flags) if (flag.startsWith(prefix)) hits.push({ def, flag, explicit });
    } else {
      // 짧은 옵션은 값을 붙여 쓸 수 있다(-mfoo).
      const short = tok.slice(0, 2);
      for (const { def, flag } of flags) {
        if (flag === short) hits.push({ def, flag, explicit: tok.slice(2) });
        else if (flag.startsWith(prefix)) hits.push({ def, flag, explicit });
      }
    }
    if (hits.length > 1) this.error(`ambiguous option: ${prefix} could match ${hits.map((h) => h.flag).join(", ")}`);
    if (hits.length === 1) return { def: hits[0].def, explicit: hits[0].explicit };
    const negOpts = this.opts.some((o) => o.flags.some((f) => NEG_NUMBER.test(f)));
    if (NEG_NUMBER.test(tok) && !negOpts) return null;
    if (tok.includes(" ")) return null;
    return { def: null, explicit: null };
  }

  private looksLikeOption(tok: string): boolean {
    return this.classify(tok) !== null;
  }

  private convert(def: OptDef | PosDef, raw: string): unknown {
    const label = def.positional ? def.metavar ?? def.name : def.flags.join("/");
    let v: unknown = raw;
    if (def.type === "int") {
      if (!/^\s*[-+]?\d+\s*$/.test(raw)) this.error(`argument ${label}: invalid int value: '${raw}'`);
      v = parseInt(raw, 10);
    } else if (def.type === "float") {
      const f = Number(raw.trim());
      if (raw.trim() === "" || Number.isNaN(f)) this.error(`argument ${label}: invalid float value: '${raw}'`);
      v = f;
    }
    if (def.choices && !def.choices.includes(String(v))) {
      this.error(`argument ${label}: invalid choice: ${pyRepr(String(v))} (choose from ${def.choices.join(", ")})`);
    }
    return v;
  }

  private parseInto(argv: readonly string[], ns: Namespace): string[] {
    for (const o of this.opts) {
      if (o.default === SUPPRESS) continue;
      if (o.action === "store_true") ns[o.dest] = o.default ?? false;
      else ns[o.dest] = o.default ?? null;
    }
    const seen = new Set<string>();
    const positionals: string[] = [];
    const unknown: string[] = [];
    let i = 0;
    let onlyPos = false;
    while (i < argv.length) {
      const tok = argv[i];
      if (!onlyPos && tok === "--") { onlyPos = true; i++; continue; }
      const cls = onlyPos ? null : this.classify(tok);
      if (cls) {
        const { def, explicit } = cls;
        if (!def) { unknown.push(tok); i++; continue; }
        seen.add(def.dest);
        if (def.action === "store_true") {
          if (explicit !== null) this.error(`argument ${def.flags.join("/")}: ignored explicit argument ${pyRepr(explicit)}`);
          ns[def.dest] = true; i++; continue;
        }
        if (def.nargs === "*" || def.nargs === "+") {
          const vals: string[] = explicit !== null ? [explicit] : [];
          i++;
          if (explicit === null) while (i < argv.length && !this.looksLikeOption(argv[i]) && argv[i] !== "--") vals.push(argv[i++]);
          if (def.nargs === "+" && !vals.length) this.error(`argument ${def.flags.join("/")}: expected at least one argument`);
          ns[def.dest] = vals.map((v) => this.convert(def, v));
          continue;
        }
        let val: string;
        if (explicit !== null) { val = explicit; i++; }
        else {
          const nxt = argv[i + 1];
          if (nxt === undefined || this.looksLikeOption(nxt)) this.error(`argument ${def.flags.join("/")}: expected one argument`);
          val = nxt; i += 2;
        }
        ns[def.dest] = this.convert(def, val);
        continue;
      }
      if (this.sub && !this.pos.length && !onlyPos) {
        const p = this.sub.parsers.get(tok);
        if (!p) {
          const choices = [...this.sub.parsers.keys()].join(", ");
          this.error(`argument ${this.sub.dest}: invalid choice: ${pyRepr(tok)} (choose from ${choices})`);
        }
        ns[this.sub.dest] = tok;
        const tail = p.parseInto(argv.slice(i + 1), ns);
        this.finish(ns, seen, positionals);
        return [...unknown, ...tail];
      }
      positionals.push(tok);
      i++;
    }
    if (this.sub && this.sub.required && !(this.sub.dest in ns)) {
      this.error(`the following arguments are required: ${this.sub.dest}`);
    }
    const extra = this.finish(ns, seen, positionals);
    return [...unknown, ...extra];
  }

  private finish(ns: Namespace, seen: Set<string>, positionals: string[]): string[] {
    const missing: string[] = [];
    let k = 0;
    const fixedAfter = (idx: number) => this.pos.slice(idx + 1).filter((p) => !p.nargs).length;
    this.pos.forEach((p, idx) => {
      const avail = positionals.length - k - fixedAfter(idx);
      if (p.nargs === "*" || p.nargs === "+") {
        const take = Math.max(0, avail);
        if (p.nargs === "+" && take === 0) { missing.push(p.metavar ?? p.name); return; }
        ns[p.dest] = positionals.slice(k, k + take).map((v) => this.convert(p, v));
        k += take;
      } else if (p.nargs === "?") {
        if (avail > 0) ns[p.dest] = this.convert(p, positionals[k++]);
        else ns[p.dest] = p.default ?? null;
      } else if (k < positionals.length) {
        ns[p.dest] = this.convert(p, positionals[k++]);
      } else {
        missing.push(p.metavar ?? p.name);
      }
    });
    for (const o of this.opts) {
      if (o.required && !seen.has(o.dest)) missing.push(o.flags.join("/"));
    }
    if (missing.length) this.error(`the following arguments are required: ${missing.join(", ")}`);
    return positionals.slice(k);
  }
}
