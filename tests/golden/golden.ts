// golden.ts - 기준 출력(tests/golden/expected)과 비교에 쓰는 공용 도우미.
//
// 입력은 scripts/demo_profile.ts 가 만드는 데모 프로필이다(사용자의 ~/.claude 를 쓰지 않는다).
// 케이스는 cases.json 에 있고, 각 케이스는 템플릿에서 되살린 같은 프로필 위에서 단계(steps)를 차례로 실행한다.
// 기준 파일은 Python 판이 같은 케이스를 실행한 결과를 이 정규화로 저장한 것이다(Python 판은 저장소에서 빠졌다).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { deepEqual } from "node:assert/strict";
import { after, before, test } from "node:test";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const GOLDEN_DIR = path.join(REPO, "tests", "golden");
export const EXPECTED_DIR = path.join(GOLDEN_DIR, "expected");
const TS_ENTRY = path.join(GOLDEN_DIR, "ts-entry.ts");

export interface Step {
  argv: string[];
  /** 실행 전에 만들 폴더(자리표시자 사용 가능). */
  mkdir?: string[];
}

export interface Case {
  id: string;
  module: string;
  note?: string;
  steps: Step[];
}

export interface StepResult {
  argv: string[];
  exit: number;
  doc: unknown;
  /** stdout 이 JSON 이 아닐 때만. */
  stdout?: string;
}

export interface CaseResult {
  id: string;
  module: string;
  note?: string;
  steps: StepResult[];
}

export interface RunOutput {
  exit: number;
  stdout: string;
  stderr: string;
}

export type Runner = (module: string, argv: string[], env: NodeJS.ProcessEnv) => RunOutput;

// ----- 실행기 -----

