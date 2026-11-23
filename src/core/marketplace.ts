// marketplace.ts - .claude-plugin/marketplace.json 카탈로그. src/marketplace.py 이식.
//
// 278개를 미리 받지 않는다: 매니페스트만 sparse checkout(401K) 하고 플러그인은 선택 시점에 받는다
// (전체 체크아웃은 9.7M, 24배).
//
// renames 는 조회 해석 전용이다. key=구 이름, value=신 이름(실측 검증).
// origin 은 항상 현재 이름으로 정규화해 저장하고 별칭을 원장에 남기지 않는다.
//
// 순수 함수 모듈: 네트워크/git/subprocess 를 타지 않는다. remote_fetch/library 를
// import 하지 않는다(lib_store 는 Python 과 같은 JSON 읽기에만, cli_result·plugin_units 는 Python 문자열 도우미에만 쓴다).
// 이미 받아둔 매니페스트 파일 위의 로직만 다룬다.
// (예외 하나: classifySource 는 '존재하는 디렉토리인가'만 확인한다. 로컬 경로 형식을
// 판별하려면 그 질문을 피할 수 없다. 읽기도 쓰기도 하지 않는다.)
import fs from "node:fs";
import path from "node:path";
import { casefold, pyRepr } from "./cli_result.ts";
import { readJsonFile } from "./lib_store.ts";
import { pyStrip } from "./plugin_units.ts";

export { casefold, pyRepr, pyStrip };

export const MANIFEST_REL = path.join(".claude-plugin", "marketplace.json");

// Windows 예약 디바이스 이름(확장자·대소문자 무관). 경로 이탈은 아니지만 그런 이름으로
// 파일/디렉토리를 만들 수 없어 기능적으로 깨진다.
const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

// git 이 url 문자열 자체를 해석한다(인자 배열 격리가 안 통함). 허용 스킴만
// 통과시킨다. scp 스타일(user@host:path)도 정상 git 문법이라 허용한다.
// 정규식의 `[^\n]*` 와 `\n?$` 는 Python re 의 `.` 와 `$`(끝의 줄바꿈 하나 앞에서도 맞는다)를 옮긴 것이다.
const ALLOWED_URL_SCHEMES = ["https://", "http://", "ssh://", "git://", "file://"];
const SCP_STYLE_RE = /^[A-Za-z0-9_.~-]+@[A-Za-z0-9_.-]+:[A-Za-z0-9_./~-][^\n]*\n?$/;
// 전송 헬퍼 구문(예: ext::, foo::). 문자열 맨 앞에서만 위험하다. 부분 문자열로 "::" 를
// 찾으면 IPv6 리터럴 URL(https://[::1]/r.git) 을 오탐하므로 앞에 anchor 한다.
const TRANSPORT_HELPER_RE = /^[A-Za-z0-9+.-]*::/;
const HEX_RE = /^[0-9a-fA-F]+\n?$/;

