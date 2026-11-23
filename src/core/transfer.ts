// transfer.ts - PC 간 설정 이관 번들(cmbundle v1) 만들기·가져오기. src/transfer.py 이식.
//
//   inventory [--with-optional local,memory,agent-memory] 이관 대상 목록(읽기 전용)
//   export --out P [--with-optional ...] [--include-secrets]
//                                                       번들 쓰기. P 가 .cmbundle 이면 zip, 아니면 폴더
//   inspect --bundle P                                  번들 요약
//   plan --bundle P [--secrets JSON] [--choices JSON]   이 PC 와 비교(읽기 전용). 항목별 new/same/changed/blocked/skipped
//   apply --bundle P --plan-id X [--ids a,b] [--install-plugins]
//                                                       plan 그대로 적용. 스냅샷 전/후, 스토어 imports[] 원장
//   undo --import-id X [--force]                        원장의 휴지통·백업으로 되돌린다
//   history                                             가져오기(imports[])·내보내기(exports[]) 기록
//   sync-setup --dir D [--profile N]                    공유 폴더 지정(스토어 config.json 의 sync)
//   sync-push [--include-secrets]                       이 PC 를 <D>/<N>/ 폴더 번들로 올린다
//   sync-status [--from M]                              PC 목록, 또는 M 과 항목별 in-sync/local-ahead/remote-ahead/diverged/untracked
//   plan --sync-from M / sync-pull --from M --plan-id X M 의 폴더 번들을 plan/apply 하고 기준을 맞춘다
//   roots --bundle P --roots JSON [--by claude|user]   이 PC 경로 짝을 확인해 저장(다음 plan 이 쓴다)
//
// 다른 PC 의 번들은 드라이브·도구 폴더가 다르다. plan 은 이 PC 에 없는 경로의 짝을 정해(--roots > 저장된 짝 > 추정)
// 값을 바꿔 끼우고, 그래도 없는 경로를 쓰는 훅·MCP 서버는 쓰지 않는다. 동작 중인 이 PC 값은 덮지 않는다.
//
// 번들에는 ~/.claude, ~/.claude.json 의 mcpServers, Desktop config 의 mcpServers, 스토어 설정만 담는다.
// 설정이 가리키는 그 밖의 파일(훅 스크립트, MCP 서버 실행 파일, 플러그인 폴더, 라이브러리)은 담지 않고
// external 로 경로만 보고한다. 새 PC 에서 같은 경로에 따로 준비해야 하는 목록이다.
//
// JSON 값은 시크릿 치환 -> 경로 토큰화 -> 외부 경로 추출 순서로 처리한다. 이 순서라야 보고·manifest 에
// 시크릿 값이 섞이지 않는다. 파일·트리 항목은 원문 바이트 그대로 담고 원문으로 해시한다.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import zlib from "node:zlib";
import { CliExit, compareCodePoints, emit, guard, JsonArgumentParser, pyStr, type CliDoc } from "./cli_result.ts";
import * as cas from "./cas.ts";
import * as configEdit from "./config_edit.ts";
import * as libStore from "./lib_store.ts";
import { abspath, basename, dirname, normcase, normpath, pjoin, SEP, splitroot } from "./lib_store.ts";
import * as paths from "./paths.ts";
import * as pluginState from "./plugin_state.ts";
import { pyIsabs } from "./plugin_units.ts";
import * as pluginCli from "./plugin_cli.ts";
import { encodeProjectDir } from "./claude_config.ts";

export interface TransferOpts {
  /** 생략 시 lib_store.defaultStore(). */
  store?: string;
}

export interface ImportArgs {
  secrets?: string;
  choices?: string;
  roots?: string;
  exclude?: string;
}

type Obj = Record<string, unknown>;

const WIN = process.platform === "win32";
const FORMAT = "cmbundle", VERSION = 1;
const HOME = () => paths.expanduser("~");
const CLAUDE_HOME = () => pjoin(HOME(), ".claude");
const CLAUDE_JSON = () => pjoin(HOME(), ".claude.json");
const SIZE_WARN = 50 * 1024 * 1024;

// (category, 하위 디렉토리, 보고 라벨, 디렉토리만 항목인가)
const TREE_CATS: [string, string, string, boolean][] = [
  ["cc.skills", "skills", "Skill", true],
  ["cc.agents", "agents", "Agent", false],
  ["cc.commands", "commands", "Command", false],
  ["cc.rules", "rules", "Rule", false],
  ["cc.output-styles", "output-styles", "Output style", false],
  ["cc.workflows", "workflows", "Workflow", false],
  ["cc.themes", "themes", "Theme", false],
];
const FILE_CATS: [string, string, string][] = [
  ["cc.claude-md", "CLAUDE.md", "CLAUDE.md"],
  ["cc.keybindings", "keybindings.json", "keybindings.json"],
];
const LABELS: Record<string, string> = {
  ...Object.fromEntries(TREE_CATS.map(([c, , l]) => [c, l])),
  ...Object.fromEntries(FILE_CATS.map(([c, , l]) => [c, l])),
  "cc.settings": "settings.json (permissions, hooks, env, plugin declarations)",
  "cc.settings-local": "settings.local.json",
  "cc.refs": "Referenced file under ~/.claude (hook and statusLine scripts)",
  "cc.mcp-user": "MCP server (Claude Code)",
  "desk.mcp": "MCP server (Desktop)",
  "cm.store": "config-monitor store settings",
  "cc.project-memory": "Project memory",
  "cc.agent-memory": "Agent memory",
};
const OPTIONAL: Record<string, string> = { local: "cc.settings-local", memory: "cc.project-memory", "agent-memory": "cc.agent-memory" };

// Python str 의 공백(str.isspace)과 같은 문자 집합. JS 의 \s 와는 \x1c-\x1f, \x85, \ufeff 에서 다르다.
const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${PY_WS}]+`, "u");
const WS_EDGE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "gu");

const SECRET_KEY = /TOKEN|KEY|SECRET|PASSWORD|AUTHORIZATION/;
const SECRET_VAL = /(?<![A-Za-z0-9])(sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9\-]{10,})/;
// Python re 의 $ 는 끝의 줄바꿈 하나 앞에서도 맞는다. match 로 쓰는 패턴은 \n?$ 로 옮겼다.
const HIGH_ENTROPY = /^[A-Za-z0-9+/_=\-]{40,}\n?$/;
const PATH_START_SRC = "[A-Za-z]:[\\\\/]|\\$\\{(?:HOME|CLAUDE_HOME|DESKTOP_DIR)\\}|~[\\\\/]";
const PATH_START = new RegExp(PATH_START_SRC);
const PATH_START_AT0 = new RegExp(`^(?:${PATH_START_SRC})`);
const STORE_MARKET_KEYS = ["id", "url", "ref", "name"];
const STORE_REMOTE_KEYS = ["id", "url", "ref", "map"];
const MCP_CATS = ["cc.mcp-user", "desk.mcp"];
const SETTINGS_CATS = ["cc.settings", "cc.settings-local"];

// ----- Python 동작 호환 도우미 -----

class PyError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

// 설정 JSON 은 PyFloat(1.0, 1e-07)·bigint(2^53 초과) 로 읽는다. 아래 도우미는 그 둘을 dict 가 아닌 값으로 다룬다.
const isObj = libStore.isDict;
const truthy = libStore.pyTruthy;
const pyType = libStore.pyTypeName;
const pyEq = libStore.pyEq;

function or<T>(v: unknown, d: T): unknown {
  return truthy(v) ? v : d;
}

/** dict.items(). dict 가 아니면 Python 처럼 AttributeError. */
function items(v: unknown): [string, unknown][] {
  if (!isObj(v)) throw new PyError("AttributeError", `'${pyType(v)}' object has no attribute 'items'`);
  return Object.entries(v);
}

/** dict.get(k, d). dict 가 아니면 AttributeError. */
function get(o: unknown, k: string, d: unknown = null): unknown {
  if (!isObj(o)) throw new PyError("AttributeError", `'${pyType(o)}' object has no attribute 'get'`);
  return Object.hasOwn(o, k) ? o[k] : d;
}

/** for x in v: list 는 원소, dict 는 키, str 은 문자. */
function iter(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObj(v)) return Object.keys(v);
  if (typeof v === "string") return [...v];
  throw new PyError("TypeError", `'${pyType(v)}' object is not iterable`);
}

function put(o: Obj, k: string, v: unknown): void {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}

const cmp = compareCodePoints;
const sortStr = (xs: Iterable<string>) => [...xs].sort(cmp);

function stripWs(s: string): string {
  return s.replace(WS_EDGE, "");
}

function splitWs(s: string): string[] {
  return s.split(WS_RUN).filter((x) => x);
}

function lstripChars(s: string, chars: string): string {
  let i = 0;
  while (i < s.length && chars.includes(s[i])) i++;
  return s.slice(i);
}

function rstripChars(s: string, chars: string): string {
  let i = s.length;
  while (i && chars.includes(s[i - 1])) i--;
  return s.slice(0, i);
}

function replaceAll(s: string, a: string, b: string): string {
  return a ? s.split(a).join(b) : s;
}

function reEscape(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

const isabs = pyIsabs;

function splitdrive(p: string): [string, string] {
  const [d, r, t] = splitroot(p);
  return [d, r + t];
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function isdir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isfile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** errno 가 붙은 node:fs 오류(Python OSError 에 해당). */
function isOSError(e: unknown): boolean {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string" && typeof (e as NodeJS.ErrnoException).errno === "number";
}

/** Python ValueError 에 해당: JSON 파싱 실패, 엄격 utf-8 디코드 실패. */
function isValueError(e: unknown): boolean {
  return libStore.isValueError(e) || e instanceof SyntaxError || (e instanceof PyError && e.name === "ValueError");
}

const OS_ERR_NAMES: Record<string, string> = {
  ENOENT: "FileNotFoundError", EEXIST: "FileExistsError", EISDIR: "IsADirectoryError",
  ENOTDIR: "NotADirectoryError", EACCES: "PermissionError", EPERM: "PermissionError",
};

/** f"{type(e).__name__}: {e}" 에 해당. node:fs 오류는 Python 예외 이름으로 바꾼다(문장은 node 원문). */
function excStr(e: unknown): string {
  if (!(e instanceof Error)) return `Exception: ${String(e)}`;
  const code = (e as NodeJS.ErrnoException).code;
  const name = isOSError(e) ? OS_ERR_NAMES[code ?? ""] ?? "OSError" : e.name;
  return `${name}: ${e.message}`;
}

function errCode(e: unknown): string | undefined {
  return isOSError(e) ? (e as NodeJS.ErrnoException).code : undefined;
}

function sha(b: Uint8Array | string): string {
  return "sha256:" + crypto.createHash("sha256").update(b).digest("hex");
}

function canon(obj: unknown): string {
  return libStore.pyDumpsEx(obj, { sortKeys: true, separators: [",", ":"], ensureAscii: false });
}

function dumps2(obj: unknown, sortKeys = false): Buffer {
  return Buffer.from(libStore.pyDumpsEx(obj, { indent: 2, ensureAscii: false, sortKeys }), "utf8");
}

// secrets.json 은 --secrets 인자와 같은 숫자 처리가 되도록 floats 없이 읽는다.
const FLOATS = { floats: true } as const, NO_FLOATS = {} as const;

/** open(p, encoding="utf-8-sig") + json.load. 설정 파일을 다시 쓸 때 숫자 표기를 지키려고 PyFloat·bigint 로 읽는다. */
function load(p: string, opts: libStore.LoadsOptions = FLOATS): unknown {
  return libStore.readJsonFile(p, opts);
}

function normDisp(p: string): string {
  return normpath(p);
}

function nowIso(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${String(d.getFullYear()).padStart(4, "0")}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}

function ts(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear()).padStart(4, "0")}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

interface WalkEntry { root: string; rel: string[]; dirs: string[]; files: string[] }

/** os.walk(top-down, followlinks=False). 읽지 못하는 폴더는 건너뛴다. sorted 면 dirs.sort(), sorted(files) 순서. */
function* walk(top: string, sorted = false, rel: string[] = []): Generator<WalkEntry> {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(top, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs: string[] = [], files: string[] = [], links = new Set<string>();
  for (const e of ents) {
    let dir = e.isDirectory();
    if (e.isSymbolicLink()) {
      dir = isdir(pjoin(top, e.name));
      if (dir) links.add(e.name);
    }
    (dir ? dirs : files).push(e.name);
  }
  if (sorted) {
    dirs.sort(cmp);
    files.sort(cmp);
  }
  yield { root: top, rel, dirs, files };
  for (const d of dirs) if (!links.has(d)) yield* walk(pjoin(top, d), sorted, [...rel, d]);
}

function shMove(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if (errCode(e) !== "EXDEV") throw e;
    fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function copy2(src: string, dst: string): void {
  fs.copyFileSync(src, dst);
  const st = fs.statSync(src);
  fs.utimesSync(dst, st.atime, st.mtime);
}

// ----- 해시 -----

/** os.walk(디렉토리 정렬) 순서: 한 폴더 안에서 파일이 하위 폴더보다 먼저 온다. */
function walkKey(rel: string): [number, string][] {
  const parts = rel.split("/");
  return [...parts.slice(0, -1).map((d) => [1, d] as [number, string]), [0, parts[parts.length - 1]]];
}

function cmpWalkKey(a: [number, string][], b: [number, string][]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i][0] !== b[i][0]) return a[i][0] - b[i][0];
    const c = cmp(a[i][1], b[i][1]);
    if (c) return c;
  }
  return a.length - b.length;
}

/** rows = [(트리 안 상대경로 '/', 파일 해시)]. export 와 import 가 같은 값을 내야 한다. */
export function treeDigest(rows: [string, string][]): string {
  const sorted = [...rows].sort((x, y) => cmpWalkKey(walkKey(x[0]), walkKey(y[0])));
  return sha(Buffer.from(sorted.map(([r, h]) => `${r}\0${h}\n`).join(""), "utf8"));
}

/** [rows, 총 바이트]. */
export function treeRows(p: string): [[string, string][], number] {
  const rows: [string, string][] = [];
  let size = 0;
  for (const w of walk(p, true)) {
    for (const fn of w.files) {
      const data = fs.readFileSync(pjoin(w.root, fn));
      rows.push([[...w.rel, fn].join("/"), sha(data)]);
      size += data.length;
    }
  }
  return [rows, size];
}

/** 시크릿 치환 -> 토큰화. [결과, {경로: 원래 값}]. 대상 PC 의 현재 값도 같은 함수로 해시해 비교한다. */
export function prepareJson(cat: string, iid: string, obj: unknown, tokens: Token[] | null): [unknown, Record<string, string>] {
  const found: Record<string, string> = {};
  if (MCP_CATS.includes(cat)) obj = scrub(obj, iid, found);
  if (SETTINGS_CATS.includes(cat) && isObj(get(obj, "env"))) {
    obj = { ...(obj as Obj), env: scrub((obj as Obj).env, iid, found, "env") };
  }
  return [tokens && tokens.length ? mapStrings(obj, (s) => tokenize(s, tokens)) : obj, found];
}

// ----- 경로 토큰 -----

export type Token = [string, string, RegExp];

/** 긴 접두부터 치환해야 ${CLAUDE_HOME} 이 ${HOME}/.claude 로 쪼개지지 않는다. */
export function makeTokens(desktopDir: string): Token[] {
  const toks: [string, string][] = [["${CLAUDE_HOME}", CLAUDE_HOME()], ["${DESKTOP_DIR}", desktopDir], ["${HOME}", HOME()]];
  toks.sort((a, b) => [...b[1]].length - [...a[1]].length);
  const flags = WIN ? "giu" : "gu";
  return toks.map(([tok, base]) => {
    const segs = base.split(/[\\/]+/).filter((s) => s).map(reEscape);
    const lead = base.startsWith("/") ? "/" : "";
    const pat = new RegExp(reEscape(lead) + segs.join("[\\\\/]+") + `(?=[\\\\/"'${PY_WS};]|$)`, flags);
    return [tok, base, pat] as Token;
  });
}

export function tokenize(s: string, tokens: Token[]): string {
  for (const [tok, , pat] of tokens) s = s.replace(pat, () => tok);
  return s;
}

export function detokenize(s: string, tokens: Token[]): string {
  for (const [tok, base] of tokens) s = replaceAll(s, tok, base);
  return s;
}

export function mapStrings(obj: unknown, fn: (s: string) => string): unknown {
  if (typeof obj === "string") return fn(obj);
  if (Array.isArray(obj)) return obj.map((v) => mapStrings(v, fn));
  if (isObj(obj)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(obj)) put(out, k, mapStrings(v, fn));
    return out;
  }
  return obj;
}

// ----- 시크릿 -----

function looksSecretValue(v: string): boolean {
  if (SECRET_VAL.test(v)) return true;
  return HIGH_ENTROPY.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !PATH_START_AT0.test(v);
}

/**
 * 키 이름이 시크릿 패턴이면 그 아래 문자열 전부, 아니면 값 패턴에 걸린 문자열만 치환한다.
 * found 에 {path: 원래 값} 을 모은다(값은 secrets.json 에만 간다).
 */
export function scrub(obj: unknown, itemId: string, found: Record<string, string>, prefix = "", keyHit = false): unknown {
  if (isObj(obj)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(obj)) {
      put(out, k, scrub(v, itemId, found, prefix ? `${prefix}.${k}` : k, keyHit || SECRET_KEY.test(k.toUpperCase())));
    }
    return out;
  }
  if (Array.isArray(obj)) return obj.map((v, i) => scrub(v, itemId, found, `${prefix}[${i}]`, keyHit));
  if (typeof obj === "string" && obj && (keyHit || looksSecretValue(obj))) {
    found[prefix] = obj;
    return `\${CM_SECRET:${itemId}:${prefix}}`;
  }
  return obj;
}

// ----- 외부 경로 -----

