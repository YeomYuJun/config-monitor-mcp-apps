// tests/test_tracking.py, tests/test_smoke.py 의 cas 부분을 옮긴 것 + Python 판과 디스크 형식이 같은지 확인.
// config_edit, plugin_cli 가 있어야 하는 테스트(편집 후행 스냅샷, 스냅샷 구간 락, CLI 위임)는 옮기지 않았다.
process.env.CLAUDE_CAS_NO_DEFAULT_TRACK = "1";   // 기본 추적 대상(실사용자 파일)이 테스트 스토어에 합류하지 않게
process.env.CLAUDE_CAS_LOCK_WAIT = "0.2";        // 락 경합 테스트가 기본 8초 대기를 하지 않게

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import * as cas from "../../src/core/cas.ts";
import type { CliDoc } from "../../src/core/cli_result.ts";
import { pyOracle, readTree, writeTree, type Subst } from "./py_oracle.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(ROOT, "src");
const PY = "python";   // 기록 모드(CM_PY_RECORD=1)에서만 실행된다
const WIN = process.platform === "win32";
const oracle = pyOracle("cas");
// 기록과 같은 입력이 되도록 Python 과 비교하는 파일의 mtime 을 고정한다(index.json 에 mtime_ns 가 들어간다).
const FIXED_MTIME = 1_700_000_000;
const sub = (): Subst => ({ "<TMP>": tmp, "<HOME>": process.env.USERPROFILE ?? "" });

/** python src/<script> 의 stdout(기록). 스토어를 쓰는 호출은 tree 로 그 폴더를 함께 기록하고 되살린다. */
function pyRun(script: string, args: string[], tree?: string): { rc: number; out: string } {
  const rec = oracle(`run ${script} ${args.join(" ")}`, sub(), () => {
    const r = spawnSync(PY, [path.join(SRC, script), ...args], {
      encoding: "utf-8", windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", CLAUDE_CAS_NO_DEFAULT_TRACK: "1" },
    });
    return { rc: r.status ?? -1, out: r.stdout, tree: tree ? readTree(tree) : undefined };
  });
  if (tree && rec.tree && process.env.CM_PY_RECORD !== "1") writeTree(tree, rec.tree);
  return { rc: rec.rc, out: rec.out };
}

