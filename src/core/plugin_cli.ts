// plugin_cli.ts - `claude plugin ...` 위임(플러그인/마켓플레이스 단위 조작). src/plugin_cli.py 이식.
//
// config-monitor 에서 claude CLI 를 부르는 유일한 자리다. scan 경로는 여기를 import 하지
// 않는다(claude_config -> plugin_state 는 파일만 읽는다). 명령 경로에서만 쓴다.
//
// 왜 손으로 안 쓰고 위임하는가:
// 플러그인 통째 설치는 ~/.claude/plugins/installed_plugins.json 에 기록되는데 그건
// "version": 2 가 붙은 비공개 포맷이고 이미 한 번 마이그레이션했다. 손으로 쓰면 다음
// 버전에서 조용히 깨진다. 설치 자체도 매니페스트 해석 + 소스별 fetch(url / git-subdir /
// str-path / github 4종) + 캐시 배치 + .in_use 마킹이라 재구현할 이유가 없다.
//
// 두 설치 모델을 합치지 않는 이유:
//   Library 모델   항목 1개를 ~/.claude/skills/<name> 로 복사. 이름 평탄. 설치 전 diff·롤백 O.
//                  Claude Desktop 에도 넣을 수 있다(Desktop 엔 플러그인 개념이 없다).
//   Plugins 모델   플러그인 통째를 캐시에 두고 참조. 이름은 <ns>:<item>. 토글로 on/off.
// Claude Code 원장에는 "12개 중 3개를 설치했음"을 담을 필드가 없다. 그래서 Library 모델의
// 설치를 저쪽에 반영하는 건 불가능하고, 반대로 이 모듈이 하는 플러그인 단위 조작은 전부 된다.
//
// 여기서 하지 않는 것:
// - enable / disable: `claude plugin enable|disable` 이 있지만 쓰지 않는다. 그 조작은
//   settings.json 의 enabledPlugins 한 키를 뒤집는 게 전부라서, config_edit 의 plugin-toggle 로
//   직접 쓰면 스냅샷 + .bak + 원자적 쓰기 + 롤백이 공짜로 붙고 claude 가 PATH 에 없어도 된다.
// - auto-update / favorites / mark-for-update: 셋 다 CLI 서브커맨드가 없다(`claude plugin
//   marketplace` 는 add/list/remove/update 뿐). favorites/mark-for-update 는 저장 흔적도 없어 키를
//   추측할 수밖에 없고, 추측으로 남의 설정 파일에 키를 만들지 않는다. auto-update 는 저장 위치가
//   있지만(known_marketplaces.json 의 autoUpdate 와 settings 의 extraKnownMarketplaces[].autoUpdate)
//   claude 가 그 둘을 자기 규칙으로 동기화하므로 사이에 끼어드는 건 별도 판단이 필요하다.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { JsonArgumentParser, emit, guard, pyStr, type CliDoc, type EmitExtra } from "./cli_result.ts";
import * as marketplace from "./marketplace.ts";  // safeSegment: 매니페스트에서 온 이름은 신뢰할 수 없는 입력이다
import * as configEdit from "./config_edit.ts";   // snapshotOnce: CLI 가 settings.json 을 직접 쓰므로 전/후를 이력에 남긴다
import { pyStrip, pyWhich } from "./plugin_units.ts";

/** 모든 서브커맨드 공통(서브커맨드 뒤에 오는 옵션). store 생략 시 env CLAUDE_SNAPSHOT_STORE, 그것도 없으면 cas 기본 스토어. */
export interface CommonOpts {
  cwd?: string;
  dryRun?: boolean;
  store?: string;
  noSnapshot?: boolean;
}

export interface PluginOpts extends CommonOpts {
  marketplace: string;
  plugin: string;
}

const TIMEOUT = 600;  // 설치/갱신은 네트워크 + git 이다. hooks 설치보다 넉넉히 준다.
const WIN = process.platform === "win32";

function out(ok: boolean, code: string, message: string, extra: EmitExtra = {}): never {
  return emit(ok, code, message, extra);
}

// ----- Python 호환 -----

/** subprocess.run(text=True, encoding="utf-8", errors="replace") 의 디코드 + 줄바꿈 변환, 이어서 strip(). */
function pyText(b: Buffer): string {
  const s = new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);
  return pyStrip(s.replace(/\r\n?/g, "\n"));
}

