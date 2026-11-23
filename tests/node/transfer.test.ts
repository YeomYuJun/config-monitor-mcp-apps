// tests/test_transfer.py 를 옮긴 것. Python 판과의 교차 확인은 transfer.xcheck.test.ts 에 있다.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Bundle, BundleError, PathMap, findPaths, inferRoots, main, makeTokens, merge, mergeServer, normCmd,
  resolveSecrets, safeMember, scrub, syncState, tokenize, detokenize, treeDigest, union,
} from "../../src/core/transfer.ts";
import * as cas from "../../src/core/cas.ts";
import * as configEdit from "../../src/core/config_edit.ts";
import { PyFloat } from "../../src/core/lib_store.ts";
import type { CliDoc } from "../../src/core/cli_result.ts";

const SECRET = "ghp_" + "Ab1".repeat(12);
const WIN = process.platform === "win32";

function write(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
}

const loadJ = (p: string) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^\ufeff/, ""));

/** ext = ~/.claude 밖의 실재 폴더(훅·MCP 가 가리킨다). */
function makeHome(root: string, ext: string): string {
  const home = path.join(root, "home");
  const ch = path.join(home, ".claude");
  write(path.join(ch, "skills", "qa", "SKILL.md"), "---\ndescription: q\n---\n");
  write(path.join(ch, "skills", "synced", "acct", "x", "SKILL.md"), "synced\n");
  write(path.join(ch, "agents", "rev.md"), "---\ndescription: r\n---\n");
  write(path.join(ch, "hooks", "guard.py"), "print(1)\n");
  write(path.join(ext, "hook.js"), "//\n");
  write(path.join(ext, "srv", "index.js"), "//\n");
  write(path.join(ch, "settings.json"), JSON.stringify({
    feedbackDrafts: { x: 1 },
    statusLine: { type: "command", command: `node "${path.join(ch, "hooks", "guard.py")}"` },
    hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${path.join(ext, "hook.js")}"` }] }] },
    env: { API_TOKEN: SECRET },
    model: "sonnet",
    permissions: { allow: ["Bash(ls)"] },
  }));
  write(path.join(home, ".claude.json"), JSON.stringify({
    oauthAccount: { emailAddress: "a@b" },
    mcpServers: { srv: { command: "node", args: [path.join(ext, "srv", "index.js")], env: { GITHUB_TOKEN: SECRET } } },
  }));
  const desk = path.join(home, "AppData", "Roaming", "Claude");
  write(path.join(desk, "claude_desktop_config.json"), JSON.stringify({ mcpServers: { dsk: { command: "node", args: [path.join(desk, "dsk.js")] } } }));
  return home;
}

function envFor(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_CONFIG_LIBRARIES;
  return {
    ...env, ...extra, HOME: home, USERPROFILE: home, CLAUDE_CAS_NO_DEFAULT_TRACK: "0",
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    CLAUDE_SNAPSHOT_STORE: path.join(home, "store"), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
  };
}