function pyEval(code: string, input: unknown): unknown {
  return oracle(`eval ${code} ${JSON.stringify(input)}`, sub(), () => {
    const r = spawnSync(PY, ["-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(SRC)})\nARG = json.loads(sys.stdin.read())\n${code}`], {
      encoding: "utf-8", input: JSON.stringify(input), windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", CLAUDE_CAS_NO_DEFAULT_TRACK: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as unknown;
  });
}

let tmp = "", store = "", work = "", file = "";
const casMain = (...args: string[]) => cas.main(["--store", store, ...args]);
const writeLf = (text: string, f = file) => fs.writeFileSync(f, text, "utf8");
const history = async (f = file) => (await casMain("history", f, "--json")).revisions as Record<string, unknown>[];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cas_test_"));
  store = path.join(tmp, "store");
  work = path.join(tmp, "proj", ".claude");
  fs.mkdirSync(work, { recursive: true });
  file = path.join(work, "settings.json");
  writeLf('{\n  "keep": true\n}');
  await casMain("init");
  await casMain("track", file);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ----- test_tracking.py -----

test("snapshot and cat emit one json document", async () => {
  await casMain("snapshot", "-m", "a", "--json");
  const again = await casMain("snapshot", "-m", "b", "--json");
  assert.deepEqual([again.ok, again.code], [true, "noop"]);
  const c = await casMain("cat", file, "--json");
  assert.equal(c.content, fs.readFileSync(file, "utf8"));
  const miss = await casMain("cat", file + ".nope", "--json");
  assert.deepEqual([miss.ok, miss.code], [false, "not_tracked"]);
});

test("eol only change reports no content diff", async () => {
  await casMain("snapshot", "-m", "base");
  writeLf('{\r\n  "keep": true\r\n}');
  assert.equal((await casMain("diff", file, "--json")).kind, "eol_or_bom_only");
});

test("empty ref shows first revision as full addition", async () => {
  await casMain("snapshot", "-m", "base");
  const rev = (await history())[0].snapshot as string;
  const d = (await casMain("diff", file, "--from", "empty", "--to", rev)).diff as string;
  assert.ok(d.includes('+  "keep": true'));
  assert.ok(!d.includes("\n-"));
});

test("real change shows only changed lines", async () => {
  await casMain("snapshot", "-m", "base");
  fs.writeFileSync(file, '{\r\n  "keep": false\r\n}');
  const d = (await casMain("diff", file)).diff as string;
  assert.ok(d.includes('-  "keep": true') && d.includes('+  "keep": false'));
  assert.ok(!d.includes("-{"));
});

test("gc drops old, keeps latest and current objects", async () => {
  const snapFiles = () => fs.readdirSync(path.join(store, "snapshots")).filter((n) => n.endsWith(".json")).sort();
  const objCount = () => {
    let n = 0;
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : n++));
    walk(path.join(store, "objects"));
    return n;
  };
  const age = (name: string) => {
    const f = path.join(store, "snapshots", name);
    const m = JSON.parse(fs.readFileSync(f, "utf8"));
    m.time = "2020-01-01T00:00:00";
    fs.writeFileSync(f, JSON.stringify(m));
  };
  await casMain("snapshot", "-m", "old");
  writeLf('{\n  "keep": 2\n}');
  await casMain("snapshot", "-m", "new");
  age(snapFiles()[0]);
  const before = objCount();
  let out = await casMain("gc", "--json", "--keep-days", "30", "--dry-run");
  assert.equal(out.removed_snapshots, 1);
  assert.equal(snapFiles().length, 2);
  out = await casMain("gc", "--json", "--keep-days", "30");
  assert.equal(out.removed_snapshots, 1);
  assert.equal(snapFiles().length, 1);
  assert.equal(objCount(), before - 1);
  const rev = (await history()).at(-1)!.snapshot as string;
  const r = await casMain("restore", file, "--from", rev);
  assert.ok(r.ok, JSON.stringify(r));
});

test("gc never drops the newest manifest", async () => {
  await casMain("snapshot", "-m", "only");
  const d = path.join(store, "snapshots");
  const name = fs.readdirSync(d)[0];
  const m = JSON.parse(fs.readFileSync(path.join(d, name), "utf8"));
  m.time = "2020-01-01T00:00:00";
  fs.writeFileSync(path.join(d, name), JSON.stringify(m));
  assert.equal((await casMain("gc", "--json", "--keep-days", "30")).removed_snapshots, 0);
});

test("status json carries watcher and last snapshot; corrupt watcher.json does not kill status", async () => {
  const out = await casMain("status", "--json");
  assert.equal((out.watcher as Record<string, unknown>).running, false);
  assert.ok("last_snapshot" in out);
  fs.writeFileSync(path.join(store, "watcher.json"), "{broken");
  const st = cas.watcherState(store);
  assert.equal(st.running, false);
  assert.match(String(st.reason), /Failed to read watcher\.json: JSONDecodeError: Expecting property name/);
});

test("scan keeps previous entry when file is unreadable", { skip: !WIN }, async () => {
  const p = cas.storePaths(store);
  await cas.takeSnapshot(p, "base");
  const config = await cas.loadConfig(p);
  const index = cas.loadIndex(p);
  const key = Object.keys(index)[0];
  writeLf('{\n  "keep": "size changed"\n}');
  // 공유 없이 연 핸들이 있으면 Windows 에서 읽기가 EBUSY 로 실패한다(Python 테스트의 PermissionError mock 대신 실제 잠금).
  const { spawn } = await import("node:child_process");
  const child = spawn("powershell", ["-NoProfile", "-Command",
    `$f=[IO.File]::Open('${file}','Open','ReadWrite','None'); Write-Output locked; Start-Sleep -Seconds 3; $f.Close()`], { windowsHide: true });
  await new Promise<void>((res) => child.stdout.once("data", () => res()));
  try {
    const [result, newIndex] = cas.scan(p, config, index, false);
    assert.ok(result.unchanged.includes(key));
    assert.deepEqual(newIndex[key], index[key]);
  } finally {
    const exited = new Promise((res) => child.once("exit", res));
    child.kill();
    await exited;
  }
});

