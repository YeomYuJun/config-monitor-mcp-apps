// tests/test_plugin_state.py 를 옮긴 것. config_edit(ToggleOp), plugin_cli(ClaudeCliDelegation),
// library(market-discover 사유 문장)를 부르는 케이스는 그 모듈의 테스트가 맡는다.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importCandidates, normUrl, readEnabled, readMarkets, readPlugins, scanItems, splitId } from "../../src/core/plugin_state.ts";
import { hasMcp, loadMcpJson } from "../../src/core/plugin_units.ts";
import { pluginSectionCards } from "../../src/core/claude_config.ts";

function write(p: string, text: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const wjson = (p: string, obj: unknown) => write(p, JSON.stringify(obj, null, 2));

class Fx {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin_state_test_"));
  pdir = path.join(this.tmp, "plugins");
  cache = path.join(this.pdir, "cache");
  settings = path.join(this.tmp, "settings.json");

  plugin(market: string, name: string, meta: Record<string, unknown> = {}, files: Record<string, string> = {}, version = "1.0.0") {
    const root = path.join(this.cache, market, name, version);
    wjson(path.join(root, ".claude-plugin", "plugin.json"), { name, version, description: `${name} desc`, ...meta });
    for (const [rel, body] of Object.entries(files)) write(path.join(root, ...rel.split("/")), body);
    return root;
  }

  installed(mapping: Record<string, string>, scope = "user", projectPath?: string) {
    const entry: Record<string, unknown> = { scope, version: "1.0.0" };
    if (projectPath) entry.projectPath = projectPath;
    wjson(path.join(this.pdir, "installed_plugins.json"), {
      version: 2,
      plugins: Object.fromEntries(Object.entries(mapping).map(([pid, root]) => [pid, [{ ...entry, installPath: root }]])),
    });
  }

  enabled(mapping: Record<string, boolean>, p?: string) {
    wjson(p ?? this.settings, { enabledPlugins: mapping });
  }

  read(settings?: string[]) {
    return Object.fromEntries(readPlugins(this.pdir, settings ?? [this.settings]).map((r) => [r.id, r]));
  }

  dispose() {
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

let fx: Fx;
beforeEach(() => { fx = new Fx(); });
afterEach(() => fx.dispose());

describe("id versus namespace", () => {
  test("ns comes from plugin.json and id is untouched", () => {
    const root = fx.plugin("official", "notion", { name: "Notion" });
    fx.installed({ "notion@official": root });
    fx.enabled({ "notion@official": true });
    const r = fx.read()["notion@official"];
    assert.deepEqual([r.id, r.ns, r.name], ["notion@official", "Notion", "notion"]);
  });

  test("ns falls back to the id name when plugin.json is missing", () => {
    const root = path.join(fx.cache, "m", "solo", "1.0.0");
    fs.mkdirSync(root, { recursive: true });
    fx.installed({ "solo@m": root });
    fx.enabled({ "solo@m": true });
    assert.equal(fx.read()["solo@m"].ns, "solo");
  });

  test("splitId uses the last @", () => {
    assert.deepEqual(splitId("a@b"), ["a", "b"]);
    assert.deepEqual(splitId("we@ird@market"), ["we@ird", "market"]);
    assert.deepEqual(splitId("bare"), ["bare", ""]);
  });
});

describe("four states", () => {
  test("ok and disabled", () => {
    fx.installed({ "on@m": fx.plugin("m", "on"), "off@m": fx.plugin("m", "off") });
    fx.enabled({ "on@m": true, "off@m": false });
    const got = fx.read();
    assert.equal(got["on@m"].state, "ok");
    assert.equal(got["off@m"].state, "disabled");
  });

  test("missing when the install path is gone", () => {
    const root = fx.plugin("m", "ghost");
    fx.installed({ "ghost@m": root });
    fx.enabled({ "ghost@m": true });
    fs.rmSync(root, { recursive: true });
    const r = fx.read()["ghost@m"];
    assert.equal(r.state, "missing");
    assert.deepEqual(r.items.skills, []);
  });

  test("stale key without an install record is surfaced", () => {
    fx.installed({});
    fx.enabled({ "vibe-kit@inline": false });
    const r = fx.read()["vibe-kit@inline"];
    assert.equal(r.state, "stale");
    assert.equal(r.root, "");
    assert.equal(r.project_path, "");
  });

  test("absent enabled key defaults to enabled", () => {
    fx.installed({ "implicit@m": fx.plugin("m", "implicit") });
    fx.enabled({});
    const r = fx.read()["implicit@m"];
    assert.equal(r.state, "ok");
    assert.equal(r.enabled_explicit, false);
    assert.equal(r.enabled_from, null);
  });
});

describe("component scan", () => {
  test("dot directories are not scanned", () => {
    const root = fx.plugin("m", "sp", {}, {
      "skills/alpha/SKILL.md": "---\nname: alpha\n---\n",
      ".agents/ghost.md": "---\nname: ghost\n---\n",
      "agents/.hidden.md": "---\nname: hidden\n---\n",
      "commands/ns/deep.md": "---\ndescription: d\n---\n",
    });
    const items = scanItems(root) as Record<string, { name: string }[]>;
    assert.deepEqual(items.skills.map((s) => s.name), ["alpha"]);
    assert.deepEqual(items.agents, []);
    assert.deepEqual(items.commands.map((c) => c.name), ["ns/deep"]);
  });

  test("skill without SKILL.md is not counted", () => {
    assert.deepEqual(scanItems(fx.plugin("m", "s", {}, { "skills/empty/README.md": "x" })).skills, []);
  });

  test("hooks are read through plugin_units", () => {
    const root = fx.plugin("m", "h", {}, { "hooks/hooks.json": JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: 'node "a b.js"' }] }] },
    }) });
    const hooks = scanItems(root).hooks as { event: string; commands: string[] }[];
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].event, "PostToolUse");
    assert.deepEqual(hooks[0].commands, ['node "a b.js"']);
  });
});