/**
 * 명령 문자열·env 값에서 절대경로 후보를 뽑는다. 따옴표 안은 공백을 포함한 한 덩어리로 본다.
 * POSIX 의 '/' 시작 토큰은 소스가 POSIX 일 때만 - Windows 명령의 '/c' 같은 스위치를 경로로 오인한다.
 */
export function findPaths(s: string, lists = false): string[] {
  const out: string[] = [];
  for (const piece of lists ? s.split(";") : [s]) {
    const quoted = [...piece.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => (m[1] ?? "") || (m[2] ?? ""));
    const rest = splitWs(piece.replace(/"[^"]*"|'[^']*'/g, " "));
    for (const c of [...quoted, ...rest]) {
      const m = PATH_START.exec(c);
      if (m) out.push(rstripChars(c.slice(m.index), ",)"));
      else if (!WIN && c.startsWith("/") && c.length > 1 && !c.startsWith("//")) out.push(c);
    }
  }
  return out;
}

type Ref = [string, string, string, string, boolean];

/** (kind, owner, field, 문자열, 목록 여부). 훅 command, statusLine, env 만 본다(실측에서 경로가 나온 곳). */
function settingsRefs(obj: unknown): Ref[] {
  const out: Ref[] = [];
  for (const [event, entries] of items(or(get(obj, "hooks"), {}))) {
    (Array.isArray(entries) ? entries : []).forEach((ent, i) => {
      iter(isObj(ent) ? or(get(or(ent, {}), "hooks"), []) : []).forEach((hk, j) => {
        if (isObj(hk) && typeof hk.command === "string") out.push(["hook", event, `hooks.${event}[${i}].hooks[${j}].command`, hk.command, false]);
      });
    });
  }
  const sl = get(obj, "statusLine");
  if (isObj(sl) && typeof sl.command === "string") out.push(["statusline", "statusLine", "statusLine.command", sl.command, false]);
  for (const [k, v] of items(or(get(obj, "env"), {}))) {
    if (typeof v === "string") out.push([k === "CLAUDE_CODE_PLUGIN_DIRS" ? "plugin-dirs" : "env", k, `env.${k}`, v, true]);
  }
  return out;
}

function mcpRefs(name: string, server: unknown): Ref[] {
  const out: Ref[] = [];
  const cmd = get(server, "command");
  if (typeof cmd === "string") out.push(["mcp", name, "command", cmd, false]);
  iter(or(get(server, "args"), [])).forEach((a, i) => {
    if (typeof a === "string") out.push(["mcp", name, `args[${i}]`, a, false]);
  });
  const cwd = get(server, "cwd");
  if (typeof cwd === "string") out.push(["mcp", name, "cwd", cwd, false]);
  for (const [k, v] of items(or(get(server, "env"), {}))) {
    if (typeof v === "string") out.push(["mcp", name, `env.${k}`, v, true]);
  }
  return out;
}

// ----- 경로 맞춤 -----
// ${HOME}·${CLAUDE_HOME}·${DESKTOP_DIR} 는 토큰이라 이 PC 값으로 이미 풀린다. 남는 것은 도구를 둔 드라이브·폴더처럼
// PC 마다 다른 절대경로다. 다른 PC 번들을 그대로 쓰면 이 PC 에 없는 경로가 설정에 들어가 매 턴 훅이 실패한다.
// 원칙 둘을 어디서 온 짝(추정·사람·Claude)이든 똑같이 지킨다.
//   - 이 PC 에 없는 경로는 쓰지 않는다. 맞출 짝이 없으면 그 경로를 쓰는 훅 하나·서버 하나를 뺀다.
//   - 동작 중인 이 PC 값을 동작하지 않는 값으로 덮지 않는다.

type ExistsFn = (p: string) => boolean;

function pexists(p: string): boolean {
  return exists(paths.expanduser(p));
}

function ncase(p: string): string {
  return normcase(normpath(p));
}

function under(p: string, root: string): boolean {
  const a = ncase(p), b = ncase(root);
  return a === b || a.startsWith(rstripChars(b, "\\/") + SEP);
}

/** under(p, frm) 인 p 의 frm 부분만 to 로 바꾼다. */
function rebase(p: string, frm: string, to: string): string {
  const rest = lstripChars(normpath(p).slice(normpath(frm).length), "\\/");
  return rest ? pjoin(to, rest) : normpath(to);
}

/** p 의 조상 가운데 이 PC 에 없는 가장 위 폴더(그 부모는 있다). p 가 있으면 null. */
function topMissing(p: string, ex: ExistsFn): string | null {
  let cur = normpath(p);
  if (ex(cur)) return null;
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur || ex(parent)) return cur;
    cur = parent;
  }
}

function localDrives(): string[] {
  if (!WIN) return [];
  return [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => `${c}:\\`).filter((d) => exists(d));
}

function sameName(a: string, b: string): boolean {
  return basename(normpath(a)).toLowerCase() === basename(normpath(b)).toLowerCase();
}

export interface RootRow { from: string; to: string | null; source: string; total?: number; resolved?: number; error?: string }

/**
 * 이 PC 에서 찾지 못한 경로들의 짝 루트를 추정한다. [{from, to, source, total, resolved}].
 * 근거는 둘뿐이다 - 같은 역할의 이 PC 폴더(config-monitor 라이브러리 루트), 드라이브 글자만 다른 같은 폴더.
 * 파일 이름으로 디스크를 뒤지지 않는다 - index.js 처럼 흔한 이름은 엉뚱한 도구에 붙는다.
 * 하나도 풀지 못하는 짝은 내지 않는다(그런 짝은 확인할 거리만 늘린다).
 */
export function inferRoots(missing: string[], srcLibs: string[] = [], localLibs: string[] = [], ex: ExistsFn = pexists, drives?: string[] | null): RootRow[] {
  const drv = drives ?? localDrives();
  let left = [...missing];
  const roots: RootRow[] = [];
  const take = (frm: string, to: string, source: string): boolean => {
    const mine = left.filter((p) => under(p, frm));
    const ok = mine.filter((p) => ex(rebase(p, frm, to))).length;
    if (!ok) return false;
    roots.push({ from: normpath(frm), to: normpath(to), source, total: mine.length, resolved: ok });
    left = left.filter((p) => !mine.includes(p));
    return true;
  };
  for (const src of srcLibs) {
    if (ex(src)) continue;
    let cands = localLibs.filter((lib) => sameName(lib, src) && ex(lib));
    if (!cands.length && localLibs.length === 1 && ex(localLibs[0])) cands = [...localLibs];
    for (const loc of cands) if (take(src, loc, "library")) break;
  }
  const tops: string[] = [];
  for (const p of left) {
    const t = topMissing(p, ex);
    if (t && !tops.some((x) => ncase(t) === ncase(x))) tops.push(t);
  }
  for (const top of tops) {
    const [drive, rest] = splitdrive(top);
    if (!drive) continue;
    let best: [number, string] | null = null;
    for (const d of drv) {
      if (ncase(d) === ncase(drive + SEP)) continue;
      const to = pjoin(d, lstripChars(rest, "\\/"));
      const n = left.filter((p) => under(p, top) && ex(rebase(p, top, to))).length;
      if (n && (best === null || n > best[0])) best = [n, to];
    }
    if (best) take(top, best[1], "drive");
  }
  return roots;
}

/**
 * from 루트를 to 로 바꾼다. 문자열 어디에 있든(명령 인자 안이라도) 경로 경계에서만 맞추고, 긴 루트가 이긴다.
 * 원래 글이 '/' 를 쓰면 바꾼 부분도 '/' 로 쓴다.
 */
export class PathMap {
  readonly pairs: [string, string][];
  private rx: RegExp | null;

  constructor(pairs: Iterable<[string, string]>) {
    this.pairs = [...pairs].filter(([f, t]) => f && t).map(([f, t]) => [normpath(f), normpath(t)] as [string, string])
      .sort((a, b) => [...b[0]].length - [...a[0]].length);
    const alts = this.pairs.map(([f], i) => {
      const segs = f.split(/[\\/]+/).filter((s) => s).map(reEscape);
      const lead = f && "\\/".includes(f[0]) ? "[\\\\/]" : "";
      return `(?<r${i}>` + lead + segs.join("[\\\\/]+") + ")";
    });
    this.rx = alts.length
      ? new RegExp("(?<![A-Za-z0-9_.])(?:" + alts.join("|") + `)(?=[\\\\/"'${PY_WS};,)]|$)`, WIN ? "giu" : "gu")
      : null;
  }

  sub(s: unknown, used?: Set<string>): unknown {
    if (!this.rx || typeof s !== "string") return s;
    return s.replace(this.rx, (...args: unknown[]) => {
      const groups = args[args.length - 1] as Record<string, string | undefined>;
      const str = args[args.length - 2] as string;
      const offset = args[args.length - 3] as number;
      const m0 = args[0] as string;
      const idx = Number(Object.keys(groups).find((k) => groups[k] !== undefined)!.slice(1));
      const [f, t] = this.pairs[idx];
      used?.add(pairKey(f, t));
      const end = offset + m0.length;
      const nxt = str.slice(end, end + 1);
      const out = nxt === "\\" || nxt === "/" ? rstripChars(t, "\\/") : t;
      return m0.includes("/") || nxt === "/" ? out.replace(/\\/g, "/") : out;
    });
  }
}

// set[(from, to)] 을 JS Set 에 담는 키. \0 은 경로에 나오지 않는다.
const pairKey = (f: string, t: string) => `${f}\0${t}`;
const unpair = (k: string) => k.split("\0") as [string, string];

function sortedPairs(used: Set<string>): { from: string; to: string }[] {
  return [...used].map(unpair).sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1])).map(([f, t]) => ({ from: f, to: t }));
}

function dead(s: string, lists = false, alive: ExistsFn = pexists): string[] {
  return findPaths(s, lists).filter((p) => !alive(p));
}

/**
 * 같은 훅인지 비교할 때만 쓴다. 경로는 normcase·normpath 로, 따옴표·공백 차이는 없앤다.
 * 이게 없으면 대소문자·구분자만 다른 같은 스크립트(C:/my-tools/Hooks/x.js, c:/my-tools/hooks/x.js)가
 * 다른 훅으로 보여 같은 훅이 두 번 돈다.
 */
export function normCmd(cmd: string): string {
  let s = cmd;
  for (const p of findPaths(cmd)) s = replaceAll(s, p, ncase(paths.expanduser(p)));
  s = splitWs(s.replace(/"/g, " ").replace(/'/g, " ")).join(" ");
  return WIN ? s.toLowerCase() : s;
}

export function hookId(event: string, norm: string): string {
  return "hook:" + crypto.createHash("sha256").update(`${event}\0${norm}`, "utf8").digest("hex").slice(0, 10);
}

/** 실행에 쓰는 경로(command·args·cwd) 가운데 이 PC 에 없는 것. env 의 경로는 서버가 만들 데이터 폴더일 수 있어 보지 않는다. */
function deadServer(name: string, server: unknown, alive: ExistsFn = pexists): string[] {
  return mcpRefs(name, server).filter(([, , field]) => !field.startsWith("env.")).flatMap(([, , , s, lists]) => dead(s, lists, alive));
}

// ----- 수집 -----

export interface Item {
  id: string;
  category: string;
  strategy: string;
  rel?: string;
  key?: string;
  hash: string;
  size: number;
  files: number;
  secrets?: string[];
  project?: string;
  _src?: string;
  _json?: unknown;
}

interface External { kind: string; path: string; token: string; exists: boolean; owners: string[]; scopes: string[]; fields: string[] }

const pub = <T extends object>(o: T): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));

export class Collector {
  readonly store: string;
  readonly optional: Set<string>;
  readonly includeSecrets: boolean;
  readonly desktopDir: string;
  readonly desktopConfig: string;
  readonly tokens: Token[];
  items: Item[] = [];
  skipped: { id: string; reason: string }[] = [];
  refs: [string, string, string, string, string][] = [];   // (kind, owner, scope, field, tokenized path)
  secrets: Record<string, Record<string, string>> = {};    // item id -> {path: value}
  warnings: string[] = [];
  plugins: Obj = {};
  external: External[] = [];

  constructor(store: string, optional: Iterable<string> = [], includeSecrets = false) {
    this.store = store;
    this.optional = new Set(optional);
    this.includeSecrets = includeSecrets;
    this.desktopDir = paths.resolveDesktopDir();
    this.desktopConfig = pjoin(this.desktopDir, paths.DESKTOP_CONFIG_NAME);
    this.tokens = makeTokens(this.desktopDir);
  }

  rel(p: string): string {
    return tokenize(p, this.tokens).replace(/\\/g, "/");
  }

  addFile(cat: string, iid: string, p: string): void {
    const data = fs.readFileSync(p);
    this.items.push({ id: iid, category: cat, strategy: "file", rel: this.rel(p), hash: sha(data), size: data.length, files: 1, _src: p });
  }

  addTree(cat: string, iid: string, p: string, extra: Obj = {}): void {
    const [rows, size] = treeRows(p);
    this.items.push({ id: iid, category: cat, strategy: "tree", rel: this.rel(p), hash: treeDigest(rows), size, files: rows.length, ...extra, _src: p });
    if (size > SIZE_WARN) {
      this.warnings.push(`${dispId(iid)}: ${Math.floor(size / (1024 * 1024))}MB, over ${Math.floor(SIZE_WARN / (1024 * 1024))}MB`);
    }
  }

  addJson(cat: string, iid: string, key: string, obj: unknown, refs: (o: unknown) => Ref[]): void {
    const [o, found] = prepareJson(cat, iid, obj, this.tokens);
    if (Object.keys(found).length) this.secrets[iid] = found;
    const c = canon(o);
    this.items.push({ id: iid, category: cat, strategy: "json-keys", key, hash: sha(Buffer.from(c, "utf8")), size: Buffer.byteLength(c, "utf8"),
      files: 0, secrets: sortStr(Object.keys(found)), _json: o });
    for (const [kind, owner, field, s, lists] of refs(o)) {
      for (const p of findPaths(s, lists)) this.refs.push([kind, owner, cat, field, p]);
    }
  }

  collect(): this {
    this.treesAndFiles();
    this.memories();
    this.settings();
    this.mcp();
    this.storeCfg();
    this.resolveRefs();
    return this;
  }

  private treesAndFiles(): void {
    for (const [cat, sub, , dirsOnly] of TREE_CATS) {
      const d = pjoin(CLAUDE_HOME(), sub);
      if (!isdir(d)) continue;
      for (const name of sortStr(fs.readdirSync(d))) {
        const full = pjoin(d, name);
        if (name.startsWith(".")) continue;
        if (cat === "cc.skills" && paths.RESERVED_SKILL_DIRS.includes(name)) {
          this.skipped.push({ id: `${cat}/${name}`, reason: "claude.ai account sync folder" });
          continue;
        }
        if (isdir(full)) this.addTree(cat, `${cat}/${name}`, full);
        else if (!dirsOnly) this.addFile(cat, `${cat}/${name}`, full);
      }
    }
    for (const [cat, fn] of FILE_CATS) {
      const p = pjoin(CLAUDE_HOME(), fn);
      if (isfile(p)) this.addFile(cat, cat, p);
    }
  }

  /**
   * 기본 제외. 프로젝트 메모리 폴더 이름은 프로젝트 경로를 인코딩한 것이라 대상 PC 에서 다시
   * 인코딩해야 한다 - 원래 경로를 ~/.claude.json 의 projects 에서 찾아 project 로 남긴다.
   */
  private memories(): void {
    if (this.optional.has("cc.agent-memory")) {
      const d = pjoin(CLAUDE_HOME(), "agent-memory");
      for (const name of isdir(d) ? sortStr(fs.readdirSync(d)) : []) {
        if (!name.startsWith(".") && isdir(pjoin(d, name))) this.addTree("cc.agent-memory", `cc.agent-memory/${name}`, pjoin(d, name));
      }
    }
    if (!this.optional.has("cc.project-memory")) return;
    let projects: unknown;
    try {
      projects = or(get(load(CLAUDE_JSON()), "projects"), {});
    } catch (e) {
      if (!(isOSError(e) || isValueError(e) || (e instanceof PyError && e.name === "AttributeError"))) throw e;
      projects = {};
    }
    const known = new Map<string, string>();
    for (const pp of iter(projects)) known.set(encodeProjectDir(String(pp)), String(pp));
    const d = pjoin(CLAUDE_HOME(), "projects");
    for (const enc of isdir(d) ? sortStr(fs.readdirSync(d)) : []) {
      const mem = pjoin(d, enc, "memory");
      if (!isdir(mem)) continue;
      if (!known.has(enc)) {
        this.skipped.push({ id: `cc.project-memory/${enc}`, reason: "Unknown project for this memory (no path in ~/.claude.json)" });
        continue;
      }
      this.addTree("cc.project-memory", `cc.project-memory/${enc}`, mem, { project: this.rel(known.get(enc)!) });
    }
  }

  private settings(): void {
    const sp = pjoin(CLAUDE_HOME(), "settings.json");
    if (isfile(sp)) {
      let obj = load(sp);
      const prof = cas.ignoreProfile({}, sp);
      if (prof) obj = cas.stripKeys(obj, prof.rules, prof.keep);
      obj = this.pluginDecls(obj);
      this.addJson("cc.settings", "cc.settings", "settings.json", obj, settingsRefs);
    }
    const lp = pjoin(CLAUDE_HOME(), "settings.local.json");
    if (isfile(lp)) {
      if (this.optional.has("cc.settings-local")) this.addJson("cc.settings-local", "cc.settings-local", "settings.local.json", load(lp), settingsRefs);
      else this.skipped.push({ id: "cc.settings-local", reason: "Excluded by default (include with --with-optional local)" });
    }
  }

