// tests/test_remote_library.py 의 ScanRecords, ScanEnumerationErrors, ConflictStatus, RemoteAdd, MarketAdd, PluginFetch,
// MarketUnregister, FetchAndUnregister, HooksInstall, McpInstall, HooksUninstallStructural, ScanHooksMcpFlags,
// MarketSourceForms 와 tests/test_plugin_state.py 의 market-discover 사유 문장을 옮긴 것.
import { test, describe, beforeEach, afterEach, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { main, normUrl } from "../../src/core/library.ts";
import { classifySource } from "../../src/core/marketplace.ts";
import { gitAvailable } from "../../src/core/remote_fetch.ts";
import * as libStore from "../../src/core/lib_store.ts";

const noGit = !gitAvailable() && "git 없음";
let tmp = "";
let store = "";
let target = "";
let savedLibs: string | undefined;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "library_test_")));
  store = path.join(tmp, "store");
  target = path.join(tmp, ".claude");
  savedLibs = process.env.CLAUDE_CONFIG_LIBRARIES;
  delete process.env.CLAUDE_CONFIG_LIBRARIES;
});
afterEach(() => {
  if (savedLibs === undefined) delete process.env.CLAUDE_CONFIG_LIBRARIES;
  else process.env.CLAUDE_CONFIG_LIBRARIES = savedLibs;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** cas init 이 만드는 스토어(config.json, index.json, 폴더). */
function initStore(): void {
  for (const d of ["objects", "snapshots", "log"]) fs.mkdirSync(path.join(store, d), { recursive: true });
  fs.writeFileSync(path.join(store, "config.json"), JSON.stringify({ version: 1, store, tracked: [] }, null, 2));
  fs.writeFileSync(path.join(store, "index.json"), "{}");
}

const lib = (...args: string[]) => main(["--store", store, "--target", target, "--no-snapshot", ...args]);
const cfg = () => libStore.loadCfg(store) as Record<string, any>;

async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const keep = process.env.PATH;
  process.env.PATH = value;
  try {
    return await fn();
  } finally {
    process.env.PATH = keep;
  }
}

function write(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf-8"));
const localOrigin = (p: string) => "local:" + libStore.norm(p);

// pytest 의 os.walk 몽키패치 자리: dir(소문자) 한 곳의 나열만 OSError 로 실패시킨다.
async function withBrokenDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const real = fs.readdirSync;
  const m = mock.method(fs, "readdirSync", ((p: fs.PathLike, ...rest: unknown[]) => {
    if (path.normalize(String(p)).toLowerCase() === dir) {
      throw Object.assign(new Error(`ENAMETOOLONG: simulated enumeration failure, scandir '${String(p)}'`), { code: "ENAMETOOLONG", errno: -4064 });
    }
    return (real as (...a: unknown[]) => unknown).call(fs, p, ...rest);
  }) as typeof fs.readdirSync);
  try {
    return await fn();
  } finally {
    m.mock.restore();
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" }).trim();
}

function repo(dir: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return "file:///" + dir.replaceAll("\\", "/").replace(/^\/+/, "");
}

function commit(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "more");
}

describe("entry", () => {
  test("parser errors are invalid_arg documents", async () => {
    const r = await lib("catalog", "--limit", "x");
    assert.deepEqual([r.ok, r.code, r.message], [false, "invalid_arg", "library catalog: argument --limit: invalid int value: 'x'"]);
    assert.equal((await main([])).message, "library: the following arguments are required: op");
  });

  test("scan with nothing registered is ok and empty", async () => {
    initStore();
    const r = await lib("scan");
    assert.deepEqual([r.ok, r.code, r.message, r.target, r.libraries], [true, "ok", "No libraries registered", target, []]);
  });

  test("scan --lib on an uninitialized store reports it", async () => {
    const r = await lib("scan", "--lib", path.join(tmp, "x"));
    assert.deepEqual([r.ok, r.code, r.libraries], [false, "store_uninitialized", []]);
  });

  test("unregister --lib", async () => {
    initStore();
    const p = path.join(tmp, "mylib");
    const c = cfg();
    c.libraries = [p];
    libStore.saveCfg(store, c);
    const r = await lib("unregister", "--lib", p.toUpperCase());
    assert.deepEqual([r.code, r.removed], ["ok", true]);
    assert.deepEqual(cfg().libraries, []);
    assert.deepEqual([(await lib("unregister", "--lib", p)).code], ["noop"]);
    assert.equal((await lib("unregister")).code, "invalid_arg");
    assert.equal((await lib("unregister", "--origin", "weird:x")).message, "Invalid origin format: weird:x");
  });

  test("unregister refuses a path given by the environment", async () => {
    initStore();
    const p = path.join(tmp, "envlib");
    process.env.CLAUDE_CONFIG_LIBRARIES = p;
    const r = await lib("unregister", "--lib", p);
    assert.deepEqual([r.ok, r.code, r.target], [false, "refused", p]);
  });

  test("normUrl makes shorthand and full url equal", () => {
    assert.equal(normUrl(classifySource("anthropics/claude-code").url), normUrl(classifySource("https://github.com/anthropics/claude-code.git").url));
    assert.equal(normUrl(" HTTPS://x/Y.GIT/ "), "https://x/y");
    assert.equal(normUrl(null), "");
  });
});

describe("RemoteAdd", { skip: noGit }, () => {
  let origin = "";
  let url = "";
  beforeEach(() => {
    origin = path.join(tmp, "origin");
    url = repo(origin, { "Skills/s1/SKILL.md": "---\nname: s1\n---\nbody\n", "Agents/a1.md": "agent\n" });
  });

  test("registers and detects uppercase layout", async () => {
    initStore();
    const r = await lib("remote-add", "--url", url, "--ref", "main");
    assert.equal(r.ok, true, r.message);
    assert.equal(r.id, "origin");
    assert.equal(r.origin, "remote:origin");
    assert.deepEqual([...(r.layout as any).found].sort(), ["agents", "skills"]);
    assert.equal((r.layout as any).map.skills, "Skills");
    assert.equal(r.cache, path.join(store, "lib-cache", "remotes", "origin"));
    assert.ok(fs.statSync(r.cache as string).isDirectory());
    assert.equal(r.marketplace, false);
    const rec = cfg().remotes[0];
    assert.deepEqual(Object.keys(rec), ["id", "url", "ref", "sha", "fetched_at", "cache", "map"]);
    assert.match(rec.fetched_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });

  test("reports store uninitialized instead of lying", async () => {
    const r = await lib("remote-add", "--url", url, "--ref", "main");
    assert.equal(r.ok, false);
    assert.equal(r.code, "store_uninitialized");
    assert.match(r.message, /not initialized/);
  });

  test("is idempotent on the same id", async () => {
    initStore();
    await lib("remote-add", "--url", url, "--ref", "main");
    const r = await lib("remote-add", "--url", url, "--ref", "main");
    assert.equal(r.ok, true);
    assert.equal(r.already, true);
    assert.equal(cfg().remotes.length, 1);
  });

  test("without git fails clearly", async () => {
    initStore();
    const r = await withPath("", () => lib("remote-add", "--url", url, "--ref", "main"));
    assert.deepEqual([r.ok, r.code, r.message], [false, "tool_missing", "git was not found on PATH"]);
  });

  test("a --map that is not json is refused with the python decoder message", async () => {
    initStore();
    const r = await lib("remote-add", "--url", url, "--map", "{bad");
    assert.deepEqual([r.ok, r.code, r.target], [false, "invalid_arg", "--map"]);
    assert.equal(r.message, "--map is not valid JSON: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)");
  });

  test("a bad url is external_failed", async () => {
    initStore();
    const r = await lib("remote-add", "--url", "file:///definitely/not/a/repo.git");
    assert.deepEqual([r.ok, r.code], [false, "external_failed"]);
  });

  test("fetch updates sha and content", async () => {
    initStore();
    const first = await lib("remote-add", "--url", url, "--ref", "main");
    commit(origin, { "Agents/a2.md": "second agent\n" });
    const r = await lib("fetch", "--origin", "remote:origin");
    assert.deepEqual([r.ok, r.message, r.origin], [true, "Updated: origin", "remote:origin"]);
    assert.notEqual(r.sha, first.sha);
    assert.equal(cfg().remotes[0].sha, r.sha);
    assert.ok(fs.existsSync(path.join(first.cache as string, "Agents", "a2.md")));
    const row = ((await lib("scan")).libraries as any[]).find((l) => l.source === "remote");
    assert.deepEqual(row.categories.agents.map((i: any) => i.name).sort(), ["a1", "a2"]);
  });

  test("scan never pulls by itself", async () => {
    initStore();
    await lib("remote-add", "--url", url, "--ref", "main");
    commit(origin, { "Agents/a3.md": "third\n" });
    const row = ((await lib("scan")).libraries as any[]).find((l) => l.source === "remote");
    assert.deepEqual(row.categories.agents.map((i: any) => i.name), ["a1"]);
  });

  test("unregister removes registration and cache", async () => {
    initStore();
    const { cache } = await lib("remote-add", "--url", url, "--ref", "main");
    const r = await lib("unregister", "--origin", "remote:origin");
    assert.deepEqual([r.ok, r.removed], [true, true]);
    assert.deepEqual(cfg().remotes, []);
    assert.ok(!fs.existsSync(cache as string));
    assert.equal((await lib("unregister", "--origin", "remote:origin")).code, "noop");
  });

  test("unregister refuses when the ledger still holds the cache", async () => {
    initStore();
    const { cache } = await lib("remote-add", "--url", url, "--ref", "main");
    const c = cfg();
    libStore.ledgerPut(c, target, "hooks", "some-hook", { kind: "hooks", origin: "remote:origin", root: cache });
    libStore.saveCfg(store, c);
    const r = await lib("unregister", "--origin", "remote:origin");
    assert.deepEqual([r.ok, r.code, r.held_by], [false, "held", ["hooks/some-hook"]]);
    assert.ok(fs.existsSync(cache as string));
    assert.equal(cfg().remotes.length, 1);
  });

  test("fetch of an unknown origin is rejected", async () => {
    initStore();
    assert.deepEqual(await lib("fetch", "--origin", "remote:nope"), { ok: false, code: "not_found", message: "Remote not registered: nope", target: "nope" });
    assert.equal((await lib("fetch", "--origin", "x")).code, "invalid_arg");
  });
});

describe("MarketAdd", { skip: noGit }, () => {
  let mk = "";
  let url = "";
  const manifest = (plugins: unknown[], name = "testmarket") => JSON.stringify({ name, plugins });
  const BUNDLED = { name: "bundled", description: "bundled one", category: "development", source: "./plugins/bundled" };
  const EXTERNAL = { name: "external", description: "remote one", category: "database", source: { source: "url", url: "https://example.invalid/x.git", sha: "0".repeat(40) } };

  beforeEach(() => {
    mk = path.join(tmp, "mk");
    url = repo(mk, {
      "plugins/bundled/skills/bs1/SKILL.md": "---\nname: bs1\n---\nbundled skill\n",
      ".claude-plugin/marketplace.json": manifest([BUNDLED, EXTERNAL]),
    });
    initStore();
  });

  test("sparse checks out the manifest only", async () => {
    const r = await lib("market-add", "--url", url, "--ref", "main");
    assert.equal(r.ok, true, r.message);
    assert.deepEqual([r.id, r.name, r.kind, r.plugins, r.already], ["mk", "testmarket", "git", 2, false]);
    assert.equal(r.message, "Marketplace registered: mk (plugins: 2)");
    assert.ok(fs.existsSync(path.join(r.cache as string, ".claude-plugin", "marketplace.json")));
    assert.ok(!fs.existsSync(path.join(r.cache as string, "plugins", "bundled")));
    assert.deepEqual(Object.keys(cfg().marketplaces[0]), ["id", "url", "ref", "kind", "sha", "fetched_at", "cache", "name", "plugins"]);
  });

  test("catalog needs no network", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    const r = await withPath("", () => lib("catalog"));
    assert.deepEqual([r.ok, r.total, r.categories], [true, 2, { development: 1, database: 1 }]);
  });

  test("catalog filters", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    assert.deepEqual(((await lib("catalog", "--category", "database")).rows as any[]).map((x) => x.name), ["external"]);
    assert.deepEqual(((await lib("catalog", "--query", "BUNDLED")).rows as any[]).map((x) => x.name), ["bundled"]);
  });

  test("market does not join the library until fetched", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    const r = await lib("scan");
    assert.deepEqual([r.ok, r.libraries], [true, []]);
  });

  test("catalog with no marketplace is empty not error", async () => {
    const r = await lib("catalog");
    assert.deepEqual([r.ok, r.total, r.total_all, r.offset, r.limit, r.rows], [true, 0, 0, 0, 50, []]);
  });

  test("rows carry market provenance", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    const rows = (await lib("catalog")).rows as any[];
    assert.ok(rows.length);
    for (const r of rows) assert.deepEqual([r.marketplace, r.market_name, r.market_url], ["mk", "testmarket", url]);
  });

  test("reregistering the same url says so", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    const r = await lib("market-add", "--url", url, "--ref", "main");
    assert.deepEqual([r.ok, r.already], [true, true]);
    assert.equal(r.message, "Marketplace already registered - manifest updated: mk (plugins: 2)");
  });

  test("same url under a different id is rejected", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    const r = await lib("market-add", "--url", url + "/", "--ref", "main", "--id", "other");
    assert.deepEqual([r.ok, r.code, r.message], [false, "exists", "This URL is already registered as 'mk'"]);
  });

  test("id collision from two different urls is rejected not overwritten", async () => {
    const url2 = repo(path.join(tmp, "nest", "mk"), { ".claude-plugin/marketplace.json": manifest([], "impostor") });
    await lib("market-add", "--url", url, "--ref", "main");
    const r = await lib("market-add", "--url", url2, "--ref", "main");
    assert.equal(r.ok, false);
    assert.match(r.message, /--id/);
    assert.deepEqual(((await lib("catalog", "--limit", "-1")).marketplaces as any[]).map((m) => m.name), ["testmarket"]);
  });

  test("summary lists markets and respects filters", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    let r = await lib("catalog", "--limit", "-1");
    assert.deepEqual(r.rows, []);
    assert.deepEqual(r.marketplaces, [{ id: "mk", name: "testmarket", url, total: 2, total_all: 2 }]);
    r = await lib("catalog", "--limit", "-1", "--category", "database");
    assert.deepEqual([(r.marketplaces as any[])[0].total, (r.marketplaces as any[])[0].total_all, r.total, r.total_all, r.limit], [1, 2, 1, 2, -1]);
  });

  test("marketplace filter pages that market alone", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    const r = await lib("catalog", "--marketplace", "mk", "--limit", "1", "--offset", "1");
    assert.deepEqual([r.total, (r.rows as any[]).length, (r.marketplaces as any[]).map((m) => m.id)], [2, 1, ["mk"]]);
  });

  test("paging slices the merged list once", async () => {
    const url2 = repo(path.join(tmp, "mk2"), { ".claude-plugin/marketplace.json": manifest([
      { name: "p3", category: "monitoring", source: "./plugins/p3" }, { name: "p4", category: "monitoring", source: "./plugins/p4" }], "second") });
    await lib("market-add", "--url", url, "--ref", "main");
    await lib("market-add", "--url", url2, "--ref", "main");
    const seen: string[] = [];
    for (const off of [0, 2]) {
      const r = await lib("catalog", "--limit", "2", "--offset", String(off));
      assert.deepEqual([r.total, r.offset, (r.rows as any[]).length], [4, off, 2]);
      seen.push(...(r.rows as any[]).map((x) => x.name));
    }
    assert.deepEqual(seen.sort(), ["bundled", "external", "p3", "p4"]);
    const r = await lib("catalog", "--limit", "2", "--offset", "99");
    assert.deepEqual([r.offset, (r.rows as any[]).length], [2, 2]);
  });

  test("plugin-fetch rejects unknown and malicious plugin names before touching disk", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    assert.deepEqual(await lib("plugin-fetch", "--marketplace", "mk", "--plugin", "nope"), { ok: false, code: "not_found", message: "Plugin not in the catalog: nope", target: "nope" });
    for (const bad of ["../evil", "..", "C:evil", "a/b"]) {
      const r = await lib("plugin-fetch", "--marketplace", "mk", "--plugin", bad);
      assert.deepEqual([r.ok, r.code], [false, "external_failed"], bad);
    }
    assert.equal((await lib("plugin-fetch", "--marketplace", "mk", "--plugin", "a/b")).message, "Invalid plugin name: 'a/b'");
    assert.ok(!fs.existsSync(path.join(store, "lib-cache", "markets", "mk", "plugins")));
  });

  test("external plugin failure leaves the registry untouched", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    const r = await lib("plugin-fetch", "--marketplace", "mk", "--plugin", "external");
    assert.deepEqual([r.ok, r.code], [false, "external_failed"]);
    assert.deepEqual(cfg().marketplaces[0].plugins, []);
  });

  test("bundled plugin fetch expands the sparse set in place", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    const r = await lib("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled");
    assert.equal(r.ok, true, r.message);
    assert.deepEqual([r.code, r.origin, r.plugin], ["ok", "market:mk/bundled", "bundled"]);
    assert.ok(fs.existsSync(path.join(r.cache as string, "skills", "bs1", "SKILL.md")));
    assert.deepEqual([r.has_hooks, r.has_mcp], [false, false]);
  });

  test("a genuinely empty category is zero without a warning", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    const r = await lib("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled");
    const comp = r.components as Record<string, number>;
    assert.deepEqual([comp.agents, comp.commands, comp.skills], [0, 0, 1]);
    assert.deepEqual(r.components_failed, {});
    assert.equal(r.warning, null);
  });

  test("a fetched plugin joins the library with market source", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    await lib("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled");
    const row = ((await lib("scan")).libraries as any[]).find((l) => l.source === "market");
    assert.equal(row.origin, "market:mk/bundled");
    assert.deepEqual(row.categories.skills.map((i: any) => i.name), ["bs1"]);
  });

  test("refetch is idempotent and keeps one registration", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    await lib("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled");
    const r = await lib("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled");
    assert.equal(r.ok, true, r.message);
    const m = cfg().marketplaces[0];
    assert.equal(m.plugins.length, 1);
    const mkRoot = path.join(store, "lib-cache", "markets", "mk");
    assert.ok(!fs.existsSync(path.join(mkRoot, "plugins")));
    assert.equal(m.plugins[0].cache, path.join(mkRoot, "repo", "plugins", "bundled"));
  });

  test("external refetch with a multi-segment path replaces the stale sha dir", async () => {
    const ext = path.join(tmp, "ext");
    const extUrl = repo(ext, { "packages/tool/skills/es1/SKILL.md": "---\nname: es1\n---\nv1\n" });
    const sha1 = git(ext, "rev-parse", "HEAD");
    const writeManifest = (sha: string) => commit(mk, { ".claude-plugin/marketplace.json": manifest([BUNDLED,
      { name: "multiseg", description: "multi-segment external", category: "database", source: { source: "git-subdir", url: extUrl, ref: "main", path: "packages/tool", sha } }]) });
    writeManifest(sha1);
    await lib("market-add", "--url", url, "--ref", "main");
    const r1 = await lib("plugin-fetch", "--marketplace", "mk", "--plugin", "multiseg");
    assert.equal(r1.ok, true, r1.message);
    commit(ext, { "packages/tool/skills/es1/SKILL.md": "---\nname: es1\n---\nv2\n" });
    const sha2 = git(ext, "rev-parse", "HEAD");
    assert.notEqual(sha1, sha2);
    writeManifest(sha2);
    await lib("market-add", "--url", url, "--ref", "main");
    const r2 = await lib("plugin-fetch", "--marketplace", "mk", "--plugin", "multiseg");
    assert.equal(r2.ok, true, r2.message);
    assert.deepEqual(fs.readdirSync(path.join(store, "lib-cache", "markets", "mk", "plugins", "multiseg")).sort(), [sha2.slice(0, 12)]);
    assert.equal(cfg().marketplaces[0].plugins[0].sha, sha2);
  });

  test("plugin-fetch warns when a category cannot be enumerated", async () => {
    await lib("market-add", "--url", url, "--ref", "main");
    await lib("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled");
    const broken = path.join(store, "lib-cache", "markets", "mk", "repo", "plugins", "bundled", "skills").toLowerCase();
    const r = await withBrokenDir(broken, () => lib("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled"));
    assert.equal(r.ok, true, r.message);
    assert.ok(!("skills" in (r.components as object)));
    assert.ok("skills" in (r.components_failed as object));
    assert.match(r.warning as string, /skills/);
  });

  test("a materialized root that does not exist is cache_missing and not registered", async () => {
    const extUrl = repo(path.join(tmp, "ext_ghost"), { "README.md": "no ghost subdir here\n" });
    commit(mk, { ".claude-plugin/marketplace.json": manifest([{ name: "ghost", category: "development", source: { source: "git-subdir", url: extUrl, ref: "main", path: "nope/deep" } }]) });
    await lib("market-add", "--url", url, "--ref", "main");
    const r = await lib("plugin-fetch", "--marketplace", "mk", "--plugin", "ghost");
    assert.deepEqual([r.ok, r.code], [false, "cache_missing"]);
    assert.match(r.message, /not found/);
    assert.equal(r.root_length, Array.from(r.root as string).length);
    assert.deepEqual(cfg().marketplaces[0].plugins, []);
  });

  test("market-level unregister removes everything", async () => {
    const r0 = await lib("market-add", "--url", url, "--ref", "main");
    const r = await lib("unregister", "--origin", "market:mk");
    assert.deepEqual([r.ok, r.message], [true, "Unregistered: market:mk"]);
    assert.deepEqual(cfg().marketplaces, []);
    assert.ok(!fs.existsSync(path.join(store, "lib-cache", "markets", "mk")));
    assert.ok(!fs.existsSync(r0.cache as string));
  });
});

