// MCP 도구(buildTools 의 run)가 인자를 cmd* 옵션으로 옮긴 결과를 Python 판 기준 출력과 비교한다.
// 기준 파일은 CLI argv 로 만든 것이므로, 같은 뜻의 도구 호출을 단계마다 적고 앞에서부터 그 단계 수만큼 비교한다.
// 한 케이스의 단계는 한 자식 프로세스 안에서 차례로 돈다(서버가 상주하며 여러 호출을 받는 조건).
import { after, before, test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Demo, GOLDEN_DIR, REPO, diffResults, loadExpected } from "../golden/golden.ts";

// [도구, 인자, 실행 전에 만들 폴더]. null 은 그 단계를 건너뛴다(기준 출력이 CLI 인자 파서의 오류라 도구 호출로는 생기지 않는 것).
type Step = [string, Record<string, unknown>, string[]?] | null;

const S = "{CLAUDE}/settings.json";
const LINT = "local:{LIB}/hooks/lint";
const NOTES = "local:{LIB}/servers/notes";

const CASES: Record<string, Step[]> = {
  "cas.watcher-status": [["watcher_status", {}]],
  "cas.track": [["config_track", { path: "{CLAUDE}/CLAUDE.md" }], ["config_track", { path: "{CLAUDE}/CLAUDE.md" }],
    ["config_track", { path: "{PROJECT}" }], ["get_tracked", {}]],
  "cas.untrack": [["config_untrack", { path: "{PROJECT}/.claude/settings.json" }], ["config_untrack", { path: "{PROJECT}/.claude/settings.json" }],
    ["get_tracked", {}]],
  "cas.history": [["get_file_history", { path: S }], ["get_file_history", { path: "{PROJECT}/.claude/settings.json" }]],
  "cas.cat": [["get_file_content", { path: S }], ["get_file_content", { path: "{CLAUDE}/rules/style.md" }]],
  "cas.diff": [["get_diff", { path: "{PROJECT}/.claude/settings.json" }], ["get_diff", { path: S, from: "{SNAP:0}", to: "{SNAP:-1}" }],
    ["get_diff", { path: S, from: "{SNAP:0}", raw: true }], ["get_diff", { path: S }], ["get_diff", { path: "{CLAUDE}/rules/style.md" }]],
  "cas.snapshot": [["snapshot_now", { message: "golden" }], ["snapshot_now", { message: "golden again" }]],
  "cas.gc": [["snapshot_gc", { keepDays: 90, dryRun: true }], ["snapshot_gc", { keepDays: 0, dryRun: true }], ["snapshot_gc", { keepDays: 0 }]],
  "cas.restore": [["config_restore", { path: S, from: "{SNAP:0}" }], ["get_file_content", { path: S }],
    ["config_restore", { path: S, from: "19990101T000000_000000" }]],
  "prefs.get": [["get_prefs", {}]],
  "prefs.set": [["set_prefs", { sections: { preset: "present", hidden: ["themes"], unknown: 1 }, view: { scope: "global" } }], ["get_prefs", {}]],
  "claude_config.dump": [["get_config", { projects: ["{PROJECT}/.claude"] }]],
  "claude_config.dump-filtered": [
    ["get_config", { projects: ["{PROJECT}/.claude"], sections: ["skills", "hooks", "perm"], compact: true }],
    ["get_config", { projects: ["{PROJECT}/.claude"], scope: "project", compact: true }],
    ["get_config", { projects: ["{PROJECT}/.claude"], query: "planner", compact: true }]],
  "claude_config.summary": [["summarize_config", { projects: ["{PROJECT}/.claude"] }]],
  "claude_config.projects": [["list_projects", {}], ["list_projects", { includeMissing: true }]],
  "config_edit.perm": [["config_perm_add", { kind: "allow", rule: "Bash(ls:*)" }], ["config_perm_add", { kind: "allow", rule: "Bash(ls:*)" }],
    ["config_perm_remove", { kind: "deny", rule: "Read(./.env)" }], ["config_perm_remove", { kind: "ask", rule: "Nothing" }],
    ["config_perm_add", { settings: "{PROJECT}/.claude/settings.json", kind: "deny", rule: "Bash(rm:*)" }]],
  "config_edit.hook": [["config_hook_add", { event: "Stop", command: "node notify.js", matcher: "*" }],
    ["config_hook_remove", { event: "Stop", needle: "node notify.js" }], ["config_hook_remove", { event: "Stop", needle: "node notify.js" }]],
  "config_edit.plugin-toggle": [["config_plugin_toggle", { id: "demo@market", on: false }], ["config_plugin_toggle", { id: "demo@market", on: false }],
    ["config_plugin_toggle", { id: "demo@market", on: true }]],
  "config_edit.outputstyle": [["config_outputstyle_set", { name: "" }], ["config_outputstyle_set", { name: "" }],
    ["config_outputstyle_set", { name: "concise" }]],
  "config_edit.skill": [["skill_scaffold", { name: "new-skill", desc: "Demo skill" }], ["skill_scaffold", { name: "new-skill" }],
    ["skill_scaffold", { name: "proj-skill", skillsDir: "{PROJECT}/.claude/skills", content: "---\ndescription: x\n---\n\nbody\n" }],
    ["config_skill_remove", { name: "changelog" }], ["config_skill_remove", { name: "changelog" }], ["skill_scaffold", { name: "synced" }]],
  "config_edit.agent": [["config_agent_add", { name: "reviewer", desc: "Reviews", tools: "Read, Grep", model: "sonnet" }],
    ["config_agent_add", { name: "reviewer" }], ["config_agent_remove", { name: "doc-editor" }], ["config_agent_remove", { name: "doc-editor" }]],
  "config_edit.item": [["config_item_add", { itemKind: "rule", name: "api", desc: "API rules", paths: "src/api/**" }],
    ["config_item_add", { itemKind: "workflow", name: "release" }], ["config_item_add", { itemKind: "output-style", name: "concise" }],
    ["config_item_remove", { itemKind: "rule", name: "style" }], ["config_item_remove", { itemKind: "rule", name: "style" }],
    ["config_item_add", { itemKind: "rule", name: "local", dir: "{PROJECT}/.claude/rules" }], ["config_item_add", { itemKind: "rule", name: "a/b" }]],
  "config_edit.mcp": [["config_mcp_add", { name: "demo", serverJson: '{"command":"npx","args":["-y","demo-mcp"]}', scope: "user" }],
    ["config_mcp_add", { name: "demo", serverJson: '{"command":"npx"}', scope: "desktop" }], ["config_mcp_remove", { name: "github", scope: "user" }],
    ["config_mcp_remove", { name: "github", scope: "user" }], ["config_mcp_remove", { name: "notes", scope: "desktop" }],
    ["config_mcp_add", { name: "bad", serverJson: "[1]" }]],
  "library.scan": [["library_scan", {}], ["library_scan", { targetDir: "{PROJECT}/.claude" }]],
  "library.install": [["library_install", { category: "skills", path: "sql-review" }], ["library_install", { category: "skills", path: "release-notes" }],
    ["library_install", { category: "agents", path: "security-auditor" }],
    ["library_install", { targetDir: "{PROJECT}/.claude", category: "commands", path: "standup" }],
    ["library_install", { category: "skills", path: "missing-skill" }], ["library_install", { category: "skills", path: "sql-review", origin: "remote:nope" }],
    ["library_scan", {}]],
  "library.uninstall": [["library_install", { category: "skills", path: "sql-review" }],
    ["library_uninstall", { category: "skills", name: "sql-review", origin: "remote:other" }],
    ["library_uninstall", { category: "skills", name: "sql-review" }], ["library_uninstall", { category: "skills", name: "sql-review" }]],
  "library.unregister": [["library_unregister", { lib: "{LIB}" }], ["library_unregister", { origin: "remote:nope" }],
    ["library_unregister", { origin: "market:nope" }], ["library_unregister", { origin: "bogus:x" }]],
  "library.market": [["library_market_discover", {}], ["library_catalog", {}], ["library_catalog", { limit: -1 }],
    ["library_plugin_fetch", { marketplace: "nope", plugin: "x" }], ["library_fetch", { origin: "remote:nope" }],
    ["library_add", { kind: "remote", url: "https://example.invalid/x.git", map: "[1]" }]],
  "library.hooks": [["library_hooks_install", { origin: LINT, dryRun: true }], ["library_hooks_install", { origin: LINT }],
    ["library_hooks_install", { origin: LINT }], ["library_hooks_uninstall", { origin: LINT }], ["library_hooks_uninstall", { origin: LINT }],
    ["library_hooks_install", { origin: "remote:nope" }]],
  "library.mcp": [["library_mcp_install", { origin: NOTES, dryRun: true }], ["library_mcp_install", { origin: NOTES, scope: "desktop" }],
    ["library_mcp_install", { origin: NOTES, server: "nope" }], ["library_mcp_uninstall", { origin: NOTES, scope: "desktop" }],
    ["library_mcp_uninstall", { origin: NOTES, scope: "desktop" }]],
  "plugin_cli.dry-run": [["claude_plugin_install", { marketplace: "demo-market", plugin: "demo", dryRun: true }],
    ["claude_plugin_update", { marketplace: "demo-market", plugin: "demo", scope: "managed", dryRun: true }],
    ["claude_plugin_uninstall", { marketplace: "demo-market", plugin: "demo", keepData: true, dryRun: true }],
    ["claude_marketplace_add", { source: "owner/repo", sparse: ["plugins", ".claude-plugin"], dryRun: true }],
    ["claude_marketplace_update", { dryRun: true }], ["claude_marketplace_remove", { name: "demo-market", scope: "user", dryRun: true }],
    ["claude_plugin_install", { marketplace: "demo-market", plugin: "a/b", dryRun: true }],
    null,   // --marketplace -x: CLI 에서는 argparse 가 값으로 받지 않는다. 도구 호출은 검증 오류가 된다(아래 별도 테스트)
    ["claude_plugin_install", { marketplace: "m", plugin: "demo", cwd: "{ROOT}/missing", dryRun: true }]],
  "plugin_catalog.no-cache": [["plugin_catalog", {}], ["plugin_catalog", { id: "demo@market" }], ["plugin_catalog", { cache: "{ROOT}/missing.json" }]],
  "transfer.inventory": [["config_export", { dryRun: true }], ["config_export", { dryRun: true, withOptional: ["local", "memory"] }],
    ["config_export", { dryRun: true, withOptional: ["bogus"] }]],
  "transfer.export": [["config_export", { out: "{ROOT}/out/folder-bundle" }], ["config_export", { out: "{ROOT}/out/folder-bundle" }],
    ["config_export", { out: "{ROOT}/out/zip.cmbundle" }]],
  "transfer.import": [["config_import_plan", { bundle: "{BUNDLE}" }], ["config_import_apply", { bundle: "{BUNDLE}", planId: "{S0.plan_id}" }],
    ["config_import_undo", { importId: "{S1.import_id}" }], ["config_import_undo", { importId: "{S1.import_id}" }], ["config_import_history", {}]],
  "transfer.import-stale": [["config_import_apply", { bundle: "{BUNDLE}", planId: "0000000000000000" }],
    ["config_import_plan", { bundle: "{ROOT}/no-bundle" }], ["config_import_plan", {}], ["config_import_plan", { bundle: "{BUNDLE}", secrets: [1] }]],
  "transfer.roots": [["config_import_roots", { bundle: "{BUNDLE}", roots: { "{ROOT}\\old-pc\\old-drive": "{ROOT}\\tools" } }],
    ["config_import_plan", { bundle: "{BUNDLE}" }],
    ["config_import_roots", { bundle: "{BUNDLE}", roots: { "{ROOT}\\nowhere": "{ROOT}\\missing" } }]],
  "transfer.sync": [["config_sync_status", {}], ["config_sync_setup", { dir: "{ROOT}/sync", profile: "pc1" }, ["{ROOT}/sync"]], ["config_sync_push", {}],
    ["config_sync_status", {}], ["config_sync_status", { from: "pc1" }], ["config_import_plan", { syncFrom: "pc1" }],
    ["config_sync_pull", { from: "pc1", planId: "{S5.plan_id}" }], ["config_sync_status", { from: "nope" }]],
};

