// tests/test_plugin_catalog.py 를 옮긴 것. 실사용자의 캐시를 읽지 않는다(전부 path/--cache 를 명시).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultCache, details, load, main, summary } from "../../src/core/plugin_catalog.ts";
import { exitCode } from "../../src/core/cli_result.ts";

type O = Record<string, any>;

function entry(over: O = {}): O {
  return {
    plugin: "code-review",
    tokens: { "claude-opus-4-7": { always_on: 25, on_invoke: 2489 } },
    components: { commands: [], agents: [], skills: [], hooks: [], mcpServers: [], lspServers: [] },
    unique_installs: 404331,
    last_updated: "2026-02-20T01:06:49Z",
    marketplace_entry: {
      name: "code-review", description: "자동 코드 리뷰", author: { name: "Anthropic", email: "s@a.com" },
      source: "./plugins/code-review", category: "productivity", homepage: "https://example.invalid/code-review",
    },
    source: "code-review@claude-plugins-official",
    sha: null, source_sha: "aecd4c85",
    ...over,
  };
}

const hasList = (v: unknown): boolean => Array.isArray(v) || (!!v && typeof v === "object" && Object.values(v).some(hasList));

let tmp = "", cache = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin_catalog_test_"));
  cache = path.join(tmp, "plugin-catalog-cache.json");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const raw = (doc: unknown) => fs.writeFileSync(cache, JSON.stringify(doc));
function cacheWith(plugins: O, catOver: O = {}) {
  raw({ version: 1, fetchedAt: "2026-08-06T04:31:43.504Z", catalog: {
    generated_at: "2026-08-06T04:00:00Z", installs_generated_at: "2026-08-05T00:00:00Z",
    marketplace_sha: "deadbeef", models: ["claude-opus-4-7", "claude-sonnet-4-6"], plugins, ...catOver,
  } });
}
const det = (id: string) => details(id, cache) as O;

describe("component shapes", () => {
  beforeEach(() => cacheWith({
    "dictish@m": entry({ components: {
      skills: [{ name: "alpha", chars: { always_on: 50 } }, { name: "beta", chars: {} }],
      commands: [{ name: "review", chars: {} }], agents: [], hooks: [], mcpServers: [], lspServers: [] } }),
    "stringy@m": entry({ components: {
      skills: ["alpha", "beta"], hooks: ["PreToolUse", "PostToolUse"], mcpServers: ["chrome-devtools"],
      commands: [], agents: [], lspServers: [] } }),
  }));

  test("dict items become name strings and string items pass through", () => {
    const a = det("dictish@m").components, b = det("stringy@m").components;
    assert.deepEqual(a.skills, ["alpha", "beta"]);
    assert.deepEqual(a.commands, ["review"]);
    for (const names of Object.values(a) as unknown[][]) assert.ok(names.every((n) => typeof n === "string"));
    assert.deepEqual(b.hooks, ["PreToolUse", "PostToolUse"]);
    assert.deepEqual(b.mcpServers, ["chrome-devtools"]);
    assert.deepEqual(a.skills, b.skills);
  });

  test("unnameable items are dropped, not nulled", () => {
    cacheWith({ "weird@m": entry({ components: { skills: [{ chars: {} }, { name: 7 }, { name: "" }, 42, null, { name: "ok" }, "plain"] } }) });
    assert.deepEqual(det("weird@m").components.skills, ["ok", "plain"]);
  });

  test("malformed components do not throw", () => {
    cacheWith({ "a@m": entry({ components: "nope" }), "b@m": entry({ components: { skills: "nope", hooks: null } }), "c@m": entry({ components: null }) });
    const got = load(cache);
    assert.ok(got.ok);
    assert.deepEqual(got.entries["a@m"].components, {});
    assert.deepEqual(got.entries["b@m"].components, { skills: [], hooks: [] });
    assert.deepEqual(got.entries["c@m"].components, {});
    assert.equal(got.entries["b@m"].total, 0);
  });

  test("unknown component kind is carried through", () => {
    cacheWith({ "a@m": entry({ components: { widgets: [{ name: "w1" }] } }) });
    assert.deepEqual(det("a@m").components.widgets, ["w1"]);
    assert.deepEqual(det("a@m").counts, { widgets: 1 });
  });
});