describe("MarketUnregister", () => {
  // git 없이 돌도록 plugin-fetch 를 거치지 않고 등록 상태를 직접 만든다.
  let pluginsDir = "";
  let repoDir = "";
  beforeEach(() => {
    initStore();
    const root = path.join(store, "lib-cache", "markets", "mk");
    repoDir = path.join(root, "repo");
    pluginsDir = path.join(root, "plugins");
    fs.mkdirSync(path.join(repoDir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".claude-plugin", "marketplace.json"), "{}");
    fs.mkdirSync(path.join(repoDir, "plugins", "bundled"), { recursive: true });
    fs.mkdirSync(path.join(pluginsDir, "real2", "abc"), { recursive: true });
    const c = cfg();
    c.marketplaces = [{ id: "mk", url: "u", kind: "git", cache: repoDir, name: "testmarket", plugins: [
      { name: "bundled", cache: path.join(repoDir, "plugins", "bundled"), kind: "str-path" },
      { name: "real2", cache: path.join(pluginsDir, "real2", "abc"), staging: path.join(pluginsDir, "real2", "abc"), kind: "url" }] }];
    libStore.saveCfg(store, c);
  });

  test("plugin-level unregister removes only that plugin", async () => {
    const r = await lib("unregister", "--origin", "market:mk/real2");
    assert.deepEqual([r.ok, r.removed], [true, true]);
    const m = cfg().marketplaces[0];
    assert.deepEqual(m.plugins.map((p: any) => p.name), ["bundled"]);
    assert.ok(!fs.existsSync(path.join(pluginsDir, "real2")));
    assert.ok(fs.existsSync(path.join(repoDir, ".claude-plugin", "marketplace.json")));
  });

  test("plugin-level unregister refused when its own cache is held", async () => {
    const c = cfg();
    libStore.ledgerPut(c, target, "hooks", "real2-hook", { kind: "hooks", origin: "market:mk/real2", root: path.join(pluginsDir, "real2", "abc") });
    libStore.saveCfg(store, c);
    const r = await lib("unregister", "--origin", "market:mk/real2");
    assert.deepEqual([r.ok, r.code, r.held_by], [false, "held", ["hooks/real2-hook"]]);
    assert.ok(fs.existsSync(path.join(pluginsDir, "real2", "abc")));
    assert.equal(cfg().marketplaces[0].plugins.length, 2);
  });

  test("plugin-level unregister allowed when a different plugin's cache is held", async () => {
    const c = cfg();
    libStore.ledgerPut(c, target, "hooks", "bundled-hook", { kind: "hooks", origin: "market:mk/bundled", root: path.join(repoDir, "plugins", "bundled") });
    libStore.saveCfg(store, c);
    const r = await lib("unregister", "--origin", "market:mk/real2");
    assert.equal(r.ok, true);
    assert.deepEqual(cfg().marketplaces[0].plugins.map((p: any) => p.name), ["bundled"]);
  });

  test("bundled plugin unregister does not delete shared repo files", async () => {
    const r = await lib("unregister", "--origin", "market:mk/bundled");
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(path.join(repoDir, "plugins", "bundled")));
    assert.ok(fs.existsSync(path.join(pluginsDir, "real2", "abc")));
    assert.deepEqual(cfg().marketplaces[0].plugins.map((p: any) => p.name), ["real2"]);
  });

  test("unknown plugin or market is a no-op", async () => {
    assert.equal((await lib("unregister", "--origin", "market:mk/nope")).code, "noop");
    assert.equal((await lib("unregister", "--origin", "market:nope")).code, "noop");
    assert.equal(cfg().marketplaces[0].plugins.length, 2);
  });
});