/** subprocess.list2cmdline: CreateProcess 에 넘기는 명령줄(MS C 런타임 인용 규칙). */
function list2cmdline(seq: readonly string[]): string {
  const result: string[] = [];
  for (const arg of seq) {
    let bs = "";
    if (result.length) result.push(" ");
    const needquote = arg.includes(" ") || arg.includes("\t") || !arg;
    if (needquote) result.push('"');
    for (const c of arg) {
      if (c === "\\") bs += c;
      else if (c === '"') {
        result.push("\\".repeat(bs.length * 2), '\\"');
        bs = "";
      } else {
        if (bs) { result.push(bs); bs = ""; }
        result.push(c);
      }
    }
    if (bs) result.push(bs);
    if (needquote) result.push(bs, '"');
  }
  return result.join("");
}

// ----- claude 실행 -----

/**
 * PATH 의 claude 실행 파일. 없으면 null.
 *
 * Windows 에서 npm 전역 설치면 claude.cmd 로 잡힌다. Python 판은 CreateProcess 가 .cmd 를
 * 그대로 실행했지만 Node 는 .bat/.cmd 를 셸 없이 띄우지 않으므로 runClaude 가 cmd.exe 를 거친다.
 */
export function claudePath(): string | null {
  return pyWhich("claude");
}

function noLeadingDash(v: unknown, what: string): string {
  // 리스트 인자라 셸 주입은 없지만, claude CLI 자신이 '-' 로 시작하는 값을 옵션으로 읽는다.
  if (typeof v !== "string" || !v || v.startsWith("-")) {
    out(false, "invalid_arg", `Invalid ${what}: ${marketplace.pyRepr(v)}`, { target: v });
  }
  return v;
}

/**
 * 마켓/플러그인 이름 검증. 경로 세그먼트 규율(marketplace.safeSegment)까지 적용한다.
 * 마켓 소스(owner/repo, URL, 로컬 경로)에는 쓰면 안 된다. 그건 세그먼트가 아니다.
 */
function safeName(v: unknown, what: string): string {
  noLeadingDash(v, what);
  try {
    marketplace.safeSegment(v, what);
  } catch (e) {
    if (e instanceof marketplace.ManifestError) out(false, "invalid_arg", e.message, { target: v });
    throw e;
  }
  return v as string;
}

/**
 * claude 를 띄우고 [종료 코드, stdout, stderr] 를 돌려준다. 시작 실패와 시간 초과는 종료 코드 null.
 * stdin 은 닫아 둔다: 서버 프로세스 안에서 부르면 상속된 stdin 이 MCP 전송 채널이다.
 */
function runClaude(argv: readonly string[], cwd: string | null): Promise<[number | null, string, string]> {
  return new Promise((resolve) => {
    let file = argv[0];
    let args = argv.slice(1);
    const opts: SpawnOptions = { cwd: cwd ?? undefined, stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
    if (WIN && /\.(bat|cmd)$/i.test(file)) {
      // CreateProcess 가 배치 파일에 대해 하는 것과 같은 형태(cmd.exe /c "<명령줄>")로 직접 띄운다.
      file = process.env.ComSpec || "cmd.exe";
      args = ["/c", `"${list2cmdline(argv)}"`];
      opts.windowsVerbatimArguments = true;
    }
    let child: ChildProcess;
    try {
      child = spawn(file, args, opts);
    } catch (e) {
      resolve([null, "", (e as Error).message]);
      return;
    }
    const so: Buffer[] = [];
    const se: Buffer[] = [];
    let done = false;
    const finish = (r: [number | null, string, string]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish([null, "", `Did not finish within ${TIMEOUT} seconds`]);
    }, TIMEOUT * 1000);
    child.stdout!.on("data", (b: Buffer) => so.push(b));
    child.stderr!.on("data", (b: Buffer) => se.push(b));
    child.on("error", (e) => finish([null, "", e.message]));
    child.on("close", (code) => finish([code, pyText(Buffer.concat(so)), pyText(Buffer.concat(se))]));
  });
}

// ----- op 별 argv 조립 -----
// 각 함수는 [claude 뒤에 붙을 인자 리스트, 사람이 읽을 대상 이름] 을 돌려준다.
// 검증은 조립 시점에 한다. 거부되면 프로세스를 아예 띄우지 않는다.

type Op = "install" | "update" | "uninstall" | "market-add" | "market-update" | "market-remove";

interface Args {
  op: Op;
  marketplace?: string;
  plugin?: string;
  scope?: string | null;
  keepData?: boolean;
  source?: string;
  sparse?: string[] | null;
  name?: string | null;
  cwd: string | null;
  dryRun: boolean;
  store: string | null;
  noSnapshot: boolean;
}

function pluginId(a: Args): string {
  return `${safeName(a.plugin, "plugin name")}@${safeName(a.marketplace, "marketplace name")}`;
}

