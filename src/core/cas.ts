// cas.ts - Custom Content-Addressable Snapshot engine (git 원리, 독립 경로 추적판). src/cas.py 이식.
//
// git 과 다른 점:
//   - 단일 work-tree 루트를 가정하지 않는다. 흩어진 임의의 절대경로/디렉토리/glob 를
//     각각 독립적으로 추적한다. (10~20개 규모 대상)
//   - 저장소는 추적 대상과 분리된 한 곳에 모인다. 기본값: CLAUDE_SNAPSHOT_STORE 환경변수,
//     없으면 lib_store.defaultStore() 규칙(--store 로 오버라이드).
//
// 변경 탐지 원리 (git index 모델):
//   1) stat fast-path: size + mtime_ns 가 index 와 같으면 내용을 안 읽고 unchanged.
//   2) 다르면 내용을 해싱해 hash 비교 (touch 등 내용 무변경 케이스 제거).
//   3) index 에 없는 경로 = 신규, 워킹트리에 없는데 index 에 있으면 = 삭제.
//   4) 해시가 달라도 파일별 무시 키 프로필(DEFAULT_IGNORE_KEYS)로 걸러 같으면 unchanged.
//
// cmd* 는 CLI 서브커맨드의 --json 형태와 같은 문서를 돌려준다. 나머지는 다른 모듈이 부르는 함수다.
import { createHash } from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { compareCodePoints, emit, guard, JsonArgumentParser, makeDoc, type CliDoc, type CodeMap } from "./cli_result.ts";
import {
  abspath, basename, configLock, defaultStore as libDefaultStore, dirname, fileLock, isDict, isOSError, isoLocal,
  isValueError, LOCK_STALE_SEC as LIB_LOCK_STALE_SEC, lockWaitSec, LockTimeoutError, normcase, pjoin, psplit, pyDumpsEx,
  pyEq, pyErrorName, pyFixed, pyLoads, pyNow, pyTruthy, readJsonFile, SEP, stamp, textModeNewlines, UnicodeDecodeError,
  type LockHandle,
} from "./lib_store.ts";
import { desktopConfigPath, expanduser } from "./paths.ts";

export interface StorePaths {
  store: string;
  config: string;
  index: string;
  objects: string;
  snapshots: string;
  log: string;
}

export interface CasConfig {
  version?: number;
  store?: string;
  tracked: string[];
  ignore_defaults?: string[];
  ignore_keys?: Record<string, string[]>;
  ignore_empty_projects?: boolean;
  [key: string]: unknown;
}

/** index.json 항목. mtime_ns 는 2^53 을 넘으므로 정밀도를 잃지 않게 bigint 로 다룬다(docs/port-contract-2026-11-20.md 7.2절). */
export interface IndexEntry {
  size: number;
  mtime_ns: bigint;
  mode: number;
  hash: string | null;
}

export type CasIndex = Record<string, IndexEntry>;

export interface ScanResult {
  new: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
}

export interface IgnoreProfile {
  rules: string[][];
  keep: string[][];
  empty_projects: boolean;
  fp: string;
}

export interface StoreOpts {
  /** 생략 시 defaultStore(). */
  store?: string;
}

const CODES: CodeMap = [[LockTimeoutError, "lock_timeout"]];
const GLOB_CHARS = /[*?[\]]/;
const hasGlob = (s: string) => GLOB_CHARS.test(s);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// ----- 저장소 경로와 JSON -----

/** Python cas.DEFAULT_STORE. lib_store.defaultStore() 와 같은 값이다. */
export function defaultStore(): string {
  return libDefaultStore();
}

/** 존재하면 자동 추적할 기본 대상. untrack 으로 명시 제외한 항목(ignore_defaults)은 다시 넣지 않는다. */
export function defaultTracked(): string[] {
  const home = expanduser("~");
  return [
    pjoin(home, ".claude.json"),
    pjoin(home, ".claude", "settings.json"),
    desktopConfigPath(),   // 설치 방식(Win32/MSIX)에 맞는 실제 desktop config
  ];
}

export function storePaths(store: string): StorePaths {
  return {
    store,
    config: pjoin(store, "config.json"),
    index: pjoin(store, "index.json"),
    objects: pjoin(store, "objects"),
    snapshots: pjoin(store, "snapshots"),
    log: pjoin(store, "log"),
  };
}

/** utf-8-sig 로 읽는다. 파일이 없으면 dflt. 깨진 JSON 은 던진다. saveJson 이 같은 숫자 표기로 다시 쓰도록 소수는 PyFloat 로 읽는다. */
export function loadJson<T>(path: string, dflt: T): T | unknown {
  if (!fs.existsSync(path)) return dflt;
  return readJsonFile(path, { floats: true });
}

/** <path>.<pid>.tmp 에 utf-8, indent 2, ensure_ascii=False 로 쓰고 replace. 줄바꿈은 docs/port-contract-2026-11-20.md 7.2절. */
export function saveJson(path: string, data: unknown): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;   // 잠금 없는 쓰기(sig 캐시)가 두 프로세스에서 겹쳐도 서로의 임시 파일을 밟지 않게
  fs.writeFileSync(tmp, textModeNewlines(pyDumpsEx(data, { indent: 2, ensureAscii: false })), "utf8");
  fs.renameSync(tmp, path);
}

/** index.json 을 읽고 mtime_ns 를 bigint 로 맞춘다(안전 범위의 값도 number 로 남기지 않는다). */
export function loadIndex(p: StorePaths): CasIndex {
  const idx = loadJson(p.index, {}) as Record<string, Record<string, unknown>>;
  if (isDict(idx)) {
    for (const e of Object.values(idx)) {
      if (isDict(e) && typeof e.mtime_ns === "number" && Number.isInteger(e.mtime_ns)) e.mtime_ns = BigInt(e.mtime_ns);
    }
  }
  return idx as unknown as CasIndex;
}

function mergeDefaults(config: CasConfig): boolean {
  if (!own(config, "tracked")) config.tracked = [];
  const tracked = config.tracked;
  const ignored = new Set((own(config, "ignore_defaults") ? config.ignore_defaults : []) as string[]);
  let changed = false;
  for (const d of defaultTracked()) {
    if (!tracked.includes(d) && !ignored.has(d) && isFile(d)) {
      tracked.push(d);
      changed = true;
    }
  }
  return changed;
}

function noDefaultTrack(): boolean {
  return process.env.CLAUDE_CAS_NO_DEFAULT_TRACK === "1";
}

/** config.json + DEFAULT_TRACKED 병합(ignore_defaults 제외). 바뀌면 락 안에서 다시 읽어 병합해 저장한다. */
export async function loadConfig(p: StorePaths): Promise<CasConfig> {
  let config = loadJson(p.config, { version: 1, tracked: [] }) as CasConfig;
  if (noDefaultTrack()) return config;
  if (mergeDefaults(config) && isDir(p.store)) {
    const h = await configLock(p.store);
    try {
      config = loadJson(p.config, { version: 1, tracked: [] }) as CasConfig;
      if (mergeDefaults(config)) saveJson(p.config, config);
    } finally {
      h.release();
    }
  }
  return config;
}

