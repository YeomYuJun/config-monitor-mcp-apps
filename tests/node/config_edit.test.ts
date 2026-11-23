// tests/test_smoke.py 의 ConfigEdit·ConfigEditExtended, tests/test_item_edit.py, tests/test_tracking.py 의
// TestSaveAtomicEol, tests/test_plugin_state.py 의 ToggleOp 를 옮긴 것 + Python 판과 같은 바이트를 쓰는지 확인.
// cas 스냅샷이 필요한 테스트(편집 귀속, 구간 락)와 claude_config 를 읽는 테스트(LAZY/EAGER 배지)는
// 그 모듈이 들어온 뒤 옮긴다. 여기서는 모든 편집을 --no-snapshot 으로 부른다.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ce from "../../src/core/config_edit.ts";
import { decodeBytes, encodeBytes, pyOracle, readTree, writeTree } from "./py_oracle.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY_EDIT = path.join(REPO, "src", "config_edit.py");

let tmp = "";
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config_edit_test_")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const writeJson = (p: string, v: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v));
};

describe("saveAtomic EOL", () => {
  const file = () => path.join(tmp, "settings.json");

  test("lf file stays lf", () => {
    fs.writeFileSync(file(), '{\n  "a": 1\n}');
    ce.saveAtomic(file(), { a: 1, b: 2 });
    const data = fs.readFileSync(file());
    assert.ok(!data.includes("\r\n"));
    assert.ok(data.includes("\n"));
  });

  test("crlf file stays crlf", () => {
    fs.writeFileSync(file(), '{\r\n  "a": 1\r\n}');
    ce.saveAtomic(file(), { a: 1, b: 2 });
    const s = fs.readFileSync(file(), "latin1");
    assert.equal(s.split("\n").length, s.split("\r\n").length);
    assert.ok(s.includes("\r\n"));
  });

  test("new file is lf, no BOM, no trailing newline", () => {
    ce.saveAtomic(file(), { a: 1, "한글": "값" });
    const b = fs.readFileSync(file());
    assert.equal(b.toString("utf8"), '{\n  "a": 1,\n  "한글": "값"\n}');
    assert.notEqual(b[0], 0xef);
  });

  test("existing BOM is dropped and tmp is not left behind", () => {
    fs.writeFileSync(file(), "\uFEFF{}");
    ce.saveAtomic(file(), { a: 1 });
    assert.notEqual(fs.readFileSync(file())[0], 0xef);
    assert.ok(!fs.existsSync(file() + ".tmp"));
  });
});

