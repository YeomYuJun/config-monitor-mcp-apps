// demo_profile.ts - README 스크린샷과 기준 출력 테스트(tests/golden)에 쓰는 데모 프로필을 만든다.
//
//   npx tsx scripts/demo_profile.ts Z:\
//
// <root> 아래에 가짜 사용자(alex)의 Claude 설정, 추적 프로젝트 하나, 라이브러리, 스냅샷 이력,
// 다른 PC 에서 만든 이관 번들을 만든다. 실제 설정은 건드리지 않는다. 화면 경로가 짧고 사람 이름이
// 드러나지 않게, 빈 드라이브 글자에 임시 폴더를 subst 로 붙여 그 루트를 넘기는 것을 권한다.
// 파일 바이트는 이 프로필을 처음 만든 Python 판(텍스트 모드 쓰기, json.dumps indent=2)과 같다.
//
// 끝에 대시보드를 이 프로필로 띄우는 환경변수를 출력한다(브라우저 모드: npm run serve).
import fs from "node:fs";
import path from "node:path";
import * as cas from "../src/core/cas.ts";
import { pyDumps, type CliDoc } from "../src/core/cli_result.ts";
import { textModeNewlines } from "../src/core/lib_store.ts";
import * as transfer from "../src/core/transfer.ts";

type Json = Record<string, any>;

function write(p: string, text: string | Json): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, textModeNewlines(typeof text === "string" ? text : pyDumps(text, { indent: 2 })), "utf8");
}

function readJson(p: string): Json {
  return JSON.parse(fs.readFileSync(p, "utf8")) as Json;
}

function md(desc: string, body = "", front: Record<string, string> = {}): string {
  const head = Object.entries(front).map(([k, v]) => `${k}: ${v}\n`).join("");
  return `---\ndescription: ${desc}\n${head}---\n\n${body}\n`;
}