function build(a: Args): [string[], string] {
  switch (a.op) {
    case "install": {
      const pid = pluginId(a);
      return [["plugin", "install", pid, "--scope", a.scope!], pid];
    }
    case "update": {
      const pid = pluginId(a);
      return [["plugin", "update", pid, "--scope", a.scope!], pid];
    }
    case "uninstall": {
      const pid = pluginId(a);
      // -y 를 항상 준다: 우리는 항상 비-TTY 로 부르고, 그 경우 확인 프롬프트가 뜨면
      // 응답할 수 없어 TIMEOUT 까지 매달린다. -y 는 프롬프트를 건너뛸 뿐 대상은 안 늘린다.
      const argv = ["plugin", "uninstall", pid, "--scope", a.scope!, "-y"];
      if (a.keepData) argv.push("--keep-data");
      return [argv, pid];
    }
    case "market-add": {
      // 소스는 owner/repo · URL · 로컬 경로 중 무엇이든 될 수 있어 세그먼트 검증을 못 한다.
      // 옵션 오인만 막고 나머지 판정은 claude 에 맡긴다(저쪽이 자기 형식의 주인이다).
      const src = noLeadingDash(a.source, "marketplace source");
      const argv = ["plugin", "marketplace", "add", src, "--scope", a.scope!];
      for (const s of a.sparse ?? []) noLeadingDash(s, "sparse path");
      if (a.sparse && a.sparse.length) argv.push("--sparse", ...a.sparse);
      return [argv, src];
    }
    case "market-update": {
      // 이름 없이 부르면 전체 갱신이다(claude 의 계약). 그 경우도 명시적으로 보고한다.
      if (!a.name) return [["plugin", "marketplace", "update"], "(all)"];
      const n = safeName(a.name, "marketplace name");
      return [["plugin", "marketplace", "update", n], n];
    }
    case "market-remove": {
      const n = safeName(a.name, "marketplace name");
      const argv = ["plugin", "marketplace", "remove", n];
      // scope 를 생략하면 claude 가 모든 스코프에서 지운다. 그게 기본이지만 조용히
      // 넓게 지우는 셈이라, 호출부가 고를 수 있게 열어 두고 기본은 저쪽 기본을 따른다.
      if (a.scope) argv.push("--scope", a.scope);
      return [argv, n];
    }
  }
  return out(false, "invalid_arg", `Unknown op: ${a.op}`, { target: a.op });
}

const DONE: Record<Op, string> = {
  "install": "Installed", "uninstall": "Uninstalled", "update": "Updated",
  "market-add": "Marketplace added", "market-update": "Marketplace updated", "market-remove": "Marketplace removed",
};
// 마켓 등록/제거는 세션 재시작과 무관하다(선언만 바뀐다). 컴포넌트가 오가는 조작만 안내한다.
const NEEDS_RESTART = new Set<Op>(["install", "uninstall", "update"]);

async function execute(a: Args): Promise<never> {
  const [tail, target] = build(a);
  const exe = claudePath();
  const argv = [exe ?? "claude", ...tail];
  const cwd = a.cwd || null;
  let cwdIsDir = false;
  try {
    cwdIsDir = cwd !== null && fs.statSync(cwd).isDirectory();
  } catch {
    cwdIsDir = false;
  }
  if (cwd && !cwdIsDir) out(false, "invalid_arg", `cwd is not a directory: ${cwd}`, { target: cwd });

  if (a.dryRun) {
    out(true, "dry_run", "Not run (dry-run)", { dry_run: true, target, command: argv, cwd, available: !!exe });
  }
  if (!exe) {
    out(false, "tool_missing", "claude not found on PATH - plugin and marketplace operations are delegated to the Claude Code CLI",
      { target, command: argv });
  }

  // CLI 는 추적 대상(settings.json 의 enabledPlugins 등)을 직접 쓴다. 편집 경로처럼
  // 전/후를 스냅샷해 이력 공백을 막는다. 단, 위임은 최대 600초라 락을 걸쳐 쥘 수 없어
  // (60초 뒤 죽은 락으로 회수됨) 단발 2회로 하고, 그 사이 watcher 가 중간 상태를
  // auto: 로 찍을 수 있는 건 수용한다.
  if (!a.noSnapshot) await configEdit.snapshotOnce(a.store, "external change (before edit)");
  const [rc, so, se] = await runClaude(argv, cwd);
  if (rc !== 0) {
    out(false, "external_failed", `claude ${tail.join(" ")} failed (rc=${pyStr(rc)})`,
      { detail: se || so || null, target, command: argv, cwd, stdout: so, stderr: se, rc });
  }
  const tailMsg = NEEDS_RESTART.has(a.op) ? " (applies from the next session)" : "";
  if (!a.noSnapshot) await configEdit.snapshotOnce(a.store, `${DONE[a.op]}: ${target} (claude CLI)`);
  return out(true, "ok", `${DONE[a.op]}: ${target}${tailMsg}`,
    { target, command: argv, cwd, stdout: so, stderr: se, scope: a.scope ?? null });
}