let demo: Demo | null = null;
before(() => { demo = Demo.create(); });
after(() => demo?.dispose());

/** 데모 프로필에서 도구 단계를 한 자식 프로세스로 돌려 정규화한 문서를 돌려준다. parallel 이면 단계를 동시에 부른다. */
function runTools(steps: NonNullable<Step>[], parallel = false): unknown[] {
  demo!.reset();
  const args = [path.join(GOLDEN_DIR, "tool-entry.ts"), demo!.root, JSON.stringify(steps), ...(parallel ? ["parallel"] : [])];
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    env: demo!.env, cwd: REPO, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000, windowsHide: true,
  });
  deepEqual(r.status, 0, r.stderr);
  return (JSON.parse(r.stdout.trim()) as Record<string, unknown>[]).map((d, i) => {
    // get_tracked 는 cas status 문서에 서버가 changes.json 의 표식을 더한다(기준 출력에는 없다).
    if (steps[i][0] === "get_tracked") delete d.change;
    return demo!.normalize(d);
  });
}

for (const [id, steps] of Object.entries(CASES)) {
  test(`tools golden ${id}`, () => {
    const keep = steps.map((s, i) => [s, i] as const).filter((x): x is readonly [NonNullable<Step>, number] => x[0] !== null);
    const docs = runTools(keep.map(([s]) => s));
    const expected = loadExpected(id).steps;
    const want = keep.map(([, i]) => expected[i].doc);
    const diffs = diffResults(want, docs);
    deepEqual(diffs, [], diffs.join("\n"));
  });
}