/** 데모 사용자의 env 로 core 명령을 부른다(core 는 env 를 호출 시점에 읽는다). */
async function run(env: Record<string, string>, fn: () => Promise<CliDoc>): Promise<void> {
  const keep: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    keep[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    const d = await fn();
    if (!d.ok) throw new Error(`${d.code}: ${d.message}`);
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function envFor(home: string, store: string, libs = ""): Record<string, string> {
  return {
    HOME: home, USERPROFILE: home, CLAUDE_SNAPSHOT_STORE: store,
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    CLAUDE_CONFIG_LIBRARIES: libs, CLAUDE_CAS_NO_DEFAULT_TRACK: "0",
  };
}

const node = (p: string) => `node "${p}"`;

/** my-tools 모양의 개인 라이브러리: .claude 구조 + 훅·MCP 도구. */
function library(lib: string): void {
  write(path.join(lib, "skills", "release-notes", "SKILL.md"), md("Draft release notes from merged PRs"));
  write(path.join(lib, "skills", "sql-review", "SKILL.md"), md("Review SQL migrations for locking and data loss"));
  write(path.join(lib, "skills", "api-docs", "SKILL.md"), md("Generate endpoint docs from route handlers"));
  write(path.join(lib, "agents", "test-writer.md"), md("Writes focused unit tests for a changed file", "", { name: "test-writer" }));
  write(path.join(lib, "agents", "security-auditor.md"), md("Audits a diff for injection and secret leaks", "", { name: "security-auditor" }));
  write(path.join(lib, "commands", "standup.md"), md("Summarize yesterday's commits for standup"));
  // 도구 폴더마다 플러그인과 같은 선언 파일을 둬 Library 의 Hooks·MCP 단위로 잡히게 한다.
  for (const [h, event, matcher] of [["format-on-save", "PostToolUse", "Edit|Write"], ["guard-secrets", "PreToolUse", "Bash"], ["lint", "Stop", null]] as const) {
    const d = path.join(lib, "hooks", h);
    write(path.join(d, "index.js"), "// demo hook\n");
    const entry: Json = { hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/index.js" }] };
    if (matcher) entry.matcher = matcher;
    write(path.join(d, "hooks", "hooks.json"), { hooks: { [event]: [entry] } });
  }
  const srv = path.join(lib, "servers", "notes");
  write(path.join(srv, "server.js"), "// demo MCP server\n");
  write(path.join(srv, ".mcp.json"), { mcpServers: { notes: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] } } });
}

function userHome(home: string, lib: string, project: string): void {
  const ch = path.join(home, ".claude");
  const hooks = path.join(lib, "hooks");
  write(path.join(ch, "CLAUDE.md"), "# Working style\n\n- Prefer small, reviewed changes.\n");
  for (const [name, desc] of [["code-review", "Review a diff for correctness and readability"],
    ["changelog", "Keep CHANGELOG.md in step with releases"],
    ["release-notes", "Draft release notes from merged PRs"],
    ["debug-trace", "Trace a failing request through the logs"]]) {
    write(path.join(ch, "skills", name, "SKILL.md"), md(desc));
  }
  for (const [name, desc] of [["planner", "Breaks a feature into reviewable steps"],
    ["test-writer", "Writes focused unit tests for a changed file"],
    ["doc-editor", "Tightens README and docs prose"]]) {
    write(path.join(ch, "agents", `${name}.md`), md(desc, "", { name, tools: "Read, Grep, Edit" }));
  }
  write(path.join(ch, "commands", "standup.md"), md("Summarize yesterday's commits for standup"));
  write(path.join(ch, "commands", "triage.md"), md("Label and route new issues"));
  write(path.join(ch, "rules", "style.md"), md("House style for TypeScript"));
  write(path.join(ch, "rules", "sql.md"), md("Migration rules", "", { paths: "migrations/**" }));
  write(path.join(ch, "output-styles", "concise.md"), md("Short answers, code first"));
  write(path.join(ch, "settings.json"), {
    model: "sonnet",
    outputStyle: "concise",
    permissions: { allow: ["Read", "Bash(git status)", "Bash(git diff:*)"], deny: ["Read(./.env)"] },
    hooks: {
      PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: node(path.join(hooks, "format-on-save", "index.js")) }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: node(path.join(hooks, "guard-secrets", "index.js")) }] }],
    },
  });
  write(path.join(home, ".claude.json"), {
    mcpServers: {
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      notes: { command: "node", args: [path.join(lib, "servers", "notes", "server.js")] },
    },
    projects: { [project.replace(/\\/g, "/")]: { allowedTools: ["Bash(npm test)"], hasTrustDialogAccepted: true } },
  });
  write(path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"), {
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", project] },
      notes: { command: "node", args: [path.join(lib, "servers", "notes", "server.js")] },
    },
  });
}

function projectDir(project: string): void {
  const pc = path.join(project, ".claude");
  write(path.join(project, "CLAUDE.md"), "# acme-web\n\nNext.js app. Run `npm test` before pushing.\n");
  write(path.join(pc, "settings.json"), { permissions: { allow: ["Bash(npm test)", "Bash(npm run lint)"] } });
  write(path.join(pc, "skills", "deploy-preview", "SKILL.md"), md("Deploy a preview build for this branch"));
  write(path.join(pc, "agents", "planner.md"), md("Plans work against this repo's conventions", "", { name: "planner" }));
  write(path.join(project, ".mcp.json"), { mcpServers: { postgres: { command: "npx", args: ["-y", "pg-mcp"] } } });
}

/** 설정 파일마다 diff 가 보이는 리비전 몇 개 + 마지막에는 스냅샷 밖에서 고친 변경 하나. */
async function history(home: string, store: string, project: string, libs: string): Promise<void> {
  const env = envFor(home, store, libs);
  const sp = path.join(home, ".claude", "settings.json");
  await run(env, () => cas.main(["--store", store, "init"]));
  await run(env, () => cas.main(["--store", store, "track", project]));
  await run(env, () => cas.main(["--store", store, "snapshot", "-m", "initial setup"]));
  const edits: [string, (s: Json) => void][] = [
    ["allow npm test", (s) => s.permissions.allow.push("Bash(npm test)")],
    ["deny reading secrets", (s) => s.permissions.deny.push("Read(./secrets/**)")],
    ["switch model", (s) => { s.model = "opus"; }],
  ];
  for (const [msg, fn] of edits) {
    const s = readJson(sp);
    fn(s);
    write(sp, s);
    await run(env, () => cas.main(["--store", store, "snapshot", "-m", msg]));
  }
  const pp = path.join(project, ".claude", "settings.json");
  const s = readJson(pp);
  s.permissions.allow.push("Bash(npx playwright test)");
  write(pp, s);                                     // 스냅샷 밖 변경 - 목록에 '수정' 으로 보인다
}

