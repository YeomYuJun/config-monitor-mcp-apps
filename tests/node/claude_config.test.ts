// tests/test_sections.py 와 tests/test_smoke.py 의 ClaudeConfigDump 를 옮긴 것.
// discover() 를 인자 없이 부르는 케이스는 사용자의 실제 프로필 대신 임시 홈을 읽게 env 를 바꾼다.
// test_item_edit.py 의 스캐폴드·output style 설정 케이스는 config_edit 를 부르므로 그 모듈의 테스트가 맡는다.
import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activeOutputStyle, card, claudeMdCards, compactState, count, discover, encodeProjectDir, fileCard, filterState, globCards,
  GROUPS, isAddCard, listProjects, main, mdDirCards, memoryCards, outputStyleCards, parse, readFrontmatter, rulesCards,
  section, SECTIONS, skillCards, summarize, type Card, type ConfigState, type Found,
} from "../../src/core/claude_config.ts";

type O = Record<string, any>;
const WIN = process.platform === "win32";
const ENV_KEYS = ["USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR"];

let tmp = "";
let saved: Record<string, string | undefined> = {};

/** 임시 홈·APPDATA·임시 폴더를 tmp 아래로 옮긴다(호출 시점에 env 를 읽으므로 같은 프로세스에서 된다). */
function isolate() {
  const home = path.join(tmp, "home");
  const systemp = path.join(tmp, "systemp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(systemp, { recursive: true });
  Object.assign(process.env, {
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TEMP: systemp, TMP: systemp, TMPDIR: systemp,
  });
  return home;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude_config_test_"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  isolate();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(p: string, text: string | Buffer = "") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const sec = (state: ConfigState | O, id: string) => (state.sections as O[]).find((s) => s.id === id)!;
const byName = (cards: Card[]) => Object.fromEntries(cards.map((c) => [c.name, c]));

describe("registry", () => {
  test("ids unique and groups known", () => {
    const groups = new Set(GROUPS.map(([g]) => g));
    for (const [sid, s] of Object.entries(SECTIONS)) {
      assert.equal(sid, s.id);
      assert.ok(groups.has(s.group), sid);
      assert.ok([null, "eager", "lazy", "never"].includes(s.load), sid);
    }
  });

  test("every section carries id and group; titles unchanged; keybindings is not a section", () => {
    const state = parse(discover());
    for (const s of state.sections) {
      assert.ok(s.id in SECTIONS);
      assert.ok(s.group);
    }
    const titles = state.sections.map((s) => s.title.split(" · ")[0]);
    for (const t of ["Permissions", "Hooks", "Skills (code)", "Agents", "Commands", "Plugins", "Scheduled Tasks", "Desktop Skills"]) {
      assert.ok(titles.includes(t), t);
    }
    assert.ok(!("keybindings" in SECTIONS));
    assert.ok(!state.sections.some((s) => s.id === "keybindings"));
  });
});

describe("counting", () => {
  test("add cards are excluded from the count", () => {
    const real = card("real", [["desc", "x"]]);
    const adder = card("＋ 새 규칙", [], { badge: "add", edit: { kind: "item-add", itemKind: "rule" } });
    assert.equal(count([real, adder]), 1);
    assert.equal(count([adder]), 0);
    assert.ok(isAddCard(adder) && !isAddCard(real));
  });

  test("an empty surface with only an adder titles as zero", () => {
    const s = section("rules", rulesCards(tmp));
    assert.ok(s.title.endsWith("· 0"), s.title);
    assert.equal(s.cards.length, 1);
  });
});

describe("builders", () => {
  test("md dir reads frontmatter and nests; load callback decides per card", () => {
    write(path.join(tmp, "d", "a.md"), "---\ndescription: 첫째\n---\n본문\n");
    write(path.join(tmp, "d", "sub", "b.md"), "no frontmatter\n");
    write(path.join(tmp, "d", "lazy.md"), "---\npaths:\n  - src/**\n---\n");
    const cards = byName(mdDirCards(path.join(tmp, "d"), "rule", null, null, (_r, _p, meta) => ("paths" in meta ? "lazy" : "eager")));
    assert.deepEqual(Object.keys(cards).sort(), ["a", "lazy", "sub/b"]);
    assert.equal(cards.a.load, "eager");
    assert.equal(cards.lazy.load, "lazy");
    assert.deepEqual(cards.a.kv[0], ["desc", "첫째"]);
  });

  test("glob cards and file card skip missing", () => {
    write(path.join(tmp, "one.json"));
    write(path.join(tmp, "ship.js"));
    write(path.join(tmp, "notes.txt"));
    write(path.join(tmp, ".hidden.js"));
    assert.equal(globCards(tmp, "*.json", "theme").length, 1);
    assert.deepEqual(globCards(tmp, "*.js", "workflow").map((c) => c.name), ["ship"]);
    assert.deepEqual(fileCard(path.join(tmp, "nope.json"), "kb"), []);
    assert.equal(fileCard(path.join(tmp, "one.json"), "kb").length, 1);
  });

  test("synced is hidden only in the global skills dir", () => {
    for (const n of ["synced", "mine"]) write(path.join(tmp, "s", n, "SKILL.md"));
    const names = (scope: string | null) => skillCards(path.join(tmp, "s"), scope).filter((c) => !isAddCard(c)).map((c) => c.name).sort();
    assert.deepEqual(names(null), ["mine"]);
    assert.deepEqual(names("project"), ["mine", "synced"]);
  });

  test("builders tolerate missing directories", () => {
    assert.deepEqual(mdDirCards(path.join("nope", "gone"), "rule"), []);
    assert.deepEqual(globCards(null, "*.js", "workflow"), []);
  });

  test("size uses thousands separators", () => {
    write(path.join(tmp, "big.md"), "x".repeat(12345));
    assert.deepEqual(fileCard(path.join(tmp, "big.md"), "kb")[0].kv[0], ["size", "12,345 B"]);
  });
});

describe("instruction surfaces", () => {
  test("rules load class splits on paths frontmatter", () => {
    write(path.join(tmp, "r", "style.md"), "---\ndescription: 전역 규칙\n---\n");
    write(path.join(tmp, "r", "testing.md"), "---\npaths:\n  - tests/**\n---\n");
    const by = byName(rulesCards(path.join(tmp, "r")));
    assert.equal(by.style.load, "eager");
    assert.equal(by.testing.load, "lazy");
  });

  test("only the selected output style is eager; none selected is all never", () => {
    for (const n of ["terse", "verbose"]) write(path.join(tmp, "o", n + ".md"), "---\ndescription: x\n---\n");
    const by = byName(outputStyleCards(path.join(tmp, "o"), "terse"));
    assert.equal(by.terse.load, "eager");
    assert.equal(by.verbose.load, "never");
    assert.equal(outputStyleCards(path.join(tmp, "o"), null)[0].load, "never");
  });

  test("active output style lets local settings win", () => {
    write(path.join(tmp, "settings.json"), '{"outputStyle": "terse"}');
    write(path.join(tmp, "settings.local.json"), '{"outputStyle": "verbose"}');
    assert.equal(activeOutputStyle([path.join(tmp, "settings.json"), path.join(tmp, "settings.local.json")]), "verbose");
    assert.equal(activeOutputStyle([]), null);
  });

  test("claude md cards cover all three locations", () => {
    for (const rel of ["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")]) write(path.join(tmp, rel), "# hi\n");
    const cards = claudeMdCards(tmp, "project", tmp);
    assert.equal(cards.length, 3);
    assert.ok(cards.every((c) => c.load === "eager"));
  });
});

describe("project output style inherits global", () => {
  function build(globalStyle: string | null, projectStyle: string | null) {
    const gdir = path.join(tmp, "g", ".claude"), pdir = path.join(tmp, "proj", ".claude");
    for (const n of ["terse", "verbose"]) write(path.join(pdir, "output-styles", n + ".md"), "---\ndescription: x\n---\n");
    write(path.join(gdir, "settings.json"), JSON.stringify(globalStyle ? { outputStyle: globalStyle } : {}));
    write(path.join(pdir, "settings.json"), JSON.stringify(projectStyle ? { outputStyle: projectStyle } : {}));
    const found = discover({ code_settings: path.join(gdir, "settings.json") });
    return byName(sec(parse(found, [pdir]), "output-styles").cards.filter((c: Card) => c.scope === "project" && c.badge !== "add"));
  }

  test("global style marks the project card eager", () => {
    const by = build("terse", null);
    assert.deepEqual([by.terse.load, by.verbose.load], ["eager", "never"]);
  });

  test("project setting overrides global", () => {
    const by = build("terse", "verbose");
    assert.deepEqual([by.verbose.load, by.terse.load], ["eager", "never"]);
  });

  test("no style anywhere leaves all never", () => {
    assert.deepEqual([...new Set(Object.values(build(null, null)).map((c) => c.load))], ["never"]);
  });
});

describe("memory surfaces", () => {
  test("project dir encoding matches observed", () => {
    assert.equal(encodeProjectDir("d:\\config-monitor"), "d--config-monitor");
    assert.equal(encodeProjectDir("C:\\Users\\YEOMYU~1\\AppData\\Local\\Temp"), "C--Users-YEOMYU-1-AppData-Local-Temp");
    assert.equal(encodeProjectDir("D:\\한글😀"), "D-----");
  });

  test("memory index is eager and topics are lazy", () => {
    write(path.join(tmp, "m", "MEMORY.md"), "- [t](t.md)\n");
    write(path.join(tmp, "m", "t.md"), "---\ndescription: 토픽\n---\n");
    const by = byName(memoryCards(path.join(tmp, "m")));
    assert.equal(by.MEMORY.load, "eager");
    assert.equal(by.MEMORY.edit, undefined);
    assert.equal(by.t.load, "lazy");
  });

  test("project memory is found through the encoded project dir", () => {
    const home = process.env.USERPROFILE!;
    const root = path.join(tmp, "work", "acme");
    write(path.join(root, ".claude", "settings.json"), "{}");
    write(path.join(home, ".claude", "projects", encodeProjectDir(root).toUpperCase(), "memory", "MEMORY.md"), "x\n");
    const cards = sec(parse({}, [path.join(root, ".claude")]), "project-memory").cards as Card[];
    assert.deepEqual(cards.map((c) => [c.name, c.scope]), [["MEMORY", "project"]]);
  });
});

describe("conversational views", () => {
  function state(): ConfigState {
    const g = card("brainstorm", [["description", "x".repeat(800)]], { badge: "skill", ok: true });
    const p = card("brainstorm", [["description", "proj"]], { badge: "skill", ok: true, scope: "project", project: "D:/proj",
      edit: { kind: "skill", skillsDir: "D:/proj/.claude/skills" } });
    const q = card("other", [["description", "unique-needle"]], { badge: "skill", ok: true });
    const add = card("＋ 새 스킬", [["형식", "name"]], { badge: "add", edit: { kind: "skill-add" } });
    const hooks = card("PreToolUse", [["command", "python x.py"]], { badge: "hook", ok: true });
    const plug = card("Notion", [["marketplace", "official"]], { badge: "disabled", ok: true });
    return { generated: "t", sources: {}, sections: [section("skills", [g, p, q, add]), section("hooks", [hooks]), section("plugins", [plug])] };
  }

  test("filter by section, scope and query", () => {
    const st = state();
    assert.deepEqual(filterState(st, ["hooks"]).sections.map((s) => s.id), ["hooks"]);
    const proj = filterState(st, null, "project").sections[0];
    assert.deepEqual(proj.cards.map((c) => c.name), ["brainstorm"]);
    assert.equal(proj.title, "Skills (code) · 1");
    assert.deepEqual(filterState(st, null, "global").sections[0].cards.map((c) => c.name), ["brainstorm", "other"]);
    assert.deepEqual(filterState(st, null, null, "NEEDLE").sections[0].cards.map((c) => c.name), ["other"]);
    assert.equal(st.sections[0].title, "Skills (code) · 3", "필터가 원본 섹션을 바꾸면 안 된다");
  });

  test("compact keeps edit and trims description", () => {
    const s = compactState(state()).sections[0];
    assert.ok(!s.cards.some((c) => c.name === "＋ 새 스킬"));
    const [g, p] = s.cards as O[];
    assert.ok(!("kv" in g));
    assert.equal([...g.desc].length, 201);
    assert.equal(p.edit.skillsDir, "D:/proj/.claude/skills");
    assert.equal(p.scope, "project");
    assert.ok(!("ok" in g));
  });

  test("summary counts names, collisions and plugin states", () => {
    const s = summarize(state()) as O;
    const skills = s.sections.find((e: O) => e.id === "skills");
    assert.deepEqual([skills.count, skills.global, skills.project], [3, 2, 1]);
    assert.deepEqual(skills.names, ["brainstorm", "brainstorm", "other"]);
    assert.deepEqual([skills.title, skills.load], ["Skills (code)", "eager"]);
    assert.deepEqual(s.collisions, [{ section: "skills", name: "brainstorm", projects: ["D:/proj"], wins: "global" }]);
    assert.deepEqual(s.plugins, { disabled: 1 });
  });

  test("dump cli accepts filters and the summary subcommand", async () => {
    const d = await main(["dump", "--sections", "hooks", "--compact"]) as O;
    assert.equal(d.ok, true);
    assert.deepEqual(d.sections.map((s: O) => s.id), ["hooks"]);
    const s = await main(["summary"]) as O;
    assert.ok("collisions" in s);
    assert.ok(s.sections.every((e: O) => "names" in e));
    assert.equal((await main(["dump", "--scope", "nope"]) as O).code, "invalid_arg");
  });
});

describe("project list", () => {
  let withc = "", noc = "";
  beforeEach(() => {
    withc = path.join(tmp, "withc");
    noc = path.join(tmp, "noc");
    fs.mkdirSync(path.join(withc, ".claude"), { recursive: true });
    fs.mkdirSync(noc, { recursive: true });
  });
  const found = (keys: string[]): Found => {
    const cj = path.join(tmp, "claude.json");
    fs.writeFileSync(cj, JSON.stringify({ projects: Object.fromEntries(keys.map((k) => [k, {}])) }));
    return { claude_json: cj };
  };
  const paths = (keys: string[], includeMissing = false) => listProjects(found(keys), includeMissing).map((p) => p.path);

  test("short name alias collapses to one row", () => {
    const alias = path.join(tmp, "WITHC~1");
    const native = fs.realpathSync.native;
    const m = mock.method(fs.realpathSync, "native", ((p: string) => native(p === alias ? withc : p)) as typeof native);
    try {
      assert.deepEqual(paths([withc, alias]), [withc]);
    } finally {
      m.mock.restore();
    }
  });

  test("missing .claude is hidden unless requested; parse shows the same rows", () => {
    assert.deepEqual(paths([withc, noc]), [withc]);
    assert.deepEqual(paths([withc, noc], true), [withc, noc]);
    const cards = sec(parse(found([withc, noc])), "claude-json").cards.filter((c: Card) => c.badge === "project");
    assert.deepEqual(cards.map((c: Card) => c.kv[0][1]), [withc]);
  });

  test("temp and desktop scratch paths are always excluded", () => {
    const inTemp = path.join(process.env.TEMP!, "x");
    const inScratch = path.join(process.env.APPDATA!, "Claude", "scratch-workspaces", "y");
    assert.deepEqual(paths([inTemp, inScratch, noc], true), [noc]);
  });

  test("has_claude flag and claude_dir", () => {
    const by = Object.fromEntries(listProjects(found([withc, noc]), true).map((p) => [p.path, p]));
    assert.equal(by[withc].has_claude, true);
    assert.equal(by[noc].has_claude, false);
    assert.equal(by[withc].claude_dir, path.join(withc, ".claude"));
  });

  test("same dir with different spelling is listed once, first spelling kept", () => {
    const variants = [withc, withc + path.sep, path.join(withc, ".")];
    if (WIN) variants.push(withc.replace(/\\/g, "/"), withc.toUpperCase());
    const rows = listProjects(found(variants));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, withc);
  });
});

