// remote_fetch.ts - 원격 레포 물질화(git) + 라이브러리 레이아웃 탐지. src/remote_fetch.py 이식.
//
// store 를 모른다(캐시 경로는 호출부가 준다). 네트워크를 타는 유일한 모듈이므로
// scan 경로에서는 import 만 하고 호출하지 않는다.
//
// 레이아웃 탐지가 별도인 이유: fetch 된 플러그인 루트는 이미 소문자 agents/skills/commands 라
// 매핑이 0 이다. 매핑이 필요한 건 my-tools 처럼 Agents/Skills 인 임의 레포뿐이다.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";
import { casefold, pyRepr } from "./cli_result.ts";
import { pyLoads } from "./lib_store.ts";
import { pyStrip, pyWhich as which, withinOnce } from "./plugin_units.ts";

export const CATEGORY_NAMES = ["agents", "skills", "commands"] as const;
const SKILL_MARKER = "skill.md";   // 비교는 항상 casefold 후

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

export class GitError extends FetchError {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

// subprocess.run(timeout=...) 이 내는 TimeoutExpired. GitError 가 아니므로 materialize 의 정리 분기를 타지 않는다.
export class TimeoutExpired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutExpired";
  }
}

export interface Layout {
  map: Record<string, string>;
  found: string[];
  candidates: { category: string; path: string }[];
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function dirs(p: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(p);
  } catch {
    return [];
  }
  return names.filter((e) => isDir(path.join(p, e)) && !e.startsWith("."));
}

/** p 하위 어딘가에 SKILL.md(대소문자 무시)를 품은 디렉토리가 있는가. */
function hasSkillMarker(p: string, ancestors: Set<string> = new Set()): boolean {
  // Python 판(os.walk)은 정션을 폴더로 보고 내려간다. Node 는 정션과 심볼릭 링크를 구분하지 못하므로
  // 링크는 대상을 따라가 폴더면 내려가고, 조상을 가리키는 링크(순환)는 실제 경로로 걸러 다시 들어가지 않는다.
  let found = false;
  withinOnce(ancestors, p, () => {
    let names: string[];
    try {
      names = fs.readdirSync(p);
    } catch {
      return;
    }
    const sub: string[] = [];
    for (const n of names) {
      const full = path.join(p, n);
      if (isDir(full)) {
        if (!n.startsWith(".")) sub.push(full);
      } else if (casefold(n) === SKILL_MARKER) {
        found = true;
        return;
      }
    }
    found = sub.some((s) => hasSkillMarker(s, ancestors));
  });
  return found;
}

/**
 * 1) 루트 직계에서 agents/skills/commands 를 대소문자 무시로 찾아 채택.
 * 2) 실패한 카테고리는 깊이 2 + SKILL.md 마커로 후보만 제안(자동 채택 안 함).
 *
 * 반환 map 의 값은 root 기준 상대경로(실제 디스크 표기 그대로).
 * 자동 채택은 폴백이 아니라 기본 경로이고, 매핑은 사용자가 확정한다.
 */
export function detectLayout(root: string): Layout {
  const top = dirs(root);
  const byFold = new Map<string, string>();
  for (const d of top) byFold.set(casefold(d), d);
  const cmap: Record<string, string> = {};
  const found: string[] = [];
  for (const cat of CATEGORY_NAMES) {
    const actual = byFold.get(cat);
    if (actual) {
      cmap[cat] = actual;
      found.push(cat);
    }
  }

  const candidates: { category: string; path: string }[] = [];
  const seen = new Set<string>();
  const add = (cat: string, rel: string) => {
    const k = `${cat}\0${rel}`;
    if (!found.includes(cat) && !seen.has(k)) {
      seen.add(k);
      candidates.push({ category: cat, path: rel });
    }
  };

  for (const d of top) {
    const sub = path.join(root, d);
    for (const d2 of dirs(sub)) {
      if ((CATEGORY_NAMES as readonly string[]).includes(casefold(d2))) add(casefold(d2), path.join(d, d2));
    }
    // SKILL.md 를 품은 디렉토리는 이름이 skills 가 아니어도 스킬 루트 후보다.
    if (!(CATEGORY_NAMES as readonly string[]).includes(casefold(d)) && hasSkillMarker(sub)) add("skills", d);
  }

  return { map: cmap, found, candidates };
}

