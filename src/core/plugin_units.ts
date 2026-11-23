// plugin_units.ts - hooks / MCP 서버 설치 유닛. src/plugin_units.py 이식.
//
// agents/skills/commands 는 leaf 가 자기완결적이라 ~/.claude 로 복사한다. hooks 는 아니다:
// 2개 플러그인이 ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/ 를 참조한다(hooks/ 의 형제 디렉토리).
// 설치 단위는 hooks/ 가 아니라 플러그인 루트 전체다.
//
// 그래서 vendoring 하지 않는다 - fetch 된 플러그인 루트를 캐시에 그대로 두고
// ${CLAUDE_PLUGIN_ROOT} 를 그 절대 캐시 경로로 치환한 엔트리를 settings.json 에 병합한다.
// 결과로 캐시가 load-bearing 이 되고, 원장이 그 삭제를 막는다.
//
// 함정: 명령을 정규식으로 뽑으면 이스케이프된 \" 에서 잘려 0건 오답이 난다.
// 반드시 JSON 으로 파싱한 구조에서 읽는다.
//
// 이 모듈은 이미 fetch 된 파일 위의 순수 로직이다. library/remote_fetch/marketplace 를
// import 하지 않는다 - 네트워크도, git 도, 프로세스도 없다. lib_store 에서는 Python 호환 JSON 도우미만 쓴다.
import fs from "node:fs";
import path from "node:path";
import {
  basename, dirname, isValueError, normcase, normpath, pjoin, psplit, pyEq as pyEqValue, pyTruthy, pyTypeName, PyFloat, readJsonFile,
  splitroot, type LoadsOptions,
} from "./lib_store.ts";

export const PLUGIN_ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";
export const HOOKS_REL = path.join("hooks", "hooks.json");
export const MCP_REL = ".mcp.json";
export const PLUGIN_JSON_REL = path.join(".claude-plugin", "plugin.json");
export const UNIT_SKIP: readonly string[] = ["node_modules", "__pycache__"];

/** shutil.which 대용. 찾지 못하면 null. */
export type Which = (cmd: string) => string | null;

export interface InterpreterCheck {
  interp: string;
  ok: boolean;
  reason: "" | "missing" | "stub";
  path?: string;
}

// ----- Python 의미를 맞추는 도우미(plugin_state, claude_config 도 쓴다) -----
// os.path(ntpath) 는 join 에서 구분자를 바꾸지 않고, normpath 는 끝 구분자를 뗀다. node:path 와 결과가 다르다.

const WIN = process.platform === "win32";
const SEP = WIN ? "\\" : "/";