/** loadConfig 와 같은 병합 결과를 저장 없이 돌려준다(락을 잡을 수 없는 동기 호출부용: watcher.writeState). */
export function loadConfigMerged(p: StorePaths): CasConfig {
  const config = loadJson(p.config, { version: 1, tracked: [] }) as CasConfig;
  if (!noDefaultTrack()) mergeDefaults(config);
  return config;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
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

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function hashBytes(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

export function objectPath(p: StorePaths, h: string): string {
  return pjoin(p.objects, h.slice(0, 2), h.slice(2));
}

export function writeObject(p: StorePaths, content: Uint8Array): string {
  const h = hashBytes(content);
  const dst = objectPath(p, h);
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(dirname(dst), { recursive: true });
    const tmp = `${dst}.${process.pid}.tmp`;   // 중단되면 해시 이름의 잘린 blob 이 남고 exists 검사로 다시 안 쓰인다
    fs.writeFileSync(tmp, zlib.deflateSync(content, { level: 9 }));
    fs.renameSync(tmp, dst);
  }
  return h;
}

export function readObject(p: StorePaths, h: string): Buffer {
  return zlib.inflateSync(fs.readFileSync(objectPath(p, h)));
}

// ----- 의미 변경 판정 -----
// .claude.json 은 설정과 기계 상태(캐시·카운터·타임스탬프)가 한 파일에 섞여 있어 바이트 비교로는 매 세션이
// 리비전이 된다(2026-09 실측: 리비전 434개 중 실변경 10개). 파일별 무시 키 프로필로 판정과 기본 diff 표시에서만
// 그 키들을 뺀다. blob 은 원문 그대로 저장·복원되고 diff --raw 는 전부 보여준다.
// 규칙: 점 구분 경로, 세그먼트별 glob, 매칭된 경로의 하위 전체. 기본 규칙은 실제 스냅샷에서 관측된 키만 담았다.
export const DEFAULT_IGNORE_KEYS: Readonly<Record<string, readonly string[]>> = {
  ".claude.json": [
    "cached*", "*Cache", "*CacheSlots", "*Count", "*At", "last*", "hasSeen*", "*Migration*",
    "numStartups", "migrationVersion", "tipsHistory", "tipLifetimeShownCounts", "pluginUsage",
    "skillUsage", "replBridgePlaceholders", "changelogLastFetched", "closedIssuesLastChecked",
    "announcementImpressions", "feedbackSurveyState", "seenNotifications", "fleetViewPeakConcurrent",
    "githubRepoPaths", "rcLongTurnNudgeSeenKey", "oauthAccount.profileFetchedAt",
    "projects.*.last*", "projects.*.projectOnboardingSeenCount", "projects.*.hasCompletedProjectOnboarding",
    "projects.*.hasUnseenTeamArtifacts", "projects.*.loggedAuthoredArtifactPaths",
  ],
  "settings.json": ["feedbackDrafts"],
  "claude_desktop_config.json": ["preferences.sidebarMode", "preferences.epitaxyPrefs"],
};
// 새 프로젝트 폴더에서 Claude Code 를 처음 열면 생기는, 값이 전부 기본값인 projects 항목의 등장·소멸.
export const PROJECT_DEFAULTS: Readonly<Record<string, unknown>> = {
  allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [],
  disabledMcpjsonServers: [], disabledMcpServers: [], hasTrustDialogAccepted: false,
  hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
};

/**
 * path 의 무시 프로필(null = 원문 해시 판정). config.ignore_keys 는 basename/절대경로 키로 기본 규칙에
 * 더해진다. '!경로' 는 규칙에 걸려도 그 경로(와 하위)를 남기는 예외 - '!last*' 는 기본 규칙 하나를 끄고
 * '!lastCost' 는 키 하나만 살린다. fp 는 판정 지문(sig 캐시 키) - 바뀌면 sig 를 다시 계산한다.
 */
export function ignoreProfile(config: Partial<CasConfig>, path: string): IgnoreProfile | null {
  const name = basename(path);
  const user = (pyTruthy(config.ignore_keys) ? config.ignore_keys : {}) as Record<string, string[]>;
  const rules: string[] = [...(DEFAULT_IGNORE_KEYS[name] ?? [])];
  const keep: string[] = [];
  for (const r of [...(own(user, name) ? user[name] : []), ...(own(user, path) ? user[path] : [])]) {
    (r.startsWith("!") ? keep : rules).push(r.replace(/^!+/, ""));
  }
  const emptyProjects = name === ".claude.json" && (own(config, "ignore_empty_projects") ? pyTruthy(config.ignore_empty_projects) : true);
  if (!rules.length && !emptyProjects) return null;
  const uniqSorted = (xs: string[]) => [...new Set(xs)].sort(compareCodePoints);
  const fp = hashBytes(Buffer.from(pyDumpsEx([uniqSorted(rules), uniqSorted(keep), emptyProjects ? PROJECT_DEFAULTS : false], { sortKeys: true }))).slice(0, 16);
  return { rules: rules.map((r) => r.split(".")), keep: keep.map((r) => r.split(".")), empty_projects: emptyProjects, fp };
}

const fnCache = new Map<string, RegExp>();

/** fnmatch.fnmatchcase(name, pat). */
export function fnmatchcase(name: string, pat: string): boolean {
  let re = fnCache.get(pat);
  if (!re) {
    re = new RegExp(`^(?:${translateGlob(pat)})$`, "su");
    fnCache.set(pat, re);
  }
  return re.test(name);
}

const reEscape = (c: string) => c.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

/** fnmatch.translate 의 패턴 본문. */
function translateGlob(pat: string): string {
  const chars = [...pat];
  const n = chars.length;
  let i = 0;
  let res = "";
  while (i < n) {
    const c = chars[i++];
    if (c === "*") {
      while (i < n && chars[i] === "*") i++;
      res += ".*";
    } else if (c === "?") {
      res += ".";
    } else if (c === "[") {
      let j = i;
      if (j < n && chars[j] === "!") j++;
      if (j < n && chars[j] === "]") j++;
      while (j < n && chars[j] !== "]") j++;
      if (j >= n) {
        res += "\\[";
      } else {
        let stuff = chars.slice(i, j);
        let neg = false;
        if (stuff[0] === "!") {
          neg = true;
          stuff = stuff.slice(1);
        }
        const body = stuff.map((ch, k) => (ch === "-" && k > 0 && k < stuff.length - 1 ? "-" : reEscape(ch))).join("");
        if (!stuff.length && !neg) res += "(?!)";
        else if (!stuff.length && neg) res += ".";
        else res += `[${neg ? "^" : ""}${body}]`;
        i = j + 1;
      }
    } else {
      res += reEscape(c);
    }
  }
  return res;
}

function ruleHits(segs: string[], rules: string[][]): boolean {
  return rules.some((r) => r.length <= segs.length && r.every((pat, i) => fnmatchcase(segs[i], pat)));
}

/** segs 아래 어딘가를 살리는 예외가 있으면 통째로 지우지 말고 내려가야 한다. */
function keepBelow(segs: string[], keep: string[][]): boolean {
  return keep.some((r) => r.length > segs.length && segs.every((s, i) => fnmatchcase(s, r[i])));
}

/** Python _strip. rules 에 걸린 키를 뺀 새 객체. dict 만 내려가고 list 는 그대로 둔다. */
export function stripKeys(obj: unknown, rules: string[][], keep: string[][], prefix: string[] = []): unknown {
  if (!isDict(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const kp = [...prefix, k];
    if (ruleHits(kp, rules) && !ruleHits(kp, keep) && !keepBelow(kp, keep)) continue;
    setKey(out, k, stripKeys(v, rules, keep, kp));
  }
  return out;
}

function setKey(o: Record<string, unknown>, k: string, v: unknown): void {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}

function isDefaultProject(v: unknown): boolean {
  if (!isDict(v)) return false;
  return Object.entries(v).every(([k, x]) => own(PROJECT_DEFAULTS, k) && pyEq(PROJECT_DEFAULTS[k], x));
}

function strictDecodeSig(data: Uint8Array): string {
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new UnicodeDecodeError("'utf-8' codec can't decode bytes: invalid utf-8");
  }
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 무시 경로를 뺀 파싱 결과. JSON 이 아니면 null. 숫자는 Python float 표기를 지키려고 PyFloat 로 남긴다. */
export function significant(data: Uint8Array, profile: IgnoreProfile): unknown {
  let obj: unknown;
  try {
    obj = pyLoads(strictDecodeSig(data), { floats: true });
  } catch (e) {
    if (isValueError(e)) return null;
    throw e;
  }
  obj = stripKeys(obj, profile.rules, profile.keep);
  if (profile.empty_projects && isDict(obj) && isDict(obj.projects)) {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj.projects)) if (!isDefaultProject(v)) setKey(kept, k, v);
    obj.projects = kept;
  }
  return obj;
}

export function sigOf(data: Uint8Array, profile: IgnoreProfile): string {
  const obj = significant(data, profile);
  if (obj === null) return "raw:" + hashBytes(data);
  return "json:" + hashBytes(Buffer.from(pyDumpsEx(obj, { sortKeys: true, separators: [",", ":"], ensureAscii: false }), "utf8"));
}

/** 두 JSON 값 사이에 값이 다른 리프 경로 집합(경로는 키 배열). */
function changedPaths(a: unknown, b: unknown, prefix: string[] = [], out: Map<string, string[]> = new Map()): Map<string, string[]> {
  if (isDict(a) && isDict(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (own(a, k) && own(b, k)) changedPaths(a[k], b[k], [...prefix, k], out);
      else {
        const p = [...prefix, k];
        out.set(JSON.stringify(p), p);
      }
    }
    return out;
  }
  if (!pyEq(a, b)) out.set(JSON.stringify(prefix), prefix);
  return out;
}

