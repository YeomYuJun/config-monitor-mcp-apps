// transfer 의 Python 교차 확인에 쓰는 고정 입력. 기대값은 Python 판 출력과 번들 파일을 저장한
// fixtures/transfer.xcheck.json 이고, 다시 만들 때만 transfer.xcheck.capture.ts 로 Python 을 부른다.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isZipfile, main, ZipReader } from "../../src/core/transfer.ts";
import type { CliDoc } from "../../src/core/cli_result.ts";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXPECTED = path.join(REPO, "tests", "node", "fixtures", "transfer.xcheck.json");
/** 번들 manifest 의 source.host. 저장 파일에 실제 호스트명이 들어가지 않게 양쪽 판 모두 이 값으로 바꿔 쓴다. */
export const HOST = "demo-pc";
/** 키 이름(TOKEN)으로 시크릿이 되는 값. 토큰 모양이 아니라 저장소 시크릿 검사에 걸리지 않는다. */
export const SECRET_VALUE = "fixture-secret-value";
export const KINDS = ["zip", "folder"] as const;
export type Kind = (typeof KINDS)[number];
export const SECRETS_ARG = JSON.stringify({ "cc.mcp-user/srv": { "env.GITHUB_TOKEN": "x" } });

/** 저장소 드라이브의 cmg-<8 hex>. 길이가 고정이라 캡처 때 루트와 실행 때 루트를 같은 길이로 바꿔 끼울 수 있다. */
export function makeRoot(): string {
  return path.join(path.parse(REPO).root, `cmg-${randomBytes(4).toString("hex")}`);
}

export interface Layout {
  /** 가져오는 쪽 홈과 번들을 두는 루트 */
  root: string;
  /** 내보내는 쪽 루트. plan 을 돌릴 때는 통째로 없어야 경로 짝 추정(없는 가장 위 폴더)이 캡처 때와 같다. */
  src: string;
  /** 내보내는 쪽 홈 */
  a: string;
  /** 홈 밖의 도구 폴더(훅·MCP 가 가리킨다) */
  ext: string;
  /** 가져오는 쪽 홈(빈 PC) */
  b: string;
  bundles: string;
  tree: string;
}

export function layout(root: string, src: string): Layout {
  return {
    root, src, a: path.join(src, "home"), ext: path.join(src, "tools"), b: path.join(root, "b", "Users", "other"),
    bundles: path.join(root, "bundles"), tree: path.join(root, "tree"),
  };
}

function write(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
}

export function buildSource(L: Layout): void {
  const ch = path.join(L.a, ".claude");
  write(path.join(ch, "skills", "qa", "SKILL.md"), "---\ndescription: q\n---\n");
  write(path.join(ch, "skills", "synced", "acct", "x", "SKILL.md"), "synced\n");
  write(path.join(ch, "skills", "한글", "설명.md"), "한글 내용\n");
  write(path.join(ch, "agents", "rev.md"), "---\ndescription: r\n---\n");
  write(path.join(ch, "hooks", "guard.py"), "print(1)\n");
  write(path.join(L.ext, "hook.js"), "//\n");
  write(path.join(L.ext, "srv", "index.js"), "//\n");
  write(path.join(ch, "settings.json"), JSON.stringify({
    feedbackDrafts: { x: 1 },
    statusLine: { type: "command", command: `node "${path.join(ch, "hooks", "guard.py")}"` },
    hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${path.join(L.ext, "hook.js")}"` }] }] },
    env: { API_TOKEN: SECRET_VALUE },
    model: "sonnet",
    ratio: "@RATIO@",
    permissions: { allow: ["Bash(ls)"] },
  }).replace('"@RATIO@"', "1.0"));
  write(path.join(L.a, ".claude.json"), JSON.stringify({
    mcpServers: { srv: { command: "node", args: [path.join(L.ext, "srv", "index.js")], env: { GITHUB_TOKEN: SECRET_VALUE } } },
  }));
  const desk = path.join(L.a, "AppData", "Roaming", "Claude");
  write(path.join(desk, "claude_desktop_config.json"), JSON.stringify({ mcpServers: { dsk: { command: "node", args: [path.join(desk, "dsk.js")] } } }));
}

export function buildTree(dir: string): void {
  for (const rel of ["b.txt", "A.txt", "sub/z.md", "sub/deep/x", "Sub2/y", "한글/파일.md"]) write(path.join(dir, ...rel.split("/")), rel);
}

function randomLines(rnd: () => number, n: number, alpha: number): string[] {
  return Array.from({ length: n }, () => `l${Math.floor(rnd() * alpha)}`);
}

/** difflib 비교 입력. 같은 씨앗이라 캡처와 실행에서 같은 목록이 나온다. */
export function diffCases(): [string[], string[], number][] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const cases: [string[], string[], number][] = [[[], [], 2], [["a"], [], 2], [[], ["a"], 3], [["a", "b"], ["a", "b"], 2]];
  for (let i = 0; i < 40; i++) {
    const a = randomLines(rnd, Math.floor(rnd() * 30), 6);
    const b = a.filter(() => rnd() > 0.2).flatMap((x) => (rnd() > 0.85 ? [x, `n${Math.floor(rnd() * 4)}`] : [x]));
    cases.push([a, b, 1 + (i % 3)]);
  }
  // 200줄 이상이면 autojunk 가 흔한 줄을 b2j 에서 뺀다
  const big = randomLines(rnd, 260, 3);
  cases.push([big, big.filter(() => rnd() > 0.1), 2]);
  return cases;
}