describe("MarketSourceForms", () => {
  const MANIFEST_BODY = Buffer.from(JSON.stringify({ name: "jsonmarket", plugins: [
    { name: "ext1", description: "remote only", category: "development", source: { source: "url", url: "https://example.invalid/x.git", sha: "0".repeat(40) } }] }));
  const routes: Record<string, Buffer> = { "/mk/marketplace.json": MANIFEST_BODY, "/mk/broken.json": Buffer.from("nope"), "/marketplace.json": MANIFEST_BODY };
  let srv: http.Server;
  let base = "";
  let local = "";

  before(async () => {
    srv = http.createServer((req, res) => {
      const body = routes[req.url ?? ""];
      if (!body) res.writeHead(404).end();
      else res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) }).end(body);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });
  after(() => srv.close());
  beforeEach(() => {
    local = path.join(tmp, "localmk");
    fs.mkdirSync(path.join(local, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(local, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "localmarket", plugins: [
      { name: "bundled", description: "on disk", category: "development", source: "./plugins/bundled" }] }));
    initStore();
  });
  const rec = (mid: string) => cfg().marketplaces.find((m: any) => m.id === mid);

  test("local directory registers without git or copying", async () => {
    const r = await withPath("", () => lib("market-add", "--url", local));
    assert.equal(r.ok, true, r.message);
    assert.deepEqual([r.kind, r.name, r.cache, r.url], ["local", "localmarket", local, local]);
    assert.match(r.sha as string, /^[0-9a-f]{12}$/);
    assert.ok(!fs.existsSync(path.join(store, "lib-cache", "markets", "localmk", "repo")));
  });

  test("local without manifest is refused as not a marketplace", async () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    const r = await lib("market-add", "--url", plain);
    assert.deepEqual([r.ok, r.code], [false, "not_a_marketplace"]);
    assert.match(r.message, /not a marketplace/);
  });

  test("local notations of the same dir are one registration", async () => {
    await lib("market-add", "--url", local);
    const r = await lib("market-add", "--url", path.join(local, "sub", "..") + path.sep);
    assert.deepEqual([r.ok, r.already], [true, true]);
    assert.match(r.message, /reread from disk/);
  });

  test("local fetch rereads the edited manifest", async () => {
    const before0 = await lib("market-add", "--url", local);
    fs.writeFileSync(path.join(local, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "localmarket", plugins: [
      { name: "bundled", category: "development", source: "./plugins/bundled" }, { name: "added", category: "database", source: "./plugins/added" }] }));
    const r = await lib("fetch", "--origin", "market:localmk");
    assert.deepEqual([r.ok, r.plugins], [true, 2]);
    assert.notEqual(r.sha, before0.sha);
    assert.equal(rec("localmk").kind, "local");
  });

  test("local bundled plugin fetch says why instead of a git error", async () => {
    await lib("market-add", "--url", local);
    const r = await lib("plugin-fetch", "--marketplace", "localmk", "--plugin", "bundled");
    assert.deepEqual([r.ok, r.code], [false, "unsupported"]);
    assert.match(r.message, /has no repository/);
  });

  test("unregistering a local market never deletes the user's directory", async () => {
    await lib("market-add", "--url", local);
    const r = await lib("unregister", "--origin", "market:localmk");
    assert.equal(r.removed, true);
    assert.ok(fs.existsSync(path.join(local, ".claude-plugin", "marketplace.json")));
  });

  test("json url registers and lands in the catalog", async () => {
    const r = await lib("market-add", "--url", base + "/mk/marketplace.json");
    assert.equal(r.ok, true, r.message);
    assert.deepEqual([r.kind, r.id, r.plugins], ["json", "mk", 1]);
    assert.deepEqual(((await lib("catalog")).rows as any[]).map((x) => x.name), ["ext1"]);
  });

  test("undeducible id asks for --id", async () => {
    const r = await lib("market-add", "--url", base + "/marketplace.json");
    assert.deepEqual([r.ok, r.code], [false, "invalid_arg"]);
    assert.match(r.message, /--id/);
    assert.equal((await lib("market-add", "--url", base + "/marketplace.json", "--id", "root")).ok, true);
  });

  test("json market survives a fetch round trip", async () => {
    await lib("market-add", "--url", base + "/mk/marketplace.json");
    const r = await lib("fetch", "--origin", "market:mk");
    assert.deepEqual([r.ok, r.kind], [true, "json"]);
    assert.equal(rec("mk").kind, "json");
  });

  test("broken json url is refused and registers nothing", async () => {
    const r = await lib("market-add", "--url", base + "/mk/broken.json");
    assert.deepEqual([r.ok, r.code], [false, "external_failed"]);
    assert.deepEqual(gdMarkets(), []);
  });

  test("unknown source form names the transport helper", async () => {
    const r = await lib("market-add", "--url", "ext::sh -c evil");
    assert.deepEqual([r.ok, r.code], [false, "invalid_arg"]);
    assert.match(r.message, /transport helper/);
  });

  test("records without kind are treated as git", { skip: noGit }, async () => {
    const c = cfg();
    c.marketplaces = [{ id: "old", url: "https://example.invalid/x.git", cache: local, name: "old", plugins: [] }];
    libStore.saveCfg(store, c);
    const r = await lib("plugin-fetch", "--marketplace", "old", "--plugin", "bundled");
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.message, /has no repository/);
  });

  test("scan flags a library that is also a marketplace", async () => {
    const r = await lib("scan", "--lib", local);
    assert.equal(r.ok, true, r.message);
    const row = (r.libraries as any[]).find((l) => libStore.norm(l.lib) === libStore.norm(local));
    assert.equal(row.marketplace, true);
  });

  test("scan does not flag a plain library", async () => {
    const plain = path.join(tmp, "plainlib");
    fs.mkdirSync(path.join(plain, "skills"), { recursive: true });
    const row = ((await lib("scan", "--lib", plain)).libraries as any[]).find((l) => libStore.norm(l.lib) === libStore.norm(plain));
    assert.equal(row.marketplace, false);
  });

  function gdMarkets(): unknown[] {
    return cfg().marketplaces ?? [];
  }
});

