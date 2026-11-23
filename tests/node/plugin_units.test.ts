// tests/test_remote_library.py 의 plugin_units 전용 클래스(Substitution, HooksMerge, InterpreterCheck,
// HooksMergeIdempotency, NoneInputsAreNoops)를 옮긴 것 + Python os.path 와 맞춘 도우미.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkInterpreter, entryRefsRoot, findUnits, firstToken, hookCommands, hookRefsRoot, hooksMerge, hooksRemove,
  interpreterWarnings, loadHooksJson, pyBasename, pyDirname, pyJoin, pyNormpath, substitute,
} from "../../src/core/plugin_units.ts";

const WIN = process.platform === "win32";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function fixture(hooks: unknown) {
  const ctx = { tmp: "", root: "" };
  beforeEach(() => {
    ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subst_test_"));
    ctx.root = path.join(ctx.tmp, "plugins", "sg", "abc123");
    fs.mkdirSync(path.join(ctx.root, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(ctx.root, "hooks-handlers"), { recursive: true });
    fs.writeFileSync(path.join(ctx.root, "hooks", "hooks.json"), JSON.stringify(hooks));
  });
  afterEach(() => fs.rmSync(ctx.tmp, { recursive: true, force: true }));
  return ctx;
}

const HOOKS = {
  description: "test hooks",
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh"' }] }],
    PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/post.py"', timeout: 10 }] }],
  },
};

type S = Record<string, any>;

describe("substitution", () => {
  const ctx = fixture(HOOKS);

  test("nested structures are replaced and the input is not mutated", () => {
    const got = substitute(HOOKS, ctx.root) as S;
    assert.ok(got.hooks.SessionStart[0].hooks[0].command.includes(ctx.root));
    assert.ok(!JSON.stringify(got).includes("${CLAUDE_PLUGIN_ROOT}"));
    assert.ok(HOOKS.hooks.SessionStart[0].hooks[0].command.includes("${CLAUDE_PLUGIN_ROOT}"));
    assert.equal(got.hooks.PostToolUse[0].matcher, "Edit|Write");
    assert.equal(got.hooks.PostToolUse[0].hooks[0].timeout, 10);
  });

  test("every occurrence is replaced and '$&' in the root is literal", () => {
    assert.equal(substitute("${CLAUDE_PLUGIN_ROOT}/a ${CLAUDE_PLUGIN_ROOT}/b", "R$&"), "R$&/a R$&/b");
  });

  test("sibling directory reference survives", () => {
    const cmd = (substitute(HOOKS, ctx.root) as S).hooks.SessionStart[0].hooks[0].command as string;
    assert.ok(fs.statSync(path.dirname(cmd.split('"')[1])).isDirectory());
  });

  test("hook commands come from parsed json", () => {
    assert.equal(hookCommands(loadHooksJson(ctx.root)).length, 2);
  });

  test("loadHooksJson returns null when absent", () => {
    assert.equal(loadHooksJson(path.join(ctx.tmp, "nope")), null);
  });
});

