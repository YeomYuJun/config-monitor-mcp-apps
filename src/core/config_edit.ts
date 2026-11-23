// config_edit.ts - Claude 설정 파일 안전 편집기(스냅샷 선행 + atomic write + .bak). src/config_edit.py 이식.
//
// 안전장치:
//   1) 편집 전 cas 스냅샷 시도(추적 중이면 롤백 지점 생성). 실패해도 편집은 진행.
//   2) 편집 전 타임스탬프 .bak 백업.
//   3) tmp 파일에 쓴 뒤 JSON 파싱 검증 통과해야 rename 으로 원자적 교체.
//
// 대상:
//   ~/.claude/settings.json                          permissions / hooks / enabledPlugins
//   ~/.claude.json                                   전역 mcpServers (scope=user)
//   <Desktop>/claude_desktop_config.json             Desktop mcpServers (scope=desktop)
//     <Desktop> = Win32 는 %APPDATA%/Claude, MSIX/Store 는 패키지 하위. paths.ts 가 프로브해 해석.
//   ~/.claude/skills/<name>/                         code 스킬 (scaffold/remove)
//   ~/.claude/agents/<name>.md                       에이전트 (scaffold/remove)
//     --skills-dir/--agents-dir 로 프로젝트-로컬(<root>/.claude/skills) 지정 가능.
//     형태는 <...>/.claude/<skills|agents> 로 제한(safeConfigDir).
//
// 파괴적 삭제는 없다: JSON 편집은 스냅샷+.bak+atomic, 파일/디렉토리 삭제는 .trash 이동.
import fs from "node:fs";
import { JsonArgumentParser, emit, guard, type CliDoc, type EmitExtra } from "./cli_result.ts";
import * as paths from "./paths.ts";  // read(claude_config) 와 동일한 해석기로 Desktop config 경로를 잡는다
import * as cas from "./cas.ts";      // 스냅샷은 in-process 로 찍는다(락을 편집 전후로 걸쳐 쥐기 위해, snapshotBefore 주석)
import {
  attributeError, basename, dirname, isDict, normcase, normpath, pjoin as pyJoin, pyDumpsEx, pyLoads, pyNow,
  readJsonFile, stamp as pyStamp, type LockHandle,
} from "./lib_store.ts";

/** 부모 파서 옵션(Python 에서는 서브커맨드 앞). 생략 시 기본값은 docs/port-contract-2026-11-20.md 3.3절. */
export interface EditOpts {
  settings?: string;
  skillsDir?: string;
  agentsDir?: string;
  itemsDir?: string | null;
  memoryDir?: string | null;
  claudeJson?: string;
  desktopConfig?: string;
  /** 생략 시 env CLAUDE_SNAPSHOT_STORE, 그것도 없으면 cas 기본 스토어. */
  store?: string | null;
  noSnapshot?: boolean;
}

export type ItemKind = "rule" | "output-style" | "workflow";

/** 편집 함수의 반환: [고친 문서, 메시지, 바뀌었는지]. */
export type OpResult = [Record<string, unknown>, string, boolean];

type Obj = Record<string, unknown>;

const WIN = process.platform === "win32";

function home(): string {
  return paths.expanduser("~");
}

// 단일 파일 항목(하위 디렉토리, 확장자). skills 는 디렉토리형이라 여기 없다. 이쪽은 파일 하나가
// 항목 하나라서 scaffold/remove 한 쌍이 세 종류를 다 덮는다.
const ITEM_KINDS: Record<ItemKind, [string, string]> = {
  "rule": ["rules", ".md"],
  "output-style": ["output-styles", ".md"],
  "workflow": ["workflows", ".js"],
};

const SETTINGS_NAMES = ["settings.json", "settings.local.json"];

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const isObj = isDict;

function has(o: Obj, k: string): boolean {
  return Object.hasOwn(o, k);
}

/** o[k] = v. "__proto__" 같은 이름도 프로토타입이 아니라 자기 키로 넣는다. */
function put(o: Obj, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
}

/** Python dict.get 에 해당. 객체가 아니면 AttributeError 와 같은 자리에서 던진다(guard 가 internal 로 만든다). */
function asDict(v: unknown, what: string): Obj {
  if (!isObj(v)) throw attributeError(v, what);
  return v;
}

/** time.strftime('%Y%m%d%H%M%S'): 로컬 시각. */
function stamp(): string {
  return pyStamp(pyNow());
}

// 설정 파일은 소수(1e-07)와 2^53 을 넘는 정수를 Python 판과 같은 표기로 다시 써야 하므로 PyFloat·bigint 로 읽는다.
const LOADS = { floats: true } as const;

// ----- 다른 모듈이 부르는 함수 -----

/** 결과 문서를 던진다. 인자 순서가 emit 과 다르다(message, code). */
export function out(ok: boolean, message: string, code: string, extra: EmitExtra = {}): never {
  return emit(ok, code, message, extra);
}