describe("ScanRecords", () => {
  let kit = "";
  beforeEach(() => {
    kit = path.join(tmp, "kit", ".claude");
    write(path.join(kit, "agents", "a1.md"), "agent body\n");
    initStore();
  });
  const addRemote = (rec: Record<string, unknown>) => {
    const c = cfg();
    (c.remotes ??= []).push(rec);
    libStore.saveCfg(store, c);
  };
  const rowOf = async (libPath: string) => ((await lib("scan")).libraries as any[]).find((l) => l.lib === libPath);

  test("scan emits the origin of a local library", async () => {
    const r = await lib("scan", "--lib", kit);
    assert.equal(r.ok, true, r.message);
    const row = (r.libraries as any[])[0];
    assert.equal(row.source, "registered");
    assert.equal(row.origin, localOrigin(kit));
    assert.equal(row.categories.agents[0].origin, row.origin);
  });

  test("uppercase category dirs are scanned via the map", async () => {
    const up = path.join(tmp, "upkit");
    write(path.join(up, "Skills", "s1", "SKILL.md"), "---\nname: s1\n---\n");
    addRemote({ id: "upkit", url: "u", cache: up, map: { skills: "Skills" } });
    const row = await rowOf(up);
    assert.deepEqual([row.source, row.origin], ["remote", "remote:upkit"]);
    assert.deepEqual(row.categories.skills.map((i: any) => i.name), ["s1"]);
  });

  test("a missing remote cache reports an error row, not silence", async () => {
    const gone = path.join(tmp, "gone");
    addRemote({ id: "gone", url: "u", cache: gone });
    const row = await rowOf(gone);
    assert.deepEqual([row.error, row.source], ["Path not found", "remote"]);
  });

  test("scan stays offline", async () => {
    addRemote({ id: "offlinekit", url: "u", cache: kit });
    const r = await withPath("", () => lib("scan"));
    assert.equal(r.ok, true, r.message);
  });

  test("install with --lib and --origin resolves the remote record, not a local one", async () => {
    const up = path.join(tmp, "upkit2");
    write(path.join(up, "Agents", "a1.md"), "agent body\n");
    addRemote({ id: "upkit2", url: "u", cache: up, map: { agents: "Agents" } });
    const r = await lib("install", "agents", "a1", "--lib", up, "--origin", "remote:upkit2");
    assert.equal(r.ok, true, r.message);
    assert.equal(r.origin, "remote:upkit2");
    assert.ok(fs.existsSync(path.join(target, "agents", "a1.md")));
    assert.equal(libStore.ledgerGet(cfg(), target, "agents", "a1")?.origin, "remote:upkit2");
  });
});