/** Python str.isspace 가 참인 문자. JS \s 와 다르다(\x1c-\x1f, \x85 포함, ﻿ 제외). */
export const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${PY_WS}]+`);
const WS_LEAD = new RegExp(`^[${PY_WS}]+`);
const WS_TRAIL = new RegExp(`[${PY_WS}]+$`);
const WS_ONE = new RegExp(`^[${PY_WS}]$`);

export function pyStrip(s: string): string {
  return s.replace(WS_LEAD, "").replace(WS_TRAIL, "");
}

export function pyIsSpace(c: string): boolean {
  return WS_ONE.test(c);
}

// os.path 도우미는 lib_store 의 것을 쓴다(같은 ntpath 이식을 두 벌 두지 않는다).
export const pySplitroot = splitroot, pyJoin = pjoin, pySplit = psplit, pyDirname = dirname, pyBasename = basename;
export const pyNormpath = normpath, pyNormcase = normcase;

/** os.path.isabs(3.12 ntpath): 앞 3자에서 구분자로 시작하거나 드라이브 뒤에 구분자가 온다. */
export function pyIsabs(p: string): boolean {
  if (!WIN) return p.startsWith("/");
  const s = p.slice(0, 3).replace(/\//g, "\\");
  return s.startsWith("\\") || s.slice(1).startsWith(":\\");
}

/** Python 참거짓: None, False, 0, "", [], {} 가 거짓. */
export function truthy(v: unknown): boolean {
  return pyTruthy(v);
}

/** Python `x or y`. */
export function or<T, U>(v: T, d: U): T | U {
  return truthy(v) ? v : d;
}

export function isDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof PyFloat);
}

const typeName = pyTypeName;

/** dict.get(k, d): 키가 있으면 값이 null 이어도 그 값. dict 가 아니면 AttributeError 처럼 던진다. */
export function pyGet(o: unknown, k: string, d: unknown = null): unknown {
  if (!isDict(o)) throw new TypeError(`AttributeError: '${typeName(o)}' object has no attribute 'get'`);
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d;
}

/** for x in v: list 는 원소, str 은 문자, dict 는 키. 그 밖은 TypeError. */
export function pyIter(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (isDict(v)) return Object.keys(v);
  throw new TypeError(`'${typeName(v)}' object is not iterable`);
}

export function pyLen(v: unknown): number {
  if (typeof v === "string") return [...v].length;
  if (Array.isArray(v)) return v.length;
  if (isDict(v)) return Object.keys(v).length;
  throw new TypeError(`object of type '${typeName(v)}' has no len()`);
}

/** dict.items(). dict 가 아니면 던진다. */
export function pyItems(v: unknown): [string, unknown][] {
  if (!isDict(v)) throw new TypeError(`AttributeError: '${typeName(v)}' object has no attribute 'items'`);
  return Object.entries(v);
}

/** Python == (dict 는 키 순서 무시, list 는 순서 비교, True == 1, 1 == 1.0). */
export function pyEq(a: unknown, b: unknown): boolean {
  return pyEqValue(a ?? null, b ?? null);
}

/** utf-8-sig 로 읽어 Python json.load 처럼 파싱. 잘못된 utf-8 은 던진다(Python strict 디코드와 같다). */
export function loadJsonSig(p: string, opts: LoadsOptions = {}): unknown {
  return readJsonFile(p, opts);
}

/** os.path.exists(링크를 따라간다). */
export function pyExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function pyIsdir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 재귀 순회의 링크 순환 방지용 키(실제 경로). 폴더 판정이 정션·링크를 따라가므로, 조상 폴더를 가리키는
 * 정션이 있으면 Windows 의 재해석 한도(63단계)까지 같은 항목을 되풀이해 나열한다.
 * Python 판은 MAX_PATH 에서 멈추지만 Node 는 긴 경로를 받아 그보다 훨씬 깊이 내려간다.
 */
export function realKey(p: string): string {
  try {
    return pyNormcase(fs.realpathSync.native(p));
  } catch {
    return pyNormcase(pyNormpath(p));
  }
}

/** 조상 집합에 dir 을 넣고 fn 을 실행한다. dir 이 이미 조상이면(순환) 실행하지 않는다. */
export function withinOnce(ancestors: Set<string>, dir: string, fn: () => void): void {
  const key = realKey(dir);
  if (ancestors.has(key)) return;
  ancestors.add(key);
  try {
    fn();
  } finally {
    ancestors.delete(key);
  }
}

/** 키를 원형대로 담는다(__proto__ 같은 이름도 자기 속성이 되게). */
function put(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

// ----- 모듈 본문 -----

/** 중첩 구조의 모든 문자열에서 ${CLAUDE_PLUGIN_ROOT} 를 root 로 치환. 입력을 변형하지 않는다. */
export function substitute<T>(obj: T, root: string): T {
  if (typeof obj === "string") return obj.split(PLUGIN_ROOT_VAR).join(root) as T;
  if (Array.isArray(obj)) return obj.map((x) => substitute(x, root)) as T;
  if (isDict(obj)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) put(out, k, substitute(v, root));
    return out as T;
  }
  return obj;
}

/** 파일이 없으면 null. 파싱 실패는 던진다. */
export function loadHooksJson(pluginRoot: string, opts: LoadsOptions = {}): unknown {
  const p = pyJoin(pluginRoot, HOOKS_REL);
  if (!pyExists(p)) return null;
  return loadJsonSig(p, opts);
}

/**
 * 플러그인의 MCP 서버 선언. 소스가 둘이다.
 *
 * 표준은 루트의 `.mcp.json` 이지만, plugin.json 안에 mcpServers 를 인라인으로 선언하는
 * 플러그인도 있다(실측: chrome-devtools-mcp 1.6.0). `.mcp.json` 만 보면 그런 플러그인은
 * 조용히 "MCP 0건"이 되어 설치할 게 없다고 나온다 - 대시보드 표시와 설치 가능 건수가
 * 어긋나는 자리다. 공식 마켓 레포 내 40개는 전부 파일 방식이고 인라인은 외부 레포에서
 * 가져온 플러그인 쪽에서 나온다.
 *
 * 반환 형태는 두 경로가 같다(`{"mcpServers": {...}}`) - 호출부는 구분할 필요가 없다.
 * `.mcp.json` 이 있으면 그쪽이 이긴다(명시 파일이 더 구체적인 선언이다).
 */
export function loadMcpJson(pluginRoot: string, opts: LoadsOptions = {}): unknown {
  const p = pyJoin(pluginRoot, MCP_REL);
  if (pyExists(p)) return loadJsonSig(p, opts);
  const meta = pyJoin(pluginRoot, PLUGIN_JSON_REL);
  if (!pyExists(meta)) return null;
  const data = loadJsonSig(meta, opts);
  const servers = isDict(data) ? pyGet(data, "mcpServers") : null;
  return isDict(servers) && truthy(servers) ? { mcpServers: servers } : null;
}

/**
 * 설치 버튼을 띄울지 판정. loadMcpJson 과 같은 두 소스를 본다 -
 * exists(".mcp.json") 만 보던 자리가 인라인 선언 플러그인에서 버튼을 안 띄웠다.
 */
export function hasMcp(pluginRoot: string): boolean {
  if (pyExists(pyJoin(pluginRoot, MCP_REL))) return true;
  try {
    return truthy(pyGet(or(loadMcpJson(pluginRoot), {}), "mcpServers"));
  } catch (e) {
    if (isLoadError(e)) return false;
    throw e;
  }
}

/** Python (OSError, ValueError) 에 해당하는 것: 파일 시스템 오류, JSON 문법 오류, utf-8 디코드 오류. */
export function isLoadError(e: unknown): boolean {
  if (e instanceof SyntaxError || isValueError(e)) return true;
  if (!(e instanceof Error)) return false;
  const code = (e as NodeJS.ErrnoException).code;
  return typeof code === "string" && (/^E[A-Z]+$/.test(code) || code === "ERR_ENCODING_INVALID_ENCODED_DATA");
}

export function isUnit(root: string): boolean {
  return pyExists(pyJoin(root, HOOKS_REL)) || hasMcp(root);
}

/**
 * lib 아래 깊이 depth 까지에서 hooks/hooks.json 또는 MCP 선언을 가진 디렉토리.
 *
 * 라이브러리 하나가 도구 여러 개를 나란히 담는 구조(Hooks/<name>, servers/<name>)를 위한
 * 것이라 lib 자체는 제외하고(루트는 호출부가 따로 본다) 유닛 안으로는 더 내려가지 않는다.
 * 나열 실패는 그 가지만 포기한다 - 목록 전체가 비는 것보다 한 가지가 빠지는 쪽이 낫다.
 */
export function findUnits(lib: string, depth = 2): string[] {
  const found: string[] = [];
  const walk = (d: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => cmpCodePoints(a.name, b.name));
    for (const e of entries) {
      if (e.name.startsWith(".") || UNIT_SKIP.includes(e.name)) continue;
      const full = pyJoin(d, e.name);
      // Python 의 is_dir(follow_symlinks=False) 는 정션을 폴더로 본다. Node 는 정션과 심볼릭 링크를
      // 같은 링크로 보고하고 둘을 구분하지 못하므로, 링크는 대상이 폴더인지 따라가서 판정한다.
      if (!(e.isDirectory() || (e.isSymbolicLink() && pyIsdir(full)))) continue;
      if (isUnit(full)) found.push(full);
      else if (level < depth) walk(full, level + 1);
    }
  };
  walk(lib, 1);
  return found;
}

function cmpCodePoints(a: string, b: string): number {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

/**
 * 파싱된 구조에서 모든 command 문자열을 뽑는다(정규식 금지).
 *
 * hooksCfg 가 null 이면 아무것도 하지 않는다 - loadHooksJson 은 hooks.json 이 없는
 * (39개 중 33개가 이 경우다) 흔한 케이스에서 null 을 돌려주며, 그건 오류가 아니다.
 */
export function hookCommands(hooksCfg: unknown): string[] {
  const cmds: string[] = [];
  const hooks = or(pyGet(or(hooksCfg, {}), "hooks"), {});
  if (!isDict(hooks)) throw new TypeError("AttributeError: object has no attribute 'values'");
  for (const entries of Object.values(hooks)) {
    for (const entry of pyIter(or(entries, []))) {
      for (const h of pyIter(or(pyGet(entry, "hooks"), []))) {
        const c = pyGet(h, "command");
        if (typeof c === "string") cmds.push(c);
      }
    }
  }
  return cmds;
}

function norm(p: string): string {
  return pyNormcase(pyNormpath(p));
}

/**
 * 이 hook 하나가 root 아래를 가리키는가.
 *
 * 문자열 매칭을 쓰지 않는다. config_edit.op_hook_remove 는
 * `needle not in json.dumps(h, ensure_ascii=False)` 로 직렬화 결과에 매칭하는데,
 * JSON 이 \\ 를 \\\\ 로 이스케이프하므로 raw Windows 경로 needle 은 영원히 0건이 된다.
 * 조용히 실패해서 재설치마다 엔트리가 중복 누적된다(findings.md §8 실측).
 *
 * 대신 파싱된 구조의 command 를 직접 읽고 정규화 경로로 비교한다.
 */
export function hookRefsRoot(hook: unknown, root: string): boolean {
  const c = isDict(hook) ? pyGet(hook, "command") : null;
  if (typeof c !== "string") return false;
  // 명령은 따옴표/인자와 섞여 있다. 정규화 후 부분 매치를 찾되, 매치 다음 문자가
  // 경로 경계(구분자/따옴표/공백/끝)인지 본다 - 경계 없는 부분문자열 매칭은
  // .../plugins/foo 가 .../plugins/foo-bar 의 hook 까지 지운다
  // (ledger_refs_root 가 os.sep 접두 가드를 쓰는 것과 같은 근거).
  const nr = norm(root), nc = norm(c);
  let i = 0;
  for (;;) {
    i = nc.indexOf(nr, i);
    if (i < 0) return false;
    const j = i + nr.length;
    if (j >= nc.length || [SEP, "/", '"', "'"].includes(nc[j]) || pyIsSpace(nc[j])) return true;
    i += 1;
  }
}

/** 엔트리의 hook 중 하나라도 root 를 가리키는가. entry 가 null 이면 false - 크래시 대신 no-op. */
export function entryRefsRoot(entry: unknown, root: string): boolean {
  if (!truthy(entry)) return false;
  return pyIter(or(pyGet(entry, "hooks"), [])).some((h) => hookRefsRoot(h, root));
}

function hooksOf(settings: Record<string, unknown>): Record<string, unknown> {
  const h = or(pyGet(settings, "hooks"), {});
  if (!isDict(h)) throw new TypeError("settings.hooks is not an object");
  return h;
}

/**
 * settings 에서 root 를 가리키는 hook 을 전부 제거. [settings, 제거한 hook 수].
 *
 * 엔트리가 아니라 hook 단위로 지운다. 한 엔트리(같은 matcher)에 다른 도구의 hook 이
 * 나란히 들어 있을 수 있어서(실측: PostToolUse Edit|Write 한 엔트리에 comment-linter 와
 * convention-enforcer), 엔트리째 지우면 남의 hook 이 딸려 나간다. hook 이 하나도 안 남은
 * 엔트리만 떨어진다.
 */
export function hooksRemove(settings: Record<string, unknown>, root: string): [Record<string, unknown>, number] {
  const hooks = hooksOf(settings);
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const keep: unknown[] = [];
    for (const e of pyIter(hooks[event])) {
      const hs = isDict(e) ? pyIter(or(pyGet(e, "hooks"), [])) : [];
      const left = hs.filter((h) => !hookRefsRoot(h, root));
      removed += hs.length - left.length;
      if (left.length === hs.length) keep.push(e);
      else if (left.length) keep.push({ ...(e as Record<string, unknown>), hooks: left });
    }
    if (keep.length) hooks[event] = keep;
    else delete hooks[event];   // 빈 배열을 남기지 않는다(설정 파일이 지저분해진다)
  }
  if (truthy(hooks)) settings.hooks = hooks;
  else delete settings.hooks;
  return [settings, removed];
}

function hookCount(e: unknown): number {
  return pyLen(or(pyGet(e, "hooks"), []));
}

/**
 * hooks.json 을 matcher·timeout 그대로 병합. [settings, 제거 hook 수, 추가 hook 수].
 *
 * hooksCfg 가 null 이면(플러그인에 hooks.json 자체가 없는 흔한 경우 - loadHooksJson 이
 * 돌려주는 값) 아무것도 하지 않는다.
 *
 * 멱등성은 두 가지 독립된 메커니즘으로 이룬다. 서로 다른 실패 모드를 잡기 때문에
 * 하나가 다른 하나를 대체하지 못한다:
 *
 * 1. root 기반 제거(기존): 삽입 전에 oldRoot(원장의 root, 없으면 newRoot)를 가리키는
 *    엔트리를 먼저 걷어낸다. oldRoot 를 쓰는 이유 - 캐시 경로가 plugins/<name>/<sha>/ 로
 *    sha 를 품고 있어서 sha 가 바뀌면 settings 의 기존 엔트리는 옛 경로를 가리킨다.
 *    새 경로로 지우면 못 걷어내고 새 엔트리가 나란히 쌓인다.
 * 2. identity 기반 제거(신규): root 기반 제거는 command 안에 root 문자열이 있는 엔트리만
 *    찾는다. hooks.json 의 command 가 ${CLAUDE_PLUGIN_ROOT} 를 전혀 안 쓰고 전역 도구를
 *    그대로 부르는 형태(유효한 hooks.json 이다)면 root 로는 절대 못 찾아서, 삽입할 때마다
 *    그 엔트리가 그대로 쌓인다 - uninstall 도 못 찾는 영구 중복. 그래서 삽입 직전에,
 *    이번에 추가하려는(치환 후) 엔트리와 구조적으로 동일한 기존 엔트리를 이벤트별로
 *    먼저 걷어낸다. 부작용: 사용자의 hook 이 플러그인 것과 완전히 같으면 하나로 합쳐진다 -
 *    둘이 구분 불가능하므로 결과 동작은 동일해서 괜찮다. 내용이 다른 사용자 hook 은
 *    이 필터에 걸리지 않으므로 그대로 남는다.
 *
 * 빈 이벤트 배열(hooks.json 에 이벤트가 [] 로 선언된 경우)은 settings 에 빈 키를
 * 만들지 않는다.
 */
export function hooksMerge(settings: Record<string, unknown>, hooksCfg: unknown, newRoot: string, oldRoot?: string | null): [Record<string, unknown>, number, number] {
  if (!truthy(hooksCfg)) return [settings, 0, 0];
  let removed: number;
  [settings, removed] = hooksRemove(settings, oldRoot || newRoot);
  if (oldRoot && norm(oldRoot) !== norm(newRoot)) {
    const [s, extra] = hooksRemove(settings, newRoot);   // 부분 실패 잔재도 정리
    settings = s;
    removed += extra;
  }
  const subbed = substitute(hooksCfg, newRoot);
  const hooks = hooksOf(settings);
  let added = 0;
  const events = or(pyGet(subbed, "hooks"), {});
  for (const [event, raw] of pyItems(events)) {
    const entries = or(raw, []);
    if (!truthy(entries)) continue;                    // 빈 배열은 빈 키를 만들지 않는다
    if (!Array.isArray(entries)) throw new TypeError(`hooks.${event} is not an array`);
    const existing = pyIter(Object.prototype.hasOwnProperty.call(hooks, event) ? hooks[event] : []);
    const inEntries = (e: unknown) => entries.some((x) => pyEq(e, x));
    const keep = existing.filter((e) => !inEntries(e));   // identity 기반 제거
    removed += existing.filter(inEntries).reduce((n: number, e) => n + hookCount(e), 0);
    hooks[event] = [...keep, ...entries];
    added += entries.reduce((n: number, e) => n + hookCount(e), 0);
  }
  if (truthy(hooks)) settings.hooks = hooks;
  else delete settings.hooks;
  return [settings, removed, added];
}

/** 명령의 첫 토큰(인터프리터). 따옴표로 감싼 경로를 지원한다. */
export function firstToken(command: string): string {
  const s = pyStrip(command || "");
  if (!s) return "";
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    const end = s.indexOf(q, 1);
    return end > 0 ? s.slice(1, end) : s.slice(1);
  }
  return s.split(WS_RUN)[0];
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC";

function accessCheck(p: string): boolean {
  try {
    if (fs.statSync(p).isDirectory()) return false;
    if (!WIN) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * shutil.which(cmd) (Python 3.12, mode=F_OK|X_OK). PATHEXT 확장자는 대소문자 그대로 붙인다(claude.EXE).
 * PATH 가 없으면 os.defpath 를, 빈 문자열이면 찾지 않는다(bpo-35755). 이 저장소의 which 는 이것 하나다.
 */
export function pyWhich(cmd: string): string | null {
  const [dir, base] = pySplit(cmd);
  let dirs: string[];
  if (dir) dirs = [dir];
  else {
    const p = process.env.PATH ?? (WIN ? ".;C:\\bin" : "/bin:/usr/bin");
    if (p === "") return null;
    dirs = p.split(WIN ? ";" : ":");
    // NeedCurrentDirectoryForExePath: 이 env 가 없으면 현재 폴더를 먼저 본다.
    if (WIN && process.env.NoDefaultCurrentDirectoryInExePath === undefined) dirs.unshift(".");
  }
  let files = [base];
  if (WIN) {
    const exts = (process.env.PATHEXT || DEFAULT_PATHEXT).split(";").filter(Boolean).map((e) => e.replace(/\.+$/, ""));
    files = exts.map((e) => base + e);
    const up = base.toUpperCase();
    if (exts.some((e) => up.endsWith(e.toUpperCase()))) files.unshift(base);
  }
  const seen = new Set<string>();
  for (const d of dirs) {
    const nd = pyNormcase(d);
    if (seen.has(nd)) continue;
    seen.add(nd);
    for (const f of files) {
      const name = pyJoin(d, f);
      if (accessCheck(name)) return name;
    }
  }
  return null;
}

/**
 * 설치 전 인터프리터 점검. 차단하지 않고 경고 배지 재료를 돌려준다.
 *
 * WindowsApps 별칭 스텁을 따로 잡는 이유: 이 머신의 python3 는 shutil.which 로 찾아지지만
 * 실행하면 'Python was not found' 를 낸다 - 설치해도 조용히 실패할 hook 이다.
 */
export function checkInterpreter(command: string, which?: Which): InterpreterCheck {
  const w = which || pyWhich;
  const interp = firstToken(command);
  if (!interp) return { interp: "", ok: true, reason: "" };
  if (interp.includes(SEP) || (WIN && interp.includes("/"))) {
    const ok = pyExists(interp);     // 절대/상대 경로로 준 경우
    return { interp, ok, reason: ok ? "" : "missing" };
  }
  const found = w(interp);
  if (!found) return { interp, ok: false, reason: "missing" };
  if (norm(found).includes("windowsapps")) return { interp, ok: false, reason: "stub", path: found };
  return { interp, ok: true, reason: "", path: found };
}

/** 문제 있는 인터프리터만(정상은 안 담는다). 중복 제거. */
export function interpreterWarnings(hooksCfg: unknown, which?: Which): InterpreterCheck[] {
  const seen = new Set<string>();
  const warns: InterpreterCheck[] = [];
  for (const c of hookCommands(hooksCfg)) {
    const r = checkInterpreter(c, which);
    if (!r.ok && !seen.has(r.interp)) {
      seen.add(r.interp);
      warns.push(r);
    }
  }
  return warns;
}