describe("broken input", () => {
  test("missing, corrupt, no catalog, wrong types and non-object top level are ok:false", () => {
    const missing = load(path.join(tmp, "no-such-file.json"));
    assert.deepEqual([missing.ok, missing.entries, missing.models, missing.fetched_at], [false, {}, [], ""]);
    fs.writeFileSync(cache, '{"version": 1, "catalog": {"plugins": {');
    assert.equal(load(cache).ok, false);
    raw({ version: 1, fetchedAt: "x" });
    assert.equal(load(cache).ok, false);
    for (const cat of [{ generated_at: "x" }, { plugins: [] }, { plugins: "nope" }]) {
      raw({ catalog: cat });
      assert.equal(load(cache).ok, false, JSON.stringify(cat));
    }
    fs.writeFileSync(cache, "[1, 2, 3]");
    assert.equal(load(cache).ok, false);
  });

  test("non-dict entries are skipped, not fatal", () => {
    cacheWith({ "good@m": entry(), "bad@m": "nope", "also-bad@m": null });
    const got = load(cache);
    assert.ok(got.ok);
    assert.deepEqual(Object.keys(got.entries), ["good@m"]);
  });

  test("summary and details survive a broken file; empty plugins is ok", () => {
    fs.writeFileSync(cache, "not json at all");
    assert.deepEqual(summary(cache), {});
    assert.equal(details("code-review@m", cache), null);
    cacheWith({});
    assert.deepEqual([load(cache).ok, load(cache).entries], [true, {}]);
  });
});

describe("details", () => {
  test("full record fields", () => {
    cacheWith({ "code-review@claude-plugins-official": entry({ components: {
      commands: [{ name: "code-review", chars: {} }], agents: [], skills: [], hooks: [], mcpServers: [], lspServers: [] } }) });
    const r = det("code-review@claude-plugins-official");
    assert.equal(r.id, "code-review@claude-plugins-official");
    assert.equal(r.name, "code-review");
    assert.equal(r.marketplace, "claude-plugins-official");
    assert.equal(r.installs, 404331);
    assert.deepEqual(r.components.commands, ["code-review"]);
    assert.deepEqual(r.counts, { commands: 1 });
    assert.equal(r.total, 1);
    assert.equal(r.category, "productivity");
    assert.equal(r.last_updated, "2026-02-20T01:06:49Z");
    assert.equal(r.source_sha, "aecd4c85");
    assert.equal(r.sha, null);
    assert.equal(r.version, null);
    assert.equal(r.tokens["claude-opus-4-7"].on_invoke, 2489);
  });

  test("unknown id is null", () => {
    cacheWith({ "a@m": entry() });
    assert.equal(details("b@m", cache), null);
    assert.equal(details("", cache), null);
  });

  test("counts drop zero kinds and total matches", () => {
    cacheWith({ "a@m": entry({ components: { commands: [{ name: "c1" }, { name: "c2" }], skills: [{ name: "s1" }], agents: [], hooks: [], mcpServers: [], lspServers: [] } }) });
    const r = det("a@m");
    assert.deepEqual(r.counts, { commands: 2, skills: 1 });
    assert.ok("agents" in r.components);
    assert.equal(r.total, 3);
  });

  test("id split", () => {
    cacheWith({ bare: entry({ plugin: "bare" }), "we@ird@market": entry({ plugin: null }) });
    assert.deepEqual([det("bare").name, det("bare").marketplace], ["bare", ""]);
    assert.deepEqual([det("we@ird@market").name, det("we@ird@market").marketplace], ["we@ird", "market"]);
  });

  test("installs, version and sha keep null distinct from empty", () => {
    const me = { ...entry().marketplace_entry, version: "2.1.0" };
    cacheWith({
      "a@m": entry({ unique_installs: null, version: "1.0.0" }), "b@m": entry({ unique_installs: "많음", version: null, marketplace_entry: me }),
      "c@m": entry({ unique_installs: 0, version: null, sha: 7, source_sha: "" }), "d@m": entry({ unique_installs: true }),
    });
    const d = load(cache).entries as O;
    assert.deepEqual([d["a@m"].installs, d["b@m"].installs, d["c@m"].installs, d["d@m"].installs], [null, null, 0, null]);
    assert.deepEqual([d["a@m"].version, d["b@m"].version, d["c@m"].version], ["1.0.0", "2.1.0", null]);
    assert.deepEqual([d["c@m"].sha, d["c@m"].source_sha], [null, null]);
  });

  test("marketplace_entry missing or wrong type", () => {
    cacheWith({ "a@m": entry({ marketplace_entry: null }), "b@m": entry({ marketplace_entry: "nope" }) });
    for (const pid of ["a@m", "b@m"]) {
      const r = det(pid);
      assert.deepEqual([r.description, r.author, r.homepage, r.category], ["", "", "", ""]);
    }
  });
});

test("author is a dict name, a string, or empty", () => {
  for (const [value, want] of [[{ name: "Anthropic" }, "Anthropic"], ["Anthropic", "Anthropic"], [null, ""], [{}, ""], [{ email: "x@y.z" }, ""], [{ name: 7 }, ""], [42, ""]] as [unknown, string][]) {
    cacheWith({ "a@m": entry({ marketplace_entry: { ...entry().marketplace_entry, author: value } }) });
    assert.equal(det("a@m").author, want, JSON.stringify(value));
  }
});