describe("ScanEnumerationErrors", () => {
  let kit = "";
  beforeEach(() => {
    kit = path.join(tmp, "kit", ".claude");
    write(path.join(kit, "skills", "s1", "SKILL.md"), "---\nname: s1\n---\n");
    write(path.join(kit, "agents", "a1.md"), "agent\n");
    initStore();
  });

  test("an enumeration failure surfaces as an error, not zero items", async () => {
    const r = await withBrokenDir(path.join(kit, "skills").toLowerCase(), () => lib("scan", "--lib", kit));
    assert.equal(r.ok, true, r.message);
    const row = (r.libraries as any[])[0];
    assert.match(row.error, /^Could not list some items - skills: /);
    assert.deepEqual(row.categories.skills, []);
    assert.deepEqual(row.categories.agents.map((i: any) => i.name), ["a1"]);
  });

  test("a genuinely empty library reports zero items without an error", async () => {
    const empty = path.join(tmp, "empty", ".claude");
    fs.mkdirSync(empty, { recursive: true });
    const row = ((await lib("scan", "--lib", empty)).libraries as any[])[0];
    assert.ok(!("error" in row));
    assert.deepEqual(Object.keys(row.categories).sort(), ["agents", "commands", "output-styles", "rules", "skills", "workflows"]);
    assert.ok(Object.values(row.categories).every((v) => Array.isArray(v) && v.length === 0));
  });
});