/** 파일이 없으면 {}. utf-8-sig. 깨진 JSON 은 던진다. */
export function load(filePath: string): unknown {
  // utf-8-sig: PowerShell Out-File 등이 남기는 BOM 을 견딘다(utf-8 로 열면 JSON 파서가 거부해
  // 편집이 전부 예외로 죽고 stdout 순수 JSON 계약도 깨진다). BOM 없는 파일도 동일 처리.
  if (!exists(filePath)) return {};
  return readJsonFile(filePath, LOADS);
}

/** d[key] 가 객체가 아니면 {} 로 바꿔 넣고 그것을 돌려준다. 손편집으로 남은 null 을 빈 값으로 되살린다. */
export function slotDict(d: Record<string, unknown>, key: string): Record<string, unknown> {
  const o = asDict(d, "get");
  let v = has(o, key) ? o[key] : undefined;
  if (!isObj(v)) {
    v = {};
    put(o, key, v);
  }
  return v as Obj;
}

/** d[key] 를 배열로 보장하고 반환(slotDict 와 동일 취지). */
function slotList(d: Obj, key: string): unknown[] {
  const o = asDict(d, "get");
  let v = has(o, key) ? o[key] : undefined;
  if (!Array.isArray(v)) {
    v = [];
    put(o, key, v);
  }
  return v as unknown[];
}

/** <path>.<YYYYmmddHHMMSS>.bak 로 복사(mtime 보존). 파일이 없으면 null. */
export function backup(filePath: string): string | null {
  if (!exists(filePath)) return null;
  const bak = `${filePath}.${stamp()}.bak`;
  // Windows 의 CopyFileW 는 수정 시각을 그대로 옮긴다. 그 밖의 플랫폼은 copy2 처럼 직접 맞춘다.
  fs.copyFileSync(filePath, bak);
  if (!WIN) {
    const st = fs.statSync(filePath);
    fs.utimesSync(bak, st.atime, st.mtime);
  }
  return bak;
}

/**
 * JSON 직렬화 + 원자 교체. 개행은 기존 파일의 방식(CRLF/LF)을 따라 bytes 로 쓴다.
 * 텍스트 모드처럼 \n 을 \r\n 으로 바꿔 쓰면 LF 파일(Claude Code 가 쓰는 형식) 전체가 뒤집히고,
 * 이후 diff 가 전량 삭제+추가로 보인다. 새 파일은 LF.
 */
export function saveAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  let text = pyDumpsEx(data, { indent: 2, ensureAscii: false });
  let crlf = false;
  try {
    crlf = fs.readFileSync(filePath).includes("\r\n");
  } catch {
    crlf = false;
  }
  if (crlf) text = text.replace(/\n/g, "\r\n");
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, Buffer.from(text, "utf8"));
  readJsonFile(tmp);  // 검증
  fs.renameSync(tmp, filePath);
}

/** 형제 .trash/<name>.<ts> 로 이동(rm 대신). 디렉토리 삭제도 복구 가능하게. */
export function trash(filePath: string): string {
  const n = normpath(filePath);
  const tdir = pyJoin(dirname(n), ".trash");
  fs.mkdirSync(tdir, { recursive: true });
  const dst = pyJoin(tdir, `${basename(n)}.${stamp()}`);
  // shutil.move 는 대상이 이미 있는 디렉토리면 그 안으로 옮긴다.
  const real = isDir(dst) ? pyJoin(dst, basename(n)) : dst;
  fs.renameSync(filePath, real);
  return dst;
}

/**
 * --settings 검증: <...>/.claude/settings[.local].json 형태만 허용. 실패하면 invalid_arg 문서를 던지고 성공하면 normpath.
 * safeConfigDir 이 디렉토리 인자에 거는 제약을 파일 인자에도 건다. 이쪽만 비어 있으면
 * saveAtomic 의 mkdir 이 임의 경로에 트리를 만들며 JSON 을 쓴다(도구 파라미터로 노출된 값이다).
 * 실제 대상은 전역(~/.claude)과 프로젝트(<root>/.claude) 둘뿐이라 호출부는 그대로.
 * Claude 가 읽는 이름은 settings.json / settings.local.json 두 개다(claude_config 의 settings 탐색).
 */
export function safeSettingsPath(p: string): string {
  const n = normpath(p);
  if (!SETTINGS_NAMES.map(normcase).includes(normcase(basename(n))) ||
      normcase(basename(dirname(n))) !== normcase(".claude")) {
    out(false, `Invalid settings path (only <...>/.claude/settings[.local].json is allowed): '${p}'`, "invalid_arg", { target: p });
  }
  return n;
}

/**
 * --skills-dir/--agents-dir/--items-dir 검증: <...>/.claude/<sub> 형태만 허용.
 * 이 옵션들이 MCP 도구 파라미터(프로젝트-로컬 삭제)로 노출되면서 임의 경로가 trash() 까지
 * 도달할 수 있게 됐다. safeName 은 이름 세그먼트만 막으므로 디렉토리도 한 겹 막는다.
 * 전역(~/.claude/skills)과 프로젝트(<root>/.claude/skills) 둘 다 이 형태라 호출부는 그대로.
 */