describe("meta", () => {
  test("timestamps come from their own levels; models are filtered", () => {
    cacheWith({ "a@m": entry() });
    const got = load(cache);
    assert.deepEqual([got.fetched_at, got.generated_at, got.installs_at, got.path],
      ["2026-08-06T04:31:43.504Z", "2026-08-06T04:00:00Z", "2026-08-05T00:00:00Z", cache]);
    assert.deepEqual(got.models, ["claude-opus-4-7", "claude-sonnet-4-6"]);
    cacheWith({}, { models: ["ok", 7, null, { name: "x" }] });
    assert.deepEqual(load(cache).models, ["ok"]);
    cacheWith({}, { models: "nope" });
    assert.deepEqual(load(cache).models, []);
  });

  test("utf-8 BOM is tolerated", () => {
    cacheWith({ "a@m": entry() });
    fs.writeFileSync(cache, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(cache)]));
    assert.ok(load(cache).ok);
  });

  test("default cache points at the claude plugins dir", () => {
    assert.ok(defaultCache().endsWith("plugin-catalog-cache.json"));
    assert.ok(defaultCache().includes("plugins"));
  });
});

describe("summary", () => {
  beforeEach(() => cacheWith({
    "a@m": entry({ components: { commands: [{ name: "c1" }], skills: ["s1", "s2"], agents: [], hooks: [] } }),
    "b@m": entry({ unique_installs: null, components: { hooks: ["PreToolUse"] } }),
  }));

  test("counts and installs; no name arrays; not aliased to details", () => {
    const s = summary(cache) as O;
    assert.deepEqual(Object.keys(s).sort(), ["a@m", "b@m"]);
    assert.deepEqual(s["a@m"], { installs: 404331, components: { commands: 1, skills: 2 }, total: 3 });
    assert.deepEqual(s["b@m"], { installs: null, components: { hooks: 1 }, total: 1 });
    assert.equal(hasList(s), false);
    s["a@m"].components.commands = 999;
    assert.equal(det("a@m").counts.commands, 1);
  });
});

describe("cli", () => {
  const PID = "code-review@claude-plugins-official";
  beforeEach(() => cacheWith({ [PID]: entry({ components: {
    commands: [{ name: "code-review", chars: {} }], agents: [], skills: [], hooks: [], mcpServers: [], lspServers: [] } }) }));

  async function call(...argv: string[]) {
    const doc = await main(argv) as O;
    assert.equal(exitCode(doc as never), doc.ok ? 0 : 1);
    return doc;
  }

  test("summary keys are pinned; --cache works before the subcommand", async () => {
    const r = await call("summary", "--cache", cache);
    assert.deepEqual(Object.keys(r).sort(), ["code", "entries", "fetched_at", "generated_at", "installs_at", "message", "models", "ok"]);
    assert.deepEqual(r.entries, { [PID]: { installs: 404331, components: { commands: 1 }, total: 1 } });
    assert.equal(r.message, "Plugins: 1");
    assert.deepEqual(Object.keys((await call("--cache", cache, "summary")).entries), [PID]);
  });

  test("summary failure still carries an empty entries map", async () => {
    const r = await call("summary", "--cache", path.join(tmp, "gone.json"));
    assert.deepEqual([r.ok, r.code, r.entries], [false, "cache_unavailable", {}]);
    assert.ok(r.message.includes("gone.json"));
  });

  test("details record is flattened to the top level", async () => {
    const r = await call("details", PID, "--cache", cache);
    assert.deepEqual(Object.keys(r).sort(), ["author", "category", "code", "components", "counts", "description", "homepage", "id",
      "installs", "last_updated", "marketplace", "message", "name", "ok", "sha", "source_sha", "tokens", "total", "version"]);
    assert.deepEqual([r.ok, r.id, r.author, r.total], [true, PID, "Anthropic", 1]);
  });

  test("unknown id and missing cache report failure with the requested id", async () => {
    const r = await call("details", "nope@other-market", "--cache", cache);
    assert.deepEqual(Object.keys(r).sort(), ["code", "id", "message", "ok", "target"]);
    assert.deepEqual([r.code, r.id, r.target], ["not_found", "nope@other-market", "nope@other-market"]);
    const g = await call("details", PID, "--cache", path.join(tmp, "gone.json"));
    assert.deepEqual([g.code, g.id], ["cache_unavailable", PID]);
  });

  test("argparse errors are invalid_arg", async () => {
    const r = await call("bogus");
    assert.equal(r.code, "invalid_arg");
    assert.equal(r.message, "plugin_catalog: argument op: invalid choice: 'bogus' (choose from summary, details)");
  });
});