describe("ConflictStatus", () => {
  let libA = "";
  let libB = "";
  const kit = (name: string, body: string) => {
    const d = path.join(tmp, name);
    write(path.join(d, "agents", "code-reviewer.md"), body);
    return d;
  };
  beforeEach(() => {
    fs.mkdirSync(target, { recursive: true });
    libA = kit("kitA", "from A\n");
    libB = kit("kitB", "from B\n");
    initStore();
  });
  const statusOf = async (l: string) => ((await lib("scan", "--lib", l)).libraries as any[])[0].categories.agents[0];

  test("a second origin sees conflict, not modified", async () => {
    await lib("scan", "--lib", libA);
    const r = await lib("install", "agents", "code-reviewer", "--lib", libA);
    assert.equal(r.ok, true, r.message);
    assert.equal((await statusOf(libA)).status, "installed");
    const it = await statusOf(libB);
    assert.deepEqual([it.status, it.owner], ["conflict", localOrigin(libA)]);
  });

  test("without a ledger entry status falls back to the hash compare", async () => {
    write(path.join(target, "agents", "code-reviewer.md"), "from A\n");
    assert.equal((await statusOf(libA)).status, "installed");
    assert.equal((await statusOf(libB)).status, "modified");
  });

  test("uninstall refuses when the origin is not the owner", async () => {
    await lib("scan", "--lib", libA);
    await lib("install", "agents", "code-reviewer", "--lib", libA);
    const r = await lib("uninstall", "agents", "code-reviewer", "--origin", localOrigin(libB));
    assert.deepEqual([r.ok, r.code, r.owner], [false, "owner_mismatch", localOrigin(libA)]);
    assert.ok(fs.existsSync(path.join(target, "agents", "code-reviewer.md")));
  });

  test("uninstall clears the ledger entry", async () => {
    await lib("scan", "--lib", libA);
    await lib("install", "agents", "code-reviewer", "--lib", libA);
    const r = await lib("uninstall", "agents", "code-reviewer");
    assert.equal(r.ok, true, r.message);
    assert.equal(r.owner, localOrigin(libA));
    assert.equal(libStore.ledgerGet(cfg(), target, "agents", "code-reviewer"), null);
    assert.equal((await statusOf(libB)).status, "not_installed");
  });

  test("overwriting after a conflict transfers ownership", async () => {
    await lib("scan", "--lib", libA);
    await lib("install", "agents", "code-reviewer", "--lib", libA);
    const r = await lib("install", "agents", "code-reviewer", "--lib", libB);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.synced, true);
    assert.equal((await statusOf(libB)).status, "installed");
    assert.equal((await statusOf(libA)).status, "conflict");
  });
});