export function bundlePath(L: Layout, who: "py" | "ts", kind: Kind): string {
  return path.join(L.bundles, kind === "zip" ? `${who}.cmbundle` : `${who}-bundle`);
}

/** 번들 하나에 거는 명령 목록. */
export function bundleArgs(bundle: string): string[][] {
  return [["plan", "--bundle", bundle], ["plan", "--bundle", bundle, "--secrets", SECRETS_ARG], ["inspect", "--bundle", bundle],
    ["plan", "--bundle", bundle, "--secrets", "[1]"]];
}

/** 번들 없이 끝나는 명령. */
export function miscArgs(L: Layout): string[][] {
  return [["plan", "--bundle", path.join(L.root, "nope")], ["plan"]];
}

export function envFor(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_CONFIG_LIBRARIES;
  return {
    ...env, HOME: home, USERPROFILE: home, CLAUDE_CAS_NO_DEFAULT_TRACK: "0",
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    CLAUDE_SNAPSHOT_STORE: path.join(home, "store"), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
  };
}

/** TS 판을 같은 프로세스에서 python transfer.py 와 같은 argv 로 부른다. 호스트명은 HOST 로 바꿔 둔다. */
export async function runTs(home: string, args: string[]): Promise<CliDoc> {
  const env = envFor(home);
  const saved = { ...process.env };
  const hostname = os.hostname;
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
  os.hostname = () => HOST;
  try {
    return await main(args);
  } finally {
    os.hostname = hostname;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/** 번들 안 파일 {이름: bytes}. zip 은 중앙 디렉토리 순서, 폴더는 이름순. */
export function members(p: string): [string, Buffer][] {
  if (isZipfile(p)) {
    const z = new ZipReader(p);
    return z.names.map((n) => [n, z.read(n)]);
  }
  const out: [string, Buffer][] = [];
  const walk = (d: string, rel: string[]) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      if (e.isDirectory()) walk(path.join(d, e.name), [...rel, e.name]);
      else out.push([[...rel, e.name].join("/"), fs.readFileSync(path.join(d, e.name))]);
    }
  };
  walk(p, []);
  return out;
}

/** 저장 형식: zip 은 파일 하나, 폴더는 {상대경로: base64}. 폴더 번들을 git 이 줄바꿈 변환하지 않게 base64 로 둔다. */
export type StoredBundle = { zip: string } | { files: Record<string, string> };

export function storeBundle(p: string): StoredBundle {
  if (isZipfile(p)) return { zip: fs.readFileSync(p).toString("base64") };
  return { files: Object.fromEntries(members(p).map(([n, b]) => [n, b.toString("base64")])) };
}

export function materialize(s: StoredBundle, p: string): void {
  if ("zip" in s) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(s.zip, "base64"));
    return;
  }
  for (const [rel, b64] of Object.entries(s.files)) {
    const dst = path.join(p, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, Buffer.from(b64, "base64"));
  }
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 루트 경로(원형, JSON 안의 두 겹 역슬래시, '/' 형, 대소문자 무시)를 <ROOT> 로 바꾼다. */
export function rootReps(roots: string[]): [RegExp, string][] {
  return roots.flatMap((r) => [
    [new RegExp(esc(r.replace(/\\/g, "\\\\")), "gi"), "<ROOT>"],
    [new RegExp(esc(r), "gi"), "<ROOT>"],
    [new RegExp(esc(r.replace(/\\/g, "/")), "gi"), "<ROOT>"],
  ] as [RegExp, string][]);
}

export function normalize(doc: unknown, roots: string[]): unknown {
  const reps = rootReps(roots);
  const str = (s: string) => reps.reduce((a, [re, to]) => a.replace(re, to), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [str(k), walk(x)]));
    return v;
  };
  return walk(doc);
}

export interface Run {
  argv: string[];
  exit: number;
  doc: unknown;
}

export interface XcheckFixture {
  /** 캡처 때 내보내는 쪽 루트. 번들 안에 이 경로가 남아 있어 실행 때도 <ROOT> 로 바꾼다. */
  capture_src: string;
  difflib: string[][];
  tree: { rows: [string, string][]; size: number; digest: string };
  bundles: Record<string, StoredBundle>;
  /** Python 판이 TS 판 번들을 읽어 확인한 결과 */
  py_read_ts: Record<string, { hash: string; ok: Record<string, boolean>; secrets: Record<string, Record<string, string>> }>;
  /** Python 판 plan·inspect 출력(루트는 <ROOT>) */
  runs: Record<string, Run[]>;
}

/** 저장 파일과 번들 안(zip 은 푼 내용)에서 이 PC 의 홈 경로, 임시 폴더, 사용자명, 호스트명을 찾는다. */
export function leaks(fx: XcheckFixture, text: string): string[] {
  const needles = [os.homedir(), os.tmpdir(), os.userInfo().username, os.hostname()].filter((x) => x && x.length >= 3);
  const hay: [string, string][] = [["fixture", text]];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xcheck_leak_"));
  try {
    for (const [name, s] of Object.entries(fx.bundles)) {
      const p = path.join(tmp, "zip" in s ? `${name}.cmbundle` : name);
      materialize(s, p);
      for (const [m, b] of members(p)) hay.push([`${name}:${m}`, b.toString("utf8")]);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const out: string[] = [];
  for (const n of needles) {
    const lower = n.toLowerCase();
    const alt = lower.replace(/\\/g, "\\\\");
    for (const [where, s] of hay) if (s.toLowerCase().includes(lower) || s.toLowerCase().includes(alt)) out.push(`${where} 에 ${n}`);
  }
  return out;
}