describe("perm summary names", () => {
  test("perm names carry their source file", () => {
    write(path.join(tmp, "s", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    const perm = (summarize(parse({ code_settings: path.join(tmp, "s", "settings.json") })) as O).sections.find((e: O) => e.id === "perm");
    assert.deepEqual(perm.names, ["allow (settings.json)", "deny (settings.json)", "ask (settings.json)"]);
  });

  test("project perm names carry project and file", () => {
    const cdir = path.join(tmp, "proj", ".claude");
    write(path.join(cdir, "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    const perm = (summarize(parse({}, [cdir + path.sep])) as O).sections.find((e: O) => e.id === "perm");
    assert.ok(perm.names.includes("allow (proj/settings.local.json)"));
  });
});

describe("frontmatter", () => {
  test("BOM-prefixed and CRLF frontmatter are parsed; quotes are stripped", () => {
    write(path.join(tmp, "a.md"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("---\nname: demo\n---\nbody\n")]));
    assert.deepEqual({ ...readFrontmatter(path.join(tmp, "a.md")) }, { name: "demo" });
    write(path.join(tmp, "b.md"), "---\r\nname: \"q\"\r\ndescription:  'two words'  \r\n---\r\n");
    assert.deepEqual({ ...readFrontmatter(path.join(tmp, "b.md")) }, { name: "q", description: "two words" });
    assert.deepEqual({ ...readFrontmatter(path.join(tmp, "none.md")) }, {});
  });
});

describe("dump (test_smoke.ClaudeConfigDump)", () => {
  test("null values do not crash dump", async () => {
    write(path.join(tmp, "desktop.json"), JSON.stringify({ mcpServers: { dead: null, noargs: { command: "npx", args: null, env: null } } }));
    write(path.join(tmp, "settings.json"), JSON.stringify({ permissions: null, hooks: null }));
    const d = await main(["dump", "--paths", `desktop_config=${path.join(tmp, "desktop.json")}`, `code_settings=${path.join(tmp, "settings.json")}`]) as O;
    assert.equal(d.ok, true);
    assert.ok(sec(d, "mcp-desktop").cards.some((c: O) => c.name === "dead"));
  });

  test("broken settings surfaces a parse error card", async () => {
    write(path.join(tmp, "settings.json"), '{"permissions": {"allow": ["Bash(ls)"],,}}');
    const d = await main(["dump", "--paths", `code_settings=${path.join(tmp, "settings.json")}`]) as O;
    const cards = sec(d, "perm").cards as O[];
    assert.ok(cards.length && cards.some((c) => c.name.includes("오류")));
  });

  test("agents are scanned recursively; .trash is skipped; nested agents are view only", async () => {
    const ad = path.join(tmp, "agents");
    for (const [rel, nm] of [["top.md", "top-agent"], ["review/security.md", "sec-review"], [".trash/deleted.md", "trashed-agent"]]) {
      write(path.join(ad, rel), `---\nname: ${nm}\ndescription: d\n---\n`);
    }
    const by = byName(sec(await main(["dump", "--paths", `agents_dir=${ad}`]), "agents").cards);
    assert.ok("sec-review" in by && "top-agent" in by && !("trashed-agent" in by));
    assert.equal(by["sec-review"].edit, undefined);
    assert.equal(by["top-agent"].edit!.name, "top");
  });

  test("project commands and .mcp.json; env values do not leak", async () => {
    const cdir = path.join(tmp, "p", ".claude");
    for (const rel of ["deploy.md", "frontend/component.md", ".trash/old.md"]) write(path.join(cdir, "commands", rel), "---\ndescription: d\n---\n");
    write(path.join(tmp, "p", ".mcp.json"), JSON.stringify({ mcpServers: { "team-db": { command: "npx", env: { DB_TOKEN: "SECRET_VALUE" } } } }));
    const d = await main(["dump", "--projects", cdir]) as O;
    assert.ok(!JSON.stringify(d).includes("SECRET_VALUE"));
    const cmds = sec(d, "commands").cards as O[];
    const names = cmds.map((c) => c.name);
    assert.ok(names.includes("frontend/component") && names.includes("deploy") && !names.includes(".trash/old"));
    assert.ok(cmds.every((c) => c.edit === undefined));
    const mcp = sec(d, "mcp-project").cards as O[];
    assert.deepEqual(mcp.map((c) => c.name), ["team-db"]);
    assert.equal(Object.fromEntries(mcp[0].kv).env, "DB_TOKEN");
  });

  test("settings.local.json is a separate source with its own edit target", async () => {
    const base = path.join(tmp, "settings.json"), local = path.join(tmp, "settings.local.json");
    write(base, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
    write(local, JSON.stringify({ permissions: { allow: ["Bash(git:*)", "Read(*)"] } }));
    const allows = (sec(await main(["dump", "--paths", `code_settings=${base}`]), "perm").cards as O[]).filter((c) => c.name === "allow");
    const bySrc = Object.fromEntries(allows.map((c) => [c.source, c]));
    assert.deepEqual(bySrc[local].edit.items, ["Bash(git:*)", "Read(*)"]);
    assert.deepEqual(bySrc[base].edit.items, ["Bash(ls:*)"]);
    for (const [f, c] of Object.entries(bySrc)) assert.equal((c as O).edit.settings, f);
  });

  test("a non-string args item in .mcp.json fails the dump like the python TypeError", async () => {
    const cdir = path.join(tmp, "p", ".claude");
    fs.mkdirSync(cdir, { recursive: true });
    write(path.join(tmp, "p", ".mcp.json"), JSON.stringify({ mcpServers: { s: { command: "x", args: [1] } } }));
    assert.equal((await main(["dump", "--projects", cdir]) as O).code, "internal");
  });
});

describe("plugins joining sections", () => {
  test("an ok plugin's skills, hooks and mcp join their sections; a disabled one only has a plugin card", () => {
    const pdir = path.join(tmp, "plugins");
    const root = path.join(pdir, "cache", "m", "sp", "1.0.0");
    const off = path.join(pdir, "cache", "m", "off", "1.0.0");
    write(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "Sp", version: "2.0.0", description: "d" }));
    write(path.join(root, "skills", "alpha", "SKILL.md"), "---\ndescription: a skill\n---\n");
    write(path.join(root, "agents", "helper.md"), "---\nname: real-helper\n---\n");
    write(path.join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
    write(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { srv: { type: "http", url: "https://x" } } }));
    write(path.join(off, "skills", "beta", "SKILL.md"), "");
    write(path.join(pdir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
      "sp@m": [{ scope: "user", installPath: root }], "off@m": [{ scope: "user", installPath: off }] } }));
    const settings = path.join(tmp, "cfg", "settings.json");
    write(settings, JSON.stringify({ enabledPlugins: { "sp@m": true, "off@m": false } }));
    const state = parse({ plugins_dir: pdir, code_settings: settings });
    const plugins = byName(sec(state, "plugins").cards);
    assert.deepEqual([plugins.sp.badge, plugins.off.badge], ["plugin", "disabled"]);
    assert.equal(Object.fromEntries(plugins.sp.kv).namespace, "Sp:");
    assert.equal(Object.fromEntries(plugins.sp.kv).gives, "skills 1 · agents 1 · hooks 1 · mcp 1");
    assert.deepEqual(sec(state, "skills").cards.map((c: Card) => c.name), ["Sp:alpha"]);
    assert.deepEqual(sec(state, "agents").cards.map((c: Card) => c.name), ["Sp:real-helper"]);
    const hook = sec(state, "hooks").cards.find((c: Card) => c.plugin === "sp@m");
    assert.equal(Object.fromEntries(hook.kv).commands, "echo hi");
    const mcp = sec(state, "claude-json").cards.find((c: Card) => c.name === "Sp:srv");
    assert.deepEqual(mcp.kv, [["type", "http"], ["url", "https://x"], ["from", "sp@m"]]);
    assert.equal(sec(state, "skills").title, "Skills (code) · 1");
  });
});