  /**
   * enabledPlugins 를 대상 PC 에서 그대로 쓸 수 있게 다듬는다.
   * - 원장에 없는 마켓 플러그인 키는 뺀다(대상에서 설치 실패로 남는다). @builtin·@inline 은 원장에 오지
   *   않는 종류라 남긴다.
   * - user 스코프로 설치됐는데 키가 없는 플러그인은 true 를 명시한다. 대상은 선언된 키만 받아 온다.
   * - 쓰는 마켓이 extraKnownMarketplaces 에 없으면 known_marketplaces.json 의 source 로 보탠다.
   */
  private pluginDecls(obj: unknown): unknown {
    const pdir = pjoin(CLAUDE_HOME(), "plugins");
    const installed = pluginState.readInstalled(pdir);
    const enabled: Obj = { ...(or(get(obj, "enabledPlugins"), {}) as Obj) };
    const kinds: Record<string, string[]> = { market: [], builtin: [], inline: [] };
    const dropped: string[] = [], added: string[] = [];
    for (const pid of Object.keys(enabled)) {
      const market = pluginState.splitId(pid)[1];
      if (market === "builtin" || market === "inline") kinds[market].push(pid);
      else if (Object.hasOwn(installed, pid)) kinds.market.push(pid);
      else {
        dropped.push(pid);
        delete enabled[pid];
        this.skipped.push({ id: `cc.plugins/${pid}`, reason: "Plugin declaration with no install record" });
      }
    }
    for (const pid of sortStr(Object.keys(installed))) {
      const rec = installed[pid] as unknown as Obj;
      const scopes = iter(or(get(rec, "scopes"), [get(rec, "scope")]));
      if (!Object.hasOwn(enabled, pid) && scopes.includes("user")) {
        put(enabled, pid, true);
        added.push(pid);
        kinds.market.push(pid);
      }
    }
    const ekm: Obj = { ...(or(get(obj, "extraKnownMarketplaces"), {}) as Obj) };
    let known: unknown;
    try {
      known = load(pjoin(pdir, "known_marketplaces.json"));
    } catch (e) {
      if (!(isOSError(e) || isValueError(e))) throw e;
      known = {};
    }
    const marketsAdded: string[] = [];
    for (const pid of kinds.market) {
      const m = pluginState.splitId(pid)[1];
      if (m && !Object.hasOwn(ekm, m) && isObj(get(or(get(known, m), {}), "source"))) {
        put(ekm, m, { source: (get(known, m) as Obj).source });
        marketsAdded.push(m);
      }
    }
    this.plugins = {
      declared: Object.values(kinds).reduce((n, v) => n + v.length, 0),
      ...Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, sortStr(v)])),
      added_explicit: added, dropped, markets_added: marketsAdded,
    };
    const out: Obj = { ...(obj as Obj) };
    if (Object.keys(enabled).length || Object.hasOwn(out, "enabledPlugins")) out.enabledPlugins = enabled;
    if (Object.keys(ekm).length) out.extraKnownMarketplaces = ekm;
    return out;
  }

  private mcp(): void {
    const sources: [string, string][] = [["cc.mcp-user", CLAUDE_JSON()], ["desk.mcp", this.desktopConfig]];
    for (const [cat, p] of sources) {
      if (!isfile(p)) continue;
      let servers: unknown;
      try {
        servers = or(get(load(p), "mcpServers"), {});
      } catch (e) {
        if (!(isOSError(e) || isValueError(e))) throw e;
        this.warnings.push(`${LABELS[cat]}: could not read ${p}`);
        continue;
      }
      for (const [name, server] of items(servers).sort((a, b) => cmp(a[0], b[0]))) {
        if (isObj(server)) this.addJson(cat, `${cat}/${name}`, `mcpServers.${name}`, server, (o) => mcpRefs(name, o));
      }
    }
  }

  private storeCfg(): void {
    let cfg: unknown;
    try {
      cfg = libStore.loadCfg(this.store);
    } catch (e) {
      if (!(isOSError(e) || isValueError(e))) throw e;
      cfg = {};
    }
    if (!truthy(cfg)) {
      this.skipped.push({ id: "cm.store", reason: `No store settings: ${this.store}` });
      return;
    }
    const pick = (r: unknown, keys: string[]) => Object.fromEntries(keys.map((k) => [k, get(r, k)]));
    const obj = {
      libraries: or(get(cfg, "libraries"), []),
      remotes: iter(or(get(cfg, "remotes"), [])).filter(isObj).map((r) => pick(r, STORE_REMOTE_KEYS)),
      marketplaces: iter(or(get(cfg, "marketplaces"), [])).filter(isObj).map((m) => pick(m, STORE_MARKET_KEYS)),
      ui: or(get(cfg, "ui"), {}),
    };
    const refs = (o: unknown): Ref[] => iter(or(get(o, "libraries"), []))
      .map((lib, i) => [lib, i] as const).filter(([lib]) => typeof lib === "string")
      .map(([lib, i]) => ["library", lib as string, `libraries[${i}]`, lib as string, false]);
    this.addJson("cm.store", "cm.store", "config.json", obj, refs);
  }

  /** ${CLAUDE_HOME} 안을 가리키면 번들에 넣고(이미 들어간 항목 안이면 그대로), 나머지는 external. */
  resolveRefs(): void {
    const bundled = this.items.filter((it) => it._src !== undefined).map((it) => it._src!);
    const inside = (p: string) => bundled.some((s) => normcase(p) === normcase(s) || normcase(p).startsWith(normcase(s) + SEP));
    const ext = new Map<string, External>();
    for (const [kind, owner, scope, field, tp] of this.refs) {
      const local = normDisp(paths.expanduser(detokenize(tp, this.tokens)));
      if (TOKEN_NAMES.has(rstripChars(tp, "\\/"))) continue;   // 홈·Desktop 폴더 자체는 대상 PC 에서 토큰으로 다시 풀린다
      if (tp.startsWith("${CLAUDE_HOME}") && exists(local)) {
        if (!inside(local)) {
          const iid = "cc.refs/" + relpath(local, CLAUDE_HOME()).split(SEP).join("/");
          if (isdir(local)) this.addTree("cc.refs", iid, local);
          else this.addFile("cc.refs", iid, local);
          bundled.push(local);
        }
        continue;
      }
      const k = `${kind}\0${normcase(local)}`;
      let e = ext.get(k);
      if (!e) {
        e = { kind, path: local, token: tp, exists: exists(local), owners: [], scopes: [], fields: [] };
        ext.set(k, e);
      }
      if (!e.owners.includes(owner)) e.owners.push(owner);
      if (!e.scopes.includes(scope)) e.scopes.push(scope);
      e.fields.push(`${scope}:${field}`);
    }
    this.external = [...ext.values()].sort((a, b) =>
      EXT_ORDER.indexOf(a.kind) - EXT_ORDER.indexOf(b.kind) || cmp(a.path.toLowerCase(), b.path.toLowerCase()));
  }

  counts(): Record<string, number> {
    const c: Record<string, number> = {};
    for (const it of this.items) c[it.category] = (c[it.category] ?? 0) + 1;
    return c;
  }

  /** 영어 화면은 이 줄 대신 src/ui/transfer.ts reportLines 가 같은 구성으로 그린다. */
  report(outPath: string | null = null): string[] {
    const lines = [outPath ? `Export result: ${outPath}` : "Items to carry"];
    const counts = this.counts();
    const order = [...TREE_CATS.map(([c]) => c), ...FILE_CATS.map(([c]) => c),
      "cc.project-memory", "cc.agent-memory", "cc.refs", "cc.settings", "cc.settings-local", "cc.mcp-user", "desk.mcp", "cm.store"];
    for (const cat of order) {
      if (counts[cat]) lines.push(SINGLE.has(cat) ? `- ${LABELS[cat]}` : `- ${LABELS[cat]}: ${counts[cat]}`);
    }
    const p = this.plugins as Record<string, any>;
    if (truthy(p)) {
      lines.push(`- Plugin declarations ${p.declared} (marketplace ${p.market.length}, built-in ${p.builtin.length}, ` +
        `inline ${p.inline.length}); Claude Code on the new PC downloads them on its next start`);
      if (p.added_explicit.length) lines.push(`  - Set true for installed plugins that had no declaration: ${p.added_explicit.join(", ")}`);
      if (p.dropped.length) lines.push(`  - Dropped declarations with no install record: ${p.dropped.join(", ")}`);
    }
    const sec = Object.entries(this.secrets).flatMap(([iid, d]) => Object.keys(d).map((k) => [iid, k]));
    if (sec.length) {
      lines.push(this.includeSecrets
        ? `- ${sec.length} secrets written to secrets.json as plain text (take care if the bundle sits in a shared folder)`
        : `- ${sec.length} secrets left out as placeholders (enter them on the new PC)`);
      lines.push(...sec.map(([iid, k]) => `  - ${dispId(iid)}: ${k}`));
    }
    if (this.external.length) {
      lines.push("- Not bundled (prepare these at the same paths on the new PC)");
      for (const kind of EXT_ORDER) {
        const rows = this.external.filter((e) => e.kind === kind);
        if (!rows.length) continue;
        lines.push(`  - ${EXT_LABELS[kind]}`);
        const disp = (e: External) => e.path + (e.exists ? "" : " [missing on this PC too]");
        if (kind === "mcp") {
          // 서버 하나가 실행 파일·데이터 폴더를 여럿 가리킨다 - 서버 단위로 모은다.
          const by = new Map<string, { name: string; scopes: string[]; paths: string[] }>();
          for (const e of rows) {
            for (const o of e.owners) {
              let g = by.get(o.toLowerCase());
              if (!g) {
                g = { name: o, scopes: [], paths: [] };
                by.set(o.toLowerCase(), g);
              }
              g.paths.push(disp(e));
              g.scopes.push(...e.scopes.filter((s) => !g!.scopes.includes(s)));
            }
          }
          for (const g of [...by.values()].sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()))) {
            const where = [...g.scopes].sort((a, b) => SCOPE_ORDER.indexOf(a) - SCOPE_ORDER.indexOf(b)).map((s) => SCOPE_LABELS[s]).join(", ");
            lines.push(`    - ${g.name} (${where}): ${g.paths.join(", ")}`);
          }
        } else if (kind === "plugin-dirs" || kind === "library") {
          lines.push(...rows.map((e) => `    - ${disp(e)}`));
        } else {
          lines.push(...rows.map((e) => `    - ${disp(e)} (${e.owners.join(", ")})`));
        }
      }
    }
    if (this.skipped.length) {
      lines.push(`- Skipped ${this.skipped.length}`);
      lines.push(...this.skipped.map((s) => `  - ${dispId(s.id)}: ${s.reason}`));
    }
    if (this.warnings.length) {
      lines.push("- Warnings");
      lines.push(...this.warnings.map((w) => `  - ${w}`));
    }
    return lines;
  }

  manifest(): Obj {
    return {
      format: FORMAT, version: VERSION,
      created: nowIso(),
      source: { host: os.hostname(), os: process.platform, home: HOME(), claude_home: CLAUDE_HOME(), desktop_dir: this.desktopDir },
      tokens: Object.fromEntries(this.tokens.map(([tok, base]) => [tok, base])),
      items: this.items.map(pub),
      skipped: this.skipped,
      plugins: this.plugins,
      external: this.external,
    };
  }
}

const SINGLE = new Set(["cc.claude-md", "cc.keybindings", "cc.settings", "cc.settings-local", "cm.store"]);
const EXT_ORDER = ["mcp", "hook", "statusline", "plugin-dirs", "env", "library"];
const EXT_LABELS: Record<string, string> = {
  mcp: "MCP servers", hook: "Hooks", statusline: "statusLine",
  "plugin-dirs": "Plugin folders (CLAUDE_CODE_PLUGIN_DIRS)", env: "settings env",
  library: "config-monitor libraries",
};
const SCOPE_LABELS: Record<string, string> = { "cc.mcp-user": "Claude Code", "desk.mcp": "Desktop" };
const SCOPE_ORDER = Object.keys(SCOPE_LABELS);
const TOKEN_NAMES = new Set(["${HOME}", "${CLAUDE_HOME}", "${DESKTOP_DIR}"]);

/** 보고용: 'cc.mcp-user/remote-memory' -> 'MCP 서버 (Claude Code) remote-memory'. */
export function dispId(iid: string): string {
  const i = iid.indexOf("/");
  const cat = i < 0 ? iid : iid.slice(0, i), name = i < 0 ? "" : iid.slice(i + 1);
  const label = LABELS[cat] || (cat === "cc.plugins" ? "Plugin declaration" : cat);
  return stripWs(`${label} ${name}`);
}

/** os.path.relpath(p, start). 둘 다 절대경로로 바꾼 뒤 공통 조상부터 센다. */
function relpath(p: string, start: string): string {
  const [sd, , sr] = splitroot(abspath(start));
  const [pd, , pr] = splitroot(abspath(p));
  if (normcase(sd) !== normcase(pd)) throw new PyError("ValueError", `path is on mount '${pd}', start on mount '${sd}'`);
  const sl = sr ? sr.split(SEP) : [], pl = pr ? pr.split(SEP) : [];
  let i = 0;
  while (i < Math.min(sl.length, pl.length) && normcase(sl[i]) === normcase(pl[i])) i++;
  const rel = [...Array(sl.length - i).fill(".."), ...pl.slice(i)];
  return rel.length ? pjoin(rel[0], ...rel.slice(1)) : ".";
}

// ----- zip (zipfile.ZipFile 의 ZIP_DEFLATED 쓰기·읽기 중 번들이 쓰는 부분) -----
// 새 npm 의존성 없이 옮겼다. Python zipfile 이 읽을 수 있고 Python 이 쓴 번들을 읽는다.
// ZIP64(4GiB 이상)와 암호화는 다루지 않는다.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): [number, number] {
  if (d.getFullYear() < 1980) throw new PyError("ValueError", "ZIP does not support timestamps before 1980");
  return [(d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()];
}

interface ZipSrc { name: string; data: Buffer; date: Date; attr: number }

/** zipfile.ZipFile(path, "w", ZIP_DEFLATED) 에 차례로 쓴 것과 같은 구조. */
export function writeZip(file: string, entries: ZipSrc[]): void {
  const chunks: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  const createSystem = WIN ? 0 : 3;
  for (const e of entries) {
    const ascii = /^[\x00-\x7f]*$/.test(e.name);
    const nameBuf = Buffer.from(e.name, "utf8");
    const flags = ascii ? 0 : 0x800;
    const comp = zlib.deflateRawSync(e.data);
    const crc = crc32(e.data);
    const [t, d] = dosTime(e.date);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt8(20, 4); lh.writeUInt8(0, 5); lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(t, 10); lh.writeUInt16LE(d, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt8(20, 4); cd.writeUInt8(createSystem, 5); cd.writeUInt8(20, 6); cd.writeUInt8(0, 7);
    cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(8, 10); cd.writeUInt16LE(t, 12); cd.writeUInt16LE(d, 14); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(e.data.length, 24); cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(e.attr >>> 0, 38); cd.writeUInt32LE(off, 42);
    chunks.push(lh, nameBuf, comp);
    central.push(cd, nameBuf);
    off += lh.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16); end.writeUInt16LE(0, 20);
  fs.writeFileSync(file, Buffer.concat([...chunks, cdBuf, end]));
}

const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** zipfile.is_zipfile: 끝 레코드가 있는가. */
export function isZipfile(file: string): boolean {
  try {
    const buf = fs.readFileSync(file);
    return buf.length >= 22 && findEocd(buf) >= 0;
  } catch {
    return false;
  }
}

class BadZipFile extends PyError {
  constructor(message: string) {
    super("BadZipFile", message);
  }
}

/** zipfile.ZipFile(path) 의 namelist / NameToInfo / read. */
export class ZipReader {
  private buf: Buffer;
  readonly names: string[] = [];
  private info = new Map<string, { method: number; csize: number; usize: number; crc: number; offset: number }>();

  constructor(file: string) {
    this.buf = fs.readFileSync(file);
    const eocd = findEocd(this.buf);
    if (eocd < 0) throw new BadZipFile("File is not a zip file");
    const count = this.buf.readUInt16LE(eocd + 10);
    let p = this.buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      if (this.buf.readUInt32LE(p) !== 0x02014b50) throw new BadZipFile("Bad magic number for central directory");
      const flags = this.buf.readUInt16LE(p + 8), method = this.buf.readUInt16LE(p + 10);
      const crc = this.buf.readUInt32LE(p + 16), csize = this.buf.readUInt32LE(p + 20), usize = this.buf.readUInt32LE(p + 24);
      const nlen = this.buf.readUInt16LE(p + 28), xlen = this.buf.readUInt16LE(p + 30), clen = this.buf.readUInt16LE(p + 32);
      const offset = this.buf.readUInt32LE(p + 42);
      const raw = this.buf.subarray(p + 46, p + 46 + nlen);
      let name = flags & 0x800 ? raw.toString("utf8") : [...raw].map((b) => (b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80])).join("");
      // ZipInfo.__init__: NUL 뒤를 버리고 Windows 에서는 역슬래시를 '/' 로 바꾼다.
      const nul = name.indexOf("\0");
      if (nul >= 0) name = name.slice(0, nul);
      if (WIN) name = name.replace(/\\/g, "/");
      this.names.push(name);
      this.info.set(name, { method, csize, usize, crc, offset });
      p += 46 + nlen + xlen + clen;
    }
  }

  has(name: string): boolean {
    return this.info.has(name);
  }

  /** 없는 이름은 Python 처럼 KeyError. */
  read(name: string): Buffer {
    const z = this.info.get(name);
    if (!z) throw new PyError("KeyError", `There is no item named '${name}' in the archive`);
    const o = z.offset;
    if (this.buf.readUInt32LE(o) !== 0x04034b50) throw new BadZipFile("Bad magic number for file header");
    const start = o + 30 + this.buf.readUInt16LE(o + 26) + this.buf.readUInt16LE(o + 28);
    const comp = this.buf.subarray(start, start + z.csize);
    let data: Buffer;
    if (z.method === 0) data = Buffer.from(comp);
    else if (z.method === 8) data = zlib.inflateRawSync(comp);
    else throw new PyError("NotImplementedError", "That compression method is not supported");
    if (crc32(data) !== z.crc) throw new BadZipFile(`Bad CRC-32 for file '${name}'`);
    return data;
  }
}