describe("HooksInstall", () => {
  let settings = "";
  let root = "";
  let claudeJson = "";
  const ORIGIN = ["--origin", "market:mk/sg"];
  beforeEach(() => {
    fs.mkdirSync(target, { recursive: true });
    settings = path.join(target, "settings.json");
    write(settings, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
    root = path.join(tmp, "cache", "plugins", "sg", "abc123");
    fs.mkdirSync(path.join(root, "hooks-handlers"), { recursive: true });
    write(path.join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [
      { type: "command", command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks-handlers/s.sh"', timeout: 5 }] }] } }));
    write(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      "sg-server": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server/index.js"] },
      other: { command: "python", args: ["${CLAUDE_PLUGIN_ROOT}/o.py"] } } }));
    claudeJson = path.join(tmp, "claude.json");
    write(claudeJson, JSON.stringify({ projects: {} }));
    initStore();
    const c = cfg();
    c.marketplaces = [{ id: "mk", url: "u", cache: path.join(tmp, "repo"), plugins: [{ name: "sg", sha: "abc123", cache: root }] }];
    libStore.saveCfg(store, c);
  });
  const s = () => readJson(settings);
  const cj = () => readJson(claudeJson);
  const hooks = (...extra: string[]) => lib("hooks-install", ...ORIGIN, "--settings", settings, ...extra);
  // --claude-json, --desktop-config 는 부모 파서 옵션이라 서브커맨드 앞에 온다.
  const mcp = (op: string, extra: string[] = [], parent: string[] = []) =>
    main(["--store", store, "--target", target, "--no-snapshot", "--claude-json", claudeJson, ...parent, op, ...ORIGIN, ...extra]);
  const dropPlugins = () => {
    const c = cfg();
    c.marketplaces[0].plugins = [];
    libStore.saveCfg(store, c);
  };

  test("install merges the entry with the absolute cache path", async () => {
    const r = await hooks();
    assert.equal(r.ok, true, r.message);
    assert.deepEqual([r.code, r.message, r.added, r.removed, r.root], ["ok", "Hooks installed: sg (1)", 1, 0, root]);
    const h = s().hooks.SessionStart[0].hooks[0];
    assert.ok(h.command.includes(root));
    assert.ok(!h.command.includes("${CLAUDE_PLUGIN_ROOT}"));
    assert.equal(h.timeout, 5);
    assert.deepEqual(s().permissions.allow, ["Bash(ls:*)"]);
  });

  test("hooks install is idempotent", async () => {
    await hooks();
    await hooks();
    assert.equal(s().hooks.SessionStart.length, 1);
  });

  test("scan reports the hooks install state for the owning origin", async () => {
    const row = async (o: string) => ((await lib("scan")).libraries as any[]).find((l) => l.origin === o);
    const before0 = await row("market:mk/sg");
    assert.deepEqual([before0.has_hooks, before0.hooks_installed], [true, false]);
    await hooks();
    const after0 = await row("market:mk/sg");
    assert.deepEqual([after0.hooks_installed, after0.hooks_events], [true, ["SessionStart"]]);
    const c = cfg();
    c.marketplaces[0].id = "other";
    libStore.saveCfg(store, c);
    assert.equal((await row("market:other/sg")).hooks_installed, false);
  });

  test("install records the root in the ledger", async () => {
    await hooks();
    const rec = libStore.ledgerGet(cfg(), target, "hooks", "sg") as Record<string, unknown>;
    assert.deepEqual([rec.kind, rec.root, rec.origin, rec.events], ["hooks", root, "market:mk/sg", ["SessionStart"]]);
  });

  test("reinstall after a sha change removes the entries of the old root", async () => {
    await hooks();
    const newRoot = path.join(tmp, "cache", "plugins", "sg", "def456");
    fs.cpSync(root, newRoot, { recursive: true });
    const c = cfg();
    Object.assign(c.marketplaces[0].plugins[0], { sha: "def456", cache: newRoot });
    libStore.saveCfg(store, c);
    const r = await hooks();
    assert.equal(r.ok, true, r.message);
    const arr = s().hooks.SessionStart;
    assert.equal(arr.length, 1);
    assert.ok(arr[0].hooks[0].command.includes(newRoot));
  });

  test("uninstall removes the entry and the ledger record", async () => {
    await hooks();
    const r = await lib("hooks-uninstall", ...ORIGIN, "--settings", settings);
    assert.equal(r.ok, true, r.message);
    assert.deepEqual([r.message, r.removed, r.changed, r.degraded, r.warning], ["Hooks removed: sg (1)", 1, true, false, null]);
    assert.ok(!("hooks" in s()));
    assert.deepEqual(s().permissions.allow, ["Bash(ls:*)"]);
    assert.equal(libStore.ledgerGet(cfg(), target, "hooks", "sg"), null);
  });

  test("install refuses an unmaterialized plugin", async () => {
    dropPlugins();
    const r = await hooks();
    assert.deepEqual([r.ok, r.code], [false, "not_fetched"]);
    assert.match(r.message, /fetch/);
  });

  test("install takes no network", async () => {
    const r = await withPath("", () => hooks());
    assert.equal(r.ok, true, r.message);
  });

  test("dry run returns commands and warnings without writing", async () => {
    const r = await hooks("--dry-run");
    assert.deepEqual([r.ok, r.code, r.dry_run], [true, "dry_run", true]);
    assert.ok((r.commands as string[])[0].includes(root));
    assert.ok(Array.isArray(r.warnings));
    assert.deepEqual(r.events, ["SessionStart"]);
    assert.ok(!("hooks" in s()));
  });

  test("mcp install substitutes the root in args", async () => {
    const r = await mcp("mcp-install");
    assert.equal(r.ok, true, r.message);
    assert.deepEqual([r.message, r.target, r.servers], ["MCP servers installed: sg (2, scope=user)", claudeJson, ["other", "sg-server"]]);
    const srv = cj().mcpServers["sg-server"];
    assert.ok(srv.args[0].includes(root));
    assert.ok(!JSON.stringify(srv).includes("${CLAUDE_PLUGIN_ROOT}"));
    assert.deepEqual(cj().projects, {});
  });

  test("mcp install of a single server writes that server only", async () => {
    await mcp("mcp-install", ["--server", "sg-server"]);
    assert.deepEqual(Object.keys(cj().mcpServers), ["sg-server"]);
    const r = await mcp("mcp-install", ["--server", "nope"]);
    assert.deepEqual([r.ok, r.code, r.available], [false, "not_found", ["other", "sg-server"]]);
  });

  test("mcp install is idempotent", async () => {
    await mcp("mcp-install");
    await mcp("mcp-install");
    assert.deepEqual(Object.keys(cj().mcpServers).sort(), ["other", "sg-server"]);
  });

  test("mcp uninstall removes only this plugin's servers", async () => {
    write(claudeJson, JSON.stringify({ projects: {}, mcpServers: { mine: { command: "x" } } }));
    await mcp("mcp-install");
    const r = await mcp("mcp-uninstall");
    assert.equal(r.ok, true, r.message);
    assert.deepEqual([r.removed, r.changed], [2, true]);
    assert.deepEqual(Object.keys(cj().mcpServers), ["mine"]);
    assert.deepEqual(cj().projects, {});
    assert.equal((await mcp("mcp-uninstall")).code, "noop");
  });

  test("mcp install records the ledger with server names", async () => {
    await mcp("mcp-install");
    const rec = libStore.ledgerGet(cfg(), target, "mcp", "sg") as Record<string, unknown>;
    assert.deepEqual([rec.kind, rec.servers, rec.root, rec.scope, rec.target], ["mcp", ["other", "sg-server"], root, "user", claudeJson]);
  });

  test("mcp install refuses an unmaterialized plugin", async () => {
    dropPlugins();
    assert.match((await mcp("mcp-install")).message, /fetch/);
  });

  test("mcp dry run shows servers without writing", async () => {
    const r = await mcp("mcp-install", ["--dry-run"]);
    assert.deepEqual([r.dry_run, r.servers], [true, ["other", "sg-server"]]);
    assert.ok(!("mcpServers" in cj()));
  });

  test("desktop scope writes the desktop config, not claude.json", async () => {
    const desktop = path.join(tmp, "claude_desktop_config.json");
    write(desktop, "{}");
    const r = await mcp("mcp-install", ["--scope", "desktop"], ["--desktop-config", desktop]);
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(Object.keys(readJson(desktop).mcpServers).sort(), ["other", "sg-server"]);
    assert.ok(!("mcpServers" in cj()));
  });
});

describe("HooksUninstallStructural", () => {
  let settings = "";
  let root = "";
  const ORIGIN = ["--origin", "market:mk/sg"];
  beforeEach(() => {
    fs.mkdirSync(target, { recursive: true });
    settings = path.join(target, "settings.json");
    write(settings, JSON.stringify({ hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "echo user-own" }] }] } }));
    root = path.join(tmp, "cache", "plugins", "sg", "abc123");
    write(path.join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks-handlers/pre.sh"' }] }],
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: "global-lint-tool --check" }] }] } }));
    initStore();
    const c = cfg();
    c.marketplaces = [{ id: "mk", url: "u", cache: path.join(tmp, "repo"), plugins: [{ name: "sg", sha: "abc123", cache: root }] }];
    libStore.saveCfg(store, c);
  });
  const s = () => readJson(settings);
  const stopCmds = () => ((s().hooks ?? {}).Stop ?? []).map((h: any) => h.hooks[0].command);

  test("uninstall removes a hook that does not reference the plugin root", async () => {
    await lib("hooks-install", ...ORIGIN, "--settings", settings);
    assert.deepEqual([s().hooks.PreToolUse.length, s().hooks.Stop.length], [1, 2]);
    const r = await lib("hooks-uninstall", ...ORIGIN, "--settings", settings);
    assert.equal(r.ok, true, r.message);
    assert.ok(!stopCmds().includes("global-lint-tool --check"));
    assert.deepEqual(Object.keys(s().hooks), ["Stop"]);
  });

  test("uninstall leaves the user's own hook in the same event", async () => {
    await lib("hooks-install", ...ORIGIN, "--settings", settings);
    await lib("hooks-uninstall", ...ORIGIN, "--settings", settings);
    assert.deepEqual(stopCmds(), ["echo user-own"]);
  });

  test("a hook with a float timeout is still removed by identity", async () => {
    write(path.join(root, "hooks", "hooks.json"), '{"hooks": {"Stop": [{"matcher": "*", "hooks": [{"type": "command", "command": "global-lint-tool --check", "timeout": 1.5}]}]}}');
    await lib("hooks-install", ...ORIGIN, "--settings", settings);
    assert.match(fs.readFileSync(settings, "utf-8"), /"timeout": 1\.5/);
    const r = await lib("hooks-uninstall", ...ORIGIN, "--settings", settings);
    assert.deepEqual([r.ok, r.removed], [true, 1]);
    assert.deepEqual(stopCmds(), ["echo user-own"]);
  });

  test("settings numbers keep their python spelling through install and uninstall", async () => {
    write(settings, '{\n  "ratio": 1.0,\n  "big": 12345678901234567890,\n  "tiny": 1e-07\n}');
    const spelled = () => {
      const text = fs.readFileSync(settings, "utf-8");
      for (const re of [/"ratio": 1\.0,/, /"big": 12345678901234567890,/, /"tiny": 1e-07/]) assert.match(text, re);
    };
    assert.equal((await lib("hooks-install", ...ORIGIN, "--settings", settings)).ok, true);
    spelled();
    assert.equal((await lib("hooks-uninstall", ...ORIGIN, "--settings", settings)).ok, true);
    spelled();
    assert.ok(!("hooks" in readJson(settings)));
  });

  test("a root-free hook with a 1.0 timeout stays single across reinstalls and matches python bytes", async () => {
    write(path.join(root, "hooks", "hooks.json"), '{"hooks": {"Stop": [{"matcher": "*", "hooks": [{"type": "command", "command": "global-lint-tool --check", "timeout": 1.0}]}]}}');
    write(path.join(root, ".mcp.json"), '{"mcpServers": {"srv": {"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/s.js"], "timeout": 1.0}}}');
    const claudeJson = path.join(tmp, "claude.json");
    write(claudeJson, '{"projects": {}}');
    const c = cfg();
    c.ratio = new libStore.PyFloat(1);
    libStore.saveCfg(store, c);
    for (let i = 0; i < 2; i++) assert.equal((await lib("hooks-install", ...ORIGIN, "--settings", settings)).ok, true);
    const mcp = await main(["--store", store, "--target", target, "--no-snapshot", "--claude-json", claudeJson, "mcp-install", ...ORIGIN]);
    assert.equal(mcp.ok, true, mcp.message);
    // Python 판 library.py 로 같은 입력에서 hooks-install 두 번, mcp-install 한 번을 실행해 얻은 바이트.
    assert.equal(fs.readFileSync(settings, "utf-8"),
      '{\n  "hooks": {\n    "Stop": [\n      {\n        "matcher": "*",\n        "hooks": [\n          {\n            "type": "command",\n'
      + '            "command": "echo user-own"\n          }\n        ]\n      },\n      {\n        "matcher": "*",\n        "hooks": [\n'
      + '          {\n            "type": "command",\n            "command": "global-lint-tool --check",\n            "timeout": 1.0\n'
      + '          }\n        ]\n      }\n    ]\n  }\n}');
    assert.equal(fs.readFileSync(claudeJson, "utf-8"),
      '{\n  "projects": {},\n  "mcpServers": {\n    "srv": {\n      "command": "node",\n      "args": [\n        '
      + JSON.stringify(root + "/s.js") + '\n      ],\n      "timeout": 1.0\n    }\n  }\n}');
    assert.match(fs.readFileSync(libStore.storeConfigPath(store), "utf-8"), /"ratio": 1\.0,\r?\n/);
  });

  test("uninstall degrades gracefully when the cache is gone", async () => {
    await lib("hooks-install", ...ORIGIN, "--settings", settings);
    fs.rmSync(root, { recursive: true, force: true });
    const r = await lib("hooks-uninstall", ...ORIGIN, "--settings", settings);
    assert.deepEqual([r.ok, r.degraded], [true, true]);
    assert.ok(r.warning);
    assert.ok(!("PreToolUse" in (s().hooks ?? {})));
    assert.ok(stopCmds().includes("global-lint-tool --check"));
    assert.ok(stopCmds().includes("echo user-own"));
  });
});