/** src/core/<module>.ts 의 main(argv) 를 자식 프로세스에서 부른다(모듈이 import 시점에 env 를 읽어도 안전). */
export const tsRunner: Runner = (module, argv, env) => {
  const r = spawnSync(process.execPath, ["--import", "tsx", TS_ENTRY, module, ...argv], {
    env, cwd: REPO, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true,
  });
  return { exit: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
};

// ----- 데모 프로필 -----

function copyTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    // copyFileSync 는 Windows 에서 CopyFileW 라 mtime 을 100ns 정밀도로 보존한다(index.json 의 mtime_ns 와 맞아야 한다).
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function encodeProjectDir(p: string): string {
  return p.replace(/[^A-Za-z0-9]/gu, "-");
}

export class Demo {
  readonly root: string;
  readonly template: string;
  readonly home: string;
  readonly claude: string;
  readonly store: string;
  readonly lib: string;
  readonly project: string;
  readonly bundle: string;
  readonly env: NodeJS.ProcessEnv;

  private constructor(root: string) {
    this.root = root;
    this.template = root + ".tpl";
    this.home = path.join(root, "Users", "alex");
    this.claude = path.join(this.home, ".claude");
    this.store = path.join(this.home, ".claude-snapshot");
    this.lib = path.join(root, "tools", "my-tools");
    this.project = path.join(root, "work", "acme-web");
    this.bundle = path.join(root, "bundles", "old-laptop");
    const base: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^(CLAUDE_SNAPSHOT_STORE|CLAUDE_CONFIG_LIBRARIES|CLAUDE_CAS_|CONFIG_MONITOR_|HOMEDRIVE$|HOMEPATH$)/i.test(k)) continue;
      base[k] = v;
    }
    const systemp = path.join(root, "systemp");
    this.env = {
      ...base,
      HOME: this.home, USERPROFILE: this.home,
      APPDATA: path.join(this.home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(this.home, "AppData", "Local"),
      CLAUDE_SNAPSHOT_STORE: this.store,
      CLAUDE_CONFIG_LIBRARIES: this.lib,
      CLAUDE_CAS_NO_DEFAULT_TRACK: "0",
      // 시스템 임시 폴더 아래 프로젝트는 목록에서 빠지므로 자식의 임시 폴더를 프로필 안으로 옮긴다.
      TEMP: systemp, TMP: systemp, TMPDIR: systemp,
    };
  }

  /**
   * 루트는 저장소 드라이브의 cmg-<8hex>(길이 고정). 길이가 같아야 경로가 든 값의 size 가 세션마다 같다.
   * CM_GOLDEN_ROOT 로 바꿀 수 있지만 그러면 size 비교가 어긋날 수 있다.
   */
  static create(rootOverride?: string): Demo {
    const root = rootOverride || process.env.CM_GOLDEN_ROOT ||
      path.join(path.parse(REPO).root, `cmg-${randomBytes(4).toString("hex")}`);
    const d = new Demo(root);
    fs.rmSync(d.root, { recursive: true, force: true });
    fs.rmSync(d.template, { recursive: true, force: true });
    fs.mkdirSync(d.root, { recursive: true });
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(REPO, "scripts", "demo_profile.ts"), d.root], {
      env: d.env, cwd: REPO, encoding: "utf-8", timeout: 300_000, windowsHide: true,
    });
    if (r.status !== 0) throw new Error(`demo_profile.ts 실패(${r.status}): ${r.stdout}\n${r.stderr}`);
    fs.mkdirSync(path.join(d.root, "systemp"), { recursive: true });
    copyTree(d.root, d.template);
    return d;
  }

  /** 이미 만들어진 루트를 가리키는 Demo(자식 프로세스에서 자리표시자를 풀 때). */
  static at(root: string): Demo {
    return new Demo(root);
  }

  reset(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
    copyTree(this.template, this.root);
  }

  dispose(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
    fs.rmSync(this.template, { recursive: true, force: true });
  }

  snapshots(): string[] {
    try {
      return fs.readdirSync(path.join(this.store, "snapshots")).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
    } catch {
      return [];
    }
  }

  private vars(): Record<string, string> {
    return { ROOT: this.root, HOME: this.home, CLAUDE: this.claude, STORE: this.store, LIB: this.lib, PROJECT: this.project, BUNDLE: this.bundle };
  }

  /** 자리표시자를 푼다. {ROOT} 같은 경로로 시작하는 인자는 path.normalize 로 구분자를 맞춘다. */
  resolve(arg: string, prev: StepResult[]): string {
    const vars = this.vars();
    // {J:NAME} 은 JSON 문자열 안에 넣을 수 있게 역슬래시를 두 겹으로 한 값이다.
    let out = arg.replace(/\{J:([A-Z]+)\}/g, (m, k: string) => vars[k]?.replace(/\\/g, "\\\\") ?? m);
    out = out.replace(/\{([A-Z]+)\}/g, (m, k: string) => vars[k] ?? m);
    out = out.replace(/\{SNAP:(-?\d+)\}/g, (_m, n: string) => {
      const s = this.snapshots();
      const i = Number(n);
      const v = s[i < 0 ? s.length + i : i];
      if (!v) throw new Error(`스냅샷 ${n} 없음`);
      return v;
    });
    out = out.replace(/\{S(\d+)\.([A-Za-z_]+)\}/g, (_m, n: string, f: string) => {
      const doc = prev[Number(n)]?.doc as Record<string, unknown> | undefined;
      const v = doc?.[f];
      if (typeof v !== "string") throw new Error(`단계 ${n} 의 ${f} 없음`);
      return v;
    });
    if (/^\{(ROOT|HOME|CLAUDE|STORE|LIB|PROJECT|BUNDLE)\}/.test(arg)) out = path.normalize(out);
    return out;
  }

  // ----- 정규화 -----

  private replacers(): [RegExp, string][] {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fwd = this.root.replace(/\\/g, "/");
    const dbl = this.root.replace(/\\/g, "\\\\");
    const realHome = os.homedir();
    const host = os.hostname();
    return [
      [new RegExp(esc(dbl), "gi"), "<ROOT>"],
      [new RegExp(esc(this.root), "gi"), "<ROOT>"],
      [new RegExp(esc(fwd), "gi"), "<ROOT>"],
      [new RegExp(esc(encodeProjectDir(this.root)), "gi"), "<ROOT-ENC>"],
      ...(realHome.length > 3 ? [[new RegExp(esc(realHome), "gi"), "<REAL_HOME>"] as [RegExp, string]] : []),
      ...(host ? [[new RegExp(`\\b${esc(host)}\\b`, "gi"), "<HOST>"] as [RegExp, string]] : []),
      [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)?/g, "<TIME>"],
      [/\d{8}T\d{6}_\d{6}/g, "<SNAP>"],
      [/(?<![0-9a-f])\d{14}(?![0-9a-f])/g, "<TS14>"],
      [/\b\d{2}:\d{2}:\d{2}\b/g, "<HMS>"],
      // 내용 해시: 데모 파일 안에 루트 경로가 들어 있어 루트마다 바뀐다
      [/sha256:[0-9a-f]{64}/g, "sha256:<HASH>"],
      [/<TS14>-[0-9a-f]{8}\b/g, "<TS14>-<HEX8>"],
      [/\bhook:[0-9a-f]{10}\b/g, "hook:<HEX10>"],
      [/\bplan [0-9a-f]{16}\b/g, "plan <HEX16>"],
      [/^[0-9a-f]{12}$|^[0-9a-f]{16}$/g, "<HEX>"],
      // plugin_cli 의 command[0]: 이 PC 에서 찾은 claude 실행 파일(없으면 "claude")
      [/^(?:.*[\\/])?claude\.(?:exe|cmd|bat)$/i, "<CLAUDE>"],
    ];
  }

  normalize(value: unknown): unknown {
    const reps = this.replacers();
    const str = (s: string) => reps.reduce((acc, [re, to]) => acc.replace(re, to), s);
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return str(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(o)) {
          if (EXCLUDE_KEYS.has(k)) continue;
          out[str(k)] = walk(x);
        }
        return out;
      }
      return v;
    };
    const doc = walk(value) as Record<string, unknown> | null;
    if (doc && typeof doc === "object" && !Array.isArray(doc) && MESSAGE_FREE_CODES.has(String(doc.code))) delete doc.message;
    return doc;
  }
}