// ----- 번들 쓰기 -----

type Entry = [string, Buffer | string];

/** (번들 안 상대경로, bytes 또는 원본 파일 경로). */
function* bundleEntries(col: Collector, includeSecrets: boolean, mbytes: Buffer): Generator<Entry> {
  yield ["manifest.json", mbytes];
  yield ["report.json", dumps2({ lines: col.report(), external: col.external, skipped: col.skipped })];
  for (const it of col.items) {
    if (it.strategy === "json-keys") yield [`json/${it.id}.json`, dumps2(it._json)];
    else if (it.strategy === "file") yield [`files/${it.rel}`, it._src!];
    else {
      for (const w of walk(it._src!)) {
        for (const fn of w.files) yield [`files/${it.rel}/${[...w.rel, fn].join("/")}`, pjoin(w.root, fn)];
      }
    }
  }
  if (includeSecrets && Object.keys(col.secrets).length) yield ["secrets.json", dumps2(col.secrets)];
}

/** ZipInfo.from_file 의 arcname 정규화(드라이브·앞 구분자를 떼고 normpath, '/' 로). */
function arcname(name: string): string {
  let a = lstripChars(normpath(splitdrive(name)[1]), WIN ? "\\/" : "/");
  if (WIN) a = a.replace(/\\/g, "/");
  return a;
}

/** 번들 해시(= manifest 바이트 해시, import 의 plan_id 와 같은 기준)를 돌려준다. */
export function writeBundle(col: Collector, out: string, includeSecrets: boolean): string {
  const tmp = `${out}.${process.pid}.tmp`;
  const mbytes = dumps2(col.manifest());
  try {
    if (out.toLowerCase().endsWith(".cmbundle")) {
      const now = new Date();
      const entries: ZipSrc[] = [];
      for (const [name, src] of bundleEntries(col, includeSecrets, mbytes)) {
        if (Buffer.isBuffer(src)) entries.push({ name: WIN ? name.replace(/\\/g, "/") : name, data: src, date: now, attr: (0o600 << 16) >>> 0 });
        else {
          const st = fs.statSync(src);
          entries.push({ name: arcname(name), data: fs.readFileSync(src), date: st.mtime, attr: ((st.mode & 0xffff) << 16) >>> 0 });
        }
      }
      writeZip(tmp, entries);
    } else {
      for (const [name, src] of bundleEntries(col, includeSecrets, mbytes)) {
        const dst = pjoin(tmp, ...name.split("/"));
        fs.mkdirSync(dirname(dst), { recursive: true });
        if (Buffer.isBuffer(src)) fs.writeFileSync(dst, src);
        else fs.writeFileSync(dst, fs.readFileSync(src));
      }
    }
    fs.renameSync(tmp, out);
    return sha(mbytes);
  } catch (e) {
    if (isdir(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    else if (exists(tmp)) fs.rmSync(tmp);
    throw e;
  }
}

// ----- 번들 읽기 -----

export class BundleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BundleError";
    this.code = code;
  }
}

/** 번들은 공유 폴더에서 오는 입력이다. 상대 이동·드라이브·역슬래시가 섞인 이름은 받지 않는다. */
export function safeMember(name: string): string[] {
  const parts = name.split("/");
  if (!name || name.includes("\\") || parts.some((p) => p === "" || p === "." || p === ".." || p.includes(":"))) {
    throw new BundleError("bundle_invalid", `Invalid path inside the bundle: ${name}`);
  }
  return parts;
}

export class Bundle {
  readonly path: string;
  private zip: ZipReader | null = null;
  readonly manifest: Obj;
  readonly hash: string;
  readonly secrets: unknown;

  constructor(p: string) {
    this.path = abspath(p);
    if (isfile(this.path) && isZipfile(this.path)) this.zip = new ZipReader(this.path);
    else if (!isdir(this.path)) throw new BundleError("bundle_invalid", `Not a bundle (must be a folder or a .cmbundle zip): ${this.path}`);
    const raw = this.read("manifest.json");
    let m: unknown;
    try {
      m = libStore.pyLoads(libStore.decodeUtf8SigStrict(raw));
    } catch (e) {
      if (!isValueError(e)) throw e;
      throw new BundleError("bundle_invalid", `Could not read manifest.json: ${(e as Error).message}`);
    }
    if (!isObj(m) || m.format !== FORMAT) throw new BundleError("bundle_invalid", `Not a cmbundle manifest: ${this.path}`);
    if (!pyEq(m.version ?? null, VERSION)) throw new BundleError("bundle_version", `Cannot read bundle version ${pyStr(m.version ?? null)} (supported: ${VERSION})`);
    this.manifest = m;
    this.hash = sha(raw);
    this.secrets = this.exists("secrets.json") ? this.json("secrets.json", NO_FLOATS) : {};
  }

  private fsPath(name: string): string {
    return pjoin(this.path, ...safeMember(name));
  }

  exists(name: string): boolean {
    if (this.zip) {
      safeMember(name);
      return this.zip.has(name);
    }
    return isfile(this.fsPath(name));
  }

  read(name: string): Buffer {
    try {
      if (this.zip) {
        safeMember(name);
        return this.zip.read(name);
      }
      return fs.readFileSync(this.fsPath(name));
    } catch (e) {
      if ((e instanceof PyError && e.name === "KeyError") || errCode(e) === "ENOENT") throw new BundleError("bundle_invalid", `Not in the bundle: ${name}`);
      throw e;
    }
  }

  json(name: string, opts: libStore.LoadsOptions = FLOATS): unknown {
    try {
      return libStore.pyLoads(libStore.decodeUtf8SigStrict(this.read(name)), opts);
    } catch (e) {
      if (!isValueError(e)) throw e;
      throw new BundleError("bundle_invalid", `Could not read ${name}: ${(e as Error).message}`);
    }
  }

  /** [(트리 안 상대경로, bytes)]. */
  tree(rel: string): [string, Buffer][] {
    const pref = `files/${rel}/`;
    let names: string[];
    if (this.zip) names = this.zip.names.filter((n) => n.startsWith(pref) && !n.endsWith("/"));
    else {
      const base = this.fsPath(`files/${rel}`);
      names = [];
      for (const w of walk(base)) names.push(...w.files.map((fn) => pref + [...w.rel, fn].join("/")));
    }
    return names.map((n) => {
      safeMember(n.slice(pref.length));
      return [n.slice(pref.length), this.read(n)] as [string, Buffer];
    });
  }
}

// ----- import plan -----

const PH = /^\$\{CM_SECRET:([^:}]+):([^}]*)\}\n?$/;
const DIFF_MAX = 400;
const STORE_KEYS = ["libraries", "remotes", "marketplaces", "ui"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\n?$/;
// cc.refs 가 쓰면 안 되는 ~/.claude 바로 아래 이름. 설정 파일은 병합 경로로만 바꾸고 상태 폴더는 건드리지 않는다.
const REF_DENY = new Set(["settings.json", "settings.local.json", "plugins", "projects", "backups", "history.jsonl"]);
const CAT_SUB = new Map(TREE_CATS.map(([c, sub, , d]) => [c, [sub, d] as [string, boolean]]));
const CAT_FILE = new Map(FILE_CATS.map(([c, fn]) => [c, fn]));

function readBytes(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch (e) {
    if (["ENOENT", "EISDIR", "EACCES", "EPERM"].includes(errCode(e) ?? "")) return null;
    throw e;
  }
}

function textDiff(a: Uint8Array | null, b: Uint8Array | null): string[] {
  const ea = a ?? Buffer.alloc(0), eb = b ?? Buffer.alloc(0);
  if (ea.includes(0) || eb.includes(0)) return ["(binary file)"];
  const lines = cas.unifiedDiff(cas.diffLines(ea), cas.diffLines(eb), "current", "bundle", 2, "");
  return [...lines.slice(0, DIFF_MAX), ...(lines.length > DIFF_MAX ? [`... ${lines.length - DIFF_MAX} lines omitted`] : [])];
}

function jsonDiff(a: unknown, b: unknown): string[] {
  return textDiff(dumps2(a, true), dumps2(b, true));
}

/** 자리표시자를 값으로 바꾼다. sources 는 {item id: {경로: 값}} 목록이고 앞쪽이 우선. 못 푼 경로도 돌려준다. */
export function resolveSecrets(obj: unknown, sources: unknown[]): [unknown, string[]] {
  const missing: string[] = [];
  const fn = (s: string): string => {
    const m = PH.exec(s);
    if (!m) return s;
    for (const src of sources) {
      const v = get(or(get(src, m[1]), {}), m[2]);
      if (typeof v === "string") return v;
    }
    missing.push(m[2]);
    return s;
  };
  return [mapStrings(obj, fn), missing];
}

function isHookEntry(x: unknown): x is Obj & { hooks: unknown[] } {
  return isObj(x) && Array.isArray(x.hooks);
}

function entryKey(x: Obj): string {
  return canon(Object.fromEntries(Object.entries(x).filter(([k]) => k !== "hooks")));
}

/**
 * 배열은 합집합(대상 순서 유지). 훅 항목은 matcher 가 같으면 한 항목 안에서 hooks 를 합친다 -
 * 따로 붙이면 같은 훅이 두 번 돈다.
 */
export function union(cur: unknown[], inc: unknown[]): unknown[] {
  const out = [...cur];
  for (const x of inc) {
    if (out.some((y) => canon(x) === canon(y))) continue;
    if (isHookEntry(x)) {
      const j = out.findIndex((y) => isHookEntry(y) && entryKey(y) === entryKey(x));
      if (j >= 0) {
        const y = out[j] as Obj & { hooks: unknown[] };
        out[j] = { ...y, hooks: union(y.hooks, x.hooks) };
        continue;
      }
    }
    out.push(x);
  }
  return out;
}

/** 객체는 키 단위, 배열은 합집합, 스칼라가 다르면 take(path) 가 참일 때만 번들 값. */
export function merge(cur: unknown, inc: unknown, take: (p: string) => boolean, conflicts: string[], path = ""): unknown {
  if (isObj(cur) && isObj(inc)) {
    const out: Obj = { ...cur };
    for (const [k, v] of Object.entries(inc)) {
      const sub = path ? `${path}.${k}` : k;
      put(out, k, Object.hasOwn(cur, k) ? merge(cur[k], v, take, conflicts, sub) : v);
    }
    return out;
  }
  if (Array.isArray(cur) && Array.isArray(inc)) return union(cur, inc);
  if (pyEq(cur, inc)) return cur;
  conflicts.push(path);
  return take(path) ? inc : cur;
}

/** 경로 표기(대소문자·구분자·겹친 구분자)만 다른 값은 같은 값이다. */
function sameVal(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a === b || normCmd(a) === normCmd(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameVal(x, b[i]));
  return pyEq(a, b);
}

/**
 * 이 PC 에서 동작 중인 MCP 서버에 번들 서버를 합친다. 이 PC 에만 있는 키(env 포함)는 남기고, 번들에만 있는
 * 키는 더하고, 둘 다 있는데 다르면 conflicts 에 올리고 take(path) 일 때만 번들 값. 통째로 바꾸면
 * 이 PC 에만 있는 env(라이브러리 폴더 등)가 사라진다.
 */
export function mergeServer(cur: Obj, inc: Obj, take: (p: string) => boolean, conflicts: string[]): Obj {
  const out: Obj = { ...cur };
  for (const [k, v] of Object.entries(inc)) {
    if (!Object.hasOwn(cur, k)) put(out, k, v);
    else if (k === "env" && isObj(cur[k]) && isObj(v)) {
      const env: Obj = { ...(cur[k] as Obj) };
      for (const [ek, ev] of Object.entries(v)) {
        if (!Object.hasOwn(env, ek)) put(env, ek, ev);
        else if (!sameVal(env[ek], ev)) {
          conflicts.push(`env.${ek}`);
          if (take(`env.${ek}`)) put(env, ek, ev);
        }
      }
      out[k] = env;
    } else if (!sameVal(cur[k], v)) {
      conflicts.push(k);
      if (take(k)) put(out, k, v);
    }
  }
  return out;
}

function chooser(choice: unknown): (p: string) => boolean {
  if (isObj(choice)) return (p) => get(choice, p) === "take";
  return () => choice === "take";
}

/**
 * libraries 는 경로 합집합. remotes·marketplaces 는 대상에 없는 id 만 보태고 캐시는 이 PC 스토어
 * 자리로 둔다(라이브러리 fetch 가 그 자리에 받는다). ui 는 일반 병합. [병합 결과, 새로 보탠 origin].
 */
function mergeStore(cur: Obj, inc: Obj, store: string, take: (p: string) => boolean, conflicts: string[]): [Obj, string[]] {
  const libs = [...iter(or(cur.libraries, []))];
  const seen = new Set(libs.filter((x): x is string => typeof x === "string").map((x) => libStore.norm(x)));
  for (const x of iter(or(inc.libraries, []))) {
    if (typeof x === "string" && !seen.has(libStore.norm(x))) {
      libs.push(x);
      seen.add(libStore.norm(x));
    }
  }
  const added: string[] = [];
  const rem = [...iter(or(cur.remotes, []))], mks = [...iter(or(cur.marketplaces, []))];
  const haveR = new Set(rem.filter(isObj).map((r) => get(r, "id")));
  const haveM = new Set(mks.filter(isObj).map((m) => get(m, "id")));
  const pick = (r: Obj, keys: string[]) => Object.fromEntries(keys.map((k) => [k, get(r, k)]));
  for (const r of iter(or(inc.remotes, []))) {
    const rid = isObj(r) ? get(r, "id") : null;
    if (typeof rid === "string" && rid && SAFE_ID.test(rid) && !haveR.has(rid)) {
      rem.push({ ...pick(r as Obj, STORE_REMOTE_KEYS), cache: pjoin(store, "lib-cache", "remotes", rid), sha: null, fetched_at: null });
      added.push(`remote:${rid}`);
    }
  }
  for (const m of iter(or(inc.marketplaces, []))) {
    const mid = isObj(m) ? get(m, "id") : null;
    if (typeof mid === "string" && mid && SAFE_ID.test(mid) && !haveM.has(mid)) {
      mks.push({ ...pick(m as Obj, STORE_MARKET_KEYS), cache: null, plugins: [] });
      added.push(`market:${mid}`);
    }
  }
  const ui = merge(or(cur.ui, {}), or(inc.ui, {}), take, conflicts, "ui");
  return [{ libraries: libs, remotes: rem, marketplaces: mks, ui }, added];
}

function mask(cat: string, iid: string, obj: unknown): unknown {
  return isObj(obj) ? prepareJson(cat, iid, obj, null)[0] : obj;
}

class ProjectMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectMissing";
  }
}

type Row = Obj & { id: string; state: string };

interface ExtRow { kind: unknown; owners: unknown; scopes: unknown; fields: unknown; path: string; source_path: unknown; exists: boolean; in_home: boolean; mapped_from?: string }

/**
 * 번들 항목마다 이 PC 의 현재 상태와 비교한다. 아무것도 쓰지 않는다(스냅샷·스토어 초기화 경로도
 * 타지 않는다). 각 항목의 _fp 는 plan 이 읽은 대상 상태의 지문이고 plan_id 가 이를 묶는다.
 */
export class Planner {
  readonly b: Bundle;
  readonly store: string;
  readonly secrets: Obj;
  readonly choices: Obj;
  readonly rootsArg: Obj;                // {from: to | ""} - "" 는 이 루트를 맞추지 않음
  readonly exclude: Set<string>;         // 체크를 끈 훅 id
  readonly desktopDir: string;
  readonly desktopConfig: string;
  readonly tokens: Token[];
  items: Row[] = [];
  warnings: string[] = [];
  external: ExtRow[] = [];
  warningCodes: Obj[] = [];              // warnings 와 같은 순서의 {code, ...} - 화면은 이것으로 번역한다
  pmap = new PathMap([]);
  roots: RootRow[] = [];
  unresolved: Obj[] = [];
  missing: string[] = [];
  explicit: Record<string, string> = {};
  incoming: string[] = [];               // 이 번들이 쓰는 파일·폴더 자리 - 적용하면 생긴다
  readonly sourceKey: string;
  planId = "";
  private files = new Map<string, [unknown, string | null]>();

  constructor(bundle: Bundle, store: string, secrets?: Obj | null, choices?: Obj | null, roots?: Obj | null, exclude?: Iterable<string> | null) {
    this.b = bundle;
    this.store = store;
    this.secrets = secrets || {};
    this.choices = choices || {};
    this.rootsArg = roots || {};
    this.exclude = new Set(exclude ?? []);
    this.desktopDir = paths.resolveDesktopDir();
    this.desktopConfig = pjoin(this.desktopDir, paths.DESKTOP_CONFIG_NAME);
    this.tokens = makeTokens(this.desktopDir);
    const src = or(get(bundle.manifest, "source"), {});
    this.sourceKey = `${pyStrOr(get(src, "host"))}|${pyStrOr(get(src, "home"))}`;
  }

  detok(obj: unknown): unknown {
    return mapStrings(obj, (s) => detokenize(s, this.tokens));
  }

  warn(code: string, msg: string, params: Obj = {}): void {
    this.warnings.push(msg);
    this.warningCodes.push({ code, ...params });
  }

  /** 이 PC 에 있거나, 이 가져오기가 함께 만들 자리(~/.claude 의 훅 스크립트 등)면 산 경로다. */
  alive = (p: string): boolean => pexists(p) || this.incoming.some((t) => under(paths.expanduser(p), t));

  remap(obj: unknown, used?: Set<string>): unknown {
    return mapStrings(obj, (s) => this.pmap.sub(s, used) as string);
  }