describe("junction folders", { skip: !WIN }, () => {
  // 정션은 tmp 안의 픽스처만 가리키게 하고, 정리할 때 링크만 지운다(rmdirSync).
  const links: string[] = [];
  const junction = (target: string, at: string) => {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, "junction");
    links.push(at);
  };
  afterEach(() => {
    for (const l of links.splice(0).reverse()) fs.rmdirSync(l);
  });

  test("a junctioned skill folder is listed", () => {
    write(path.join(tmp, "store", "linked", "SKILL.md"), "---\ndescription: via junction\n---\n");
    write(path.join(tmp, "skills", "plain", "SKILL.md"), "");
    junction(path.join(tmp, "store", "linked"), path.join(tmp, "skills", "linked"));
    const by = byName(skillCards(path.join(tmp, "skills")));
    assert.ok("plain" in by && "linked" in by);
    assert.deepEqual(by.linked.kv[0], ["desc", "via junction"]);
  });

  test("a junction loop is walked once in md dirs, agents and the recursive glob", async () => {
    write(path.join(tmp, "rules", "a.md"), "---\ndescription: a\n---\n");
    junction(path.join(tmp, "rules"), path.join(tmp, "rules", "sub", "loop"));
    assert.deepEqual(mdDirCards(path.join(tmp, "rules"), "rule").map((c) => c.name), ["a"]);

    write(path.join(tmp, "agents", "x.md"), "");
    junction(path.join(tmp, "agents"), path.join(tmp, "agents", "n", "loop"));
    const agents = sec(await main(["dump", "--paths", `agents_dir=${path.join(tmp, "agents")}`]) as O, "agents").cards as O[];
    assert.deepEqual(agents.filter((c) => !isAddCard(c)).map((c) => c.name), ["x"]);

    const base = path.join(process.env.APPDATA!, "Claude", "local-agent-mode-sessions", "skills-plugin");
    write(path.join(base, "s1", "manifest.json"), JSON.stringify({ skills: [{ skillId: "k", name: "m" }] }));
    junction(base, path.join(base, "s1", "loop"));
    assert.deepEqual(discover().desktop_skill_manifest_glob, [path.join(base, "s1", "manifest.json")]);
  });
});