test("ignored-only change is not a revision", async () => {
  await casMain("snapshot", "-m", "base");
  writeLf('{\n  "keep": true,\n  "feedbackDrafts": {"x": 1}\n}');
  assert.deepEqual((await casMain("status", "--json")).modified, []);
  assert.equal((await history()).length, 1);
  const d = await casMain("diff", file, "--json");
  assert.deepEqual([d.kind, d.ignored], ["ignored_only", "feedbackDrafts"]);
  assert.ok(String((await casMain("diff", file, "--raw")).diff).includes("feedbackDrafts"));
});

test("mixed change shows significant keys and notes the rest", async () => {
  await casMain("snapshot", "-m", "base");
  writeLf('{\n  "keep": false,\n  "feedbackDrafts": {"x": 1}\n}');
  await casMain("snapshot", "-m", "edit");
  const [r0, r1] = (await history()).map((r) => r.snapshot as string);
  const d = await casMain("diff", file, "--json", "--from", r0, "--to", r1);
  assert.equal(d.kind, "diff");
  assert.ok(String(d.diff).includes('-  "keep": true') && String(d.diff).includes('+  "keep": false'));
  assert.ok(!String(d.diff).includes("feedbackDrafts"));
  assert.equal(d.ignored, "feedbackDrafts");
});

function setIgnore(rules: string[]): void {
  const cfgPath = path.join(store, "config.json");
  const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  c.ignore_keys = { "settings.json": rules };
  fs.writeFileSync(cfgPath, JSON.stringify(c));
}

test("config rules: wildcard, subtree and keep exceptions", async () => {
  setIgnore(["!feedbackDrafts", "hooks", "!hooks.b", "meta.*.ts"]);
  const base = '{\n  "keep": true,\n  "hooks": {"a": {"ts": 1}, "b": {"ts": 2}},\n  "meta": {"x": {"ts": 1}},\n  "feedbackDrafts": 1\n}';
  writeLf(base);
  await casMain("snapshot", "-m", "base");
  const modified = async () => (await casMain("status", "--json")).modified;
  writeLf(base.replace('"a": {"ts": 1}', '"a": {"ts": 9}').replace('"x": {"ts": 1}', '"x": {"ts": 9}'));
  assert.deepEqual(await modified(), []);
  writeLf(base.replace('"b": {"ts": 2}', '"b": {"ts": 8}'));
  assert.deepEqual(await modified(), [file]);
  writeLf(base.replace('"feedbackDrafts": 1', '"feedbackDrafts": 2'));
  assert.deepEqual(await modified(), [file]);
});

test("unparsable content falls back to raw hash", async () => {
  await casMain("snapshot", "-m", "base");
  writeLf("{ broken");
  assert.deepEqual((await casMain("status", "--json")).modified, [file]);
  await casMain("snapshot", "-m", "broken");
  const [r0, r1] = (await history()).map((r) => r.snapshot as string);
  assert.ok(String((await casMain("diff", file, "--from", r0, "--to", r1)).diff).includes("@@"));
});

test("history folds revisions that differ only in ignored keys; warm sig cache", async () => {
  setIgnore(["!feedbackDrafts"]);
  for (let i = 0; i < 3; i++) {
    writeLf(`{\n  "keep": true,\n  "feedbackDrafts": ${i}\n}`);
    await casMain("snapshot", "-m", `noise ${i}`);
  }
  assert.equal((await history()).length, 3);
  setIgnore([]);
  assert.equal((await history()).length, 1);
  const cache = path.join(store, "sig-cache.json");
  assert.ok(fs.existsSync(cache));
  fs.unlinkSync(cache);
  const p = cas.storePaths(store);
  const config = await cas.loadConfig(p);
  assert.equal(cas.warmSigCache(p, config, 1), 2);
  assert.equal(cas.warmSigCache(p, config, 8), 0);
  assert.equal(cas.warmSigCache(p, config, 8), 0);
});