  private localLibs(): string[] {
    const libs = (process.env.CLAUDE_CONFIG_LIBRARIES ?? "").split(nodePath.delimiter).map(stripWs).filter((p) => p);
    try {
      libs.push(...iter(or(get(libStore.loadCfg(this.store), "libraries"), [])).filter((x): x is string => typeof x === "string"));
    } catch (e) {
      if (!(isOSError(e) || isValueError(e))) throw e;
    }
    const out: string[] = [];
    for (const x of libs) {                // env 와 스토어에 같은 폴더가 둘 다 있을 수 있다
      if (isdir(x) && !out.some((y) => ncase(x) === ncase(y))) out.push(x);
    }
    return out;
  }

  /**
   * 번들 external 가운데 이 PC 에 없는 경로의 짝을 정한다. 우선순위: 이번 요청의 roots > 저장된 짝
   * (사람·Claude 가 확정한 것) > 추정. 사람이 끈 루트("")는 추정이 다시 채우지 않는다.
   */
  setupPaths(): void {
    const ext: [Obj, string, string][] = [];
    for (const e of iter(or(get(this.b.manifest, "external"), []))) {
      if (isObj(e)) {
        const tok = pyStrOr(or(get(e, "token"), or(get(e, "path"), "")));
        ext.push([e, tok, normDisp(paths.expanduser(detokenize(tok, this.tokens)))]);
      }
    }
    this.missing = ext.filter(([, tok, p]) => !tok.startsWith("${") && !pexists(p)).map(([, , p]) => p);
    let saved: unknown;
    try {
      saved = or(get(or(get(libStore.loadCfg(this.store), "import_roots"), {}), this.sourceKey), {});
    } catch (e) {
      if (!(isOSError(e) || isValueError(e))) throw e;
      saved = {};
    }
    const chosen = new Map<string, [string, string]>();
    for (const [f, v] of items(saved)) {
      if (isObj(v)) chosen.set(normpath(f), [or(get(v, "to"), "") as string, or(get(v, "by"), "user") as string]);
    }
    for (const [f, t] of Object.entries(this.rootsArg)) {
      if (typeof t === "string") {
        chosen.set(normpath(f), [stripWs(t), "user"]);
        this.explicit[normpath(f)] = stripWs(t);
      }
    }
    let report: RootRow[] = [];
    const pairs: [string, string][] = [];
    for (const [f, [t, by]] of chosen) {
      let err: string | null = null;
      if (!isabs(f)) err = "Not an absolute path";
      else if (t && !(isabs(t) && isdir(t))) err = "Folder does not exist on this PC";
      if (err) {
        report.push({ from: f, to: t || null, source: by, error: err });
        delete this.explicit[f];
        continue;
      }
      report.push({ from: f, to: t || null, source: by });
      if (t) pairs.push([f, t]);
    }
    const rest = this.missing.filter((p) => !report.some((r) => !r.error && under(p, r.from)));
    const libs = ext.filter(([e]) => get(e, "kind") === "library").map(([, , p]) => p);
    const inferred = inferRoots(rest, libs, this.localLibs());
    pairs.push(...inferred.map((r) => [r.from, r.to!] as [string, string]));
    report = [...report, ...inferred.map((r) => ({ from: r.from, to: r.to, source: r.source }))];
    this.pmap = new PathMap(pairs);
    // 경로마다 가장 긴 루트 하나에만 센다(겹치는 루트가 같은 경로를 두 번 세지 않게).
    const live = report.filter((r) => !r.error);
    for (const r of live) r.total = r.resolved = 0;
    const orphans: string[] = [];
    for (const p of this.missing) {
      let own: RootRow | null = null;
      for (const r of live) if (under(p, r.from) && (own === null || [...r.from].length > [...own.from].length)) own = r;
      if (own === null) {
        orphans.push(p);
        continue;
      }
      own.total! += 1;
      own.resolved! += own.to && pexists(rebase(p, own.from, own.to)) ? 1 : 0;
    }
    // 짝이 없는 경로는 가장 위의 없는 폴더로 묶어 빈 칸 줄로 낸다 - 사람이나 Claude 가 채울 자리다.
    for (const p of orphans) {
      const top = topMissing(p, pexists) || p;
      let r = report.find((x) => x.source === "none" && ncase(x.from) === ncase(top));
      if (!r) {
        r = { from: top, to: null, source: "none", total: 0, resolved: 0 };
        report.push(r);
      }
      r.total! += 1;
    }
    this.roots = report;
    for (const [e, tok, p] of ext) {
      const q = normDisp(this.pmap.sub(p) as string);
      const row: ExtRow = { kind: get(e, "kind"), owners: get(e, "owners"), scopes: get(e, "scopes"), fields: get(e, "fields"),
        path: q, source_path: get(e, "path"), exists: pexists(q), in_home: tok.startsWith("${") };
      if (ncase(q) !== ncase(p)) row.mapped_from = p;
      this.external.push(row);
    }
    this.unresolved = this.external.filter((e) => !e.exists)
      .map((e) => ({ path: e.path, kind: e.kind, owners: e.owners, source_path: e.source_path, in_home: e.in_home }));
  }

  /** [내용 또는 null, 오류 문구 또는 null]. */
  jsonFile(p: string, opts: libStore.LoadsOptions = FLOATS): [unknown, string | null] {
    if (!this.files.has(p)) {
      try {
        this.files.set(p, isfile(p) ? [load(p, opts), null] : [null, null]);
      } catch (e) {
        if (!(isOSError(e) || isValueError(e))) throw e;
        this.files.set(p, [null, `Could not read target file: ${p} (${(e as Error).message})`]);
      }
    }
    return this.files.get(p)!;
  }

  targetOf(it: Obj): string {
    const cat = get(it, "category"), rel = pyStrOr(or(get(it, "rel"), ""));
    const i = rel.indexOf("/");
    const head = i < 0 ? rel : rel.slice(0, i), tail = i < 0 ? "" : rel.slice(i + 1);
    const bad = new BundleError("bundle_invalid", `${pyStr(get(it, "id"))}: write path is outside the allowed area: ${rel}`);
    if (head !== "${CLAUDE_HOME}" || !tail) throw bad;
    const parts = safeMember(tail);
    let ok: boolean;
    if (typeof cat === "string" && CAT_SUB.has(cat)) {
      const [sub, dirsOnly] = CAT_SUB.get(cat)!;
      ok = parts.length === 2 && parts[0] === sub && !parts[1].startsWith(".") &&
        (cat !== "cc.skills" || !paths.RESERVED_SKILL_DIRS.includes(parts[1])) &&
        (it.strategy === "tree" || !dirsOnly);
    } else if (typeof cat === "string" && CAT_FILE.has(cat)) {
      ok = parts.length === 1 && parts[0] === CAT_FILE.get(cat) && it.strategy === "file";
    } else if (cat === "cc.agent-memory") {
      ok = parts.length === 2 && parts[0] === "agent-memory" && !parts[1].startsWith(".") && it.strategy === "tree";
    } else if (cat === "cc.project-memory") {
      if (!(parts.length === 3 && parts[0] === "projects" && parts[2] === "memory" && it.strategy === "tree" &&
        typeof it.project === "string" && it.project)) throw bad;
      const proj = normDisp(this.pmap.sub(detokenize(it.project, this.tokens)) as string);
      if (!isdir(proj)) throw new ProjectMissing(proj);
      return pjoin(CLAUDE_HOME(), "projects", encodeProjectDir(proj), "memory");
    } else if (cat === "cc.refs") {
      ok = !REF_DENY.has(parts[0]) && !parts[0].startsWith(".") &&
        !(parts[0] === "skills" && parts.length > 1 && paths.RESERVED_SKILL_DIRS.includes(parts[1]));
    } else ok = false;
    if (!ok) throw bad;
    return pjoin(CLAUDE_HOME(), ...parts);
  }

  run(): this {
    const m = this.b.manifest;
    for (const it of iter(or(get(m, "items"), []))) {
      if (isObj(it) && (it.strategy === "file" || it.strategy === "tree")) {
        try {
          this.incoming.push(this.targetOf(it));
        } catch (e) {
          if (!(e instanceof BundleError || e instanceof ProjectMissing)) throw e;   // 그 항목의 plan 이 같은 사유로 막는다
        }
      }
    }
    this.setupPaths();
    for (const it of iter(or(get(m, "items"), []))) {
      if (!isObj(it) || typeof it.id !== "string") throw new BundleError("bundle_invalid", "manifest items have an invalid format");
      const row: Row = { id: it.id, category: get(it, "category"), strategy: get(it, "strategy"), state: "" };
      delete (row as Obj).state;
      Object.assign(row, this.plan(it));
      this.items.push(row);
    }
    for (const s of iter(or(get(m, "skipped"), []))) {
      if (isObj(s)) {
        const sid = pyStr(get(s, "id"));
        this.items.push({ id: get(s, "id") as string, category: sid.split("/")[0], state: "skipped", reason: get(s, "reason") });
      }
    }
    if (this.unresolved.length) {
      this.warn("paths_missing", `${this.unresolved.length} paths do not exist on this PC; hooks and MCP servers that use them are left out`,
        { n: this.unresolved.length });
    }
    const cats = new Set(this.items.filter((r) => r.state === "new" || r.state === "changed").map((r) => r.category));
    if (MCP_CATS.some((c) => cats.has(c))) {
      this.warn("restart_after", "If Claude Code or Desktop is running, it may rewrite the config file right after apply. Restart them after applying");
    }
    if (cats.has("desk.mcp") && !isdir(this.desktopDir)) {
      this.warn("desktop_dir_new", `Claude Desktop folder does not exist and will be created: ${this.desktopDir}`, { target: this.desktopDir });
    }
    if (!isfile(libStore.storeConfigPath(this.store))) {
      this.warn("store_new", `Store does not exist yet and will be created on apply: ${this.store}`, { target: this.store });
    }
    let fps = [...this.items].sort((a, b) => cmp(pyStr(a.id), pyStr(b.id))).filter((r) => Object.hasOwn(r, "_fp"))
      .map((r) => `${r.id}\0${pyStr(r._fp)}\n`).join("");
    // 경로 짝은 화면에 보인 값 자체를 바꾸므로 plan_id 에 묶는다 - 다른 짝으로 apply 하면 plan_stale.
    // 끈 훅(exclude)은 ids 와 같은 선택이라 묶지 않는다(비교 뒤 체크를 바꿔도 적용할 수 있어야 한다).
    fps += canon(this.pmap.pairs);
    this.planId = sha(Buffer.from(this.b.hash + "\n" + fps, "utf8")).slice(7, 23);
    return this;
  }

  private plan(it: Obj): Obj {
    const s = it.strategy, cat = it.category as string;
    if (s === "file") return this.planFile(it);
    if (s === "tree") return this.planTree(it);
    if (s === "json-keys" && SETTINGS_CATS.includes(cat)) return this.planSettings(it);
    if (s === "json-keys" && MCP_CATS.includes(cat)) return this.planMcp(it);
    if (s === "json-keys" && cat === "cm.store") return this.planStore();
    throw new BundleError("bundle_invalid", `Unknown item: ${it.id}`);
  }

  private planFile(it: Obj): Obj {
    const tgt = this.targetOf(it);
    const data = this.b.read(`files/${it.rel}`);
    if (sha(data) !== get(it, "hash")) throw new BundleError("bundle_invalid", `${it.id}: content hash does not match the manifest`);
    if (isdir(tgt)) return { target: tgt, state: "blocked", reason: "A folder with the same name exists", _fp: "dir" };
    const cur = readBytes(tgt);
    const row: Obj = { target: tgt, _fp: cur !== null ? sha(cur) : null, _data: data };
    if (cur === null) row.state = "new";
    else if (row._fp === it.hash) row.state = "same";
    else Object.assign(row, { state: "changed", diff: textDiff(cur, data) });
    return row;
  }

  private planTree(it: Obj): Obj {
    let tgt: string;
    try {
      tgt = this.targetOf(it);
    } catch (e) {
      if (!(e instanceof ProjectMissing)) throw e;
      return { target: e.message, state: "blocked", code: "project_missing", _fp: "missing", reason: `Target project does not exist on this PC: ${e.message}` };
    }
    const files = this.b.tree(it.rel as string);
    const rows = files.map(([r, d]) => [r, sha(d)] as [string, string]);
    if (treeDigest(rows) !== get(it, "hash")) throw new BundleError("bundle_invalid", `${it.id}: content hash does not match the manifest`);
    if (isfile(tgt)) return { target: tgt, state: "blocked", reason: "A file with the same name exists", _fp: "file" };
    const cur = isdir(tgt) ? treeRows(tgt)[0] : null;
    const row: Obj = { target: tgt, _fp: cur !== null ? treeDigest(cur) : null, _data: files };
    if (cur === null) row.state = "new";
    else if (row._fp === it.hash) row.state = "same";
    else {
      const a = new Map(rows), c = new Map(cur);
      Object.assign(row, { state: "changed", files: {
        added: sortStr([...a.keys()].filter((k) => !c.has(k))),
        removed: sortStr([...c.keys()].filter((k) => !a.has(k))),
        modified: sortStr([...a.keys()].filter((k) => c.has(k) && a.get(k) !== c.get(k))),
      } });
    }
    return row;
  }

  private planSettings(it: Obj): Obj {
    const iid = it.id as string, cat = it.category as string;
    const tgt = pjoin(CLAUDE_HOME(), cat === "cc.settings" ? "settings.json" : "settings.local.json");
    const [cur, err] = this.jsonFile(tgt);
    if (err || (cur !== null && !isObj(cur))) return { target: tgt, state: "blocked", reason: err || "Target file is not a JSON object", _fp: "bad" };
    let inc = this.detok(this.b.json(`json/${iid}.json`));
    if (!isObj(inc)) throw new BundleError("bundle_invalid", `${iid}: not a JSON object`);
    const curD = (cur ?? {}) as Obj;
    let missing: string[];
    [inc, missing] = resolveSecrets(inc, [this.secrets, this.b.secrets, { [iid]: prepareJson(cat, iid, curD, null)[1] }]);
    const row: Obj = { target: tgt, _fp: cur !== null ? sha(canon(cur)) : null };
    const incO = inc as Obj;
    if (missing.length && isObj(incO.env)) {
      const env = incO.env as Obj;
      const left = Object.fromEntries(Object.entries(env).filter(([, v]) => !(typeof v === "string" && PH.test(v))));
      const keys = Object.keys(env).filter((k) => !Object.hasOwn(left, k)).join(", ");
      row.warnings = ["Secret values are missing, so these env keys are not imported: " + keys];
      row.warning_codes = [{ code: "secret_env_dropped", target: keys }];
      inc = { ...incO, env: left };
    }
    const used = new Set<string>();
    const [adapted, hooks, dropped] = this.adaptSettings(inc as Obj, curD, used);
    const conflicts: string[] = [];
    const merged = merge(curD, adapted, chooser(get(this.choices, iid)), conflicts);
    row._value = merged;
    if (hooks.length) row.hooks = hooks;
    if (dropped.length) row.dropped = dropped;
    if (used.size) row.remapped = sortedPairs(used);
    if (cur === null) row.state = "new";
    else if (pyEq(merged, curD) && !conflicts.length) row.state = "same";
    else Object.assign(row, { state: "changed", diff: jsonDiff(mask(cat, iid, curD), mask(cat, iid, merged)) });
    if (conflicts.length) row.conflicts = conflicts;
    return row;
  }

  /**
   * [이 PC 에 맞춘 inc, 훅 줄, 뺀 것]. 훅은 명령 하나가 한 줄이다.
   * 이 PC 에 없는 경로를 쓰는 훅은 불가, 이 PC 에 이미 같은 훅이 있으면 동일, 나머지는 신규.
   */
  private adaptSettings(inc: Obj, curD: Obj, used: Set<string>): [Obj, Obj[], Obj[]] {
    const have = new Set<string>();
    if (isObj(curD.hooks)) {
      for (const [ev, ents] of Object.entries(curD.hooks)) {
        for (const e of Array.isArray(ents) ? ents : []) {
          for (const h of isHookEntry(e) ? e.hooks : []) {
            if (isObj(h) && typeof h.command === "string") have.add(`${ev}\0${normCmd(h.command)}`);
          }
        }
      }
    }
    const subs: Obj[] = [], dropped: Obj[] = [], hooks: Obj = {};
    const src = isObj(inc.hooks) ? inc.hooks : {};
    for (const [ev, ents] of Object.entries(src)) {
      if (!Array.isArray(ents)) {
        put(hooks, ev, ents);
        continue;
      }
      const keep: unknown[] = [];
      for (const e of ents) {
        if (!isHookEntry(e)) {
          keep.push(this.remap(e, used));
          continue;
        }
        const kept: unknown[] = [];
        for (const h of e.hooks) {
          if (!(isObj(h) && typeof h.command === "string")) {
            kept.push(h);
            continue;
          }
          const mine = new Set<string>();
          const cmd = this.pmap.sub(h.command, mine) as string;
          const norm = normCmd(cmd);
          const sub: Obj = { id: hookId(ev, norm), event: ev, matcher: get(e, "matcher"), command: cmd };
          if (mine.size) sub.remapped = sortedPairs(mine);
          const d = dead(cmd, false, this.alive);
          if (d.length) {
            Object.assign(sub, { state: "blocked", code: "path_missing", target: d[0] });
            dropped.push({ what: "hook", event: ev, target: d[0] });
          } else if (have.has(`${ev}\0${norm}`)) {
            Object.assign(sub, { state: "same", code: "dup" });
          } else {
            sub.state = "new";
            if (this.exclude.has(sub.id as string)) sub.excluded = true;
            else {
              kept.push({ ...h, command: cmd });
              for (const k of mine) used.add(k);
            }
          }
          subs.push(sub);
        }
        if (kept.length) keep.push({ ...e, hooks: kept });
      }
      if (keep.length) put(hooks, ev, keep);
    }
    const out: Obj = {};
    for (const [k, v] of Object.entries(inc)) {
      if (k !== "hooks") put(out, k, this.remap(v, used));
      else if (Object.keys(hooks).length) out[k] = hooks;
    }
    const sl = out.statusLine;
    const d = isObj(sl) && typeof sl.command === "string" ? dead(sl.command, false, this.alive) : [];
    if (d.length) {
      dropped.push({ what: "statusLine", target: d[0] });
      delete out.statusLine;
    }
    let env = out.env;
    if (isObj(env) && typeof env.CLAUDE_CODE_PLUGIN_DIRS === "string") {
      const parts = env.CLAUDE_CODE_PLUGIN_DIRS.split(";").filter((x) => stripWs(x));
      const alive = parts.filter((x) => !dead(x, false, this.alive).length);
      dropped.push(...parts.filter((x) => !alive.includes(x)).map((x) => ({ what: "plugin-dir", target: stripWs(x) })));
      env = { ...env };
      if (alive.length) (env as Obj).CLAUDE_CODE_PLUGIN_DIRS = alive.join(";");
      else delete (env as Obj).CLAUDE_CODE_PLUGIN_DIRS;
      out.env = env;
    }
    return [out, subs, dropped];
  }