/** 원문 두 내용 사이에서 무시 규칙에 걸려 diff 본문에 안 나온 변경의 요약(최상위 키별 개수). 없으면 ''. */
function ignoredSummary(a: Uint8Array, b: Uint8Array, profile: IgnoreProfile): string {
  let ra: unknown, rb: unknown;
  try {
    ra = pyLoads(strictDecodeSig(a), { floats: true });
    rb = pyLoads(strictDecodeSig(b), { floats: true });
  } catch (e) {
    if (isValueError(e)) return "";
    throw e;
  }
  // 걸러진 diff 가 조상 경로에서 이미 보여주는 변경(빈 프로젝트 항목이 한쪽에서만 빠져 깊이가 달라지는 경우)은
  // 숨은 것이 아니다 - 걸러진 변경 경로를 접두로 갖지 않는 원문 변경 경로만 센다.
  const shown = [...changedPaths(significant(a, profile), significant(b, profile)).values()];
  const hidden = [...changedPaths(ra, rb).values()].filter((pth) => !shown.some((s) => s.length <= pth.length && s.every((x, i) => pth[i] === x)));
  const counts = new Map<string, number>();
  for (const pth of hidden) {
    const top = pth.length ? pth[0] : "<root>";
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((x, y) => y[1] - x[1] || compareCodePoints(x[0], y[0]));
  const parts = top.slice(0, 6).map(([k, n]) => (n > 1 ? `${k}(${n})` : k));
  if (top.length > 6) parts.push(`(+${top.length - 6})`);
  return parts.join(", ");
}

/** diff 표시용: 무시 경로를 뺀 JSON 을 2칸 들여쓰기로 다시 직렬화(키 순서 보존). JSON 이 아니면 null. */
function filteredText(data: Uint8Array, profile: IgnoreProfile): string | null {
  if (!data.length) return "";
  const obj = significant(data, profile);
  return obj === null ? null : pyDumpsEx(obj, { indent: 2, ensureAscii: false });
}

// sig 캐시: blob 하나의 sig 계산이 20ms 라 타임라인(수백 blob)을 매번 계산하면 클릭이 초 단위로 멈춘다.
interface SigCache {
  sigs: Record<string, Record<string, string>>;
  warmed: string[];
}

function sigCachePath(p: StorePaths): string {
  return pjoin(p.store, "sig-cache.json");
}

/** {"sigs": {fp: {blob hash: sig}}, "warmed": [fp...]}. 깨졌으면 빈 캐시(다시 계산하면 된다). */
export function loadSigCache(p: StorePaths): SigCache {
  let c: Record<string, unknown>;
  try {
    c = loadJson(sigCachePath(p), {}) as Record<string, unknown>;
  } catch (e) {
    if (!isValueError(e)) throw e;
    c = {};
  }
  return { sigs: (pyTruthy(c.sigs) ? c.sigs : {}) as SigCache["sigs"], warmed: (pyTruthy(c.warmed) ? c.warmed : []) as string[] };
}

function saveSigCache(p: StorePaths, cache: SigCache): void {
  saveJson(sigCachePath(p), cache);
}

/** blob h 의 sig(캐시 우선, 없으면 계산해 cache 에 넣는다 - 저장은 호출자 몫). blob 이 없으면 null. */
function blobSig(p: StorePaths, cache: SigCache, profile: IgnoreProfile, h: string): string | null {
  if (!own(cache.sigs, profile.fp)) cache.sigs[profile.fp] = {};
  const bucket = cache.sigs[profile.fp];
  if (!own(bucket, h)) {
    try {
      bucket[h] = sigOf(readObject(p, h), profile);
    } catch (e) {
      if (isOSError(e)) return null;
      throw e;
    }
  }
  return bucket[h];
}

function sigCached(p: StorePaths, profile: IgnoreProfile, h: string, persist: boolean): string | null {
  const cache = loadSigCache(p);
  const known = own(cache.sigs, profile.fp) && own(cache.sigs[profile.fp], h);
  const s = blobSig(p, cache, profile, h);
  if (persist && !known && s !== null) saveSigCache(p, cache);
  return s;
}

function rememberSig(p: StorePaths, profile: IgnoreProfile, h: string, s: string): void {
  const cache = loadSigCache(p);
  if (!own(cache.sigs, profile.fp)) cache.sigs[profile.fp] = {};
  cache.sigs[profile.fp][h] = s;
  saveSigCache(p, cache);
}

/** 스냅샷 blob 의 sig 를 미리 계산해 둔다(watcher 유휴 틱이 조금씩 부른다). 남은 미계산 sig 개수를 돌려준다. */
export function warmSigCache(p: StorePaths, config: CasConfig, budget = 8): number {
  const profiles = new Map<string, IgnoreProfile>();
  for (const path of expandTracked(own(config, "tracked") ? config.tracked : [])) {
    const pr = ignoreProfile(config, path);
    if (pr) profiles.set(path, pr);
  }
  const fps = [...new Set([...profiles.values()].map((pr) => pr.fp))].sort(compareCodePoints);
  const cache = loadSigCache(p);
  if (!fps.length || pyEq(cache.warmed, fps)) return 0;
  const todo = new Map<string, IgnoreProfile>();
  for (const sid of snapshotIds(p)) {
    const m = manifest(p, sid);
    const entries = (own(m, "entries") ? m.entries : {}) as Record<string, Record<string, unknown> | null>;
    for (const [path, pr] of profiles) {
      const h = (own(entries, path) && entries[path] ? entries[path] : {})!.hash as string | undefined;
      if (h && !(own(cache.sigs, pr.fp) && own(cache.sigs[pr.fp], h))) todo.set(h, pr);
    }
  }
  for (const [h, pr] of [...todo.entries()].slice(0, budget)) blobSig(p, cache, pr, h);
  const kept: SigCache["sigs"] = {};
  for (const [fp, v] of Object.entries(cache.sigs)) if (fps.includes(fp)) kept[fp] = v;
  cache.sigs = kept;
  if (todo.size <= budget) cache.warmed = fps;
  saveSigCache(p, cache);
  return Math.max(0, todo.size - budget);
}

// ----- 추적 경로 전개 -----

/** ntpath.expandvars(Windows: %VAR%, $VAR, ${VAR}, 작은따옴표 안은 그대로). posix 는 $VAR, ${VAR}. */
export function expandvars(path: string): string {
  if (!path.includes("$") && !(process.platform === "win32" && path.includes("%"))) return path;
  const env = process.env;
  const get = (k: string) => (process.platform === "win32" ? env[k] : own(env, k) ? env[k] : undefined);
  if (process.platform !== "win32") {
    return path.replace(/\$(\w+|\{[^}]*\})/g, (m, v: string) => {
      const name = v.startsWith("{") ? v.slice(1, -1) : v;
      const val = get(name);
      return val === undefined ? m : val;
    });
  }
  const varchars = /[A-Za-z0-9_-]/;
  let res = "";
  let index = 0;
  let p = path;
  let n = p.length;
  while (index < n) {
    const c = p[index];
    if (c === "'") {
      p = p.slice(index + 1);
      n = p.length;
      const k = p.indexOf(c);
      if (k >= 0) {
        index = k;
        res += c + p.slice(0, index + 1);
      } else {
        res += c + p;
        index = n - 1;
      }
    } else if (c === "%") {
      if (p.slice(index + 1, index + 2) === "%") {
        res += c;
        index += 1;
      } else {
        p = p.slice(index + 1);
        n = p.length;
        const k = p.indexOf("%");
        if (k < 0) {
          res += "%" + p;
          index = n - 1;
        } else {
          index = k;
          const v = p.slice(0, index);
          const val = get(v);
          res += val === undefined ? "%" + v + "%" : val;
        }
      }
    } else if (c === "$") {
      if (p.slice(index + 1, index + 2) === "$") {
        res += c;
        index += 1;
      } else if (p.slice(index + 1, index + 2) === "{") {
        p = p.slice(index + 2);
        n = p.length;
        const k = p.indexOf("}");
        if (k < 0) {
          res += "${" + p;
          index = n - 1;
        } else {
          index = k;
          const v = p.slice(0, index);
          const val = get(v);
          res += val === undefined ? "${" + v + "}" : val;
        }
      } else {
        let v = "";
        index += 1;
        let ch = p.slice(index, index + 1);
        while (ch && varchars.test(ch)) {
          v += ch;
          index += 1;
          ch = p.slice(index, index + 1);
        }
        const val = get(v);
        res += val === undefined ? "$" + v : val;
        if (ch) index -= 1;
      }
    } else {
      res += c;
    }
    index += 1;
  }
  return res;
}

function listdir(d: string, dironly: boolean): string[] {
  try {
    const out: string[] = [];
    for (const e of fs.readdirSync(d || ".", { withFileTypes: true })) {
      if (!dironly) out.push(e.name);
      else if (e.isDirectory() || (e.isSymbolicLink() && isDir(pjoin(d || ".", e.name)))) out.push(e.name);
    }
    return out;
  } catch {
    return [];
  }
}

function fnfilter(names: string[], pat: string): string[] {
  const np = normcase(pat);
  return names.filter((n) => fnmatchcase(normcase(n), np));
}

function glob1(d: string, pat: string, dironly: boolean): string[] {
  let names = listdir(d, dironly);
  if (!pat.startsWith(".")) names = names.filter((x) => !x.startsWith("."));
  return fnfilter(names, pat);
}

function glob0(d: string, base: string, dironly: boolean): string[] {
  if (base) {
    if (lexists(pjoin(d, base)) && (!dironly || isDir(pjoin(d, base)))) return [base];
  } else if (isDir(d)) return [base];
  return [];
}

function rlistdir(d: string, dironly: boolean): string[] {
  const out: string[] = [];
  for (const x of listdir(d, dironly)) {
    if (x.startsWith(".")) continue;
    out.push(x);
    const sub = d ? pjoin(d, x) : x;
    for (const y of rlistdir(sub, dironly)) out.push(pjoin(x, y));
  }
  return out;
}

function glob2(d: string, _pat: string, dironly: boolean): string[] {
  return ["", ...rlistdir(d, dironly)];
}

function iglob(pathname: string, recursive: boolean, dironly: boolean): string[] {
  const [dname, base] = psplit(pathname);
  if (!hasGlob(pathname)) {
    if (base) return lexists(pathname) ? [pathname] : [];
    return isDir(dname) ? [pathname] : [];
  }
  if (!dname) return recursive && base === "**" ? glob2("", base, dironly) : glob1("", base, dironly);
  const dirs = dname !== pathname && hasGlob(dname) ? iglob(dname, recursive, true) : [dname];
  const inDir = hasGlob(base) ? (recursive && base === "**" ? glob2 : glob1) : glob0;
  const out: string[] = [];
  for (const d of dirs) for (const name of inDir(d, base, dironly)) out.push(pjoin(d, name));
  return out;
}

