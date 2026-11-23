// library.ts - 라이브러리(.claude 구조 디렉토리) <-> 라이브 설정 토글 엔진. src/library.py 이식.
//
// 원리 (/plugin 과 동일한 소스<->설치상태 모델):
//   - 라이브러리 = 설치 가능한 항목의 소스(read-only 취급).
//   - 라이브 설정(~/.claude) = 설치 상태.
//   - scan 이 항목별 3상태를 판정: not_installed / installed(내용 동일) / modified(내용 다름).
//     상태 판정은 이름이 아니라 내용 해시 비교. 라이브러리가 업데이트되면 modified 가
//     "동기화 가능" 신호가 된다.
//
// 안전 규율 (config_edit 와 동일):
//   - install 덮어쓰기 전: cas 스냅샷 + .bak(파일) / .trash 이동(디렉토리)
//   - uninstall: 삭제 대신 .trash 이동(복구 가능)
//
// 라이브러리 등록은 store/config.json 의 "libraries": [...] 에 영속화.
import crypto from "node:crypto";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { type CliDoc, type CodeMap, JsonArgumentParser, compareCodePoints, emit, guard, pyStr } from "./cli_result.ts";
import {
  backup, load, opMcpAdd, opMcpRemove, out, releaseSpan, safeSettingsPath, saveAtomic, snapshotAfter, snapshotBefore, trash, withEditLock,
} from "./config_edit.ts";
import * as libStore from "./lib_store.ts";
import { type StoreConfig, LockTimeoutError, StoreNotInitialized, basename, dirname, norm, normcase, normpath, pjoin, pyEq, pyLoads } from "./lib_store.ts";
import * as marketplace from "./marketplace.ts";
import { desktopConfigPath, expanduser } from "./paths.ts";
import * as pluginState from "./plugin_state.ts";
import * as pluginUnits from "./plugin_units.ts";
import * as remoteFetch from "./remote_fetch.ts";

/** 부모 파서 옵션(Python 에서는 서브커맨드 앞). */
export interface LibOpts {
  /** 생략 시 lib_store.defaultStore(). */
  store?: string;
  /** 설치 대상 .claude 루트. 생략 시 ~/.claude. */
  target?: string;
  noSnapshot?: boolean;
  claudeJson?: string;
  desktopConfig?: string;
}

export type Category = "agents" | "skills" | "commands" | "rules" | "output-styles" | "workflows";

// 카테고리 -> [하위경로, 항목 종류, 파일 확장자]. dir 종류는 확장자를 쓰지 않는다.
// 표면이 늘면 여기 한 줄만 더한다. 설치/제거/sync/conflict/원장이 전부 이 표를 탄다.
const CATEGORIES: Record<Category, [string, "file" | "dir", string]> = {
  "agents": ["agents", "file", ".md"],
  "skills": ["skills", "dir", ""],   // <name>/ (SKILL.md 포함)
  "commands": ["commands", "file", ".md"],
  "rules": ["rules", "file", ".md"],
  "output-styles": ["output-styles", "file", ".md"],
  "workflows": ["workflows", "file", ".js"],
};
const CATEGORY_NAMES = Object.keys(CATEGORIES) as Category[];

// 라이브러리 바깥을 가리키는 상대참조 탐지 휴리스틱: CLAUDE_PROJECT_DIR 또는 형제 디렉토리
// (conventions/playbooks/rules/modes/analysis) 참조가 있으면 다른 환경에 설치 시 깨질 수 있어 배지로 표시.
const KIT_REF_RE = /CLAUDE_PROJECT_DIR|(?:conventions|playbooks|rules|modes|analysis)\//;
const KIT_REF_EXTS = [".md", ".js", ".ps1", ".sh", ".py"];

const CODES: CodeMap = [[StoreNotInitialized, "store_uninitialized"], [LockTimeoutError, "lock_timeout"]];

// 플러그인의 hooks.json·.mcp.json 은 settings·.claude.json 에 그대로 옮겨 쓰므로 1.0 을 1 로 바꾸지 않게 PyFloat 로 읽는다.
const PY_NUMBERS = { floats: true } as const;

const MAX_PATH_HINT = " The path most likely exceeds the Windows path length limit (MAX_PATH, about 260 characters). "
  + "Set CLAUDE_SNAPSHOT_STORE to a shorter path and try again.";

interface Args {
  store: string;
  target: string;
  noSnapshot: boolean;
  claudeJson: string;
  desktopConfig: string;
  [k: string]: any;
}

type Dict = Record<string, any>;
type LibRec = { lib: string; source: string; origin: string; map: Dict | null };

// ----- Python 호환 도우미 -----

function g(o: unknown, k: string): any {
  return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) ? (o as Dict)[k] : undefined;
}

/** dict.get(k, default): 키가 있으면 값이 None 이어도 그 값이다. */
function gd(o: unknown, k: string, d: unknown): any {
  return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) ? (o as Dict)[k] : d;
}

const truthy = marketplace.pyTruthy;
const or = (...vs: unknown[]): any => {
  for (const v of vs.slice(0, -1)) if (truthy(v)) return v;
  return vs[vs.length - 1];
};

function isOsError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string" && typeof (e as NodeJS.ErrnoException).errno === "number";
}

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

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Python 3.12 ntpath.isabs: 구분자로 시작하거나 둘째·셋째 글자가 ":\" 이면 절대경로다.
function isAbs(p: string): boolean {
  if (process.platform !== "win32") return p.startsWith("/");
  const s = p.slice(0, 3).replaceAll("/", "\\");
  return s.startsWith("\\") || s.slice(1, 3) === ":\\";
}

function cpLen(s: string): number {
  return Array.from(s).length;
}

function sortedStrings(xs: Iterable<string>): string[] {
  return [...xs].sort(compareCodePoints);
}

/** datetime.now().astimezone().isoformat(timespec="seconds"). */
function now(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

/**
 * os.walk(top, onerror=...) topdown. 호출부가 dirs 배열을 고치면 그만큼만 내려간다.
 * Python 판은 정션을 폴더로 보고 내려간다. Node 는 정션과 심볼릭 링크를 구분하지 못하므로 링크는 대상을
 * 따라가 폴더면 내려가고, 조상 폴더를 가리키는 링크(순환)는 실제 경로로 걸러 다시 들어가지 않는다.
 */
function* walk(top: string, strict: boolean, ancestors: Set<string> = new Set()): Generator<[string, string[], string[]]> {
  const key = pluginUnits.realKey(top);
  if (ancestors.has(key)) return;
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(top, { withFileTypes: true });
  } catch (e) {
    if (strict) throw e;
    return;
  }
  const dirs: string[] = [];
  const names: string[] = [];
  for (const e of ents) {
    let d = e.isDirectory();
    if (e.isSymbolicLink()) d = isDir(pjoin(top, e.name));
    (d ? dirs : names).push(e.name);
  }
  ancestors.add(key);
  try {
    yield [top, dirs, names];
    for (const d of dirs) yield* walk(pjoin(top, d), strict, ancestors);
  } finally {
    ancestors.delete(key);
  }
}

// ----- 해시와 항목 나열 -----