function common(o: CommonOpts): Pick<Args, "cwd" | "dryRun" | "store" | "noSnapshot"> {
  return {
    cwd: o.cwd ?? null,
    dryRun: !!o.dryRun,
    store: o.store !== undefined ? o.store : process.env.CLAUDE_SNAPSHOT_STORE ?? null,
    noSnapshot: !!o.noSnapshot,
  };
}

function run(a: () => Args): Promise<CliDoc> {
  return guard(() => execute(a()));
}

export async function cmdInstall(opts: PluginOpts & { scope?: "user" | "project" | "local" }): Promise<CliDoc> {
  return run(() => ({ op: "install", marketplace: opts.marketplace, plugin: opts.plugin, scope: opts.scope ?? "user", ...common(opts) }));
}

export async function cmdUpdate(opts: PluginOpts & { scope?: "user" | "project" | "local" | "managed" }): Promise<CliDoc> {
  return run(() => ({ op: "update", marketplace: opts.marketplace, plugin: opts.plugin, scope: opts.scope ?? "user", ...common(opts) }));
}

export async function cmdUninstall(opts: PluginOpts & { scope?: "user" | "project" | "local"; keepData?: boolean }): Promise<CliDoc> {
  return run(() => ({
    op: "uninstall", marketplace: opts.marketplace, plugin: opts.plugin, scope: opts.scope ?? "user",
    keepData: !!opts.keepData, ...common(opts),
  }));
}

export async function cmdMarketAdd(opts: CommonOpts & { source: string; scope?: "user" | "project" | "local"; sparse?: string[] }): Promise<CliDoc> {
  return run(() => ({ op: "market-add", source: opts.source, scope: opts.scope ?? "user", sparse: opts.sparse ?? null, ...common(opts) }));
}

export async function cmdMarketUpdate(opts: CommonOpts & { name?: string }): Promise<CliDoc> {
  return run(() => ({ op: "market-update", name: opts.name ?? null, ...common(opts) }));
}

export async function cmdMarketRemove(opts: CommonOpts & { name: string; scope?: "user" | "project" | "local" }): Promise<CliDoc> {
  return run(() => ({ op: "market-remove", name: opts.name, scope: opts.scope ?? null, ...common(opts) }));
}

function parser(): JsonArgumentParser {
  const ap = new JsonArgumentParser("plugin_cli");
  const sub = ap.addSubparsers({ dest: "op", required: true });
  const made: JsonArgumentParser[] = [];
  const add = (name: string) => {
    const p = sub.addParser(name);
    made.push(p);
    return p;
  };
  const pluginOp = (name: string, scopes: string[]) => {
    const p = add(name);
    p.addArgument("--marketplace", { required: true });
    p.addArgument("--plugin", { required: true });
    p.addArgument("--scope", { choices: scopes, default: "user" });
    return p;
  };
  pluginOp("install", ["user", "project", "local"]);
  // update 만 managed 스코프를 받는다(claude plugin update --help 실측).
  pluginOp("update", ["user", "project", "local", "managed"]);
  pluginOp("uninstall", ["user", "project", "local"]).addArgument("--keep-data", { action: "store_true" });

  let p = add("market-add");
  p.addArgument("source");
  p.addArgument("--scope", { choices: ["user", "project", "local"], default: "user" });
  p.addArgument("--sparse", { nargs: "*", default: null });
  p = add("market-update");
  p.addArgument("--name", { default: null });
  p = add("market-remove");
  p.addArgument("--name", { required: true });
  p.addArgument("--scope", { choices: ["user", "project", "local"], default: null });

  // 모든 op 이 공유하는 옵션. 서브파서마다 따로 달아야 하위 파서가 인식한다.
  for (const sp of made) {
    sp.addArgument("--cwd", { default: null });
    sp.addArgument("--dry-run", { action: "store_true" });
    sp.addArgument("--store", { default: process.env.CLAUDE_SNAPSHOT_STORE ?? null });
    sp.addArgument("--no-snapshot", { action: "store_true" });
  }
  return ap;
}

/** argv 는 python plugin_cli.py 의 인자와 같다. */
export async function main(argv: string[]): Promise<CliDoc> {
  return guard(() => {
    const ns = parser().parse(argv);
    const a: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ns)) a[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
    return execute(a as unknown as Args);
  });
}