describe("hooks merge", () => {
  const ctx = fixture(HOOKS);

  test("windows path matching is not string based", () => {
    const root = WIN ? "D:\\cache\\plugins\\sg\\abc123" : "/c/plugins/sg/abc123";
    const entry = { matcher: "*", hooks: [{ type: "command", command: 'bash "' + root + '/hooks/run.sh"' }] };
    assert.ok(entryRefsRoot(entry, root));
  });

  test("a different plugin does not match; case and separators are ignored", () => {
    const entry = { hooks: [{ type: "command", command: 'bash "' + ctx.root + '/hooks/x.sh"' }] };
    assert.ok(!entryRefsRoot(entry, path.join(ctx.tmp, "plugins", "other", "def456")));
    const fwd = { hooks: [{ type: "command", command: 'bash "' + ctx.root.replace(/\\/g, "/") + '/hooks/x.sh"' }] };
    assert.ok(entryRefsRoot(fwd, ctx.root));
  });

  test("merge twice does not duplicate", () => {
    const cfg = loadHooksJson(ctx.root);
    let [s, , added1] = hooksMerge({}, cfg, ctx.root, null);
    const [s2, removed2] = hooksMerge(s, cfg, ctx.root, ctx.root);
    s = s2;
    assert.equal(added1, 2);
    assert.equal(removed2, 2);
    assert.equal((s as S).hooks.SessionStart.length, 1);
    assert.equal((s as S).hooks.PostToolUse.length, 1);
  });

  test("sha change removes old root entries", () => {
    const cfg = loadHooksJson(ctx.root);
    const [s] = hooksMerge({}, cfg, ctx.root, null);
    const newRoot = path.join(ctx.tmp, "plugins", "sg", "def456");
    const [s2, removed] = hooksMerge(s, cfg, newRoot, ctx.root);
    assert.equal(removed, 2);
    const cmd = (s2 as S).hooks.SessionStart[0].hooks[0].command as string;
    assert.ok(cmd.includes(newRoot) && !cmd.includes(ctx.root));
  });

  test("unrelated user hooks are preserved", () => {
    const mine = { matcher: "*", hooks: [{ type: "command", command: "echo mine" }] };
    const [s, removed] = hooksMerge({ hooks: { SessionStart: [mine] } }, loadHooksJson(ctx.root), ctx.root, null);
    assert.equal(removed, 0);
    assert.deepEqual((s as S).hooks.SessionStart[0], mine);
    assert.equal((s as S).hooks.SessionStart.length, 2);
  });

  test("remove leaves no empty event key and is idempotent", () => {
    const [s] = hooksMerge({}, loadHooksJson(ctx.root), ctx.root, null);
    const [s2, removed] = hooksRemove(s, ctx.root);
    assert.equal(removed, 2);
    assert.ok(!("SessionStart" in ((s2 as S).hooks ?? {})));
    assert.equal(hooksRemove(s2, ctx.root)[1], 0);
  });

  test("remove keeps other tools' hooks in a shared entry", () => {
    const mine = { type: "command", command: 'node "' + ctx.root + '/index.js"' };
    const theirs = { type: "command", command: 'node "D:/elsewhere/comment-linter/index.js"' };
    const [s, removed] = hooksRemove({ hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [theirs, mine] }] } }, ctx.root);
    assert.equal(removed, 1);
    assert.deepEqual((s as S).hooks.PostToolUse, [{ matcher: "Edit|Write", hooks: [theirs] }]);
  });

  test("merge into a shared entry replaces only its own hook", () => {
    const theirs = { type: "command", command: 'node "D:/elsewhere/comment-linter/index.js"' };
    const old = { type: "command", command: 'python3 "' + ctx.root + '/hooks/post.py"', timeout: 10 };
    const [s, removed, added] = hooksMerge({ hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [theirs, old] }] } },
      loadHooksJson(ctx.root), ctx.root, ctx.root);
    assert.deepEqual([removed, added], [1, 2]);
    const post = (s as S).hooks.PostToolUse;
    assert.deepEqual(post[0], { matcher: "Edit|Write", hooks: [theirs] });
    assert.equal(post.length, 2);
    assert.ok(post[1].hooks[0].command.includes(ctx.root));
  });
});

describe("hook ref boundary (test_plugin_state.TestHookRefsRootBoundary)", () => {
  test("sibling prefix root does not match", { skip: !WIN }, () => {
    const h = { command: "node D:\\store\\m\\plugins\\foo-bar\\h.js" };
    assert.ok(!hookRefsRoot(h, "D:\\store\\m\\plugins\\foo"));
    assert.ok(hookRefsRoot(h, "D:\\store\\m\\plugins\\foo-bar"));
  });

  test("quote, space and end boundaries still match", { skip: !WIN }, () => {
    assert.ok(hookRefsRoot({ command: 'node "D:\\x\\foo" --flag' }, "D:\\x\\foo"));
    assert.ok(hookRefsRoot({ command: "cd D:\\x\\foo" }, "D:\\x\\foo"));
  });
});