/** 다른 PC(sam, 도구는 그 PC 의 old-drive)에서 만든 번들. 만든 뒤 그 PC 폴더는 지운다. */
async function oldPcBundle(root: string, bundle: string): Promise<void> {
  const old = path.join(root, "old-pc");
  const home = path.join(old, "Users", "sam");
  const lib = path.join(old, "old-drive", "my-tools");
  const store = path.join(home, ".claude-snapshot");
  library(lib);
  write(path.join(lib, "hooks", "notify", "index.js"), "// only on the old PC\n");
  const ch = path.join(home, ".claude");
  const hooks = path.join(lib, "hooks");
  for (const [name, desc] of [["code-review", "Review a diff for correctness and readability"],
    ["sql-review", "Review SQL migrations for locking and data loss"],
    ["api-docs", "Generate endpoint docs from route handlers"]]) {
    write(path.join(ch, "skills", name, "SKILL.md"), md(desc));
  }
  write(path.join(ch, "agents", "security-auditor.md"), md("Audits a diff for injection and secret leaks", "", { name: "security-auditor" }));
  write(path.join(ch, "settings.json"), {
    model: "opus",
    permissions: { allow: ["Read", "Bash(git status)", "Bash(pytest:*)"] },
    hooks: {
      PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: node(path.join(hooks, "format-on-save", "index.js")) }] }],
      Stop: [{ hooks: [{ type: "command", command: node(path.join(hooks, "notify", "index.js")) },
        { type: "command", command: node(path.join(hooks, "lint", "index.js")) }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: node(path.join(hooks, "guard-secrets", "index.js")) }] }],
    },
  });
  write(path.join(home, ".claude.json"), {
    mcpServers: {
      notes: { command: "node", args: [path.join(lib, "servers", "notes", "server.js")] },
      jira: { command: "node", args: [path.join(old, "old-drive", "jira-mcp", "index.js")] },
    },
  });
  write(path.join(store, "config.json"), { version: 1, store, tracked: [], libraries: [lib] });
  await run(envFor(home, store), () => transfer.main(["--store", store, "export", "--out", bundle]));
  const mp = path.join(bundle, "manifest.json");
  const m = readJson(mp);
  m.source.host = "old-laptop";                    // 이 PC 의 호스트명이 화면에 찍히지 않게
  write(mp, m);
  fs.rmSync(old, { recursive: true, force: true });
}

const root = path.resolve(process.argv[2] ?? "demo");
const home = path.join(root, "Users", "alex");
const lib = path.join(root, "tools", "my-tools");
const project = path.join(root, "work", "acme-web");
const store = path.join(home, ".claude-snapshot");
const bundle = path.join(root, "bundles", "old-laptop");
for (const d of ["Users", "tools", "work", "bundles", "old-pc"]) fs.rmSync(path.join(root, d), { recursive: true, force: true });
library(lib);
userHome(home, lib, project);
projectDir(project);
await history(home, store, project, lib);
await oldPcBundle(root, bundle);
console.log("# 데모 프로필로 대시보드 띄우기 (PowerShell)");
for (const [k, v] of [["HOME", home], ["USERPROFILE", home], ["APPDATA", path.join(home, "AppData", "Roaming")],
  ["LOCALAPPDATA", path.join(home, "AppData", "Local")], ["CLAUDE_SNAPSHOT_STORE", store],
  ["CLAUDE_CONFIG_LIBRARIES", lib], ["CONFIG_MONITOR_LANG", "en"]]) {
  console.log(`$env:${k} = '${v}'`);
}
console.log("npm run serve   # 이관 화면: 가져오기 탭에 " + bundle);