/** glob.glob(pat, recursive=True). Windows 에서 대소문자를 무시하고, 점으로 시작하는 이름은 패턴이 점으로 시작할 때만 맞는다. */
export function pyGlob(pat: string): string[] {
  const r = iglob(pat, true, false);
  if (!pat || pat.slice(0, 2) === "**") {
    if (r.length && r[0] === "") r.shift();
  }
  return r;
}

function walkFiles(root: string, out: Set<string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = pjoin(root, e.name);
    const dir = e.isDirectory() || (e.isSymbolicLink() && isDir(full));
    if (!dir) out.add(abspath(full));
    else if (e.isDirectory()) walkFiles(full, out);
  }
}

/** config.tracked 항목(파일/디렉토리/glob)을 실제 파일 절대경로 집합으로 전개. */
export function expandTracked(tracked: string[]): Set<string> {
  const files = new Set<string>();
  for (const entry of tracked) {
    const pat = expanduser(expandvars(entry));
    if (hasGlob(pat)) {
      for (const m of pyGlob(pat)) if (isFile(m)) files.add(abspath(m));
    } else if (isDir(pat)) {
      walkFiles(pat, files);
    } else if (isFile(pat)) {
      files.add(abspath(pat));
    }
  }
  return files;
}

/**
 * 단일 파일 tracked 항목을 expandTracked 와 '동일하게' 정규화.
 * status 버킷(new/unchanged/...)에 담기는 문자열과 byte-identical 하게 맞춰,
 * UI 가 defaults 로 전역/프로젝트 행을 정확히 매칭하게 한다(경로 구분자/~/env 정규화).
 */
export function normEntry(entry: string): string {
  return abspath(expanduser(expandvars(entry)));
}

function fileStat(path: string): { size: number; mtime_ns: bigint; mode: number } {
  const st = fs.lstatSync(path, { bigint: true });
  return { size: Number(st.size), mtime_ns: st.mtimeNs, mode: Number(st.mode) };
}

/** 추적 경로를 스캔해 변경을 분류. rehash=true 면 객체와 sig-cache 를 쓴다. false 면 읽기만 한다. */
export function scan(p: StorePaths, config: CasConfig, index: CasIndex, rehash = true): [ScanResult, CasIndex] {
  const current = expandTracked(own(config, "tracked") ? config.tracked : []);
  const result: ScanResult = { new: [], modified: [], deleted: [], unchanged: [] };
  const newIndex: CasIndex = {};
  for (const path of [...current].sort(compareCodePoints)) {
    let stt: ReturnType<typeof fileStat>;
    try {
      stt = fileStat(path);
    } catch (e) {
      if (isOSError(e)) continue;
      throw e;
    }
    const prev = own(index, path) ? index[path] : undefined;
    if (prev === undefined || prev === null) {
      let h: string | null = null;
      if (rehash) {
        try {
          h = writeObject(p, fs.readFileSync(path));
        } catch (e) {
          if (isOSError(e)) continue;        // 다른 프로세스가 쓰는 중이면 다음 스캔에서 다시 본다
          throw e;
        }
      }
      newIndex[path] = { ...stt, hash: h };
      result.new.push(path);
      continue;
    }
    if (pyEq(prev.size, stt.size) && pyEq(prev.mtime_ns, stt.mtime_ns)) {
      newIndex[path] = prev;
      result.unchanged.push(path);
      continue;
    }
    // 한 번 읽은 내용으로 해시와 blob 을 함께 만든다 - 두 번 따로 읽으면 그 사이 파일이
    // 또 바뀌었을 때 index 의 해시가 가리키는 blob 이 존재하지 않게 된다(복원 불가).
    let data: Buffer;
    try {
      data = fs.readFileSync(path);
    } catch (e) {
      if (!isOSError(e)) throw e;
      newIndex[path] = prev;
      result.unchanged.push(path);
      continue;
    }
    const h = hashBytes(data);
    if (h === prev.hash) {
      newIndex[path] = { ...stt, hash: h };
      result.unchanged.push(path);
      continue;
    }
    const profile = ignoreProfile(config, path);
    const curSig = profile ? sigOf(data, profile) : null;
    if (profile && prev.hash && curSig === sigCached(p, profile, prev.hash, rehash)) {
      // 무시 키만 바뀜: 새 blob 없이 stat 만 따라간다(index 가 저장되면 다음 스캔은 fast-path)
      newIndex[path] = { ...stt, hash: prev.hash };
      result.unchanged.push(path);
      continue;
    }
    if (rehash) {
      writeObject(p, data);
      if (profile) rememberSig(p, profile, h, curSig!);
    }
    newIndex[path] = { ...stt, hash: h };
    result.modified.push(path);
  }
  for (const path of Object.keys(index)) if (!current.has(path)) result.deleted.push(path);
  return [result, newIndex];
}

// ----- 스냅샷 락 -----
// 스냅샷은 index.json 을 read-modify-write 하고 parent 를 snaps[-1] 로 고른다. 편집(config_edit)과
// watcher 가 이걸 동시에 도는 건 예외가 아니라 정상 흐름이다 - 편집 -> 파일 변경 -> watcher 감지가
// 항상 겹친다. os.replace 는 쓰기만 원자적이라 시퀀스 전체는 못 막고, 두 프로세스가 같은 parent 를
// 읽으면 이력 체인이 갈라진다. 파일 내용은 content-addressed 라 안전하지만 이력이 어긋나는 건
// 이 도구가 파는 것 자체가 깨지는 일이다.
// 대기 상한은 짧아야 한다 - config_edit.snapshot_before 는 cas 를 in-process 로 부르고 모든 예외를
// 삼키므로, 오래 기다리면 편집이 그만큼 늦어진 뒤 스냅샷이 조용히 생략된 채 편집만 진행된다.
export const LOCK_STALE_SEC = LIB_LOCK_STALE_SEC;

/** Python _snapshot_lock 에 들어간 상태. <store>/snapshot.lock, 대기 lockWaitSec(), stale 60초. 재진입 불가. */
export async function acquireSnapshotLock(p: StorePaths): Promise<LockHandle> {
  fs.mkdirSync(p.store, { recursive: true });          // init 전에도 잠글 수 있어야 한다
  return fileLock(pjoin(p.store, "snapshot.lock"), lockWaitSec(), LOCK_STALE_SEC, "Another snapshot is in progress");
}

export async function withSnapshotLock<T>(p: StorePaths, fn: () => T | Promise<T>): Promise<T> {
  const h = await acquireSnapshotLock(p);
  try {
    return await fn();
  } finally {
    h.release();
  }
}

/** Python _take_snapshot: 스냅샷 락을 잡고 takeSnapshotLocked. 변경이 없으면 [null, result]. */
export async function takeSnapshot(p: StorePaths, message: string, force = false): Promise<[string | null, ScanResult]> {
  return withSnapshotLock(p, () => takeSnapshotLocked(p, message, force));
}

/** Python _take_snapshot_locked: 호출자가 스냅샷 락을 쥐고 있어야 한다. */
export async function takeSnapshotLocked(p: StorePaths, message: string, force = false): Promise<[string | null, ScanResult]> {
  const config = await loadConfig(p);
  const index = loadIndex(p);
  const [result, newIndex] = scan(p, config, index, true);
  const changed = result.new.length + result.modified.length + result.deleted.length;
  if (changed === 0 && !force) {
    if (!pyEq(newIndex, index)) saveJson(p.index, newIndex);   // 무시 키만 바뀐 파일의 stat 을 따라가 다음 스캔은 fast-path
    return [null, result];
  }
  const snaps = isDir(p.snapshots) ? fs.readdirSync(p.snapshots).sort(compareCodePoints) : [];
  const parent = snaps.length ? snaps[snaps.length - 1] : null;
  const now = pyNow();
  const ts = stamp(now, true);
  const entries: Record<string, { hash: string | null; size: number }> = {};
  for (const [path, e] of Object.entries(newIndex)) entries[path] = { hash: e.hash ?? null, size: e.size };
  const m = {
    time: isoLocal(now),
    message: message || "",
    parent,
    changes: { new: result.new, modified: result.modified, deleted: result.deleted },
    entries,
  };
  saveJson(pjoin(p.snapshots, ts + ".json"), m);
  saveJson(p.index, newIndex);
  return [ts, result];
}

/**
 * 변경은 없는데 stat 만 바뀐 파일(무시 키만 저장된 경우)의 index 를 락 안에서 따라가게 한다.
 * 락을 잡고 다시 봤을 때 진짜 변경이 있으면 손대지 않는다 - 다음 틱이 제 메시지로 스냅샷한다.
 */
export async function refreshIndex(p: StorePaths): Promise<void> {
  await withSnapshotLock(p, async () => {
    const config = await loadConfig(p);
    const index = loadIndex(p);
    const [result, newIndex] = scan(p, config, index, false);
    if (!(result.new.length || result.modified.length || result.deleted.length) && !pyEq(newIndex, index)) saveJson(p.index, newIndex);
  });
}