function safeConfigDir(d: string, sub: string): string {
  const n = normpath(d);
  if (normcase(basename(n)) !== normcase(sub) || normcase(basename(dirname(n))) !== normcase(".claude")) {
    out(false, `Invalid config directory (only <...>/.claude/${sub} is allowed): '${d}'`, "invalid_arg", { target: d });
  }
  return n;
}

/**
 * --memory-dir 검증: <...>/projects/<encoded>/memory 형태만 허용.
 * 메모리는 .claude/<sub> 형태가 아니라 safeConfigDir 을 못 쓴다. 가드 없이 두면
 * 도구 파라미터로 들어온 임의 경로가 trash() 까지 도달한다.
 */
function safeMemoryDir(d: string): string {
  const n = normpath(d);
  if (normcase(basename(n)) !== normcase("memory") ||
      normcase(basename(dirname(dirname(n)))) !== normcase("projects")) {
    out(false, `Invalid memory directory (only <...>/projects/<name>/memory is allowed): '${d}'`, "invalid_arg", { target: d });
  }
  return n;
}

/** 디렉토리 탈출/경로 주입 방지: 이름은 경로 구분자·상대참조 없이 단일 세그먼트만. */
function safeName(name: string): string {
  if (!name || name !== basename(name) || name === "." || name === ".." || /[\\/]/.test(name)) {
    out(false, `Invalid name: '${name}'`, "invalid_arg", { target: name });
  }
  return name;
}

/**
 * workflow 는 meta 블록이 없으면 실행되지 않으므로 스텁도 그 형태를 지켜야 한다.
 * rule 의 paths: 는 적재 등급을 EAGER 에서 LAZY 로 바꾼다(빈 값이면 넣지 않는다).
 */
function itemStub(kind: ItemKind, name: string, desc: string, paths_ = ""): string {
  if (kind === "workflow") {
    return `export const meta = {\n` +
      `  name: '${name}',\n` +
      `  description: '${desc}',\n` +
      `  phases: [{ title: 'Work' }],\n` +
      `}\n\nphase('Work')\n`;
  }
  const fm = [`name: ${name}`, `description: ${desc}`];
  if (kind === "rule" && paths_) fm.push(`paths:\n  - ${paths_}`);
  return "---\n" + fm.join("\n") + `\n---\n\n# ${name}\n\n작성 중.\n`;
}

// ----- 스냅샷 스팬 -----

// snapshotBefore 가 잡은 스냅샷 락을 snapshotAfter 까지 들고 가는 스팬 상태.
const span: { lock: LockHandle | null; p: cas.StorePaths | null } = { lock: null, p: null };

function storeP(store: string | null | undefined): cas.StorePaths {
  return cas.storePaths(store || cas.defaultStore());
}

/** Python _release_span: guard 의 cleanup. 쥐고 있는 스냅샷 락을 놓는다. */
export function releaseSpan(): void {
  const lock = span.lock;
  span.lock = span.p = null;
  if (lock !== null) {
    try {
      lock.release();
    } catch {
      // 해제 실패는 무시한다(락은 stale 판정으로 회수된다).
    }
  }
}

/**
 * 편집 직전: 아직 스냅샷 안 된 변경(대시보드 밖 편집)을 롤백 지점으로 보존하고,
 * 스냅샷 락을 잡은 채 유지한다. 락은 snapshotAfter 가 op 스냅샷을 찍은 뒤 푼다.
 * 풀어 두면 파일 쓰기와 op 스냅샷 사이에 watcher tick 이 먼저 찍어 편집 결과가
 * 'auto:' 메시지로 기록되고, 리비전에 작업 이름이 남지 않는다(경합 가드).
 * 실패는 무시(편집 자체는 진행).
 */
export async function snapshotBefore(store: string | null | undefined): Promise<void> {
  try {
    if (span.p !== null) {          // 이미 스팬 안: 드리프트만 추가 캡처
      await cas.takeSnapshotLocked(span.p, "external change (before edit)");
      return;
    }
    const p = storeP(store);
    const lock = await cas.acquireSnapshotLock(p);
    span.lock = lock;
    span.p = p;
    await cas.takeSnapshotLocked(p, "external change (before edit)");
  } catch {
    releaseSpan();
  }
}

/**
 * 편집 직후: 이 편집의 결과를 op 메시지로 스냅샷 후 락 해제. 전에는 pre-스냅샷만
 * 있어서 리비전 N 의 diff 가 N-1 편집 내용을 보여주는 오프바이원 귀속이 났다.
 * snapshotBefore 가 실패했으면 단독 락으로라도 찍는다.
 */
export async function snapshotAfter(store: string | null | undefined, message: string): Promise<void> {
  try {
    if (span.p !== null) {
      await cas.takeSnapshotLocked(span.p, message);
    } else {
      const p = storeP(store);
      await cas.withSnapshotLock(p, () => cas.takeSnapshotLocked(p, message));
    }
  } catch {
    // 스냅샷 실패는 편집 결과에 영향을 주지 않는다.
  } finally {
    releaseSpan();
  }
}