// ── git ────────────────────────────────────────────────────────────────────
// 모든 명령에 두 플래그를 고정 + 로컬 config 에도 박는다(이후 checkout 까지 커버):
//   core.autocrlf=false  줄바꿈 정규화가 내용 해시를 바꿔 허위 modified 를 만드는 걸 막는다.
//   core.longpaths=true  Windows MAX_PATH(260자) 를 넘는 캐시 경로에서 git 이 자기
//                        내부 파일(.git/objects/pack/*.promisor, .git/hooks/*.sample 등)을
//                        "Filename too long" 으로 못 쓰는 걸 막는다. 외부 플러그인은
//                        <store>/lib-cache/markets/<mkt>/plugins/<name>/<40자 sha>/ 아래에
//                        물질화되므로 store 경로가 길면 여유(실측: 기본 store 기준 54자)가
//                        금방 잠식된다. CLAUDE_SNAPSHOT_STORE 는 사용자가 바꿀 수 있다.
//                        주의: 이 플래그는 git 자신의 파일 I/O 에만 적용된다. 이 모듈
//                        바깥의 mkdir/copy/walk 등은 여전히 260자 제한을 받는다(이 머신에서 확인).
//                        \\?\ 접두를 코드베이스 전반에 넣는 건 범위를 벗어나므로 하지 않는다.
// tarball 폴백은 만들지 않는다. 호스트 하나에서만 되고 얻는 게 없다.

export const GIT_BASE: readonly string[] = ["git", "-c", "core.autocrlf=false", "-c", "core.longpaths=true"];
const GIT_TIMEOUT_SEC = 600;

// git 이 url/ref/sha 문자열 자체를 해석하므로 인자 배열 격리로는 주입을
// 막지 못한다(실측: git fetch 가 "--upload-pack=evil" 을 받으면 "evil" 을 서브프로세스로
// 실행 시도했다). marketplace 가 같은 검증을 이미 하지만, remote-add/market-add 처럼
// 사용자가 --url 을 직접 넘겨 marketplace 를 거치지 않는 경로도 있으므로 여기서
// 독립적으로 다시 검사한다(marketplace 를 import 하지 않는다. 이 모듈은 그보다 아래
// 계층이다). marketplace 의 동일 로직과 의도적으로 중복이다.
const ALLOWED_URL_SCHEMES = ["https://", "http://", "ssh://", "git://", "file://"];
const SCP_STYLE_RE = /^[A-Za-z0-9_.~-]+@[A-Za-z0-9_.-]+:[A-Za-z0-9_./~-][^\n]*\n?$/;
const TRANSPORT_HELPER_RE = /^[A-Za-z0-9+.-]*::/;   // 앞에서만 검사. IPv6 리터럴([::1]) 오탐 방지
const HEX_RE = /^[0-9a-fA-F]+\n?$/;

function validateUrl(url: unknown): string {
  if (typeof url !== "string" || !url) throw new GitError(`Invalid url: ${pyRepr(url)}`);
  if (url.startsWith("-")) throw new GitError(`url starts like an option (injection risk): ${pyRepr(url)}`);
  if (TRANSPORT_HELPER_RE.test(url)) throw new GitError(`url must not use transport helper syntax (e.g. ext::): ${pyRepr(url)}`);
  const low = url.toLowerCase();
  if (ALLOWED_URL_SCHEMES.some((s) => low.startsWith(s)) || SCP_STYLE_RE.test(url)) return url;
  throw new GitError(`url scheme is not in the allowed list: ${pyRepr(url)}`);
}

function validateRef(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value || value.startsWith("-")) throw new GitError(`Invalid ${what}: ${pyRepr(value)}`);
  return value;
}

function validateSha(sha: unknown): string | null {
  if (sha === null || sha === undefined) return null;
  if (typeof sha !== "string" || !sha || sha.startsWith("-") || !HEX_RE.test(sha)) {
    throw new GitError(`Invalid sha (not hex): ${pyRepr(sha)}`);
  }
  return sha;
}