test("default-valued project entries are ignored", async () => {
  const f = path.join(work, ".claude.json");
  writeLf('{"projects": {}}', f);
  await casMain("track", f);
  await casMain("snapshot", "-m", "base");
  writeLf('{"projects": {"/a": {"allowedTools": [], "hasTrustDialogAccepted": false}}}', f);
  assert.deepEqual((await casMain("status", "--json")).modified, []);
  writeLf('{"projects": {"/a": {"allowedTools": [], "hasTrustDialogAccepted": true}}}', f);
  assert.deepEqual((await casMain("status", "--json")).modified, [f]);
  await casMain("snapshot", "-m", "trust");
  const revs = await history(f);
  const d = await casMain("diff", f, "--from", revs[0].snapshot as string, "--to", revs[1].snapshot as string);
  assert.ok(String(d.diff).includes('+      "hasTrustDialogAccepted": true'));
  assert.ok(!String(d.diff).includes("# Ignored keys"));
});

test("interrupted object write leaves no blob", () => {
  const p = cas.storePaths(store);
  const rename = fs.renameSync;
  (fs as { renameSync: unknown }).renameSync = () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
  try {
    assert.throws(() => cas.writeObject(p, Buffer.from("partial-content")));
  } finally {
    (fs as { renameSync: unknown }).renameSync = rename;
  }
  assert.ok(!fs.existsSync(cas.objectPath(p, cas.hashBytes(Buffer.from("partial-content")))));
});

test("snapshot lock: release keeps a lock taken over by another holder, removes own lock", async () => {
  const p = cas.storePaths(store);
  const lock = path.join(store, "snapshot.lock");
  await cas.withSnapshotLock(p, () => fs.writeFileSync(lock, JSON.stringify({ pid: 0, token: "other-holder" })));
  assert.ok(fs.existsSync(lock));
  fs.unlinkSync(lock);
  await cas.withSnapshotLock(p, () => undefined);
  assert.ok(!fs.existsSync(lock));
});

test("untracked path is refused; untracked file with snapshot history still diffs", async () => {
  await casMain("snapshot", "-m", "s1");
  const other = path.join(tmp, "secret.txt");
  fs.writeFileSync(other, "secret-value");
  const out = await casMain("diff", other);
  assert.equal(out.ok, false);
  assert.ok(!JSON.stringify(out).includes("secret-value"));
  const sid = cas.snapshotIds(cas.storePaths(store)).at(-1)!;
  await casMain("untrack", file);
  writeLf('{\n  "keep": false\n}');
  assert.ok(String((await casMain("diff", "--from", sid, file)).diff).includes('+  "keep": false'));
});

// ----- test_smoke.py CasRoundTrip, TrackProjectPreset -----

test("snapshot refuses while another holds the lock; stale lock is broken", async () => {
  writeLf('{"x": 2}');
  const lock = path.join(store, "snapshot.lock");
  fs.writeFileSync(lock, '{"pid": 1}');
  const r = await casMain("snapshot", "-m", "blocked", "--json");
  assert.deepEqual([r.ok, r.code], [false, "lock_timeout"]);
  assert.match(r.message, /in progress/);
  assert.deepEqual(fs.readdirSync(path.join(store, "snapshots")), []);
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(lock, old, old);
  const ok = await casMain("snapshot", "-m", "after stale", "--json");
  assert.equal(ok.ok, true);
  assert.ok(!fs.existsSync(lock));
});

test("full flow: snapshot, status, modify, diff, history, restore", async () => {
  const target = path.join(tmp, "target.txt");
  fs.writeFileSync(target, "v1 line A\nv1 line B\n");
  await casMain("track", target);
  const sid = (await casMain("snapshot", "-m", "baseline", "--json")).snapshot as string;
  assert.ok(((await casMain("status", "--json")).unchanged as string[]).includes(target));
  fs.writeFileSync(target, "v2 CHANGED\nv1 line B\n");
  assert.ok(((await casMain("status", "--json")).modified as string[]).includes(target));
  assert.ok(String((await casMain("diff", target, "--from", sid)).diff).includes("v2 CHANGED"));
  assert.ok((await history(target)).length);
  const res = await casMain("restore", target, "--from", sid);
  assert.ok(res.ok);
  assert.ok(res.pre_snapshot && res.post_snapshot && res.pre_snapshot !== res.post_snapshot, "같은 밀리초의 두 스냅샷도 id 가 달라야 한다");
  for (const s of [res.pre_snapshot, res.post_snapshot]) assert.ok(fs.existsSync(path.join(store, "snapshots", `${s}.json`)));
  assert.equal(fs.readFileSync(target, "utf8"), "v1 line A\nv1 line B\n");
});

