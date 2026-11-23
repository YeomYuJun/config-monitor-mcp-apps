// tests/test_remote_library.py 의 LibStore, Ledger 를 옮긴 것 + Python 판과 디스크 형식·경로 규칙이 같은지 확인.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ls from "../../src/core/lib_store.ts";
import { decodeBytes, encodeBytes, pyOracle } from "./py_oracle.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(ROOT, "src");
const PY = "python";   // 기록 모드(CM_PY_RECORD=1)에서만 실행된다
const WIN = process.platform === "win32";
const oracle = pyOracle("lib_store");

/** src 를 sys.path 에 넣고 Python 코드를 돌려 stdout(JSON) 을 읽는다(기록 모드에서만 실행된다). */
function pyRaw(code: string, env: NodeJS.ProcessEnv = {}): unknown {
  const r = spawnSync(PY, ["-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(SRC)})\n${code}`], {
    encoding: "utf-8", env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...env }, windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as unknown;
}

/** pyRaw 의 기록. */
function py(code: string, env: NodeJS.ProcessEnv = {}): unknown {
  return oracle(`${code} ${JSON.stringify(env)}`, { "<TMP>": tmp, "<CWD>": process.cwd() }, () => pyRaw(code, env));
}

let tmp = "";
let store = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libstore_test_"));
  store = path.join(tmp, "store");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function initStore(cfg: unknown = { version: 1, store, tracked: [] }): void {
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(ls.storeConfigPath(store), JSON.stringify(cfg));
}

// ----- LibStore -----

test("save raises when store uninitialized", () => {
  // 조용한 등록 실패 회귀 가드: store 가 없으면 False 를 삼키지 말고 예외를 던진다.
  assert.throws(() => ls.saveCfg(store, { libraries: [] }), ls.StoreNotInitialized);
});

test("roundtrip preserves unknown keys", () => {
  // 원장/remotes 를 쓰는 코드가 기존 키를 날리지 않아야 한다.
  initStore();
  const cfg = ls.loadCfg(store);
  cfg.libraries = [];
  (cfg.remotes ??= []).push({ id: "x", url: "u" });
  ls.saveCfg(store, cfg);
  const again = ls.loadCfg(store);
  assert.deepEqual(again.remotes, [{ id: "x", url: "u" }]);
  assert.ok("libraries" in again);
  assert.ok("tracked" in again);
});

test("default store: env, then legacy folder, then home", () => {
  const saved = process.env.CLAUDE_SNAPSHOT_STORE;
  try {
    process.env.CLAUDE_SNAPSHOT_STORE = store;
    assert.equal(ls.defaultStore(), store);
    process.env.CLAUDE_SNAPSHOT_STORE = "";
    const want = fs.existsSync(ls.LEGACY_WIN_STORE) && WIN ? ls.LEGACY_WIN_STORE : ls.pjoin(os.homedir(), ".claude-snapshot");
    if (process.env.USERPROFILE === os.homedir() || !WIN) assert.equal(ls.defaultStore(), want);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_SNAPSHOT_STORE;
    else process.env.CLAUDE_SNAPSHOT_STORE = saved;
  }
});

// ----- Ledger -----

const tgt = WIN ? "C:\\Users\\u\\.claude" : "/home/u/.claude";

test("two origins same name collide on one key", () => {
  // 원장 방향의 존재 이유: 서로 다른 출처의 같은 이름이 같은 키에 앉아야 두 번째 설치가 첫 번째의 소유권을 본다.
  const cfg: ls.StoreConfig = {};
  ls.ledgerPut(cfg, tgt, "skills", "code-review", { origin: "market:official/plugin-a", src_hash: "h1" });
  assert.equal(ls.ledgerGet(cfg, tgt, "skills", "code-review")?.origin, "market:official/plugin-a");
  assert.deepEqual(Object.keys(cfg.installed![ls.ledgerRootKey(tgt)]), ["skills/code-review"]);
});

test("key is case and separator normalized", () => {
  const cfg: ls.StoreConfig = {};
  ls.ledgerPut(cfg, tgt, "agents", "a1", { origin: "local:d:\\x" });
  const alt = WIN ? tgt.replace(/\\/g, "/").toUpperCase() : tgt + "/";
  assert.notEqual(ls.ledgerGet(cfg, alt, "agents", "a1"), null);
});

test("del is idempotent", () => {
  const cfg: ls.StoreConfig = {};
  ls.ledgerPut(cfg, tgt, "agents", "a1", { origin: "local:x" });
  ls.ledgerDel(cfg, tgt, "agents", "a1");
  ls.ledgerDel(cfg, tgt, "agents", "a1");
  assert.equal(ls.ledgerGet(cfg, tgt, "agents", "a1"), null);
  ls.ledgerDel({}, tgt, "agents", "a1");
});

test("refs_root finds hooks holding a cache dir", () => {
  const cfg: ls.StoreConfig = {};
  const root = ls.pjoin("D:\\cache", "plugins", "sg", "abc123");
  ls.ledgerPut(cfg, tgt, "hooks", "security-guidance", { kind: "hooks", origin: "market:official/security-guidance", root });
  ls.ledgerPut(cfg, tgt, "agents", "a1", { origin: "local:x" });
  assert.deepEqual(ls.ledgerRefsRoot(cfg, root).map((h) => h.key), ["hooks/security-guidance"]);
  assert.deepEqual(ls.ledgerRefsRoot(cfg, ls.pjoin("D:\\cache", "other")), []);
});

test("refs_root matches descendant but not sibling prefix", () => {
  // 번들 플러그인의 root 는 마켓 레포 캐시의 하위다. 형제("...\repo-extra")는 매치되면 안 된다.
  let cfg: ls.StoreConfig = {};
  const cacheRoot = ls.pjoin("D:\\cache", "markets", "mk", "repo");
  ls.ledgerPut(cfg, tgt, "hooks", "bundled-hook", { kind: "hooks", origin: "market:mk/bundled", root: ls.pjoin(cacheRoot, "plugins", "bundled") });
  assert.deepEqual(ls.ledgerRefsRoot(cfg, cacheRoot).map((h) => h.key), ["hooks/bundled-hook"]);
  cfg = {};
  ls.ledgerPut(cfg, tgt, "hooks", "sibling-hook", { kind: "hooks", origin: "market:mk/other", root: ls.pjoin(ls.dirname(cacheRoot), "repo-extra") });
  assert.deepEqual(ls.ledgerRefsRoot(cfg, cacheRoot), []);
});

// ----- Python 판과의 호환 -----

const PATHS = [
  "C:\\a\\b\\", "C:/a/b/", "C:/A/B/../c/", "", ".", "a/../..", "/x/../..", "C:..\\a", "C:", "C:x", "\\\\srv\\sh\\..\\x",
  "\\\\srv\\sh", "\\\\?\\UNC\\srv\\sh\\x", "D:\\.claude-snapshot", "rel\\x\\.\\y", "C:\\a\\\\b", "/", "//x", "a\\", "C:\\",
];

test("os.path functions match python", () => {
  const want = py(`import os
ps = json.loads(sys.argv[1]) if len(sys.argv) > 1 else ${JSON.stringify(PATHS)}
out = {}
for p in ps:
    out[p] = [os.path.normpath(p), os.path.normcase(os.path.normpath(p)), os.path.basename(p), os.path.dirname(p),
              os.path.join(p, "config.json"), os.path.join("D:\\\\base", p), os.path.join(p, "x", "/abs")]
print(json.dumps(out))`) as Record<string, string[]>;
  for (const p of PATHS) {
    const got = [ls.normpath(p), ls.norm(p), ls.basename(p), ls.dirname(p), ls.pjoin(p, "config.json"), ls.pjoin("D:\\base", p), ls.pjoin(p, "x", "/abs")];
    assert.deepEqual(got, want[p], JSON.stringify(p));
  }
});

test("abspath matches python", { skip: !WIN }, () => {
  const ps = ["C:\\a\\b\\", "C:/a/b/", "C:\\a\\b. ", "C:\\a\\..\\b", "rel\\x", "\\\\srv\\sh\\x\\", "C:\\a\\b\\.", "C:\\a\\\\b", "C:\\x\\y.json"];
  const want = py(`import os; print(json.dumps([os.path.abspath(p) for p in ${JSON.stringify(ps)}]))`) as string[];
  assert.deepEqual(ps.map(ls.abspath), want);
});

test("pyFixed rounds exact halves to even like python format", () => {
  const xs = [0, 0.05, 0.25, 0.35, 2.5, 3.5, 0.125, 1.0, 262144 / 1048576, 786432 / 1048576, 12.3456, 8, 0.3];
  const want = py(`xs = ${JSON.stringify(xs)}; print(json.dumps([[f"{x:.1f}", f"{x:.0f}"] for x in xs]))`);
  assert.deepEqual(xs.map((x) => [ls.pyFixed(x, 1), ls.pyFixed(x, 0)]), want);
});

test("python-written config.json is read, ts-written bytes equal python's", () => {
  initStore();
  const data = { version: 1, store, tracked: ["C:\\x\\한글.json"], ui: { sections: { hidden: [] } }, installed: {}, n: null, b: true };
  const saved = oracle("save_cfg bytes", { "<TMP>": tmp }, () => {
    pyRaw(`import lib_store; lib_store.save_cfg(${JSON.stringify(store)}, json.loads(${JSON.stringify(JSON.stringify(data))})); print("null")`);
    return encodeBytes(fs.readFileSync(ls.storeConfigPath(store)));
  });
  fs.writeFileSync(ls.storeConfigPath(store), decodeBytes(saved));
  const pyBytes = fs.readFileSync(ls.storeConfigPath(store));
  assert.deepEqual(ls.loadCfg(store), data);
  ls.saveCfg(store, data);
  assert.deepEqual(fs.readFileSync(ls.storeConfigPath(store)), pyBytes);
  assert.deepEqual(py(`import lib_store; print(json.dumps(lib_store.load_cfg(${JSON.stringify(store)}), ensure_ascii=False))`), data);
  if (WIN) assert.ok(pyBytes.includes(Buffer.from("\r\n")));
});

test("config.json keeps python float and big int spelling through load and save", async () => {
  // Python 판 json.dump(indent=2) 가 Windows 텍스트 모드로 쓴 바이트.
  const PY_CFG = '{\r\n  "version": 1,\r\n  "ratio": 1.0,\r\n  "tiny": 1e-07,\r\n  "big": 12345678901234567890,\r\n'
    + '  "ui": {\r\n    "view": {\r\n      "zoom": 2.5\r\n    }\r\n  }\r\n}';
  fs.mkdirSync(store, { recursive: true });
  const p = ls.storeConfigPath(store);
  const want = WIN ? PY_CFG : PY_CFG.replace(/\r\n/g, "\n");
  fs.writeFileSync(p, want, "utf8");
  ls.saveCfg(store, ls.loadCfg(store));
  assert.equal(fs.readFileSync(p, "utf8"), want);
  await ls.withEditCfg(store, () => {});
  assert.equal(fs.readFileSync(p, "utf8"), want);
});

test("config.json with a BOM is readable", () => {
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(ls.storeConfigPath(store), "\ufeff" + JSON.stringify({ version: 1 }), "utf8");
  assert.deepEqual(ls.loadCfg(store), { version: 1 });
});

test("withEditCfg saves on success and skips the save when fn throws", async () => {
  await assert.rejects(ls.withEditCfg(store, () => 1), ls.StoreNotInitialized);
  initStore({ version: 1 });
  await ls.withEditCfg(store, (cfg) => { cfg.libraries = ["a"]; });
  assert.deepEqual(ls.loadCfg(store).libraries, ["a"]);
  await assert.rejects(ls.withEditCfg(store, (cfg) => { cfg.libraries = ["b"]; throw new Error("stop"); }), /stop/);
  assert.deepEqual(ls.loadCfg(store).libraries, ["a"]);
  assert.ok(!fs.existsSync(path.join(store, "config.lock")));
});

test("lock file content matches python and is released only by its owner", async () => {
  fs.mkdirSync(store, { recursive: true });
  const lock = path.join(store, "config.lock");
  const h = await ls.configLock(store);
  const raw = fs.readFileSync(lock, "utf8");
  assert.match(raw, /^\{"pid": \d+, "at": "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?", "token": "[0-9a-f]{32}"\}$/);
  fs.writeFileSync(lock, JSON.stringify({ pid: 0, token: "other-holder" }));
  h.release();
  assert.ok(fs.existsSync(lock), "다른 소유자의 락은 지우지 않는다");
  fs.unlinkSync(lock);
  const h2 = await ls.configLock(store);
  h2.release();
  assert.ok(!fs.existsSync(lock));
});

test("lock held by python times out in ts, stale lock is broken", async () => {
  fs.mkdirSync(store, { recursive: true });
  const lock = path.join(store, "config.lock");
  fs.writeFileSync(lock, '{"pid": 1}');
  await assert.rejects(ls.fileLock(lock, 0.2, 60, "busy"), (e: Error) => {
    assert.equal(e.name, "TimeoutError");
    assert.equal(e.message, `busy (waited 0s): ${lock}`);
    return e instanceof ls.LockTimeoutError;
  });
  const old = Date.now() / 1000 - 120;
  fs.utimesSync(lock, old, old);
  const h = await ls.fileLock(lock, 0.2, 60, "busy");
  h.release();
  assert.ok(!fs.existsSync(lock));
});

test("python releases a lock taken by ts only if the token matches", async () => {
  fs.mkdirSync(store, { recursive: true });
  const h = await ls.configLock(store);
  const r = py(`import lib_store
try:
    with lib_store.file_lock(${JSON.stringify(path.join(store, "config.lock"))}, 0.2, 60, "busy"):
        print(json.dumps("acquired"))
except TimeoutError as e:
    print(json.dumps(str(e)))`);
  assert.match(String(r), /^busy\(0s 대기\)/);
  h.release();
});