/** PATH 에서 git 을 찾는다(shutil.which 와 같은 규칙). */
export function gitAvailable(): boolean {
  return which("git") !== null;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// subprocess.run(text=True, encoding="utf-8", errors="replace") 와 같게: utf-8 대체 디코드 + 줄바꿈 통일.
function decodeText(b: Buffer): string {
  return new TextDecoder("utf-8").decode(b).replace(/\r\n?/g, "\n");
}

function spawnGit(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(GIT_BASE[0], [...GIT_BASE.slice(1), ...args], {
      cwd, encoding: "buffer", windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_SEC * 1000,
    }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: string | null }) | null;
      if (e && e.killed) {
        reject(new TimeoutExpired(`Command '${pyRepr([...GIT_BASE, ...args])}' timed out after ${GIT_TIMEOUT_SEC} seconds`));
        return;
      }
      if (e && typeof e.code === "string") {
        reject(e);
        return;
      }
      resolve({ code: e ? Number(e.code ?? 1) : 0, stdout: decodeText(stdout as Buffer), stderr: decodeText(stderr as Buffer) });
    });
  });
}

async function run(cwd: string, ...args: string[]): Promise<string> {
  if (!gitAvailable()) throw new GitError("git was not found on PATH");
  const p = await spawnGit(cwd, args);
  if (p.code !== 0) {
    const tail = Array.from(pyStrip(p.stderr || p.stdout)).slice(0, 500).join("");
    throw new GitError(`git ${args.join(" ")} failed (rc=${p.code}): ${tail}`);
  }
  return pyStrip(p.stdout);
}

/**
 * dest 에 레포를 물질화하고 해석된 sha 를 반환. 이미 있으면 재사용(sparse 확장 포함).
 *
 * sha 가 있으면 sha 로 직접 fetch 한다(GitHub 은 비-tip SHA 도 허용).
 * 실패하면 ref 로 받고 결과 sha 를 검증하는 폴백을 탄다.
 *
 * git fetch 는 실패해도 .git/FETCH_HEAD 를 빈 파일로 만들어 둔다(전송 시도 시점에
 * 열어서 truncate 하기 때문). "실패하면 부분 캐시를 남기지 않는다"는 계약은 git 이
 * 보장해주지 않으므로, 이번 호출이 새로 만든 dest 라면 실패 시 통째로 지운다.
 *
 * url/ref/sha 검증은 dest 를 건드리기 전에 한다. 거부되면 디렉토리 자체가 생기지 않는다.
 */