test("cat returns CRLF content and BOM as-is", async () => {
  const f = path.join(tmp, "crlf.txt");
  fs.writeFileSync(f, "﻿A\r\nB\r\n");
  await casMain("track", f);
  await casMain("snapshot", "-m", "base");
  assert.equal((await casMain("cat", f, "--json")).content, "﻿A\r\nB\r\n");
  assert.ok(!String((await casMain("diff", f)).diff).includes("\r\r\n"));
});

test("watcher-status: no watcher, BOM + tz-aware heartbeat, 7-digit fraction", async () => {
  assert.equal((await casMain("watcher-status")).running, false);
  const now = new Date();
  const off = -now.getTimezoneOffset();
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = new Date(now.getTime() + off * 60_000).toISOString().slice(0, 19);
  const tz = `${off < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  const wj = path.join(store, "watcher.json");
  for (const hb of [`${local}.123456${tz}`, `${local}.1970395${tz}`]) {
    fs.writeFileSync(wj, "﻿" + JSON.stringify({ pid: 9999, started: hb, heartbeat: hb, debounceMs: 2000, dirs: [] }), "utf8");
    const s = await casMain("watcher-status");
    assert.equal(s.error, null, String(s.error));
    assert.equal(s.running, true);
    assert.equal(typeof s.age_sec, "number");
  }
});

async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const keys = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CLAUDE_CAS_NO_DEFAULT_TRACK"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local") });
  delete process.env.CLAUDE_CAS_NO_DEFAULT_TRACK;
  try {
    return await fn(home);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("default tracked merge, untrack is not resurrected, defaults match buckets", async () => {
  await withFakeHome(async (home) => {
    const cj = path.join(home, ".claude.json");
    fs.writeFileSync(cj, "{}");
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
    const st = await casMain("status", "--json");
    const cfg = () => JSON.parse(fs.readFileSync(path.join(store, "config.json"), "utf8"));
    assert.ok(cfg().tracked.includes(cj));
    assert.ok(cfg().tracked.includes(path.join(home, ".claude", "settings.json")));
    const buckets = new Set(["new", "modified", "deleted", "unchanged"].flatMap((k) => st[k] as string[]));
    assert.ok((st.defaults as string[]).includes(cj));
    assert.ok(!(st.defaults as string[]).includes(file));
    for (const d of st.defaults as string[]) assert.ok(buckets.has(d), d);
    await casMain("untrack", cj);
    await casMain("status", "--json");
    assert.ok(!cfg().tracked.includes(cj));
    assert.ok(cfg().ignore_defaults.includes(cj));
  });
});

test("default merge does not overwrite a concurrent untrack", async () => {
  // 병합 저장은 config.lock 안에서 다시 읽은 config 에 한다. 락을 기다리는 사이 다른 프로세스가 지운 항목을 되살리면 안 된다.
  await withFakeHome(async (home) => {
    const dflt = path.join(home, ".claude.json");
    fs.writeFileSync(dflt, "{}");
    const lock = path.join(store, "config.lock");
    fs.writeFileSync(lock, '{"pid": 1}');
    process.env.CLAUDE_CAS_LOCK_WAIT = "3";
    try {
      const pending = cas.loadConfig(cas.storePaths(store));
      await new Promise((r) => setTimeout(r, 300));
      const cfgPath = path.join(store, "config.json");
      const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      c.tracked = c.tracked.filter((t: string) => t !== file);
      fs.writeFileSync(cfgPath, JSON.stringify(c));
      fs.unlinkSync(lock);
      await pending;
    } finally {
      process.env.CLAUDE_CAS_LOCK_WAIT = "0.2";
    }
    const tracked = JSON.parse(fs.readFileSync(path.join(store, "config.json"), "utf8")).tracked;
    assert.ok(!tracked.includes(file));
    assert.ok(tracked.includes(dflt));
  });
});

test("pyNow follows the wall clock and strictly increases", async () => {
  const { pyNow, stamp } = await import("../../src/core/lib_store.ts");
  const a = pyNow(), b = pyNow();
  assert.ok(Math.abs(a.date.getTime() - Date.now()) < 50);
  assert.ok(stamp(b, true) > stamp(a, true));
});

const nc = (p: string) => path.resolve(p).toLowerCase();
const make = (p: string, body = "{}") => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};
const added = (d: CliDoc) => new Set((d.added as string[]).map(nc));

test("track: project dir expands settings and prose presets, .claude dir, file, empty dir, missing file", async () => {
  const proj = path.join(tmp, "repoP");
  const s = make(path.join(proj, ".claude", "settings.json"));
  const sl = make(path.join(proj, ".claude", "settings.local.json"));
  const md = make(path.join(proj, "CLAUDE.md"), "# rules");
  const lmd = make(path.join(proj, "CLAUDE.local.md"), "# local");
  const cmd = make(path.join(proj, ".claude", "CLAUDE.md"), "# in-claude");
  assert.deepEqual(added(await casMain("track", "--json", proj)), new Set([s, sl, md, lmd, cmd].map(nc)));
  const cdir = path.join(tmp, "repoB", ".claude");
  const s2 = make(path.join(cdir, "settings.json"));
  assert.deepEqual(added(await casMain("track", "--json", cdir)), new Set([nc(s2)]));
  const f = make(path.join(tmp, "repoC", ".claude", "settings.json"));
  const rf = await casMain("track", "--json", f);
  assert.deepEqual(added(rf), new Set([nc(f)]));
  assert.deepEqual(rf.not_found, []);
  const empty = path.join(tmp, "repoD", ".claude");
  fs.mkdirSync(empty, { recursive: true });
  const re = await casMain("track", "--json", empty);
  assert.deepEqual([re.added, re.not_found], [[], []]);
  const ghost = path.join(tmp, "nope", "settings.json");
  const rg = await casMain("track", "--json", ghost);
  assert.deepEqual(added(rg), new Set([nc(ghost)]));
  assert.deepEqual((rg.not_found as string[]).map(nc), [nc(ghost)]);
});

test("untrack removes a deleted file from the index and purges a legacy directory entry's subtree", async () => {
  const f = make(path.join(tmp, "repoF", ".claude", "settings.json"));
  await casMain("track", "--json", f);
  await casMain("snapshot");
  fs.unlinkSync(f);
  assert.ok(((await casMain("status", "--json")).deleted as string[]).includes(f));
  const r = await casMain("untrack", "--json", f);
  assert.deepEqual([r.ok, r.index_removed], [true, 1]);
  const all = (d: CliDoc) => ["new", "modified", "deleted", "unchanged"].flatMap((k) => d[k] as string[]);
  assert.ok(!all(await casMain("status", "--json")).includes(f));
  const proj = path.join(tmp, "legacy");
  make(path.join(proj, "a.txt"), "a");
  make(path.join(proj, "sub", "b.txt"), "b");
  const cfgPath = path.join(store, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.tracked.push(path.resolve(proj));
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  await casMain("snapshot");
  const r2 = await casMain("untrack", "--json", proj);
  assert.deepEqual([r2.ok, r2.index_removed], [true, 2]);
  assert.ok(!all(await casMain("status", "--json")).some((p) => p.startsWith(proj + path.sep)));
});

test("invalid arguments report argparse messages", async () => {
  const r = await cas.main(["history"]);
  assert.deepEqual([r.ok, r.code, r.message], [false, "invalid_arg", "cas history: the following arguments are required: path"]);
});

// ----- Python 판과의 디스크 형식 -----

test("stat values match python os.lstat", () => {
  fs.utimesSync(file, FIXED_MTIME, FIXED_MTIME);
  const want = pyEval("import os; s = os.lstat(ARG); print(json.dumps([str(s.st_mtime_ns), s.st_mode, s.st_size]))", file) as [string, number, number];
  const st = fs.lstatSync(file, { bigint: true });
  assert.deepEqual([st.mtimeNs.toString(), Number(st.mode), Number(st.size)], want);
});

test("store written by python is read by ts and vice versa, with identical bytes", async () => {
  // 같은 입력에서 Python 판과 TS 판이 쓴 config.json, index.json, objects 는 바이트가 같고 매니페스트는 시각만 다르다.
  const f2 = path.join(work, "한글 설정.json");
  writeLf('{\n  "a": 1.0,\n  "b": [1, 2, 3],\n  "c": "한글"\n}', f2);
  for (const f of [file, f2]) fs.utimesSync(f, FIXED_MTIME, FIXED_MTIME);
  const pyStore = path.join(tmp, "pystore");
  for (const args of [["init"], ["track", file, f2], ["snapshot", "-m", "py"]]) assert.equal(pyRun("cas.py", ["--store", pyStore, ...args], pyStore).rc, 0);
  await casMain("track", f2);
  await casMain("snapshot", "-m", "py");
  const rd = (s: string, ...p: string[]) => fs.readFileSync(path.join(s, ...p));
  const cfgNorm = (b: Buffer, s: string) => b.toString("utf8").split(JSON.stringify(s).slice(1, -1)).join("<S>");
  assert.equal(cfgNorm(rd(store, "config.json"), store), cfgNorm(rd(pyStore, "config.json"), pyStore));
  assert.deepEqual(rd(store, "index.json"), rd(pyStore, "index.json"));
  // 객체는 이름(원본 sha256)과 풀어낸 내용이 같아야 한다. 압축 바이트는 Node 와 Python 의 zlib 빌드가 달라
  // 입력에 따라 다르게 나온다(둘 다 같은 zlib 형식이라 서로 읽힌다).
  const objs = (s: string) => {
    const out: Record<string, string> = {};
    for (const d of fs.readdirSync(path.join(s, "objects"))) {
      for (const n of fs.readdirSync(path.join(s, "objects", d))) out[d + n] = zlib.inflateSync(rd(s, "objects", d, n)).toString("hex");
    }
    return out;
  };
  assert.deepEqual(objs(store), objs(pyStore));
  const man = (s: string) => {
    const name = fs.readdirSync(path.join(s, "snapshots"))[0];
    return rd(s, "snapshots", name).toString("utf8").replace(/"time": "[^"]+"/, '"time": "<T>"');
  };
  assert.equal(man(store), man(pyStore));
  // TS 가 쓴 스토어를 Python 이 읽고, Python 이 쓴 스토어를 TS 가 읽는다.
  writeLf('{\n  "keep": false\n}');
  const pyStatus = JSON.parse(pyRun("cas.py", ["--store", store, "status", "--json"]).out);
  assert.deepEqual([pyStatus.modified, pyStatus.unchanged], [[file], [f2]]);
  const pyHist = JSON.parse(pyRun("cas.py", ["--store", store, "history", file, "--json"]).out);
  assert.equal(pyHist.revisions.length, 1);
  const tsStatus = await cas.main(["--store", pyStore, "status", "--json"]);
  assert.deepEqual([tsStatus.modified, tsStatus.unchanged], [[file], [f2]]);
  const sid = cas.snapshotIds(cas.storePaths(pyStore))[0];
  const tsDiff = await cas.main(["--store", pyStore, "diff", file, "--from", sid, "--json"]);
  const pyDiff = JSON.parse(pyRun("cas.py", ["--store", pyStore, "diff", file, "--from", sid, "--json"]).out);
  assert.deepEqual(tsDiff, pyDiff);
});

test("sig-cache values match python, including float notation", async () => {
  writeLf('{\n  "keep": 1.0,\n  "n": 1e20,\n  "feedbackDrafts": 0\n}');
  await casMain("snapshot", "-m", "a");
  writeLf('{\n  "keep": 1.0,\n  "n": 1e20,\n  "feedbackDrafts": 1\n}');
  assert.deepEqual((await casMain("status", "--json")).modified, [], "무시 키만 바뀌었다");
  await casMain("snapshot", "-m", "b", "--force");
  await history();   // sig 를 계산해 sig-cache 에 넣는다
  const tsCache = JSON.parse(fs.readFileSync(path.join(store, "sig-cache.json"), "utf8"));
  fs.unlinkSync(path.join(store, "sig-cache.json"));
  const pySigs = oracle("sig-cache sigs after python history", sub(), () => {
    assert.equal(pyRun("cas.py", ["--store", store, "history", file, "--json"]).rc, 0);
    return JSON.parse(fs.readFileSync(path.join(store, "sig-cache.json"), "utf8")).sigs as unknown;
  });
  assert.deepEqual(tsCache.sigs, pySigs);
  const p = cas.storePaths(store);
  const prof = cas.ignoreProfile(await cas.loadConfig(p), file)!;
  const fp = pyEval("import cas; print(json.dumps(cas.ignore_profile({}, ARG)['fp']))", file);
  assert.equal(prof.fp, fp);
  const dotfp = pyEval("import cas; print(json.dumps(cas.ignore_profile({'ignore_keys': {'.claude.json': ['!last*', 'x']}}, ARG)['fp']))", path.join(work, ".claude.json"));
  assert.equal(cas.ignoreProfile({ ignore_keys: { ".claude.json": ["!last*", "x"] } }, path.join(work, ".claude.json"))!.fp, dotfp);
});

// ----- Python 표준 라이브러리 동작 -----

test("unified diff matches difflib, including autojunk over 200 lines", () => {
  let seed = 7;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const cases: [string[], string[]][] = [[[], []], [["a"], []], [[], ["a"]], [["a", "b", "c"], ["a", "x", "c"]]];
  for (let k = 0; k < 12; k++) {
    const n = k < 6 ? 20 + rnd(30) : 210 + rnd(80);
    const a = Array.from({ length: n }, () => ["{", "}", "  x", `  "k${rnd(8)}": ${rnd(5)}`, ""][rnd(5)]);
    const b = a.filter(() => rnd(10) > 0).flatMap((l) => (rnd(12) === 0 ? [l, `  "new${rnd(9)}"`] : [l]));
    cases.push([a, b]);
  }
  const want = pyEval("import difflib\nprint(json.dumps([list(difflib.unified_diff(a, b, 'f', 't', lineterm='')) for a, b in ARG]))", cases) as string[][];
  cases.forEach(([a, b], i) => assert.deepEqual(cas.unifiedDiff(a, b, "f", "t", 3, ""), want[i], `case ${i}`));
});

test("splitlines, fnmatchcase, expandvars and glob match python", () => {
  const texts = ["", "a", "a\n", "a\r\nb\rc\n\nd", "x\vy\fz\x1cw\x85v u t", "\n\n"];
  const pats = [["feedbackDrafts", "feedback*"], ["lastCost", "last*"], ["abc", "a?c"], ["a.c", "a[.]c"], ["ab", "a[!b]"], ["a-b", "a[x-z-]b"], ["A", "a"], ["x[", "x["], ["", "*"]];
  const vars = ["%USERPROFILE%\\x", "$USERPROFILE", "${USERPROFILE}y", "'%USERPROFILE%'", "%NOPE_X%", "$NOPE_X", "%%", "$$", "a$", "100%"];
  const tree = path.join(tmp, "g");
  for (const f of ["a.json", "b.txt", ".hidden.json", "sub/c.json", "sub/deep/d.json", ".dot/e.json", "Sub2/F.JSON"]) make(path.join(tree, f));
  const globs = [`${tree}\\*.json`, `${tree}\\**\\*.json`, `${tree}\\**`, `${tree}\\s*\\*.json`, `${tree}\\.*`, `${tree}\\SUB\\*.json`, `${tree}\\nope\\*`];
  const want = pyEval(`import os, fnmatch, glob
t, p, v, g = ARG
print(json.dumps([[s.splitlines() for s in t], [fnmatch.fnmatchcase(a, b) for a, b in p], [os.path.expandvars(x) for x in v],
                  [sorted(glob.glob(x, recursive=True)) for x in g]]))`, [texts, pats, vars, WIN ? globs : []]) as unknown[][];
  assert.deepEqual(texts.map(cas.splitlines), want[0]);
  assert.deepEqual(pats.map(([a, b]) => cas.fnmatchcase(a, b)), want[1]);
  if (WIN) {
    assert.deepEqual(vars.map(cas.expandvars), want[2]);
    assert.deepEqual(globs.map((g) => cas.pyGlob(g).sort()), want[3]);
  }
});