// 마켓 소스 형식 판별용. Claude Code 의 Add Marketplace 가 받는 4형식 중 이 도구는 git
// 으로 clone 되는 둘(scp/전체 URL)만 받아왔다. 나머지 둘(owner/repo 축약, marketplace.json
// 직접)과 로컬 경로를 여기서 판정한다. 판정만 하고 물질화는 호출부가 한다.
const LOCAL_PREFIXES = ["./", "../", ".\\", "..\\"];
export const DRIVE_ABS_RE = /^[A-Za-z]:[\\/]/;   // os.path.isabs 는 OS 마다 답이 달라 판정이 흔들린다
const JSON_SCHEMES = ["http://", "https://"];    // JSON 본문은 http(s) 로만 받는다
const GENERIC_JSON_STEMS = ["marketplace", "index"];   // 파일명이 이거면 id 로 쓸 정보가 없다
// 축약에 붙는 ref: owner/repo#branch · owner/repo@tag (Claude Code 의 Add Marketplace 와 같은 형식).
// 떼어내지 않으면 '#'/'@' 가 세그먼트 검증을 통과해 URL 뒤에 붙고 clone 단계에서야 깨진다.
const SHORTHAND_REF_RE = /^([^#@]+)[#@]([^\n]+)\n?$/;

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export interface Manifest {
  name: string;
  description: string;
  owner: unknown;
  plugins: unknown[];
  renames: Record<string, string>;
  by_name: Record<string, Record<string, unknown>>;
}

export interface SourceClass {
  kind: "git" | "json" | "local";
  url: string | null;
  path: string | null;
  ref: string | null;
  id: string;
}

export interface SourceSpec {
  kind: "str-path" | "github" | "git-subdir" | "url";
  url: string | null;
  path: string | null;
  ref: string | null;
  sha: string | null;
}

export interface CatalogPage {
  total: number;
  offset: number;
  limit: number;
  categories: Record<string, number>;
  rows: Record<string, unknown>[];
}

// ----- Python 호환 도우미 -----

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** dict.get(k). JSON.parse 결과의 프로토타입 키("constructor" 등)를 값으로 보지 않는다. */
function dget(d: Dict, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : undefined;
}

export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  return "dict";
}

// 오염된 매니페스트에서 Python 판이 AttributeError 로 끝나는 자리를 같은 예외 이름으로 낸다(guard 가 internal 로 바꾼다).
function attributeError(v: unknown, attr: string): Error {
  const e = new Error(`'${pyTypeName(v)}' object has no attribute '${attr}'`);
  e.name = "AttributeError";
  return e;
}

function getOrThrow(d: unknown, k: string): unknown {
  if (!isDict(d)) throw attributeError(d, "get");
  return dget(d, k);
}

function strCasefold(v: unknown): string {
  if (typeof v !== "string") throw attributeError(v, "casefold");
  return casefold(v);
}

function pySlice<T>(a: T[], start: number, stop?: number): T[] {
  const n = a.length;
  const clamp = (i: number) => (i < 0 ? Math.max(0, n + i) : Math.min(i, n));
  const s = clamp(start);
  const e = stop === undefined ? n : clamp(stop);
  return e > s ? a.slice(s, e) : [];
}

function startsWithAny(s: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => s.startsWith(p));
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
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

// 없는 경로는 Python realpath(strict=False) 처럼 lexical 절대경로로 돌려준다.
function realpath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

// open() 이 내는 OSError 의 str() 표기. JSON 파싱 오류 문장은 Python json 과 다르다.
function osErrorText(e: unknown, p: string): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return `[Errno 2] No such file or directory: ${pyRepr(p)}`;
  if (code === "EACCES" || code === "EPERM" || code === "EISDIR") return `[Errno 13] Permission denied: ${pyRepr(p)}`;
  return (e as Error).message;
}

// ----- 매니페스트 -----

/** utf-8-sig 로 읽는다. 읽기·파싱 실패와 plugins 가 list 가 아니면 ManifestError. */
export function parseManifest(manifestPath: string): Manifest {
  let raw: unknown;
  try {
    raw = readJsonFile(manifestPath);
  } catch (e) {
    throw new ManifestError(`Cannot read the manifest: ${osErrorText(e, manifestPath)}`);
  }
  const plugins = getOrThrow(raw, "plugins");
  if (!Array.isArray(plugins)) throw new ManifestError("The manifest has no plugins array");
  const r = raw as Dict;
  const byName: Record<string, Dict> = Object.create(null);
  for (const e of plugins) {
    if (!isDict(e) || !pyTruthy(dget(e, "name"))) continue;
    const name = dget(e, "name");
    try {
      safeSegment(name, "plugin name");
    } catch (err) {
      if (err instanceof ManifestError) continue;   // 이름 자체가 경로 이탈이면 조회 대상에서 제외. 매니페스트 전체는 안 죽인다
      throw err;
    }
    byName[name as string] = e;
  }
  const or = (v: unknown, d: unknown) => (pyTruthy(v) ? v : d);
  return {
    name: or(dget(r, "name"), "") as string,
    description: or(dget(r, "description"), "") as string,
    owner: dget(r, "owner") ?? null,
    plugins,
    renames: or(dget(r, "renames"), {}) as Record<string, string>,
    by_name: byName,
  };
}