function hashFile(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/**
 * os.walk 인데 나열 실패를 삼키지 않는다. 기본 onerror=None 은 OSError 를 조용히 버리고
 * 빈 결과만 낸다. Windows MAX_PATH(약 260자) 초과 등으로 못 읽은 하위경로가 '항목 없음'
 * 으로 둔갑해 진짜 빈 디렉토리와 구분이 안 됐다. 여기서 다시 올려
 * 보내면 호출부(hashDir/hasKitRef 는 OSError 로, iterItems 는
 * cmdScan 의 카테고리별 try/catch 로)가 실패와 '진짜 없음'을 구분할 수 있다.
 */
function walkStrict(p: string) {
  return walk(p, true);
}

/** 디렉토리 해시 = 정렬된 (상대경로, 파일해시) 목록의 해시. 파일 추가/삭제/수정 모두 감지. */
function hashDir(p: string): string {
  const rows: string[] = [];
  const base = p.length;
  for (const [root, dirs, names] of walkStrict(p)) {
    const keep = dirs.filter((d) => !d.startsWith("."));
    dirs.splice(0, dirs.length, ...keep);
    for (const n of sortedStrings(names)) {
      const full = pjoin(root, n);
      const rel = relUnder(full, p, base).replaceAll("\\", "/");
      rows.push(`${rel}:${hashFile(full)}`);
    }
  }
  return crypto.createHash("sha256").update(Buffer.from(sortedStrings(rows).join("\n"), "utf-8")).digest("hex");
}

// walk 가 top 에 이름을 이어 붙여 만든 경로에서 top 아래 부분만 떼어 낸다(os.path.relpath 와 같은 값).
function relUnder(full: string, top: string, topLen = top.length): string {
  if (full === top) return ".";
  let rest = full.slice(topLen);
  while (rest.startsWith("\\") || rest.startsWith("/")) rest = rest.slice(1);
  return rest || ".";
}

/** 항목이 라이브러리 바깥의 형제 디렉토리를 참조하는지 휴리스틱 검사(이식성 배지용). */
function hasKitRef(p: string, kind: "file" | "dir"): boolean {
  let files: string[] = [];
  if (kind === "file") files = [p];
  else {
    for (const [root, dirs, names] of walkStrict(p)) {
      const keep = dirs.filter((d) => !d.startsWith("."));
      dirs.splice(0, dirs.length, ...keep);
      files.push(...names.filter((n) => KIT_REF_EXTS.some((x) => n.endsWith(x))).map((n) => pjoin(root, n)));
    }
  }
  for (const f of files.slice(0, 50)) {
    try {
      if (KIT_REF_RE.test(new TextDecoder("utf-8").decode(fs.readFileSync(f)))) return true;
    } catch (e) {
      if (!isOsError(e)) throw e;
    }
  }
  return false;
}

/** CLAUDE_CONFIG_LIBRARIES(os.pathsep 구분 복수 경로). env 지정분은 대시보드에서 제거 불가. */
function envLibs(): string[] {
  const sep = process.platform === "win32" ? ";" : ":";
  return (process.env.CLAUDE_CONFIG_LIBRARIES ?? "").split(sep).map((p) => marketplace.pyStrip(p)).filter((p) => p);
}

function originLocal(p: string): string {
  return "local:" + norm(p);
}

/**
 * 라이브러리 레코드 목록 = env + store(libraries/remotes/marketplaces).
 * 정규화 경로로 중복 제거(첫 표기 유지).
 * libraries 키 자체는 문자열 배열 그대로 둔다.
 */
function loadLibs(store: string): LibRec[] {
  const recs: LibRec[] = [];
  const seen = new Set<string>();
  const add = (p: unknown, source: string, origin: string, cmap: unknown = null) => {
    if (!truthy(p)) return;
    const k = norm(p as string);
    if (seen.has(k)) return;
    seen.add(k);
    recs.push({ lib: p as string, source, origin, map: (cmap ?? null) as Dict | null });
  };
  for (const p of envLibs()) add(p, "env", originLocal(p));
  const cfg = libStore.loadCfg(store);
  for (const p of gd(cfg, "libraries", []) as string[]) add(p, "registered", originLocal(p));
  for (const r of gd(cfg, "remotes", []) as Dict[]) add(g(r, "cache"), "remote", `remote:${pyStr(g(r, "id"))}`, g(r, "map"));
  for (const m of gd(cfg, "marketplaces", []) as Dict[]) {
    for (const pl of gd(m, "plugins", []) as Dict[]) {
      add(g(pl, "cache"), "market", `market:${pyStr(g(m, "id"))}/${pyStr(g(pl, "name"))}`, g(pl, "map"));
    }
  }
  return recs;
}

/** 라이브러리 경로를 store config.json 에 등록(멱등). 미초기화면 StoreNotInitialized 가 올라간다. */
async function registerLib(store: string, lib: string): Promise<boolean> {
  await libStore.withEditCfg(store, (cfg) => {
    if (!Object.prototype.hasOwnProperty.call(cfg, "libraries")) cfg.libraries = [];
    const libs = cfg.libraries as string[];
    if (libs.every((x) => norm(x) !== norm(lib))) libs.push(lib);
  });
  return true;
}

/** store config.json 의 libraries 에서 경로 제거(멱등). env 지정 경로는 여기서 못 지운다. */
async function unregisterLib(store: string, lib: string): Promise<boolean> {
  if ((gd(libStore.loadCfg(store), "libraries", []) as string[]).every((x) => norm(x) !== norm(lib))) return false;
  await libStore.withEditCfg(store, (cfg) => {
    cfg.libraries = (gd(cfg, "libraries", []) as string[]).filter((x) => norm(x) !== norm(lib));
  });
  return true;
}

/**
 * [leaf, full, kind, relpath] 산출.
 * cmap: 카테고리 -> lib 기준 상대경로(원격 레포가 Agents/Skills 처럼 대문자일 때).
 * 스킬 마커는 대소문자 무시. skill.md 를 쓴 레포가 대소문자 구분 FS 에서 누락되지 않게.
 * file 종류(agents/commands): base 직계 *.md.
 * dir 종류(skills): 가변 깊이 재귀. SKILL.md 를 가진 디렉토리를 스킬 leaf 로 간주.
 *   (그룹/서브그룹으로 감싸인 구조도 leaf 만 뽑음. leaf 내부 하위폴더로는 안 내려감.)
 * walkStrict 를 쓰므로 나열 도중 OSError 가 나면 그대로 던진다. 호출부(cmdScan)가 카테고리 단위로 잡는다.
 */
function* iterItems(lib: string, category: Category, cmap: Dict | null = null): Generator<[string, string, "file" | "dir", string]> {
  let [sub, kind, ext] = CATEGORIES[category];
  if (truthy(cmap) && truthy(g(cmap, category))) sub = g(cmap, category);
  const base = pjoin(lib, sub);
  if (!isDir(base)) return;
  if (kind === "file") {
    for (const name of sortedStrings(fs.readdirSync(base))) {
      if (name.startsWith(".")) continue;
      const full = pjoin(base, name);
      if (name.toLowerCase().endsWith(ext) && isFile(full)) {
        const stem = name.slice(0, name.length - ext.length);
        yield [stem, full, kind, stem];
      }
    }
    return;
  }
  for (const [root, dirs, names] of walkStrict(base)) {
    const keep = sortedStrings(dirs.filter((d) => !d.startsWith(".")));
    dirs.splice(0, dirs.length, ...keep);
    if (names.some((n) => marketplace.casefold(n) === "skill.md")) {
      const rel = relUnder(root, base).replaceAll("\\", "/");
      yield [basename(root), root, kind, rel];
      dirs.splice(0, dirs.length);   // leaf 확정. 스킬 내부는 하위 스킬이 아니므로 더 안 내려감
    }
  }
}

function targetPath(targetRoot: string, category: Category, name: string, kind: "file" | "dir"): string {
  const [sub, , ext] = CATEGORIES[category];
  return pjoin(targetRoot, sub, kind === "dir" ? name : `${name}${ext}`);
}

function status(libPath: string, tgt: string, kind: "file" | "dir"): string {
  if (!exists(tgt)) return "not_installed";
  let same: boolean;
  try {
    same = kind === "file" ? hashFile(libPath) === hashFile(tgt) : hashDir(libPath) === hashDir(tgt);
  } catch (e) {
    if (!isOsError(e)) throw e;
    return "modified";
  }
  return same ? "installed" : "modified";
}

/**
 * 레코드 해석: a.lib 지정 시 이미 알려진 레코드(env/registered/remote/market)와
 * norm() 매칭을 시도해, 있으면 그 레코드(정확한 source/origin/map)를 그대로 쓴다.
 * 없으면(=새 로컬 경로) local: 레코드를 합성한다. registerNew(scan 전용)면
 * 합성 전에 store 에도 등록한다. a.lib 미지정이면 전체 레코드 목록.
 *
 * 무조건 local: 로 재합성하면(구버전 버그) UI 가 remote 캐시 경로를 --lib 로 보내면서
 * --origin 도 같이 보내는 설치 조합에서 origin 필터가 항상 빈 결과가 되어
 * 원격 레포 설치가 전부 실패한다. 또 이미 remotes[] 에 있는 캐시 경로를 매번 재등록하면
 * libraries[] 에도 중복으로 들어가 같은 캐시가 source="registered"/"remote" 두 줄로 쪼개진다.
 */
async function recsFor(a: Args, registerNew = false): Promise<LibRec[]> {
  const all = loadLibs(a.store);
  if (!truthy(a.lib)) return all;
  const hit = all.find((r) => norm(r.lib) === norm(a.lib));
  if (hit) return [hit];
  if (registerNew) await registerLib(a.store, a.lib);   // StoreNotInitialized 는 호출부로 전파
  return [{ lib: a.lib, source: "registered", origin: originLocal(a.lib), map: null }];
}

/**
 * 4상태 판정. [status, owner_origin].
 * 원장에 없는 타깃은 기존 해시 비교로 흘린다. 기능 도입 전 설치분과
 * 대시보드 밖에서 생긴 항목이 오늘과 완전히 동일하게 동작해야 하므로.
 */
function statusEx(cfg: StoreConfig, targetRoot: string, category: Category, leaf: string, src: string, tgt: string, kind: "file" | "dir", origin: string): [string, unknown] {
  if (!exists(tgt)) return ["not_installed", null];
  const rec = libStore.ledgerGet(cfg, targetRoot, category, leaf);
  if (!truthy(rec)) return [status(src, tgt, kind), null];
  const owner = g(rec, "origin") ?? null;
  if (truthy(owner) && owner !== origin) return ["conflict", owner];
  return [status(src, tgt, kind), owner];
}

/**
 * hooks/mcp 보유·설치 플래그. 라이브러리 루트 행과 하위 유닛 행이 같은 규칙을 쓴다.
 *
 * hooks/mcp 설치 버튼이 이 플래그에 매달린다(UI 는 scan 행을 쓰므로 여기 없으면 버튼이 안 뜬다).
 * 설치 여부는 원장(타깃 기준)에서 읽는다. 원장 키는 플러그인 이름이라 서로 다른
 * 마켓의 동명 플러그인이 한 칸을 공유한다. origin 이 일치할 때만 "설치됨"으로 본다
 * (남의 설치를 내 행의 배지로 표시하고 제거 버튼까지 띄우는 오작동 방지).
 */
function unitFlags(cfg: StoreConfig, target: string, root: string, origin: string): Dict {
  const uname = unitName(origin);
  const hrec = or(libStore.ledgerGet(cfg, target, "hooks", uname), {});
  const mrec = or(libStore.ledgerGet(cfg, target, "mcp", uname), {});
  const hOwn = g(hrec, "origin") === origin;
  const mOwn = g(mrec, "origin") === origin;
  return {
    has_hooks: exists(pjoin(root, pluginUnits.HOOKS_REL)),
    has_mcp: pluginUnits.hasMcp(root),   // .mcp.json + plugin.json 인라인 둘 다
    hooks_installed: hOwn,
    mcp_installed: mOwn,
    hooks_events: hOwn ? gd(hrec, "events", []) : [],
    mcp_servers: mOwn ? gd(mrec, "servers", []) : [],
  };
}

/** 라이브러리 하위 도구 디렉토리 행. origin 은 local:<그 경로> 라 hooks/mcp-install 이 그대로 치환 루트로 쓴다. */
function unitRows(cfg: StoreConfig, target: string, lib: string): Dict[] {
  return pluginUnits.findUnits(lib).map((root) => {
    const origin = originLocal(root);
    return { lib: root, name: basename(root), origin, ...unitFlags(cfg, target, root, origin) };
  });
}

/** origin -> 표시용 메타(고정 sha / fetched_at / url). staleness 배지의 근거. */
function sourceMeta(cfg: StoreConfig): Map<string, Dict> {
  const m = new Map<string, Dict>();
  for (const r of gd(cfg, "remotes", []) as Dict[]) {
    m.set(`remote:${pyStr(g(r, "id"))}`, { sha: g(r, "sha") ?? null, fetched_at: g(r, "fetched_at") ?? null, url: g(r, "url") ?? null });
  }
  for (const mk of gd(cfg, "marketplaces", []) as Dict[]) {
    for (const pl of gd(mk, "plugins", []) as Dict[]) {
      m.set(`market:${pyStr(g(mk, "id"))}/${pyStr(g(pl, "name"))}`, { sha: g(pl, "sha") ?? null, fetched_at: g(pl, "fetched_at") ?? null, url: g(mk, "url") ?? null });
    }
  }
  return m;
}

async function runScan(a: Args): Promise<never> {
  let recs: LibRec[];
  try {
    recs = await recsFor(a, true);
  } catch (e) {
    if (e instanceof StoreNotInitialized) emit(false, "store_uninitialized", e.message, { libraries: [] });
    throw e;
  }
  if (!recs.length) {
    // 미설정은 오류가 아니라 정상 상태(라이브러리 기능 미사용). 빈 결과로 응답.
    emit(true, "ok", "No libraries registered", { target: a.target, libraries: [] });
  }
  const cfg = libStore.loadCfg(a.store);
  const meta = sourceMeta(cfg);
  const result: Dict[] = [];
  for (const rec of recs) {
    const { lib, source, origin, map: cmap } = rec;
    const row: Dict = { lib, source, origin, marketplace: isMarketplace(lib), ...unitFlags(cfg, a.target, lib, origin), ...(meta.get(origin) ?? {}) };
    if (!isDir(lib)) {
      result.push({ ...row, error: "Path not found", categories: {}, units: [] });
      continue;
    }
    row.units = unitRows(cfg, a.target, lib);
    const cats: Dict = {};
    const enumErrors: string[] = [];
    for (const category of CATEGORY_NAMES) {
      let items: Dict[] = [];
      try {
        for (const [leaf, full, kind, rel] of iterItems(lib, category, cmap)) {
          // 설치는 leaf 이름으로 평탄화(그룹 접두 제거) -> ~/.claude/<sub>/<leaf>
          const tgt = targetPath(a.target, category, leaf, kind);
          const [st, owner] = statusEx(cfg, a.target, category, leaf, full, tgt, kind, origin);
          const group = dirname(rel).replaceAll("\\", "/");   // "" = 그룹 없음(평면)
          items.push({
            name: leaf,
            group,          // 표시용(가변 깊이 트리): "2-stack/java-spring" 등
            relpath: rel,   // 설치 지정용(소스 상대경로, leaf 와 다를 수 있음)
            status: st,
            owner,          // conflict 일 때 현재 소유자 origin
            origin,
            kit_ref: hasKitRef(full, kind),
            lib_path: full,
            target: tgt,
          });
        }
      } catch (e) {
        if (!isOsError(e)) throw e;
        // 나열이 도중에 죽었다(예: 깊은 하위경로가 Windows MAX_PATH 를 넘음).
        // 이 카테고리만 비우고 계속하되(한 라이브러리의 사고가 scan 전체를 막지 않음),
        // row 에 error 를 남겨 "진짜 항목 0개"와 구분되게 한다.
        enumErrors.push(`${category}: ${e.message}`);
        items = [];
      }
      cats[category] = items;
    }
    const rowOut: Dict = { ...row, categories: cats };
    if (enumErrors.length) rowOut.error = "Could not list some items - " +enumErrors.join("; ");
    result.push(rowOut);
  }
  emit(true, "ok", `Libraries: ${result.length}`, { target: a.target, libraries: result });
}

/**
 * 등록 해제. --lib(로컬 경로) 또는 --origin(remote:/market:[/<plugin>]).
 * 캐시 삭제는 원장이 그 캐시를 참조하지 않을 때만 한다. hooks/MCP 가 걸려 있으면 거부한다.
 *
 * market:<id>/<plugin> 은 그 플러그인 하나만 뺀다. Library 칸의 플러그인 칩 ✕ 가 이 형태의
 * origin 을 그대로 보내므로, 예전처럼 market:<id> 로 뭉뚱그려 mid 만 뽑으면 플러그인 하나를
 * 지우려다 마켓 등록 전체(레포 + 다른 모든 플러그인)를 날려버린다.
 */
async function runUnregister(a: Args): Promise<never> {
  if (truthy(a.origin)) {
    const origin: string = a.origin;
    const heldMsg = (n: number) => `Cannot unregister: installed items still reference this cache (${n})`;

    if (origin.startsWith("remote:")) {
      const rid = origin.slice("remote:".length);
      let caches: string[] = [];
      await libStore.withEditCfg(a.store, (cfg) => {
        const arr = gd(cfg, "remotes", []) as Dict[];
        const hit = arr.find((x) => g(x, "id") === rid);
        if (!hit) emit(true, "noop", "Already absent (no-op)", { removed: false });
        caches = truthy(g(hit, "cache")) ? [hit.cache] : [];
        const held = caches.flatMap((c) => libStore.ledgerRefsRoot(cfg, c));
        if (held.length) emit(false, "held", heldMsg(held.length), { target: origin, held_by: held.map((h) => h.key) });
        arr.splice(arr.indexOf(hit!), 1);
      });
      for (const c of caches) rmtreeForce(c);
      emit(true, "ok", `Unregistered: ${origin}`, { removed: true });
    }

    if (origin.startsWith("market:")) {
      const [mid, pname] = partition(origin.slice("market:".length));
      let phit: Dict | undefined;
      await libStore.withEditCfg(a.store, (cfg) => {
        const mks = gd(cfg, "marketplaces", []) as Dict[];
        const mhit = mks.find((x) => g(x, "id") === mid);
        if (!mhit) emit(true, "noop", "Already absent (no-op)", { removed: false });
        if (pname) {
          // 플러그인 단위: 그 플러그인만 빼고 마켓 등록·매니페스트 캐시·다른 플러그인은 안 건드린다.
          const pl = gd(mhit, "plugins", []) as Dict[];
          phit = pl.find((p) => g(p, "name") === pname);
          if (!phit) emit(true, "noop", "Already absent (no-op)", { removed: false });
          const pcache = g(phit, "cache");
          // 가드는 이 플러그인의 캐시만 본다. 다른 플러그인이나 마켓 루트를 붙잡은 원장
          // 항목이 이 해제를 막으면 안 된다(ledgerRefsRoot 는 containment 라 pcache 를
          // 넘기면 pcache 의 하위만 잡고 마켓 루트 같은 조상은 절대 안 잡는다).
          const held = truthy(pcache) ? libStore.ledgerRefsRoot(cfg, pcache) : [];
          if (held.length) emit(false, "held", heldMsg(held.length), { target: origin, held_by: held.map((h) => h.key) });
          pl.splice(pl.indexOf(phit!), 1);
        } else {
          // 마켓 단위(플러그인 세그먼트 없음): 레포 + 모든 플러그인이 한 덩이라 전부 지운다.
          const caches = [g(mhit, "cache"), ...(gd(mhit, "plugins", []) as Dict[]).map((p) => g(p, "cache"))].filter((c) => truthy(c));
          const held = caches.flatMap((c) => libStore.ledgerRefsRoot(cfg, c));
          if (held.length) emit(false, "held", heldMsg(held.length), { target: origin, held_by: held.map((h) => h.key) });
          mks.splice(mks.indexOf(mhit!), 1);
        }
      });

      if (pname) {
        // 번들(str-path)은 마켓 레포 워킹트리를 공유한다. 손으로 지우면 매니페스트나
        // 다른 플러그인까지 같이 날아간다. 등록만 빼고 디스크는 건드리지 않는다.
        // 외부는 plugins/<name>/ 전체가 이 플러그인 전용이라 통째로 지운다.
        if (g(phit, "kind") !== "str-path") {
          const [, , pluginsDir] = marketPaths(a.store, mid);
          rmtreeForce(pjoin(pluginsDir, pname));
        }
        emit(true, "ok", `Unregistered: ${origin}`, { removed: true });
      }
      // market 은 repo + plugins 가 <store>/lib-cache/markets/<id>/ 아래 한 덩이라 그 루트를 지운다.
      rmtreeForce(libCache(a.store, "markets", mid));
      emit(true, "ok", `Unregistered: ${origin}`, { removed: true });
    }

    emit(false, "invalid_arg", `Invalid origin format: ${origin}`, { target: origin });
  }

  if (!truthy(a.lib)) emit(false, "invalid_arg", "A library path to remove (--lib) or --origin is required", { target: "--lib" });
  if (envLibs().some((e) => norm(a.lib) === norm(e))) {
    emit(false, "refused", "A path set by the CLAUDE_CONFIG_LIBRARIES environment variable cannot be removed", { target: a.lib });
  }
  let removed: boolean;
  try {
    removed = await unregisterLib(a.store, a.lib);
  } catch (e) {
    if (!(e instanceof StoreNotInitialized)) throw e;
    removed = false;
  }
  emit(true, removed ? "ok" : "noop", removed ? "Library path removed" : "Already absent (no-op)", { removed });
}

/** str.partition("/") 의 [앞, 뒤]. */
function partition(s: string): [string, string] {
  const i = s.indexOf("/");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

/**
 * [src, kind, target, origin] 해석. a.path = 카테고리 루트 기준 상대경로(가변 깊이 허용).
 * 타깃은 leaf 이름으로 평탄화.
 * 경로 주입 차단: 각 세그먼트는 순수 파일명이어야 함. 빈/./.. 금지, 콜론 금지
 * (드라이브상대 'C:foo' 는 isabs=False 로 새어들어 경로 결합이 lib 밖으로 튐 + NTFS ADS 'a:b'),
 * 그리고 basename 과 동일(구분자·드라이브 접두 제거되면 다름).
 */
async function resolveItem(a: Args): Promise<[string, "file" | "dir", string, string]> {
  const rel = ((a.path || "") as string).replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const parts = rel ? rel.split("/") : [];
  const segBad = parts.some((p) => p === "" || p === "." || p === ".." || p.includes(":") || p !== basename(p));
  if (!parts.length || isAbs(a.path) || segBad) out(false, `Invalid path: '${a.path}'`, "invalid_arg", { target: a.path });
  const category = a.category as Category;
  const [sub, kind, ext] = CATEGORIES[category];
  if (kind === "file" && parts.length !== 1) out(false, `Path must be a single name: '${a.path}'`, "invalid_arg", { target: a.path });
  const leaf = parts[parts.length - 1];
  let recs = await recsFor(a);
  if (truthy(a.origin)) {
    recs = recs.filter((r) => r.origin === a.origin);
    if (!recs.length) out(false, `Origin not found: ${a.origin}`, "not_found", { target: a.origin });
  }
  const hits: [string, "file" | "dir", string, string][] = [];
  for (const r of recs) {
    const cmap = or(r.map, {});
    let src = pjoin(r.lib, or(g(cmap, category), sub), ...parts);
    if (kind === "file") src += ext;
    if (exists(src)) hits.push([src, kind, targetPath(a.target, category, leaf, kind), r.origin]);
  }
  if (!hits.length) out(false, `Not in any library: ${category}/${rel}`, "not_found", { target: `${category}/${rel}` });
  if (hits.length > 1) {
    // 캐시가 여러 개면 첫 매치를 조용히 고르는 건 conflict 판정을 우회한다.
    out(false, `Ambiguous origin (${hits.length} matches) - specify one with --origin`, "ambiguous", { target: a.path, candidates: hits.map((h) => h[3]) });
  }
  return hits[0];
}

/** shutil.copy2 / copytree(symlinks=False): 내용과 시각을 옮기고 링크는 따라가 복사한다. */
function copyItem(src: string, dst: string, kind: "file" | "dir"): void {
  fs.cpSync(src, dst, { recursive: kind === "dir", preserveTimestamps: true, dereference: true, errorOnExist: true, force: false });
}

async function runInstall(a: Args): Promise<never> {
  // phantom 방지: target(.claude 루트)의 부모(프로젝트 폴더 또는 HOME)가 실제로 존재해야 설치.
  // 전역 ~/.claude 는 부모 ~ 가 항상 존재하므로 통과. 없는 프로젝트 경로에 .claude 를 만들지 않는다.
  const parent = dirname(normpath(a.target));
  if (parent && !isDir(parent)) out(false, `Parent directory of the install target does not exist (refusing to create a phantom): ${parent}`, "refused", { target: parent });
  const [src, kind, tgt, origin] = await resolveItem(a);
  const existed = exists(tgt);
  if (!a.noSnapshot) await snapshotBefore(a.store);
  let bak: string | null = null;
  if (existed) {
    // 이미 설치된 항목은 오류 대신 동기화: 라이브러리 버전으로 덮어쓰기 전 백업(파일 .bak / 디렉토리 .trash)
    bak = kind === "file" ? backup(tgt) : trash(tgt);
  }
  fs.mkdirSync(dirname(tgt), { recursive: true });
  if (kind === "file") fs.cpSync(src, tgt, { preserveTimestamps: true, dereference: true });
  else copyItem(src, tgt, kind);
  const leaf = basename((a.path as string).replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""));
  let warn: string | null = null;
  const srcHash = kind === "file" ? hashFile(src) : hashDir(src);
  try {
    await libStore.withEditCfg(a.store, (cfg) => {
      libStore.ledgerPut(cfg, a.target, a.category, leaf, { origin, relpath: a.path, src_hash: srcHash, at: now() });
    });
  } catch (e) {
    if (!(e instanceof StoreNotInitialized)) throw e;
    // 파일은 이미 설치됐다. 원장만 못 남긴 상태를 숨기지 않는다.
    // 이 항목은 다음 scan 에서 하위호환(해시 비교) 경로로 흐른다.
    warn = "Store is not initialized, so the origin was not recorded (the install itself completed)";
  }
  const msg = `${existed ? "Synced" : "Installed"}: ${a.category}/${a.path}`;
  if (!a.noSnapshot) await snapshotAfter(a.store, msg);
  out(true, msg, "ok", { target: tgt, backup: bak, synced: existed, origin, warning: warn });
}

async function runUninstall(a: Args): Promise<never> {
  const name: string = a.name;
  if (name !== basename(name) || name === "." || name === ".." || name.includes(":") || name.includes("\\") || name.includes("/")) {
    out(false, `Invalid name: '${name}'`, "invalid_arg", { target: name });
  }
  const category = a.category as Category;
  const [, kind] = CATEGORIES[category];
  const tgt = targetPath(a.target, category, name, kind);
  if (!exists(tgt)) out(true, `Already absent: ${category}/${name} (no-op)`, "noop", { changed: false });
  const cfg = libStore.loadCfg(a.store);
  const rec = libStore.ledgerGet(cfg, a.target, category, name);
  const owner = g(or(rec, {}), "origin") ?? null;
  if (truthy(a.origin) && truthy(owner) && owner !== a.origin) {
    // 요청한 출처가 소유자가 아니다. 남의 설치를 지우지 않는다.
    out(false, `Origin mismatch - this item is owned by '${owner}'`, "owner_mismatch", { target: owner, owner });
  }
  if (!a.noSnapshot) await snapshotBefore(a.store);
  const dst = trash(tgt);
  try {
    await libStore.withEditCfg(a.store, (c) => libStore.ledgerDel(c, a.target, category, name));
  } catch (e) {
    if (!(e instanceof StoreNotInitialized)) throw e;   // 원장이 애초에 없었다는 뜻. 지울 것도 없다
  }
  const msg = `Removed (moved to .trash): ${category}/${name}`;
  if (!a.noSnapshot) await snapshotAfter(a.store, msg);
  out(true, msg, "ok", { trashed: dst, owner });
}

function libCache(store: string, ...parts: string[]): string {
  return pjoin(store, "lib-cache", ...parts);
}

/**
 * git 캐시(.git/objects 의 pack/idx 는 읽기전용) 도 지우는 rmtree.
 * 오류를 무시하기만 하면 읽기전용 파일에서 조용히 절반만 지워진 캐시가 남는다.
 * unregister/plugin-fetch 정리가 실제로 끝났다고 오인하게 만든다.
 */
function rmtreeForce(p: string): void {
  if (!exists(p)) return;
  try {
    // node 의 rm 은 Windows 의 EPERM(읽기전용)에서 쓰기 권한을 주고 다시 지운다.
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Python onerror 도 남은 오류를 삼킨다 */
  }
}

/**
 * 비교 전용 URL 정규화. 후행 슬래시/.git 접미/대소문자만 흡수한다.
 * 같은 레포를 가리키는 표기 차이(github.com/a/b vs github.com/a/b.git)를 중복으로 잡기 위한 것이지
 * URL 을 정규화해 저장하려는 게 아니다(저장은 사용자가 준 표기 그대로).
 */
export function normUrl(u: unknown): string {
  let s = marketplace.pyStrip((truthy(u) ? u : "") as string).replace(/\/+$/, "");
  if (s.toLowerCase().endsWith(".git")) s = s.slice(0, -4);
  return marketplace.casefold(s);
}

/**
 * [거부 사유, 같은 id 의 기존 레코드]. 사유가 있으면 호출부가 ok:false 로 끝낸다.
 *
 * id 는 URL 의 레포명에서 파생되므로 서로 다른 두 URL 이 같은 id 를 만들 수 있다
 * (.../a/plugins.git 과 .../b/plugins.git). 그대로 두면 뒤에 등록한 쪽이 앞 레코드를
 * 조용히 덮어쓰는데, 이미 fetch 한 플러그인 목록까지 물려받아 다른 레포의 캐시를
 * 가리키는 레코드가 된다. 등록이 아니라 손상이다.
 */
function dupChecks(entries: Dict[], eid: string, url: string): [string | null, Dict | null] {
  const sameId = entries.find((e) => g(e, "id") === eid) ?? null;
  const sameUrl = entries.find((e) => g(e, "id") !== eid && normUrl(g(e, "url")) === normUrl(url)) ?? null;
  if (sameUrl) return [`This URL is already registered as '${pyStr(g(sameUrl, "id"))}'`, null];
  if (sameId && normUrl(g(sameId, "url")) !== normUrl(url)) {
    return [`id '${eid}' is already registered with a different URL (${pyStr(g(sameId, "url"))}) - choose another name with --id`, null];
  }
  return [null, sameId];
}

/** URL 에서 레포명을 파생. 신뢰할 수 없는 입력이므로 세그먼트 검증을 통과해야 한다. */
function idFromUrl(url: string): string {
  const segs = url.replace(/\/+$/, "").split("/");
  let base = segs[segs.length - 1];
  if (base.endsWith(".git")) base = base.slice(0, -4);
  if (!base || base !== basename(base) || base === "." || base === ".." || base.includes(":") || base.includes("\\") || base.includes("/")) {
    out(false, `Cannot derive a valid id from the URL: '${url}' - specify one with --id`, "invalid_arg", { target: url });
  }
  return base;
}

function badId(id: string): boolean {
  return id !== basename(id) || id.includes(":") || id.includes("\\") || id.includes("/");
}

/** 임의 git 레포를 라이브러리로 등록. 네트워크를 타는 명시 호출 도구다(scan 아님). */
async function runRemoteAdd(a: Args): Promise<never> {
  if (!remoteFetch.gitAvailable()) emit(false, "tool_missing", "git was not found on PATH");
  const rid: string = truthy(a.id) ? a.id : idFromUrl(a.url);
  if (badId(rid)) out(false, `Invalid id: '${rid}'`, "invalid_arg", { target: rid });
  const [reason, prev] = dupChecks(gd(libStore.loadCfg(a.store), "remotes", []), rid, a.url);
  if (reason) emit(false, "exists", reason, { target: rid });
  const cache = libCache(a.store, "remotes", rid);
  let cmap: unknown = null;
  if (truthy(a.map)) {
    try {
      cmap = pyLoads(a.map);
    } catch (e) {
      out(false, `--map is not valid JSON: ${(e as Error).message}`, "invalid_arg", { target: "--map" });
    }
    if (cmap === null || typeof cmap !== "object" || Array.isArray(cmap) || Object.keys(cmap).some((k) => !(CATEGORY_NAMES as string[]).includes(k))) {
      out(false, `--map keys must be one of ${marketplace.pyRepr(CATEGORY_NAMES)}`, "invalid_arg", { target: "--map" });
    }
  }
  let sha = "";
  try {
    sha = await remoteFetch.materialize(cache, a.url, truthy(a.ref) ? a.ref : null);
  } catch (e) {
    if (e instanceof remoteFetch.GitError) emit(false, "external_failed", e.message, { target: a.url, detail: e.message });
    throw e;
  }
  const layout = remoteFetch.detectLayout(cache);
  if (truthy(cmap)) layout.map = { ...layout.map, ...(cmap as Dict) };
  try {
    await libStore.withEditCfg(a.store, (cfg) => {
      if (!Object.prototype.hasOwnProperty.call(cfg, "remotes")) cfg.remotes = [];
      const remotes = cfg.remotes as Dict[];
      const rec = { id: rid, url: a.url, ref: truthy(a.ref) ? a.ref : null, sha, fetched_at: now(), cache, map: or(layout.map, null) };
      const i = remotes.findIndex((r) => g(r, "id") === rid);
      if (i >= 0) remotes[i] = rec;
      else remotes.push(rec);
    });
  } catch (e) {
    if (e instanceof StoreNotInitialized) emit(false, "store_uninitialized", e.message, { cache });
    throw e;
  }
  // clone 이 끝난 뒤에야 매니페스트 유무를 알 수 있다(사전 판별하려면 받아보는 수밖에 없다).
  // 그래서 거절이 아니라 사후 통지다. .claude 레이아웃이 있으면 원격 등록 자체는 유효하고,
  // 마켓플레이스이기도 하다는 사실만 UI 가 이어서 안내한다.
  emit(true, "ok", prev ? `Remote already registered - updated: ${rid}` : `Remote library registered: ${rid}`, {
    id: rid, origin: `remote:${rid}`, cache, sha, layout, already: !!prev, marketplace: isMarketplace(cache),
  });
}

function marketPaths(store: string, mid: string): [string, string, string] {
  const base = libCache(store, "markets", mid);
  return [base, pjoin(base, "repo"), pjoin(base, "plugins")];
}

/**
 * root 가 마켓플레이스 매니페스트를 품고 있는가. 파일 존재 확인 한 번이고 네트워크를
 * 타지 않는다. 이미 디스크에 있는 것(로컬 경로 / clone 끝난 캐시)에만 묻는다.
 *
 * Library 와 Marketplace 를 가르는 실제 축은 전송 방식(로컬/원격)이 아니라 이 매니페스트의
 * 유무다. UI 가 잘못 넣은 소스를 반대편으로 안내하려면 그 사실을 응답에 실어야 한다.
 */
function isMarketplace(root: unknown): boolean {
  return isFile(pjoin((truthy(root) ? root : "") as string, marketplace.MANIFEST_REL));
}

/**
 * 로컬 마켓은 리비전이 없다. 매니페스트 내용 해시를 sha 자리에 넣는다.
 * None 을 넣으면 '갱신했는데 아무 변화가 없다'로 보이지만, 내용 해시면 사용자가 파일을
 * 고친 순간 값이 달라져 다시 읽었다는 사실이 눈에 보인다.
 */
function localManifestSha(p: string): string | null {
  try {
    return hashFile(p).slice(0, 12);
  } catch (e) {
    if (!isOsError(e)) throw e;
    return null;
  }
}

/**
 * 마켓 소스 4형식(owner/repo · git URL · marketplace.json URL · 로컬 경로)을 등록.
 *
 * git 이면 .claude-plugin/ 만 sparse checkout 한다(실측: 401K vs 전체 9.7M, 24배).
 * json 이면 매니페스트 파일 하나만 받고, local 이면 복사하지 않고 그 경로를 그대로
 * 캐시로 삼는다. 사용자가 이미 디스크에 들고 있는 걸 스토어에 두 벌로 만들면 어느 쪽이
 * 진짜인지 모르게 되고, 원본을 고쳐도 반영되지 않는다.
 * 어느 형식이든 플러그인은 선택 시점에 받는다.
 */
async function runMarketAdd(a: Args): Promise<never> {
  let cs: marketplace.SourceClass;
  try {
    cs = marketplace.classifySource(a.url);
  } catch (e) {
    if (e instanceof marketplace.ManifestError) emit(false, "invalid_arg", e.message, { target: a.url });
    throw e;
  }
  const kind = cs.kind;
  // 저장하는 값은 항상 정규화된 표기다(축약 -> 전체 URL, 로컬 -> realpath). fetch 가
  // 이 값을 다시 classifySource 에 넣으므로, 같은 kind 로 되돌아오지 않으면 갱신이 깨진다.
  const url = (kind === "local" ? cs.path : cs.url) as string;
  if (kind === "git" && !remoteFetch.gitAvailable()) emit(false, "tool_missing", "git was not found on PATH");
  const mid: string = truthy(a.id) ? a.id : kind === "git" ? idFromUrl(url) : cs.id;
  if (!mid) emit(false, "invalid_arg", `Cannot derive a valid id from the source: '${a.url}' - specify one with --id`, { target: a.url });
  if (badId(mid)) out(false, `Invalid id: '${mid}'`, "invalid_arg", { target: mid });
  const [reason, prev0] = dupChecks(gd(libStore.loadCfg(a.store), "marketplaces", []), mid, url);
  if (reason) emit(false, "exists", reason, { target: mid });
  const [, repo] = marketPaths(a.store, mid);
  let cache = repo;
  let sha: string | null = null;
  try {
    if (kind === "git") {
      // 축약에 붙여 온 ref(owner/repo#branch)를 명시적 --ref 보다 우선한다. 사용자가
      // 소스 문자열에 함께 적은 쪽이 더 구체적인 의사표시다.
      sha = await remoteFetch.materialize(repo, url, or(cs.ref, a.ref, null), null, [".claude-plugin"]);
    } else if (kind === "json") {
      sha = await remoteFetch.fetchManifestJson(repo, url);
    } else {
      cache = url;   // 로컬은 fetch 없이 경로 검증만 한다
      sha = null;    // 매니페스트를 읽은 뒤 내용 해시로 채운다
    }
  } catch (e) {
    if (e instanceof remoteFetch.FetchError) emit(false, "external_failed", e.message, { target: a.url, detail: e.message });
    throw e;
  }
  const manifestPath = pjoin(cache, marketplace.MANIFEST_REL);
  let mf: marketplace.Manifest;
  try {
    mf = marketplace.parseManifest(manifestPath);
  } catch (e) {
    if (e instanceof marketplace.ManifestError) {
      const hint = kind === "local" ? "not a marketplace (.claude-plugin/marketplace.json is missing)" : "this does not look like a marketplace (use remote-add)";
      // code 를 함께 준다: message 는 한국어 문장이라 UI 가 문자열 매칭으로 분기할 수 없다
      // (영어 UI 에서 깨지고, 문구를 고치는 순간 조용히 죽는다). 분기는 code 로만 한다.
      emit(false, "not_a_marketplace", `${e.message} - ${hint}`, { target: a.url });
    }
    throw e;
  }
  if (kind === "local") sha = localManifestSha(manifestPath);
  try {
    await libStore.withEditCfg(a.store, (cfg) => {
      if (!Object.prototype.hasOwnProperty.call(cfg, "marketplaces")) cfg.marketplaces = [];
      const mks = cfg.marketplaces as Dict[];
      const prev = mks.find((m) => g(m, "id") === mid);
      // kind 를 남긴다. 없는(구버전) 레코드는 읽는 쪽에서 git 으로 간주한다. 그때는 git 만 있었다.
      // ref 는 git 에서만 의미가 있다(json/local 에는 브랜치라는 게 없다).
      const rec = {
        id: mid, url, ref: kind === "git" ? (truthy(a.ref) ? a.ref : null) : null,
        kind, sha, fetched_at: now(), cache, name: mf.name,
        plugins: gd(or(prev, {}), "plugins", []),   // 이미 fetch 한 플러그인은 보존
      };
      if (prev) mks[mks.indexOf(prev)] = rec;
      else mks.push(rec);
    });
  } catch (e) {
    if (e instanceof StoreNotInitialized) emit(false, "store_uninitialized", e.message, { cache });
    throw e;
  }
  const cat = marketplace.catalog(mf, {}, null, null, 0);
  // 같은 URL 을 다시 등록한 경우는 거부하지 않는다(매니페스트 갱신이 정당한 동작이다).
  // 대신 새로 등록한 것처럼 말하지 않는다. 이미 fetch 한 플러그인은 그대로 보존된다.
  const again = kind === "local" ? "Marketplace already registered - reread from disk" : "Marketplace already registered - manifest updated";
  emit(true, "ok", prev0 ? `${again}: ${mid} (plugins: ${cat.total})` : `Marketplace registered: ${mid} (plugins: ${cat.total})`, {
    id: mid, name: mf.name, cache, sha, kind, url, plugins: cat.total, categories: cat.categories, already: !!prev0,
  });
}

/**
 * Claude Code(`/plugins`)에 등록된 마켓을 읽어 이 스토어와 대조한다.
 *
 * 네트워크를 타지 않는다. 읽는 파일은 known_marketplaces.json 하나뿐이고, 실제 등록은
 * 사용자가 후보를 골라 market-add 를 눌렀을 때만 일어난다. Claude Code 의 플러그인 캐시는
 * 건드리지 않는다. .in_use / GC 가 딸린 비공개 수명주기다.
 *
 * 양쪽에 다 등록된 마켓은 숨기지 않고 both 로 돌려준다. 두 도구가 같은 레포를 각자의
 * 캐시에 서로 다른 시점으로 들고 있기 때문에, 그 어긋남은 감추는 것보다 보이는 게 낫다.
 * Claude Code 쪽은 sha 를 기록하지 않으므로(lastUpdated 만 있다) 시각끼리 비교한다.
 */
async function runMarketDiscover(a: Args): Promise<never> {
  const pdir: string = truthy(a.pluginsDir) ? a.pluginsDir : pluginState.defaultPluginsDir();
  const mks = or(gd(libStore.loadCfg(a.store), "marketplaces", []), []) as Dict[];
  const mine = new Map<string, Dict>();
  for (const m of mks) if (truthy(g(m, "url"))) mine.set(pluginState.normUrl(m.url), m);
  const neu: Dict[] = [], both: Dict[] = [], unusable: Dict[] = [];
  const markets = pluginState.readMarkets(pdir);
  for (const name of sortedStrings(Object.keys(markets))) {
    const m = markets[name];
    const row = { name, kind: m.kind, repo: m.repo, url: m.url, path: m.path, claude_updated: m.updated };
    if (!truthy(m.url)) {
      // 조용히 빼면 "왜 N개가 아니지"가 되므로 이유와 함께 돌려준다. 사유를 한 종류로
      // 못박지 않는다. URL 이 없는 종류는 file/directory(로컬 경로) 말고도 npm ·
      // settings · seeded 가 있어서, 하나로 적으면 나머지에 거짓말이 된다.
      unusable.push({ ...row, reason: `Source has no URL to fetch from: ${pyStr(or(m.kind, "unknown"))}` + (truthy(m.path) ? ` (${pyStr(m.path)})` : "") });
      continue;
    }
    const got = mine.get(pluginState.normUrl(m.url as string));
    if (got) both.push({ ...row, id: g(got, "id") ?? null, sha: g(got, "sha") ?? null, fetched_at: g(got, "fetched_at") ?? null });
    else neu.push(row);
  }
  emit(true, "ok", `Markets to import: ${neu.length} · registered in both: ${both.length}` + (unusable.length ? ` · cannot be imported: ${unusable.length}` : ""), {
    plugins_dir: pdir, new: neu, both, unusable,
  });
}

/**
 * 등록된 마켓의 카탈로그. 네트워크를 타지 않는다. 캐시된 매니페스트만 읽는다.
 *
 * 페이지는 합친 목록 위에서 한 번 자른다. 마켓별로 limit/offset 을 걸면(구버전)
 * offset=40 이 "마켓마다 40개씩 건너뛰기"가 되고 한 페이지에 limit×마켓수 행이 실려
 * total 과 어긋난다. 마켓이 둘 이상이면 페이지 이동이 곧바로 깨진다.
 * (UI 는 --marketplace 로 마켓 하나씩 따로 페이징한다. 그 경우 이 슬라이스가 곧 그 마켓의
 * 슬라이스가 되므로 같은 코드가 두 용도를 함께 만족한다.)
 *
 * 각 행에는 어느 마켓/URL 에서 왔는지를 붙인다. 합쳐 자른 뒤에도 출처가 유지되도록
 * 별도 메타 배열이 아니라 행 자체에 담는다. marketplaces 요약은 그와 별개로 항상 싣는다:
 * UI 가 마켓별 구획을 그리려면 행을 한 줄도 받기 전에 마켓 목록과 각 개수가 필요하다.
 * limit 이 음수면 행을 아예 싣지 않는다(요약 전용 조회).
 */
async function runCatalog(a: Args): Promise<never> {
  const cfg = libStore.loadCfg(a.store);
  const mks = (gd(cfg, "marketplaces", []) as Dict[]).filter((m) => !truthy(a.marketplace) || g(m, "id") === a.marketplace);
  const rows: Dict[] = [];
  const counts: Record<string, number> = {};
  const summary: Dict[] = [];
  for (const m of mks) {
    const mpath = pjoin(or(g(m, "cache"), ""), marketplace.MANIFEST_REL);
    if (!exists(mpath)) continue;   // 캐시가 사라졌으면 그 마켓만 건너뛴다(전체를 죽이지 않음)
    let mf: marketplace.Manifest;
    try {
      mf = marketplace.parseManifest(mpath);
    } catch (e) {
      if (e instanceof marketplace.ManifestError) continue;
      throw e;
    }
    const fetched: Dict = Object.create(null);
    for (const p of gd(m, "plugins", []) as Dict[]) {
      const n = g(p, "name");
      if (typeof n === "string") fetched[n] = p;
    }
    const r = marketplace.catalog(mf, fetched, a.query, a.category, 0);
    const mname = or(mf.name, g(m, "name"), g(m, "id") ?? null);
    // total 은 필터 후 개수(페이저가 쓴다), total_all 은 필터 전 개수다.
    // 둘 다 보내야 UI 가 "2 / 284" 로 필터가 걸려 있다는 사실 자체를 드러낼 수 있다.
    // 필터 후 개수만 보이면 접힌 섹션에서는 왜 2개인지 알 방법이 없다.
    // categories 집계는 marketplace.catalog 안에서 필터 전에 세므로 그 합이 곧 전체 개수다.
    const totalAll = Object.values(r.categories).reduce((s, v) => s + v, 0);
    summary.push({ id: g(m, "id") ?? null, name: mname, url: or(g(m, "url"), ""), total: r.total, total_all: totalAll });
    for (const [k, v] of Object.entries(r.categories)) counts[k] = (Object.prototype.hasOwnProperty.call(counts, k) ? counts[k] : 0) + v;
    for (const row of r.rows) rows.push({ ...row, marketplace: g(m, "id") ?? null, market_name: mname, market_url: or(g(m, "url"), "") });
  }
  const total = rows.length;
  const rawLimit: number | null = a.limit ?? null;
  const limit = rawLimit && rawLimit > 0 ? rawLimit : 0;
  // 검색/필터로 total 이 줄면 옛 offset 이 목록 밖을 가리킨다. 마지막 페이지로 당긴다.
  let offset = Math.max(0, a.offset || 0);
  if (limit && offset >= total) offset = total ? Math.max(0, Math.floor((total - 1) / limit) * limit) : 0;
  const page = rawLimit !== null && rawLimit < 0 ? [] : limit ? rows.slice(offset, offset + limit) : rows.slice(offset);
  emit(true, "ok", `Plugins: ${total}`, {
    total, total_all: Object.values(counts).reduce((s, v) => s + v, 0), offset, limit: rawLimit, categories: counts, marketplaces: summary, rows: page,
  });
}

/**
 * fetch 직후 실제 개수. 카탈로그에는 이 칼럼이 없다. fetch 이후에만 알 수 있으므로.
 *
 * iterItems 는 나열 실패를 삼키지 않는다. 0 은 '읽었더니 진짜 없다'와 '못 읽었다'를 구분하지 못하므로
 * 실패는 별도 객체로 갈라 둔다. 호출부가 실수로 실패를 0 으로 오독할 수 없게 한다.
 * 두 객체의 키 집합은 항상 서로소다.
 */
function countComponents(root: string, cmap: Dict | null = null): { counts: Record<string, number>; failed: Record<string, string> } {
  const counts: Record<string, number> = {};
  const failed: Record<string, string> = {};
  for (const c of CATEGORY_NAMES) {
    try {
      let n = 0;
      for (const _ of iterItems(root, c, cmap)) n++;
      counts[c] = n;
    } catch (e) {
      if (!isOsError(e)) throw e;
      failed[c] = e.message;
    }
  }
  return { counts, failed };
}

function maxPathHint(root: string): string {
  return process.platform === "win32" && cpLen(root) >= 200 ? MAX_PATH_HINT : "";
}

/**
 * 카탈로그의 플러그인 1개를 물질화해 Library 에 합류시킨다.
 *
 * 번들(str-path)이면 마켓 레포의 sparse 집합을 그 경로만큼 확장하고(+42K),
 * 외부면 그 플러그인만 별도 fetch 한다(~444K). 278개를 미리 받지 않는다.
 */
async function runPluginFetch(a: Args): Promise<never> {
  const mid: string = a.marketplace;
  const cfg0 = libStore.loadCfg(a.store);
  const m = (gd(cfg0, "marketplaces", []) as Dict[]).find((x) => g(x, "id") === mid);
  if (!m) out(false, `Marketplace not registered: ${mid}`, "not_found", { target: mid });
  let mf: marketplace.Manifest;
  try {
    // 플러그인 이름은 신뢰할 수 없는 입력이다. 디스크를 만지기 전에 검증한다.
    marketplace.safeSegment(a.plugin, "plugin name");
    mf = marketplace.parseManifest(pjoin(or(g(m, "cache"), ""), marketplace.MANIFEST_REL));
  } catch (e) {
    if (e instanceof marketplace.ManifestError) emit(false, "external_failed", e.message, { target: a.plugin, detail: e.message });
    throw e;
  }
  const [entry, canonRaw] = marketplace.resolvePlugin(mf, a.plugin);
  if (!entry) emit(false, "not_found", `Plugin not in the catalog: ${a.plugin}`, { target: a.plugin });
  const canon = canonRaw as string;
  let spec: marketplace.SourceSpec;
  try {
    spec = marketplace.sourceSpec(entry!);
  } catch (e) {
    if (e instanceof marketplace.ManifestError) emit(false, "external_failed", e.message, { target: canon, detail: e.message });
    throw e;
  }

  const [, repo, pluginsDir] = marketPaths(a.store, mid);
  const prev = (gd(m, "plugins", []) as Dict[]).find((p) => g(p, "name") === canon) ?? null;
  const oldRoot = g(or(prev, {}), "cache") ?? null;          // 0단계: 옛 root 를 먼저 읽어 둔다
  const oldStaging = g(or(prev, {}), "staging") ?? null;     // 외부 플러그인의 옛 sha 스테이징 루트(있으면)

  if (spec.kind === "str-path" && or(g(m, "kind"), "git") !== "git") {
    // 번들 플러그인은 "마켓 레포의 워킹트리를 넓힌다"는 뜻이라 git 마켓에서만 성립한다.
    // json/local 마켓에는 넓힐 레포가 없다. 그대로 두면 매니페스트 URL 이나 로컬 경로를
    // clone 하려다 엉뚱한 git 오류를 뱉으므로 여기서 이유를 밝히고 끝낸다.
    emit(false, "unsupported", `This market (${pyStr(g(m, "kind") ?? null)}) has no repository, so its bundled plugins cannot be fetched: ${canon} - for a local path, register it as a library path (--lib) instead`, { target: canon });
  }
  let sha = "";
  let root = "";
  let sparse: string | null = null;
  let staging: string | null = null;
  try {
    if (spec.kind === "str-path") {
      // 번들: 마켓 레포의 sparse 집합을 확장한다(별도 클론 없음). 지울 전용 스테이징이 없다.
      const keep = sortedStrings(new Set([".claude-plugin", ...(gd(m, "plugins", []) as Dict[]).map((p) => g(p, "sparse")).filter((s) => truthy(s)), spec.path as string]));
      sha = await remoteFetch.materialize(repo, m!.url, or(g(m, "ref"), null), null, keep);
      root = pjoin(repo, ...(spec.path as string).split("/"));
      sparse = spec.path;
      staging = null;
    } else {
      // 외부: plugins/<name>/<sha12>/ 에 완전히 물질화한 뒤에야 옛 sha 를 지운다(1단계).
      // 디렉토리 이름에는 sha 앞 12자만 쓴다(Windows MAX_PATH 에 28자 여유를 번다).
      // 12자는 이 용도로 충돌 걱정 없이 유일하다. 원장/레지스트리에는
      // 항상 spec.sha(또는 materialize 가 돌려준 전체 sha)를 그대로 저장한다.
      // 식별/비교/원장 참조는 전체 sha 에 의존하므로 여기서 자르면 안 된다.
      const shaTag = spec.sha ? spec.sha.slice(0, 12) : "head";
      staging = pjoin(pluginsDir, canon, shaTag);
      sha = await remoteFetch.materialize(staging, spec.url as string, spec.ref, spec.sha, spec.path ? [spec.path] : null);
      root = spec.path ? pjoin(staging, ...spec.path.split("/")) : staging;
      sparse = null;
    }
  } catch (e) {
    if (e instanceof remoteFetch.GitError) emit(false, "external_failed", e.message, { target: canon, detail: e.message });
    throw e;
  }

  // materialize 가 성공을 보고해도(git rc=0, 예외 없음) 결과 디렉토리가 실제로 없을 수 있다.
  // 실측: Windows MAX_PATH(약 260자) 를 넘는 경로는 git 이 파일을 못 쓰는데도 조용히 넘어가고,
  // 이후 isdir/walk 는 예외 대신 False/빈 결과를 낸다. 그 상태로 원장에 쓰면
  // "가져옴: 성공, 컴포넌트 0개" 라는 거짓 성공이 나간다. 등록(원장 쓰기)
  // 전에 여기서 반드시 확인한다. 번들/외부 두 경로 모두 이 한 지점에서 걸러진다.
  if (!isDir(root)) {
    const length = cpLen(root);
    emit(false, "cache_missing", `Plugin cache directory not found (length ${length} characters): ${root}.${maxPathHint(root)}`, { target: root, root, root_length: length });
  }

  const layout = remoteFetch.detectLayout(root);
  // staging 을 rec 에 그대로 들고 있는다. source.path 가 다단(예: "plugins/sub")이면
  // dirname(root) 로 스테이징 루트를 역산하는 건 한 단계 안쪽을 지워 옛 sha 디렉토리
  // 자체가 살아남는다(git-subdir 가 80/278 로 흔한 종류라 실사용에서 매번 재현된다).
  const rec = { name: canon, sha, fetched_at: now(), cache: root, staging, map: or(layout.map, null), sparse, kind: spec.kind };
  let cfg: StoreConfig = {};
  try {
    await libStore.withEditCfg(a.store, (c) => {   // 3단계: 원장/레지스트리 갱신
      cfg = c;
      const m2 = (c.marketplaces as Dict[]).find((x) => g(x, "id") === mid);
      if (!m2) {
        const err = new Error("");
        err.name = "StopIteration";
        throw err;
      }
      if (!Object.prototype.hasOwnProperty.call(m2, "plugins")) m2.plugins = [];
      const pl = m2.plugins as Dict[];
      const i = prev ? pl.findIndex((p) => isDeepStrictEqual(p, prev)) : -1;
      if (i >= 0) pl[i] = rec;
      else pl.push(rec);
    });
  } catch (e) {
    if (e instanceof StoreNotInitialized) emit(false, "store_uninitialized", e.message);
    throw e;
  }

  // 4단계: 등록이 성공한 뒤에만 옛 sha 스테이징 디렉토리를 지운다.
  // 여기 도달하기 전에 실패하면 옛 설치가 계속 동작한다. 그것이 sha 층을 두는 이유다.
  // oldStaging 이 없으면(번들이었거나 첫 fetch) 지울 전용 디렉토리가 없다는 뜻이니 건드리지 않는다.
  if (truthy(oldStaging) && norm(oldStaging) !== norm(staging || "") && !libStore.ledgerRefsRoot(cfg, oldRoot).length) {
    rmtreeForce(oldStaging);
  }

  const comp = countComponents(root, layout.map);
  let warning: string | null = null;
  if (Object.keys(comp.failed).length) {
    // fetch 자체는 성공이다(파일은 디스크에 있고 등록도 유효하다). ok:true 를 유지하되,
    // "성공 + 0개" 로는 못 읽게 경고를 명시적으로 붙인다. scan 이 이미
    // 쓰는 것과 같은 근거(경로 길이 / CLAUDE_SNAPSHOT_STORE)를 재사용한다.
    warning = `Could not list these categories, so their counts are unknown (not zero): ${sortedStrings(Object.keys(comp.failed)).join(", ")}.${maxPathHint(root)}`;
  }
  emit(true, "ok", `Fetched: ${canon}`, {
    origin: `market:${mid}/${canon}`, plugin: canon, cache: root, sha, components: comp.counts, components_failed: comp.failed,
    has_hooks: exists(pjoin(root, "hooks", "hooks.json")), has_mcp: pluginUnits.hasMcp(root), warning,
  });
}

/**
 * 등록된 remote/market 을 명시적으로 갱신한다. 자동 pull 은 없다.
 * hooks 라면 매 세션 실행되는 코드가 조용히 바뀌는 것이므로 사용자가 눌러야 한다.
 *
 * remotes[]/marketplaces[] 가 별도 배열이고 id 를 레포명에서 파생하므로 둘 다 'my-tools' 일 수 있다.
 * 그래서 접두 붙은 origin 형식으로 받는다.
 */
async function runFetch(a: Args): Promise<never> {
  const origin: string = a.origin || "";
  const cfg = libStore.loadCfg(a.store);
  if (origin.startsWith("remote:")) {
    const rid = origin.slice("remote:".length);
    const r = (gd(cfg, "remotes", []) as Dict[]).find((x) => g(x, "id") === rid);
    if (!r) emit(false, "not_found", `Remote not registered: ${rid}`, { target: rid });
    let sha = "";
    try {
      sha = await remoteFetch.materialize(r!.cache, r!.url, or(g(r, "ref"), null));
    } catch (e) {
      if (e instanceof remoteFetch.GitError) emit(false, "external_failed", e.message, { target: rid, detail: e.message });
      throw e;
    }
    const cmap = remoteFetch.detectLayout(r!.cache).map;
    await libStore.withEditCfg(a.store, (c) => {
      const r2 = (gd(c, "remotes", []) as Dict[]).find((x) => g(x, "id") === rid);
      if (!r2) emit(false, "not_found", `Remote not registered: ${rid}`, { target: rid });
      r2!.sha = sha;
      r2!.fetched_at = now();
      r2!.map = or(cmap, g(r2, "map") ?? null);
    });
    emit(true, "ok", `Updated: ${rid}`, { origin, sha });
  }
  if (origin.startsWith("market:")) {
    const [mid, pname] = partition(origin.slice("market:".length));
    if (pname) return runPluginFetch({ ...a, marketplace: mid, plugin: pname });   // 플러그인 갱신 = 재-fetch(원자적 교체 포함)
    const m = (gd(cfg, "marketplaces", []) as Dict[]).find((x) => g(x, "id") === mid);
    if (!m) emit(false, "not_found", `Market not registered: ${mid}`, { target: mid });
    // 매니페스트만 다시 받는다(플러그인은 보존). kind 별로 하는 일이 다르다:
    //   git/json  원격에서 다시 받는다.
    //   local     받을 원격이 없다. 그래도 no-op 으로 두지 않고 디스크에서 매니페스트를
    //             다시 읽는다: 사용자가 그 파일을 직접 고치는 게 로컬 마켓의 갱신이므로,
    //             다시 읽어야 카탈로그와 sha(내용 해시)가 실제 내용과 맞는다. 버튼이
    //             아무 일도 안 하는 것처럼 보이는 게 조용한 실패다.
    return runMarketAdd({ ...a, url: m!.url, ref: g(m, "ref") ?? null, id: mid });
  }
  emit(false, "invalid_arg", `Invalid origin format (expected remote:<id> or market:<id>[/<plugin>]): ${origin}`, { target: origin });
}

/** origin -> hooks/mcp 원장 이름. 경로/설정을 읽지 않는 순수 문자열 파생이라 행마다 불러도 store 를 다시 읽지 않는다. */
function unitName(origin: string): string {
  if (origin.startsWith("remote:")) return origin.slice("remote:".length);
  if (origin.startsWith("market:")) {
    const [mid, pname] = partition(origin.slice("market:".length));
    return pname || mid;
  }
  if (origin.startsWith("local:")) {
    // 경로 전체를 쓴다. basename 으로 줄이면 라이브러리 루트가 대개 ".claude" 라
    // 등록된 로컬 라이브러리 둘이 같은 원장 칸을 쓰고 뒤에 설치한 쪽이 앞을 덮어써,
    // 앞 라이브러리의 hooks 를 대시보드에서 제거할 수 없게 된다.
    return origin.slice("local:".length) || origin;
  }
  return origin;
}

/** origin -> [플러그인 루트 경로, 표시 이름]. 미물질화면 [null, name]. */
function resolveOriginRoot(store: string, origin: string): [string | null, string] {
  if (origin.startsWith("remote:")) {
    const rid = origin.slice("remote:".length);
    const r = (gd(libStore.loadCfg(store), "remotes", []) as Dict[]).find((x) => g(x, "id") === rid);
    return [g(or(r, {}), "cache") ?? null, rid];
  }
  if (origin.startsWith("market:")) {
    const [mid, pname] = partition(origin.slice("market:".length));
    const m = (gd(libStore.loadCfg(store), "marketplaces", []) as Dict[]).find((x) => g(x, "id") === mid);
    if (!m) return [null, pname || mid];
    const p = (gd(m, "plugins", []) as Dict[]).find((x) => g(x, "name") === pname);
    return [g(or(p, {}), "cache") ?? null, pname];
  }
  if (origin.startsWith("local:")) {
    // 로컬 라이브러리도 hooks/hooks.json / .mcp.json 을 가질 수 있다. origin 이 곧 경로라
    // 물질화 여부를 물을 것도 없다. 호출부가 isdir 로 존재만 확인한다.
    return [origin.slice("local:".length), unitName(origin)];
  }
  return [null, origin];
}

/**
 * --target 검증: .claude 루트만 허용(도구 파라미터 targetDir 의 계약 그대로).
 * install 은 <target>/<category>/<name> 에 라이브러리 내용을 쓰는데, install 의 부모 존재
 * 검사(phantom 방지)는 '존재하는 아무 디렉토리'를 다 통과시킨다. 그 경로로 임의 위치에
 * 파일을 심을 수 있다. UI 도 basename 이 .claude 인 후보만 대상 목록에 올린다(tracked.ts).
 */
function safeTargetDir(d: string): string {
  const n = normpath(d);
  if (normcase(basename(n)) !== normcase(".claude")) out(false, `Invalid install target (only <...>/.claude is allowed): '${d}'`, "invalid_arg", { target: d });
  return n;
}

function settingsPath(a: Args): string {
  // --settings 와 --target 은 둘 다 도구 파라미터로 노출돼 있고 여기서 합류한다. 검증을
  // 합류 지점에 두어야 --target 이 '--settings 를 다른 이름으로 넘기는 통로'가 되지 않는다.
  return safeSettingsPath(truthy(a.settings) ? a.settings : pjoin(a.target, "settings.json"));
}

function hookEvents(hooksCfg: unknown): string[] {
  return sortedStrings(Object.keys(or(g(hooksCfg, "hooks"), {})));
}

/**
 * 플러그인의 hooks 를 settings.json 에 병합한다. 네트워크를 타지 않는다.
 * 미물질화 플러그인이면 암묵적으로 받아오지 않고 거부한다. fetch 는 항상 사용자가 명시적으로 누른 결과여야 한다.
 */
async function runHooksInstall(a: Args): Promise<never> {
  const [root, name] = resolveOriginRoot(a.store, a.origin);
  if (!truthy(root) || !isDir(root!)) emit(false, "not_fetched", `Not fetched yet - run fetch first: ${a.origin}`, { target: a.origin });
  const hooksCfg = pluginUnits.loadHooksJson(root!, PY_NUMBERS);
  if (!truthy(hooksCfg)) emit(false, "not_found", `hooks/hooks.json not found: ${a.origin}`, { target: a.origin });

  const warns = pluginUnits.interpreterWarnings(hooksCfg);
  const commands = pluginUnits.hookCommands(pluginUnits.substitute(hooksCfg, root!));
  if (a.dryRun) {
    // 치환된 명령 원문을 그대로 보여준다. 설치 = 매 세션 임의 코드 실행이므로 별도 확인 단계다.
    emit(true, "dry_run", `Would install hooks: ${name} (${commands.length})`, { dry_run: true, origin: a.origin, root, commands, warnings: warns, events: hookEvents(hooksCfg) });
  }

  const sp = settingsPath(a);
  const cfg = libStore.loadCfg(a.store);
  const prev = or(libStore.ledgerGet(cfg, a.target, "hooks", name), {});
  const oldRoot = g(prev, "root") ?? null;   // needle 은 원장의 root 이지 현재 캐시 경로가 아니다

  let s = load(sp) as Dict;
  let removed: number, added: number;
  [s, removed, added] = pluginUnits.hooksMerge(s, hooksCfg, root!, oldRoot);
  if (!a.noSnapshot) await snapshotBefore(a.store);
  const bak = backup(sp);
  saveAtomic(sp, s);

  let warn: string | null = null;
  const srcHash = hashFile(pjoin(root!, pluginUnits.HOOKS_REL));
  try {
    await libStore.withEditCfg(a.store, (c) => {
      libStore.ledgerPut(c, a.target, "hooks", name, { kind: "hooks", origin: a.origin, root, events: hookEvents(hooksCfg), src_hash: srcHash, at: now() });
    });
  } catch (e) {
    if (!(e instanceof StoreNotInitialized)) throw e;
    warn = "Store is not initialized, so the origin was not recorded - pass the path with --root when uninstalling";
  }
  if (!a.noSnapshot) await snapshotAfter(a.store, `Hooks installed: ${name} (${added})`);
  emit(true, "ok", `Hooks installed: ${name} (${added})`, { origin: a.origin, root, settings: sp, removed, added, backup: bak, warnings: warns, warning: warn });
}

/**
 * settings 에서 이 플러그인의 hook 엔트리를 제거한다. root 매칭 + (있으면) 구조적 동일성,
 * hooksMerge 가 삽입 중복을 막는 두 메커니즘을 그대로 대칭 적용한다.
 *
 * root 매칭만으로는 ${CLAUDE_PLUGIN_ROOT} 를 전혀 안 쓰는 hook(전역 도구를 직접 부르는
 * 유효한 hooks.json)을 못 찾는다. 그런 엔트리는 설치 때 identity 매칭으로 들어갔으므로
 * 제거도 identity 매칭이어야 대칭이다. hooksCfg 가 없으면(캐시가 이미 사라졌거나
 * hooks.json 을 못 읽음) root 매칭만 수행한다. 호출부가 이 축소된 결과를 degraded 로 알린다.
 */
function hooksRemoveAll(settings0: Dict, root: string, hooksCfg: unknown): [Dict, number] {
  let [settings, removed] = pluginUnits.hooksRemove(settings0, root);
  if (!truthy(hooksCfg)) return [settings, removed];
  const subbed = pluginUnits.substitute(hooksCfg, root);
  const hooks = or(g(settings, "hooks"), {}) as Dict;
  for (const [event, entries0] of Object.entries(or(g(subbed, "hooks"), {}) as Dict)) {
    const entries = or(entries0, []) as unknown[];
    if (!entries.length || !Object.prototype.hasOwnProperty.call(hooks, event)) continue;
    const existing = hooks[event] as unknown[];
    // settings 와 hooks.json 은 소수를 PyFloat 로 읽으므로 Python 의 == 로 비교한다.
    const keep = existing.filter((e) => !entries.some((x) => pyEq(x, e)));   // 사용자 hook 은 이 필터에 안 걸린다
    removed += existing.length - keep.length;
    if (keep.length) hooks[event] = keep;
    else delete hooks[event];   // 빈 배열을 남기지 않는다
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  return [settings, removed];
}

/**
 * settings.json 에서 이 플러그인의 hook 엔트리를 걷어낸다. 캐시는 지우지 않는다.
 *
 * 구조적 동일성 판정에는 그 플러그인의 hooks.json 이 다시 필요하다. 원장의 root 는
 * 캐시가 아직 살아있다는 보장이다(unregister 가 원장이 참조하는 캐시를 지우지 못하게 막는다).
 * 사용자가 도구 밖에서 캐시를 직접 지웠다면 그 보장이 깨지므로 root 매칭만으로 폴백하고,
 * 무엇을 못 했는지 결과에 명시한다(조용히 덜 하지 않는다).
 */
async function runHooksUninstall(a: Args): Promise<never> {
  const cfg = libStore.loadCfg(a.store);
  const [, name] = resolveOriginRoot(a.store, a.origin);
  const rec = or(libStore.ledgerGet(cfg, a.target, "hooks", name), {});
  const root = or(g(rec, "root"), resolveOriginRoot(a.store, a.origin)[0]);
  if (!truthy(root)) emit(true, "noop", "No install record (no-op)", { changed: false });
  const cachePresent = isDir(root);
  const hooksCfg = cachePresent ? pluginUnits.loadHooksJson(root, PY_NUMBERS) : null;
  const sp = settingsPath(a);
  let s = load(sp) as Dict;
  let removed: number;
  [s, removed] = hooksRemoveAll(s, root, hooksCfg);
  if (removed) {
    if (!a.noSnapshot) await snapshotBefore(a.store);
    backup(sp);
    saveAtomic(sp, s);
    if (!a.noSnapshot) await snapshotAfter(a.store, `Hooks removed: ${name} (${removed})`);
  }
  try {
    await libStore.withEditCfg(a.store, (c) => libStore.ledgerDel(c, a.target, "hooks", name));
  } catch (e) {
    if (!(e instanceof StoreNotInitialized)) throw e;
  }
  const degraded = !cachePresent;
  const warn = degraded
    ? "The plugin cache is already gone, so only hooks matching its path were removed - hooks that do not reference the plugin root (ones that call a global tool directly) may remain"
    : null;
  emit(true, "ok", `Hooks removed: ${name} (${removed})`, { origin: a.origin, removed, changed: !!removed, degraded, warning: warn });
}

/** scope -> 대상 파일. desktop 이 실질 가치다. Claude Desktop 에는 /plugin 마켓플레이스가 없다. */
function mcpTarget(a: Args): string {
  return a.scope === "desktop" ? a.desktopConfig : a.claudeJson;
}

/** 플러그인의 .mcp.json 서버를 ~/.claude.json 또는 Desktop config 에 넣는다. 네트워크를 타지 않는다. 미물질화면 거부한다. */
async function runMcpInstall(a: Args): Promise<never> {
  const [root, name] = resolveOriginRoot(a.store, a.origin);
  if (!truthy(root) || !isDir(root!)) emit(false, "not_fetched", `Not fetched yet - run fetch first: ${a.origin}`, { target: a.origin });
  const mcp = pluginUnits.loadMcpJson(root!, PY_NUMBERS);
  let servers = or(g(or(mcp, {}), "mcpServers"), {}) as Dict;
  if (truthy(a.server)) {
    if (!Object.prototype.hasOwnProperty.call(servers, a.server)) {
      emit(false, "not_found", `No such server: ${a.server}`, { target: a.server, available: sortedStrings(Object.keys(servers)) });
    }
    servers = { [a.server]: servers[a.server] };
  }
  if (!Object.keys(servers).length) emit(false, "not_found", `No MCP server declarations (.mcp.json / plugin.json): ${a.origin}`, { target: a.origin });
  servers = pluginUnits.substitute(servers, root!);

  const tgt = mcpTarget(a);
  if (a.dryRun) {
    emit(true, "dry_run", `Would install MCP servers: ${name} (${Object.keys(servers).length})`, {
      dry_run: true, origin: a.origin, root, target: tgt, servers: sortedStrings(Object.keys(servers)), server_config: servers,
    });
  }

  let d = load(tgt) as Dict;
  for (const [sname, sconf] of Object.entries(servers)) [d] = opMcpAdd(d, sname, sconf);
  if (!a.noSnapshot) await snapshotBefore(a.store);
  const bak = backup(tgt);
  saveAtomic(tgt, d);

  let warn: string | null = null;
  try {
    await libStore.withEditCfg(a.store, (c) => {
      const prev = or(libStore.ledgerGet(c, a.target, "mcp", name), {});
      const merged = sortedStrings(new Set([...(gd(prev, "servers", []) as string[]), ...Object.keys(servers)]));
      libStore.ledgerPut(c, a.target, "mcp", name, { kind: "mcp", origin: a.origin, root, scope: a.scope, target: tgt, servers: merged, at: now() });
    });
  } catch (e) {
    if (!(e instanceof StoreNotInitialized)) throw e;
    warn = "Store is not initialized, so the origin was not recorded (the install itself completed)";
  }
  const n = Object.keys(servers).length;
  if (!a.noSnapshot) await snapshotAfter(a.store, `MCP servers installed: ${name} (${n}, scope=${a.scope})`);
  emit(true, "ok", `MCP servers installed: ${name} (${n}, scope=${a.scope})`, { origin: a.origin, target: tgt, backup: bak, servers: sortedStrings(Object.keys(servers)), warning: warn });
}

/** 원장에 기록된 서버 이름만 지운다. 사용자가 직접 넣은 서버는 건드리지 않는다. */
async function runMcpUninstall(a: Args): Promise<never> {
  const cfg = libStore.loadCfg(a.store);
  const [, name] = resolveOriginRoot(a.store, a.origin);
  const rec = or(libStore.ledgerGet(cfg, a.target, "mcp", name), {});
  const names = (truthy(a.server) ? [a.server] : gd(rec, "servers", [])) as string[];
  const tgt = or(g(rec, "target"), mcpTarget(a)) as string;
  if (!truthy(names)) emit(true, "noop", "No install record (no-op)", { changed: false });
  let d = load(tgt) as Dict;
  let removed = 0;
  for (const sname of names) {
    let ch: boolean;
    [d, , ch] = opMcpRemove(d, sname);
    removed += ch ? 1 : 0;
  }
  if (removed) {
    if (!a.noSnapshot) await snapshotBefore(a.store);
    backup(tgt);
    saveAtomic(tgt, d);
    if (!a.noSnapshot) await snapshotAfter(a.store, `MCP servers removed: ${name} (${removed})`);
  }
  try {
    await libStore.withEditCfg(a.store, (c) => {
      const r = or(libStore.ledgerGet(c, a.target, "mcp", name), {});
      if (truthy(a.server) && truthy(g(r, "servers"))) {
        r.servers = (r.servers as string[]).filter((s) => s !== a.server);
        if (truthy(r.servers)) libStore.ledgerPut(c, a.target, "mcp", name, r);
        else libStore.ledgerDel(c, a.target, "mcp", name);
      } else {
        libStore.ledgerDel(c, a.target, "mcp", name);
      }
    });
  } catch (e) {
    if (!(e instanceof StoreNotInitialized)) throw e;
  }
  emit(true, "ok", `MCP servers removed: ${name} (${removed})`, { origin: a.origin, target: tgt, removed, changed: !!removed });
}

// ----- 진입점 -----

function defaults(): Omit<Args, "target"> & { target: string } {
  const home = expanduser("~");
  return {
    store: libStore.defaultStore(),
    target: pjoin(home, ".claude"),
    noSnapshot: false,
    claudeJson: pjoin(home, ".claude.json"),
    desktopConfig: desktopConfigPath(),
  };
}

// snapshotBefore~snapshotAfter 구간을 직접 쓰는 명령. config_edit 의 스팬 상태를 나눠 쓰므로 그 편집 락 안에서 돌린다.
// 이 명령들은 config_edit 의 cmd*(락을 다시 잡는다)를 부르지 않고 op 함수만 쓴다(락은 재진입하지 않는다).
const SPAN_OPS: ReadonlySet<(a: Args) => Promise<never>> = new Set([runInstall, runUninstall, runHooksInstall, runHooksUninstall, runMcpInstall, runMcpUninstall]);

async function runOp(fn: (a: Args) => Promise<never>, a: Args): Promise<CliDoc> {
  if (!SPAN_OPS.has(fn)) return guard(() => fn(a), CODES);
  return withEditLock(async () => {
    try {
      return await guard(() => fn(a), CODES, releaseSpan);
    } finally {
      // 예외가 아니어도 out 이 던진 문서로 끝나면 snapshotAfter 를 지나지 않으므로 여기서 놓는다.
      releaseSpan();
    }
  });
}

function toArgs(opts: LibOpts & Dict): Args {
  const d = defaults();
  const a: Args = { ...d, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) } as Args;
  a.target = safeTargetDir(a.target);
  return a;
}

async function wrap(fn: (a: Args) => Promise<never>, opts: LibOpts & Dict): Promise<CliDoc> {
  let a: Args;
  try {
    a = toArgs(opts);
  } catch (e) {
    return guard(() => { throw e; }, CODES);
  }
  return runOp(fn, a);
}

export async function cmdScan(opts: LibOpts & { lib?: string | null }): Promise<CliDoc> {
  return wrap(runScan, opts);
}

export async function cmdUnregister(opts: LibOpts & { lib?: string | null; origin?: string | null }): Promise<CliDoc> {
  return wrap(runUnregister, opts);
}

export async function cmdInstall(opts: LibOpts & { category: Category; path: string; lib?: string | null; origin?: string | null }): Promise<CliDoc> {
  return wrap(runInstall, opts);
}

export async function cmdUninstall(opts: LibOpts & { category: Category; name: string; origin?: string | null }): Promise<CliDoc> {
  return wrap(runUninstall, opts);
}

/** 네트워크(git). map 은 CLI --map JSON 문자열 그대로. */
export async function cmdRemoteAdd(opts: LibOpts & { url: string; ref?: string | null; id?: string | null; map?: string | null }): Promise<CliDoc> {
  return wrap(runRemoteAdd, opts);
}

/** 네트워크(git 또는 HTTP, 로컬 경로면 없음). */
export async function cmdMarketAdd(opts: LibOpts & { url: string; ref?: string | null; id?: string | null }): Promise<CliDoc> {
  return wrap(runMarketAdd, opts);
}

export async function cmdMarketDiscover(opts: LibOpts & { pluginsDir?: string }): Promise<CliDoc> {
  return wrap(runMarketDiscover, opts);
}

export async function cmdCatalog(opts: LibOpts & { marketplace?: string | null; query?: string | null; category?: string | null; limit?: number; offset?: number }): Promise<CliDoc> {
  return wrap(runCatalog, { limit: 50, offset: 0, ...opts });
}

/** 네트워크(git). */
export async function cmdPluginFetch(opts: LibOpts & { marketplace: string; plugin: string }): Promise<CliDoc> {
  return wrap(runPluginFetch, opts);
}

/** 네트워크(git 또는 HTTP). */
export async function cmdFetch(opts: LibOpts & { origin: string }): Promise<CliDoc> {
  return wrap(runFetch, opts);
}

export async function cmdHooksInstall(opts: LibOpts & { origin: string; settings?: string | null; dryRun?: boolean }): Promise<CliDoc> {
  return wrap(runHooksInstall, opts);
}

export async function cmdHooksUninstall(opts: LibOpts & { origin: string; settings?: string | null }): Promise<CliDoc> {
  return wrap(runHooksUninstall, opts);
}

export async function cmdMcpInstall(opts: LibOpts & { origin: string; server?: string | null; dryRun?: boolean; scope?: "user" | "desktop" }): Promise<CliDoc> {
  return wrap(runMcpInstall, { scope: "user", ...opts });
}

export async function cmdMcpUninstall(opts: LibOpts & { origin: string; server?: string | null; scope?: "user" | "desktop" }): Promise<CliDoc> {
  return wrap(runMcpUninstall, { scope: "user", ...opts });
}

const RUNNERS: Record<string, (a: Args) => Promise<never>> = {
  "scan": runScan, "unregister": runUnregister, "install": runInstall, "uninstall": runUninstall,
  "remote-add": runRemoteAdd, "market-add": runMarketAdd, "market-discover": runMarketDiscover, "catalog": runCatalog,
  "plugin-fetch": runPluginFetch, "fetch": runFetch, "hooks-install": runHooksInstall, "hooks-uninstall": runHooksUninstall,
  "mcp-install": runMcpInstall, "mcp-uninstall": runMcpUninstall,
};

function parser(): JsonArgumentParser {
  const d = defaults();
  const ap = new JsonArgumentParser("library");
  ap.addArgument("--store", { dest: "store", default: d.store });
  ap.addArgument("--target", { dest: "target", default: d.target });
  ap.addArgument("--no-snapshot", { dest: "noSnapshot", action: "store_true" });
  ap.addArgument("--claude-json", { dest: "claudeJson", default: d.claudeJson });
  ap.addArgument("--desktop-config", { dest: "desktopConfig", default: d.desktopConfig });
  const sub = ap.addSubparsers({ dest: "op", required: true });
  const cats = CATEGORY_NAMES as readonly string[];

  sub.addParser("scan").addArgument("--lib", { dest: "lib", default: null });
  sub.addParser("unregister").addArgument("--lib", { dest: "lib", default: null }).addArgument("--origin", { dest: "origin", default: null });
  sub.addParser("install").addArgument("category", { choices: cats }).addArgument("path")
    .addArgument("--lib", { dest: "lib", default: null }).addArgument("--origin", { dest: "origin", default: null });
  sub.addParser("uninstall").addArgument("category", { choices: cats }).addArgument("name").addArgument("--origin", { dest: "origin", default: null });
  sub.addParser("remote-add").addArgument("--url", { dest: "url", required: true }).addArgument("--ref", { dest: "ref", default: null })
    .addArgument("--id", { dest: "id", default: null }).addArgument("--map", { dest: "map", default: null });
  sub.addParser("market-add").addArgument("--url", { dest: "url", required: true }).addArgument("--ref", { dest: "ref", default: null })
    .addArgument("--id", { dest: "id", default: null });
  sub.addParser("market-discover").addArgument("--plugins-dir", { dest: "pluginsDir", default: null });
  sub.addParser("catalog").addArgument("--marketplace", { dest: "marketplace", default: null }).addArgument("--query", { dest: "query", default: null })
    .addArgument("--category", { dest: "category", default: null })
    .addArgument("--limit", { dest: "limit", type: "int", default: 50 }).addArgument("--offset", { dest: "offset", type: "int", default: 0 });
  sub.addParser("plugin-fetch").addArgument("--marketplace", { dest: "marketplace", required: true }).addArgument("--plugin", { dest: "plugin", required: true });
  sub.addParser("fetch").addArgument("--origin", { dest: "origin", required: true });
  sub.addParser("hooks-install").addArgument("--origin", { dest: "origin", required: true }).addArgument("--settings", { dest: "settings", default: null })
    .addArgument("--dry-run", { dest: "dryRun", action: "store_true" });
  sub.addParser("hooks-uninstall").addArgument("--origin", { dest: "origin", required: true }).addArgument("--settings", { dest: "settings", default: null });
  sub.addParser("mcp-install").addArgument("--origin", { dest: "origin", required: true }).addArgument("--server", { dest: "server", default: null })
    .addArgument("--dry-run", { dest: "dryRun", action: "store_true" }).addArgument("--scope", { dest: "scope", choices: ["user", "desktop"], default: "user" });
  sub.addParser("mcp-uninstall").addArgument("--origin", { dest: "origin", required: true }).addArgument("--server", { dest: "server", default: null })
    .addArgument("--scope", { dest: "scope", choices: ["user", "desktop"], default: "user" });
  return ap;
}

/** argv 는 python library.py 의 인자와 같다. */
export async function main(argv: string[]): Promise<CliDoc> {
  let a: Args;
  try {
    a = parser().parse(argv) as Args;
    a.target = safeTargetDir(a.target);
  } catch (e) {
    return guard(() => { throw e; }, CODES);
  }
  return runOp(RUNNERS[a.op], a);
}