/**
 * 비교에서 빼는 키(어느 깊이든). 실행마다 또는 루트 경로마다 바뀌는 값이다. 근거는 docs/port-contract-2026-11-20.md 6.3절.
 * detail 은 오류 원문(traceback 이나 외부 프로세스 출력)이라 항상 뺀다.
 */
export const EXCLUDE_KEYS: ReadonlySet<string> = new Set([
  "detail",
  // cas gc: zlib 로 압축한 객체 크기라 내용 속 루트 경로 문자에 따라 바뀐다
  "freed_bytes",
]);

/** message 를 비교하지 않는 code. 예외 원문이 메시지가 된다. */
export const MESSAGE_FREE_CODES: ReadonlySet<string> = new Set(["internal", "crash", "not_implemented"]);

// ----- 케이스 실행 -----

export function loadCases(module?: string): Case[] {
  const all = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, "cases.json"), "utf-8")) as Case[];
  return module ? all.filter((c) => c.module === module) : all;
}

export function expectedPath(id: string): string {
  return path.join(EXPECTED_DIR, `${id}.json`);
}

export function loadExpected(id: string): CaseResult {
  return JSON.parse(fs.readFileSync(expectedPath(id), "utf-8")) as CaseResult;
}

function parseStdout(stdout: string): { doc: unknown; stdout?: string } {
  const t = stdout.trim();
  try {
    return { doc: JSON.parse(t) };
  } catch {
    return { doc: null, stdout: t };
  }
}

/** 템플릿에서 프로필을 되살리고 단계를 실행한다. 반환값은 정규화된 결과. */
export function runCase(demo: Demo, c: Case, runner: Runner): CaseResult {
  demo.reset();
  const raw: StepResult[] = [];
  const steps: StepResult[] = [];
  for (const s of c.steps) {
    for (const m of s.mkdir ?? []) fs.mkdirSync(demo.resolve(m, raw), { recursive: true });
    const argv = s.argv.map((a) => demo.resolve(a, raw));
    const r = runner(c.module, argv, demo.env);
    const parsed = parseStdout(r.stdout);
    raw.push({ argv, exit: r.exit, ...parsed });
    const norm: StepResult = { argv: s.argv, exit: r.exit, doc: demo.normalize(parsed.doc) };
    if (parsed.stdout !== undefined) norm.stdout = demo.normalize(parsed.stdout) as string;
    steps.push(norm);
  }
  return { id: c.id, module: c.module, ...(c.note ? { note: c.note } : {}), steps };
}

/** 두 결과의 차이를 "경로: 기대 -> 실제" 줄로. 같으면 빈 배열. */
export function diffResults(expected: unknown, actual: unknown, at = "$"): string[] {
  if (isDeepStrictEqual(expected, actual)) return [];
  const isObj = (v: unknown) => v !== null && typeof v === "object";
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const out: string[] = [];
    if (expected.length !== actual.length) out.push(`${at}.length: ${expected.length} -> ${actual.length}`);
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) out.push(...diffResults(expected[i], actual[i], `${at}[${i}]`));
    return out;
  }
  if (isObj(expected) && isObj(actual) && !Array.isArray(expected) && !Array.isArray(actual)) {
    const e = expected as Record<string, unknown>, a = actual as Record<string, unknown>;
    const out: string[] = [];
    for (const k of new Set([...Object.keys(e), ...Object.keys(a)])) {
      if (!(k in a)) out.push(`${at}.${k}: 빠짐`);
      else if (!(k in e)) out.push(`${at}.${k}: 추가됨 ${JSON.stringify(a[k]).slice(0, 200)}`);
      else out.push(...diffResults(e[k], a[k], `${at}.${k}`));
    }
    return out;
  }
  return [`${at}: ${JSON.stringify(expected)?.slice(0, 200)} -> ${JSON.stringify(actual)?.slice(0, 200)}`];
}

/** 기준 파일과 비교한다. argv 와 note 는 비교하지 않는다(케이스 정의에서 온다). */
export function compareCase(demo: Demo, c: Case, runner: Runner): string[] {
  const exp = loadExpected(c.id);
  const act = runCase(demo, c, runner);
  const strip = (r: CaseResult) => r.steps.map((s) => ({ exit: s.exit, doc: s.doc, stdout: s.stdout }));
  return diffResults(strip(exp), strip(act));
}

/**
 * node:test 용. 이식 세션의 테스트 파일에서 부른다:
 *   import { goldenSuite } from "../golden/golden.ts";  goldenSuite("cas");
 * 모듈의 케이스마다 test 하나를 만들고 TS 판 출력을 기준 파일과 비교한다.
 */
export function goldenSuite(module: string, opts: { only?: string[] } = {}): void {
  let demo: Demo | null = null;
  before(() => { demo = Demo.create(); });
  after(() => demo?.dispose());
  for (const c of loadCases(module)) {
    if (opts.only && !opts.only.includes(c.id)) continue;
    test(`golden ${c.id}`, () => {
      const diffs = compareCase(demo!, c, tsRunner);
      deepEqual(diffs, [], diffs.join("\n"));
    });
  }
}