// ----- 스냅샷 조회 -----

export function snapshotIds(p: StorePaths): string[] {
  if (!isDir(p.snapshots)) return [];
  return fs.readdirSync(p.snapshots).sort(compareCodePoints).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
}

export function manifest(p: StorePaths, sid: string): Record<string, unknown> {
  return loadJson(pjoin(p.snapshots, sid + ".json"), {}) as Record<string, unknown>;
}

function entryOf(m: Record<string, unknown>, target: string): Record<string, unknown> | null {
  const entries = (own(m, "entries") ? m.entries : {}) as Record<string, unknown>;
  const e = own(entries, target) ? entries[target] : undefined;
  return e === undefined ? null : (e as Record<string, unknown>);
}

function hashInSnapshot(p: StorePaths, sid: string, target: string): string | null {
  const e = entryOf(manifest(p, sid), target);
  return pyTruthy(e) ? ((e!.hash ?? null) as string | null) : null;
}

/** ref: 'work'/null -> 현재 파일, 'empty' -> 빈 내용, 그 외 -> 스냅샷 id 의 blob. */
function contentAt(p: StorePaths, ref: string | null, target: string): Buffer | null {
  if (ref === null || ref === "work" || ref === "WORK") return fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (ref === "empty") return Buffer.alloc(0);   // 직전 리비전이 없는 첫 리비전과의 비교용 - 전체가 추가로 표시된다
  const h = hashInSnapshot(p, ref, target);
  if (!h) return null;
  try {
    return readObject(p, h);
  } catch {
    return null;
  }
}

/** Python str.splitlines(). */
export function splitlines(t: string): string[] {
  const out: string[] = [];
  const re = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
  let last = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    out.push(t.slice(last, m.index));
    last = m.index + m[0].length;
  }
  if (last < t.length) out.push(t.slice(last));
  return out;
}

/**
 * diff 비교용 줄 목록: 개행 방식(CRLF/LF/CR)과 선두 BOM 을 정규화한다.
 * keepends 로 비교하면 저장 주체가 바뀔 때 EOL 이 뒤집힌 파일이 전량 삭제+추가로
 * 보인다(내용은 그대로인데). blob 은 원본 바이트 그대로 두고 표기만 불감으로.
 */
export function diffLines(b: Uint8Array): string[] {
  const t = Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8");
  return splitlines(t.replace(/^﻿+/, ""));
}

// ----- difflib.unified_diff -----

type Opcode = [tag: "replace" | "delete" | "insert" | "equal", i1: number, i2: number, j1: number, j2: number];

/** difflib.SequenceMatcher(None, a, b) 의 매칭(autojunk 포함). 줄 목록 전용. */
class SequenceMatcher {
  private b2j = new Map<string, number[]>();
  constructor(private a: string[], private b: string[]) {
    b.forEach((elt, i) => {
      const xs = this.b2j.get(elt);
      if (xs) xs.push(i);
      else this.b2j.set(elt, [i]);
    });
    const n = b.length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of [...this.b2j]) if (idxs.length > ntest) this.b2j.delete(elt);
    }
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    const { a, b, b2j } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // bjunk 는 비어 있으므로 Python 의 "not isbjunk" 확장만 남는다(popular 원소 위로 일치를 넓힌다).
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  private matchingBlocks(): [number, number, number][] {
    const la = this.a.length, lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: [number, number, number][] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let i1 = 0, j1 = 0, k1 = 0;
    const out: [number, number, number][] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) out.push([i1, j1, k1]);
        i1 = i2; j1 = j2; k1 = k2;
      }
    }
    if (k1) out.push([i1, j1, k1]);
    out.push([la, lb, 0]);
    return out;
  }

  opcodes(): Opcode[] {
    let i = 0, j = 0;
    const out: Opcode[] = [];
    for (const [ai, bj, size] of this.matchingBlocks()) {
      const tag = i < ai && j < bj ? "replace" : i < ai ? "delete" : j < bj ? "insert" : "";
      if (tag) out.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) out.push(["equal", ai, i, bj, j]);
    }
    return out;
  }

  groupedOpcodes(n = 3): Opcode[][] {
    let codes = this.opcodes();
    if (!codes.length) codes = [["equal", 0, 1, 0, 1]];
    if (codes[0][0] === "equal") {
      const [t, i1, i2, j1, j2] = codes[0];
      codes[0] = [t, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
    }
    const last = codes.length - 1;
    if (codes[last][0] === "equal") {
      const [t, i1, i2, j1, j2] = codes[last];
      codes[last] = [t, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
    }
    const nn = n + n;
    const groups: Opcode[][] = [];
    let group: Opcode[] = [];
    for (const code of codes) {
      let [tag, i1, i2, j1, j2] = code;
      if (tag === "equal" && i2 - i1 > nn) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        groups.push(group);
        group = [];
        i1 = Math.max(i1, i2 - n);
        j1 = Math.max(j1, j2 - n);
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length && !(group.length === 1 && group[0][0] === "equal")) groups.push(group);
    return groups;
  }
}

function formatRangeUnified(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return `${beginning}`;
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

/** difflib.unified_diff(a, b, fromfile, tofile, n, lineterm) 의 줄 목록. */
export function unifiedDiff(a: string[], b: string[], fromfile = "", tofile = "", n = 3, lineterm = "\n"): string[] {
  const out: string[] = [];
  let started = false;
  for (const group of new SequenceMatcher(a, b).groupedOpcodes(n)) {
    if (!started) {
      started = true;
      out.push(`--- ${fromfile}${lineterm}`, `+++ ${tofile}${lineterm}`);
    }
    const first = group[0], last = group[group.length - 1];
    out.push(`@@ -${formatRangeUnified(first[1], last[2])} +${formatRangeUnified(first[3], last[4])} @@${lineterm}`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) out.push(" " + line);
        continue;
      }
      if (tag === "replace" || tag === "delete") for (const line of a.slice(i1, i2)) out.push("-" + line);
      if (tag === "replace" || tag === "insert") for (const line of b.slice(j1, j2)) out.push("+" + line);
    }
  }
  return out;
}

// ----- watcher 상태 -----

/**
 * PowerShell round-trip('o') 포맷은 소수부가 7자리라 Python<3.11 fromisoformat 이 못 읽는다.
 * 소수부를 마이크로초(6자리)로 잘라 파싱. (예: .1970395+09:00 -> .197039+09:00)
 * 반환: epoch 밀리초(마이크로초 소수 포함)와 시간대 유무. naive 는 로컬 시각으로 본다.
 */
export function parseIso(s: unknown): { ms: number; aware: boolean } {
  const str = String(s === null || s === undefined ? "None" : s).replace(/(\.\d{6})\d+/, "$1");
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6}))?)?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d{1,6})?)?)?)?$/.exec(str);
  if (!m) {
    const e = new Error(`Invalid isoformat string: '${str}'`);
    e.name = "ValueError";
    throw e;
  }
  const [, Y, Mo, D, h = "0", mi = "0", sec = "0", frac = "", tz] = m;
  const us = frac ? Number(frac.padEnd(6, "0")) : 0;
  if (!tz) return { ms: new Date(+Y, +Mo - 1, +D, +h, +mi, +sec).getTime() + us / 1000, aware: false };
  let off = 0;
  if (tz !== "Z") {
    const t = /^([+-])(\d{2}):?(\d{2})?:?(\d{2})?/.exec(tz)!;
    off = (t[1] === "-" ? -1 : 1) * ((+t[2]) * 3600 + (+(t[3] ?? 0)) * 60 + (+(t[4] ?? 0)));
  }
  return { ms: Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +sec) - off * 1000 + us / 1000, aware: true };
}

/**
 * watcher.ts 가 쓰는 watcher.json(heartbeat) 을 읽어 상주 여부를 판정.
 * heartbeat 가 폴링 간격의 3배 + 5초 안이면 running, 아니면 stale(죽었거나 멈춤).
 * watcher-status 와 status --json(watcher 블록) 공용.
 */
export function watcherState(store: string): Record<string, unknown> {
  const statePath = pjoin(store, "watcher.json");
  if (!fs.existsSync(statePath)) return { running: false, reason: "watcher.json not found (watcher is not running)" };
  let st: unknown;
  try {
    st = readJsonFile(statePath);   // 다른 도구가 BOM 을 붙여도 견디게
  } catch (e) {
    // exists 확인과 open 사이에 watcher 종료가 파일을 지울 수 있고(폴링과 겹침),
    // 깨진 JSON 도 있을 수 있다. 여기서 죽으면 status --json 전체(추적 목록)가 죽는다.
    if (!isOSError(e) && !isValueError(e)) throw e;
    return { running: false, reason: `Failed to read watcher.json: ${pyErrorName(e)}: ${(e as Error).message}` };
  }
  let age: number | null = null;
  let stale = true;
  let err: string | null = null;
  try {
    if (!isDict(st)) throw Object.assign(new Error(`'${Array.isArray(st) ? "list" : typeof st}' object has no attribute 'get'`), { name: "AttributeError" });
    const hb = parseIso(own(st, "heartbeat") ? st.heartbeat : null);
    age = (Date.now() - hb.ms) / 1000;   // tz-aware/naive 모두 epoch 로 맞춰 뺀다
    const deb = own(st, "debounceMs") ? st.debounceMs : 2000;
    if (typeof deb !== "number") throw Object.assign(new Error(`unsupported operand type(s) for /: '${deb === null ? "NoneType" : typeof deb === "string" ? "str" : "dict"}' and 'float'`), { name: "TypeError" });
    const thresh = (deb / 1000.0) * 3 + 5;
    stale = age > thresh;
  } catch (e) {   // 어떤 파싱 이상도 null 대신 원인 보고
    err = `${pyErrorName(e)}: ${(e as Error).message}`;
  }
  const g = (k: string, d: unknown = null) => (isDict(st) && own(st, k) ? st[k] : d);
  return {
    running: !stale, stale, age_sec: age, error: err,
    pid: g("pid"), started: g("started"), heartbeat: g("heartbeat"),
    dirs: g("dirs", []), lastEvent: g("lastEvent", ""),
  };
}