/**
 * 단발 스냅샷(락을 스팬으로 유지하지 않는다). 오래 걸리는 위임 작업(claude CLI 등)의
 * 전/후 캡처용. 스팬을 쓰면 60초 뒤 죽은 락으로 판정돼 회수된다(cas 의 LOCK_STALE_SEC).
 * 실패는 무시(작업 자체는 진행).
 */
export async function snapshotOnce(store: string | null | undefined, message: string): Promise<void> {
  try {
    const p = storeP(store);
    await cas.withSnapshotLock(p, () => cas.takeSnapshotLocked(p, message));
  } catch {
    // 위와 같다.
  }
}

// ----- ops (설정 딕셔너리를 받아 [설정, 메시지, 바뀌었는지] 반환) -----

export function opPermAdd(s: Obj, kind: string, rule: string): OpResult {
  const lst = slotList(slotDict(s, "permissions"), kind);
  if (lst.includes(rule)) return [s, `Already exists: ${kind} '${rule}'`, false];
  lst.push(rule);
  return [s, `Added: permissions.${kind} += '${rule}'`, true];
}

export function opPermRemove(s: Obj, kind: string, rule: string): OpResult {
  const lst = slotList(slotDict(s, "permissions"), kind);
  const i = lst.indexOf(rule);
  if (i < 0) return [s, `Not found (unchanged): ${kind} '${rule}'`, false];
  lst.splice(i, 1);
  return [s, `Removed: permissions.${kind} -= '${rule}'`, true];
}

export function opHookAdd(s: Obj, event: string, command: string, matcher?: string | null): OpResult {
  const arr = slotList(slotDict(s, "hooks"), event);
  arr.push({ matcher: matcher || "*", hooks: [{ type: "command", command }] });
  return [s, `Hook added: ${event} (matcher=${matcher || "*"}) <- ${command}`, true];
}

/**
 * command 가 needle 과 정확히 일치하는 훅만 제거.
 * 직렬화 JSON 에 부분 문자열로 맞추던 방식은 세 가지가 동시에 틀렸다:
 *   - 접두가 같은 다른 훅까지 제거('node a.js' 로 'node a.js --verbose' 까지)
 *   - 명령 속 " 나 \ 가 직렬화로 이스케이프돼 매칭 자체가 성립 안 함(제거 불가)
 *   - 엔트리째 버려서 같은 matcher 안의 형제 훅까지 소실
 * 훅 단위로 지우고 비게 된 엔트리·이벤트 키·hooks 딕셔너리까지 정리한다. 빈 껍데기를
 * 남기면 {"hooks":{"PostToolUse":[]}} 같은 찌꺼기가 사용자 settings.json 에 쌓인다.
 */
export function opHookRemove(s: Obj, event: string, needle: string): OpResult {
  const arr = slotList(slotDict(s, "hooks"), event);
  let removed = 0;
  const kept: unknown[] = [];
  for (const ent of arr) {
    if (!isObj(ent)) {
      kept.push(ent);
      continue;
    }
    const hooks = slotList(ent, "hooks");
    const left = hooks.filter((hk) => !(isObj(hk) && has(hk, "command") && hk.command === needle));
    removed += hooks.length - left.length;
    put(ent, "hooks", left);
    if (left.length) kept.push(ent);
  }
  arr.splice(0, arr.length, ...kept);
  if (removed && !arr.length) {
    const hooksMap = s.hooks;
    if (isObj(hooksMap)) {
      delete hooksMap[event];
      if (!Object.keys(hooksMap).length) delete s.hooks;
    }
  }
  return [s, `Hooks removed (${removed}): ${event} ~ '${needle}'`, removed > 0];
}

/**
 * settings.json 의 enabledPlugins[<id>] 만 건드린다.
 *
 * id 는 '<플러그인 이름>@<마켓 이름>' 이고 마켓 매니페스트 엔트리 이름 쪽에서 온다.
 * plugin.json 의 name(표시 네임스페이스)과 다를 수 있다. 실측: 매니페스트는 'notion',
 * plugin.json 은 'Notion', 세션 표시는 'Notion:create-page', 토글 키는
 * 'notion@claude-plugins-official'. 그래서 여기서 대소문자 정규화 같은 걸 하지 않는다.
 * 호출부는 plugin_state 가 준 id 를 그대로 넘겨야 한다.
 *
 * 대상 파일은 --settings 로 온다. plugin_state 의 enabled 판정이 그 값을 정한 파일을
 * enabled_from 에 남기고 카드가 그걸 들고 오므로, 프로젝트에서 켠 플러그인을 전역
 * 파일에서 껐다가 안 먹는 상황이 생기지 않는다.
 *
 * 적용은 다음 세션부터다. Claude Code 가 enabledPlugins 를 세션 시작 시 읽는다.
 */
export function opPluginToggle(s: Obj, pid: string, on: boolean): OpResult {
  if (!pid) return [s, "Plugin id is empty", false];
  if (!has(s, "enabledPlugins")) put(s, "enabledPlugins", {});
  const m = asDict(s.enabledPlugins, "get");
  if (has(m, pid) && m[pid] === on) return [s, `Already ${on ? "enabled" : "disabled"}: ${pid}`, false];
  put(m, pid, on);
  return [s, `Plugin ${on ? "enabled" : "disabled"}: ${pid} (applies from the next session)`, true];
}