describe("ScanHooksMcpFlags", () => {
  let both = "";
  let neither = "";
  let missing = "";
  beforeEach(() => {
    initStore();
    both = path.join(tmp, "plugin-both");
    write(path.join(both, "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
    write(path.join(both, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    neither = path.join(tmp, "plugin-neither");
    fs.mkdirSync(neither, { recursive: true });
    missing = path.join(tmp, "plugin-missing");
    const c = cfg();
    c.libraries = [both, neither];
    (c.remotes ??= []).push({ id: "gone", url: "u", cache: missing });
    libStore.saveCfg(store, c);
  });
  const rows = async () => {
    const r = await lib("scan");
    assert.equal(r.ok, true, r.message);
    return Object.fromEntries((r.libraries as any[]).map((l) => [l.lib, l]));
  };

  test("a plugin with both reports true", async () => {
    const row = (await rows())[both];
    assert.deepEqual([row.has_hooks, row.has_mcp], [true, true]);
  });

  test("a plugin with neither reports false", async () => {
    const row = (await rows())[neither];
    assert.deepEqual([row.has_hooks, row.has_mcp], [false, false]);
  });

  test("a missing cache row reports false without raising", async () => {
    const row = (await rows())[missing];
    assert.deepEqual([row.error, row.has_hooks, row.has_mcp, row.units], ["Path not found", false, false, []]);
  });

  test("sub units are listed and install by their own origin", async () => {
    const tools = path.join(tmp, "tools");
    const alpha = path.join(tools, "Hooks", "alpha");
    write(path.join(alpha, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/index.js"' }] }] } }));
    write(path.join(tools, "servers", "beta", ".mcp.json"), JSON.stringify({ mcpServers: { beta: { command: "python", args: ["${CLAUDE_PLUGIN_ROOT}/s.py"] } } }));
    fs.mkdirSync(path.join(tools, "Hooks", "bare"), { recursive: true });
    write(path.join(tools, "deep", "x", "gamma", "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
    write(path.join(target, "settings.json"), "{}");
    const c = cfg();
    c.libraries.push(tools);
    libStore.saveCfg(store, c);

    const row = (await rows())[tools];
    assert.deepEqual([row.has_hooks, row.has_mcp], [false, false]);
    const units = Object.fromEntries(row.units.map((u: any) => [u.name, u]));
    assert.deepEqual(Object.keys(units).sort(), ["alpha", "beta"]);
    assert.deepEqual([units.alpha.has_hooks, units.alpha.has_mcp, units.beta.has_hooks, units.beta.has_mcp], [true, false, false, true]);
    assert.ok(units.alpha.origin.startsWith("local:"));

    const dry = await lib("hooks-install", "--origin", units.alpha.origin, "--dry-run");
    assert.equal(dry.ok, true, dry.message);
    assert.ok((dry.commands as string[])[0].toLowerCase().includes(alpha.toLowerCase()));
    const r = await lib("hooks-install", "--origin", units.alpha.origin);
    assert.equal(r.ok, true, r.message);
    const unit = (await rows())[tools].units.find((u: any) => u.name === "alpha");
    assert.deepEqual([unit.hooks_installed, unit.hooks_events], [true, ["Stop"]]);
  });
});

describe("junction folders", { skip: process.platform !== "win32" }, () => {
  // 정션은 tmp 안의 픽스처만 가리키게 하고, 정리할 때 링크만 지운다(rmdirSync).
  const links: string[] = [];
  const junction = (to: string, at: string) => {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(to, at, "junction");
    links.push(at);
  };
  const unlinkAll = () => {
    for (const l of links.splice(0).reverse()) fs.rmdirSync(l);
  };
  let kit = "";
  beforeEach(() => {
    kit = path.join(tmp, "kit");
    initStore();
  });
  const skills = async () => {
    const row = ((await lib("scan", "--lib", kit)).libraries as any[])[0];
    assert.ok(!("error" in row), row.error);
    return row.categories.skills as any[];
  };

  test("a junctioned skill folder is listed, installed and hashed through the junction", async () => {
    try {
      write(path.join(kit, "skills", "plain", "SKILL.md"), "---\nname: plain\n---\n");
      write(path.join(tmp, "fixture", "linked", "SKILL.md"), "---\nname: linked\n---\n");
      write(path.join(tmp, "fixture", "linked", "ref", "notes.md"), "notes\n");
      junction(path.join(tmp, "fixture", "linked"), path.join(kit, "skills", "linked"));
      assert.deepEqual((await skills()).map((i) => i.name), ["linked", "plain"]);
      const r = await lib("install", "skills", "linked", "--lib", kit);
      assert.equal(r.ok, true, r.message);
      assert.ok(fs.existsSync(path.join(target, "skills", "linked", "ref", "notes.md")));
      assert.equal((await skills()).find((i) => i.name === "linked").status, "installed");
    } finally {
      unlinkAll();
    }
  });

  test("a junction loop is walked once", async () => {
    try {
      write(path.join(kit, "skills", "s1", "SKILL.md"), "---\nname: s1\n---\n");
      junction(path.join(kit, "skills"), path.join(kit, "skills", "group", "loop"));
      assert.deepEqual((await skills()).map((i) => i.name), ["s1"]);
    } finally {
      unlinkAll();
    }
  });
});

describe("market-discover", () => {
  test("the unusable reason names the actual source kind", async () => {
    const pdir = path.join(tmp, "plugins");
    write(path.join(pdir, "known_marketplaces.json"), JSON.stringify({
      pkg: { source: { source: "npm", package: "some-pkg" } },
      dir: { source: { source: "directory", path: "/x/y" } } }));
    const r = await main(["--store", path.join(tmp, "store"), "market-discover", "--plugins-dir", pdir]);
    assert.equal(r.ok, true, r.message);
    const by = Object.fromEntries((r.unusable as any[]).map((x) => [x.name, x]));
    assert.match(by.pkg.reason, /npm/);
    assert.doesNotMatch(by.pkg.reason, /local path/i);
    assert.match(by.dir.reason, /directory/);
    assert.ok(by.dir.reason.includes("/x/y"));
  });
});
