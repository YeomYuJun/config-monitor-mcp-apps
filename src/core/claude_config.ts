// claude_config.ts - Claude 설정 introspection(정규화 sections JSON). src/claude_config.py 이식.
//
// 대상 경로:
//   ~\.claude.json                                  Claude Code 전역 (관심 키만 선별 추출)
//   ~\.claude\settings.json                         permission allow/deny + hooks
//   ~\.claude\skills\*                              Code 스킬
//   ~\.claude\agents\*                              Code 에이전트
//   ~\Claude\Scheduled\*\SKILL.md                   스케줄러
//   <Desktop>\claude_desktop_config.json            Desktop MCP
//   <Desktop>\...\skills-plugin\**\manifest.json    Desktop 스킬(서버관리, 동기화 캐시)
//     <Desktop> = Win32 설치본은 %APPDATA%\Claude, MSIX/Store 설치본은 패키지 하위 경로.
//     설치 방식에 따라 다르므로 paths 가 두 후보를 프로브해 해석한다.
import fs from "node:fs";
import { compareCodePoints, emit, guard, JsonArgumentParser, pyDumps, pyRepr, type CliDoc } from "./cli_result.ts";
// Win32/MSIX 겸용 Claude Desktop 디렉토리 해석(read 와 write 가 같은 경로를 보게 한다)
import { expanduser, RESERVED_SKILL_DIRS, resolveDesktopDir } from "./paths.ts";
// 플러그인 레지스트리 조회(읽기 전용). 순수 모듈 - 네트워크/프로세스 없음
import { defaultPluginsDir, itemCounts, readPlugins, type PluginRecord } from "./plugin_state.ts";
import {
  isDict, or, PY_WS, pyBasename, pyDirname, pyExists, pyGet, pyIsabs, pyIsdir, pyItems, pyIter, pyJoin, pyLen,
  pyNormcase, pyNormpath, pySplit, pyStrip, realKey, truthy, withinOnce,
} from "./plugin_units.ts";

/** discover() 결과. 키는 src/claude_config.py 의 CANDIDATES, 값은 절대경로·null·(desktop_skill_manifest_glob 만) 경로 배열. */
export type Found = Record<string, string | string[] | null>;

export interface Card {
  name: string;
  badge: string | null;
  ok: boolean;
  kv: [string, string][];
  edit?: Record<string, unknown>;
  scope?: "project";
  project?: string;
  source?: string;
  plugin?: string;
  builtin?: true;
  load?: "eager" | "lazy" | "never";
  [key: string]: unknown;
}

export interface Section {
  id: string;
  title: string;
  group: string;
  source: string | null;
  cards: Card[];
  load?: string;
  note?: string;
}

export interface ConfigState {
  generated: string;
  sources: Found;
  sections: Section[];
}

type Obj = Record<string, unknown>;
type Kv = [string, unknown][];

const WIN = process.platform === "win32";
const SEP = WIN ? "\\" : "/";

// ----- Python 값 표기 -----

/** Python str(). */
function pyStrOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  return pyRepr(v);
}

/** sep.join(items): 원소가 str 이 아니면 Python 처럼 TypeError. */
function strJoin(sep: string, items: unknown): string {
  const xs = pyIter(items);
  xs.forEach((x, i) => {
    if (typeof x !== "string") throw new TypeError(`sequence item ${i}: expected str instance`);
  });
  return xs.join(sep);
}

/** `k in container`. dict 는 키, list 는 원소, str 은 부분 문자열. */
function pyContains(container: unknown, k: string): boolean {
  if (isDict(container)) return Object.prototype.hasOwnProperty.call(container, k);
  if (Array.isArray(container)) return container.includes(k);
  if (typeof container === "string") return container.includes(k);
  throw new TypeError("argument of type is not iterable");
}

