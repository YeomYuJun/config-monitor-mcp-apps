// tests/test_tracking.py 의 TestWatcherTick 을 옮긴 것 + watcher.json 형식과 Node 프로세스 기동 확인.
// 스냅샷 구간 락(config_edit.snapshot_before) 을 쓰는 테스트는 config_edit 이 있어야 해서 옮기지 않았다.
process.env.CLAUDE_CAS_NO_DEFAULT_TRACK = "1";
process.env.CLAUDE_CAS_LOCK_WAIT = "0.2";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cas from "../../src/core/cas.ts";
import * as watcher from "../../src/core/watcher.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WATCHER = [path.join(ROOT, "src", "server-stdio.ts"), "--watcher"];

let tmp = "", store = "", file = "";
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "watcher_test_"));
  store = path.join(tmp, "store");
  const work = path.join(tmp, "proj", ".claude");
  fs.mkdirSync(work, { recursive: true });
  file = path.join(work, "settings.json");
  fs.writeFileSync(file, '{\n  "keep": true\n}');
  await cas.main(["--store", store, "init"]);
  await cas.main(["--store", store, "track", file]);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("tick snapshots changes and idles when clean", async () => {
  const p = cas.storePaths(store);
  const first = await watcher.tick(p);
  assert.ok(first && first.startsWith("auto:"));
  assert.equal(await watcher.tick(p), null);
  fs.writeFileSync(file, '{\n  "keep": false\n}');
  const again = await watcher.tick(p);
  assert.ok(again && again.includes("settings.json"));
});

test("tick message lists three names then the rest", async () => {
  for (let i = 0; i < 5; i++) {
    const f = path.join(tmp, `f${i}.txt`);
    fs.writeFileSync(f, String(i));
    await cas.main(["--store", store, "track", f]);
  }
  assert.equal(await watcher.tick(cas.storePaths(store)), "auto: f0.txt, f1.txt, f2.txt +3 more");
});

test("tick ignores an ignored-key-only save and returns null while the snapshot lock is held", async () => {
  const p = cas.storePaths(store);
  await watcher.tick(p);
  fs.writeFileSync(file, '{\n  "keep": true,\n  "feedbackDrafts": {"x": 1}\n}');
  assert.equal(await watcher.tick(p), null);
  assert.equal(cas.snapshotIds(p).length, 1);
  fs.writeFileSync(file, '{\n  "keep": "locked"\n}');
  const h = await cas.acquireSnapshotLock(p);
  try {
    assert.equal(await watcher.tick(p), null);
  } finally {
    h.release();
  }
  assert.ok(await watcher.tick(p));
});

test("write_state makes status report running; heartbeat format", async () => {
  const p = cas.storePaths(store);
  assert.equal(cas.watcherState(store).running, false);
  watcher.writeState(p, 2000, "2026-01-01T00:00:00", "");
  const st = cas.watcherState(store);
  assert.equal(st.running, true);
  const raw = fs.readFileSync(path.join(store, "watcher.json"), "utf8");
  const j = JSON.parse(raw);
  assert.deepEqual(Object.keys(j), ["pid", "started", "heartbeat", "debounceMs", "dirs", "lastEvent"]);
  assert.match(j.heartbeat, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?[+-]\d\d:\d\d$/);
  assert.deepEqual(j.dirs, [file]);
  if (process.platform === "win32") assert.ok(raw.includes("\r\n"));
});

test("safe_tick reports an exception instead of raising", async () => {
  const p = cas.storePaths(store);
  fs.writeFileSync(p.index, "{broken");
  const [msg, err] = await watcher.safeTick(p);
  assert.equal(msg, null);
  assert.match(String(err), /^JSONDecodeError: /);
});

test("watcher process: missing config exits 1, bad args exit 2, runs and cleans up watcher.json", async () => {
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", ...WATCHER, ...args], { cwd: ROOT, encoding: "utf-8", windowsHide: true });
  const miss = run(["--store", path.join(tmp, "none")]);
  assert.equal(miss.status, 1);
  assert.match(miss.stdout, /config\.json not found/);
  const bad = run(["--interval-ms", "x"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /watcher: error: argument --interval-ms: invalid int value: 'x'/);
  const child = spawn(process.execPath, ["--import", "tsx", ...WATCHER, "--store", store, "--interval-ms", "200"], {
    cwd: ROOT, windowsHide: true, env: { ...process.env, CLAUDE_CAS_NO_DEFAULT_TRACK: "1" },
  });
  const wj = path.join(store, "watcher.json");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(fs.existsSync(wj) && cas.snapshotIds(cas.storePaths(store)).length)) await new Promise((r) => setTimeout(r, 100));
  assert.equal(cas.watcherState(store).running, true);
  assert.equal(cas.snapshotIds(cas.storePaths(store)).length, 1);
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
});