/**
 * [entry, 정규 이름]. renames 를 따라가되 순환/미도달은 [null, null].
 *
 * 별칭은 결과에 남기지 않는다. 호출부는 항상 정규 이름으로 origin 을 만든다.
 * canonical 이름은 반환 직전 safeSegment 로 재검증한다: by_name 이 이미 안전한 이름만
 * 담고 있지만(parseManifest), 그 불변식이 깨져도(호출부가 by_name 을 직접 조립하는
 * 테스트/미래 코드) 마지막 방어선이 되도록 한다. plugin-fetch 가 이 반환값으로 바로 경로를 잇기 때문이다.
 * cur 가 문자열이 아니면(예: renames 값이 dict 인 오염된 매니페스트) 즉시 포기한다.
 */
export function resolvePlugin(mf: Manifest, name: string): [Record<string, unknown> | null, string | null] {
  const seen = new Set<string>();
  let cur: unknown = name;
  while (typeof cur === "string" && cur && !seen.has(cur)) {
    const entry = getOrThrow(mf.by_name, cur);
    if (pyTruthy(entry)) {
      try {
        safeSegment(cur, "plugin name");
      } catch (err) {
        if (err instanceof ManifestError) return [null, null];
        throw err;
      }
      return [entry as Dict, cur];
    }
    seen.add(cur);
    cur = getOrThrow(mf.renames, cur);
  }
  return [null, null];
}

export function displayName(entry: Record<string, unknown>): string {
  for (const k of ["displayName", "name"]) {
    const v = dget(entry, k);
    if (pyTruthy(v)) return v as string;
  }
  return "";
}

/**
 * 단일 경로 세그먼트 검증. library 의 항목 해석과 같은 규율:
 * 빈/./.. 금지(트레일링 dot/space 를 벗겨낸 뒤에도), 콜론 금지(드라이브 상대 'C:foo' 와
 * NTFS ADS 'a:b'), 구분자 금지, Windows 예약 디바이스 이름(확장자·대소문자 무관) 금지.
 *
 * 트레일링 dot/space 를 따로 가려내는 이유: os.path.normpath 가 이를 먹어치우므로
 * 이 가드의 판정이 OS 의 실제 해석과 어긋나면 안 된다.
 */
export function safeSegment(s: unknown, what = "name"): string {
  if (typeof s !== "string" || !s || s.includes(":") || s.includes("\\") || s.includes("/")) {
    throw new ManifestError(`Invalid ${what}: ${pyRepr(s)}`);
  }
  const stripped = s.replace(/[ .\t]+$/, "");
  if (stripped === "" || stripped === "." || stripped === "..") {
    throw new ManifestError(`Invalid ${what}: ${pyRepr(s)}`);
  }
  const stem = casefold(stripped.split(".", 1)[0]);
  if (RESERVED_DEVICE_NAMES.has(stem)) throw new ManifestError(`Reserved ${what}: ${pyRepr(s)}`);
  return s;
}

/** 레포 내 상대경로 검증. './' 접두만 벗기고 나머지는 세그먼트별로 safeSegment. */
export function safeRelpath(p: unknown, what = "path"): string {
  if (typeof p !== "string" || !p) throw new ManifestError(`Invalid ${what}: ${pyRepr(p)}`);
  let q = p.replaceAll("\\", "/");
  if (q.startsWith("./")) q = q.slice(2);
  if (q.startsWith("/") || isAbs(p)) throw new ManifestError(`${what} must be a relative path: ${pyRepr(p)}`);
  const parts = q.split("/");
  for (const seg of parts) safeSegment(seg, what);
  return parts.join("/");
}

/**
 * git 이 스스로 해석하는 문자열이라 remote_fetch 가 인자 배열로 넘겨도
 * 주입을 막지 못한다(git 자신이 "ext::" 전송 헬퍼나 "--upload-pack=" 같은 옵션형 값을
 * 해석해 임의 명령을 실행한다. 실측: git fetch 가 --upload-pack=evil 을 받으면
 * "evil" 을 서브프로세스로 실행 시도하는 게 재현됐다). 허용 스킴 allowlist 로 막는다.
 */
function validateSourceUrl(url: unknown, what = "source.url"): string {
  if (typeof url !== "string" || !url) throw new ManifestError(`Invalid ${what}: ${pyRepr(url)}`);
  if (url.startsWith("-")) throw new ManifestError(`${what} starts like an option (injection risk): ${pyRepr(url)}`);
  if (TRANSPORT_HELPER_RE.test(url)) throw new ManifestError(`${what} must not use transport helper syntax (e.g. ext::): ${pyRepr(url)}`);
  if (startsWithAny(url.toLowerCase(), ALLOWED_URL_SCHEMES) || SCP_STYLE_RE.test(url)) return url;
  throw new ManifestError(`${what} scheme is not in the allowed list: ${pyRepr(url)}`);
}