export function opMcpAdd(d: Record<string, unknown>, name: string, server: unknown): OpResult {
  const servers = slotDict(d, "mcpServers");
  const existed = has(servers, name);
  put(servers, name, server);
  return [d, `${existed ? "Updated" : "Added"}: mcpServers.${name}`, true];
}

export function opMcpRemove(d: Record<string, unknown>, name: string): OpResult {
  // 없거나 null 이면 제거할 것도 없음(키를 새로 만들지 않는다).
  const v = asDict(d, "get").mcpServers;
  const servers = v ? asDict(v, "__contains__") : {};
  if (!has(servers, name)) return [d, `Not found (unchanged): mcpServers.${name}`, false];
  delete servers[name];
  return [d, `Removed: mcpServers.${name}`, true];
}

// ----- 실행 -----

interface Base {
  settings: string;
  skillsDir: string;
  agentsDir: string;
  itemsDir: string | null;
  memoryDir: string | null;
  claudeJson: string;
  desktopConfig: string;
  store: string | null;
  noSnapshot: boolean;
}

type Args = Base & ({ op: "perm-add" | "perm-remove"; kind: string; rule: string }
  | { op: "hook-add"; event: string; command: string; matcher: string | null }
  | { op: "hook-remove"; event: string; needle: string }
  | { op: "skill-scaffold"; name: string; desc: string; content: string | null }
  | { op: "skill-remove" | "agent-remove" | "memory-remove" | "outputstyle-set"; name: string }
  | { op: "agent-scaffold"; name: string; desc: string; tools: string; model: string; content: string | null }
  | { op: "item-scaffold"; kind: ItemKind; name: string; desc: string; paths: string; content: string | null }
  | { op: "item-remove"; kind: ItemKind; name: string }
  | { op: "plugin-toggle"; id: string; state: "on" | "off" }
  | { op: "mcp-add"; name: string; serverJson: string; scope: "user" | "desktop" }
  | { op: "mcp-remove"; name: string; scope: "user" | "desktop" });

function base(o: EditOpts): Base {
  const h = home();
  return {
    settings: o.settings ?? pyJoin(h, ".claude", "settings.json"),
    skillsDir: o.skillsDir ?? pyJoin(h, ".claude", "skills"),
    agentsDir: o.agentsDir ?? pyJoin(h, ".claude", "agents"),
    itemsDir: o.itemsDir ?? null,
    memoryDir: o.memoryDir ?? null,
    claudeJson: o.claudeJson ?? pyJoin(h, ".claude.json"),
    // Win32(%APPDATA%\Claude) vs MSIX/Store(...\Packages\Claude_*\LocalCache\Roaming\Claude)
    // 를 프로브해 실제 파일을 대상으로 삼는다. --desktop-config 로 명시 오버라이드 가능.
    desktopConfig: o.desktopConfig ?? paths.desktopConfigPath(),
    store: o.store !== undefined ? o.store : process.env.CLAUDE_SNAPSHOT_STORE ?? null,
    noSnapshot: !!o.noSnapshot,
  };
}

/** settings 외 임의 JSON 설정 파일에 동일한 안전 패턴 적용. */
async function editJsonFile(file: string, mutate: (d: Obj) => OpResult, noSnapshot: boolean, store: string | null): Promise<never> {
  const [data, msg, changed] = mutate(load(file) as Obj);
  if (!changed) out(true, msg + " (no-op)", "noop", { changed: false });
  if (!noSnapshot) await snapshotBefore(store);
  const bak = backup(file);
  saveAtomic(file, data);
  if (!noSnapshot) await snapshotAfter(store, msg);
  return out(true, msg, "ok", { changed: true, file, backup: bak });
}

async function writeNew(a: Base, file: string, dir: string, body: string, msg: string, field: Obj): Promise<never> {
  if (!a.noSnapshot) await snapshotBefore(a.store);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  if (!a.noSnapshot) await snapshotAfter(a.store, msg);
  return out(true, msg, "ok", field);
}

async function moveToTrash(a: Base, target: string, msg: string): Promise<never> {
  if (!a.noSnapshot) await snapshotBefore(a.store);
  const dst = trash(target);
  if (!a.noSnapshot) await snapshotAfter(a.store, msg);
  return out(true, msg, "ok", { trashed: dst });
}