// ----- CLI 서브커맨드 -----

// 프로젝트 .claude 를 추적할 때 자동 감지할 설정 파일(존재하는 것만). 나머지는 파일 경로 직접 add.
const PROJECT_PRESET = ["settings.json", "settings.local.json"];
// 산문 설정: 카드로 만들기엔 안 맞지만 바뀌면 Claude 행동이 바뀌므로 diff/복원 가치가 크다.
// 루트(<root>/CLAUDE.md)와 .claude 양쪽 모두 가능해 PROJECT_PRESET 과 탐색 위치가 다르다.
const PROSE_PRESET = ["CLAUDE.md", "CLAUDE.local.md"];

/** 설정 파일이 있을 '.claude' 폴더 해석: 프로젝트 루트를 주면 <root>/.claude, .claude 를 직접 주면 그 폴더. */
function claudeDirOf(path: string): string {
  const sub = pjoin(path, ".claude");
  return isDir(sub) ? sub : path;
}

/** '.claude' 를 직접 주면 그 부모(프로젝트 루트), 아니면 그대로. */
function projectRootOf(path: string): string {
  const p = path.replace(/[/\\]+$/, "");
  return basename(p) === ".claude" ? dirname(p) : path;
}

/** 디렉토리는 프로젝트 프리셋(존재하는 settings*.json)으로 확장, 파일/글롭은 그대로 반환. */
function expandTrackPath(path: string): string[] {
  if (hasGlob(path)) return [path];                                  // 글롭은 원문 유지(status 시 확장)
  const ap = abspath(expanduser(path));
  if (isDir(ap)) {
    const cdir = claudeDirOf(ap);
    const out = PROJECT_PRESET.map((n) => pjoin(cdir, n)).filter(isFile);
    // CLAUDE.md 는 루트/.claude 어느 쪽에도 올 수 있다(둘이 같은 디렉토리면 중복 제거).
    for (const d of new Set([projectRootOf(ap), cdir])) out.push(...PROSE_PRESET.map((n) => pjoin(d, n)).filter(isFile));
    return out;
  }
  return [ap];                                                        // 파일(미존재도 명시 추적 허용)
}

/** untrack 비교용: 파일 경로는 abspath 로도 확장(track 이 abspath 로 저장). */
function normTargets(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of paths) {
    out.add(t);
    if (!hasGlob(t)) out.add(abspath(expanduser(t)));
  }
  return out;
}

const storeOf = (opts: StoreOpts) => opts.store ?? defaultStore();

/** 평문 출력 서브커맨드(init)는 문서 대신 아무것도 돌려주지 않는다. */
export async function cmdInit(opts: StoreOpts): Promise<void> {
  const store = storeOf(opts);
  const p = storePaths(store);
  for (const d of [p.store, p.objects, p.snapshots, p.log]) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(p.config)) saveJson(p.config, { version: 1, store, tracked: [] });
  if (!fs.existsSync(p.index)) saveJson(p.index, {});
}

async function doTrack(store: string, paths: string[]): Promise<never> {
  const p = storePaths(store);
  return withSnapshotLock(p, async () => {                 // 스냅샷과 같은 config/index 를 고쳐 쓴다
    const added: string[] = [], already: string[] = [], notFound: string[] = [];
    const h = await configLock(p.store);
    try {
      const config = loadJson(p.config, { version: 1, tracked: [] }) as CasConfig;
      for (const path of paths) {
        for (const ap of expandTrackPath(path)) {
          // 아직 없는 경로도 추적을 허용한다(나중에 생길 파일을 미리 걸어 두는 건 의도된 기능이다).
          // 다만 오타도 같은 모양이라 조용히 넣으면 유령 행으로 남는다 - 어느 것이 아직 없는지
          // 호출부에 알려 화면이 말하게 한다. 글롭은 지금 매칭이 0건이어도 정상이므로 이 판정에서 제외한다.
          if (!hasGlob(ap) && !fs.existsSync(ap)) notFound.push(ap);
          if (config.tracked.includes(ap)) already.push(ap);
          else {
            config.tracked.push(ap);
            added.push(ap);
          }
        }
      }
      saveJson(p.config, config);
    } finally {
      h.release();
    }
    emit(true, added.length ? "ok" : "noop", `Added: ${added.length}`, { added, already, not_found: notFound });
  });
}

async function doUntrack(store: string, paths: string[]): Promise<never> {
  const p = storePaths(store);
  return withSnapshotLock(p, async () => {                 // 스냅샷과 같은 config/index 를 고쳐 쓴다
    const targets = normTargets(paths);
    let before: number;
    let config: CasConfig;
    const h = await configLock(p.store);
    try {
      config = loadJson(p.config, { version: 1, tracked: [] }) as CasConfig;
      before = config.tracked.length;
      config.tracked = config.tracked.filter((t) => !targets.has(t));
      // 기본 추적 대상을 명시적으로 뺀 경우, loadConfig 의 자동 병합이 되살리지 않도록 기록.
      const ignored = new Set<string>((own(config, "ignore_defaults") ? config.ignore_defaults : []) as string[]);
      const defaults = defaultTracked();
      for (const t of targets) if (defaults.includes(t)) ignored.add(t);
      if (ignored.size) config.ignore_defaults = [...ignored].sort(compareCodePoints);
      saveJson(p.config, config);
    } finally {
      h.release();
    }
    // index 에서도 제거: status 의 'deleted' 는 index(스냅샷된 파일) 기준이라 tracked 에서 빠져도
    // index 에 남아 있으면 계속 삭제됨 상태로 표시된다. 추적 해제 = index 에서도 완전 제외.
    // 디렉토리 항목(구버전 track 의 raw 저장분)은 index 에 '하위 파일' 경로로 들어 있어
    // 정확 일치로는 안 지워진다 - prefix 매칭으로 하위 경로까지 함께 제거.
    const dirPrefixes = [...targets].filter((t) => !hasGlob(t)).map((t) => t + SEP);
    const index = loadIndex(p);
    let idxRemoved = 0;
    for (const k of Object.keys(index)) {
      const ak = abspath(expanduser(k));
      if (targets.has(k) || targets.has(ak) || dirPrefixes.some((d) => ak.startsWith(d))) {
        delete index[k];
        idxRemoved++;
      }
    }
    if (idxRemoved) saveJson(p.index, index);
    const removed = before - config.tracked.length;
    emit(true, removed || idxRemoved ? "ok" : "noop", `Removed: ${removed} (index: ${idxRemoved})`, { removed, index_removed: idxRemoved });
  });
}

async function doStatus(store: string): Promise<never> {
  const p = storePaths(store);
  const config = await loadConfig(p);
  const index = loadIndex(p);
  const [result] = scan(p, config, index, false);
  const defaults = defaultTracked();
  const ids = snapshotIds(p);
  emit(true, "ok", "Tracking status", {
    ...result,
    // 전역(기본 추적) 대상 분류용. UI 가 전역(editable) vs 프로젝트(view-only) 행 구분에 사용.
    // 버킷 문자열과 동일 정규화(normEntry)로 내보내야 UI 의 정확 매칭이 성립.
    defaults: (own(config, "tracked") ? config.tracked : []).filter((t) => defaults.includes(t)).map(normEntry),
    // UI 폴링이 status 한 번으로 watcher 생존과 새 스냅샷 여부까지 아는 데 쓴다
    // (별도 watcher_status/log 호출 = 폴링마다 프로세스 하나씩 추가라 여기 얹는다).
    watcher: watcherState(store),
    last_snapshot: ids.length ? ids[ids.length - 1] : null,
  });
}

async function doSnapshot(store: string, message: string, force: boolean): Promise<never> {
  const p = storePaths(store);
  let ts: string | null, result: ScanResult;
  try {
    [ts, result] = await takeSnapshot(p, message, force);
  } catch (e) {
    if (!(e instanceof LockTimeoutError)) throw e;
    emit(false, "lock_timeout", "Snapshot skipped: another snapshot is in progress", { detail: e.message });
  }
  if (ts === null) emit(true, "noop", "No changes, snapshot skipped (use --force to take one anyway)", { snapshot: null });
  const counts = { new: result.new.length, modified: result.modified.length, deleted: result.deleted.length };
  emit(true, "ok", `Snapshot ${ts}  (+${counts.new} ~${counts.modified} -${counts.deleted})`, { snapshot: ts, counts });
}