async function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T> | T): Promise<T> {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/** TS 판 transfer 를 같은 프로세스에서 python transfer.py 와 같은 argv 로 부른다. */
async function run(home: string, args: string[], extra: Record<string, string> = {}): Promise<CliDoc> {
  return withEnv(envFor(home, extra), () => main(args));
}

function treeState(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out[path.relative(root, p)] = "dir";
        walk(p);
      } else out[path.relative(root, p)] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return out;
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const itemOf = (res: CliDoc, iid: string) => (res.items as any[]).find((i) => i.id === iid);
const statesOf = (res: CliDoc) => Object.fromEntries((res.items as any[]).map((i) => [i.id, i.state]));

// ----- TestExport -----

test("export: zip bundle counts external paths and keeps secrets out", async () => {
  const tmp = tmpdir("transfer_test_");
  try {
    const ext = path.join(tmp, "tools");
    const home = makeHome(tmp, ext);
    const out = path.join(tmp, "a.cmbundle");
    const res = await run(home, ["export", "--out", out]);
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal((res.counts as any)["cc.skills"], 1);
    assert.deepEqual((res.skipped as any[]).find((s) => s.id === "cc.skills/synced"), { id: "cc.skills/synced", reason: "claude.ai account sync folder" });
    const exts = new Set((res.external as any[]).map((e) => `${e.kind}|${e.path.toLowerCase()}`));
    assert.ok(exts.has(`hook|${path.join(ext, "hook.js").toLowerCase()}`));
    assert.ok(exts.has(`mcp|${path.join(ext, "srv", "index.js").toLowerCase()}`));
    assert.ok((res.report as string[]).some((l) => l.includes("Not bundled (prepare these at the same paths on the new PC)")));
    const b = new Bundle(out);
    const blobs = Buffer.concat(["manifest.json", "report.json", "json/cc.settings.json"].map((n) => b.read(n)));
    assert.ok(!blobs.includes(SECRET));
    assert.ok(!blobs.includes("a@b"));
    const settings = b.json("json/cc.settings.json") as any;
    assert.ok(!("feedbackDrafts" in settings));
    assert.ok(b.exists("files/${CLAUDE_HOME}/hooks/guard.py"));   // ~/.claude 안 참조는 번들에 들어간다
    assert.ok(settings.statusLine.command.includes("${CLAUDE_HOME}"));
    assert.deepEqual(new Set((res.secrets as any[]).map((s) => s.path)), new Set(["env.API_TOKEN", "env.GITHUB_TOKEN"]));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("export: include-secrets puts values only in secrets.json and says so", async () => {
  const tmp = tmpdir("transfer_test_");
  try {
    const home = makeHome(tmp, path.join(tmp, "tools"));
    const out = path.join(tmp, "s.cmbundle");
    const res = await run(home, ["export", "--out", out, "--include-secrets"]);
    assert.ok((res.report as string[]).some((l) => l.includes("plain text")));
    assert.ok((res.warnings as string[]).length);
    const b = new Bundle(out);
    assert.ok(b.read("secrets.json").toString("utf8").includes(SECRET));
    assert.ok(!b.read("json/cc.settings.json").includes(SECRET));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("export: same content under another home hashes the same", async () => {
  const tmp = tmpdir("transfer_test_");
  try {
    const ext = path.join(tmp, "tools");
    const home = makeHome(tmp, ext);
    const other = makeHome(path.join(tmp, "b"), ext);
    const h = (r: CliDoc) => Object.fromEntries((r.items as any[]).map((i) => [i.id, i.hash]));
    const a = h(await run(home, ["inventory"])), b = h(await run(other, ["inventory"]));
    assert.equal(a["cc.settings"], b["cc.settings"]);
    assert.equal(a["cc.skills/qa"], b["cc.skills/qa"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("export: folder bundle and existing target", async () => {
  const tmp = tmpdir("transfer_test_");
  try {
    const home = makeHome(tmp, path.join(tmp, "tools"));
    const out = path.join(tmp, "bundle-dir");
    assert.ok((await run(home, ["export", "--out", out])).ok);
    assert.ok(fs.statSync(path.join(out, "manifest.json")).isFile());
    assert.equal((await run(home, ["export", "--out", out])).code, "exists");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ----- TestPlan / TestApply -----

interface PlanCtx { tmp: string; ext: string; a: string; bundle: string; b: string }

async function planSetup(): Promise<PlanCtx> {
  const tmp = tmpdir("transfer_plan_");
  const ext = path.join(tmp, "tools");
  const a = makeHome(path.join(tmp, "a"), ext);
  const bundle = path.join(tmp, "a-bundle");
  assert.ok((await run(a, ["export", "--out", bundle])).ok);
  const b = path.join(tmp, "b", "Users", "other");
  fs.mkdirSync(b, { recursive: true });
  return { tmp, ext, a, bundle, b };
}

test("plan: on an empty pc writes nothing", async () => {
  const c = await planSetup();
  try {
    const before = treeState(path.dirname(c.b));
    const res = await run(c.b, ["plan", "--bundle", c.bundle]);
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(treeState(path.dirname(c.b)), before);
    const st = statesOf(res);
    assert.equal(st["cc.skills/qa"], "new");
    assert.equal(st["cc.settings"], "new");
    assert.equal(st["cc.skills/synced"], "skipped");
    const srv = itemOf(res, "cc.mcp-user/srv");
    assert.deepEqual([srv.state, srv.code], ["blocked", "secret_missing"]);
    const secrets = JSON.stringify({ "cc.mcp-user/srv": { "env.GITHUB_TOKEN": "x" } });
    assert.equal(statesOf(await run(c.b, ["plan", "--bundle", c.bundle, "--secrets", secrets]))["cc.mcp-user/srv"], "new");
  } finally {
    fs.rmSync(c.tmp, { recursive: true, force: true });
  }
});

test("plan: changed skill and settings conflict", async () => {
  const c = await planSetup();
  try {
    write(path.join(c.b, ".claude", "skills", "qa", "SKILL.md"), "other\n");
    write(path.join(c.b, ".claude", "settings.json"), JSON.stringify({ model: "opus", permissions: { allow: ["Read"] } }));
    const res = await run(c.b, ["plan", "--bundle", c.bundle]);
    const qa = itemOf(res, "cc.skills/qa");
    assert.deepEqual([qa.state, qa.files.modified], ["changed", ["SKILL.md"]]);
    const st = itemOf(res, "cc.settings");
    assert.deepEqual([st.state, st.conflicts], ["changed", ["model"]]);
    assert.ok((st.diff as string[]).some((l) => l.includes("Bash(ls)")));
  } finally {
    fs.rmSync(c.tmp, { recursive: true, force: true });
  }
});

test("plan: rejects a bundle that writes outside its folder", async () => {
  const c = await planSetup();
  try {
    const mp = path.join(c.bundle, "manifest.json");
    const m = loadJ(mp);
    m.items.find((i: any) => i.id === "cc.skills/qa").rel = "${CLAUDE_HOME}/../evil";
    fs.writeFileSync(mp, JSON.stringify(m));
    assert.equal((await run(c.b, ["plan", "--bundle", c.bundle])).code, "bundle_invalid");
    m.version = 2;
    fs.writeFileSync(mp, JSON.stringify(m));
    assert.equal((await run(c.b, ["plan", "--bundle", c.bundle])).code, "bundle_version");
  } finally {
    fs.rmSync(c.tmp, { recursive: true, force: true });
  }
});

/** B 는 사용자명이 다르고 Desktop 이 MSIX 설치본이다. */
async function applySetup(): Promise<PlanCtx & { msix: string }> {
  const c = await planSetup();
  const msix = path.join(c.b, "AppData", "Local", "Packages", "Claude_x", "LocalCache", "Roaming", "Claude");
  fs.mkdirSync(msix, { recursive: true });
  write(path.join(msix, "dsk.js"), "//\n");   // 서버 스크립트가 이 PC 에도 있어야 가져온다
  return { ...c, msix };
}

async function applyBundle(home: string, bundle: string, ...extra: string[]): Promise<CliDoc> {
  const pid = (await run(home, ["plan", "--bundle", bundle, ...extra])).plan_id as string;
  return run(home, ["apply", "--bundle", bundle, "--plan-id", pid, ...extra]);
}

test("apply: on an empty pc, then plan is all same", async () => {
  const c = await applySetup();
  try {
    const sb = path.join(c.tmp, "a-secrets.cmbundle");
    assert.ok((await run(c.a, ["export", "--out", sb, "--include-secrets"])).ok);
    const res = await applyBundle(c.b, sb);
    assert.equal(res.code, "ok", JSON.stringify(res));
    assert.ok(res.post_snapshot);
    const again = await run(c.b, ["plan", "--bundle", sb]);
    const states = new Set((again.items as any[]).map((i) => i.state));
    states.delete("skipped");
    assert.deepEqual(states, new Set(["same"]));
    const settings = loadJ(path.join(c.b, ".claude", "settings.json"));
    assert.ok(!JSON.stringify(settings).includes("${"));
    assert.ok(settings.statusLine.command.toLowerCase().includes(path.join(c.b, ".claude", "hooks", "guard.py").toLowerCase()));
    assert.equal(loadJ(path.join(c.b, ".claude.json")).mcpServers.srv.env.GITHUB_TOKEN, SECRET);
    const dsk = loadJ(path.join(c.msix, "claude_desktop_config.json")).mcpServers.dsk;
    assert.ok(dsk.args[0].toLowerCase().startsWith(c.msix.toLowerCase()));
    assert.ok(!fs.existsSync(path.join(c.b, "AppData", "Roaming", "Claude")));
  } finally {
    fs.rmSync(c.tmp, { recursive: true, force: true });
  }
});

test("apply: merge, trash, and undo restore bytes", async () => {
  const c = await applySetup();
  try {
    const skill = path.join(c.b, ".claude", "skills", "qa", "SKILL.md");
    const sp = path.join(c.b, ".claude", "settings.json");
    write(skill, "other\n");
    write(sp, JSON.stringify({ model: "opus", permissions: { allow: ["Read"] } }));
    const orig = fs.readFileSync(sp), origSkill = fs.readFileSync(skill);
    const res = await applyBundle(c.b, c.bundle);
    assert.equal(res.code, "ok", JSON.stringify(res));
    const settings = loadJ(sp);
    assert.equal(settings.model, "opus");
    assert.deepEqual(settings.permissions.allow, ["Read", "Bash(ls)"]);
    assert.ok(!fs.existsSync(path.join(c.b, ".claude.json")));   // 시크릿 없는 서버는 쓰지 않는다
    assert.equal(fs.readdirSync(path.join(c.b, ".claude", "skills", ".trash")).length, 1);
    assert.equal(((await run(c.b, ["history"])).imports as any[])[0].id, res.import_id);
    const undo = await run(c.b, ["undo", "--import-id", res.import_id as string]);
    assert.equal(undo.code, "ok", JSON.stringify(undo));
    assert.deepEqual(fs.readFileSync(skill), origSkill);
    assert.deepEqual(fs.readFileSync(sp), orig);
    assert.ok(!fs.existsSync(path.join(c.b, ".claude", "agents", "rev.md")));
    assert.equal((await run(c.b, ["undo", "--import-id", res.import_id as string])).code, "noop");
  } finally {
    fs.rmSync(c.tmp, { recursive: true, force: true });
  }
});

test("apply: refuses when the target changed after plan", async () => {
  const c = await applySetup();
  try {
    const pid = (await run(c.b, ["plan", "--bundle", c.bundle])).plan_id as string;
    write(path.join(c.b, ".claude", "skills", "qa", "SKILL.md"), "late\n");
    assert.equal((await run(c.b, ["apply", "--bundle", c.bundle, "--plan-id", pid])).code, "plan_stale");
  } finally {
    fs.rmSync(c.tmp, { recursive: true, force: true });
  }
});

// 기대 바이트는 같은 입력으로 python src/transfer.py export -> plan -> apply 를 돌려 얻은 값이다.
const NUM_SRC: Record<string, string> = {
  ".claude/settings.json": '{"permissions": {"allow": ["Bash(ls)"]}, "cfg": {"ratio": 1.0, "eps": 1e-07, "id": 12345678901234567890}}',
  ".claude.json": '{"mcpServers": {"srv": {"command": "node", "args": ["x"], "timeout": 1.0, "eps": 2.5e-08, "big": 98765432109876543210}}}',
};
const NUM_DST: Record<string, string> = {
  ".claude/settings.json": '{\r\n  "model": "opus",\r\n  "stamp": 12345678901234567891,\r\n  "tiny": 1e-07,\r\n  "one": 1.0,\r\n  "permissions": {\r\n    "allow": [\r\n      "Read"\r\n    ]\r\n  }\r\n}',
  ".claude.json": '{"numStartups": 12345678901234567892, "tips": {"a": 1.0, "b": 1e+16}, "mcpServers": {}}',
};
const NUM_PY: Record<string, string> = {
  ".claude/settings.json": '{\r\n  "model": "opus",\r\n  "stamp": 12345678901234567891,\r\n  "tiny": 1e-07,\r\n  "one": 1.0,\r\n  "permissions": {\r\n    "allow": [\r\n      "Read",\r\n      "Bash(ls)"\r\n    ]\r\n  },\r\n  "cfg": {\r\n    "ratio": 1.0,\r\n    "eps": 1e-07,\r\n    "id": 12345678901234567890\r\n  }\r\n}',
  ".claude.json": '{\n  "numStartups": 12345678901234567892,\n  "tips": {\n    "a": 1.0,\n    "b": 1e+16\n  },\n  "mcpServers": {\n    "srv": {\n      "command": "node",\n      "args": [\n        "x"\n      ],\n      "timeout": 1.0,\n      "eps": 2.5e-08,\n      "big": 98765432109876543210\n    }\n  }\n}',
};

test("apply rewrites settings and .claude.json with python number notation", async () => {
  const tmp = tmpdir("transfer_num_");
  try {
    const a = path.join(tmp, "a", "home"), b = path.join(tmp, "b", "home");
    for (const [rel, t] of Object.entries(NUM_SRC)) write(path.join(a, rel), t);
    for (const [rel, t] of Object.entries(NUM_DST)) write(path.join(b, rel), t);
    const bundle = path.join(tmp, "bnd");
    const exp = await run(a, ["export", "--out", bundle]);
    assert.ok(exp.ok);
    const first = await run(b, ["plan", "--bundle", bundle]);
    assert.deepEqual([itemOf(first, "cc.settings").state, itemOf(first, "cc.mcp-user/srv").state], ["changed", "new"]);
    const res = await applyBundle(b, bundle);
    assert.equal(res.code, "ok", JSON.stringify(res));
    for (const [rel, t] of Object.entries(NUM_PY)) assert.equal(fs.readFileSync(path.join(b, rel), "utf8"), t, rel);
    const again = await run(b, ["plan", "--bundle", bundle]);
    assert.deepEqual([itemOf(again, "cc.settings").state, itemOf(again, "cc.mcp-user/srv").state], ["same", "same"]);
    const hasPyFloat = (v: unknown): boolean => v instanceof PyFloat || (!!v && typeof v === "object" && Object.values(v).some(hasPyFloat));
    for (const d of [exp, first, res, again]) assert.ok(!hasPyFloat(d));   // 결과 문서는 cli_result.pyDumps 로 나간다
    const undo = await run(b, ["undo", "--import-id", res.import_id as string]);
    assert.equal(undo.code, "ok", JSON.stringify(undo));
    assert.equal(fs.readFileSync(path.join(b, ".claude", "settings.json"), "utf8"), NUM_DST[".claude/settings.json"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** config_edit 의 편집 락이 비었는지. 기다림은 2초로 끊는다(남은 락이 뒤 테스트까지 막지 않게). */
function editLockFree(): Promise<string> {
  return Promise.race([
    configEdit.withEditLock(async () => "free"),
    new Promise<string>((r) => setTimeout(() => r("held"), 2000).unref()),
  ]);
}

test("apply and undo release the snapshot lock and the edit lock when they fail", async () => {
  const c = await applySetup();
  try {
    const store = path.join(c.b, "store");
    const lock = path.join(store, "snapshot.lock");
    const fast = { CLAUDE_CAS_LOCK_WAIT: "0.3" };
    const pid = (await run(c.b, ["plan", "--bundle", c.bundle])).plan_id as string;

    // 다른 쪽이 스냅샷 락을 쥐고 있으면 lock_timeout 으로 끝나고 편집 락은 남지 않는다
    const held = await cas.acquireSnapshotLock(cas.storePaths(store));
    try {
      const res = await run(c.b, ["apply", "--bundle", c.bundle, "--plan-id", pid], fast);
      assert.equal(res.code, "lock_timeout", JSON.stringify(res));
      assert.equal(await editLockFree(), "free");
    } finally {
      held.release();
    }

    // pre 스냅샷이 예외로 끝나는 경우(깨진 index.json)
    fs.writeFileSync(path.join(store, "index.json"), "{bad");
    let res = await run(c.b, ["apply", "--bundle", c.bundle, "--plan-id", pid], fast);
    assert.equal(res.code, "internal", JSON.stringify(res));
    assert.ok(!fs.existsSync(lock));
    assert.equal(await editLockFree(), "free");
    assert.ok(!fs.existsSync(path.join(c.b, ".claude", "agents", "rev.md")));
    fs.rmSync(path.join(store, "index.json"));

    // 구간 안에서 예외가 나는 경우(원장의 applied 가 배열이 아니다)
    const cfgPath = path.join(store, "config.json");
    const cfg = loadJ(cfgPath);
    cfg.imports = [{ id: "broken", applied: null }];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    res = await run(c.b, ["undo", "--import-id", "broken"], fast);
    assert.equal(res.code, "internal", JSON.stringify(res));
    assert.ok(!fs.existsSync(lock));
    assert.equal(await editLockFree(), "free");

    // 두 락이 풀렸으니 다음 가져오기가 그대로 된다
    res = await run(c.b, ["apply", "--bundle", c.bundle, "--plan-id", pid], fast);
    assert.equal(res.code, "ok", JSON.stringify(res));
  } finally {
    fs.rmSync(c.tmp, { recursive: true, force: true });
  }
});

// ----- TestOptional -----

async function optionalSetup(): Promise<PlanCtx & { msix: string; obundle: string }> {
  const c = await applySetup();
  const ch = path.join(c.a, ".claude");
  const projA = path.join(c.a, "work", "p1");
  fs.mkdirSync(projA, { recursive: true });
  const cj = loadJ(path.join(c.a, ".claude.json"));
  cj.projects = { [projA]: {} };
  write(path.join(c.a, ".claude.json"), JSON.stringify(cj));
  const enc = projA.replace(/[^A-Za-z0-9]/gu, "-");
  write(path.join(ch, "projects", enc, "memory", "MEMORY.md"), "- note\n");
  write(path.join(ch, "projects", "orphan", "memory", "MEMORY.md"), "x\n");
  write(path.join(ch, "agent-memory", "rev", "notes.md"), "n\n");
  write(path.join(ch, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "x@mk": [{ scope: "user", installPath: "c" }] } }));
  const st = loadJ(path.join(ch, "settings.json"));
  st.extraKnownMarketplaces = { mk: { source: { source: "github", repo: "o/mk" } } };
  write(path.join(ch, "settings.json"), JSON.stringify(st));
  const obundle = path.join(c.tmp, "opt-bundle");
  const res = await run(c.a, ["export", "--out", obundle, "--with-optional", "memory,agent-memory"]);
  assert.ok(res.ok, JSON.stringify(res));
  assert.ok((res.skipped as any[]).some((x) => x.id === "cc.project-memory/orphan"));
  return { ...c, obundle };
}

test("optional: project memory follows the project path on this pc", async () => {
  const c = await optionalSetup();
  try {
    const st = async () => Object.fromEntries(((await run(c.b, ["plan", "--bundle", c.obundle])).items as any[]).map((i) => [i.id, i]));
    const mid = Object.keys(await st()).find((k) => k.startsWith("cc.project-memory/"))!;
    assert.equal((await st())[mid].code, "project_missing");
    const projB = path.join(c.b, "work", "p1");
    fs.mkdirSync(projB, { recursive: true });
    const row = (await st())[mid];
    assert.equal(row.target, path.join(c.b, ".claude", "projects", projB.replace(/[^A-Za-z0-9]/gu, "-"), "memory"));
    assert.equal((await applyBundle(c.b, c.obundle)).code, "ok");
    assert.ok(fs.statSync(path.join(row.target, "MEMORY.md")).isFile());
    assert.ok(fs.statSync(path.join(c.b, ".claude", "agent-memory", "rev", "notes.md")).isFile());
  } finally {
    fs.rmSync(c.tmp, { recursive: true, force: true });
  }
});

test("optional: install-plugins reports each plugin", async () => {
  const c = await optionalSetup();
  try {
    const noClaude = { PATH: path.dirname(process.execPath) };
    let pid = (await run(c.b, ["plan", "--bundle", c.obundle])).plan_id as string;
    const res = await run(c.b, ["apply", "--bundle", c.obundle, "--plan-id", pid, "--install-plugins"], noClaude);
    assert.equal(res.code, "partial", JSON.stringify(res));
    assert.deepEqual((res.plugins as any[]).map((p) => [p.id, p.code]), [["x@mk", "tool_missing"]]);
    assert.deepEqual(loadJ(path.join(c.b, ".claude", "settings.json")).enabledPlugins, { "x@mk": true });
    pid = (await run(c.b, ["plan", "--bundle", c.obundle])).plan_id as string;   // 설정은 이미 같고 설치만 남았다
    const again = await run(c.b, ["apply", "--bundle", c.obundle, "--plan-id", pid, "--install-plugins"], noClaude);
    assert.deepEqual([again.code, (again.plugins as any[]).map((p) => p.id)], ["partial", ["x@mk"]]);
  } finally {
    fs.rmSync(c.tmp, { recursive: true, force: true });
  }
});

// ----- TestPathAdapt -----
// 다른 PC 번들: 도구 폴더가 이 PC 의 다른 자리에 있다(사례: D:\my-tools -> C:\my-tools, D: 없음).

interface PathCtx { tmp: string; src: string; dst: string; a: string; b: string; bundle: string; roots: string }

async function pathSetup(): Promise<PathCtx> {
  const tmp = tmpdir("transfer_paths_");
  const src = path.join(tmp, "srcdrive", "my-tools");
  const dst = path.join(tmp, "dstdrive", "my-tools");
  const a = path.join(tmp, "a", "home");
  const ch = path.join(a, ".claude");
  for (const rel of ["hooks/a.js", "hooks/b.js", "srv.js"]) write(path.join(src, ...rel.split("/")), "//\n");
  const cmd = (rel: string) => `node "${path.join(src, ...rel.split("/"))}"`;
  write(path.join(ch, "settings.json"), JSON.stringify({
    model: "sonnet",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: cmd("hooks/a.js") }, { type: "command", command: cmd("hooks/b.js") }] }],
      PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: cmd("hooks/a.js") }] }],
    },
  }));
  write(path.join(a, ".claude.json"), JSON.stringify({ mcpServers: { tool: { command: "node", args: [path.join(src, "srv.js")] } } }));
  write(path.join(a, "store", "config.json"), JSON.stringify({ version: 1, store: path.join(a, "store"), tracked: [], libraries: [src] }));
  const bundle = path.join(tmp, "a-bundle");
  assert.ok((await run(a, ["export", "--out", bundle])).ok);
  fs.rmSync(path.join(tmp, "srcdrive"), { recursive: true });          // 원래 PC 의 드라이브는 이 PC 에 없다
  for (const rel of ["hooks/a.js", "srv.js"]) write(path.join(dst, ...rel.split("/")), "//\n");   // b.js 는 이 PC 에 설치돼 있지 않다
  const b = path.join(tmp, "b", "home");
  // 이 PC 에는 같은 훅이 대소문자·구분자만 다르게 이미 등록돼 있다
  const dup = 'node "' + path.join(dst, "Hooks", "a.js").replace(/\\/g, "/") + '"';
  write(path.join(b, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: dup }] }] } }));
  return { tmp, src, dst, a, b, bundle, roots: JSON.stringify({ [src]: dst }) };
}

function hooksOf(res: CliDoc): Record<string, any> {
  const out: Record<string, any> = {};
  for (const h of itemOf(res, "cc.settings").hooks ?? []) {
    const q = [...h.command.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    out[`${h.event}|${path.basename(q[q.length - 1]).toLowerCase()}`] = h;
  }
  return out;
}

async function withPath(fn: (c: PathCtx) => Promise<void>): Promise<void> {
  const c = await pathSetup();
  try {
    await fn(c);
  } finally {
    fs.rmSync(c.tmp, { recursive: true, force: true });
  }
}

test("paths: without a match dead paths are never written", () => withPath(async (c) => {
  const res = await run(c.b, ["plan", "--bundle", c.bundle]);
  assert.ok(res.ok, JSON.stringify(res));
  assert.deepEqual(new Set(Object.values(hooksOf(res)).map((h) => h.state)), new Set(["blocked"]));
  const tool = itemOf(res, "cc.mcp-user/tool");
  assert.deepEqual([tool.state, tool.code], ["blocked", "path_missing"]);
  assert.ok((res.roots as any[]).some((r) => r.source === "none" && r.to === null));
  const out = await run(c.b, ["apply", "--bundle", c.bundle, "--plan-id", res.plan_id as string]);
  assert.ok(out.ok, JSON.stringify(out));
  assert.ok(!JSON.stringify(loadJ(path.join(c.b, ".claude", "settings.json"))).includes("srcdrive"));
  assert.ok(!fs.existsSync(path.join(c.b, ".claude.json")));
}));

test("paths: roots remap, drop missing, and skip duplicate", () => withPath(async (c) => {
  const res = await run(c.b, ["plan", "--bundle", c.bundle, "--roots", c.roots]);
  const hk = hooksOf(res);
  assert.equal(hk["Stop|a.js"].state, "same");          // 이미 있는 훅을 한 벌 더 넣지 않는다
  assert.equal(hk["Stop|b.js"].state, "blocked");       // 이 PC 에 없다 -> 뺀다
  const post = hk["PostToolUse|a.js"];
  assert.equal(post.state, "new");
  assert.deepEqual(post.remapped, [{ from: path.normalize(c.src), to: path.normalize(c.dst) }]);
  assert.equal(itemOf(res, "cc.mcp-user/tool").state, "new");
  assert.deepEqual((res.unresolved as any[]).map((u) => u.path.toLowerCase()), [path.join(c.dst, "hooks", "b.js").toLowerCase()]);
  const out = await run(c.b, ["apply", "--bundle", c.bundle, "--plan-id", res.plan_id as string, "--roots", c.roots]);
  assert.ok(out.ok, JSON.stringify(out));
  const st = loadJ(path.join(c.b, ".claude", "settings.json"));
  assert.equal(st.hooks.Stop[0].hooks.length, 1);
  assert.ok(st.hooks.PostToolUse[0].hooks[0].command.includes("dstdrive"));
  assert.ok(!JSON.stringify(st).includes("srcdrive"));
  assert.ok(!JSON.stringify(st).includes("b.js"));
  assert.ok(loadJ(path.join(c.b, ".claude.json")).mcpServers.tool.args[0].includes("dstdrive"));
  assert.deepEqual((out.dropped as any[]).map((d) => d.target.toLowerCase()), [path.join(c.dst, "hooks", "b.js").toLowerCase()]);
  assert.equal(((await run(c.b, ["history"])).imports as any[])[0].dropped, 1);
  const again = await run(c.b, ["plan", "--bundle", c.bundle]);   // 확정한 짝은 기억한다
  const r = (again.roots as any[]).find((x) => x.from === path.normalize(c.src));
  assert.deepEqual([r.source, r.to], ["user", path.normalize(c.dst)]);
  assert.equal(itemOf(again, "cc.mcp-user/tool").state, "same");
}));

test("paths: library root is inferred from the role", () => withPath(async (c) => {
  const res = await run(c.b, ["plan", "--bundle", c.bundle], { CLAUDE_CONFIG_LIBRARIES: c.dst });
  const r = (res.roots as any[]).find((x) => x.from === path.normalize(c.src));
  assert.deepEqual([r.to, r.source, r.resolved], [path.normalize(c.dst), "library", 3]);
  assert.equal(itemOf(res, "cc.mcp-user/tool").state, "new");
}));

test("paths: working server is merged and keeps what only this pc has", () => withPath(async (c) => {
  // 구분자만 다른 같은 경로 + 이 PC 에만 있는 env -> 바꿀 게 없다
  const srv = path.join(c.dst, "srv.js").replace(/\\/g, "/").replace("/srv.js", "//srv.js");
  write(path.join(c.b, ".claude.json"), JSON.stringify({ mcpServers: { tool: { type: "stdio", command: "node", args: [srv], env: { ONLY_HERE: "1" } } } }));
  let res = await run(c.b, ["plan", "--bundle", c.bundle, "--roots", c.roots]);
  assert.equal(itemOf(res, "cc.mcp-user/tool").state, "same");
  // 실행 명령이 다르면 충돌로 보이고 기본은 이 PC 값
  write(path.join(c.b, ".claude.json"), JSON.stringify({ mcpServers: { tool: { command: "node.exe", args: [srv], env: { ONLY_HERE: "1" } } } }));
  res = await run(c.b, ["plan", "--bundle", c.bundle, "--roots", c.roots]);
  const tool = itemOf(res, "cc.mcp-user/tool");
  assert.deepEqual([tool.state, tool.conflicts], ["changed", ["command"]]);
  const out = await run(c.b, ["apply", "--bundle", c.bundle, "--plan-id", res.plan_id as string, "--roots", c.roots]);
  assert.ok(out.ok, JSON.stringify(out));
  const got = loadJ(path.join(c.b, ".claude.json")).mcpServers.tool;
  assert.deepEqual([got.command, got.env], ["node.exe", { ONLY_HERE: "1" }]);
}));

test("paths: working server is not replaced by a dead one", () => withPath(async (c) => {
  write(path.join(c.b, ".claude.json"), JSON.stringify({ mcpServers: { tool: { command: "node", args: [path.join(c.dst, "srv.js")] } } }));
  const tool = itemOf(await run(c.b, ["plan", "--bundle", c.bundle]), "cc.mcp-user/tool");
  assert.deepEqual([tool.state, tool.code], ["blocked", "keep_working"]);
}));

test("paths: excluded hook is not written", () => withPath(async (c) => {
  let res = await run(c.b, ["plan", "--bundle", c.bundle, "--roots", c.roots]);
  const hid = hooksOf(res)["PostToolUse|a.js"].id;
  res = await run(c.b, ["plan", "--bundle", c.bundle, "--roots", c.roots, "--exclude", hid]);
  assert.equal(hooksOf(res)["PostToolUse|a.js"].excluded, true);
  const out = await run(c.b, ["apply", "--bundle", c.bundle, "--plan-id", res.plan_id as string, "--roots", c.roots, "--exclude", hid]);
  assert.ok(out.ok, JSON.stringify(out));
  assert.ok(!("PostToolUse" in loadJ(path.join(c.b, ".claude", "settings.json")).hooks));
}));

test("paths: roots command validates and saves for the next plan", () => withPath(async (c) => {
  const bad = await run(c.b, ["roots", "--bundle", c.bundle, "--roots", JSON.stringify({ [c.src]: path.join(c.tmp, "nope") })]);
  assert.equal(bad.ok, false);
  const ok = await run(c.b, ["roots", "--bundle", c.bundle, "--roots", c.roots]);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual([(ok.roots as any[])[0].total, (ok.roots as any[])[0].resolved], [4, 3]);
  const res = await run(c.b, ["plan", "--bundle", c.bundle]);
  const r = (res.roots as any[]).find((x) => x.from === path.normalize(c.src));
  assert.equal(r.source, "claude");
  assert.equal(itemOf(res, "cc.mcp-user/tool").state, "new");
}));

// ----- TestInferRoots -----

test("infer roots: library first, then drive swap, and no guessing by file name", { skip: !WIN && "드라이브 글자 추정은 Windows 경로 규칙" }, () => {
  const have = new Set(["C:\\", "C:\\my-tools", "C:\\my-tools\\hooks", "C:\\my-tools\\hooks\\a.js",
    "C:\\mcpapps", "C:\\mcpapps\\x", "C:\\mcpapps\\x\\log.js", "C:\\other\\index.js"].map((p) => p.toLowerCase()));
  const ex = (p: string) => have.has(path.win32.normalize(p).toLowerCase());
  const missing = ["D:\\my-tools\\hooks\\a.js", "D:\\my-tools\\hooks\\gone.js", "D:\\mcpapps\\x\\log.js", "D:\\fast-question\\index.js"];
  const roots = inferRoots(missing, ["D:\\my-tools"], ["C:\\my-tools"], ex, ["C:\\"]);
  assert.deepEqual(roots.map((r) => [r.from, r.to, r.source, r.total, r.resolved]),
    [["D:\\my-tools", "C:\\my-tools", "library", 2, 1], ["D:\\", "C:\\", "drive", 2, 1]]);
});

test("path map keeps slash style and path boundaries", { skip: !WIN && "Windows 경로 규칙" }, () => {
  const m = new PathMap([["D:\\my-tools", "C:\\my-tools"], ["D:\\", "C:\\"]]);
  assert.equal(m.sub('node "D:/my-tools/Hooks/a.js"'), 'node "C:/my-tools/Hooks/a.js"');
  assert.equal(m.sub("D:\\mcpapps\\x.js"), "C:\\mcpapps\\x.js");
  assert.equal(m.sub("D:\\my-toolsX\\a"), "C:\\my-toolsX\\a");      // 긴 루트는 경계에서만
  assert.equal(m.sub("AD:\\x"), "AD:\\x");
  assert.equal(normCmd('node "C:/my-tools/Hooks/a/index.js"'), normCmd("node c:\\my-tools\\hooks\\a/index.js"));
});

// ----- TestSync -----

test("sync: push, pull, then both sides change", async () => {
  const tmp = tmpdir("transfer_sync_");
  try {
    const sync = path.join(tmp, "sync");
    fs.mkdirSync(sync);
    const a = makeHome(path.join(tmp, "a"), path.join(tmp, "tools"));
    const b = path.join(tmp, "b", "home");
    fs.mkdirSync(b, { recursive: true });
    const states = async (home: string, frm: string) => {
      const res = await run(home, ["sync-status", "--from", frm]);
      assert.ok(res.ok, JSON.stringify(res));
      return Object.fromEntries((res.items as any[]).map((i) => [i.id, i.state]));
    };
    assert.equal((await run(b, ["sync-push"])).code, "sync_unconfigured");
    for (const [home, name] of [[a, "pc-a"], [b, "pc-b"]]) assert.ok((await run(home, ["sync-setup", "--dir", sync, "--profile", name])).ok);
    assert.ok((await run(a, ["sync-push"])).ok);
    assert.deepEqual(((await run(b, ["sync-status"])).profiles as any[]).map((p) => p.profile), ["pc-a"]);
    const pid = (await run(b, ["plan", "--sync-from", "pc-a"])).plan_id as string;
    assert.equal((await run(b, ["sync-pull", "--from", "pc-a", "--plan-id", pid])).code, "ok");
    let st = await states(b, "pc-a");
    assert.deepEqual([st["cc.skills/qa"], st["cc.agents/rev.md"]], ["in-sync", "in-sync"]);
    assert.equal(st["cc.mcp-user/srv"], "untracked");   // 시크릿이 없어 가져오지 못했다
    write(path.join(a, ".claude", "skills", "qa", "SKILL.md"), "a2\n");
    write(path.join(a, ".claude", "agents", "rev.md"), "a2\n");
    assert.ok((await run(a, ["sync-push"])).ok);
    write(path.join(b, ".claude", "skills", "qa", "SKILL.md"), "b2\n");
    st = await states(b, "pc-a");
    assert.deepEqual([st["cc.skills/qa"], st["cc.agents/rev.md"]], ["diverged", "remote-ahead"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ----- 순수 함수 -----

test("tree digest orders files before subfolders like os.walk", () => {
  const rows: [string, string][] = [["b/x", "h1"], ["a", "h2"], ["b/a/y", "h3"], ["c", "h4"]];
  const want = "sha256:" + crypto.createHash("sha256").update("a\0h2\nc\0h4\nb/x\0h1\nb/a/y\0h3\n").digest("hex");
  assert.equal(treeDigest(rows), want);
  assert.equal(treeDigest([...rows].reverse()), want);
});

test("tokenize keeps CLAUDE_HOME whole and respects path boundaries", async () => {
  const home = WIN ? "C:\\Users\\demo" : "/home/demo";
  await withEnv({ ...process.env, USERPROFILE: home, HOME: home }, () => {
    const toks = makeTokens(path.join(home, "AppData", "Roaming", "Claude"));
    const ch = path.join(home, ".claude");
    assert.equal(tokenize(`node "${ch}${path.sep}hooks${path.sep}x.js"`, toks), 'node "${CLAUDE_HOME}' + path.sep + "hooks" + path.sep + 'x.js"');
    assert.equal(tokenize(`${home}x`, toks), `${home}x`);
    assert.equal(tokenize(home, toks), "${HOME}");
    if (WIN) assert.equal(tokenize("c:/users/DEMO/.claude/a", toks), "${CLAUDE_HOME}/a");
    assert.equal(detokenize("${CLAUDE_HOME}/a ${HOME}", toks), `${ch}/a ${home}`);
  });
});

test("scrub replaces values under secret keys and secret-looking values", () => {
  const found: Record<string, string> = {};
  const out = scrub({ env: { API_KEY: "v", PLAIN: "x", nested: [SECRET] }, args: ["sk-" + "a".repeat(20), "C:\\" + "a1".repeat(30)] }, "id", found);
  assert.deepEqual(out, {
    env: { API_KEY: "${CM_SECRET:id:env.API_KEY}", PLAIN: "x", nested: ["${CM_SECRET:id:env.nested[0]}"] },
    args: ["${CM_SECRET:id:args[0]}", "C:\\" + "a1".repeat(30)],
  });
  assert.deepEqual(Object.keys(found), ["env.API_KEY", "env.nested[0]", "args[0]"]);
  const [back, missing] = resolveSecrets(out, [{ id: found }]);
  assert.deepEqual(missing, []);
  assert.equal((back as any).env.nested[0], SECRET);
});

test("find paths reads quoted pieces and lists", () => {
  assert.deepEqual(findPaths('node "C:\\a b\\x.js" --cfg D:/c.json,'), ["C:\\a b\\x.js", "D:/c.json"]);
  assert.deepEqual(findPaths("C:\\a;~/b;rel", true), ["C:\\a", "~/b"]);
  assert.deepEqual(findPaths("cmd /c dir"), WIN ? [] : ["/c"]);
});

test("merge unions arrays, merges hook entries by matcher, and keeps scalars unless taken", () => {
  const conflicts: string[] = [];
  const cur = { model: "opus", hooks: { Stop: [{ matcher: "*", hooks: [{ command: "a" }] }] }, allow: ["Read"] };
  const inc = { model: "sonnet", hooks: { Stop: [{ matcher: "*", hooks: [{ command: "b" }] }] }, allow: ["Read", "Bash"], n: 1 };
  const out = merge(cur, inc, (p) => p === "never", conflicts);
  assert.deepEqual(out, { model: "opus", hooks: { Stop: [{ matcher: "*", hooks: [{ command: "a" }, { command: "b" }] }] }, allow: ["Read", "Bash"], n: 1 });
  assert.deepEqual(conflicts, ["model"]);
  assert.deepEqual(merge({ a: 1 }, { a: true }, () => true, []), { a: 1 });   // Python 에서 True == 1
  assert.deepEqual(union([1, { x: 1 }], [{ x: 1 }, 2]), [1, { x: 1 }, 2]);
});

test("merge server keeps env only on this pc and compares paths loosely", { skip: !WIN && "Windows 경로 규칙" }, () => {
  const conflicts: string[] = [];
  const out = mergeServer({ command: "node", args: ["C:/t//srv.js"], env: { ONLY: "1" } },
    { command: "node", args: ["c:\\t\\srv.js"], env: { NEW: "2" }, type: "stdio" }, () => false, conflicts);
  assert.deepEqual(out, { command: "node", args: ["C:/t//srv.js"], env: { ONLY: "1", NEW: "2" }, type: "stdio" });
  assert.deepEqual(conflicts, []);
});

test("sync state", () => {
  assert.equal(syncState("a", "a", null), "in-sync");
  assert.equal(syncState("a", "b", null), "untracked");
  assert.equal(syncState("a", "b", "b"), "local-ahead");
  assert.equal(syncState("a", "b", "a"), "remote-ahead");
  assert.equal(syncState("a", "b", "c"), "diverged");
});

test("safe member rejects traversal, drives, and backslashes", () => {
  for (const bad of ["", "a/../b", "a//b", "./a", "C:/x", "a\\b"]) assert.throws(() => safeMember(bad), BundleError);
  assert.deepEqual(safeMember("files/${CLAUDE_HOME}/a"), ["files", "${CLAUDE_HOME}", "a"]);
});

// Python 판과의 교차 확인은 저장한 Python 출력으로 transfer.xcheck.test.ts 에서 한다.