async function execute(a: Args): Promise<never> {
  // 경로 인자는 쓰이기 전에 형태 검증(safeSettingsPath / safeConfigDir 주석 참고).
  a.settings = safeSettingsPath(a.settings);
  if (a.op === "skill-scaffold" || a.op === "skill-remove") {
    a.skillsDir = safeConfigDir(a.skillsDir, "skills");
    if (paths.RESERVED_SKILL_DIRS.includes(a.name) &&
        normcase(a.skillsDir) === normcase(normpath(pyJoin(home(), ".claude", "skills")))) {
      out(false, `'${a.name}' cannot be edited because claude.ai account skills sync into this folder`,
        "invalid_arg", { target: pyJoin(a.skillsDir, a.name) });
    }
  } else if (a.op === "agent-scaffold" || a.op === "agent-remove") {
    a.agentsDir = safeConfigDir(a.agentsDir, "agents");
  } else if (a.op === "item-scaffold" || a.op === "item-remove") {
    const sub = ITEM_KINDS[a.kind][0];
    a.itemsDir = safeConfigDir(a.itemsDir || pyJoin(home(), ".claude", sub), sub);
  } else if (a.op === "memory-remove") {
    if (!a.memoryDir) out(false, "memory-remove requires --memory-dir", "invalid_arg", { target: "--memory-dir" });
    a.memoryDir = safeMemoryDir(a.memoryDir);
  }

  switch (a.op) {
    // 단일 파일 항목 ops (rules / output-styles / workflows)
    case "item-scaffold": {
      const name = safeName(a.name);
      const fPath = pyJoin(a.itemsDir!, name + ITEM_KINDS[a.kind][1]);
      if (exists(fPath)) out(false, `Already exists: ${fPath}`, "exists", { target: fPath });
      const body = a.content ? a.content : itemStub(a.kind, name, a.desc, a.paths);
      return writeNew(a, fPath, a.itemsDir!, body, `${a.kind} ${a.content ? "installed" : "scaffolded"}: ${fPath}`, { path: fPath });
    }
    case "item-remove": {
      const name = safeName(a.name);
      const fPath = pyJoin(a.itemsDir!, name + ITEM_KINDS[a.kind][1]);
      if (!exists(fPath)) out(false, `${a.kind} not found: ${fPath}`, "not_found", { target: fPath });
      return moveToTrash(a, fPath, `${a.kind} removed (moved to .trash): ${name}`);
    }
    case "memory-remove": {
      const name = safeName(a.name);
      const fPath = pyJoin(a.memoryDir!, name + ".md");
      if (!exists(fPath)) out(false, `Memory not found: ${fPath}`, "not_found", { target: fPath });
      return moveToTrash(a, fPath, `Memory removed (moved to .trash): ${name}`);
    }
    case "outputstyle-set": {
      // 파일을 만드는 게 아니라 '무엇이 EAGER 인가'를 바꾸는 유일한 스위치다.
      const name = a.name;
      return editJsonFile(a.settings, (d) => {
        const o = asDict(d, "get");
        const cur = has(o, "outputStyle") ? o.outputStyle : null;
        if (name) {
          put(o, "outputStyle", name);
          return [o, `Output style set: ${name}`, cur !== name];
        }
        delete o.outputStyle;
        return [o, "Output style cleared", cur !== null];
      }, a.noSnapshot, a.store);
    }
    // 파일/디렉토리 기반 ops (skills / agents)
    case "skill-scaffold": {
      const name = safeName(a.name);
      const d = pyJoin(a.skillsDir, name);
      const md = pyJoin(d, "SKILL.md");
      if (exists(md)) out(false, `Already exists: ${md}`, "exists", { target: md });
      const body = a.content ? a.content : `---\nname: ${name}\ndescription: ${a.desc}\n---\n\n# ${name}\n\n작성 중.\n`;
      return writeNew(a, md, d, body, `Skill ${a.content ? "installed" : "scaffolded"}: ${md}`, { path: md });
    }
    case "skill-remove": {
      const name = safeName(a.name);
      const d = pyJoin(a.skillsDir, name);
      if (!isDir(d)) out(false, `Skill not found: ${d}`, "not_found", { target: d });
      return moveToTrash(a, d, `Skill removed (moved to .trash): ${name}`);
    }
    case "agent-scaffold": {
      const name = safeName(a.name);
      const md = pyJoin(a.agentsDir, `${name}.md`);
      if (exists(md)) out(false, `Already exists: ${md}`, "exists", { target: md });
      let body: string;
      if (a.content) {
        body = a.content;
      } else {
        const fm = [`name: ${name}`, `description: ${a.desc}`];
        if (a.tools) fm.push(`tools: ${a.tools}`);
        if (a.model) fm.push(`model: ${a.model}`);
        body = "---\n" + fm.join("\n") + `\n---\n\n# ${name}\n\n작성 중.\n`;
      }
      return writeNew(a, md, a.agentsDir, body, `Agent ${a.content ? "installed" : "scaffolded"}: ${md}`, { path: md });
    }
    case "agent-remove": {
      const name = safeName(a.name);
      // <name>.md 파일 또는 <name>/ 디렉토리(AGENT.md 형) 둘 다 지원
      const target = [pyJoin(a.agentsDir, `${name}.md`), pyJoin(a.agentsDir, name)].find(exists);
      if (target === undefined) out(false, `Agent not found: ${name} (${a.agentsDir})`, "not_found", { target: name });
      return moveToTrash(a, target, `Agent removed (moved to .trash): ${name}`);
    }
    // mcpServers ops: scope 에 따라 대상 파일 선택
    case "mcp-add": {
      const target = a.scope === "desktop" ? a.desktopConfig : a.claudeJson;
      let server: unknown;
      try {
        server = pyLoads(a.serverJson, LOADS);
      } catch (e) {
        out(false, `Failed to parse --json: ${(e as Error).message}`, "invalid_arg", { target: "--json" });
      }
      if (!isObj(server)) {
        out(false, "--json must be a server config object (e.g. {\"command\":\"npx\",\"args\":[...]})", "invalid_arg", { target: "--json" });
      }
      const name = a.name;
      return editJsonFile(target, (d) => opMcpAdd(d, name, server), a.noSnapshot, a.store);
    }
    case "mcp-remove": {
      const target = a.scope === "desktop" ? a.desktopConfig : a.claudeJson;
      const name = a.name;
      return editJsonFile(target, (d) => opMcpRemove(d, name), a.noSnapshot, a.store);
    }
  }

  // 이하 settings.json 편집
  let s = load(a.settings) as Obj;
  let msg: string;
  let changed: boolean;
  if (a.op === "perm-add") [s, msg, changed] = opPermAdd(s, a.kind, a.rule);
  else if (a.op === "perm-remove") [s, msg, changed] = opPermRemove(s, a.kind, a.rule);
  else if (a.op === "hook-add") [s, msg, changed] = opHookAdd(s, a.event, a.command, a.matcher);
  else if (a.op === "hook-remove") [s, msg, changed] = opHookRemove(s, a.event, a.needle);
  else if (a.op === "plugin-toggle") [s, msg, changed] = opPluginToggle(s, a.id, a.state === "on");
  else return out(false, `Unknown op: ${(a as { op: string }).op}`, "invalid_arg", { target: (a as { op: string }).op });

  if (!changed) out(true, msg + " (no-op)", "noop", { changed: false });
  if (!a.noSnapshot) await snapshotBefore(a.store);
  const bak = backup(a.settings);
  saveAtomic(a.settings, s);
  if (!a.noSnapshot) await snapshotAfter(a.store, msg);
  return out(true, msg, "ok", { changed: true, settings: a.settings, backup: bak });
}