/** 특정 스냅샷의 blob 으로 파일을 복원. 안전장치: 복원 전 스냅샷(되돌릴 지점) + .bak + atomic write. */
async function doRestore(store: string, path: string, sid: string, noSnapshot: boolean, noBackup: boolean): Promise<never> {
  const p = storePaths(store);
  const target = abspath(expanduser(path));
  const blob = contentAt(p, sid, target);
  if (blob === null) emit(false, "not_found", `Snapshot ${sid} has no content for '${target}' (not tracked or deleted)`, { target });
  // 전/후 스냅샷과 파일 쓰기를 한 락 안에서 - 사이가 벌어지면 watcher tick 이 먼저 찍어
  // 복원 결과가 'auto:' 메시지로 기록되고, 리비전에 복원이라는 사실이 남지 않는다.
  let pre: string | null = null, post: string | null = null, bak: string | null = null;
  try {
    const h = noSnapshot ? null : await acquireSnapshotLock(p);
    try {
      if (!noSnapshot) {
        // 되돌릴 지점을 못 만들면 복원을 하지 않는다 - 조용히 진행하면 롤백 불가 상태가 된다.
        [pre] = await takeSnapshotLocked(p, `before restore of ${basename(target)}`);
      }
      if (fs.existsSync(target) && !noBackup) {
        bak = `${target}.${stamp(pyNow())}.bak`;
        fs.writeFileSync(bak, fs.readFileSync(target));
      }
      fs.mkdirSync(dirname(target), { recursive: true });
      const tmp = target + ".restore.tmp";
      fs.writeFileSync(tmp, blob!);
      fs.renameSync(tmp, target);
      // 복원 결과도 즉시 스냅샷: 안 찍으면 다음 편집의 pre-스냅샷이 이 상태를 제 이름 없이
      // 흡수해, 리비전 행의 메시지와 실제 diff 내용이 한 칸 어긋난다(편집 후행 스냅샷과 동일 원칙).
      if (!noSnapshot) [post] = await takeSnapshotLocked(p, `restore: ${basename(target)} <- ${sid}`);
    } finally {
      h?.release();
    }
  } catch (e) {
    if (!(e instanceof LockTimeoutError)) throw e;
    emit(false, "lock_timeout", "Pre-restore snapshot failed", { detail: e.message });
  }
  emit(true, "ok", `Restored: ${basename(target)} <- ${sid}`, { path: target, backup: bak, pre_snapshot: pre, post_snapshot: post, from: sid });
}

/**
 * 파일별 리비전 이력: 내용이 바뀐 스냅샷만 추려 git log 처럼. 무시 프로필이 있는 파일은 해시가 아니라
 * sig 전환으로 행을 만들어, 무시 키만 다른 연속 리비전은 한 행으로 접힌다(이미 쌓인 blob 포함).
 */
async function doHistory(store: string, path: string, indent: number | null): Promise<never> {
  const p = storePaths(store);
  const target = abspath(expanduser(path));   // restore/cat 과 같은 해석
  const profile = ignoreProfile(await loadConfig(p), target);
  const cache = profile ? loadSigCache(p) : null;
  let computed = 0;
  const rows: Record<string, unknown>[] = [];
  let last: string | null = "__init__";
  for (const sid of snapshotIds(p)) {
    const m = manifest(p, sid);
    const e = entryOf(m, target);
    const h = pyTruthy(e) ? ((e!.hash ?? null) as string | null) : null;
    let key = h;
    if (profile && h) {
      if (!(own(cache!.sigs, profile.fp) && own(cache!.sigs[profile.fp], h))) computed++;
      key = blobSig(p, cache!, profile, h) || h;
    }
    if (key !== last) {
      rows.push({
        snapshot: sid, time: own(m, "time") ? m.time : null, message: own(m, "message") ? m.message : "",
        hash: h ? h.slice(0, 12) : null, present: e !== null,
      });
      last = key;
    }
  }
  if (computed) saveSigCache(p, cache!);
  emit(true, "ok", `Revisions: ${rows.length}`, { path: target, revisions: rows, indent });
}

const DIFF_TEXT: Record<string, string> = {
  no_snapshot: "No snapshot yet",
  both_absent: "No content on either side (not tracked or deleted)",
  no_change: "No text changes",
  eol_or_bom_only: "Same line content; only line endings (CRLF/LF) or BOM differ",
  whitespace_only: "Only formatting differs (indentation, whitespace); meaningful content is the same",
};

type DiffRes = [kind: string, frm: string | null, to: string, diff: string, filtered: boolean, hidden: string];

async function diffResult(p: StorePaths, frmArg: string | null, toArg: string | null, raw: boolean, target: string): Promise<DiffRes | null> {
  const ids = snapshotIds(p);
  const frm = frmArg || (ids.length ? ids[ids.length - 1] : null);
  const to = toArg || "work";
  if (frm === null) return ["no_snapshot", frm, to, "", false, ""];
  if (!expandTracked((await loadConfig(p)).tracked ?? []).has(target) &&
      ![frm, to].filter((r) => !["work", "WORK", "empty"].includes(r)).some((r) => hashInSnapshot(p, r, target))) {
    return null;
  }
  let a = contentAt(p, frm, target);
  let b = contentAt(p, to, target);
  if (a === null && b === null) return ["both_absent", frm, to, "", false, ""];
  a = a ?? Buffer.alloc(0);
  b = b ?? Buffer.alloc(0);
  let linesA = diffLines(a), linesB = diffLines(b);
  let hidden = "";
  let filtered = false;
  const profile = raw ? null : ignoreProfile(await loadConfig(p), target);
  if (profile) {
    const fa = filteredText(a, profile), fb = filteredText(b, profile);
    if (fa !== null && fb !== null) {       // 한쪽이라도 JSON 이 아니면 원문 diff
      hidden = a.length && b.length ? ignoredSummary(a, b, profile) : "";
      if (fa === fb && hidden) return ["ignored_only", frm, to, "", true, hidden];
      linesA = splitlines(fa);
      linesB = splitlines(fb);
      filtered = true;
    }
  }
  const diff = unifiedDiff(linesA, linesB, String(frm), String(to), 3, "").join("\n");
  if (diff) return ["diff", frm, to, diff, filtered, hidden];
  if (a.equals(b)) return ["no_change", frm, to, "", filtered, hidden];
  if (!filtered || pyEq(diffLines(a), diffLines(b))) return ["eol_or_bom_only", frm, to, "", filtered, hidden];
  return ["whitespace_only", frm, to, "", filtered, hidden];
}

async function doDiff(store: string, path: string, frmArg: string | null, toArg: string | null, raw: boolean): Promise<never> {
  const p = storePaths(store);
  const target = abspath(expanduser(path));
  const res = await diffResult(p, frmArg, toArg, raw, target);
  if (res === null) emit(false, "not_tracked", `Not a tracked file: ${target}`, { target });
  const [kind, frm, to, diff, filtered, hidden] = res;
  let text: string;
  if (kind === "ignored_only") text = `Only ignored keys differ: ${hidden}`;
  else if (kind === "diff") text = diff + (hidden ? `\n# Ignored keys also changed: ${hidden}` : "");
  else text = DIFF_TEXT[kind];
  emit(true, "ok", kind !== "diff" ? text : "diff", { path: target, to, kind, diff, filtered, ignored: hidden, from: frm });
}