describe("settings edits", () => {
  let settings = "";
  beforeEach(() => {
    // 실제 형태(<root>/.claude/settings.json)로 픽스처를 잡는다. config_edit 이 이 형태만 받는다.
    settings = path.join(tmp, ".claude", "settings.json");
    writeJson(settings, { permissions: { allow: ["Bash(ls)"] } });
  });
  const edit = (...args: string[]) => ce.main(["--settings", settings, "--no-snapshot", ...args]);
  const load = () => readJson(settings);
  const commands = (event: string) =>
    load().hooks[event].flatMap((ent: { hooks?: { command: string }[] }) => (ent.hooks ?? []).map((hk) => hk.command));

  test("perm add remove", async () => {
    assert.equal((await edit("perm-add", "allow", "Bash(git*)")).ok, true);
    assert.ok(load().permissions.allow.includes("Bash(git*)"));
    const r = await edit("perm-remove", "allow", "Bash(git*)");
    assert.equal(r.code, "ok");
    assert.ok(!load().permissions.allow.includes("Bash(git*)"));
  });

  test("hook remove quoted command", async () => {
    // 회귀: needle 을 직렬화된 JSON 에 부분 문자열로 맞추면 명령 안의 " 가 \" 로 이스케이프돼
    // 절대 매칭되지 않는다. 경로를 따옴표로 감싼 훅(실제로 가장 흔한 형태)이 제거 불가였다.
    const cmd = 'node "C:/tools/hooks/lint.js"';
    await edit("hook-add", "PostToolUse", cmd, "--matcher", "Edit");
    const r = await edit("hook-remove", "PostToolUse", cmd);
    assert.equal(r.changed, true);
    assert.ok(!("hooks" in load()));  // 마지막 훅이 빠지면 빈 껍데기도 남기지 않는다
  });

  test("hook remove is exact not substring", async () => {
    await edit("hook-add", "PostToolUse", "node hook.js");
    await edit("hook-add", "PostToolUse", "node hook.js --verbose");
    await edit("hook-remove", "PostToolUse", "node hook.js");
    assert.deepEqual(commands("PostToolUse"), ["node hook.js --verbose"]);
  });

  test("hook remove keeps sibling in same entry", async () => {
    writeJson(settings, { hooks: { PostToolUse: [{ matcher: "Edit", hooks: [
      { type: "command", command: "a.py" }, { type: "command", command: "b.py" }] }] } });
    await edit("hook-remove", "PostToolUse", "a.py");
    assert.deepEqual(commands("PostToolUse"), ["b.py"]);
  });

  test("edit accepts BOM settings", async () => {
    fs.writeFileSync(settings, "\uFEFF" + JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    assert.equal((await edit("perm-add", "allow", "Bash(git*)")).ok, true);
    assert.ok(load().permissions.allow.includes("Bash(git*)"));
  });

  test("null sections do not crash edit", async () => {
    writeJson(settings, { permissions: null, hooks: null });
    assert.equal((await edit("perm-add", "allow", "Bash(git*)")).code, "ok");
    assert.ok(load().permissions.allow.includes("Bash(git*)"));
    const r = await edit("hook-remove", "PostToolUse", "x");
    assert.deepEqual([r.ok, r.code], [true, "noop"]);
  });

  test("hook add remove leaves no empty shell", async () => {
    await edit("hook-add", "PostToolUse", "echo hi", "--matcher", "Edit");
    assert.ok(JSON.stringify(load().hooks.PostToolUse).includes("echo hi"));
    const r = await edit("hook-remove", "PostToolUse", "echo hi");
    assert.equal(r.changed, true);
    assert.ok(!("hooks" in load()));
  });

  test("hook remove matches windows path command", async () => {
    const cmd = 'node "D:\\my-tools\\Hooks\\recursive-eval\\index.js"';
    await edit("hook-add", "PostToolUse", cmd, "--matcher", "Edit");
    const r = await edit("hook-remove", "PostToolUse", cmd);
    assert.deepEqual([r.ok, r.changed], [true, true]);
    assert.ok(!("hooks" in load()));
  });

  test("hook remove keeps siblings in the same matcher", async () => {
    writeJson(settings, { hooks: { PreToolUse: [{ matcher: "*", hooks: [
      { type: "command", command: "keep-me" }, { type: "command", command: "drop-me" }] }] } });
    await edit("hook-remove", "PreToolUse", "drop-me");
    assert.deepEqual(commands("PreToolUse"), ["keep-me"]);
  });

  test("hook remove reports no-op when nothing matches", async () => {
    await edit("hook-add", "PostToolUse", "echo hi");
    const r = await edit("hook-remove", "PostToolUse", "no-such-command");
    assert.deepEqual([r.ok, r.changed], [true, false]);
  });

  test("settings outside .claude dir is rejected before anything is written", async () => {
    const bad = path.join(tmp, "not-a-claude-dir", "deep", "arbitrary.json");
    const r = await ce.main(["--settings", bad, "--no-snapshot", "perm-add", "allow", "Bash(rm -rf /)"]);
    assert.deepEqual([r.ok, r.code, r.target], [false, "invalid_arg", bad]);
    assert.ok(!fs.existsSync(path.dirname(bad)));
  });

  test("settings.local.json in .claude dir is accepted", async () => {
    const local = path.join(tmp, ".claude", "settings.local.json");
    const r = await ce.main(["--settings", local, "--no-snapshot", "perm-add", "allow", "Bash(git*)"]);
    assert.equal(r.ok, true);
    assert.ok(readJson(local).permissions.allow.includes("Bash(git*)"));
  });

  test("ok result carries settings and backup, noop does not write", async () => {
    const r = await edit("perm-add", "allow", "Read");
    assert.equal(r.settings, settings);
    assert.match(String(r.backup), /settings\.json\.\d{14}\.bak$/);
    const before = fs.readFileSync(settings);
    const n = await edit("perm-add", "allow", "Read");
    assert.deepEqual([n.code, n.message], ["noop", "Already exists: allow 'Read' (no-op)"]);
    assert.ok(fs.readFileSync(settings).equals(before));
  });

  test("parser errors are invalid_arg", async () => {
    const r = await edit("perm-add", "maybe", "Read");
    assert.deepEqual([r.ok, r.code], [false, "invalid_arg"]);
  });
});

describe("mcp / skills / agents", () => {
  let claudeJson = "", desktop = "", skills = "", agents = "";
  beforeEach(() => {
    claudeJson = path.join(tmp, "claude.json");
    desktop = path.join(tmp, "desktop_config.json");
    skills = path.join(tmp, ".claude", "skills");
    agents = path.join(tmp, ".claude", "agents");
    writeJson(claudeJson, { mcpServers: {}, other: "keep" });
    writeJson(desktop, { mcpServers: { pre: { command: "x" } } });
  });
  const edit = (...args: string[]) => ce.main(["--claude-json", claudeJson, "--desktop-config", desktop,
    "--skills-dir", skills, "--agents-dir", agents, "--no-snapshot", ...args]);

  test("mcp add remove user scope", async () => {
    const r = await edit("mcp-add", "weather", "--json", '{"command":"npx","args":["-y","weather-mcp"]}');
    assert.deepEqual([r.ok, r.file], [true, claudeJson]);
    const d = readJson(claudeJson);
    assert.equal(d.mcpServers.weather.command, "npx");
    assert.equal(d.other, "keep");
    await edit("mcp-remove", "weather");
    assert.ok(!("weather" in readJson(claudeJson).mcpServers));
  });

  test("mcp desktop scope and invalid json", async () => {
    assert.equal((await edit("mcp-add", "s2", "--scope", "desktop", "--json", '{"command":"uv"}')).ok, true);
    const d = readJson(desktop);
    assert.ok("s2" in d.mcpServers && "pre" in d.mcpServers);
    const bad = await edit("mcp-add", "bad", "--json", "not-json");
    assert.deepEqual([bad.ok, bad.code, bad.target], [false, "invalid_arg", "--json"]);
    const arr = await edit("mcp-add", "bad", "--json", "[1]");
    assert.equal(arr.message, '--json must be a server config object (e.g. {"command":"npx","args":[...]})');
    const ghost = await edit("mcp-remove", "ghost");
    assert.deepEqual([ghost.ok, ghost.changed], [true, false]);
  });

  test("mcp server names are own keys, not prototype lookups", async () => {
    const r = await edit("mcp-remove", "toString");
    assert.equal(r.code, "noop");
    await edit("mcp-add", "__proto__", "--json", '{"command":"x"}');
    assert.deepEqual(Object.keys(readJson(claudeJson).mcpServers), ["__proto__"]);
  });

  test("skill scaffold remove roundtrip", async () => {
    const r = await edit("skill-scaffold", "myskill", "--desc", "테스트");
    assert.equal(r.ok, true);
    const md = path.join(skills, "myskill", "SKILL.md");
    assert.equal(fs.readFileSync(md, "utf8"), "---\nname: myskill\ndescription: 테스트\n---\n\n# myskill\n\n작성 중.\n");
    const rm = await edit("skill-remove", "myskill");
    assert.ok(!fs.existsSync(path.join(skills, "myskill")));
    assert.ok(fs.existsSync(String(rm.trashed)));  // 복구 가능(.trash 이동)
    assert.match(String(rm.trashed), /\\\.trash\\myskill\.\d{14}$|\/\.trash\/myskill\.\d{14}$/);
  });

  test("agent scaffold remove roundtrip", async () => {
    await edit("agent-scaffold", "reviewer", "--desc", "코드리뷰", "--tools", "Read,Grep");
    const md = path.join(agents, "reviewer.md");
    assert.ok(fs.readFileSync(md, "utf8").includes("tools: Read,Grep"));
    assert.equal((await edit("agent-remove", "reviewer")).ok, true);
    assert.ok(!fs.existsSync(md));
  });

  test("path traversal rejected", async () => {
    const r = await edit("skill-remove", "../evil");
    assert.deepEqual([r.ok, r.code], [false, "invalid_arg"]);
  });

  test("global synced dir is not removable", async () => {
    const synced = path.join(skills, "synced");
    fs.mkdirSync(synced, { recursive: true });
    const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    try {
      const r = await ce.main(["--skills-dir", skills, "--no-snapshot", "skill-remove", "synced"]);
      assert.equal(r.code, "invalid_arg");
      assert.equal(r.target, path.join(skills, "synced"));
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    assert.ok(fs.statSync(synced).isDirectory());
  });

  test("synced is an ordinary name in a project skills dir, also with a trailing separator", async () => {
    const proj = path.join(tmp, "proj", ".claude", "skills");
    const r = await ce.main(["--skills-dir", proj + path.sep, "--no-snapshot", "skill-scaffold", "synced"]);
    assert.equal(r.ok, true);
  });

  test("bad skills dir rejected before trash", async () => {
    const victim = path.join(tmp, "notclaude", "skills", "myskill");
    fs.mkdirSync(victim, { recursive: true });
    const r = await ce.main(["--skills-dir", path.dirname(victim), "--no-snapshot", "skill-remove", "myskill"]);
    assert.equal(r.ok, false);
    assert.ok(fs.statSync(victim).isDirectory());
  });

  // '---' 로 시작하는 --content 값은 CLI 파서가 옵션으로 읽으므로 cmd* 로 직접 넘긴다.
  const dirs = () => ({ claudeJson, desktopConfig: desktop, skillsDir: skills, agentsDir: agents, noSnapshot: true });

  test("agent full content install", async () => {
    const content = "---\nname: sec\ndescription: 보안 리뷰어\n" +
      'tools: ["Read", "Bash"]\nmodel: sonnet\n---\n\n# 본문\n\n워크플로우 상세.\n';
    assert.equal((await ce.cmdAgentScaffold({ ...dirs(), name: "sec", content })).ok, true);
    assert.equal(fs.readFileSync(path.join(agents, "sec.md"), "utf8"), content);
    const dup = await ce.cmdAgentScaffold({ ...dirs(), name: "sec", content });
    assert.deepEqual([dup.ok, dup.code], [false, "exists"]);
  });

  test("skill full content install", async () => {
    const content = "---\nname: myskill\ndescription: d\n---\n\n# 단계\n1. one\n";
    const r = await ce.cmdSkillScaffold({ ...dirs(), name: "myskill", content });
    assert.equal(r.message, `Skill installed: ${path.join(skills, "myskill", "SKILL.md")}`);
    assert.equal(fs.readFileSync(path.join(skills, "myskill", "SKILL.md"), "utf8"), content);
  });

  test("agent directory form is trashed too", async () => {
    fs.mkdirSync(path.join(agents, "dirform"), { recursive: true });
    const r = await edit("agent-remove", "dirform");
    assert.equal(r.ok, true);
    const miss = await edit("agent-remove", "dirform");
    assert.deepEqual([miss.code, miss.target, miss.message], ["not_found", "dirform", `Agent not found: dirform (${agents})`]);
  });
});

describe("single-file items", () => {
  let cdir = "", settings = "";
  beforeEach(() => {
    cdir = path.join(tmp, ".claude");
    settings = path.join(cdir, "settings.json");
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(settings, "{}");
  });
  const items = (sub: string) => path.join(cdir, sub);
  const scaffold = (kind: string, sub: string, name: string, ...extra: string[]) =>
    ce.main(["--settings", settings, "--items-dir", items(sub), "--no-snapshot", "item-scaffold", kind, name, ...extra]);

  test("rule stub carries paths only when given", async () => {
    await scaffold("rule", "rules", "eager-one");
    await scaffold("rule", "rules", "lazy-one", "--paths", "tests/**");
    assert.equal(fs.readFileSync(path.join(items("rules"), "eager-one.md"), "utf8"),
      "---\nname: eager-one\ndescription: TODO\n---\n\n# eager-one\n\n작성 중.\n");
    assert.equal(fs.readFileSync(path.join(items("rules"), "lazy-one.md"), "utf8"),
      "---\nname: lazy-one\ndescription: TODO\npaths:\n  - tests/**\n---\n\n# lazy-one\n\n작성 중.\n");
  });

  test("workflow stub carries a meta block", async () => {
    assert.equal((await scaffold("workflow", "workflows", "ship")).ok, true);
    const body = fs.readFileSync(path.join(items("workflows"), "ship.js"), "utf8");
    assert.ok(body.includes("export const meta"));
    assert.ok(body.includes("name: 'ship'"));
  });

  test("duplicate scaffold is refused", async () => {
    assert.equal((await scaffold("rule", "rules", "dup")).ok, true);
    const r = await scaffold("rule", "rules", "dup");
    assert.deepEqual([r.ok, r.code], [false, "exists"]);
  });

  test("remove moves to trash not delete", async () => {
    await scaffold("output-style", "output-styles", "terse");
    const r = await ce.main(["--settings", settings, "--items-dir", items("output-styles"), "--no-snapshot", "item-remove", "output-style", "terse"]);
    assert.equal(r.ok, true);
    assert.ok(!fs.existsSync(path.join(items("output-styles"), "terse.md")));
    assert.ok(fs.existsSync(String(r.trashed)));
  });

  test("remove missing item reports failure", async () => {
    const r = await ce.main(["--settings", settings, "--items-dir", items("rules"), "--no-snapshot", "item-remove", "rule", "nope"]);
    assert.deepEqual([r.ok, r.code], [false, "not_found"]);
  });

  test("items dir outside .claude is refused", async () => {
    const r = await ce.main(["--settings", settings, "--items-dir", tmp, "--no-snapshot", "item-scaffold", "rule", "x"]);
    assert.equal(r.ok, false);
  });

  test("items dir with wrong subdir is refused", async () => {
    const r = await ce.main(["--settings", settings, "--items-dir", items("skills"), "--no-snapshot", "item-scaffold", "rule", "x"]);
    assert.equal(r.ok, false);
  });

  test("name cannot escape the directory", async () => {
    for (const bad of ["../evil", "a/b", "..", "a\\b", ""]) {
      assert.equal((await scaffold("rule", "rules", bad)).ok, false, bad);
    }
  });

  test("memory remove requires a projects/<x>/memory dir", async () => {
    const none = await ce.main(["--settings", settings, "--no-snapshot", "memory-remove", "x"]);
    assert.deepEqual([none.code, none.target], ["invalid_arg", "--memory-dir"]);
    const r = await ce.main(["--settings", settings, "--memory-dir", cdir, "--no-snapshot", "memory-remove", "x"]);
    assert.equal(r.ok, false);
  });

  test("memory file moves to trash", async () => {
    const mdir = path.join(tmp, "projects", "d--proj", "memory");
    fs.mkdirSync(mdir, { recursive: true });
    fs.writeFileSync(path.join(mdir, "stale.md"), "---\ndescription: 낡음\n---\n");
    const r = await ce.main(["--settings", settings, "--memory-dir", mdir, "--no-snapshot", "memory-remove", "stale"]);
    assert.equal(r.ok, true, r.message);
    assert.ok(!fs.existsSync(path.join(mdir, "stale.md")));
    assert.ok(fs.existsSync(String(r.trashed)));
  });

  test("output style set then clear, other keys preserved", async () => {
    writeJson(settings, { model: "opus", permissions: { allow: ["Bash"] } });
    const set = await ce.main(["--settings", settings, "--no-snapshot", "outputstyle-set", "terse"]);
    assert.deepEqual([set.ok, set.file], [true, settings]);
    assert.equal(readJson(settings).outputStyle, "terse");
    assert.equal((await ce.main(["--settings", settings, "--no-snapshot", "outputstyle-set", "terse"])).code, "noop");
    assert.equal((await ce.main(["--settings", settings, "--no-snapshot", "outputstyle-set", ""])).ok, true);
    const d = readJson(settings);
    assert.ok(!("outputStyle" in d));
    assert.equal(d.model, "opus");
    assert.deepEqual(d.permissions.allow, ["Bash"]);
    assert.equal((await ce.main(["--settings", settings, "--no-snapshot", "outputstyle-set", ""])).message, "Output style cleared (no-op)");
  });
});

describe("plugin toggle", () => {
  let g = "", p = "";
  beforeEach(() => {
    g = path.join(tmp, ".claude", "settings.json");
    p = path.join(tmp, "proj", ".claude", "settings.json");
    writeJson(g, { permissions: { allow: ["Read(**)"] }, enabledPlugins: { "notion@official": true } });
    writeJson(p, { enabledPlugins: { "notion@official": true } });
  });

  test("op is idempotent", () => {
    const s = { enabledPlugins: { "a@m": false } };
    assert.equal(ce.opPluginToggle(s, "a@m", false)[2], false);
    assert.equal(ce.opPluginToggle(s, "a@m", true)[2], true);
  });

  test("op does not normalize case", () => {
    const [s] = ce.opPluginToggle({}, "Notion@official", true);
    assert.deepEqual(Object.keys(s.enabledPlugins as object), ["Notion@official"]);
  });

  test("cli touches only target file and only that key", async () => {
    const r = await ce.main(["--settings", p, "--no-snapshot", "plugin-toggle", "notion@official", "off"]);
    assert.equal(r.ok, true);
    assert.equal(readJson(p).enabledPlugins["notion@official"], false);
    const gd = readJson(g);
    assert.equal(gd.enabledPlugins["notion@official"], true);
    assert.deepEqual(gd.permissions.allow, ["Read(**)"]);
  });

  test("cli backs up before writing", async () => {
    await ce.main(["--settings", g, "--no-snapshot", "plugin-toggle", "notion@official", "off"]);
    assert.ok(fs.readdirSync(path.dirname(g)).some((f) => f.endsWith(".bak")));
  });

  test("empty id is a no-op", async () => {
    const r = await ce.main(["--settings", g, "--no-snapshot", "plugin-toggle", "", "on"]);
    assert.deepEqual([r.code, r.message], ["noop", "Plugin id is empty (no-op)"]);
  });
});

describe("cmd* entry points", () => {
  test("cmdPermAdd returns the same document as main", async () => {
    const settings = path.join(tmp, ".claude", "settings.json");
    const r = await ce.cmdPermAdd({ settings, noSnapshot: true, kind: "deny", rule: "Bash(rm:*)" });
    assert.deepEqual([r.ok, r.code, r.message], [true, "ok", "Added: permissions.deny += 'Bash(rm:*)'"]);
    assert.equal(r.backup, null);  // 새 파일이라 백업이 없다
    assert.deepEqual(readJson(settings), { permissions: { deny: ["Bash(rm:*)"] } });
  });
});

// ----- Python 판과의 디스크 형식 -----

const pyEnv = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
const oracle = pyOracle("config_edit");
const FILE_FLAGS = new Set(["--settings", "--claude-json"]);
const DIR_FLAGS = new Set(["--skills-dir", "--agents-dir", "--items-dir"]);

/** python config_edit.py 의 결과 문서(기록). 인자의 대상 파일·폴더가 Python 실행 뒤 갖던 내용을 함께 기록하고 되살린다. */
function pyEdit(...args: string[]): { ok: boolean; [k: string]: unknown } {
  const targets = args.flatMap((a, i) => (FILE_FLAGS.has(a) || DIR_FLAGS.has(a) ? [[a, args[i + 1]] as const] : []));
  const rec = oracle(`edit ${args.join(" ")}`, { "<TMP>": tmp }, () => {
    const r = spawnSync("python", [PY_EDIT, "--no-snapshot", ...args], { encoding: "utf8", env: pyEnv });
    const out: Record<string, unknown> = {};
    for (const [flag, p] of targets) {
      if (FILE_FLAGS.has(flag)) out[p] = fs.existsSync(p) ? encodeBytes(fs.readFileSync(p)) : null;
      else out[p] = readTree(p);
    }
    return { doc: JSON.parse(r.stdout) as { ok: boolean; [k: string]: unknown }, files: out };
  });
  if (process.env.CM_PY_RECORD !== "1") {
    for (const [flag, p] of targets) {
      const v = rec.files[p];
      if (FILE_FLAGS.has(flag) && typeof v === "string") {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, decodeBytes(v));
      } else if (DIR_FLAGS.has(flag) && v) writeTree(p, v as Record<string, string>);
    }
  }
  return rec.doc;
}

/** config_edit.save_atomic 으로 file 을 쓴 결과(기록). */
function pySave(file: string, src: string): void {
  const bytes = oracle(`save_atomic ${file} ${fs.readFileSync(src, "utf8")} ${fs.existsSync(file) ? encodeBytes(fs.readFileSync(file)) : "-"}`, { "<TMP>": tmp }, () => {
    const code = "import json,sys; sys.path.insert(0, sys.argv[1]); import config_edit; " +
      "config_edit.save_atomic(sys.argv[2], json.load(open(sys.argv[3], encoding='utf-8-sig')))";
    const r = spawnSync("python", ["-c", code, path.join(REPO, "src"), file, src], { encoding: "utf8", env: pyEnv });
    assert.equal(r.status, 0, r.stderr);
    return encodeBytes(fs.readFileSync(file));
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, decodeBytes(bytes));
}

describe("disk format matches the python version", () => {
  const SAMPLE = {
    permissions: { allow: ["Bash(ls:*)", "Read(./**)"], deny: [] },
    hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: 'node "D:\\a b\\x.js" --q "1"' }] }] },
    env: { "한글": "값 \u00e9 \u2028 \t tab", emoji: "\u{1F600}", ctl: "\u0001\u001f", slash: "a/b" },
    nested: { empty_obj: {}, empty_arr: [], n: -12, f: 0.5, t: true, z: null, big: 1730000000000 },
  };

  for (const [label, existing] of [["new file", null], ["lf file", '{\n  "x": 1\n}'], ["crlf file", '{\r\n  "x": 1\r\n}'], ["bom file", "\uFEFF{}"]] as const) {
    test(`saveAtomic bytes equal python save_atomic: ${label}`, () => {
      const src = path.join(tmp, "src.json");
      fs.writeFileSync(src, JSON.stringify(SAMPLE));
      const a = path.join(tmp, "py", "settings.json");
      const b = path.join(tmp, "ts", "settings.json");
      if (existing !== null) {
        for (const f of [a, b]) {
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, existing);
        }
      }
      pySave(a, src);
      ce.saveAtomic(b, readJson(src));
      assert.ok(fs.readFileSync(b).equals(fs.readFileSync(a)), `${fs.readFileSync(b, "latin1")}\n---\n${fs.readFileSync(a, "latin1")}`);
    });
  }

  test("python and ts edits interleave on one file and match a python-only run", async () => {
    const mk = (root: string) => {
      const s = path.join(root, ".claude", "settings.json");
      fs.mkdirSync(path.dirname(s), { recursive: true });
      fs.writeFileSync(s, '{\r\n  "permissions": {\r\n    "allow": [\r\n      "Read"\r\n    ]\r\n  },\r\n  "model": "opus"\r\n}');
      return s;
    };
    const only = mk(path.join(tmp, "only"));
    const mixed = mk(path.join(tmp, "mixed"));
    const steps: string[][] = [
      ["perm-add", "allow", "Bash(git:*)"],
      ["hook-add", "PostToolUse", 'node "C:\\x y\\h.js"', "--matcher", "Edit"],
      ["plugin-toggle", "demo@m", "off"],
      ["outputstyle-set", "터스"],
      ["hook-add", "PostToolUse", "echo 두번째"],
      ["hook-remove", "PostToolUse", 'node "C:\\x y\\h.js"'],
      ["perm-remove", "allow", "Read"],
    ];
    for (const [i, step] of steps.entries()) {
      const want = pyEdit("--settings", only, ...step);
      // 짝수 단계는 TS 가 Python 이 쓴 파일을, 홀수 단계는 Python 이 TS 가 쓴 파일을 읽어 고친다.
      const got = i % 2 === 0
        ? await ce.main(["--settings", mixed, "--no-snapshot", ...step])
        : pyEdit("--settings", mixed, ...step);
      assert.equal(got.code, want.code, step.join(" "));
      assert.ok(fs.readFileSync(mixed).equals(fs.readFileSync(only)), `after ${step.join(" ")}`);
    }
  });

  test("mcp-add / mcp-remove rewrite ~/.claude.json like python: big ints, small floats, 1.0", async () => {
    const text = '{\r\n  "numStartups": 9007199254740993,\r\n  "id": 123456789012345678901234567890,\r\n' +
      '  "cost": 1e-07,\r\n  "rate": 1.234e-05,\r\n  "one": 1.0,\r\n  "big": 1.2345678901234568e+20,\r\n' +
      '  "neg": -0.0,\r\n  "projects": {"D:\\\\a": {"lastCost": 0.1, "n": [1, 2.5e300]}},\r\n  "mcpServers": {"old": {"command": "x"}}\r\n}';
    const py = path.join(tmp, "py", ".claude.json");
    const ts = path.join(tmp, "ts", ".claude.json");
    for (const f of [py, ts]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
    const steps = [["mcp-add", "demo", "--json", '{"command":"npx","timeout":1.5e-3,"n":12345678901234567890}'], ["mcp-remove", "old"]];
    for (const step of steps) {
      const want = pyEdit("--claude-json", py, ...step);
      const got = await ce.main(["--claude-json", ts, "--no-snapshot", ...step]);
      assert.equal(got.code, want.code);
      assert.ok(fs.readFileSync(ts).equals(fs.readFileSync(py)), `${fs.readFileSync(ts, "utf8")}\n---\n${fs.readFileSync(py, "utf8")}`);
    }
  });

  test("mcp-add parse error wording matches python", async () => {
    const want = pyEdit("--claude-json", path.join(tmp, "a.json"), "mcp-add", "x", "--json", "{\"a\": }");
    const got = await ce.main(["--claude-json", path.join(tmp, "b.json"), "--no-snapshot", "mcp-add", "x", "--json", "{\"a\": }"]);
    assert.equal(got.code, want.code);
    const detail = String(want.message).split(": ").slice(1).join(": ");
    assert.equal(got.message, `Failed to parse --json: ${detail}`);
  });

  test("scaffolded files match python byte for byte", async () => {
    const mk = (root: string) => {
      const c = path.join(root, ".claude");
      fs.mkdirSync(c, { recursive: true });
      return c;
    };
    const pyc = mk(path.join(tmp, "py"));
    const tsc = mk(path.join(tmp, "ts"));
    const steps = (c: string): string[][] => [
      ["--skills-dir", path.join(c, "skills"), "skill-scaffold", "s1", "--desc", "설명 \"q\""],
      ["--agents-dir", path.join(c, "agents"), "agent-scaffold", "a1", "--desc", "D", "--tools", "Read, Grep", "--model", "sonnet"],
      ["--items-dir", path.join(c, "rules"), "item-scaffold", "rule", "r1", "--desc", "R", "--paths", "src/**"],
      ["--items-dir", path.join(c, "workflows"), "item-scaffold", "workflow", "w1", "--desc", "W"],
      ["--items-dir", path.join(c, "output-styles"), "item-scaffold", "output-style", "o1"],
    ];
    const pySteps = steps(pyc), tsSteps = steps(tsc);
    for (let i = 0; i < pySteps.length; i++) {
      pyEdit("--settings", path.join(pyc, "settings.json"), ...pySteps[i]);
      await ce.main(["--settings", path.join(tsc, "settings.json"), "--no-snapshot", ...tsSteps[i]]);
    }
    const content = "---\r\nname: s2\r\n---\r\n본문";
    pyEdit("--settings", path.join(pyc, "settings.json"), "--skills-dir", path.join(pyc, "skills"), "skill-scaffold", "s2", "--content", content);
    await ce.cmdSkillScaffold({ settings: path.join(tsc, "settings.json"), skillsDir: path.join(tsc, "skills"), noSnapshot: true, name: "s2", content });
    const files = ["skills/s1/SKILL.md", "agents/a1.md", "rules/r1.md", "workflows/w1.js", "output-styles/o1.md", "skills/s2/SKILL.md"];
    for (const f of files) {
      assert.ok(fs.readFileSync(path.join(tsc, f)).equals(fs.readFileSync(path.join(pyc, f))), f);
    }
  });
});