/** 옵션처럼(-로 시작) 시작하는 ref/branch 이름은 git 명령에서 옵션으로 오인된다. */
function validateRef(ref: unknown, what = "ref"): string | null {
  if (ref === null || ref === undefined) return null;
  if (typeof ref !== "string" || !ref || ref.startsWith("-")) throw new ManifestError(`Invalid ${what}: ${pyRepr(ref)}`);
  return ref;
}

function validateSha(sha: unknown, what = "sha"): string | null {
  if (sha === null || sha === undefined) return null;
  if (typeof sha !== "string" || !sha || sha.startsWith("-") || !HEX_RE.test(sha)) {
    throw new ManifestError(`Invalid ${what} (not hex): ${pyRepr(sha)}`);
  }
  return sha;
}

/**
 * 쿼리/프래그먼트를 떼어낸 부분. 이걸 안 떼면 '.../marketplace.json?token=x' 가
 * .json 으로 안 끝나 git 으로 오판되고, 결국 JSON 주소를 clone 하려 든다.
 */
function urlPathPart(u: string): string {
  for (const sep of ["#", "?"]) {
    const i = u.indexOf(sep);
    if (i >= 0) u = u.slice(0, i);
  }
  return u;
}

function lastSegment(u: string): string {
  const parts = urlPathPart(u).replaceAll("\\", "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1];
}

/** id 후보를 세그먼트 규칙으로 거른다. 못 만들면 빈 문자열. 호출부가 --id 를 요구한다. */
function safeId(cand: string): string {
  try {
    return safeSegment(cand || "", "id");
  } catch (e) {
    if (e instanceof ManifestError) return "";
    throw e;
  }
}

/**
 * .../marketplace.json 처럼 파일명이 정보가 없으면 한 단계 위 세그먼트를 쓴다.
 * 등록된 마켓 여럿이 전부 'marketplace' 라는 같은 id 를 두고 싸우는 걸 막는다.
 */
function idForJson(url: string): string {
  const halves = urlPathPart(url).split("//");
  const segs = halves[halves.length - 1].split("/").filter((s) => s);
  const base = segs.length ? segs[segs.length - 1] : "";
  const stem = base.toLowerCase().endsWith(".json") ? base.slice(0, -5) : base;
  if (GENERIC_JSON_STEMS.includes(casefold(stem)) || !stem) return safeId(segs.length >= 2 ? segs[segs.length - 2] : "");
  return safeId(stem);
}

/**
 * library 의 URL id 규칙과 같다(레포명에서 .git 제거). 두 경로가 같은 id 를 내야
 * owner/repo 축약과 전체 URL 이 서로 중복으로 잡힌다.
 */
function idForGit(url: string): string {
  const base = lastSegment(url);
  return safeId(base.toLowerCase().endsWith(".git") ? base.slice(0, -4) : base);
}

/**
 * 로컬 경로는 복사하지 않고 그 자리를 캐시로 삼으므로 realpath 로 고정해 둔다.
 * 같은 디렉토리를 ./x 와 절대경로로 두 번 등록하는 걸 중복 검사가 잡아내려면 표기가
 * 하나여야 한다. 없는 경로는 여기서 거부한다: '../../etc' 같은 값이 형식만 맞다고
 * 통과하면 존재하지도 않는 캐시를 가리키는 레코드가 스토어에 남는다.
 */
function localSource(p: string): SourceClass {
  const real = realpath(p);
  if (!isDir(real)) throw new ManifestError(`Local market path is not a directory: ${pyRepr(p)}`);
  const base = process.platform === "win32" ? path.win32.basename(real.replace(/[\\/]+$/, "")) : path.posix.basename(real.replace(/\/+$/, ""));
  return { kind: "local", url: null, path: real, ref: null, id: safeId(base) };
}

/**
 * 마켓 소스 문자열을 {kind: "git"|"json"|"local", url, path, ref, id} 로 판별.
 *
 * id 는 제안값이다. 최종 id 는 library 가 --id 와 중복 검사를 거쳐 정한다.
 *
 * 주입 가드(옵션형 시작, 전송 헬퍼 구문)를 분기보다 먼저 돌린다. 뒤쪽 분기가 어차피
 * 거부한다는 이유로 가드를 건너뛰면 분기 하나만 늘어도 가드가 조용히 무력해지고, 거부
 * 사유도 실제 위험과 다른 걸 말하게 된다.
 *
 * 판정 순서가 곧 규칙이다:
 *   1) 명시적 로컬 표기(./ ../ 절대경로 드라이브). 축약보다 먼저 본다
 *   2) 허용 스킴 URL / scp 스타일
 *   3) owner/repo 축약. 뒤에 #ref / @ref 가 붙으면 떼어 ref 로 돌려준다
 *   4) 마지막에만 '존재하는 디렉토리'로 본다. 이 검사를 3)보다 앞에 두면 cwd 아래에
 *      우연히 owner/repo 디렉토리가 있는 사람에게만 축약이 로컬로 바뀐다(cwd 의존).
 */
export function classifySource(src: string): SourceClass {
  if (typeof src !== "string" || !pyStrip(src)) throw new ManifestError(`Market source is empty: ${pyRepr(src)}`);
  const s = pyStrip(src);
  if (s.startsWith("-")) throw new ManifestError(`Market source starts like an option (injection risk): ${pyRepr(s)}`);
  if (TRANSPORT_HELPER_RE.test(s)) throw new ManifestError(`Market source must not use transport helper syntax (e.g. ext::): ${pyRepr(s)}`);

  if (startsWithAny(s, LOCAL_PREFIXES) || s === "." || s === ".." || s.startsWith("/") || s.startsWith("\\") || DRIVE_ABS_RE.test(s)) {
    return localSource(s);
  }

  const low = s.toLowerCase();
  if (startsWithAny(low, ALLOWED_URL_SCHEMES) || SCP_STYLE_RE.test(s)) {
    validateSourceUrl(s, "market source");
    if (urlPathPart(s).toLowerCase().endsWith(".json")) {
      // .json 은 git 레포가 아니라 매니페스트 본문이다. 본문은 http(s) 로만 받으므로
      // ssh/git/file 로 온 .json 은 등록해봤자 영원히 못 가져온다. 여기서 끊는다.
      if (!startsWithAny(low, JSON_SCHEMES)) throw new ManifestError(`marketplace.json can be fetched only over http/https: ${pyRepr(s)}`);
      return { kind: "json", url: s, path: null, ref: null, id: idForJson(s) };
    }
    return { kind: "git", url: s, path: null, ref: null, id: idForGit(s) };
  }

  let base = s;
  let ref: string | null = null;
  const m = SHORTHAND_REF_RE.exec(s);
  if (m) {
    base = m[1];
    ref = validateRef(m[2], "market source ref");
  }
  if (base.split("/").length - 1 === 1) {
    const [owner, repo] = base.split("/");
    safeSegment(owner, "market source");
    safeSegment(repo, "market source");
    return { kind: "git", url: `https://github.com/${owner}/${repo}.git`, path: null, id: safeId(repo), ref };
  }

  if (isDir(s)) return localSource(s);

  throw new ManifestError(
    `Unknown market source format: ${pyRepr(src)} - expected owner/repo, a git URL, ` +
    "a marketplace.json URL or a local path");
}

/**
 * 엔트리의 source 를 4종으로 정규화. 실측 분포: url 143 / git-subdir 80 / str-path 53 / github 2.
 *
 * url/ref/sha 는 여기서 검증하지만, marketplace 를 거치지 않는 호출 경로(사용자가
 * remote-add/market-add 에 직접 --url 을 넘기는 경우)도 있으므로 remote_fetch.materialize 에
 * 독립적으로 같은 검증이 한 번 더 있다(방어 심층화).
 */
export function sourceSpec(entry: Record<string, unknown>): SourceSpec {
  const src = getOrThrow(entry, "source");
  if (typeof src === "string") return { kind: "str-path", url: null, path: safeRelpath(src, "source.path"), ref: null, sha: null };
  if (!isDict(src)) throw new ManifestError(`Unknown source format: ${pyRepr(src)}`);
  const kind = dget(src, "source");
  const sha = validateSha(dget(src, "sha"));
  if (kind === "github") {
    const repo = pyTruthy(dget(src, "repo")) ? dget(src, "repo") : "";
    if (typeof repo !== "string") throw attributeError(repo, "split");
    const segs = repo.split("/");
    if (segs.length !== 2) throw new ManifestError(`Invalid github repo format: ${pyRepr(repo)}`);
    for (const s of segs) safeSegment(s, "github repo");
    return { kind: "github", url: `https://github.com/${repo}.git`, path: null, ref: validateRef(dget(src, "commit")), sha };
  }
  if (kind === "git-subdir") {
    const url = validateSourceUrl(dget(src, "url"));
    const p = safeRelpath(pyTruthy(dget(src, "path")) ? dget(src, "path") : "", "source.path");
    return { kind: "git-subdir", url, path: p, ref: validateRef(dget(src, "ref")), sha };
  }
  if (kind === "url") {
    const p = dget(src, "path");
    const url = validateSourceUrl(dget(src, "url"));
    const rel = pyTruthy(p) ? safeRelpath(p, "source.path") : null;
    return { kind: "url", url, path: rel, ref: validateRef(dget(src, "ref")), sha };
  }
  throw new ManifestError(`Unsupported source kind: ${pyRepr(kind)}`);
}

/**
 * 메타데이터 행만 돌려준다. 네트워크를 타지 않는다.
 *
 * 'installable N' 칼럼은 만들지 않는다. 컴포넌트를 선언한 엔트리가 4/278 뿐이라
 * 원격 225개는 fetch 전에 개수를 알 수 없다. 개수는 fetch 이후에만 나타난다.
 */
export function catalog(mf: Manifest, fetched: Record<string, unknown>, query?: string | null, category?: string | null, limit = 50, offset = 0): CatalogPage {
  const mname = pyTruthy(getOrThrow(mf, "name")) ? (mf.name as string) : "";
  const q = casefold(query || "");
  const rows: Dict[] = [];
  const counts: Record<string, number> = {};
  for (const e of mf.plugins) {
    if (!isDict(e) || !pyTruthy(dget(e, "name"))) continue;
    const name = dget(e, "name") as string;
    try {
      safeSegment(name, "plugin name");
    } catch (err) {
      if (err instanceof ManifestError) continue;   // 이름 자체가 경로 이탈이면 카탈로그에 노출하지 않는다(집계 제외)
      throw err;
    }
    const cat = (pyTruthy(dget(e, "category")) ? dget(e, "category") : "") as string;
    counts[cat] = (Object.prototype.hasOwnProperty.call(counts, cat) ? counts[cat] : 0) + 1;
    if (category && cat !== category) continue;
    if (q && !strCasefold(name).includes(q)) {
      const desc = pyTruthy(dget(e, "description")) ? dget(e, "description") : "";
      if (!strCasefold(desc).includes(q)) continue;
    }
    let kind: string;
    try {
      kind = sourceSpec(e).kind;
    } catch (err) {
      if (!(err instanceof ManifestError)) throw err;
      kind = "invalid";   // 매니페스트가 이상해도 카탈로그 전체를 죽이지 않는다
    }
    const gotRaw = getOrThrow(fetched, name);
    const got = pyTruthy(gotRaw) ? gotRaw : {};
    const src = dget(e, "source");
    const manifestSha = isDict(src) ? dget(src, "sha") ?? null : null;
    const gotSha = getOrThrow(got, "sha");
    const author = dget(e, "author");
    rows.push({
      name,
      display: displayName(e),
      description: pyTruthy(dget(e, "description")) ? dget(e, "description") : "",
      category: cat,
      author: typeof author === "string" ? author : "",
      homepage: pyTruthy(dget(e, "homepage")) ? dget(e, "homepage") : "",
      kind,
      sha: pyTruthy(gotSha) ? gotSha : manifestSha,   // fetch 한 sha 우선, 없으면 매니페스트의 고정 sha
      fetched: pyTruthy(gotRaw),
      origin: `market:${mname}/${name}`,
    });
  }
  const total = rows.length;
  const page = limit ? pySlice(rows, offset, offset + limit) : pySlice(rows, offset);
  return { total, offset, limit, categories: counts, rows: page };
}