describe("inline mcp declaration", () => {
  test("inline mcpServers are found", () => {
    const root = fx.plugin("m", "cdp", { mcpServers: { "chrome-devtools": { command: "npx", args: ["chrome-devtools-mcp"] } } });
    assert.ok(hasMcp(root));
    assert.deepEqual((scanItems(root).mcp as { name: string }[]).map((m) => m.name), ["chrome-devtools"]);
  });

  test(".mcp.json wins over inline", () => {
    const root = fx.plugin("m", "both", { mcpServers: { inline: { command: "a" } } },
      { ".mcp.json": JSON.stringify({ mcpServers: { fromfile: { command: "b" } } }) });
    assert.deepEqual((scanItems(root).mcp as { name: string }[]).map((m) => m.name), ["fromfile"]);
  });

  test("no declaration at all", () => {
    const root = fx.plugin("m", "none");
    assert.equal(hasMcp(root), false);
    assert.equal(loadMcpJson(root), null);
  });
});

test("later settings file wins and records its path", () => {
  fx.installed({ "p@m": fx.plugin("m", "p") });
  const proj = path.join(fx.tmp, "proj", "settings.json");
  fx.enabled({ "p@m": true });
  fx.enabled({ "p@m": false }, proj);
  const r = fx.read([fx.settings, proj])["p@m"];
  assert.equal(r.enabled, false);
  assert.equal(r.enabled_from, proj);
  assert.equal(r.state, "disabled");
});

describe("market discovery", () => {
  const markets = (m: unknown) => wjson(path.join(fx.pdir, "known_marketplaces.json"), m);

  test("github source is expanded to a url", () => {
    markets({ ua: { source: { source: "github", repo: "o/r" } } });
    assert.equal(readMarkets(fx.pdir).ua.url, "https://github.com/o/r.git");
  });

  test("candidate matching ignores .git suffix and case", () => {
    markets({ ua: { source: { source: "github", repo: "O/R" } } });
    assert.deepEqual(importCandidates(fx.pdir, ["https://github.com/o/r"]), []);
    assert.equal(importCandidates(fx.pdir, []).length, 1);
  });

  test("source without url is not a candidate", () => {
    markets({ local: { source: { source: "path", path: "/x" } } });
    assert.deepEqual(importCandidates(fx.pdir, []), []);
  });

  test("normUrl strips, drops trailing slashes and folds case", () => {
    assert.equal(normUrl("  HTTPS://X/Y.git/ "), "https://x/y");
    assert.equal(normUrl("https://x/Straße"), "https://x/strasse");
  });
});

describe("card scope tagging", () => {
  const cards = (files: string[]) =>
    Object.fromEntries(pluginSectionCards(readPlugins(fx.pdir, files), fx.settings, [fx.settings]).map((c) => [c.name, c]));
  let proj = "";
  beforeEach(() => {
    fx.installed({ "p@m": fx.plugin("m", "p") });
    proj = path.join(fx.tmp, "myproj", ".claude", "settings.json");
  });

  test("global card has no scope", () => {
    fx.enabled({ "p@m": true });
    const c = cards([fx.settings]).p;
    assert.equal(c.scope, undefined);
    assert.equal(c.edit!.settings, fx.settings);
  });

  test("project card is tagged with its root", () => {
    fx.enabled({ "p@m": true });
    fx.enabled({ "p@m": false }, proj);
    const c = cards([fx.settings, proj]).p;
    assert.equal(c.scope, "project");
    assert.equal(c.project, path.join(fx.tmp, "myproj"));
    assert.equal(c.edit!.settings, proj);
  });

  test("implicit enable is not tagged project", () => {
    fx.enabled({});
    assert.equal(cards([fx.settings]).p.scope, undefined);
  });
});

describe("install scope round trip", () => {
  const card = () => pluginSectionCards(readPlugins(fx.pdir, [fx.settings]), fx.settings, [fx.settings])[0];

  test("project scope and path reach the card", () => {
    fx.installed({ "code-review@official": fx.plugin("official", "code-review") }, "project", "D:\\");
    fx.enabled({ "code-review@official": true });
    const c = card();
    assert.equal(c.edit!.scope, "project");
    assert.equal(c.edit!.cwd, "D:\\");
    assert.ok((Object.fromEntries(c.kv).installed ?? "").includes("project"));
  });

  test("user scope needs no cwd", () => {
    fx.installed({ "code-review@official": fx.plugin("official", "code-review") });
    fx.enabled({ "code-review@official": true });
    const c = card();
    assert.equal(c.edit!.scope, "user");
    assert.equal(c.edit!.cwd, "");
    assert.ok(!("installed" in Object.fromEntries(c.kv)));
  });
});

test("enabledPlugins are read from a BOM settings file", () => {
  const s = path.join(fx.tmp, "bom", "settings.json");
  fs.mkdirSync(path.dirname(s), { recursive: true });
  fs.writeFileSync(s, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ enabledPlugins: { "a@m": false } }))]));
  assert.deepEqual(readEnabled([s]), { "a@m": { on: false, from: s } });
});