/** 추적 중인 파일의 현재 내용을 그대로 돌려준다(읽기 전용 뷰어용). 추적 목록 밖 경로는 거부 - 임의 파일 읽기 통로가 되지 않게. */
async function doCat(store: string, path: string): Promise<never> {
  const p = storePaths(store);
  const config = await loadConfig(p);
  const target = abspath(expanduser(path));
  if (!expandTracked(config.tracked ?? []).has(target)) emit(false, "not_tracked", `Not a tracked file: ${target}`, { target });
  let content: string;
  try {
    content = fs.readFileSync(target).toString("utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    emit(false, "not_found", `Tracked, but the file does not exist: ${target}`, { target });
  }
  emit(true, "ok", basename(target), { path: target, content });
}

/** Python format(x, "g"). */
function pyG(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const [mant, e] = x.toExponential(5).split("e");
  const exp = Number(e);
  const strip = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (exp < -4 || exp >= 6) return `${strip(mant)}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  return strip(x.toFixed(5 - exp));
}

/**
 * 보존 기한이 지난 스냅샷 정리 + 미참조 객체 sweep. 가장 최신 스냅샷과 현재 index 가
 * 참조하는 객체는 어떤 경우에도 지우지 않는다(현재 상태의 복원 지점 보장).
 */
async function doGc(store: string, keepDays: number, dryRun: boolean): Promise<never> {
  const p = storePaths(store);
  const cutoff = Date.now() - keepDays * 86400_000;
  let drop: string[] = [], keep: string[] = [], sweep: string[] = [], tmps: string[] = [];
  let freed = 0;
  await withSnapshotLock(p, () => {
    const ids = snapshotIds(p);
    for (const sid of ids) {
      const m = manifest(p, sid);
      try {
        const t = parseIso(own(m, "time") ? m.time : null);
        if (!t.aware && t.ms < cutoff) drop.push(sid);   // 시간대가 붙은 값은 naive 기준과 비교할 수 없어 지우지 않는다
      } catch {
        // 시간을 못 읽는 매니페스트는 지우지 않는다
      }
    }
    if (ids.length && drop.includes(ids[ids.length - 1])) drop = drop.filter((s) => s !== ids[ids.length - 1]);   // 전부 기한을 넘겼어도 최신 하나는 남긴다
    keep = ids.filter((sid) => !drop.includes(sid));
    const marked = new Set<string>();
    for (const e of Object.values(loadIndex(p))) if (e && e.hash) marked.add(e.hash);
    for (const sid of keep) {
      const m = manifest(p, sid);
      for (const e of Object.values((own(m, "entries") ? m.entries : {}) as Record<string, Record<string, unknown>>)) {
        if (e && e.hash) marked.add(e.hash as string);
      }
    }
    const walk = (root: string) => {
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const full = pjoin(root, e.name);
        if (e.isDirectory()) walk(full);
        else if (!marked.has(basename(root) + e.name)) sweep.push(full);
      }
    };
    if (isDir(p.objects)) walk(p.objects);
    for (const f of sweep) {
      try {
        freed += fs.statSync(f).size;
      } catch {
        // OSError 는 건너뛴다
      }
    }
    tmps = isDir(p.snapshots) ? fs.readdirSync(p.snapshots).filter((n) => !n.endsWith(".json")).map((n) => pjoin(p.snapshots, n)) : [];
    if (!dryRun) {
      for (const sid of drop) fs.rmSync(pjoin(p.snapshots, sid + ".json"), { force: true });
      for (const f of [...sweep, ...tmps]) {
        try {
          fs.unlinkSync(f);
        } catch {
          // OSError 는 건너뛴다
        }
      }
      if (isDir(p.objects)) {     // 비게 된 버킷 폴더 정리(비어있지 않으면 무시)
        for (const d of fs.readdirSync(p.objects)) {
          try {
            fs.rmdirSync(pjoin(p.objects, d));
          } catch {
            // 비어 있지 않거나 폴더가 아니다
          }
        }
      }
    }
  });
  const act = dryRun ? "Would clean up" : "Cleaned up";
  const msg = `${act}: snapshots ${drop.length} · objects ${sweep.length} · ${pyFixed(freed / 1048576, 1)} MB (keep ${pyG(keepDays)} days)`;
  emit(true, dryRun ? "dry_run" : "ok", msg, {
    dry_run: dryRun, keep_days: keepDays, removed_snapshots: drop.length, kept_snapshots: keep.length,
    removed_objects: sweep.length, freed_bytes: freed, tmp_removed: tmps.length,
  });
}

function doLog(store: string, limit: number): never {
  const p = storePaths(store);
  if (!isDir(p.snapshots)) emit(true, "ok", "No snapshots");
  // snapshotIds 와 같은 필터: 저장 중단이 남긴 .tmp 등을 스냅샷으로 세지 않는다.
  const names = fs.readdirSync(p.snapshots).sort(compareCodePoints).reverse().filter((n) => n.endsWith(".json"));
  const lines = names.slice(0, Math.max(0, limit)).map((name) => {
    const m = loadJson(pjoin(p.snapshots, name), {}) as Record<string, Record<string, unknown[]> | string>;
    const c = (own(m, "changes") ? m.changes : {}) as Record<string, unknown[]>;
    const len = (k: string) => (own(c, k) ? c[k].length : 0);
    return `${name.slice(0, -5)}  +${len("new")} ~${len("modified")} -${len("deleted")}  ${own(m, "message") ? m.message : ""}`;
  });
  emit(true, "ok", lines.join("\n"));
}

function doShow(store: string, path: string): never {
  const p = storePaths(store);
  const index = loadIndex(p);
  const key = abspath(expanduser(path));
  const e = own(index, key) ? index[key] : null;
  const h = e ? e.hash : null;
  if (!h) emit(true, "ok", "Not in index");
  emit(true, "ok", readObject(p, h).toString("utf8"));
}

export async function cmdTrack(opts: StoreOpts & { paths: string[] }): Promise<CliDoc> {
  return guard(() => doTrack(storeOf(opts), opts.paths), CODES);
}

export async function cmdUntrack(opts: StoreOpts & { paths: string[] }): Promise<CliDoc> {
  return guard(() => doUntrack(storeOf(opts), opts.paths), CODES);
}

export async function cmdStatus(opts: StoreOpts): Promise<CliDoc> {
  return guard(() => doStatus(storeOf(opts)), CODES);
}

export async function cmdSnapshot(opts: StoreOpts & { message?: string; force?: boolean }): Promise<CliDoc> {
  return guard(() => doSnapshot(storeOf(opts), opts.message ?? "", !!opts.force), CODES);
}

export async function cmdHistory(opts: StoreOpts & { path: string }): Promise<CliDoc> {
  return guard(() => doHistory(storeOf(opts), opts.path, null), CODES);
}

/** from/to: 스냅샷 id, "work"(현재 파일), "empty". 생략 시 from=최신 스냅샷, to=work. */
export async function cmdDiff(opts: StoreOpts & { path: string; from?: string; to?: string; raw?: boolean }): Promise<CliDoc> {
  return guard(() => doDiff(storeOf(opts), opts.path, opts.from ?? null, opts.to ?? null, !!opts.raw), CODES);
}

export async function cmdCat(opts: StoreOpts & { path: string }): Promise<CliDoc> {
  return guard(() => doCat(storeOf(opts), opts.path), CODES);
}

export async function cmdGc(opts: StoreOpts & { keepDays?: number; dryRun?: boolean }): Promise<CliDoc> {
  return guard(() => doGc(storeOf(opts), opts.keepDays ?? 90, !!opts.dryRun), CODES);
}

export async function cmdRestore(opts: StoreOpts & { path: string; from: string; noSnapshot?: boolean; noBackup?: boolean }): Promise<CliDoc> {
  return guard(() => doRestore(storeOf(opts), opts.path, opts.from, !!opts.noSnapshot, !!opts.noBackup), CODES);
}

export async function cmdWatcherStatus(opts: StoreOpts): Promise<CliDoc> {
  return guard(() => emit(true, "ok", "Watcher status",watcherState(storeOf(opts))), CODES);
}

/** argv 는 python cas.py 의 인자와 같다. --json 이 없어도 --json 형태의 문서를 돌려준다. */
export async function main(argv: string[]): Promise<CliDoc> {
  return guard(async () => {
    const ap = new JsonArgumentParser("cas");
    ap.addArgument("--store", { default: defaultStore() });
    const sub = ap.addSubparsers({ dest: "cmd", required: true });
    sub.addParser("init");
    sub.addParser("track").addArgument("paths", { nargs: "+" }).addArgument("--json", { action: "store_true" });
    sub.addParser("untrack").addArgument("paths", { nargs: "+" }).addArgument("--json", { action: "store_true" });
    sub.addParser("status").addArgument("--json", { action: "store_true" });
    sub.addParser("snapshot").addArgument("-m", "--message", { default: "" })
      .addArgument("--force", { action: "store_true" }).addArgument("--json", { action: "store_true" });
    sub.addParser("log").addArgument("-n", "--limit", { type: "int", default: 20 });
    sub.addParser("history").addArgument("path").addArgument("--json", { action: "store_true" });
    sub.addParser("diff").addArgument("path").addArgument("--from", { dest: "frm" }).addArgument("--to", { dest: "to" })
      .addArgument("--raw", { action: "store_true" }).addArgument("--json", { action: "store_true" });
    sub.addParser("show").addArgument("path");
    sub.addParser("cat").addArgument("path").addArgument("--json", { action: "store_true" });
    sub.addParser("watcher-status");
    sub.addParser("gc").addArgument("--keep-days", { type: "float", default: 90 })
      .addArgument("--dry-run", { action: "store_true" }).addArgument("--json", { action: "store_true" });
    sub.addParser("restore").addArgument("path").addArgument("--from", { dest: "frm", required: true })
      .addArgument("--no-snapshot", { action: "store_true" }).addArgument("--no-backup", { action: "store_true" });
    const a = ap.parse(argv);
    const store = a.store as string;
    switch (a.cmd) {
      case "init":
        await cmdInit({ store });
        return makeDoc(true, "ok", `Initialized: ${store}`);
      case "track": return doTrack(store, a.paths as string[]);
      case "untrack": return doUntrack(store, a.paths as string[]);
      case "status": return doStatus(store);
      case "snapshot": return doSnapshot(store, a.message as string, a.force as boolean);
      case "log": return doLog(store, a.limit as number);
      case "history": return doHistory(store, a.path as string, a.json ? null : 2);
      case "diff": return doDiff(store, a.path as string, a.frm as string | null, a.to as string | null, a.raw as boolean);
      case "show": return doShow(store, a.path as string);
      case "cat": return doCat(store, a.path as string);
      case "watcher-status": return emit(true, "ok", "Watcher status", watcherState(store));
      case "gc": return doGc(store, a.keep_days as number, a.dry_run as boolean);
      default: return doRestore(store, a.path as string, a.frm as string, a.no_snapshot as boolean, a.no_backup as boolean);
    }
  }, CODES);
}
