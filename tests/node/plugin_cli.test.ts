// tests/test_plugin_state.py 의 ClaudeCliDelegation 을 옮긴 것 + 가짜 claude.bat 로 실제 위임 경로 확인.
// 위임 전후 스냅샷(tests/test_tracking.py 의 TestCliDelegationSnapshots)은 cas 가 들어온 뒤 옮긴다.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cli from "../../src/core/plugin_cli.ts";

const call = (...args: string[]) => cli.main(args);

/** env 를 잠시 바꿔 fn 을 실행한다. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

describe("argv assembly (dry-run)", () => {
  test("install dry-run builds id and scope", async () => {
    const r = await call("install", "--marketplace", "official", "--plugin", "notion", "--scope", "project", "--dry-run");
    assert.deepEqual([r.ok, r.code, r.target], [true, "dry_run", "notion@official"]);
    assert.deepEqual((r.command as string[]).slice(1), ["plugin", "install", "notion@official", "--scope", "project"]);
    assert.deepEqual(Object.keys(r), ["ok", "code", "message", "target", "dry_run", "command", "cwd", "available"]);
    assert.equal(r.cwd, null);
  });

  test("uninstall always passes -y", async () => {
    // 비-TTY 로 부르므로 확인 프롬프트가 뜨면 응답할 수 없어 타임아웃까지 매달린다.
    const r = await call("uninstall", "--marketplace", "m", "--plugin", "p", "--dry-run");
    assert.deepEqual((r.command as string[]).slice(1), ["plugin", "uninstall", "p@m", "--scope", "user", "-y"]);
  });

  test("update accepts managed scope, install does not", async () => {
    const r = await call("update", "--marketplace", "m", "--plugin", "p", "--scope", "managed", "--dry-run");
    assert.deepEqual((r.command as string[]).slice(1), ["plugin", "update", "p@m", "--scope", "managed"]);
    const bad = await call("install", "--marketplace", "m", "--plugin", "p", "--scope", "managed", "--dry-run");
    assert.deepEqual([bad.ok, bad.code], [false, "invalid_arg"]);
  });

  test("market ops build expected argv", async () => {
    let r = await call("market-add", "owner/repo", "--scope", "project", "--dry-run");
    assert.deepEqual((r.command as string[]).slice(1), ["plugin", "marketplace", "add", "owner/repo", "--scope", "project"]);
    r = await call("market-update", "--dry-run");
    assert.deepEqual([r.target, (r.command as string[]).slice(1)], ["(all)", ["plugin", "marketplace", "update"]]);
    r = await call("market-remove", "--name", "m", "--dry-run");
    // scope 생략 = 모든 스코프에서 제거(claude 기본). 임의로 user 를 끼워 넣지 않는다.
    assert.deepEqual((r.command as string[]).slice(1), ["plugin", "marketplace", "remove", "m"]);
    r = await call("market-add", "owner/repo", "--sparse", "--dry-run");
    assert.deepEqual((r.command as string[]).slice(1), ["plugin", "marketplace", "add", "owner/repo", "--scope", "user"]);
  });

  test("market source only guards option injection", async () => {
    assert.equal((await call("market-add", "./some/local/path", "--dry-run")).ok, true);
    const r = await call("market-add", "--dry-run", "--", "-upload-pack=evil");
    assert.deepEqual([r.ok, r.message, r.target], [false, "Invalid marketplace source: '-upload-pack=evil'", "-upload-pack=evil"]);
    const s = await call("market-add", "o/r", "--sparse", "a", "--dry-run", "--", "x");
    assert.equal(s.ok, false);
  });

  test("option-like name is refused", async () => {
    const r = await call("install", "--marketplace", "m", "--plugin=-upload-pack", "--dry-run");
    assert.deepEqual([r.ok, r.code, r.message], [false, "invalid_arg", "Invalid plugin name: '-upload-pack'"]);
  });

  test("path escape and colon are refused", async () => {
    for (const bad of ["../../etc", "a/b", "a:b", ".."]) {
      assert.equal((await call("install", "--marketplace", "m", "--plugin", bad, "--dry-run")).ok, false, bad);
    }
  });

  test("missing cwd is refused", async () => {
    const r = await call("install", "--marketplace", "m", "--plugin", "p", "--cwd", path.join(os.tmpdir(), "no-such-dir-cm"), "--dry-run");
    assert.deepEqual([r.ok, r.code], [false, "invalid_arg"]);
  });

  test("cmd* entry points give the same document", async () => {
    const r = await cli.cmdMarketRemove({ name: "m", scope: "user", dryRun: true });
    assert.deepEqual((r.command as string[]).slice(1), ["plugin", "marketplace", "remove", "m", "--scope", "user"]);
    const u = await cli.cmdUninstall({ marketplace: "m", plugin: "p", keepData: true, dryRun: true });
    assert.deepEqual((u.command as string[]).slice(-2), ["-y", "--keep-data"]);
  });
});

describe("claude lookup and launch", () => {
  let tmp = "";
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin_cli_test_")); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("reports clearly when claude is not on PATH", async () => {
    const r = await withEnv({ PATH: path.join(tmp, "no-such-dir") }, () =>
      call("install", "--marketplace", "m", "--plugin", "p", "--no-snapshot"));
    assert.deepEqual([r.ok, r.code, r.target], [false, "tool_missing", "p@m"]);
    assert.ok(r.message.includes("claude"));
    assert.deepEqual(r.command, ["claude", "plugin", "install", "p@m", "--scope", "user"]);
  });

  test("dry-run works without claude and says so", async () => {
    const r = await withEnv({ PATH: path.join(tmp, "no-such-dir") }, () =>
      call("install", "--marketplace", "m", "--plugin", "p", "--dry-run"));
    assert.deepEqual([r.ok, r.available], [true, false]);
  });

  test("which keeps PATHEXT case like shutil.which", { skip: process.platform !== "win32" && "windows only" }, async () => {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude.exe"), "");
    const r = await withEnv({ PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, () => call("market-update", "--dry-run"));
    assert.equal((r.command as string[])[0], path.join(bin, "claude.EXE"));
  });

  test("a claude.bat on PATH is launched with the same argv, output decoded like text mode", { skip: process.platform !== "win32" && "windows only" }, async () => {
    const bin = path.join(tmp, "bin dir");
    fs.mkdirSync(bin);
    const log = path.join(tmp, "args.txt");
    // %* 를 그대로 남기고 stdout 에 CRLF 두 줄과 한글, stderr 에 한 줄을 쓴다.
    fs.writeFileSync(path.join(bin, "claude.bat"),
      '@echo off\r\nchcp 65001 >nul\r\necho %*>"%CM_TEST_LOG%"\r\necho line1\r\necho 둘째 줄\r\necho warn 1>&2\r\nexit /b 0\r\n');
    const cwd = path.join(tmp, "proj");
    fs.mkdirSync(cwd);
    // chcp 를 찾도록 원래 PATH 를 뒤에 둔다. 앞에 둔 bin 의 claude.bat 가 먼저 잡힌다.
    const r = await withEnv({ PATH: bin + path.delimiter + (process.env.PATH ?? ""), CM_TEST_LOG: log }, () =>
      call("install", "--marketplace", "m", "--plugin", "p", "--scope", "local", "--cwd", cwd, "--no-snapshot"));
    assert.deepEqual([r.ok, r.code, r.message], [true, "ok", "Installed: p@m (applies from the next session)"], JSON.stringify(r));
    assert.equal(fs.readFileSync(log, "utf8").trim(), "plugin install p@m --scope local");
    assert.deepEqual([r.stdout, r.stderr, r.cwd, r.scope], ["line1\n둘째 줄", "warn", cwd, "local"]);
    assert.equal((r.command as string[])[0], path.join(bin, "claude.BAT"));
  });

  test("a non-zero exit is external_failed with rc and both streams", { skip: process.platform !== "win32" && "windows only" }, async () => {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude.cmd"), "@echo off\r\necho nope 1>&2\r\nexit /b 3\r\n");
    const r = await withEnv({ PATH: bin }, () => call("market-update", "--name", "m", "--no-snapshot"));
    assert.deepEqual([r.ok, r.code, r.rc, r.stderr, r.stdout, r.detail], [false, "external_failed", 3, "nope", "", "nope"]);
    assert.equal(r.message, "claude plugin marketplace update m failed (rc=3)");
    assert.equal(r.scope, undefined);
  });
});