describe("interpreter check", () => {
  test("first token handles quotes and paths", () => {
    assert.equal(firstToken('bash "${X}/a.sh"'), "bash");
    assert.equal(firstToken('python3 "${X}/p.py" --flag'), "python3");
    assert.equal(firstToken('"C:/Program Files/x/y.exe" a'), "C:/Program Files/x/y.exe");
    assert.equal(firstToken(""), "");
  });

  test("missing, stub and real interpreters", () => {
    assert.deepEqual(checkInterpreter("nosuchinterp x", () => null), { interp: "nosuchinterp", ok: false, reason: "missing" });
    const stub = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe";
    const r = checkInterpreter('python3 "${X}/p.py"', () => stub);
    assert.deepEqual([r.ok, r.reason, r.interp], [false, "stub", "python3"]);
    const ok = checkInterpreter("bash x.sh", () => "/usr/bin/bash");
    assert.deepEqual([ok.ok, ok.reason], [true, ""]);
  });

  test("warnings collect only problems", () => {
    const cfg = { hooks: { S: [{ hooks: [{ type: "command", command: "bash a.sh" }, { type: "command", command: "python3 b.py" }] }] } };
    const w = interpreterWarnings(cfg, (n) => (n === "python3" ? "C:\\WindowsApps\\python3.exe" : "/usr/bin/" + n));
    assert.deepEqual(w.map((x) => x.interp), ["python3"]);
    assert.equal(w[0].reason, "stub");
  });
});

describe("hooks merge idempotency", () => {
  const ctx = fixture({
    description: "mixed hooks",
    hooks: {
      SessionStart: [],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo pre" }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/p.sh"' }] }],
    },
  });

  const mergeN = (s: S, n: number) => {
    const cfg = loadHooksJson(ctx.root);
    for (let i = 0; i < n; i++) s = hooksMerge(s, cfg, ctx.root, ctx.root)[0];
    return s;
  };

  test("install three times yields one entry per event", () => {
    const s = mergeN({}, 3);
    for (const ev of ["PreToolUse", "Stop", "PostToolUse"]) assert.equal(s.hooks[ev].length, 1, ev);
  });

  test("empty event list does not create a key", () => {
    const [s] = hooksMerge({}, loadHooksJson(ctx.root), ctx.root, null);
    assert.ok(!("SessionStart" in (s as S).hooks));
  });

  test("user's own different hook survives repeated merge", () => {
    const mine = { hooks: [{ type: "command", command: "echo mine" }] };
    const s = mergeN({ hooks: { Stop: [clone(mine)] } }, 3);
    assert.deepEqual(s.hooks.Stop[0], mine);
    assert.equal(s.hooks.Stop.length, 2);
  });

  test("remove after repeated merge clears the root entry once", () => {
    const [s, removed] = hooksRemove(mergeN({}, 3), ctx.root);
    assert.equal(removed, 1);
    assert.ok(!("PostToolUse" in (s as S).hooks));
  });

  test("sha change still deduplicates non-root entries", () => {
    const cfg = loadHooksJson(ctx.root);
    const [s] = hooksMerge({}, cfg, ctx.root, null);
    const newRoot = path.join(ctx.tmp, "plugins", "sg", "def456");
    const [s2] = hooksMerge(s, cfg, newRoot, ctx.root);
    const h = (s2 as S).hooks;
    assert.equal(h.PostToolUse.length, 1);
    assert.ok(h.PostToolUse[0].hooks[0].command.includes(newRoot));
    assert.equal(h.PreToolUse.length, 1);
    assert.equal(h.Stop.length, 1);
  });
});