export async function materialize(dest: string, url: string, ref?: string | null, sha?: string | null, sparse?: string[] | null): Promise<string> {
  validateUrl(url);
  validateRef(ref ?? null, "ref");
  validateSha(sha ?? null);
  fs.mkdirSync(dest, { recursive: true });
  const fresh = !isDir(path.join(dest, ".git"));
  try {
    if (fresh) {
      await run(dest, "init", "-q");
      await run(dest, "config", "--local", "core.autocrlf", "false");
      await run(dest, "config", "--local", "core.longpaths", "true");
      await run(dest, "remote", "add", "origin", url);
    } else {
      await run(dest, "remote", "set-url", "origin", url);
    }

    if (sparse && sparse.length) {
      await run(dest, "sparse-checkout", "init", "--cone");
      await run(dest, "sparse-checkout", "set", ...sparse);
    }

    const target = sha || ref || "HEAD";
    try {
      await run(dest, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", target);
    } catch (e) {
      if (!(e instanceof GitError) || !sha) throw e;
      // 서버가 비-tip SHA want 를 거부하는 경우: ref 로 받고 sha 를 검증한다.
      await run(dest, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", ref || "HEAD");
    }
    await run(dest, "checkout", "-q", "FETCH_HEAD");
    const got = await run(dest, "rev-parse", "HEAD");
    if (sha && got !== sha) throw new GitError(`sha mismatch: requested ${sha.slice(0, 12)} != actual ${got.slice(0, 12)}`);
    return got;
  } catch (e) {
    if (e instanceof GitError && fresh) {
      try {
        fs.rmSync(dest, { recursive: true, force: true });
      } catch {
        /* shutil.rmtree(ignore_errors=True) */
      }
    }
    throw e;
  }
}

// ── marketplace.json 직접 다운로드 ──────────────────────────────────────────
// git 레포가 아닌 마켓(Claude Code 가 받는 4형식 중 하나)은 매니페스트 파일 하나가 전부다.
// 표준 라이브러리만 쓴다(의존성 추가 금지). git 경로와 캐시 레이아웃을 맞춰
// <dest>/.claude-plugin/marketplace.json 에 두면 카탈로그/unregister 가 그대로 동작한다.

export const MANIFEST_MAX_BYTES = 5 * 1024 * 1024;   // 무한 스트림에 디스크를 내주지 않는다. 실측 최대 매니페스트 401K
// 테스트가 상한을 낮출 때 바꾸는 값(Python 은 모듈 상수를 덮어쓴다).
export const manifestLimits = { maxBytes: MANIFEST_MAX_BYTES };
const JSON_SCHEMES = ["http://", "https://"];
const MAX_REDIRECTS = 10;   // urllib HTTPRedirectHandler.max_redirections

/**
 * JSON 본문은 http/https 로만 받는다. ssh/git/file 은 git 전송용이지 본문 전송이 아니고,
 * file:// 을 허용하면 로컬 파일을 원격 매니페스트인 척 끌어올 수 있다.
 */
function validateHttpUrl(url: unknown, what = "url"): string {
  if (typeof url !== "string" || !url) throw new FetchError(`Invalid ${what}: ${pyRepr(url)}`);
  if (url.startsWith("-")) throw new FetchError(`${what} starts like an option: ${pyRepr(url)}`);
  if (!JSON_SCHEMES.some((s) => url.toLowerCase().startsWith(s))) throw new FetchError(`${what} must be http/https: ${pyRepr(url)}`);
  return url;
}

/**
 * 요청 주소에 쓸 프록시. Python urllib 은 HTTPS_PROXY/HTTP_PROXY(대소문자 모두)와 NO_PROXY 를 따르지만
 * Node http 는 env 를 보지 않으므로 같은 env 를 직접 읽는다. Windows 레지스트리의 시스템 프록시는 보지 않는다.
 */
export function proxyFor(target: URL, env: NodeJS.ProcessEnv = process.env): URL | null {
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s);
  if (noProxy.some((n) => n === "*" || host === n.replace(/^\./, "") || host.endsWith(n.startsWith(".") ? n : "." + n))) return null;
  const raw = target.protocol === "https:" ? env.HTTPS_PROXY ?? env.https_proxy : env.HTTP_PROXY ?? env.http_proxy;
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : "http://" + raw);
  } catch {
    return null;
  }
}

function proxyAuth(proxy: URL): Record<string, string> {
  if (!proxy.username) return {};
  const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { "Proxy-Authorization": "Basic " + Buffer.from(cred).toString("base64") };
}