  private planMcp(it: Obj): Obj {
    const iid = it.id as string, cat = it.category as string;
    const i = iid.indexOf("/");
    const key = pyStrOr(or(get(it, "key"), "")), name = i < 0 ? "" : iid.slice(i + 1);
    if (key !== `mcpServers.${name}` || !name) throw new BundleError("bundle_invalid", `${iid}: key does not match the server name`);
    const tgt = cat === "cc.mcp-user" ? CLAUDE_JSON() : this.desktopConfig;
    const [doc, err] = this.jsonFile(tgt);
    if (err || (doc !== null && !isObj(doc))) return { target: tgt, state: "blocked", reason: err || "Target file is not a JSON object", _fp: "bad" };
    const servers = get(doc ?? {}, "mcpServers");
    const cur = isObj(servers) ? get(servers, name) : null;
    let inc = this.detok(this.b.json(`json/${iid}.json`));
    if (!isObj(inc)) throw new BundleError("bundle_invalid", `${iid}: not a JSON object`);
    const tfound = isObj(cur) ? prepareJson(cat, iid, cur, null)[1] : {};
    let missing: string[];
    [inc, missing] = resolveSecrets(inc, [this.secrets, this.b.secrets, { [iid]: tfound }]);
    const used = new Set<string>();
    inc = this.remap(inc, used);
    const row: Obj = { target: tgt, key: name, _fp: cur !== null ? sha(canon(cur)) : null, _value: inc };
    if (used.size) row.remapped = sortedPairs(used);
    const d = deadServer(name, inc, this.alive);
    const curOk = isObj(cur) && !deadServer(name, cur, this.alive).length;
    const conflicts: string[] = [];
    if (curOk && !d.length) {
      inc = mergeServer(cur as Obj, inc as Obj, chooser(get(this.choices, iid)), conflicts);
      row._value = inc;
    }
    if (cur === null) row.state = "new";
    else if (isObj(cur) && !conflicts.length && (canon(cur) === canon(inc) ||
      sha(canon(prepareJson(cat, iid, cur, this.tokens)[0])) === get(it, "hash"))) row.state = "same";
    else Object.assign(row, { state: "changed", diff: jsonDiff(mask(cat, iid, cur), mask(cat, iid, inc)) });
    if (conflicts.length) row.conflicts = conflicts;
    if (d.length && row.state !== "same") {
      if (curOk) {
        Object.assign(row, { state: "blocked", code: "keep_working", missing_paths: d,
          reason: `Kept the working value on this PC; the bundle value points to a path that does not exist here: ${d[0]}` });
      } else {
        Object.assign(row, { state: "blocked", code: "path_missing", missing_paths: d, reason: `Path does not exist on this PC: ${d[0]}` });
      }
    }
    if (missing.length && row.state !== "same" && row.state !== "blocked") {
      Object.assign(row, { state: "blocked", code: "secret_missing", missing_secrets: missing, reason: "Secret values are missing: " + missing.join(", ") });
    }
    return row;
  }

  private planStore(): Obj {
    const tgt = libStore.storeConfigPath(this.store);
    const [cur, err] = this.jsonFile(tgt);
    if (err || (cur !== null && !isObj(cur))) return { target: tgt, state: "blocked", reason: err || "Target file is not a JSON object", _fp: "bad" };
    let inc = this.detok(this.b.json("json/cm.store.json"));
    if (!isObj(inc)) throw new BundleError("bundle_invalid", "cm.store: not a JSON object");
    const used = new Set<string>();
    inc = this.remap(inc, used) as Obj;
    const libs = iter(or((inc as Obj).libraries, [])).filter((x): x is string => typeof x === "string");
    const dropped = libs.filter((x) => !pexists(x)).map((x) => ({ what: "library", target: x }));
    inc = { ...(inc as Obj), libraries: libs.filter((x) => pexists(x)) };
    const curD = (cur ?? {}) as Obj;
    const conflicts: string[] = [];
    const [merged, added] = mergeStore(curD, inc as Obj, this.store, chooser(get(this.choices, "cm.store")), conflicts);
    const before = { libraries: or(curD.libraries, []), remotes: or(curD.remotes, []), marketplaces: or(curD.marketplaces, []), ui: or(curD.ui, {}) };
    const row: Obj = { target: tgt, _fp: sha(canon(Object.fromEntries(STORE_KEYS.map((k) => [k, get(curD, k)])))) + pyStr(cur !== null), _value: merged };
    if (pyEq(merged, before) && !conflicts.length) row.state = "same";
    else Object.assign(row, { state: cur === null ? "new" : "changed", diff: jsonDiff(before, merged) });
    if (conflicts.length) row.conflicts = conflicts;
    if (added.length) {
      row.warnings = ["Run a library fetch to download the contents: " + added.join(", ")];
      row.warning_codes = [{ code: "lib_fetch", target: added.join(", ") }];
    }
    if (dropped.length) row.dropped = dropped;
    if (used.size) row.remapped = sortedPairs(used);
    return row;
  }

  public(): Obj[] {
    return this.items.map(pub);
  }

  summary(): Record<string, number> {
    const s: Record<string, number> = { new: 0, same: 0, changed: 0, blocked: 0, skipped: 0 };
    for (const r of this.items) s[r.state] = (s[r.state] ?? 0) + 1;
    return s;
  }
}

/** str(x or ""): None 이 아닌 값의 Python str. */
function pyStrOr(v: unknown): string {
  return v === null || v === undefined ? "" : typeof v === "string" ? v : pyStr(v);
}

// ----- import apply / undo -----

const IMPORTS_KEEP = 50;

class Changed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Changed";
  }
}

function unique(base: string): string {
  let dst = base, n = 1;
  while (exists(dst)) {
    dst = `${base}.${n}`;
    n++;
  }
  return dst;
}

/** config_edit.trash 와 같은 자리(.trash/<이름>.<시각>). 같은 초에 다시 와도 겹치지 않게 번호를 붙인다. */
function trash(p: string): string {
  const tdir = pjoin(dirname(normpath(p)), ".trash");
  fs.mkdirSync(tdir, { recursive: true });
  const dst = unique(pjoin(tdir, `${basename(normpath(p))}.${ts()}`));
  shMove(p, dst);
  return dst;
}

function backupCopy(p: string): string | null {
  if (!exists(p)) return null;
  const dst = unique(`${p}.${ts()}.bak`);
  copy2(p, dst);
  return dst;
}

function putBytes(target: string, data: Uint8Array): void {
  const tmp = `${target}.import.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

/** 새 내용을 먼저 다 쓴 뒤 기존 것을 휴지통으로 옮기고 교체한다. 휴지통 경로 또는 null. */
function writeFile(target: string, data: Uint8Array): string | null {
  fs.mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.import.tmp`;
  fs.writeFileSync(tmp, data);
  const old = exists(target) ? trash(target) : null;
  fs.renameSync(tmp, target);
  return old;
}