// Python 판은 호출마다 프로세스가 따로라 스팬 상태를 나눠 쓸 일이 없었다. 한 프로세스 안에서는
// 동시에 들어온 두 편집이 같은 스팬을 쓰고(먼저 끝난 쪽이 상대의 락을 놓는다) 읽기-쓰기 사이에
// 서로의 결과를 덮으므로, 편집 하나가 끝날 때까지 다음 편집을 기다리게 한다.
let editTail: Promise<void> = Promise.resolve();

/**
 * fn 을 이 모듈의 다른 편집과 겹치지 않게 실행한다. snapshotBefore~snapshotAfter 구간을 직접 쓰는
 * 다른 모듈(library, transfer)도 그 구간을 이것으로 감싸야 스팬을 나눠 쓰지 않는다. 재진입하지 않는다.
 */
export async function withEditLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = editTail;
  let done!: () => void;
  editTail = new Promise<void>((r) => { done = r; });
  await prev;
  try {
    return await fn();
  } finally {
    done();
  }
}

/** guard 로 감싸 문서를 돌려준다. 프로세스가 끝나지 않으므로 남은 스팬은 여기서 놓는다. */
async function run(fn: () => Promise<never>): Promise<CliDoc> {
  return withEditLock(async () => {
    try {
      return await guard(fn, undefined, releaseSpan);
    } finally {
      releaseSpan();
    }
  });
}

// ----- CLI 서브커맨드 -----

type Kind = "allow" | "deny" | "ask";

export async function cmdPermAdd(opts: EditOpts & { kind: Kind; rule: string }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "perm-add", kind: opts.kind, rule: opts.rule }));
}

export async function cmdPermRemove(opts: EditOpts & { kind: Kind; rule: string }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "perm-remove", kind: opts.kind, rule: opts.rule }));
}

export async function cmdHookAdd(opts: EditOpts & { event: string; command: string; matcher?: string | null }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "hook-add", event: opts.event, command: opts.command, matcher: opts.matcher ?? null }));
}

export async function cmdHookRemove(opts: EditOpts & { event: string; needle: string }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "hook-remove", event: opts.event, needle: opts.needle }));
}

export async function cmdSkillScaffold(opts: EditOpts & { name: string; desc?: string; content?: string | null }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "skill-scaffold", name: opts.name, desc: opts.desc ?? "TODO", content: opts.content ?? null }));
}

export async function cmdSkillRemove(opts: EditOpts & { name: string }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "skill-remove", name: opts.name }));
}

export async function cmdAgentScaffold(opts: EditOpts & { name: string; desc?: string; tools?: string; model?: string; content?: string | null }): Promise<CliDoc> {
  return run(() => execute({
    ...base(opts), op: "agent-scaffold", name: opts.name, desc: opts.desc ?? "TODO",
    tools: opts.tools ?? "", model: opts.model ?? "", content: opts.content ?? null,
  }));
}