describe("null inputs are no-ops", () => {
  test("merge, commands, refs and warnings accept null", () => {
    const s = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } };
    const before = clone(s);
    const [s2, removed, added] = hooksMerge(s, null, "/x", null);
    assert.deepEqual([removed, added], [0, 0]);
    assert.deepEqual(s2, before);
    assert.deepEqual(hookCommands(null), []);
    assert.equal(entryRefsRoot(null, "/x"), false);
    assert.deepEqual(interpreterWarnings(null), []);
  });
});

describe("find units", () => {
  const ctx = { tmp: "" };
  beforeEach(() => { ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "units_test_")); });
  afterEach(() => fs.rmSync(ctx.tmp, { recursive: true, force: true }));

  test("depth 2, dot names and node_modules skipped, no descent into a unit", () => {
    const mk = (rel: string, body = "{}") => {
      const p = path.join(ctx.tmp, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    };
    mk("Hooks/b/hooks/hooks.json");
    mk("Hooks/a/.mcp.json");
    mk("Hooks/a/inner/hooks/hooks.json");
    mk(".hidden/hooks/hooks.json");
    mk("node_modules/x/hooks/hooks.json");
    mk("deep/l2/l3/hooks/hooks.json");
    mk("inline/.claude-plugin/plugin.json", JSON.stringify({ mcpServers: { s: { command: "x" } } }));
    const got = findUnits(ctx.tmp).map((p) => path.relative(ctx.tmp, p).replace(/\\/g, "/"));
    assert.deepEqual(got, ["Hooks/a", "Hooks/b", "inline"]);
  });
});

describe("os.path helpers", { skip: !WIN }, () => {
  test("join keeps the given separators like ntpath.join", () => {
    assert.equal(pyJoin("D:/x/acme", ".claude"), "D:/x/acme\\.claude");
    assert.equal(pyJoin("D:\\x\\", "a"), "D:\\x\\a");
    assert.equal(pyJoin("D:\\x", "C:\\y"), "C:\\y");
    assert.equal(pyJoin("D:\\x", "\\y"), "D:\\y");
  });

  test("normpath strips the trailing separator; basename of a trailing separator is empty", () => {
    assert.equal(pyNormpath("D:/a/./b/../c/"), "D:\\a\\c");
    assert.equal(pyNormpath("D:\\"), "D:\\");
    assert.equal(pyBasename("a\\b\\"), "");
    assert.equal(pyDirname("D:\\a\\b\\"), "D:\\a\\b");
    assert.equal(pyDirname("D:\\a"), "D:\\");
  });
});

describe("junction folders", { skip: !WIN }, () => {
  // 정션은 같은 임시 폴더 안의 픽스처만 가리키게 하고, 정리할 때 링크만 지운다(rmdirSync).
  const ctx = { tmp: "", links: [] as string[] };
  const junction = (target: string, at: string) => {
    fs.symlinkSync(target, at, "junction");
    ctx.links.push(at);
  };
  beforeEach(() => {
    ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "junction_test_"));
    ctx.links = [];
  });
  afterEach(() => {
    for (const l of ctx.links.reverse()) fs.rmdirSync(l);
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  });

  test("a junction to a unit folder is a unit, like python find_units", () => {
    const lib = path.join(ctx.tmp, "lib");
    for (const d of [path.join(lib, "real"), path.join(ctx.tmp, "target")]) {
      fs.mkdirSync(path.join(d, "hooks"), { recursive: true });
      fs.writeFileSync(path.join(d, "hooks", "hooks.json"), "{}");
    }
    junction(path.join(ctx.tmp, "target"), path.join(lib, "j"));
    assert.deepEqual(findUnits(lib).map((p) => path.basename(p)), ["j", "real"]);
  });

  test("a junction loop does not recurse forever", () => {
    const lib = path.join(ctx.tmp, "lib");
    fs.mkdirSync(path.join(lib, "a"), { recursive: true });
    junction(lib, path.join(lib, "a", "loop"));
    assert.deepEqual(findUnits(lib, 50), []);
  });
});