test("tools pass leading-dash values and frontmatter bodies unchanged", () => {
  const body = "---\nname:x\n---\n";
  const [skill, agent, market] = runTools([
    ["skill_scaffold", { name: "dash-skill", content: body }],
    ["config_agent_add", { name: "dash-agent", content: body }],
    ["claude_plugin_install", { marketplace: "-x", plugin: "demo", dryRun: true }],
  ]) as Record<string, unknown>[];
  deepEqual([skill.ok, agent.ok], [true, true], JSON.stringify([skill, agent]));
  deepEqual(fs.readFileSync(path.join(demo!.claude, "skills", "dash-skill", "SKILL.md"), "utf-8"), body);
  deepEqual(fs.readFileSync(path.join(demo!.claude, "agents", "dash-agent.md"), "utf-8"), body);
  deepEqual([market.ok, market.code, market.target], [false, "invalid_arg", "-x"]);
});

test("edit tools called at once in one process all land without a lock timeout", () => {
  const docs = runTools([
    ["config_perm_add", { kind: "allow", rule: "Bash(ls:*)" }],
    ["config_hook_add", { event: "Stop", command: "node notify.js", matcher: "*" }],
    ["library_hooks_install", { origin: LINT }],
    ["config_mcp_add", { name: "par", serverJson: '{"command":"npx"}' }],
    ["skill_scaffold", { name: "par-skill" }],
    ["library_install", { category: "skills", path: "sql-review" }],
    ["config_plugin_toggle", { id: "demo@market", on: false }],
    ["snapshot_now", { message: "par" }],
  ], true) as Record<string, unknown>[];
  for (const d of docs) deepEqual([d.ok, d.code === "lock_timeout"], [true, false], JSON.stringify(d));
  const s = JSON.parse(fs.readFileSync(path.join(demo!.claude, "settings.json"), "utf-8"));
  deepEqual(s.permissions.allow.includes("Bash(ls:*)"), true);
  deepEqual(s.enabledPlugins["demo@market"], false);
  const stop = JSON.stringify(s.hooks.Stop);
  deepEqual([stop.includes("node notify.js"), Object.keys(s.hooks).length > 1], [true, true], JSON.stringify(s.hooks));
  deepEqual(fs.existsSync(path.join(demo!.claude, "skills", "par-skill", "SKILL.md")), true);
  deepEqual(fs.existsSync(path.join(demo!.claude, "skills", "sql-review")), true);
  deepEqual(JSON.parse(fs.readFileSync(path.join(demo!.home, ".claude.json"), "utf-8")).mcpServers.par, { command: "npx" });
});