function put(o: Obj, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function cmpStr(a: string, b: string): number {
  return compareCodePoints(a, b);
}

/** Python 의 a < b 비교(str 끼리, 수끼리). 섞이면 TypeError. */
function pyCmp(a: unknown, b: unknown): number {
  const num = (x: unknown) => (typeof x === "boolean" ? Number(x) : x);
  const x = num(a), y = num(b);
  if (typeof x === "number" && typeof y === "number") return x - y;
  if (typeof x === "string" && typeof y === "string") return cmpStr(x, y);
  throw new TypeError("'<' not supported between instances");
}

function isoNow(): string {
  // datetime.now().isoformat(): 로컬 naive, 마이크로초가 0 이면 생략
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const us = d.getMilliseconds() * 1000;
  return us ? `${base}.${p(us, 6)}` : base;
}

// ----- os.path / glob / tempfile -----

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function listdir(d: string): string[] {
  return fs.readdirSync(d);
}

function sortedListdir(d: string): string[] {
  return listdir(d).sort(cmpStr);
}

function getsize(p: string): number {
  return fs.statSync(p).size;
}

function splitext(p: string): [string, string] {
  const sepIndex = Math.max(p.lastIndexOf("/"), WIN ? p.lastIndexOf("\\") : -1);
  const dotIndex = p.lastIndexOf(".");
  if (dotIndex > sepIndex) {
    for (let i = sepIndex + 1; i < dotIndex; i++) {
      if (p[i] !== ".") return [p.slice(0, dotIndex), p.slice(dotIndex)];
    }
  }
  return [p, ""];
}

/** os.path.realpath(strict=False). 없는 꼬리는 남기고 있는 앞부분만 푼다. realpathSync.native 는 8.3 이름을 푼다. */
function realpath(p: string): string {
  let cur = pyNormpath(p);
  if (!pyIsabs(cur)) cur = pyJoin(process.cwd(), cur);
  let tail = "";
  while (cur) {
    try {
      const r = fs.realpathSync.native(cur);
      return tail ? pyJoin(r, tail) : r;
    } catch {
      const [head, name] = pySplit(cur);
      if (head && !name) return head + tail;
      tail = tail ? pyJoin(name, tail) : name;
      cur = head;
    }
  }
  return tail;
}

/** tempfile.gettempdir: TMPDIR, TEMP, TMP, 플랫폼 기본값, cwd 중 처음 쓸 수 있는 폴더. */
function gettempdir(): string {
  const cands: string[] = [];
  for (const k of ["TMPDIR", "TEMP", "TMP"]) {
    const v = process.env[k];
    if (v) cands.push(v);
  }
  if (WIN) {
    const sr = process.env.SYSTEMROOT;
    cands.push(expanduser("~\\AppData\\Local\\Temp"), sr !== undefined ? `${sr}\\Temp` : "%SYSTEMROOT%\\Temp",
      "c:\\temp", "c:\\tmp", "\\temp", "\\tmp");
  } else cands.push("/tmp", "/var/tmp", "/usr/tmp");
  cands.push(process.cwd());
  for (const c of cands) {
    const abs = pyNormpath(pyIsabs(c) ? c : pyJoin(process.cwd(), c));
    try {
      if (fs.statSync(abs).isDirectory()) {
        fs.accessSync(abs, fs.constants.W_OK);
        return abs;
      }
    } catch {
      continue;
    }
  }
  return process.cwd();
}

const hasMagic = (s: string) => /[*?[]/.test(s);
const isHidden = (s: string) => s[0] === ".";

function fnmatchRe(pat: string): RegExp {
  let res = "";
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const c = pat[i++];
    if (c === "*") {
      while (pat[i] === "*") i++;
      res += "[\\s\\S]*";
    } else if (c === "?") res += "[\\s\\S]";
    else if (c === "[") {
      let j = i;
      if (j < n && pat[j] === "!") j++;
      if (j < n && pat[j] === "]") j++;
      while (j < n && pat[j] !== "]") j++;
      if (j >= n) res += "\\[";
      else {
        let stuff = pat.slice(i, j).replace(/\\/g, "\\\\");
        i = j + 1;
        if (stuff[0] === "!") stuff = "^" + stuff.slice(1);
        else if (stuff[0] === "^") stuff = "\\" + stuff;
        res += `[${stuff}]`;
      }
    } else res += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^(?:${res})$`, "u");
}

function fnFilter(names: string[], pat: string): string[] {
  const re = fnmatchRe(pyNormcase(pat));
  return names.filter((x) => re.test(pyNormcase(x)));
}

function iterdir(d: string, dironly: boolean): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(d || ".", { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    // DirEntry.is_dir() 는 링크를 따라간다
    if (!dironly || e.isDirectory() || (e.isSymbolicLink() && pyIsdir(d ? pyJoin(d, e.name) : e.name))) out.push(e.name);
  }
  return out;
}

const gjoin = (a: string, b: string) => (!a || !b ? a || b : pyJoin(a, b));

function glob1(d: string, pattern: string, dironly: boolean): string[] {
  let names = iterdir(d, dironly);
  if (!isHidden(pattern)) names = names.filter((x) => !isHidden(x));
  return fnFilter(names, pattern);
}

function glob0(d: string, basename: string): string[] {
  if (basename) return lexists(gjoin(d, basename)) ? [basename] : [];
  return pyIsdir(d) ? [basename] : [];
}

function* rlistdir(d: string, dironly: boolean, anc: Set<string>): Generator<string> {
  // 링크 순환 방지(realKey 참고): 조상 폴더로 되돌아가는 링크 아래는 나열하지 않는다
  const key = realKey(d || ".");
  if (anc.has(key)) return;
  anc.add(key);
  try {
    for (const x of iterdir(d, dironly)) {
      if (isHidden(x)) continue;
      yield x;
      const p = d ? gjoin(d, x) : x;
      for (const y of rlistdir(p, dironly, anc)) yield gjoin(x, y);
    }
  } finally {
    anc.delete(key);
  }
}

function* glob2(d: string, _pattern: string, dironly: boolean): Generator<string> {
  if (!d || pyIsdir(d)) yield "";
  yield* rlistdir(d, dironly, new Set());
}

/** glob.glob(pathname, recursive). Windows 에서 대소문자를 무시하고 '*' 는 점 이름을 빼며, '**' 는 숨김 폴더로 내려가지 않는다. */
function* iglob(pathname: string, recursive: boolean, dironly: boolean): Generator<string> {
  const [dirname, basename] = pySplit(pathname);
  if (!hasMagic(pathname)) {
    if (basename) {
      if (lexists(pathname)) yield pathname;
    } else if (pyIsdir(dirname)) yield pathname;
    return;
  }
  const rec = recursive && basename === "**";
  if (!dirname) {
    yield* rec ? glob2("", basename, dironly) : glob1("", basename, dironly);
    return;
  }
  const dirs: Iterable<string> = dirname !== pathname && hasMagic(dirname) ? iglob(dirname, recursive, true) : [dirname];
  for (const d of dirs) {
    const names = hasMagic(basename) ? (rec ? [...glob2(d, basename, dironly)] : glob1(d, basename, dironly)) : glob0(d, basename);
    for (const name of names) yield pyJoin(d, name);
  }
}

function glob(pattern: string, recursive = false): string[] {
  return [...iglob(pattern, recursive, false)];
}

// ----- 탐색 -----

function candidates(): Record<string, string[]> {
  const home = expanduser("~");
  // Desktop 데이터 디렉토리('...\Claude')는 설치 방식(Win32 vs MSIX/Store)에 따라
  // 물리 경로가 다르므로 후보를 프로브해 해석한다. config·skills-plugin manifest 둘 다 하위.
  const desktop = resolveDesktopDir();
  return {
    claude_json: [pyJoin(home, ".claude.json")],
    code_settings: [pyJoin(home, ".claude", "settings.json"), pyJoin(home, ".claude", "settings.local.json")],
    skills_dir: [pyJoin(home, ".claude", "skills")],
    agents_dir: [pyJoin(home, ".claude", "agents")],
    commands_dir: [pyJoin(home, ".claude", "commands")],
    plugins_dir: [pyJoin(home, ".claude", "plugins")],
    rules_dir: [pyJoin(home, ".claude", "rules")],
    output_styles_dir: [pyJoin(home, ".claude", "output-styles")],
    user_claude_md: [pyJoin(home, ".claude", "CLAUDE.md")],
    workflows_dir: [pyJoin(home, ".claude", "workflows")],
    themes_dir: [pyJoin(home, ".claude", "themes")],
    agent_memory_dir: [pyJoin(home, ".claude", "agent-memory")],
    scheduled_dir: [pyJoin(home, "Claude", "Scheduled")],
    desktop_config: [pyJoin(desktop, "claude_desktop_config.json")],
    desktop_skill_manifest_glob: [pyJoin(desktop, "local-agent-mode-sessions", "skills-plugin", "**", "manifest.json")],
  };
}

function firstExisting(ps: string[]): string | null {
  for (const p of ps) if (pyExists(p)) return p;
  return null;
}

function allGlob(patterns: string[]): string[] {
  const out = new Set<string>();
  for (const pat of patterns) for (const p of glob(pat, true)) out.add(p);
  return [...out].sort(cmpStr);
}

/** 파싱한 JSON, 실패하면 {"__error__": 오류 문장}. */
export function safeLoad(filePath: string): unknown {
  // utf-8-sig: PowerShell 이 남긴 BOM 을 파싱 오류로 오인하지 않게(BOM 없는 파일도 동일 처리).
  try {
    let text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filePath));
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (e) {
    return { __error__: e instanceof Error ? e.message : String(e) };
  }
}

/** null/비-dict 를 빈 dict 로. 손편집으로 남은 null 하나에 dump 전체가 죽지 않게 한다. */
function asDict(v: unknown): Obj {
  return isDict(v) ? v : {};
}

/** null/비-list 를 빈 list 로(위와 동일 취지). */
function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * 파싱 실패를 '항목 없음'으로 렌더하면 설정이 사라진 것으로 오인하게 된다.
 * 읽지 못했다는 사실 자체를 카드로 드러낸다(.mcp.json 렌더러와 동일 동작).
 */
function errorCard(cs: string, scope?: string | null, project?: string | null): Card {
  return card("(파싱 오류)", [["source", pyBasename(cs)], ["error", "설정을 읽지 못함"]], { scope, project, source: cs });
}

/** extra 는 --paths 의 key=path 를 나눈 것. */
export function discover(extra?: Record<string, string> | null): Found {
  const found: Found = {};
  for (const [key, cands] of Object.entries(candidates())) {
    found[key] = key.endsWith("_glob") ? allGlob(cands) : firstExisting(cands);
  }
  if (extra) for (const [k, v] of Object.entries(extra)) put(found, k, v);
  return found;
}

const FM_RE = new RegExp(`^[${PY_WS}]*---[${PY_WS}]*\\n([\\s\\S]*?)\\n---[${PY_WS}]*\\n`);
const FM_LINE = new RegExp(`^[${PY_WS}]*([A-Za-z0-9_\\-]+)[${PY_WS}]*:[${PY_WS}]*([^\\n]*)[${PY_WS}]*$`);

/** str.splitlines(): \n \r \r\n \v \f \x1c \x1d \x1e \x85 \u2028 \u2029 로 나누고 끝의 빈 줄은 만들지 않는다. */
function splitlines(s: string): string[] {
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** YAML 이 아니라 key: value 줄 파서다(규칙은 docs/port-contract-2026-11-20.md 3.2절). */
export function readFrontmatter(filePath: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(filePath).toString("utf8");
  } catch {
    return Object.create(null);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // 텍스트 모드 읽기의 universal newlines
  text = text.replace(/\r\n?/g, "\n");
  const meta: Record<string, string> = Object.create(null);
  const m = FM_RE.exec(text);
  if (!m) return meta;
  for (const line of splitlines(m[1])) {
    const mm = FM_LINE.exec(line);
    if (mm) meta[mm[1]] = pyStrip(mm[2]).replace(/^["']+/, "").replace(/["']+$/, "");
  }
  return meta;
}

function fm(meta: Record<string, string>, k: string, d: unknown): unknown {
  return k in meta ? meta[k] : d;
}

function short(v: unknown, n = 160): string {
  const s = Array.isArray(v) || isDict(v) ? pyDumps(v, { ensureAscii: false }) : pyStrOf(v);
  const cps = [...s];
  return cps.length <= n ? s : cps.slice(0, n).join("") + "…";
}

const DESC_KEYS: ReadonlySet<string> = new Set(["desc", "description", "설명", "summary"]);

export const GROUPS: readonly [string, string][] = [
  ["instructions", "지시 · 규칙"],
  ["extensions", "확장"],
  ["connect", "연결 (MCP)"],
  ["exec", "실행 · 권한"],
  ["memory", "기억"],
  ["env", "환경"],
];

/**
 * 섹션 하나의 정체성. id 는 개수·언어와 무관한 안정 키 - 저장되는 표시 설정의 키가 된다.
 * load 가 null 이면 카드마다 다르다는 뜻(rules/output-styles/project-memory).
 */
export interface Sec {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly scopes: readonly string[];
  readonly load: string | null;
  readonly note: string;
}

function sec(id: string, title: string, group: string, scopes: string[] = [], load: string | null = null, note = ""): [string, Sec] {
  return [id, Object.freeze({ id, title, group, scopes, load, note })];
}

export const SECTIONS: Readonly<Record<string, Sec>> = Object.freeze(Object.fromEntries([
  sec("claude-md", "CLAUDE.md", "instructions", ["user", "project"], "eager", "세션마다 전문 적재"),
  sec("rules", "Rules", "instructions", ["user", "project"], null, "paths: 있으면 LAZY · 없으면 EAGER"),
  sec("output-styles", "Output Styles", "instructions", ["user", "project"], null, "outputStyle 로 선택된 것만 EAGER"),
  sec("mcp-desktop", "MCP Servers (desktop)", "connect", ["desktop"], "never"),
  sec("claude-json", "Claude Code (.claude.json)", "connect", ["user"], "never", "앱 상태 · 전역 MCP · trust"),
  sec("mcp-project", "MCP Servers (project)", "connect", ["project"], "lazy", "연결/스키마"),
  sec("perm", "Permissions", "exec", ["user", "project"], "never", "런타임 판정"),
  sec("hooks", "Hooks", "exec", ["user", "project"], "never", "런타임 실행"),
  sec("skills", "Skills (code)", "extensions", ["user", "project"], "eager", "name+description 만 · 본문 LAZY"),
  sec("agents", "Agents", "extensions", ["user", "project"], "eager", "description 만 · 본문 LAZY"),
  sec("commands", "Commands", "extensions", ["user", "project"], "lazy", "본문은 호출 시"),
  sec("workflows", "Workflows", "extensions", ["user", "project"], "lazy", "각 파일이 /<name>"),
  sec("plugins", "Plugins", "extensions", ["user"], "never", "관리 단위 · 항목은 각 섹션에 합류"),
  sec("project-memory", "Project Memory", "memory", ["user"], null, "MEMORY.md EAGER(앞 200줄/25KB) · topic LAZY"),
  sec("agent-memory", "Agent Memory", "memory", ["user", "project"], "lazy", "서브에이전트 memory"),
  sec("themes", "Themes", "env", ["user"], "never", "/theme 목록 · hot-reload"),
  sec("worktreeinclude", ".worktreeinclude", "env", ["project"], "lazy", "worktree 생성 시 복사 목록"),
  sec("scheduled", "Scheduled Tasks", "env", ["desktop"]),
  sec("desktop-skills", "Desktop Skills", "connect", ["desktop"]),
]));

const hasSec = (id: string) => Object.prototype.hasOwnProperty.call(SECTIONS, id);

/**
 * '+ 새 ...' 스캐폴드 카드. 항목이 아니라 입력 폼이므로 개수에 들어가면 안 된다
 * - 규칙 0개인 Rules 가 '· 1' 로 보이고, 빈 섹션 숨기기도 걸리지 않는다.
 */
export function isAddCard(c: Obj): boolean {
  const edit = or(Object.prototype.hasOwnProperty.call(c, "edit") ? c.edit : null, {});
  return pyStrOf(pyGet(edit, "kind", "")).endsWith("-add");
}

export function count(cards: Obj[]): number {
  return cards.filter((c) => !isAddCard(c)).length;
}

/** 레지스트리 항목 + 카드 -> 섹션 dict. 제목의 ' · N' 은 여기서만 붙인다. */
export function section(sid: string, cards: Card[], source: string | null = null): Section {
  const s = SECTIONS[sid];
  const d: Section = { id: s.id, title: `${s.title} · ${count(cards)}`, group: s.group, source, cards };
  if (s.load) d.load = s.load;
  if (s.note) d.note = s.note;
  return d;
}

function recount(sc: Section): void {
  sc.title = `${SECTIONS[sc.id].title} · ${count(sc.cards)}`;
}

export interface CardOpts {
  badge?: unknown;
  ok?: boolean;
  edit?: Obj | null;
  scope?: string | null;
  project?: string | null;
  source?: string | null;
  plugin?: string | null;
  builtin?: boolean;
}

export function card(name: unknown, kv: Kv, opts: CardOpts = {}): Card {
  // 서술형 값은 넉넉히 담고(줄 수 표시는 UI 의 -webkit-line-clamp 가 담당),
  // 코드형/경로 값만 160자 선절단 - 슬라이더(2~10줄) 전 구간이 실제 텍스트로 채워지게.
  const c: Obj = {
    name, badge: opts.badge ?? null, ok: opts.ok ?? false,
    kv: kv.map(([k, v]) => [k, short(v, DESC_KEYS.has(pyStrOf(k).toLowerCase()) ? 600 : 160)]),
  };
  if (truthy(opts.edit)) c.edit = opts.edit;   // UI 가 인라인 add/remove 버튼을 그릴 때 쓰는 구조화 메타
  // scope/project 는 프로젝트 전용 항목에만 붙는다(전역 항목은 미부여).
  if (opts.scope) c.scope = opts.scope;
  if (opts.project) c.project = opts.project;
  // source 는 한 섹션에 여러 파일이 섞이는 항목(perm/hook/plugin)에만 붙는다.
  // 같은 이름의 카드(allow 등)가 파일마다 나오므로 카드 자신이 출처를 들고 있어야 한다.
  if (opts.source) c.source = opts.source;
  // plugin 은 이 항목이 플러그인에서 온 것임을 표시(값은 토글 키인 id). 로컬 항목에는 없다.
  // scope/source 와 직교한다 - 플러그인 항목은 파일이 아니라 플러그인 캐시에서 오기 때문.
  if (opts.plugin) c.plugin = opts.plugin;
  // builtin = 내가 만든 게 아니라 기본 제공된 항목(Desktop Skills 의 creatorType=anthropic).
  // plugin 과 다른 축이다: 플러그인은 내가 설치한 것이고 이쪽은 처음부터 있던 것이라,
  // 목록을 줄일 때 각각 따로 끄고 싶어진다.
  if (opts.builtin) c.builtin = true;
  return c as Card;
}

/**
 * 디렉토리 d 에서 실제로 적용되는 settings 파일들(존재하는 것만).
 * Claude 는 settings.json 과 settings.local.json 을 모두 읽고 local 이 우선한다.
 * firstExisting 으로 하나만 보면 실제 적용 중인 규칙이 안 보인다.
 */
function dirSettings(d: string): string[] {
  return [pyJoin(d, "settings.json"), pyJoin(d, "settings.local.json")].filter(pyExists);
}

/**
 * 전역에서 적용되는 settings 파일들. 같은 디렉토리의 settings.json/settings.local.json 을
 * 함께 본다. cs 가 그 둘 중 하나가 아니면(--paths 로 다른 파일을 직접 지정) 그 파일만.
 */
function settingsChain(cs: unknown): string[] {
  if (!truthy(cs)) return [];
  const p = cs as string;
  const files = dirSettings(pyDirname(p));
  return files.includes(p) ? files : [p];
}

/** 섹션 헤더용 출처 표기. 여러 파일이면 '(+N more)'(Desktop Skills 섹션과 동일 표기). */
function sourceLabel(files: string[]): string | null {
  if (!files.length) return null;
  return files.length > 1 ? `${files[0]}  (+${files.length - 1} more)` : files[0];
}

function errorOf(data: unknown): boolean {
  return pyContains(data, "__error__");
}

// --- 섹션별 카드 빌더(전역/프로젝트 공용). scope=null 이면 전역,
//     scope="project" 이면 프로젝트 항목으로 태깅. 프로젝트 항목은 편집 대상 경로를 카드가 직접 들고 간다
//     (perm/hook 은 edit.settings, skills/agents 는 edit.dir) -> 전역 디렉토리 오삭제 없이 로컬 제거 가능.
//     전역 카드에는 그 경로를 붙이지 않는다: 도구 기본값(~/.claude)으로 가는 기존 호출을 그대로 유지.
function permCards(cs: string | null, scope: string | null = null, project: string | null = null): Card[] {
  const cards: Card[] = [];
  if (cs && pyExists(cs)) {
    const data = asDict(safeLoad(cs));
    if (errorOf(data)) return [errorCard(cs, scope, project)];
    const perms = asDict(pyGet(data, "permissions"));
    for (const kind of ["allow", "deny", "ask"]) {
      const lst = asList(pyGet(perms, kind));
      // settings 는 항상 지정 - 같은 이름의 카드가 파일마다 나오므로 편집이 그 카드의 파일로 가야 한다.
      // (전역 settings.json 이면 config_edit 의 기본 대상과 같은 경로라 동작 변화 없음.)
      const edit = { kind: "perm", permKind: kind, items: [...lst], settings: cs };
      cards.push(card(kind, [["source", pyBasename(cs)]], {
        badge: String(lst.length), ok: kind === "allow", edit, scope, project, source: cs,
      }));
    }
  }
  return cards;
}

function hookCards(cs: string | null, scope: string | null = null, project: string | null = null): Card[] {
  const cards: Card[] = [];
  if (cs && pyExists(cs)) {
    const data = asDict(safeLoad(cs));
    if (errorOf(data)) return [errorCard(cs, scope, project)];
    const hooks = asDict(pyGet(data, "hooks"));
    for (const [event, raw] of Object.entries(hooks)) {
      const entries = asList(raw);
      const cmds: unknown[] = [];
      for (const ent of entries) {
        for (const hk of asList(pyGet(asDict(ent), "hooks"))) if (isDict(hk)) cmds.push(pyGet(hk, "command", ""));
      }
      const edit = { kind: "hook", event, items: cmds, settings: cs };
      cards.push(card(event, [["matchers", entries.length], ["source", pyBasename(cs)]], {
        badge: "hook", edit, scope, project, source: cs,
      }));
    }
  }
  return cards;
}

export function skillCards(sd: string | null, scope: string | null = null, project: string | null = null): Card[] {
  const cards: Card[] = [];
  if (sd && pyIsdir(sd)) {
    for (const name of sortedListdir(sd)) {
      if (name.startsWith(".") || (scope !== "project" && RESERVED_SKILL_DIRS.includes(name))) continue;
      const full = pyJoin(sd, name);
      if (pyIsdir(full)) {
        const hasMd = pyExists(pyJoin(full, "SKILL.md"));
        const meta = hasMd ? readFrontmatter(pyJoin(full, "SKILL.md")) : Object.create(null);
        const edit: Obj = { kind: "skill", name };
        if (scope === "project") edit.dir = sd;   // 이 프로젝트의 skills 디렉토리를 제거 대상으로 명시
        cards.push(card(name, [["desc", fm(meta, "description", "-")], ["path", full]], {
          badge: hasMd ? "SKILL.md" : "no md", ok: hasMd, edit, scope, project,
        }));
      }
    }
    if (scope !== "project") {
      cards.push(card("＋ 새 스킬", [["형식", "name 설명…"]], { badge: "add", edit: { kind: "skill-add" } }));
    }
  }
  return cards;
}

/**
 * agents/ 를 재귀 순회해 [rel, md, disp, top] 목록을 만든다.
 * Claude 는 하위 폴더의 에이전트까지 읽으므로 한 단계만 보면 실제로 있는 것을 없다고 표시하게 된다.
 *   rel  = 표시용 상대 이름(구분자 '/', 확장자 제거)
 *   md   = frontmatter 를 읽을 파일
 *   disp = 카드에 보일 경로(파일형은 md 자신, AGENT.md 디렉토리형은 그 디렉토리)
 *   top  = 편집 가능한 단일 세그먼트 이름. 중첩 항목은 null(제거 op 가 못 받음 -> 뷰 전용).
 * dot 디렉토리(.trash 등)는 모든 깊이에서 제외 - 삭제 보관분이 살아있는 항목으로 되살아나면 안 된다.
 */
function iterAgents(ad: string): [string, string, string, string | null][] {
  const items: [string, string, string, string | null][] = [];
  const anc = new Set<string>();
  const walk = (d: string, prefix: string) => withinOnce(anc, d, () => {
    let names: string[];
    try {
      names = sortedListdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = pyJoin(d, name);
      if (pyIsdir(full)) {
        const agentMd = pyJoin(full, "AGENT.md");
        if (pyExists(agentMd)) {
          // 디렉토리 자체가 에이전트 한 개(AGENT.md 형): 내부는 리소스이므로 더 내려가지 않는다.
          items.push([prefix + name, agentMd, full, prefix ? null : name]);
        } else walk(full, prefix + name + "/");
      } else if (name.endsWith(".md")) {
        const stem = name.slice(0, -3);
        items.push([prefix + stem, full, full, prefix ? null : stem]);
      }
    }
  });
  walk(ad, "");
  return items;
}

/**
 * 디렉토리 d 를 재귀 순회해 [rel, path] 목록. rel 은 구분자 '/', 확장자 제거.
 * commands 는 하위 폴더가 네임스페이스가 되므로 한 단계만 보면 있는 것을 없다고 표시하게 된다.
 * dot 디렉토리(.trash 등)는 모든 깊이에서 제외.
 */
function iterMd(d: string): [string, string][] {
  const items: [string, string][] = [];
  const anc = new Set<string>();
  const walk = (cur: string, prefix: string) => withinOnce(anc, cur, () => {
    let names: string[];
    try {
      names = sortedListdir(cur);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = pyJoin(cur, name);
      if (pyIsdir(full)) walk(full, prefix + name + "/");
      else if (name.endsWith(".md")) items.push([prefix + name.slice(0, -3), full]);
    }
  });
  walk(d, "");
  return items;
}

/** commands/ 의 *.md(슬래시 커맨드). config_edit 에 제거 op 가 없으므로 뷰 전용. */
function commandCards(cd: string | null, scope: string | null = null, project: string | null = null): Card[] {
  const cards: Card[] = [];
  if (cd && pyIsdir(cd)) {
    for (const [rel, full] of iterMd(cd)) {
      const meta = readFrontmatter(full);
      cards.push(card(rel, [["desc", fm(meta, "description", "-")], ["path", full]], { badge: "command", ok: true, scope, project }));
    }
  }
  return cards;
}

/** 적재 비용을 말하려면 크기가 필요하다 - EAGER 표면에서 이게 요점이다. */
function sizeKv(p: string): Kv {
  try {
    return [["size", `${String(getsize(p)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} B`]];
  } catch {
    return [];
  }
}

type PerItem<T> = (rel: string, p: string, meta: Record<string, string>) => T;

/**
 * *.md 디렉토리를 재귀 순회해 카드로. rel 은 '/' 구분 · 확장자 제거(iterMd 와 동일).
 * loadOf(rel, path, meta) 를 주면 카드마다 적재등급을 따로 정한다.
 */
export function mdDirCards(d: string | null, badge: string, scope: string | null = null, project: string | null = null,
  loadOf?: PerItem<string> | null, editOf?: PerItem<Obj | null> | null): Card[] {
  const cards: Card[] = [];
  if (!(d && pyIsdir(d))) return cards;
  for (const [rel, full] of iterMd(d)) {
    const meta = readFrontmatter(full);
    const c = card(rel, [["desc", fm(meta, "description", "-")], ...sizeKv(full), ["path", full]], { badge, ok: true, scope, project });
    if (loadOf) c.load = loadOf(rel, full, meta) as Card["load"];
    if (editOf) {
      const e = editOf(rel, full, meta);
      if (e) c.edit = e;
    }
    cards.push(c);
  }
  return cards;
}

export function globCards(d: string | null, pattern: string, badge: string, scope: string | null = null, project: string | null = null,
  editOf?: PerItem<Obj | null> | null): Card[] {
  const cards: Card[] = [];
  if (!(d && pyIsdir(d))) return cards;
  for (const full of glob(pyJoin(d, pattern)).sort(cmpStr)) {
    const rel = splitext(pyBasename(full))[0];
    const c = card(rel, [...sizeKv(full), ["path", full]], { badge, ok: true, scope, project });
    if (editOf) {
      const e = editOf(rel, full, Object.create(null));
      if (e) c.edit = e;
    }
    cards.push(c);
  }
  return cards;
}

/** 단일 파일 -> 카드 0개 또는 1개. 없으면 빈 리스트(섹션이 알아서 빈다). */
export function fileCard(p: string | null, badge: string, scope: string | null = null, project: string | null = null, load: string | null = null): Card[] {
  if (!(p && pyExists(p))) return [];
  const c = card(pyBasename(p), [...sizeKv(p), ["path", p]], { badge, ok: true, scope, project, source: p });
  if (load) c.load = load as Card["load"];
  return [c];
}

/**
 * 중첩 항목(하위 폴더)은 제거 op 가 단일 세그먼트만 받으므로 뷰 전용이다.
 * 전역 카드에는 dir 을 붙이지 않는다 - 도구 기본값(~/.claude/<sub>)으로 가게 둔다.
 */
function itemEdit(itemKind: string, rel: string, d: string, scope: string | null, extra?: Obj | null): Obj | null {
  if (rel.includes("/")) return null;
  const e: Obj = { kind: "item", itemKind, name: rel };
  if (scope === "project") e.dir = d;
  if (extra) Object.assign(e, extra);
  return e;
}

function addCard(itemKind: string, label: string): Card {
  return card(label, [["형식", "name 설명…"]], { badge: "add", edit: { kind: "item-add", itemKind } });
}

/** paths: frontmatter 가 있으면 매칭 파일을 읽을 때만(LAZY), 없으면 세션 시작에 적재(EAGER). */
export function rulesCards(d: string | null, scope: string | null = null, project: string | null = null): Card[] {
  const cards = mdDirCards(d, "rule", scope, project,
    (_rel, _p, meta) => ("paths" in meta ? "lazy" : "eager"),
    (rel) => itemEdit("rule", rel, d as string, scope));
  if (scope !== "project") cards.push(addCard("rule", "＋ 새 규칙"));
  return cards;
}

/**
 * settings 체인에서 실제로 선택된 output style. local 이 뒤에 오므로 뒤가 이긴다.
 * 키가 없으면 null - '선택된 스타일 없음'은 정상 상태다(실측: 이 키가 없는 settings 가 흔하다).
 */
export function activeOutputStyle(chain: string[] | null): string | null {
  let active: string | null = null;
  for (const cs of chain || []) {
    const v = pyGet(asDict(safeLoad(cs)), "outputStyle");
    if (typeof v === "string" && v) active = v;
  }
  return active;
}

/**
 * 선택된 하나만 컨텍스트에 들어간다. 나머지는 파일로만 존재한다.
 * active 여부를 edit 에 실어 보낸다 - '무엇이 EAGER 인가'를 바꾸는 유일한 스위치라
 * 배지로 보여주기만 하고 바꿀 수단이 없으면 반쪽이다.
 */
export function outputStyleCards(d: string | null, active: string | null = null, scope: string | null = null,
  project: string | null = null, settings: string | null = null): Card[] {
  const edit: PerItem<Obj | null> = (rel) => {
    const extra: Obj = { active: rel === active };
    if (settings) extra.settings = settings;
    return itemEdit("output-style", rel, d as string, scope, extra);
  };
  const cards = mdDirCards(d, "output-style", scope, project, (rel) => (rel === active ? "eager" : "never"), edit);
  if (scope !== "project") cards.push(addCard("output-style", "＋ 새 출력 스타일"));
  return cards;
}

const CLAUDE_MD_RELS = ["CLAUDE.md", "CLAUDE.local.md", pyJoin(".claude", "CLAUDE.md")];

/**
 * CLAUDE.md · CLAUDE.local.md · .claude/CLAUDE.md 를 한 섹션의 세 카드로.
 * 같은 종류라 섹션을 셋으로 쪼개면 목록만 길어진다.
 */
export function claudeMdCards(root: string, scope: string | null = null, project: string | null = null): Card[] {
  return CLAUDE_MD_RELS.flatMap((rel) => fileCard(pyJoin(root, rel), rel, scope, project, "eager"));
}

/** Python _encode_project_dir: [^A-Za-z0-9] 를 코드 포인트마다 '-' 하나로 바꾼다(정규식에 u 플래그 필요). */
export function encodeProjectDir(p: string): string {
  // 실측: d:\config-monitor -> d--config-monitor.
  return p.replace(/[^A-Za-z0-9]/gu, "-");
}

/**
 * MEMORY.md 는 세션마다 적재(앞 200줄/25KB), 나머지 토픽은 필요할 때 Read.
 * MEMORY.md 에는 제거를 붙이지 않는다 - 색인이라 지우면 나머지 토픽으로 가는 길이 끊긴다.
 */
export function memoryCards(d: string, scope: string | null = null, project: string | null = null): Card[] {
  return mdDirCards(d, "memory", scope, project,
    (rel) => (rel === "MEMORY" ? "eager" : "lazy"),
    (rel) => (rel === "MEMORY" || rel.includes("/") ? null : { kind: "memory", name: rel, memoryDir: d }));
}

/** 인코딩으로 먼저 찾고, 없으면 projects/ 목록에서 대소문자 무시 역매칭으로 폴백. */
function projectMemoryDir(root: string): string | null {
  const base = pyJoin(expanduser("~"), ".claude", "projects");
  const enc = encodeProjectDir(root);
  const d = pyJoin(base, enc, "memory");
  if (pyIsdir(d)) return d;
  const want = enc.toLowerCase();
  try {
    for (const name of listdir(base)) {
      if (name.toLowerCase() === want) {
        const cand = pyJoin(base, name, "memory");
        if (pyIsdir(cand)) return cand;
      }
    }
  } catch {
    // 목록을 못 읽으면 메모리 폴더가 없는 것으로 본다
  }
  return null;
}

/**
 * <root>/.mcp.json 의 mcpServers. MCP Project 스코프 - 커밋되어 팀 전체에 영향인데
 * 대시보드에 존재 자체가 없었다. 편집 op 가 없으므로 뷰 전용.
 * env 는 값 없이 키 이름만(Desktop MCP 카드와 동일).
 */
function mcpJsonCards(root: string, scope: string | null = null, project: string | null = null): Card[] {
  const cards: Card[] = [];
  const mj = pyJoin(root, ".mcp.json");
  if (pyExists(mj)) {
    const data = safeLoad(mj);
    if (errorOf(data)) {
      cards.push(card("(파싱 오류)", [["error", pyGet(data, "__error__")], ["path", mj]], { scope, project, source: mj }));
    } else {
      const servers = isDict(data) ? or(pyGet(data, "mcpServers"), {}) : {};
      for (const [name, raw] of pyItems(servers)) {
        const cfg = or(raw, {});
        cards.push(card(name, [
          ["command", pyGet(cfg, "command", "-")],
          ["args", strJoin(" ", or(pyGet(cfg, "args", []), [])) || "-"],
          ["env", strJoin(", ", Object.keys(dictOrThrow(or(pyGet(cfg, "env"), {})))) || "-"],
        ], { badge: truthy(pyGet(cfg, "command")) ? "stdio" : pyGet(cfg, "type", "?"), ok: true, scope, project, source: mj }));
      }
    }
  }
  return cards;
}

/** `.keys()` 를 부르는 자리: dict 가 아니면 AttributeError 처럼 던진다. */
function dictOrThrow(v: unknown): Obj {
  if (!isDict(v)) throw new TypeError("AttributeError: object has no attribute 'keys'");
  return v;
}

function agentCards(ad: string | null, scope: string | null = null, project: string | null = null): Card[] {
  const cards: Card[] = [];
  if (ad && pyIsdir(ad)) {
    for (const [rel, md, disp, top] of iterAgents(ad)) {
      const meta = pyExists(md) ? readFrontmatter(md) : Object.create(null);
      // 제거 op 는 파일시스템 이름 기준 - frontmatter name 과 다를 수 있다.
      // 중첩 항목(top=null)은 제거 op 가 단일 세그먼트만 받으므로 뷰 전용(전역/프로젝트 동일).
      const edit: Obj | null = top ? { kind: "agent", name: top } : null;
      if (edit && scope === "project") edit.dir = ad;   // 이 프로젝트의 agents 디렉토리를 제거 대상으로 명시
      cards.push(card(fm(meta, "name", rel), [
        ["desc", fm(meta, "description", "-")],
        ["tools", fm(meta, "tools", "-")],
        ["path", disp],
      ], { badge: "agent", edit, scope, project }));
    }
    if (scope !== "project") {
      cards.push(card("＋ 새 에이전트", [["형식", "name 설명…"]], { badge: "add", edit: { kind: "agent-add" } }));
    }
  }
  return cards;
}

/** 경로 앞뒤의 '/', '\' 를 떼는 rstrip("/\\"). */
function rstripSeps(p: string): string {
  return p.replace(/[/\\]+$/, "");
}

/**
 * 추적 중인 프로젝트 .claude 디렉토리들의 permissions/hooks/skills/agents 를 스캔해
 * 해당 전역 섹션 뒤에 프로젝트 항목으로 append(전역 카드는 불변). title 개수도 재계산.
 */
function appendProjectCards(sections: Section[], projects: string[], globalChain: string[] = []): void {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const addTo = (sid: string, cards: Card[]) => {
    const sc = byId.get(sid);
    if (sc && cards.length) sc.cards.push(...cards);
  };
  for (const cdir of projects) {
    if (!cdir || !pyIsdir(cdir)) continue;
    const root = pyDirname(rstripSeps(cdir));   // <root>/.claude -> <root> (칩 라벨 = 마지막 세그먼트)
    for (const cs of dirSettings(cdir)) {
      addTo("perm", permCards(cs, "project", root));
      addTo("hooks", hookCards(cs, "project", root));
    }
    addTo("skills", skillCards(pyJoin(cdir, "skills"), "project", root));
    addTo("agents", agentCards(pyJoin(cdir, "agents"), "project", root));
    addTo("commands", commandCards(pyJoin(cdir, "commands"), "project", root));
    addTo("mcp-project", mcpJsonCards(root, "project", root));
    addTo("claude-md", claudeMdCards(root, "project", root));
    addTo("rules", rulesCards(pyJoin(cdir, "rules"), "project", root));
    addTo("output-styles", outputStyleCards(
      pyJoin(cdir, "output-styles"),
      // 프로젝트는 전역 settings 를 상속한다 - 전역 체인을 앞에 두고 프로젝트가 이긴다.
      // 프로젝트만 보면 전역에서 켠 스타일이 그 프로젝트에서 NEVER 로 보인다.
      activeOutputStyle([...globalChain, ...dirSettings(cdir)]),
      "project", root, pyJoin(cdir, "settings.json")));
    const pwd = pyJoin(cdir, "workflows");
    addTo("workflows", globCards(pwd, "*.js", "workflow", "project", root, (rel) => itemEdit("workflow", rel, pwd, "project")));
    addTo("worktreeinclude", fileCard(pyJoin(root, ".worktreeinclude"), "worktree", "project", root, "lazy"));
    const md = projectMemoryDir(root);
    if (md) addTo("project-memory", memoryCards(md, "project", root));
    for (const [sub, badge] of [["agent-memory", "agent-memory"], ["agent-memory-local", "agent-memory-local"]]) {
      addTo("agent-memory", mdDirCards(pyJoin(cdir, sub), badge, "project", root));
    }
  }
  for (const sc of sections) if (hasSec(sc.id)) recount(sc);
}

// --- 플러그인(~/.claude/plugins) ---
// 플러그인 항목은 세션에서 <ns>:<item> 으로 네임스페이스가 붙어 로컬 항목과 이름이 겹치지
// 않는다(실측: superpowers:brainstorming, Notion:create-page). 그래서 override/conflict
// 배지를 붙이지 않는다 - 붙이면 없는 충돌을 만들어낸다.
// 편집(제거) op 도 붙이지 않는다: 플러그인 항목을 끄는 단위는 항목이 아니라 플러그인이고,
// 그 토글은 Plugins 섹션 카드에 있다.

// 플러그인 항목이 합류할 기존 섹션 id.
const PLUGIN_MERGE_IDS = ["skills", "agents", "commands", "hooks", "claude-json", "rules", "output-styles", "workflows"];
const STATE_BADGE: Record<string, string> = { ok: "plugin", disabled: "disabled", stale: "stale", missing: "missing" };

/** os.path.normcase(os.path.normpath(p)). */
export function normPath(p: string): string {
  // 경로 비교용 정규화(대소문자/구분자/./.. 흡수). lib_store.norm 과 같은 규칙.
  return pyNormcase(pyNormpath(p));
}

/**
 * 플러그인을 켠 파일이 전역 체인 밖이면 프로젝트 스코프다 -> ["project", <root>].
 * <root>/.claude/settings.json -> <root> (appendProjectCards 와 같은 라벨 기준).
 */
function pluginScope(r: PluginRecord, gset: Set<string>): [string | null, string | null] {
  const src = r.enabled_from;
  if (src && !gset.has(normPath(src))) return ["project", pyDirname(pyDirname(src))];
  return [null, null];
}

/**
 * Plugins 섹션 - 플러그인 단위 카드. 토글이 여기 붙는다(토글 단위가 플러그인이므로).
 *
 * globalSettings 는 전역 settings 체인이다. enabled_from 이 그 안에 없으면 프로젝트
 * settings 가 정한 값이므로 카드를 project 스코프로 태깅한다 - 안 하면 스코프 칩이
 * 전역으로 분류해서 "어느 프로젝트가 이걸 껐는지"를 화면에서 못 찾는다.
 */
export function pluginSectionCards(plugins: PluginRecord[], settingsFallback: string | null, globalSettings: string[] = []): Card[] {
  const gset = new Set(globalSettings.filter(Boolean).map(normPath));
  const cards: Card[] = [];
  for (const r of plugins) {
    const counts = itemCounts(r);
    const kv: Kv = [
      ["desc", or(r.desc, "-")],
      ["market", or(r.market, "-")],
      ["version", or(r.version, "-")],
      ["gives", Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ") || "-"],
    ];
    // 표시 접두(ns)는 plugin.json 에서, 토글 키(id)는 마켓 매니페스트에서 온다.
    // 실측으로 갈리는 경우가 있어(notion -> "Notion:") 다를 때만 따로 보여준다.
    if (truthy(r.ns) && r.ns !== r.name) kv.push(["namespace", `${pyStrOf(r.ns)}:`]);
    kv.push(["id", r.id]);
    if (r.state === "stale") kv.push(["note", "enabledPlugins 에만 남은 키 - 설치 기록이 없습니다"]);
    else if (r.state === "missing") kv.push(["note", `설치 경로가 없습니다: ${pyStrOf(or(r.root, "-"))}`]);
    else kv.push(["path", r.root]);
    // 설치 스코프는 토글 스코프와 다른 축이다(토글은 enabledPlugins 를 정한 파일,
    // 이쪽은 원장이 기록한 설치 위치). 제거/갱신이 향할 곳이라 카드에 보이게 둔다.
    if (truthy(r.scope) && r.scope !== "user") kv.push(["installed", `${pyStrOf(r.scope)}  ${pyStrOf(or(r.project_path, "-"))}`]);
    // 카드에는 파일명만, 전체 경로는 출처 그룹 헤더가 든다(permCards 와 같은 규율).
    // 같은 프로젝트의 settings.json 과 settings.local.json 이 갈리는 유일한 자리다 -
    // 스코프 필은 전역/프로젝트 2치라 project 설치와 local 설치를 구분하지 못한다.
    const src = (r.enabled_from || settingsFallback) as string | null;
    kv.push(["source", src ? pyBasename(src) : "-"]);
    // 토글 대상은 그 값을 정한 파일이다. 프로젝트에서 켠 것을 전역 파일에서 끄면
    // 안 먹으므로 카드가 자기 대상 경로를 들고 간다(permCards 와 같은 규율).
    let edit: Obj | null = null;
    if (r.state === "ok" || r.state === "disabled") {
      // scope/cwd 는 claude 위임(제거·갱신)이 쓴다. 안 넘기면 CLI 기본값 user 로 흘러가
      // project 스코프 설치를 영영 못 지운다 - claude 가 "project 스코프에 있다"며
      // 거절하고, 사용자는 대시보드에서 빠져나갈 길이 없다(실측 재현).
      edit = { kind: "plugin", id: r.id, on: r.enabled, settings: src, scope: or(r.scope, "user"), cwd: or(r.project_path, "") };
    }
    const [scope, proj] = pluginScope(r, gset);
    cards.push(card(r.name, kv, {
      badge: Object.prototype.hasOwnProperty.call(STATE_BADGE, r.state) ? STATE_BADGE[r.state] : r.state,
      ok: r.state === "ok", edit, plugin: r.id, scope, project: proj, source: src,
    }));
  }
  return cards;
}

/** stdio 는 command/args, 원격은 type/url. 해당 없는 키를 '-' 로 채우지 않는다. */
function pluginMcpKv(raw: unknown): Kv {
  const cfg = or(raw, {});
  if (truthy(pyGet(cfg, "command"))) {
    return [["command", pyGet(cfg, "command")], ["args", strJoin(" ", or(pyGet(cfg, "args"), [])) || "-"]];
  }
  return [["type", pyGet(cfg, "type", "-")], ["url", pyGet(cfg, "url", "-")]];
}

interface PathItem { name: unknown; path: string }

/**
 * state == ok 인 플러그인 하나가 기존 섹션에 낼 카드들 -> {섹션 id: [card]}.
 *
 * scope/project 는 그 플러그인을 켠 파일에서 온다(pluginScope). 안 붙이면 프로젝트에서만
 * 켠 플러그인의 스킬 수십 개가 전역 항목으로 잡혀, 그 프로젝트 칩을 눌렀을 때 오히려 사라진다.
 */
function pluginItemCards(r: PluginRecord, scope: string | null, project: string | null): Map<string, Card[]> {
  const { id: pid, ns, items } = r;
  const out = new Map<string, Card[]>(PLUGIN_MERGE_IDS.map((sid) => [sid, []]));
  const tag: CardOpts = { plugin: pid, scope, project };
  const label = (n: unknown) => `${pyStrOf(ns)}:${pyStrOf(n)}`;

  for (const it of items.skills as PathItem[]) {
    const meta = readFrontmatter(it.path);
    out.get("skills")!.push(card(label(it.name), [
      ["desc", fm(meta, "description", "-")], ["from", pid], ["path", it.path],
    ], { badge: "plugin", ok: true, ...tag }));
  }

  for (const it of items.agents as PathItem[]) {
    const meta = readFrontmatter(it.path);
    // 에이전트는 frontmatter name 이 실제 호출 이름이다(agentCards 와 같은 기준).
    out.get("agents")!.push(card(label(or(fm(meta, "name", null), it.name)), [
      ["desc", fm(meta, "description", "-")], ["tools", fm(meta, "tools", "-")],
      ["from", pid], ["path", it.path],
    ], { badge: "plugin", ok: true, ...tag }));
  }

  for (const it of items.commands as PathItem[]) {
    const meta = readFrontmatter(it.path);
    out.get("commands")!.push(card(label(it.name), [
      ["desc", fm(meta, "description", "-")], ["from", pid], ["path", it.path],
    ], { badge: "plugin", ok: true, ...tag }));
  }

  // 아직 이런 플러그인은 실측되지 않았다. 나왔을 때 어느 섹션에도 안 잡히는 것을 막는다.
  for (const key of ["rules", "output-styles", "workflows"]) {
    for (const it of (Object.prototype.hasOwnProperty.call(items, key) ? items[key] : []) as PathItem[]) {
      const meta = key !== "workflows" ? readFrontmatter(it.path) : Object.create(null);
      out.get(key)!.push(card(label(it.name), [
        ["desc", fm(meta, "description", "-")], ["from", pid], ["path", it.path],
      ], { badge: "plugin", ok: true, ...tag }));
    }
  }

  const hooksSrc = pyJoin(r.root as string, "hooks", "hooks.json");
  for (const h of items.hooks as { event: string; matchers: number; commands: unknown[] }[]) {
    out.get("hooks")!.push(card(h.event, [
      ["matchers", h.matchers],
      ["commands", strJoin(" ; ", h.commands) || "-"],
      ["from", pid], ["path", hooksSrc],
    ], { badge: "plugin", ...tag }));
  }

  // 플러그인 MCP 는 .claude.json 에 기록되지 않고 Claude Code 가 세션에 직접 주입한다.
  // 그래도 "Code 에서 실제로 붙는 MCP 서버"라는 점에서 이 섹션이 가장 가깝다.
  for (const m of items.mcp as { name: string; cfg: unknown }[]) {
    out.get("claude-json")!.push(card(label(m.name), [...pluginMcpKv(m.cfg), ["from", pid]], { badge: "plugin mcp", ok: true, ...tag }));
  }
  return out;
}

/**
 * state == ok 인 플러그인의 항목을 해당 전역 섹션 뒤에 append. title 개수 재계산.
 *
 * disabled / stale / missing 은 합류시키지 않는다 - 지금 적용되고 있지 않기 때문이다.
 * (설치됨 != 적용됨. 실측: chrome-devtools-mcp 는 설치돼 있고 enabled=false 다.)
 */
function appendPluginCards(sections: Section[], plugins: PluginRecord[], globalSettings: string[] = []): void {
  const gset = new Set(globalSettings.filter(Boolean).map(normPath));
  const byId = new Map(sections.map((s) => [s.id, s]));
  const touched = new Set<string>();
  for (const r of plugins) {
    if (r.state !== "ok") continue;
    const [scope, proj] = pluginScope(r, gset);
    for (const [sid, cards] of pluginItemCards(r, scope, proj)) {
      const sc = byId.get(sid);
      if (sc && cards.length) {
        sc.cards.push(...cards);
        touched.add(sid);
      }
    }
  }
  for (const sid of touched) recount(byId.get(sid)!);
}

/** Python dict 키(해시 가능한 값)를 Map 키로. 1 과 True 는 같은 키, dict/list 는 TypeError. */
function hashKey(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean" || typeof v === "number") return `n:${Number(v)}`;
  if (typeof v === "string") return `s:${v}`;
  throw new TypeError("unhashable type");
}

export function parse(found: Found, projectDirs?: string[] | null, includeMissing = false): ConfigState {
  const home = expanduser("~");
  const get = (k: string): unknown => (Object.prototype.hasOwnProperty.call(found, k) ? found[k] : null);
  const state: ConfigState = { generated: isoNow(), sources: found, sections: [] };
  const add = (s: Section) => state.sections.push(s);

  // 1) Desktop MCP servers (카드 단위 제거 + 섹션 add 카드)
  let cards: Card[] = [];
  const dc = get("desktop_config") as string | null;
  if (dc && pyExists(dc)) {
    const dd = asDict(safeLoad(dc));
    if (errorOf(dd)) cards.push(errorCard(dc));
    for (const [name, raw] of Object.entries(asDict(pyGet(dd, "mcpServers")))) {
      const cfg = asDict(raw);   // 항목이 null 이어도 카드 하나가 비는 선에서 끝나게
      cards.push(card(name, [
        ["command", pyGet(cfg, "command", "-")],
        ["args", asList(pyGet(cfg, "args")).map(pyStrOf).join(" ") || "-"],
        ["env", Object.keys(asDict(pyGet(cfg, "env"))).join(", ") || "-"],
      ], { badge: truthy(pyGet(cfg, "command")) ? "stdio" : pyGet(cfg, "type", "?"), ok: true, edit: { kind: "mcp", scope: "desktop", name } }));
    }
    if (!errorOf(dd)) {
      cards.push(card("＋ 새 MCP 서버", [["형식", 'name {"command":"npx","args":[...]}']], { badge: "add", edit: { kind: "mcp-add", scope: "desktop" } }));
    }
  }
  add(section("mcp-desktop", cards, dc));

  // 2) Claude Code 전역 (.claude.json, 관심 키만)
  cards = [];
  const cj = get("claude_json") as string | null;
  if (cj && pyExists(cj)) {
    const data = safeLoad(cj);
    if (errorOf(data)) {
      cards.push(card("(파싱 오류)", [["error", pyGet(data, "__error__")]]));
    } else {
      const gMcp = Object.keys(dictOrThrow(or(pyGet(data, "mcpServers"), {})));
      const projects = or(pyGet(data, "projects"), {});
      cards.push(card("전역 요약", [
        ["global MCP", gMcp.join(", ") || "-"],
        ["projects", pyLen(projects)],
        ["account", truthy(pyGet(data, "oauthAccount")) ? "set" : "-"],
        ["dropped", "history(노이즈) 제외 · 관심 키만 선별 추출"],
      ], { badge: "claude.json", ok: true }));
      // 전역 mcpServers 를 카드 단위로 노출(제거 가능) + add 카드
      for (const [name, raw] of Object.entries(asDict(pyGet(data, "mcpServers")))) {
        const cfg = asDict(raw);
        cards.push(card(name, [
          ["command", pyGet(cfg, "command", "-")],
          ["args", asList(pyGet(cfg, "args")).map(pyStrOf).join(" ") || "-"],
        ], { badge: "global mcp", ok: true, edit: { kind: "mcp", scope: "user", name } }));
      }
      cards.push(card("＋ 새 전역 MCP 서버", [["형식", 'name {"command":"npx","args":[...]}']], { badge: "add", edit: { kind: "mcp-add", scope: "user" } }));
      const roots = excludedRoots();
      const shown = pyItems(projects).filter(([p]) => projectShown(p, includeMissing, roots));
      for (const [p, raw] of shown.slice(0, 20)) {
        const pj = or(raw, {});
        cards.push(card(pyBasename(rstripSeps(p)) || p, [
          ["path", p],
          ["allowedTools", pyLen(or(pyGet(pj, "allowedTools", []), []))],
          ["mcpServers", Object.keys(dictOrThrow(or(pyGet(pj, "mcpServers"), {}))).join(", ") || "-"],
          ["trust", pyGet(pj, "hasTrustDialogAccepted", "-")],
        ], { badge: "project" }));
      }
    }
  }
  add(section("claude-json", cards, cj));

  // 2-1) MCP Servers (project): <root>/.mcp.json. 프로젝트를 지정했을 때만 의미가 있다
  //      (전역 .mcp.json 개념은 없음 - 전역 MCP 는 .claude.json). 카드는 appendProjectCards 가 채운다.
  const hasProjects = truthy(projectDirs);
  if (hasProjects) add(section("mcp-project", [], null));

  // 3) Permissions + 4) Hooks (settings.json + settings.local.json 을 각각 출처로)
  const chain = settingsChain(get("code_settings"));
  const perm: Card[] = [], hook: Card[] = [];
  for (const f of chain) {
    perm.push(...permCards(f));
    hook.push(...hookCards(f));
  }
  const src = sourceLabel(chain);
  add(section("perm", perm, src));
  add(section("hooks", hook, src));

  // 지시 · 규칙. 전역 CLAUDE.md 는 ~/.claude/CLAUDE.md 하나뿐이다(아티팩트 기준).
  const ucm = get("user_claude_md") as string | null;
  add(section("claude-md", fileCard(ucm, "CLAUDE.md", null, null, "eager"), ucm));
  const rd = get("rules_dir") as string | null;
  add(section("rules", rulesCards(rd), rd));
  const osd = get("output_styles_dir") as string | null;
  add(section("output-styles", outputStyleCards(osd, activeOutputStyle(chain)), osd));

  const wd = get("workflows_dir") as string | null;
  const wf = globCards(wd, "*.js", "workflow", null, null, (rel) => itemEdit("workflow", rel, wd as string, null));
  wf.push(addCard("workflow", "＋ 새 워크플로"));
  add(section("workflows", wf, wd));
  const td = get("themes_dir") as string | null;
  add(section("themes", globCards(td, "*.json", "theme"), td));
  const amd = get("agent_memory_dir") as string | null;
  add(section("agent-memory", mdDirCards(amd, "agent-memory"), amd));
  // 프로젝트별 메모리와 .worktreeinclude 는 프로젝트를 지정했을 때만 채워진다.
  add(section("project-memory", [], pyJoin(home, ".claude", "projects")));
  if (hasProjects) add(section("worktreeinclude", [], null));

  // 5) Code Skills
  const sd = get("skills_dir") as string | null;
  add(section("skills", skillCards(sd), sd));

  // 6) Agents
  const ad = get("agents_dir") as string | null;
  add(section("agents", agentCards(ad), ad));

  // 6-1) Commands (슬래시 커맨드). 라이브러리는 commands 설치를 지원하는데 조회가 없었다.
  const cmdDir = get("commands_dir") as string | null;
  add(section("commands", commandCards(cmdDir), cmdDir));

  // 6-2) Plugins (~/.claude/plugins). 여기가 사각지대였다 - 플러그인이 주는
  //      스킬/에이전트/커맨드/hooks/MCP 는 ~/.claude/skills 가 아니라 플러그인 캐시에 있어서
  //      위 섹션들에 하나도 안 잡혔다.
  const pdir = (or(get("plugins_dir"), null) as string | null) || defaultPluginsDir();
  // enabledPlugins 우선순위 오름차순: 전역 먼저, 프로젝트 나중(프로젝트가 이긴다).
  const psettings = [...chain];
  for (const cdir of projectDirs || []) if (cdir && pyIsdir(cdir)) psettings.push(...dirSettings(cdir));
  const plugins = readPlugins(pdir, psettings);
  add(section("plugins", pluginSectionCards(plugins, get("code_settings") as string | null, chain), pdir));

  // 7) Scheduled tasks
  cards = [];
  const schd = get("scheduled_dir") as string | null;
  if (schd && pyIsdir(schd)) {
    for (const name of sortedListdir(schd)) {
      const full = pyJoin(schd, name);
      const skillMd = pyJoin(full, "SKILL.md");
      if (pyIsdir(full) && pyExists(skillMd)) {
        const meta = readFrontmatter(skillMd);
        cards.push(card(name, [
          ["desc", fm(meta, "description", "-")],
          ["schedule", or(fm(meta, "cron", null), null) ?? or(fm(meta, "schedule", null), null) ?? fm(meta, "fireAt", "-")],
          ["path", full],
        ], { badge: "scheduled", ok: true }));
      }
    }
  }
  add(section("scheduled", cards, schd));

  // 8) Desktop Skills (서버관리: 모든 manifest 머지 + creatorType 구분)
  cards = [];
  let mans = get("desktop_skill_manifest_glob") as string | string[] | null;
  if (typeof mans === "string") mans = [mans];
  const merged = new Map<string, Obj>();
  for (const mp of mans || []) {
    if (!(mp && pyExists(mp))) continue;
    const data = safeLoad(mp);
    for (const s of isDict(data) ? pyIter(or(pyGet(data, "skills"), [])) : []) {
      if (!isDict(s)) continue;
      const key = hashKey(or(pyGet(s, "skillId"), null) ?? pyGet(s, "name"));
      const prev = merged.get(key);
      if (prev === undefined || cmpStr(pyStrOf(or(pyGet(s, "updatedAt"), "")), pyStrOf(or(pyGet(prev, "updatedAt"), ""))) >= 0) {
        merged.set(key, s);
      }
    }
  }
  const items = [...merged.values()].sort((a, b) => {
    const d = Number(pyGet(a, "creatorType") !== "user") - Number(pyGet(b, "creatorType") !== "user");
    return d || pyCmp(pyGet(a, "name", ""), pyGet(b, "name", ""));
  });
  const nUser = items.filter((s) => pyGet(s, "creatorType") === "user").length;
  for (const s of items) {
    const ct = pyGet(s, "creatorType", "?");
    cards.push(card(pyGet(s, "name", "?"), [
      ["desc", pyGet(s, "description", "-")],
      ["creator", ct],
      ["enabled", pyGet(s, "enabled", "-")],
      ["updated", or(pyGet(s, "updatedAt"), "-")],
    ], { badge: ct === "user" ? "user" : "anthropic", ok: ct === "user", builtin: ct !== "user" }));
  }
  const msrc = mans && mans.length > 1 ? `${mans[0]}  (+${mans.length - 1} more)` : (mans && mans.length ? mans[0] : null);
  const d = section("desktop-skills", cards, msrc);
  d.note = `user ${nUser} / anthropic ${items.length - nUser}`;
  add(d);

  // 플러그인 항목을 먼저 합류시킨 뒤 프로젝트 항목을 얹는다. 양쪽 다 자기 접두사의
  // title 개수를 재계산하므로 순서가 개수를 어긋나게 만들지 않는다.
  appendPluginCards(state.sections, plugins, chain);
  if (hasProjects) appendProjectCards(state.sections, projectDirs!, chain);
  return state;
}

// --- 대화용 축약(필터 · compact · summary) ---
// 전체 dump 는 이 PC 에서 200KB 를 넘는다. 대시보드는 그걸 한 번 받아 그리지만, 대화에서
// Claude 가 "hooks 뭐 있어" 에 답하려고 전부를 받으면 컨텍스트가 그 질문 하나로 찬다.
// 필터는 섹션·스코프·이름 세 축이고, compact 는 카드에서 UI 전용 폼과 긴 kv 를 뺀다.

function cget(c: Obj, k: string, d: unknown = null): unknown {
  return Object.prototype.hasOwnProperty.call(c, k) ? c[k] : d;
}

function cardText(c: Card): string {
  const parts: unknown[] = [cget(c, "name", ""), or(cget(c, "badge"), ""), or(cget(c, "project"), ""), or(cget(c, "plugin"), "")];
  for (const [, v] of cget(c, "kv", []) as [string, unknown][]) parts.push(pyStrOf(v));
  return parts.map(pyStrOf).join(" ").toLowerCase();
}

/**
 * sections=섹션 id 목록, scope=global|project, query=이름·값 부분일치(대소문자 무시).
 * 필터가 하나라도 걸리면 '+ 새 ...' 폼 카드는 뺀다 - 항목을 묻는 질문에 입력 폼은 답이 아니다.
 */
export function filterState(state: ConfigState, sections?: string[] | null, scope?: "global" | "project" | null, query?: string | null): ConfigState {
  const q = pyStrip(query || "").toLowerCase();
  const out: ConfigState = { ...state, sections: [] };
  for (const s of state.sections) {
    if (truthy(sections) && !sections!.includes(s.id)) continue;
    let cards = s.cards;
    if (scope || q) cards = cards.filter((c) => !isAddCard(c));
    if (scope === "global") cards = cards.filter((c) => cget(c, "scope") !== "project");
    else if (scope === "project") cards = cards.filter((c) => cget(c, "scope") === "project");
    if (q) cards = cards.filter((c) => cardText(c).includes(q));
    const sc = { ...s, cards };
    if (hasSec(sc.id)) recount(sc);
    out.sections.push(sc);
  }
  return out;
}

const COMPACT_KEEP = ["name", "badge", "scope", "project", "source", "plugin", "builtin", "load", "edit"];

/** Python `x in (None, False, "")`: == 비교라 0 도 False 와 같다. */
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === false || v === "" || v === 0;
}

/**
 * 카드를 식별·조작에 필요한 필드만으로 줄인다. edit 는 남긴다 - Claude 가 편집 도구에
 * 넘길 settings/dir 경로가 거기 있다. 서술은 첫 설명 키 하나를 200자로 자른다.
 */
export function compactState(state: ConfigState): ConfigState {
  const out: ConfigState = { ...state, sections: [] };
  for (const s of state.sections) {
    const cards: Card[] = [];
    for (const c of s.cards) {
      if (isAddCard(c)) continue;
      const n: Obj = {};
      for (const k of COMPACT_KEEP) if (Object.prototype.hasOwnProperty.call(c, k) && !isBlank(c[k])) n[k] = c[k];
      for (const [k, v] of cget(c, "kv", []) as [string, unknown][]) {
        if (DESC_KEYS.has(pyStrOf(k).toLowerCase()) && truthy(v)) {
          n.desc = short(v, 200);
          break;
        }
      }
      cards.push(n as Card);
    }
    const sc = { ...s, cards };
    if (hasSec(sc.id)) recount(sc);
    out.sections.push(sc);
  }
  return out;
}

// 같은 이름이 전역과 프로젝트에 함께 있을 때 실제로 적용되는 쪽. UI 의 배지 규칙과 같다:
// 에이전트·커맨드는 프로젝트가, 스킬은 전역(개인)이 이긴다.
const COLLISION_WINNER: Record<string, string> = { skills: "global", agents: "project", commands: "project" };

/** perm 카드 이름(allow/deny/ask)은 파일마다 반복되므로 출처를 붙여야 구별된다. */
function summaryName(secId: string, c: Card): unknown {
  if (secId !== "perm" || !truthy(cget(c, "source"))) return c.name;
  let src = pyBasename(c.source as string);
  if (truthy(cget(c, "project"))) {
    const proj = pyBasename(rstripSeps(pyStrOf(c.project)));
    src = `${proj}/${src}`;
  }
  return `${pyStrOf(c.name)} (${src})`;
}

/**
 * 섹션별 개수·적재등급·이름 목록과 이름 충돌·플러그인 상태만 담은 개요.
 * 상세는 filterState 로 내려간다(2단 구조).
 */
export function summarize(state: ConfigState): Record<string, unknown> {
  const secs: Obj[] = [];
  const collisions: Obj[] = [];
  const pluginStates: Record<string, number> = {};
  for (const s of state.sections) {
    const cards = s.cards.filter((c) => !isAddCard(c));
    const reg = hasSec(s.id) ? SECTIONS[s.id] : null;
    const globNames = new Map<string, true>();
    const projNames = new Map<string, [unknown, unknown[]]>();
    let nPlugin = 0, nBuiltin = 0;
    for (const c of cards) {
      if (truthy(cget(c, "plugin"))) nPlugin++;
      if (truthy(cget(c, "builtin"))) nBuiltin++;
      const key = hashKey(c.name);
      if (cget(c, "scope") === "project") {
        if (!projNames.has(key)) projNames.set(key, [c.name, []]);
        projNames.get(key)![1].push(or(cget(c, "project"), ""));
      } else if (!globNames.has(key)) globNames.set(key, true);
    }
    const entry: Obj = {
      id: s.id,
      title: reg ? reg.title : s.title.split(" · ")[0],
      group: cget(s as unknown as Obj, "group"),
      load: cget(s as unknown as Obj, "load"),
      count: cards.length,
      global: cards.filter((c) => cget(c, "scope") !== "project").length,
      project: cards.filter((c) => cget(c, "scope") === "project").length,
      names: cards.map((c) => summaryName(s.id, c)),
    };
    if (nPlugin) entry.plugin = nPlugin;
    if (nBuiltin) entry.builtin = nBuiltin;
    if (truthy(cget(s as unknown as Obj, "note"))) entry.note = s.note;
    secs.push(entry);
    if (Object.prototype.hasOwnProperty.call(COLLISION_WINNER, s.id)) {
      for (const [key, [name, projs]] of projNames) {
        if (globNames.has(key)) collisions.push({ section: s.id, name, projects: projs, wins: COLLISION_WINNER[s.id] });
      }
    }
    if (s.id === "plugins") {
      for (const c of cards) {
        const b = pyStrOf(or(cget(c, "badge"), "?"));
        put(pluginStates, b, (Object.prototype.hasOwnProperty.call(pluginStates, b) ? pluginStates[b] : 0) + 1);
      }
    }
  }
  return {
    generated: state.generated, sources: cget(state as unknown as Obj, "sources", {}),
    sections: secs, collisions, plugins: pluginStates,
  };
}

/** 지워진 경로는 realpath 가 8.3 표기를 긴 이름으로 못 풀므로 원래 표기와 realpath 를 둘 다 둔다. */
function excludedRoots(): Set<string> {
  const bases = [gettempdir()];
  if (process.env.APPDATA) bases.push(pyJoin(process.env.APPDATA, "Claude", "scratch-workspaces"));
  const out = new Set<string>();
  for (const b of bases) for (const f of [pyNormpath, realpath]) out.add(rstripSeps(pyNormcase(f(b))) + SEP);
  return out;
}

function isExcludedProject(p: string, roots: Set<string>): boolean {
  const cands = [pyNormpath, realpath].map((f) => pyNormcase(f(p)) + SEP);
  return cands.some((c) => [...roots].some((r) => c.startsWith(r)));
}

function projectShown(p: string, includeMissing: boolean, roots: Set<string>): boolean {
  if (isExcludedProject(p, roots)) return false;
  return includeMissing || pyIsdir(pyJoin(p, ".claude"));
}

/**
 * ~/.claude.json 의 projects 맵을 {path, name, claude_dir, has_claude} 리스트로. UI 의 원클릭 track 후보.
 * has_claude=false 행(.claude 없음 또는 경로 없음)은 includeMissing 일 때만 낸다.
 */
export function listProjects(found: Found, includeMissing = false): { path: string; name: string; claude_dir: string; has_claude: boolean }[] {
  const cj = Object.prototype.hasOwnProperty.call(found, "claude_json") ? found.claude_json : null;
  const out: { path: string; name: string; claude_dir: string; has_claude: boolean }[] = [];
  if (!(typeof cj === "string" && cj && pyExists(cj))) return out;
  const data = safeLoad(cj);
  if (!isDict(data) || errorOf(data)) return out;
  // 세션 CWD 표기가 그대로 키가 되어 같은 폴더가 대소문자·구분자·8.3 단축명만 다른 키로 남는다. 먼저 나온 표기만 낸다.
  const seen = new Set<string>();
  const roots = excludedRoots();
  for (const p of pyIter(or(pyGet(data, "projects"), {}))) {
    if (typeof p !== "string") throw new TypeError("expected str, bytes or os.PathLike object");
    const key = pyNormcase(realpath(p));
    if (seen.has(key)) continue;
    seen.add(key);
    if (!projectShown(p, includeMissing, roots)) continue;
    const cdir = pyJoin(p, ".claude");
    out.push({ path: p, name: pyBasename(rstripSeps(p)) || p, claude_dir: cdir, has_claude: pyIsdir(cdir) });
  }
  return out;
}

export interface DumpOpts {
  paths?: string[];
  projects?: string[] | null;
  includeMissing?: boolean;
  sections?: string[] | null;
  scope?: "global" | "project" | null;
  query?: string | null;
  compact?: boolean;
}

/** --paths 의 "key=path" 목록을 discover 의 extra 로. '=' 가 없는 항목은 버린다. */
function pathsExtra(paths?: string[] | null): Record<string, string> | null {
  if (!paths) return null;
  const extra: Record<string, string> = {};
  for (const kv of paths) {
    const i = kv.indexOf("=");
    if (i >= 0) put(extra, kv.slice(0, i), kv.slice(i + 1));
  }
  return extra;
}

export async function cmdDump(opts: DumpOpts): Promise<CliDoc> {
  return guard(() => {
    let state = parse(discover(pathsExtra(opts.paths)), opts.projects ?? null, !!opts.includeMissing);
    if (truthy(opts.sections) || opts.scope || opts.query) state = filterState(state, opts.sections, opts.scope, opts.query);
    if (opts.compact) state = compactState(state);
    emit(true, "ok", "Config details", { indent: 2, ...state });
  });
}

export async function cmdSummary(opts: { paths?: string[]; projects?: string[] | null; includeMissing?: boolean }): Promise<CliDoc> {
  return guard(() => {
    const found = discover(pathsExtra(opts.paths));
    emit(true, "ok", "Config summary", { indent: 2, ...summarize(parse(found, opts.projects ?? null, !!opts.includeMissing)) });
  });
}

export async function cmdProjects(opts: { paths?: string[]; includeMissing?: boolean }): Promise<CliDoc> {
  return guard(() => {
    // MCP structuredContent 는 객체여야 함(배열 금지) -> {projects:[...]} 로 감쌈.
    const rows = listProjects(discover(pathsExtra(opts.paths)), !!opts.includeMissing);
    emit(true, "ok", `Projects: ${rows.length}`, { indent: 2, projects: rows });
  });
}

/** argv 는 python claude_config.py 의 인자와 같다. discover 서브커맨드(봉투 없는 출력)는 다루지 않는다. */
export async function main(argv: string[]): Promise<CliDoc> {
  return guard(async () => {
    const ap = new JsonArgumentParser("claude_config");
    const sub = ap.addSubparsers({ dest: "cmd", required: true });
    for (const name of ["discover", "dump", "summary", "projects"]) {
      const sp = sub.addParser(name);
      sp.addArgument("--paths", { nargs: "*" });
      if (name !== "discover") sp.addArgument("--include-missing", { action: "store_true" });
      if (name === "dump" || name === "summary") sp.addArgument("--projects", { nargs: "*", default: null });
      if (name === "dump") {
        sp.addArgument("--sections", { nargs: "*", default: null });
        sp.addArgument("--scope", { choices: ["global", "project"], default: null });
        sp.addArgument("--query", { default: null });
        sp.addArgument("--compact", { action: "store_true" });
      }
    }
    const a = ap.parse(argv);
    const paths = (a.paths as string[] | null) ?? undefined;
    const includeMissing = !!a.include_missing;
    if (a.cmd === "discover") throw new Error("discover prints without a result envelope and is not supported by the TS port");
    if (a.cmd === "projects") return cmdProjects({ paths, includeMissing });
    const projects = (a.projects as string[] | null) ?? null;
    if (a.cmd === "summary") return cmdSummary({ paths, projects, includeMissing });
    return cmdDump({
      paths, projects, includeMissing,
      sections: a.sections as string[] | null, scope: a.scope as "global" | "project" | null,
      query: a.query as string | null, compact: !!a.compact,
    });
  });
}