export async function cmdAgentRemove(opts: EditOpts & { name: string }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "agent-remove", name: opts.name }));
}

export async function cmdItemScaffold(opts: EditOpts & { kind: ItemKind; name: string; desc?: string; paths?: string; content?: string | null }): Promise<CliDoc> {
  return run(() => execute({
    ...base(opts), op: "item-scaffold", kind: opts.kind, name: opts.name, desc: opts.desc ?? "TODO",
    paths: opts.paths ?? "", content: opts.content ?? null,
  }));
}

export async function cmdItemRemove(opts: EditOpts & { kind: ItemKind; name: string }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "item-remove", kind: opts.kind, name: opts.name }));
}

export async function cmdMemoryRemove(opts: EditOpts & { name: string }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "memory-remove", name: opts.name }));
}

export async function cmdOutputstyleSet(opts: EditOpts & { name: string }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "outputstyle-set", name: opts.name }));
}

export async function cmdPluginToggle(opts: EditOpts & { id: string; state: "on" | "off" }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "plugin-toggle", id: opts.id, state: opts.state }));
}

/** json 은 CLI --json 문자열 그대로(서버 설정 객체). */
export async function cmdMcpAdd(opts: EditOpts & { name: string; json: string; scope?: "user" | "desktop" }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "mcp-add", name: opts.name, serverJson: opts.json, scope: opts.scope ?? "user" }));
}

export async function cmdMcpRemove(opts: EditOpts & { name: string; scope?: "user" | "desktop" }): Promise<CliDoc> {
  return run(() => execute({ ...base(opts), op: "mcp-remove", name: opts.name, scope: opts.scope ?? "user" }));
}

function parser(): JsonArgumentParser {
  const h = home();
  const ap = new JsonArgumentParser("config_edit");
  ap.addArgument("--settings", { default: pyJoin(h, ".claude", "settings.json") });
  ap.addArgument("--skills-dir", { default: pyJoin(h, ".claude", "skills") });
  ap.addArgument("--agents-dir", { default: pyJoin(h, ".claude", "agents") });
  ap.addArgument("--items-dir", { default: null });
  ap.addArgument("--memory-dir", { default: null });
  ap.addArgument("--claude-json", { default: pyJoin(h, ".claude.json") });
  ap.addArgument("--desktop-config", { default: paths.desktopConfigPath() });
  ap.addArgument("--store", { default: process.env.CLAUDE_SNAPSHOT_STORE ?? null });
  ap.addArgument("--no-snapshot", { action: "store_true" });
  const sub = ap.addSubparsers({ dest: "op", required: true });
  const kinds = ["allow", "deny", "ask"];
  const items = Object.keys(ITEM_KINDS);
  let p = sub.addParser("perm-add"); p.addArgument("kind", { choices: kinds }); p.addArgument("rule");
  p = sub.addParser("perm-remove"); p.addArgument("kind", { choices: kinds }); p.addArgument("rule");
  p = sub.addParser("hook-add"); p.addArgument("event"); p.addArgument("command"); p.addArgument("--matcher");
  p = sub.addParser("hook-remove"); p.addArgument("event"); p.addArgument("needle");
  p = sub.addParser("skill-scaffold"); p.addArgument("name"); p.addArgument("--desc", { default: "TODO" });
  p.addArgument("--content", { default: null });
  p = sub.addParser("skill-remove"); p.addArgument("name");
  p = sub.addParser("agent-scaffold"); p.addArgument("name"); p.addArgument("--desc", { default: "TODO" });
  p.addArgument("--tools", { default: "" }); p.addArgument("--model", { default: "" });
  p.addArgument("--content", { default: null });
  p = sub.addParser("agent-remove"); p.addArgument("name");
  p = sub.addParser("item-scaffold"); p.addArgument("kind", { choices: items }); p.addArgument("name");
  p.addArgument("--desc", { default: "TODO" }); p.addArgument("--paths", { default: "" });
  p.addArgument("--content", { default: null });
  p = sub.addParser("item-remove"); p.addArgument("kind", { choices: items }); p.addArgument("name");
  p = sub.addParser("memory-remove"); p.addArgument("name");
  p = sub.addParser("outputstyle-set"); p.addArgument("name");
  p = sub.addParser("plugin-toggle"); p.addArgument("id"); p.addArgument("state", { choices: ["on", "off"] });
  p = sub.addParser("mcp-add"); p.addArgument("name"); p.addArgument("--json", { dest: "server_json", required: true });
  p.addArgument("--scope", { choices: ["user", "desktop"], default: "user" });
  p = sub.addParser("mcp-remove"); p.addArgument("name");
  p.addArgument("--scope", { choices: ["user", "desktop"], default: "user" });
  return ap;
}

/** argv 는 python config_edit.py 의 인자와 같다. */
export async function main(argv: string[]): Promise<CliDoc> {
  return run(() => {
    const ns = parser().parse(argv);
    const camel: Obj = {};
    for (const [k, v] of Object.entries(ns)) camel[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
    return execute(camel as unknown as Args);
  });
}