function writeTree(target: string, files: [string, Buffer][]): string | null {
  const parent = dirname(target);
  const tmp = pjoin(parent, `.${basename(target)}.import-${process.pid}`);
  if (isdir(tmp)) fs.rmSync(tmp, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const [rel, data] of files) {
    const dst = pjoin(tmp, ...rel.split("/"));
    fs.mkdirSync(dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
  }
  const old = exists(target) ? trash(target) : null;
  fs.renameSync(tmp, target);
  return old;
}

function fileHash(p: string): string | null {
  const b = readBytes(p);
  return b !== null ? sha(b) : null;
}

function treeHash(p: string): string | null {
  return isdir(p) ? treeDigest(treeRows(p)[0]) : null;
}

/** 새 PC 에는 스토어가 없다. 원장과 스냅샷을 남길 자리라 cas init 과 같은 최소 구성을 만든다. */
function ensureStore(store: string): cas.StorePaths {
  const p = cas.storePaths(store);
  for (const d of [p.store, p.objects, p.snapshots, p.log]) fs.mkdirSync(d, { recursive: true });
  if (!exists(p.config)) cas.saveJson(p.config, { version: 1, store, tracked: [] });
  if (!exists(p.index)) cas.saveJson(p.index, {});
  return p;
}

type Rec = Obj & { id: string; kind: string; target: string };

function writeOne(r: Row): Rec[] {
  const tgt = r.target as string;
  const existed = exists(tgt);
  let old: string | null, post: string | null;
  if (r.strategy === "file") {
    old = writeFile(tgt, r._data as Buffer);
    post = fileHash(tgt);
  } else {
    old = writeTree(tgt, r._data as [string, Buffer][]);
    post = treeHash(tgt);
  }
  return [{ id: r.id, kind: r.strategy as string, target: tgt, trash: old, action: existed ? "replaced" : "created", post_hash: post }];
}

function writeSettings(r: Row): Rec[] {
  const tgt = r.target as string;
  const existed = exists(tgt);
  const bak = backupCopy(tgt);
  configEdit.saveAtomic(tgt, r._value);
  return [{ id: r.id, kind: "json-file", target: tgt, backup: bak, action: existed ? "merged" : "created", post_hash: fileHash(tgt) }];
}

/** 같은 파일의 서버는 한 번에 쓴다(백업·저장 1회). */
function writeServers(tgt: string, group: Row[]): Rec[] {
  const doc = configEdit.load(tgt) as Obj;
  const servers = configEdit.slotDict(doc, "mcpServers");
  for (const r of group) put(servers, r.key as string, r._value);
  const bak = backupCopy(tgt);
  configEdit.saveAtomic(tgt, doc);
  return group.map((r) => ({ id: r.id, kind: "json-key", target: tgt, key: r.key, backup: bak,
    action: r.state === "changed" ? "replaced" : "created", post_hash: sha(canon(r._value)) }));
}

async function writeStore(r: Row, store: string): Promise<Rec[]> {
  let prev: Obj = {};
  await libStore.withEditCfg(store, (cfg) => {
    prev = Object.fromEntries(STORE_KEYS.filter((k) => Object.hasOwn(cfg, k)).map((k) => [k, cfg[k]]));
    Object.assign(cfg, r._value);
  });
  const v = r._value as Obj;
  return [{ id: r.id, kind: "store", target: r.target as string, prev, action: "merged",
    post_hash: sha(canon(Object.fromEntries(STORE_KEYS.map((k) => [k, get(v, k)])))) }];
}

/** [적용 기록, 실패]. 파일 하나가 실패해도 나머지는 계속한다. */
async function applyRows(rows: Row[], store: string): Promise<[Rec[], Obj[]]> {
  const jobs: [Row[], () => Rec[] | Promise<Rec[]>][] = [];
  for (const r of rows) if (r.strategy === "file" || r.strategy === "tree") jobs.push([[r], () => writeOne(r)]);
  for (const r of rows) if (SETTINGS_CATS.includes(r.category as string)) jobs.push([[r], () => writeSettings(r)]);
  const byFile = new Map<string, Row[]>();
  for (const r of rows) {
    if (MCP_CATS.includes(r.category as string)) {
      const t = r.target as string;
      if (!byFile.has(t)) byFile.set(t, []);
      byFile.get(t)!.push(r);
    }
  }
  for (const [t, g] of byFile) jobs.push([g, () => writeServers(t, g)]);
  for (const r of rows) if (r.category === "cm.store") jobs.push([[r], () => writeStore(r, store)]);
  const applied: Rec[] = [], failed: Obj[] = [];
  for (const [group, fn] of jobs) {
    try {
      applied.push(...(await fn()));
    } catch (e) {                          // 실패는 결과에 담고 다음 파일로 간다
      if (e instanceof CliExit) throw e;
      failed.push(...group.map((r) => ({ id: r.id, code: "write_failed", reason: excStr(e) })));
    }
  }
  return [applied, failed];
}

async function undoRecord(rec: Obj, force: boolean): Promise<void> {
  const kind = rec.kind, tgt = rec.target as string;
  if (kind === "file" || kind === "tree") {
    const cur = kind === "file" ? fileHash(tgt) : treeHash(tgt);
    if (cur !== get(rec, "post_hash") && !force) throw new Changed(tgt);
    if (exists(tgt)) trash(tgt);
    if (truthy(get(rec, "trash"))) shMove(rec.trash as string, tgt);
  } else if (kind === "json-file") {
    if (fileHash(tgt) !== get(rec, "post_hash") && !force) throw new Changed(tgt);
    if (truthy(get(rec, "backup"))) putBytes(tgt, readBytes(rec.backup as string) as Buffer);
    else if (exists(tgt)) trash(tgt);
  } else if (kind === "json-key") {
    // 파일째 되돌리면 그 사이 Claude Code 가 이 파일에 쓴 다른 키까지 되돌아간다. 서버 하나만 되돌린다.
    const doc = configEdit.load(tgt) as Obj;
    const servers = configEdit.slotDict(doc, "mcpServers");
    const key = rec.key as string;
    if (sha(canon(get(servers, key))) !== get(rec, "post_hash") && !force) throw new Changed(tgt);
    const prev = truthy(get(rec, "backup")) ? get(or(get(configEdit.load(rec.backup as string), "mcpServers"), {}), key) : null;
    if (prev === null) delete servers[key];
    else put(servers, key, prev);
    configEdit.saveAtomic(tgt, doc);
  } else if (kind === "store") {
    await libStore.withEditCfg(dirname(tgt), (cfg) => {
      if (sha(canon(Object.fromEntries(STORE_KEYS.map((k) => [k, get(cfg, k)])))) !== get(rec, "post_hash") && !force) throw new Changed(tgt);
      const prev = get(rec, "prev", {}) as Obj;
      for (const k of STORE_KEYS) {
        if (Object.hasOwn(prev, k)) cfg[k] = prev[k];
        else delete cfg[k];
      }
    });
  }
}

// ----- CLI -----

function summaryFields(col: Collector, out: string | null = null): Obj {
  return {
    counts: col.counts(), plugins: col.plugins, external: col.external,
    skipped: col.skipped, warnings: col.warnings,
    secrets: Object.entries(col.secrets).flatMap(([iid, d]) => Object.keys(d).map((k) => ({ item: iid, path: k }))),
    include_secrets: col.includeSecrets, report: col.report(out),
  };
}

function jsonArg(v: string | undefined, name: string): Obj {
  if (!v) return {};
  let o: unknown;
  try {
    o = libStore.pyLoads(v);
  } catch (e) {
    if (!(e instanceof libStore.JSONDecodeError)) throw e;
    emit(false, "invalid_arg", `${name}: invalid JSON (${e.message})`, { target: name });
  }
  if (!isObj(o)) emit(false, "invalid_arg", `${name} must be a JSON object`, { target: name });
  return o;
}

function openBundle(p: string): Bundle {
  try {
    return new Bundle(p);
  } catch (e) {
    if (!(e instanceof BundleError)) throw e;
    emit(false, e.code, e.message, { target: p });
  }
}

function excludeArg(v: string | undefined): string[] {
  return (v || "").split(",").map(stripWs).filter((x) => x);
}

function makePlan(a: ImportArgs & { store: string }, b: Bundle): Planner {
  try {
    return new Planner(b, a.store, jsonArg(a.secrets, "--secrets"), jsonArg(a.choices, "--choices"),
      jsonArg(a.roots, "--roots"), excludeArg(a.exclude)).run();
  } catch (e) {
    if (!(e instanceof BundleError)) throw e;
    emit(false, e.code, e.message, { target: b.path });
  }
}

function planMessage(pl: Planner): string {
  const s = pl.summary();
  let msg = `plan ${pl.planId}: new ${s.new}, changed ${s.changed}, same ${s.same}, blocked ${s.blocked}, skipped ${s.skipped}`;
  if (pl.unresolved.length) msg += `. ${pl.unresolved.length} paths that do not exist on this PC are not used (set pairs with roots to recompute)`;
  return msg;
}

const storeOf = (o: TransferOpts) => o.store ?? libStore.defaultStore();

function parseOpts(raw: string | undefined): string[] {
  const opts = (raw || "").split(",").map(stripWs).filter((x) => x);
  const bad = opts.filter((x) => !Object.hasOwn(OPTIONAL, x));
  if (bad.length) emit(false, "invalid_arg", `Unknown optional items: ${bad.join(", ")}`, { target: "--with-optional" });
  return opts;
}

async function exportImpl(op: "inventory" | "export", a: TransferOpts & { out?: string; withOptional?: string; includeSecrets?: boolean }): Promise<never> {
  const store = storeOf(a);
  const opts = parseOpts(a.withOptional);
  const includeSecrets = op === "export" && !!a.includeSecrets;
  const col = new Collector(store, opts.map((x) => OPTIONAL[x]), includeSecrets).collect();
  if (col.includeSecrets && Object.keys(col.secrets).length) col.warnings.push("Secret values are written to secrets.json as plain text");

  if (op === "inventory") {
    const its = col.items.map(pub);
    emit(true, "ok", `${its.length} items to carry, ${col.external.length} external paths`, { items: its, ...summaryFields(col) });
  }
  const out = abspath(a.out!);
  if (exists(out)) emit(false, "exists", `Already exists: ${out}`, { target: out });
  const bundleHash = writeBundle(col, out, includeSecrets);
  const hasSecrets = includeSecrets && Object.keys(col.secrets).length > 0;
  const extra = hasSecrets ? { secrets_file: "secrets.json" } : {};
  await recordExport(store, { at: nowIso(), path: out, hash: bundleHash, items: col.items.length, secrets: hasSecrets });
  emit(true, "ok", `Created bundle: ${out} (${col.items.length} items, ${col.external.length} external paths)`,
    { target: out, bundle: out, ...extra, ...summaryFields(col, out) });
}

const EXPORTS_KEEP = 20;

/**
 * 위젯이 최근 번들 목록을 보여 줄 수 있게 남긴다. 스토어가 없는 PC 에서는 남기지 않는다(export 는 소스를
 * 바꾸지 않는다).
 */
async function recordExport(store: string, rec: Obj): Promise<void> {
  try {
    await libStore.withEditCfg(store, (cfg) => {
      if (!Object.hasOwn(cfg, "exports")) cfg.exports = [];
      const ex = cfg.exports as unknown[];
      ex.push(rec);
      ex.splice(0, Math.max(0, ex.length - EXPORTS_KEEP));
    });
  } catch (e) {
    if (!(e instanceof libStore.StoreNotInitialized || e instanceof libStore.LockTimeoutError || isOSError(e) || isValueError(e))) throw e;
  }
}

async function historyImpl(a: TransferOpts): Promise<never> {
  const cfg = libStore.loadCfg(storeOf(a));
  const imports = [...iter(or(get(cfg, "imports"), []))].reverse().map((x) => {
    const applied = iter(or(get(x, "applied"), []));
    return {
      id: get(x, "id"), at: get(x, "at"), bundle: get(x, "bundle"), source_host: get(x, "source_host"),
      items: applied.map((r) => get(r, "id")), undone_at: get(x, "undone_at"),
      undone: applied.filter((r) => truthy(get(r, "undone"))).map((r) => get(r, "id")),
      dropped: iter(or(get(x, "dropped"), [])).length,
    };
  });
  const exports = [...iter(or(get(cfg, "exports"), []))].reverse();
  emit(true, "ok", `${imports.length} import records, ${exports.length} export records`, { imports, exports, sync: get(cfg, "sync") });
}

// ----- sync -----
// <sync dir>/<profile>/ 는 PC 마다 하나인 폴더 번들이다. base[<상대 profile>][<item id>] 는 그 PC 와 마지막으로
// 내용이 같았던 해시이고, 이것으로 어느 쪽이 바뀌었는지 가른다.

function syncCfg(store: string): Obj {
  const s = or(get(libStore.loadCfg(store), "sync"), {}) as Obj;
  if (!truthy(get(s, "dir"))) emit(false, "sync_unconfigured", "Sync folder is not set. Set it with sync-setup --dir");
  return s;
}

function profiles(d: string): Obj[] {
  const out: Obj[] = [];
  for (const n of isdir(d) ? sortStr(fs.readdirSync(d)) : []) {
    const mp = pjoin(d, n, "manifest.json");
    if (n.startsWith(".") || !isfile(mp)) continue;
    let m: unknown;
    try {
      m = load(mp);
    } catch (e) {
      if (!(isOSError(e) || isValueError(e))) throw e;
      continue;
    }
    out.push({ profile: n, host: get(or(get(m, "source"), {}), "host"), created: get(m, "created"), items: iter(or(get(m, "items"), [])).length });
  }
  return out;
}

function profileDir(s: Obj, name: string): string {
  if (!SAFE_ID.test(name || "")) emit(false, "invalid_arg", `Invalid profile name: ${name}`, { target: name });
  const p = pjoin(s.dir as string, name);
  if (!isfile(pjoin(p, "manifest.json"))) emit(false, "not_found", `No such PC in the sync folder: ${name}`, { target: p });
  return p;
}

function remoteHashes(pdir: string): Record<string, unknown> {
  try {
    const out: Record<string, unknown> = {};
    for (const it of iter(or(get(new Bundle(pdir).manifest, "items"), []))) put(out, (it as Obj).id as string, get(it, "hash"));
    return out;
  } catch (e) {
    if (!(e instanceof BundleError)) throw e;
    emit(false, e.code, e.message, { target: pdir });
  }
}

function localHashes(store: string, opts: unknown[]): Record<string, unknown> {
  const col = new Collector(store, opts.filter((x): x is string => typeof x === "string" && Object.hasOwn(OPTIONAL, x)).map((x) => OPTIONAL[x])).collect();
  return Object.fromEntries(col.items.map((it) => [it.id, it.hash]));
}

export function syncState(local: unknown, remote: unknown, base: unknown): string {
  if (local === remote) return "in-sync";
  if (base === null || base === undefined) return "untracked";
  if (remote === base) return "local-ahead";
  if (local === base) return "remote-ahead";
  return "diverged";
}

function setdefault(o: Obj, k: string, d: unknown): Obj {
  if (!Object.hasOwn(o, k)) put(o, k, d);
  return o[k] as Obj;
}

/** 내용이 같은 항목과 이번에 가져온 항목(taken)의 기준을 그 PC 의 해시로 맞춘다. */
function agree(cfg: Obj, profile: string, local: Record<string, unknown>, remote: Record<string, unknown>, taken: Set<string> = new Set()): void {
  const base = setdefault(setdefault(setdefault(cfg, "sync", {}), "base", {}), profile, {});
  for (const iid of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const l = Object.hasOwn(local, iid) ? local[iid] : null, r = Object.hasOwn(remote, iid) ? remote[iid] : null;
    if (taken.has(iid) && truthy(r)) put(base, iid, r);
    else if (truthy(l) && l === r) put(base, iid, l);
  }
}

async function syncSetupImpl(a: TransferOpts & { dir: string; profile?: string }): Promise<never> {
  const store = storeOf(a);
  const d = abspath(a.dir);
  if (!isdir(d)) emit(false, "not_found", `Sync folder does not exist: ${d}`, { target: d });
  const profile = a.profile || os.hostname().replace(/[^A-Za-z0-9._-]/gu, "-");
  if (!SAFE_ID.test(profile)) emit(false, "invalid_arg", `Invalid profile name: ${profile}`, { target: profile });
  ensureStore(store);
  await libStore.withEditCfg(store, (cfg) => {
    const s = setdefault(cfg, "sync", {});
    s.dir = d;
    s.profile = profile;
    setdefault(s, "base", {});
  });
  emit(true, "ok", `Sync folder: ${d} (this PC is ${profile})`, { target: d, sync: { dir: d, profile }, profiles: profiles(d) });
}

async function syncPushImpl(a: TransferOpts & { withOptional?: string; includeSecrets?: boolean }): Promise<never> {
  const store = storeOf(a);
  const s = syncCfg(store);
  const opts = parseOpts(a.withOptional);
  const includeSecrets = !!a.includeSecrets;
  const col = new Collector(store, opts.map((x) => OPTIONAL[x]), includeSecrets).collect();
  if (col.includeSecrets && Object.keys(col.secrets).length) col.warnings.push("Secret values are written to secrets.json as plain text");
  const sdir = s.dir as string, prof = s.profile as string;
  const dst = pjoin(sdir, prof);
  const fresh = pjoin(sdir, `.${prof}.push`);
  if (isdir(fresh)) fs.rmSync(fresh, { recursive: true });
  const h = writeBundle(col, fresh, includeSecrets);
  let old: string | null = null;
  if (isdir(dst)) {
    old = pjoin(sdir, `.${prof}.old.${process.pid}`);
    fs.renameSync(dst, old);
  }
  fs.renameSync(fresh, dst);
  if (old) fs.rmSync(old, { recursive: true, force: true });
  const local = Object.fromEntries(col.items.map((it) => [it.id, it.hash]));
  const others = profiles(sdir).map((p) => p.profile as string).filter((p) => p !== prof);
  const remotes = new Map(others.map((p) => [p, remoteHashes(pjoin(sdir, p))]));
  await libStore.withEditCfg(store, (cfg) => {
    const sy = cfg.sync as Obj;
    sy.with_optional = opts;
    sy.pushed_at = nowIso();
    for (const [p, remote] of remotes) agree(cfg, p, local, remote);
  });
  emit(true, "ok", `Pushed: ${dst} (${col.items.length} items)`, { target: dst, bundle: dst, hash: h, ...summaryFields(col, dst) });
}

async function syncStatusImpl(a: TransferOpts & { syncFrom?: string }): Promise<never> {
  const store = storeOf(a);
  const s = syncCfg(store);
  const profs = profiles(s.dir as string);
  const pubS = Object.fromEntries(["dir", "profile", "pushed_at"].map((k) => [k, get(s, k)]));
  if (!a.syncFrom) emit(true, "ok", `${profs.length} PCs in the sync folder`, { target: s.dir, sync: pubS, profiles: profs });
  const remote = remoteHashes(profileDir(s, a.syncFrom));
  const local = localHashes(store, iter(or(get(s, "with_optional"), [])));
  const base = (or(get(or(get(s, "base"), {}), a.syncFrom), {})) as Obj;
  const at = (o: Obj, k: string) => (Object.hasOwn(o, k) ? o[k] : null);
  const itemsOut = sortStr(new Set([...Object.keys(local), ...Object.keys(remote)])).map((i) => ({
    id: i, state: syncState(at(local, i), at(remote, i), at(base, i)), local: at(local, i), remote: at(remote, i), base: at(base, i),
  }));
  const summary: Record<string, number> = {};
  for (const it of itemsOut) summary[it.state] = (summary[it.state] ?? 0) + 1;
  emit(true, "ok", `Compared with ${a.syncFrom}: ` + sortStr(Object.keys(summary)).map((k) => `${k} ${summary[k]}`).join(", "),
    { target: a.syncFrom, sync: pubS, profiles: profs, items: itemsOut, summary });
}

async function inspectImpl(a: TransferOpts & { bundle: string }): Promise<never> {
  const b = openBundle(a.bundle);
  const m = b.manifest;
  const counts: Record<string, number> = {};
  for (const it of iter(or(get(m, "items"), []))) {
    const c = pyStr(get(it, "category"));
    counts[c] = (counts[c] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((x, y) => x + y, 0);
  emit(true, "ok", `Bundle ${basename(b.path)}: created on ${pyStr(get(get(m, "source", {}), "host"))} at ${pyStr(get(m, "created"))}, ${total} items`, {
    target: b.path, bundle: b.path, hash: b.hash, created: get(m, "created"), source: get(m, "source"),
    counts, skipped: or(get(m, "skipped"), []), external: or(get(m, "external"), []),
    plugins: or(get(m, "plugins"), {}), has_secrets: truthy(b.secrets),
  });
}

async function planImpl(a: TransferOpts & ImportArgs & { bundle?: string; syncFrom?: string }): Promise<never> {
  const store = storeOf(a);
  let bundle = a.bundle;
  if (a.syncFrom) bundle = profileDir(syncCfg(store), a.syncFrom);
  else if (!bundle) emit(false, "invalid_arg", "One of --bundle or --sync-from is required", { target: "--bundle" });
  const b = openBundle(bundle!);
  const pl = makePlan({ ...a, store }, b);
  emit(true, "ok", planMessage(pl), {
    target: b.path, bundle: b.path, plan_id: pl.planId, source: get(b.manifest, "source"), items: pl.public(), summary: pl.summary(),
    external: pl.external, warnings: pl.warnings, warning_codes: pl.warningCodes, roots: pl.roots, unresolved: pl.unresolved,
  });
}

/** 이 PC 에 없는 경로 때문에 들이지 않은 것. 고른 항목 안에서 뺀 훅·statusLine 등과, 통째로 막힌 서버. */
function droppedOf(pl: Planner, selIds: Set<string>): Obj[] {
  const out: Obj[] = [];
  for (const r of pl.items) {
    if (selIds.has(r.id)) out.push(...iter(or(r.dropped, [])).map((d) => ({ id: r.id, ...(d as Obj) })));
    if (r.code === "path_missing" || r.code === "keep_working") {
      out.push({ id: r.id, what: "item", code: r.code, target: (or(r.missing_paths, [""]) as unknown[])[0] });
    }
  }
  return out;
}

/** 확정된 짝만 남긴다(추정은 매번 다시 계산하면 같은 답이라 남길 필요가 없다). */
async function saveRoots(store: string, key: string, roots: Record<string, string>, by: string): Promise<void> {
  if (!Object.keys(roots).length) return;
  ensureStore(store);
  await libStore.withEditCfg(store, (cfg) => {
    const slot = setdefault(setdefault(cfg, "import_roots", {}), key, {});
    for (const [f, t] of Object.entries(roots)) put(slot, f, { to: t, by, at: nowIso() });
  });
}

/** Claude·사람이 정한 경로 짝을 확인해 저장한다. 다음 plan 이 이 짝을 쓴다. 설정 파일은 바꾸지 않는다. */
async function rootsImpl(a: TransferOpts & { bundle?: string; syncFrom?: string; roots: string; by?: string }): Promise<never> {
  const store = storeOf(a);
  let bundle = a.bundle;
  if (a.syncFrom) bundle = profileDir(syncCfg(store), a.syncFrom);
  else if (!bundle) emit(false, "invalid_arg", "One of --bundle or --sync-from is required", { target: "--bundle" });
  const b = openBundle(bundle!);
  const pl = new Planner(b, store);
  pl.setupPaths();
  const results: Obj[] = [], good: Record<string, string> = {};
  for (const [f, t] of Object.entries(jsonArg(a.roots, "--roots"))) {
    const f2 = normpath(f);
    const mine = pl.missing.filter((p) => f2 && isabs(f2) && under(p, f2));
    if (!mine.length) {
      results.push({ from: f, to: t, ok: false, reason: "The bundle has no missing paths under this root" });
      continue;
    }
    if (!(typeof t === "string" && isabs(t) && isdir(t))) {
      results.push({ from: f, to: t, ok: false, reason: "Folder does not exist on this PC" });
      continue;
    }
    const n = mine.filter((p) => pexists(rebase(p, f2, t))).length;
    if (!n) {
      results.push({ from: f, to: t, ok: false, total: mine.length, resolved: 0, reason: "No paths resolve with this pair" });
      continue;
    }
    put(good, f2, normpath(t));
    results.push({ from: f2, to: good[f2], ok: true, total: mine.length, resolved: n });
  }
  await saveRoots(store, pl.sourceKey, good, a.by ?? "claude");
  const ok = Object.keys(good).length > 0;
  emit(ok, ok ? "ok" : "invalid_arg",
    ok ? `Saved ${Object.keys(good).length} path pairs. Compare again on the import screen to use them` : "No pairs were saved",
    { target: b.path, roots: results });
}

/**
 * 스냅샷 락을 잡고 pre 스냅샷을 찍는다. 락은 쓰기와 post 스냅샷이 끝날 때까지 쥔다 -
 * 풀어 두면 watcher 가 사이에 찍어 리비전에 이 작업의 이름이 남지 않는다.
 */
async function openSpan(p: cas.StorePaths, message: string): Promise<[libStore.LockHandle, string | null]> {
  let span: libStore.LockHandle | null = null;
  try {
    span = await cas.acquireSnapshotLock(p);
    const [pre] = await cas.takeSnapshotLocked(p, message);
    return [span, pre];
  } catch (e) {
    // Python 판은 TimeoutError 밖의 예외에서 락 파일을 남긴 채 프로세스가 끝난다. 같은 프로세스에서 계속 도는
    // TS 판은 남은 락이 60초 동안 다음 호출을 막으므로 어떤 예외든 놓는다.
    try {
      span?.release();
    } catch {
      // 놓기 실패는 원래 예외를 가리지 않는다
    }
    if (e instanceof libStore.LockTimeoutError) {
      emit(false, "lock_timeout", "Could not create a restore point (snapshot), so nothing was changed", { detail: e.message });
    }
    throw e;
  }
}

async function closeSpan(span: libStore.LockHandle, p: cas.StorePaths, message: string): Promise<string | null> {
  try {
    return (await cas.takeSnapshotLocked(p, message))[0];
  } catch (e) {
    if (e instanceof libStore.LockTimeoutError) return null;
    throw e;
  } finally {
    try {
      span.release();
    } catch {
      // contextlib.suppress(Exception) 와 같다
    }
  }
}

function publicRec(rec: Obj): Obj {
  return Object.fromEntries(["id", "action", "target", "key", "trash", "backup"].filter((k) => rec[k] !== null && rec[k] !== undefined).map((k) => [k, rec[k]]));
}

const PLUGIN_CALL_SEC = 660;
const PLUGIN_BUDGET_SEC = 1200;   // 명령 시작부터 잰다. mcp-tools.ts 의 --install-plugins 타임아웃(1260초)보다 짧아야 한다

/** extraKnownMarketplaces 의 source 객체 -> claude plugin marketplace add 가 받는 문자열. */
function marketSource(src: unknown): unknown {
  if (!isObj(src)) return null;
  const m: Record<string, unknown> = { github: get(src, "repo"), git: get(src, "url"), url: get(src, "url"), directory: get(src, "path"), file: get(src, "path") };
  const k = get(src, "source");
  return typeof k === "string" && Object.hasOwn(m, k) ? m[k] : null;
}

/**
 * Python 판은 plugin_cli.py 를 자식 프로세스로 부른다. TS 판은 같은 프로세스에서 plugin_cli.main 을 부르고
 * 결과 문서 형식은 같다(docs/port-contract-2026-11-20.md 3.7절). 시간 초과는 기다림만 끊는다.
 */
async function callPluginCli(args: string[], store: string): Promise<Obj> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Obj>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, code: "timeout", message: `Did not finish within ${PLUGIN_CALL_SEC} seconds` }), PLUGIN_CALL_SEC * 1000);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      pluginCli.main([...args, ...(store ? ["--store", store] : [])]).then((d) => d as Obj,
        () => ({ ok: false, code: "bad_output", message: "plugin_cli output is not JSON" })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * settings 에서 켜진 마켓 플러그인 중 이 PC 원장에 없는 것을 claude CLI 로 설치한다. 마켓을 Claude Code 가
 * 모르면 extraKnownMarketplaces 의 출처로 먼저 등록한다. 순차 실행이고 시간 예산을 넘으면 나머지는 남긴다.
 */
async function installPlugins(store: string, started: number): Promise<Obj[]> {
  const st = configEdit.load(pjoin(CLAUDE_HOME(), "settings.json"));
  const pdir = pjoin(CLAUDE_HOME(), "plugins");
  const installed = pluginState.readInstalled(pdir);
  let known: Set<unknown>;
  try {
    const k = load(pjoin(pdir, "known_marketplaces.json"));
    if (Array.isArray(k) && k.some((x) => isObj(x) || Array.isArray(x))) throw new PyError("TypeError", "unhashable type");
    known = new Set(iter(k));
  } catch (e) {
    if (!(isOSError(e) || isValueError(e) || (e instanceof PyError && e.name === "TypeError"))) throw e;
    known = new Set();
  }
  const ekm = or(get(st, "extraKnownMarketplaces"), {});
  const want = items(or(get(st, "enabledPlugins"), {})).sort((a, b) => cmp(a[0], b[0]))
    .filter(([pid, v]) => v === true && !Object.hasOwn(installed, pid) && !["", "builtin", "inline"].includes(pluginState.splitId(pid)[1]))
    .map(([pid]) => pid);
  const markets = new Map<string, Obj>();
  const out: Obj[] = [];
  for (const pid of want) {
    const [name, m] = pluginState.splitId(pid);
    if ((performance.now() - started) / 1000 + PLUGIN_CALL_SEC > PLUGIN_BUDGET_SEC) {
      out.push({ id: pid, ok: false, code: "timeout", reason: "Not installed because the time budget ran out. Run it again" });
      continue;
    }
    if (!known.has(m) && !markets.has(m)) {
      const src = marketSource(get(or(get(ekm, m), {}), "source"));
      const r = truthy(src) ? await callPluginCli(["market-add", String(src)], store)
        : { ok: false, code: "not_found", message: `No source for marketplace ${m} in settings` };
      markets.set(m, r);
    }
    if (markets.has(m) && !truthy(get(markets.get(m), "ok"))) {
      out.push({ id: pid, ok: false, code: get(markets.get(m), "code"), reason: get(markets.get(m), "message") });
      continue;
    }
    const r = await callPluginCli(["install", "--marketplace", m, "--plugin", name, "--scope", "user"], store);
    out.push({ id: pid, ok: truthy(get(r, "ok")), code: get(r, "code"), reason: get(r, "message") });
  }
  return out;
}

async function pluginsStep(store: string, install: boolean, started: number, failed: Obj[]): Promise<Obj[]> {
  const plugins = install ? await installPlugins(store, started) : [];
  failed.push(...plugins.filter((x) => !x.ok).map((x) => ({ id: `cc.plugins/${x.id}`, code: x.code, reason: x.reason })));
  return plugins;
}

function pluginMsg(plugins: Obj[]): string {
  return plugins.length ? `, installed ${plugins.filter((x) => x.ok).length}/${plugins.length} plugins` : "";
}

type ApplyArgs = TransferOpts & ImportArgs & { bundle: string; planId: string; ids?: string; installPlugins?: boolean };

/** onDone(적용된 id 목록) 은 끝날 때 결과 필드를 보탠다(sync-pull 의 기준 갱신). */
async function applyImpl(a: ApplyArgs, onDone?: (ids: string[]) => Promise<Obj>): Promise<never> {
  const started = performance.now();
  const store = storeOf(a);
  const finish = async (ok: boolean, code: string, msg: string, ids: string[], fields: Obj): Promise<never> => {
    if (onDone) Object.assign(fields, await onDone(ids));
    emit(ok, code, msg, fields);
  };

  const b = openBundle(a.bundle);
  const pl = makePlan({ ...a, store }, b);
  if (a.planId !== pl.planId) {
    emit(false, "plan_stale", "Targets on this PC or path pairs changed after the comparison. Compare again and check", { target: b.path, plan_id: pl.planId });
  }
  const rows = new Map(pl.items.map((r) => [r.id, r]));
  const want = a.ids ? a.ids.split(",").map(stripWs).filter((x) => x)
    : pl.items.filter((r) => r.state === "new" || r.state === "changed").map((r) => r.id);
  const unknown = want.filter((x) => !rows.has(x));
  if (unknown.length) emit(false, "invalid_arg", `Items not in the plan: ${unknown.join(", ")}`, { target: "--ids" });
  const sel = want.map((x) => rows.get(x)!).filter((r) => r.state === "new" || r.state === "changed");
  const failed: Obj[] = want.filter((x) => rows.get(x)!.state === "blocked")
    .map((x) => ({ id: x, code: or(rows.get(x)!.code, "blocked"), reason: get(rows.get(x), "reason") }));
  if (!sel.length) {
    // 설정은 이미 같아도 플러그인 설치만 따로 요청할 수 있다.
    const plugins = await pluginsStep(store, !!a.installPlugins, started, failed);
    if (failed.length) await finish(false, "partial", "No items can be applied", [], { applied: [], failed, plugins });
    await finish(true, plugins.length ? "ok" : "noop", "No items to change" + pluginMsg(plugins), [], { applied: [], failed: [], plugins });
  }

  const p = ensureStore(store);
  const short = b.hash.slice(7, 15);
  // 같은 프로세스의 config_edit 편집과 스냅샷 구간이 겹치지 않게 한다. 재진입 불가라 안에서 config_edit 의 cmd* 를 부르지 않는다.
  const [pre, post, applied, wfailed] = await configEdit.withEditLock(async (): Promise<[string | null, string | null, Rec[], Obj[]]> => {
    const [span, pre] = await openSpan(p, `before import ${short}`);
    let applied: Rec[] = [], wfailed: Obj[] = [];
    let post: string | null;
    try {
      [applied, wfailed] = await applyRows(sel, store);
    } finally {
      const ids = new Set(applied.map((x) => x.id));
      const nNew = sel.filter((r) => ids.has(r.id) && r.state === "new").length;
      post = await closeSpan(span, p, `import ${short}: +${nNew} ~${ids.size - nNew}`);
    }
    return [pre, post, applied, wfailed];
  });
  const done = new Set(applied.map((x) => x.id));
  failed.push(...wfailed);

  const dropped = droppedOf(pl, done);
  const rec = { at: nowIso(), bundle: b.path, bundle_hash: b.hash, source_host: get(or(get(b.manifest, "source"), {}), "host"),
    plan_id: pl.planId, pre_snapshot: pre, post_snapshot: post, applied, dropped };
  let importId: string | null = null;
  if (applied.length) {
    await libStore.withEditCfg(store, (cfg) => {
      if (!Object.hasOwn(cfg, "imports")) cfg.imports = [];
      const imps = cfg.imports as Obj[];
      const have = new Set(imps.map((x) => get(x, "id")));
      const base = `${ts()}-${short}`;
      let id = base, n = 1;
      while (have.has(id)) {
        id = `${base}.${n}`;
        n++;
      }
      importId = id;
      imps.push({ id, ...rec });
      imps.splice(0, Math.max(0, imps.length - IMPORTS_KEEP));
    });
    await saveRoots(store, pl.sourceKey, pl.explicit, "user");
  }
  const plugins = await pluginsStep(store, !!a.installPlugins, started, failed);
  let msg = (importId ? `Import ${importId}: applied ${done.size}` : "No items were applied") + pluginMsg(plugins);
  if (failed.length) msg += `, ${failed.length} failed`;
  if (dropped.length) msg += `. Left out ${dropped.length} settings that use paths not on this PC`;
  await finish(!failed.length, failed.length ? "partial" : "ok", msg, sortStr(done), {
    target: b.path, import_id: importId, applied: applied.map(publicRec), failed, pre_snapshot: pre, post_snapshot: post,
    warnings: pl.warnings, plugins, dropped,
  });
  throw new Error("unreachable");
}

async function syncPullImpl(a: TransferOpts & ImportArgs & { syncFrom: string; planId: string; ids?: string; installPlugins?: boolean }): Promise<never> {
  const store = storeOf(a);
  const s = syncCfg(store);
  const bundle = profileDir(s, a.syncFrom);
  const onDone = async (ids: string[]): Promise<Obj> => {
    const local = localHashes(store, iter(or(get(s, "with_optional"), [])));
    const remote = remoteHashes(bundle);
    await libStore.withEditCfg(store, (cfg) => agree(cfg, a.syncFrom, local, remote, new Set(ids)));
    return { sync_from: a.syncFrom };
  };
  return applyImpl({ ...a, store, bundle }, onDone);
}

async function undoImpl(a: TransferOpts & { importId: string; force?: boolean }): Promise<never> {
  const store = storeOf(a);
  const ent = iter(or(get(libStore.loadCfg(store), "imports"), [])).find((x) => get(x, "id") === a.importId) as Obj | undefined;
  if (!ent) emit(false, "not_found", `No import record: ${a.importId}`, { target: a.importId });
  if (truthy(get(ent, "undone_at"))) emit(true, "noop", `Already undone: ${a.importId} (${pyStr(ent.undone_at)})`, { target: a.importId });
  const p = cas.storePaths(store);
  const restored: number[] = [], failed: Obj[] = [];
  const applied = ent.applied as Obj[];
  const [pre, post] = await configEdit.withEditLock(async (): Promise<[string | null, string | null]> => {
    const [span, pre] = await openSpan(p, `before undo import ${a.importId}`);
    let post: string | null;
    try {
      for (let i = applied.length - 1; i >= 0; i--) {
        const rec = applied[i];
        if (truthy(get(rec, "undone"))) continue;
        try {
          await undoRecord(rec, !!a.force);
          restored.push(i);
        } catch (e) {
          if (e instanceof CliExit) throw e;
          if (e instanceof Changed) {
            failed.push({ id: rec.id, code: "changed_since_import", target: rec.target, reason: "Changed after the import, so it was not undone (force overwrites it)" });
          } else {                           // 실패는 결과에 담고 나머지를 계속 되돌린다
            failed.push({ id: rec.id, code: "write_failed", target: rec.target, reason: excStr(e) });
          }
        }
      }
    } finally {
      post = await closeSpan(span, p, `undo import ${a.importId}`);
    }
    return [pre, post];
  });
  await libStore.withEditCfg(store, (cfg) => {
    const cur = iter(or(get(cfg, "imports"), [])).find((x) => get(x, "id") === a.importId) as Obj | undefined;
    if (cur) {
      for (const i of restored) (cur.applied as Obj[])[i].undone = true;
      if (!failed.length) cur.undone_at = nowIso();
    }
  });
  const out = restored.map((i) => applied[i].id);
  const msg = `Undid import ${a.importId}: ${out.length} restored` + (failed.length ? `, ${failed.length} failed` : "");
  emit(!failed.length, failed.length ? "partial" : "ok", msg, { target: a.importId, restored: out, failed, pre_snapshot: pre, post_snapshot: post });
}

// ----- 진입 함수 -----

export async function cmdInventory(opts: TransferOpts & { withOptional?: string }): Promise<CliDoc> {
  return guard(() => exportImpl("inventory", opts));
}

export async function cmdExport(opts: TransferOpts & { out: string; withOptional?: string; includeSecrets?: boolean }): Promise<CliDoc> {
  return guard(() => exportImpl("export", opts));
}

export async function cmdInspect(opts: TransferOpts & { bundle: string }): Promise<CliDoc> {
  return guard(() => inspectImpl(opts));
}

/** bundle 과 syncFrom 중 하나. */
export async function cmdPlan(opts: TransferOpts & ImportArgs & { bundle?: string; syncFrom?: string }): Promise<CliDoc> {
  return guard(() => planImpl(opts));
}

/** installPlugins 는 claude CLI 를 부른다(plugin_cli). */
export async function cmdApply(opts: TransferOpts & ImportArgs & { bundle: string; planId: string; ids?: string; installPlugins?: boolean }): Promise<CliDoc> {
  return guard(() => applyImpl(opts));
}

export async function cmdHistory(opts: TransferOpts): Promise<CliDoc> {
  return guard(() => historyImpl(opts));
}

export async function cmdSyncSetup(opts: TransferOpts & { dir: string; profile?: string }): Promise<CliDoc> {
  return guard(() => syncSetupImpl(opts));
}

export async function cmdSyncPush(opts: TransferOpts & { withOptional?: string; includeSecrets?: boolean }): Promise<CliDoc> {
  return guard(() => syncPushImpl(opts));
}

export async function cmdSyncStatus(opts: TransferOpts & { syncFrom?: string }): Promise<CliDoc> {
  return guard(() => syncStatusImpl(opts));
}

export async function cmdSyncPull(opts: TransferOpts & ImportArgs & { syncFrom: string; planId: string; ids?: string; installPlugins?: boolean }): Promise<CliDoc> {
  return guard(() => syncPullImpl(opts));
}

/** roots 는 {from: to} JSON 문자열. by 기본 "claude". */
export async function cmdRoots(opts: TransferOpts & { bundle?: string; syncFrom?: string; roots: string; by?: "claude" | "user" }): Promise<CliDoc> {
  return guard(() => rootsImpl(opts));
}

export async function cmdUndo(opts: TransferOpts & { importId: string; force?: boolean }): Promise<CliDoc> {
  return guard(() => undoImpl(opts));
}

function buildParser(): JsonArgumentParser {
  const ap = new JsonArgumentParser("transfer");
  ap.addArgument("--store", {});
  const sub = ap.addSubparsers({ dest: "op", required: true });
  for (const name of ["inventory", "export"]) {
    const p = sub.addParser(name);
    p.addArgument("--with-optional", { default: "" });
    if (name === "export") {
      p.addArgument("--out", { required: true });
      p.addArgument("--include-secrets", { action: "store_true" });
    }
  }
  sub.addParser("inspect").addArgument("--bundle", { required: true });
  let p = sub.addParser("plan");
  p.addArgument("--bundle", { default: "" });
  p.addArgument("--sync-from", { default: "" });
  for (const k of ["--secrets", "--choices", "--roots", "--exclude"]) p.addArgument(k, { default: "" });
  p = sub.addParser("apply");
  p.addArgument("--bundle", { required: true });
  p.addArgument("--plan-id", { required: true });
  p.addArgument("--ids", { default: "" });
  for (const k of ["--secrets", "--choices", "--roots", "--exclude"]) p.addArgument(k, { default: "" });
  p.addArgument("--install-plugins", { action: "store_true" });
  sub.addParser("history");
  p = sub.addParser("sync-setup");
  p.addArgument("--dir", { required: true });
  p.addArgument("--profile", { default: "" });
  p = sub.addParser("sync-push");
  p.addArgument("--with-optional", { default: "" });
  p.addArgument("--include-secrets", { action: "store_true" });
  sub.addParser("sync-status").addArgument("--from", { dest: "sync_from", default: "" });
  p = sub.addParser("sync-pull");
  p.addArgument("--from", { dest: "sync_from", required: true });
  p.addArgument("--plan-id", { required: true });
  p.addArgument("--install-plugins", { action: "store_true" });
  p.addArgument("--ids", { default: "" });
  for (const k of ["--secrets", "--choices", "--roots", "--exclude"]) p.addArgument(k, { default: "" });
  p = sub.addParser("roots");
  p.addArgument("--bundle", { default: "" });
  p.addArgument("--from", { dest: "sync_from", default: "" });
  p.addArgument("--roots", { required: true });
  p.addArgument("--by", { default: "claude", choices: ["claude", "user"] });
  p = sub.addParser("undo");
  p.addArgument("--import-id", { required: true });
  p.addArgument("--force", { action: "store_true" });
  return ap;
}

/** argv 는 python transfer.py 의 인자와 같다. */
export async function main(argv: string[]): Promise<CliDoc> {
  return guard(async () => {
    const a = buildParser().parse(argv) as Record<string, any>;
    const store = a.store ?? libStore.defaultStore();
    const imp = { secrets: a.secrets, choices: a.choices, roots: a.roots, exclude: a.exclude };
    switch (a.op as string) {
      case "inventory": return cmdInventory({ store, withOptional: a.with_optional });
      case "export": return cmdExport({ store, out: a.out, withOptional: a.with_optional, includeSecrets: a.include_secrets });
      case "inspect": return cmdInspect({ store, bundle: a.bundle });
      case "plan": return cmdPlan({ store, ...imp, bundle: a.bundle, syncFrom: a.sync_from });
      case "apply": return cmdApply({ store, ...imp, bundle: a.bundle, planId: a.plan_id, ids: a.ids, installPlugins: a.install_plugins });
      case "undo": return cmdUndo({ store, importId: a.import_id, force: a.force });
      case "history": return cmdHistory({ store });
      case "sync-setup": return cmdSyncSetup({ store, dir: a.dir, profile: a.profile });
      case "sync-push": return cmdSyncPush({ store, withOptional: a.with_optional, includeSecrets: a.include_secrets });
      case "sync-status": return cmdSyncStatus({ store, syncFrom: a.sync_from });
      case "sync-pull": return cmdSyncPull({ store, ...imp, syncFrom: a.sync_from, planId: a.plan_id, ids: a.ids, installPlugins: a.install_plugins });
      default: return cmdRoots({ store, bundle: a.bundle, syncFrom: a.sync_from, roots: a.roots, by: a.by });
    }
  });
}