/** 요청을 연다. 프록시가 있으면 http 는 프록시에 절대 주소로, https 는 CONNECT 터널 위에서 TLS 로 보낸다. */
function openGet(url: string, headers: Record<string, string>, timeoutMs: number, onRes: (res: http.IncomingMessage) => void): Promise<http.ClientRequest> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const proxy = proxyFor(u);
  if (!proxy) return Promise.resolve((isHttps ? https : http).get(url, { headers }, onRes));
  const via = { host: proxy.hostname.replace(/^\[|\]$/g, ""), port: Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80) };
  if (!isHttps) return Promise.resolve(http.get({ ...via, path: url, headers: { ...headers, Host: u.host, ...proxyAuth(proxy) } }, onRes));
  return new Promise((resolve, reject) => {
    const authority = `${u.hostname}:${u.port || 443}`;
    const connect = http.request({ ...via, method: "CONNECT", path: authority, headers: { Host: authority, ...proxyAuth(proxy) } });
    connect.setTimeout(timeoutMs, () => connect.destroy(new Error("timed out")));
    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Tunnel connection failed: ${res.statusCode} ${res.statusMessage ?? ""}`.trim()));
        return;
      }
      resolve(https.get(url, { headers, agent: false, createConnection: () => tls.connect({ socket, servername: u.hostname }) }, onRes));
    });
    connect.on("error", reject);
    connect.end();
  });
}

function getOnce(url: string, timeoutSec: number, cap: number): Promise<{ status: number; reason: string; location?: string; data: Buffer }> {
  return new Promise((resolve, reject) => {
    openGet(url, { "User-Agent": "config-monitor" }, timeoutSec * 1000, (res) => {
      const status = res.statusCode ?? 0;
      const reason = res.statusMessage ?? "";
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        resolve({ status, reason, location, data: Buffer.alloc(0) });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        size += c.length;
        if (size > cap) {
          resolve({ status, reason, data: Buffer.concat(chunks).subarray(0, cap + 1) });
          res.destroy();
        }
      });
      res.on("end", () => resolve({ status, reason, data: Buffer.concat(chunks) }));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("IncompleteRead")));
    }).then((req) => {
      // urllib 의 timeout 은 소켓 연산마다 걸린다(전체 시간 상한이 아니다).
      req.setTimeout(timeoutSec * 1000, () => req.destroy(new Error("timed out")));
      req.on("error", reject);
    }, reject);
  });
}

/**
 * 본문을 상한까지만 읽는다. Content-Length 를 믿고 자르면 헤더를 속인 서버에
 * 그대로 당한다. 읽는 양 자체를 상한+1 로 제한하고 넘치면 거부한다.
 */
async function readCapped(url: string, timeoutSec: number): Promise<Buffer> {
  const cap = manifestLimits.maxBytes;
  let cur = url;
  let data: Buffer;
  try {
    for (let hop = 0; ; hop++) {
      const r = await getOnce(cur, timeoutSec, cap);
      if (r.location !== undefined && [301, 302, 303, 307, 308].includes(r.status)) {
        if (hop >= MAX_REDIRECTS) throw new Error(`HTTP Error ${r.status}: The HTTP server returned a redirect error that would lead to an infinite loop.`);
        cur = new URL(r.location, cur).toString();
        // 리다이렉트를 따라간 최종 주소도 검사한다.
        validateHttpUrl(cur, "redirect target");
        continue;
      }
      if (r.status < 200 || r.status >= 300) throw new Error(`HTTP Error ${r.status}: ${r.reason}`);
      data = r.data;
      break;
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    // 응답이 중간에 끊기는 경우도 여기서 FetchError 로 바꾼다. 빠지면 호출부까지 새어 internal 이 된다.
    throw new FetchError(`Cannot download the manifest: ${(e as Error).message}`);
  }
  if (data.length > cap) throw new FetchError(`The manifest exceeds the size limit (${cap} bytes)`);
  return data;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * marketplace.json 을 직접 받아 <dest>/.claude-plugin/marketplace.json 에 쓰고
 * 내용 sha256 앞 12자를 반환한다(git sha 가 없으므로 그 자리를 대신한다. 내용이 바뀌면
 * 값도 바뀌어 갱신 여부가 눈에 보인다).
 *
 * 파싱 검증을 쓰기 전에 끝낸다. materialize 와 같은 계약이다: 실패하면 부분 파일을
 * 남기지 않고, 이번 호출이 dest 를 새로 만들었다면 통째로 지운다. 검증을 나중에 하면
 * 잘못된 응답이 이미 등록된 마켓의 매니페스트를 덮어써 카탈로그가 사라진다.
 */
export async function fetchManifestJson(dest: string, url: string, timeout = 30): Promise<string> {
  validateHttpUrl(url);
  const data = await readCapped(url, timeout);
  let obj: unknown;
  try {
    // ignoreBOM: BOM 을 문자로 남겨 pyLoads 가 거부하게 한다(Python json.loads 는 BOM 으로 시작하는 str 을 거부한다).
    obj = pyLoads(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data));
  } catch (e) {
    throw new FetchError(`The manifest is not valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(obj) || !Array.isArray(Object.prototype.hasOwnProperty.call(obj, "plugins") ? obj.plugins : undefined)) {
    throw new FetchError("The manifest has no plugins array");
  }

  const fresh = !isDir(dest);
  const target = path.join(dest, ".claude-plugin", "marketplace.json");
  const tmp = target + ".tmp";
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);   // 원자적 교체. 반쯤 쓰인 매니페스트가 보이지 않는다
  } catch (e) {
    if (fresh) {
      try {
        fs.rmSync(dest, { recursive: true, force: true });
      } catch {
        /* ignore_errors */
      }
    } else {
      try {
        fs.rmSync(tmp);
      } catch {
        /* 없으면 그만 */
      }
    }
    throw new FetchError(`Cannot save the manifest: ${(e as Error).message}`);
  }
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 12);
}
