// 실제 cas 스토어에 대고 도는 config_edit / plugin_cli 테스트. tests/test_tracking.py 의
// TestEditSnapshotAttribution, TestSnapshotSpanLock, TestCliDelegationSnapshots, TestIgnoreProfile 의 스냅샷 부분과
// tests/test_item_edit.py 의 LAZY·EAGER 배지 왕복을 옮긴 것 + 한 프로세스 안에서 겹친 편집.
process.env.CLAUDE_CAS_NO_DEFAULT_TRACK = "1";   // 기본 추적 대상(실사용자 파일)이 테스트 스토어에 합류하지 않게
process.env.CLAUDE_CAS_LOCK_WAIT = "0.2";        // 락 경합 테스트가 기본 8초 대기를 하지 않게

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cas from "../../src/core/cas.ts";
import * as cc from "../../src/core/claude_config.ts";
import * as ce from "../../src/core/config_edit.ts";
import * as cli from "../../src/core/plugin_cli.ts";
import * as watcher from "../../src/core/watcher.ts";

let tmp = "", store = "", file = "";
const casMain = (...args: string[]) => cas.main(["--store", store, ...args]);
const writeLf = (text: string) => fs.writeFileSync(file, text, "utf8");
const messages = async () => ((await casMain("history", file, "--json")).revisions as { message: string }[]).map((r) => r.message);
const edit = (rule: string) => ce.main(["--store", store, "--settings", file, "perm-add", "allow", rule]);
const lockPath = () => path.join(store, "snapshot.lock");

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config_edit_snap_"));
  store = path.join(tmp, "store");
  file = path.join(tmp, "proj", ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeLf('{\n  "keep": true\n}');
  await casMain("init");
  await casMain("track", file);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("edit snapshot attribution", () => {
  test("op message lands on its own revision", async () => {
    assert.equal((await edit("Bash(one*)")).ok, true);
    const msgs = await messages();
    assert.ok(msgs.length && msgs[msgs.length - 1].includes("permissions.allow"));
    assert.ok(!fs.existsSync(lockPath()));
  });

  test("consecutive edits skip the pre-snapshot", async () => {
    await casMain("snapshot", "-m", "base");   // 추적 직후 상태를 먼저 확정(이후 드리프트 없음)
    await edit("Bash(one*)");
    await edit("Bash(two*)");
    const msgs = await messages();
    // 연속 편집 사이에는 드리프트가 없으므로 pre-스냅샷이 발화하면 안 된다.
    assert.ok(!msgs.includes("external change (before edit)"));
    assert.ok(msgs.includes("Added: permissions.allow += 'Bash(one*)'"));
    assert.ok(msgs.includes("Added: permissions.allow += 'Bash(two*)'"));
  });

  test("external drift is captured before the edit", async () => {
    await casMain("snapshot", "-m", "base");
    await edit("Bash(one*)");
    writeLf('{\n  "hand": "edit"\n}');   // 대시보드 밖 편집 후 다음 편집
    await edit("Bash(two*)");
    assert.ok((await messages()).includes("external change (before edit)"));
  });
});

test("span blocks the watcher and records the op message", async () => {
  await casMain("snapshot", "-m", "base");
  const p = cas.storePaths(store);
  writeLf('{\n  "keep": "drift"\n}');            // 대시보드 밖 편집
  await ce.snapshotBefore(store);
  try {
    assert.ok(fs.existsSync(lockPath()));        // 스팬 동안 락 유지
    writeLf('{\n  "keep": "op-result"\n}');      // 편집 본문에 해당
    assert.equal(await watcher.tick(p), null);   // 락에 막혀 못 가로챔
  } finally {
    await ce.snapshotAfter(store, "op done");
  }
  assert.ok(!fs.existsSync(lockPath()));
  const msgs = await messages();
  assert.ok(msgs.includes("external change (before edit)"));
  assert.equal(msgs[msgs.length - 1], "op done");
});

test("snapshotOnce takes one snapshot and does not keep the lock", async () => {
  await casMain("snapshot", "-m", "base");
  writeLf('{\n  "keep": "once"\n}');
  await ce.snapshotOnce(store, "single");
  assert.ok(!fs.existsSync(lockPath()));
  assert.equal((await messages()).at(-1), "single");
});

test("ignored-only change is not a revision through the edit span either", async () => {
  const cfgPath = path.join(store, "config.json");
  const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  c.ignore_keys = { "settings.json": ["feedbackDrafts"] };
  fs.writeFileSync(cfgPath, JSON.stringify(c));
  await casMain("snapshot", "-m", "base");
  writeLf('{\n  "keep": true,\n  "feedbackDrafts": {"x": 1}\n}');
  assert.equal(await watcher.tick(cas.storePaths(store)), null);
  await ce.snapshotBefore(store);   // 편집 전 드리프트 캡처도 같은 판정을 탄다
  await ce.snapshotAfter(store, "op");
  assert.equal((await messages()).length, 1);
});

test("delegation is wrapped with before/after snapshots", { skip: process.platform !== "win32" && "fake claude.bat is windows only" }, async () => {
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude.bat"), '@echo delegated>>"%CM_TEST_FILE%"\r\n@exit /b 0\r\n', "ascii");
  const r = await withEnv({ CM_TEST_FILE: file, PATH: bin + path.delimiter + (process.env.PATH ?? "") }, () =>
    cli.main(["install", "--marketplace", "m", "--plugin", "p", "--store", store]));
  assert.equal(r.ok, true, JSON.stringify(r));
  const msgs = await messages();
  assert.ok(msgs.includes("external change (before edit)"));   // 위임 전 미스냅샷 상태 캡처
  assert.equal(msgs.at(-1), "Installed: p@m (claude CLI)");        // 위임 결과가 제 메시지로
  assert.ok(!fs.existsSync(lockPath()));
});

test("concurrent edits in one process keep both results and their own revisions", async () => {
  await casMain("snapshot", "-m", "base");
  const rules = ["Bash(a*)", "Bash(b*)", "Bash(c*)", "Bash(d*)"];
  const docs = await Promise.all(rules.map((r) => edit(r)));
  assert.deepEqual(docs.map((d) => d.code), ["ok", "ok", "ok", "ok"]);
  const allow = JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow;
  assert.deepEqual([...allow].sort(), rules);   // 읽기-쓰기가 겹쳐 서로를 덮지 않는다
  const msgs = await messages();
  for (const r of rules) assert.ok(msgs.includes(`Added: permissions.allow += '${r}'`), r);
  assert.ok(!msgs.includes("external change (before edit)"));   // 남의 편집을 드리프트로 잡지 않는다
  assert.ok(!fs.existsSync(lockPath()));
});

describe("load badges after scaffold and output style edits", () => {
  let cdir = "", settings = "";
  beforeEach(() => {
    cdir = path.join(tmp, "root", ".claude");
    settings = path.join(cdir, "settings.json");
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(settings, "{}");
  });
  const scaffold = (kind: string, sub: string, name: string, ...extra: string[]) =>
    ce.main(["--settings", settings, "--items-dir", path.join(cdir, sub), "--no-snapshot", "item-scaffold", kind, name, ...extra]);

  test("rule paths flag round-trips to the lazy badge", async () => {
    assert.equal((await scaffold("rule", "rules", "eager-one")).ok, true);
    assert.equal((await scaffold("rule", "rules", "lazy-one", "--paths", "tests/**")).ok, true);
    const by = Object.fromEntries(cc.rulesCards(path.join(cdir, "rules")).map((c) => [c.name, c]));
    assert.equal(by["eager-one"].load, "eager");
    assert.equal(by["lazy-one"].load, "lazy");
  });

  test("output style activation moves the eager badge", async () => {
    const osd = path.join(cdir, "output-styles");
    await scaffold("output-style", "output-styles", "terse");
    await scaffold("output-style", "output-styles", "verbose");
    // '+ 새 ...' 스캐폴드 카드는 항목이 아니라 적재 등급이 없다.
    const loads = () => Object.fromEntries(cc.outputStyleCards(osd, cc.activeOutputStyle([settings]))
      .filter((c) => !cc.isAddCard(c)).map((c) => [c.name, c.load]));
    assert.deepEqual(new Set(Object.values(loads())), new Set(["never"]));
    await ce.main(["--settings", settings, "--no-snapshot", "outputstyle-set", "terse"]);
    const after = loads();
    assert.equal(after.terse, "eager");
    assert.equal(after.verbose, "never");
  });
});
