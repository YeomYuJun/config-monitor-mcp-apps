// mcp-tools.ts - config-monitor 의 모든 도구 정의 + 등록 (stdio / http 공용).
//
// 설계: 도구는 같은 프로세스에서 src/core 의 cmd* 함수를 부른다. buildTools() 가 도구 정의를 만들고,
//       MCP(registerAll) 와 HTTP REST(server.ts) 가 동일한 핸들러를 공유한다.
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import * as cas from "./core/cas.ts";
import * as claudeConfig from "./core/claude_config.ts";
import type { CliDoc } from "./core/cli_result.ts";
import * as configEdit from "./core/config_edit.ts";
import { defaultStore, pyDumpsEx } from "./core/lib_store.ts";
import * as library from "./core/library.ts";
import * as pluginCatalog from "./core/plugin_catalog.ts";
import * as pluginCli from "./core/plugin_cli.ts";
import * as prefs from "./core/prefs.ts";
import * as transfer from "./core/transfer.ts";

const pexec = promisify(execFile);
export const RESOURCE_URI = "ui://config-monitor/dashboard.html";

// 서버 진입 파일의 실행 방식. 같은 진입 파일을 이 인자로 다시 띄워 watcher 와 HTTP 대시보드 서버를 돌린다.
export const WATCHER_FLAG = "--watcher";
export const HTTP_FLAG = "--http";

/** 번들(plugin/config-monitor/server.js)이면 그 파일, 저장소에서 tsx 로 돌면 src/server-stdio.ts. */
export function serverEntry(scriptDir: string): string {
  const bundled = path.join(scriptDir, "server.js");
  return existsSync(bundled) ? bundled : path.join(scriptDir, "server-stdio.ts");
}

/** 진입 파일을 mode 로 다시 띄우는 node 인자. tsx 로 돌 때는 execArgv 에 tsx 로더가 들어 있다. */
export function entryArgs(scriptDir: string, mode: string, ...rest: string[]): string[] {
  return [...process.execArgv, serverEntry(scriptDir), mode, ...rest];
}

/**
 * 이 설치본의 watcher 프로세스를 고르는 PowerShell 명령. list 면 고른 프로세스를 출력만 하고, 아니면 끈다.
 * node 쪽은 " --watcher " 와, 진입 파일 전체 경로 또는 같은 스토어 경로가 커맨드라인에 있어야 한다(서버 자신은 --watcher 가 없다).
 * 스토어 경로로도 고르는 이유: 플러그인은 버전마다 설치 폴더가 달라 업데이트 뒤의 서버는 옛 진입 경로를 모른다.
 */
export function watcherKillCommand(scriptDir: string, list = false, store = ""): string {
  const q = (s: string) => s.replace(/'/g, "''");
  const wpy = q(path.join(scriptDir, "watcher.py").replace(/\\/g, "/"));
  const entry = q(serverEntry(scriptDir));
  const nodeNames = [...new Set(["node.exe", path.basename(process.execPath).toLowerCase()])].map((n) => `'${q(n)}'`).join(",");
  const where = store ? `($_.CommandLine.Contains('${entry}') -or $_.CommandLine.Contains('${q(store)}'))` : `$_.CommandLine.Contains('${entry}')`;
  return "Get-CimInstance Win32_Process | Where-Object { " +
    `((@(${nodeNames}) -contains $_.Name.ToLower()) -and $_.CommandLine -and ${where} -and $_.CommandLine.Contains(' ${WATCHER_FLAG} ')) -or ` +
    `((($_.Name -like 'python*') -or ($_.Name -eq 'py.exe')) -and $_.CommandLine -like '*${wpy}*') -or ` +
    "(($_.Name -eq 'powershell.exe') -and $_.CommandLine -like '*-File*watcher.ps1*') } | " +
    "Where-Object { $_.ProcessId -ne $PID } | " +
    (list ? "ForEach-Object { $_.ProcessId }" : "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");
}

// CONFIG_MONITOR_LANG: 대시보드 시작 언어. ko/ko-KR/KO_KR 계열 -> ko, en/en-US/EN 계열 -> en.
// 미지정이면 null 을 돌려 UI 가 스스로 결정하게 둔다(저장된 토글 선택 -> 없으면 ko).
// 인식 못 하는 값은 ko(안전한 기본). 지역 접미사는 '-'/'_' 앞자리만 본다.
export function resolveLang(raw?: string): "ko" | "en" | null {
  const v = String(raw ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (!v || v === "auto") return null;   // 플러그인 userConfig 의 기본값 auto 는 미지정과 같다
  return v === "en" ? "en" : "ko";
}

// 빌드된 대시보드 HTML 에 시작 언어를 주입하는 <script>. env 미지정이면 빈 문자열
// (주입하지 않아야 UI 가 브라우저의 저장된 선택을 쓸 수 있다 - 항상 주입하면 그 경로가 죽는다).
export function langScript(): string {
  const l = resolveLang(process.env.CONFIG_MONITOR_LANG);
  return l ? `<script>window.__CONFIG_MONITOR_LANG__=${JSON.stringify(l)};</script>` : "";
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
// 문서의 PyFloat(설정 파일의 1.0)와 bigint 는 JSON.stringify 가 다루지 못하므로 Python json.dumps 와 같은 표기로 쓴다.
function docResult(doc: unknown): ToolResult {
  const t = pyDumpsEx(doc, { ensureAscii: false });
  return { content: [{ type: "text", text: t }], structuredContent: JSON.parse(t) as Record<string, unknown> };
}

/** cmd* 는 오류를 문서로 돌려준다. 그래도 던지면 도구가 실패하지 않게 internal 문서로 바꾼다. */
async function runCore(op: string, fn: () => Promise<CliDoc>): Promise<ToolResult> {
  try {
    return docResult(await fn());
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return docResult({ ok: false, code: "internal", message: `${op} failed: ${err.name}: ${err.message}`, detail: err.stack ?? err.message });
  }
}

export interface ToolDef {
  name: string;
  meta: { title: string; description: string; inputSchema: any; annotations: any };
  run: (args: any) => Promise<ToolResult>;
}

// 모든 데이터/액션 도구 정의(show_config_monitor 같은 UI 전용 도구는 제외).
export function buildTools(scriptDir: string): ToolDef[] {
  // lib_store.defaultStore 가 스토어 위치 규칙의 한 곳이다. env 는 호출 시점에 읽는다.
  const STORE = () => defaultStore();
  type Kind = "allow" | "deny" | "ask";

  type ImportOpts = { secrets?: object; choices?: object; roots?: Record<string, string>; exclude?: string[] };
  // transfer 의 cmd* 는 JSON 인자와 쉼표 목록을 CLI 문자열 그대로 받는다(파싱 오류 문서까지 같게 하려고).
  const importArgs = (a: ImportOpts): transfer.ImportArgs => ({
    ...(a.secrets && Object.keys(a.secrets).length ? { secrets: JSON.stringify(a.secrets) } : {}),
    ...(a.choices && Object.keys(a.choices).length ? { choices: JSON.stringify(a.choices) } : {}),
    ...(a.roots && Object.keys(a.roots).length ? { roots: JSON.stringify(a.roots) } : {}),
    ...(a.exclude?.length ? { exclude: a.exclude.join(",") } : {}),
  });
  const csv = (xs?: string[]) => (xs?.length ? xs.join(",") : undefined);

  // 추적 중인 프로젝트 .claude 디렉토리(전역 기본 추적분 제외). 대시보드가 get_tracked 로 같은
  // 목록을 만들어 넘기던 것을 서버가 스스로 구해, 대화에서 projects 를 몰라도 되게 한다.
  const trackedProjectDirs = async (): Promise<string[]> => {
    try {
      const st = await cas.cmdStatus({}) as Record<string, any>;
      const defaults = new Set<string>(st.defaults || []);
      const out: string[] = [];
      for (const k of ["modified", "new", "unchanged"]) {
        for (const p of st[k] || []) {
          if (defaults.has(p)) continue;
          const d = path.dirname(p);
          if (path.basename(d).toLowerCase() === ".claude" && !out.includes(d)) out.push(d);
        }
      }
      return out;
    } catch { return []; }
  };

  // 편집 도구가 project(이름 또는 경로)만 받아도 되게 .claude 디렉토리로 푼다. 후보는 추적 중인
  // 프로젝트와 ~/.claude.json 의 projects. 이름은 폴더 마지막 세그먼트를 대소문자 무시로 맞춘다.
  const resolveProject = async (ref: string): Promise<{ dir?: string; code?: string; error?: string; candidates?: string[] }> => {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const dirs = new Set<string>(await trackedProjectDirs());
    try {
      const pj = await claudeConfig.cmdProjects({}) as Record<string, any>;
      for (const p of pj.projects || []) if (p.has_claude) dirs.add(p.claude_dir);
    } catch { /* projects 목록이 없어도 추적분만으로 푼다 */ }
    const all = [...dirs];
    const r = norm(ref);
    const byPath = all.filter((d) => norm(d) === r || norm(d) === r + "/.claude");
    if (byPath.length) return { dir: byPath[0] };
    const byName = all.filter((d) => path.basename(path.dirname(d)).toLowerCase() === r);
    if (byName.length === 1) return { dir: byName[0] };
    if (byName.length > 1) return { code: "ambiguous", error: `Project name '${ref}' matches more than one project. Specify it by path`, candidates: byName };
    return { code: "project_not_found", error: `Project '${ref}' was not found (only tracked projects and projects listed in ~/.claude.json can be used)`, candidates: all };
  };

  // 마지막 편집 도구 호출 표식. 파일에 두는 이유: Desktop 위젯과 대화 중인 Claude 가 서로 다른
  // 서버 프로세스를 쓸 수 있어(Cowork 별도 인스턴스 등) 메모리 카운터로는 서로를 못 본다.
  const CHANGE_FILE = () => path.join(STORE(), "changes.json");
  const readChange = async (): Promise<{ seq: number; tool?: string; at?: string }> => {
    try { return JSON.parse(await fs.readFile(CHANGE_FILE(), "utf-8")); } catch { return { seq: 0 }; }
  };
  const bumpChange = async (tool: string): Promise<void> => {
    try {
      const prev = await readChange();
      await fs.mkdir(STORE(), { recursive: true });
      await fs.writeFile(CHANGE_FILE(), JSON.stringify({ seq: Math.max(Date.now(), prev.seq + 1), tool, at: new Date().toISOString() }));
    } catch { /* 표식 실패는 편집 결과를 바꾸지 않는다 */ }
  };

  // project 인자를 받는 편집 도구와, 풀린 .claude 디렉토리를 채워 넣을 필드.
  const PROJECT_FIELDS: Record<string, [string, string]> = {
    config_perm_add: ["settings", "settings.json"], config_perm_remove: ["settings", "settings.json"],
    config_hook_add: ["settings", "settings.json"], config_hook_remove: ["settings", "settings.json"],
    config_outputstyle_set: ["settings", "settings.json"], config_plugin_toggle: ["settings", "settings.json"],
    skill_scaffold: ["skillsDir", "skills"], config_skill_remove: ["skillsDir", "skills"],
    config_agent_add: ["agentsDir", "agents"], config_agent_remove: ["agentsDir", "agents"],
    config_item_add: ["dir", "*item"], config_item_remove: ["dir", "*item"],
  };
  const ITEM_DIRS: Record<string, string> = { rule: "rules", "output-style": "output-styles", workflow: "workflows" };
  // set_prefs 는 화면 옵션이라 다른 위젯을 다시 그릴 이유가 없다 - 보던 자리 저장이 매 클릭마다 전체 refresh 를 부르면 안 된다.
  const NO_SIGNAL = new Set(["open_in_browser", "watcher_start", "watcher_stop", "set_prefs"]);

  // 두 가지 공통 처리를 도구 정의 밖에서 한 번에 건다:
  //  1) project -> 경로 해석(PROJECT_FIELDS 에 있는 도구만; 명시한 경로 인자가 있으면 그것이 우선)
  //  2) 읽기 전용이 아닌 도구가 성공하면 변경 표식을 올려 열려 있는 대시보드가 다시 그리게 한다.
  const decorate = (d: ToolDef): ToolDef => {
    const pf = PROJECT_FIELDS[d.name];
    const meta = pf ? {
      ...d.meta,
      inputSchema: d.meta.inputSchema.extend({
        project: z.string().optional().describe("Target project (folder name or path). When given, the tool acts on that project's .claude and fills the path argument for you. Omit for the global config"),
      }),
    } : d.meta;
    const run = async (a: any) => {
      if (pf && a?.project) {
        const [field, sub] = pf;
        const r = await resolveProject(String(a.project));
        if (!r.dir) return docResult({ ok: false, code: r.code, message: r.error, target: String(a.project), candidates: r.candidates });
        const subdir = sub === "*item" ? (ITEM_DIRS[a.itemKind] || a.itemKind) : sub;
        a = { ...a, [field]: a[field] || path.join(r.dir, subdir) };
        delete a.project;
      }
      const res = await d.run(a);
      if (!d.meta.annotations.readOnlyHint && !NO_SIGNAL.has(d.name)) {
        const sc = res.structuredContent as any;
        if (sc?.ok === true && sc.code === "ok") await bumpChange(d.name);
      }
      return res;
    };
    return { ...d, meta, run };
  };

  const defs: ToolDef[] = [
    // ----- 읽기 -----
    {
      name: "get_config",
      meta: {
        title: "Get Claude Config",
        description: "Details of Claude config items, one card per item. In a conversation, call summarize_config first for the overview, then narrow here with sections/scope/query and request compact=true; the full dump exceeds 200KB. " +
          "Each card's edit field holds the path an edit tool takes (settings/skillsDir/dir, etc.). When projects is omitted, tracked projects are included automatically",
        inputSchema: z.object({
          projects: z.array(z.string()).optional().describe("Project .claude directories. Omit for all tracked projects"),
          sections: z.array(z.string()).optional().describe("Section ids (e.g. hooks, perm, skills, agents, mcp-desktop, claude-json, plugins). Same ids as summarize_config"),
          scope: z.enum(["global", "project"]).optional().describe("global = only global items (~/.claude and Desktop), project = only project .claude items"),
          query: z.string().optional().describe("Substring match on names and values (case-insensitive)"),
          compact: z.boolean().optional().describe("true shrinks each card to name, badge, scope, edit and a short description. Turn it on by default in conversations"),
          includeMissing: z.boolean().optional().describe("true also includes .claude.json project cards whose path has no .claude folder"),
        }), annotations: READ,
      },
      run: async (a: { projects?: string[]; sections?: string[]; scope?: "global" | "project"; query?: string; compact?: boolean; includeMissing?: boolean }) => {
        const projects = a.projects ?? await trackedProjectDirs();
        return runCore("get_config", () => claudeConfig.cmdDump({
          projects: projects.length ? projects : null,
          sections: a.sections?.length ? a.sections : null,
          scope: a.scope || null, query: a.query || null,
          compact: !!a.compact, includeMissing: !!a.includeMissing,
        }));
      },
    },
    {
      name: "summarize_config",
      meta: {
        title: "Summarize Claude Config",
        description: "Overview of the current Claude config: per-section count, load class (eager/lazy/never), global/project split and names; global-vs-project name collisions (which side applies); plugin state distribution. " +
          "Call this first when analysing or cleaning up the config or discussing which items to remove, then drill into specific items with get_config(sections=[...], compact=true). It summarizes state only and does not return file contents",
        inputSchema: z.object({
          projects: z.array(z.string()).optional().describe("Project .claude directories. Omit for all tracked projects"),
        }), annotations: READ,
      },
      run: async (a: { projects?: string[] }) => {
        const projects = a.projects ?? await trackedProjectDirs();
        return runCore("summarize_config", () => claudeConfig.cmdSummary({ projects: projects.length ? projects : null }));
      },
    },
    {
      name: "get_prefs",
      meta: {
        title: "Get Dashboard Preferences",
        description: "[UI only] Dashboard display preferences as JSON (section preset, hidden list, empty-section handling). These are screen options unrelated to the config contents",
        inputSchema: z.object({}), annotations: READ,
      },
      run: async () => runCore("get_prefs", () => prefs.cmdGet({ store: STORE() })),
    },
    {
      name: "set_prefs",
      meta: {
        title: "Set Dashboard Preferences",
        description: "[UI only] Save dashboard display preferences. If the store is not initialized, returns ok:false with the reason (it never reports success silently)",
        inputSchema: z.object({
          sections: z.object({
            preset: z.enum(["all", "common", "custom"]).optional(),
            hidden: z.array(z.string()).optional(),
            hideEmpty: z.boolean().optional(),
            includeMissingProjects: z.boolean().optional(),
            groupsCollapsed: z.array(z.string()).optional(),
          }).optional().describe("Send only the keys to overwrite"),
          view: z.object({
            selectedPath: z.string().optional(),
            detailOpen: z.boolean().optional(),
            scope: z.string().optional(),
            libTarget: z.string().optional(),
          }).optional().describe("Where the user was (selected file, panel, filter). Restored when the widget is loaded again"),
        }), annotations: WRITE,
      },
      run: async (a: { sections?: Record<string, unknown>; view?: Record<string, unknown> }) =>
        runCore("set_prefs", () => prefs.cmdSet({ store: STORE(), json: JSON.stringify({ sections: a.sections || {}, view: a.view || {} }) })),
    },
    {
      name: "get_tracked",
      meta: {
        title: "Get Tracked File Status",
        description: "Change state of snapshot-tracked files (new/modified/deleted/unchanged), watcher state, and the last edit tool call (change.seq). Use it to see which config files changed since the snapshot",
        inputSchema: z.object({
          phase: z.enum(["boot", "refresh", "poll"]).optional().describe("[UI only] Why the widget is calling. Logged to widget.log in the store"),
          instance: z.string().optional().describe("[UI only] Widget instance id"),
        }), annotations: READ,
      },
      run: async (a: { phase?: string; instance?: string }) => {
        // 호스트가 위젯을 몇 번 다시 올리는지, 동시에 몇 개가 살아 있는지는 서버 밖에서 알 길이 없다.
        // 폴링은 양이 많아 남기지 않고, 부트·전체 refresh 만 한 줄씩 적는다.
        if (a?.phase && a.phase !== "poll") {
          const line = `${new Date().toISOString()} ${a.phase} ${a.instance || "-"}\n`;
          await fs.mkdir(STORE(), { recursive: true }).then(() => fs.appendFile(path.join(STORE(), "widget.log"), line)).catch(() => {});
        }
        // 대시보드 폴링이 이 한 호출로 다른 클라이언트의 편집까지 알아야 한다.
        return runCore("get_tracked", async () => {
          const st = await cas.cmdStatus({});
          st.change = await readChange();
          return st;
        });
      },
    },
    {
      name: "config_track",
      meta: {
        title: "Track Config Path",
        description: "Add a config file or folder to snapshot tracking (watch only). Given a project folder or .claude, it detects " +
          "settings.json and settings.local.json automatically; given a file path, it tracks only that file. Does not edit anything",
        inputSchema: z.object({
          path: z.string().describe("Absolute path of a project folder, a .claude folder or a config file"),
        }), annotations: WRITE,
      },
      run: async (a: { path: string }) => runCore("config_track", () => cas.cmdTrack({ paths: [a.path] })),
    },
    {
      name: "config_untrack",
      meta: {
        title: "Untrack Config Path",
        description: "Remove a file from the tracking list (the file itself is left as is). Used to remove a project tracking row",
        inputSchema: z.object({
          path: z.string().describe("Absolute path of the tracked file (the path shown on the row)"),
        }), annotations: WRITE,
      },
      run: async (a: { path: string }) => runCore("config_untrack", () => cas.cmdUntrack({ paths: [a.path] })),
    },
    {
      name: "list_projects",
      meta: {
        title: "List Claude Code Projects",
        description: "Return the projects in .claude.json as {projects:[{path, name, claude_dir, has_claude}]}. By default only projects with a .claude folder; includeMissing=true also returns paths without one. Paths under the system temp folder and the Claude Desktop workspace (scratch-workspaces) are always excluded. The UI uses it for one-click track/install target candidates",
        inputSchema: z.object({
          includeMissing: z.boolean().optional().describe("true also includes project paths that have no .claude folder"),
        }), annotations: READ,
      },
      run: async (a: { includeMissing?: boolean }) =>
        runCore("list_projects", () => claudeConfig.cmdProjects({ includeMissing: !!a.includeMissing })),
    },
    {
      name: "get_file_history",
      meta: {
        title: "Get File History",
        description: "Snapshot revision history of one file (git log style). Keeps only snapshots where the content changed; for files with an ignored-keys profile, revisions that differ only in ignored keys are folded",
        inputSchema: z.object({ path: z.string().describe("Absolute path of the tracked file") }), annotations: READ,
      },
      run: async (a: { path: string }) => runCore("get_file_history", () => cas.cmdHistory({ path: a.path })),
    },
    {
      name: "get_file_content",
      meta: {
        title: "Get Current File Content",
        description: "Return the current content of a tracked config file as is (read-only viewer). Paths outside the tracking list are refused",
        inputSchema: z.object({ path: z.string().describe("Absolute path of the tracked file") }), annotations: READ,
      },
      run: async (a: { path: string }) => runCore("get_file_content", () => cas.cmdCat({ path: a.path })),
    },
    {
      name: "get_diff",
      meta: {
        title: "Get File Diff",
        description: "Unified diff between two revisions of a file (or a snapshot vs the current file). For files with an ignored-keys profile, the diff leaves out ignored keys and carries a footnote when ignored-list items also changed (raw=true gives the original). Without from/to, compares the latest snapshot with the working file",
        inputSchema: z.object({
          path: z.string(),
          from: z.string().optional().describe("Snapshot id (omit for the latest snapshot)"),
          to: z.string().optional().describe("Snapshot id or 'work' (default = the current file)"),
          raw: z.boolean().optional().describe("true gives the original diff without applying the ignored-keys profile"),
        }), annotations: READ,
      },
      run: async (a: { path: string; from?: string; to?: string; raw?: boolean }) =>
        runCore("get_diff", () => cas.cmdDiff({ path: a.path, from: a.from || undefined, to: a.to || undefined, raw: !!a.raw })),
    },
    {
      name: "snapshot_now",
      meta: {
        title: "Snapshot Now",
        description: "Create one snapshot of the current state of the tracked files",
        inputSchema: z.object({ message: z.string().optional() }), annotations: WRITE,
      },
      run: async (a: { message?: string }) => runCore("snapshot_now", () => cas.cmdSnapshot({ message: a.message || "manual" })),
    },
    {
      name: "snapshot_gc",
      meta: {
        title: "Snapshot GC",
        description: "Delete snapshots older than the retention period (default 90 days) and unreferenced objects. dryRun=true only computes and deletes nothing. The latest snapshot and objects referenced by the current index are always kept",
        inputSchema: z.object({
          keepDays: z.number().optional().describe("Retention in days (default 90)"),
          dryRun: z.boolean().optional().describe("true only computes what would be deleted"),
        }), annotations: WRITE,
      },
      run: async (a: { keepDays?: number; dryRun?: boolean }) =>
        runCore("snapshot_gc", () => cas.cmdGc({ keepDays: a.keepDays ?? 90, dryRun: !!a.dryRun })),
    },
    {
      name: "config_restore",
      meta: {
        title: "Restore File From Snapshot",
        description: "Restore a tracked file to a given snapshot version. Before restoring, the current state is snapshotted (as a rollback point) and backed up to .bak",
        inputSchema: z.object({
          path: z.string().describe("Absolute path of the tracked file to restore"),
          from: z.string().describe("Snapshot id to restore from"),
        }), annotations: EDIT,
      },
      run: async (a: { path: string; from: string }) =>
        runCore("config_restore", () => cas.cmdRestore({ path: a.path, from: a.from })),
    },
    {
      name: "config_export",
      meta: {
        title: "Export Config Bundle",
        description: "Build a bundle of the config to move to another PC (a zip if out ends in .cmbundle, otherwise a folder). Sources are only read. " +
          "The result's report lists per-item counts and the external paths the bundle could not include (MCP executables, hook scripts, plugin folders, libraries). " +
          "By default secret values are left out and only placeholders remain. dryRun=true writes no bundle and only returns the lists",
        inputSchema: z.object({
          out: z.string().optional().describe("Bundle path (required unless dryRun; refused if it already exists)"),
          dryRun: z.boolean().optional().describe("true writes nothing and only reports what would be moved and the external paths"),
          includeSecrets: z.boolean().optional().describe("true puts secret values in plain text into the bundle's secrets.json"),
          withOptional: z.array(z.enum(["local", "memory", "agent-memory"])).optional()
            .describe("Include items excluded by default. local = ~/.claude/settings.local.json, memory = project memory (~/.claude/projects/*/memory), agent-memory = ~/.claude/agent-memory"),
        }), annotations: WRITE,
      },
      run: async (a: { out?: string; dryRun?: boolean; includeSecrets?: boolean; withOptional?: string[] }) => {
        const withOptional = csv(a.withOptional);
        if (a.dryRun) return runCore("config_export", () => transfer.cmdInventory({ store: STORE(), withOptional }));
        // 상대경로는 이 서버 프로세스의 작업 폴더 기준으로 풀려 엉뚱한 곳에 생긴다.
        if (!a.out || !path.isAbsolute(a.out))
          return docResult({ ok: false, code: "invalid_arg", message: "out must be an absolute path", target: "out" });
        const out = a.out;
        return runCore("config_export", () => transfer.cmdExport({ store: STORE(), out, withOptional, includeSecrets: !!a.includeSecrets }));
      },
    },
    {
      name: "config_import_plan",
      meta: {
        title: "Plan Config Import",
        description: "Compare a bundle with this PC item by item. Writes nothing. Item states are new / same / changed (with diff) / blocked (missing secret, etc.) / skipped. " +
          "settings are compared against the merged result, and scalars with different values appear in conflicts by path (default keeps this PC's value). Pass the result's plan_id to config_import_apply. " +
          "A bundle from another PC has different drive and tool folders: roots[] pairs paths that do not exist on this PC (source = library/drive for guessed, user/claude for certain, none for no pair), " +
          "and unresolved[] lists paths with no pair. Hooks that use such a path (hooks[] state=blocked in cc.settings) and MCP servers (code=path_missing) are not written, " +
          "and a change that would overwrite a working server on this PC with a dead path is blocked with code=keep_working. A working server is merged with the bundle value: " +
          "keys only on this PC stay, keys only in the bundle are added, and differing values appear in conflicts (command, args, env.<key>; default keep). To find pairs, explore this PC and save them with config_import_roots, or pass roots and plan again",
        inputSchema: z.object({
          bundle: z.string().optional().describe("Bundle path (.cmbundle zip or folder, absolute path)"),
          syncFrom: z.string().optional().describe("Another PC (profile) in the sync folder, instead of bundle. Apply with config_sync_pull"),
          secrets: z.record(z.record(z.string())).optional().describe('Placeholder values {"<item id>": {"<path>": "<value>"}}'),
          choices: z.record(z.union([z.enum(["keep", "take"]), z.record(z.enum(["keep", "take"]))])).optional()
            .describe('Scalar conflict choices {"<item id>": "take"} or {"<item id>": {"<path>": "take"}}. Default keep'),
          roots: z.record(z.string()).optional()
            .describe('Path pairs {"<bundle-side root>": "<absolute folder path on this PC>"}. "" leaves that root unmatched. Omit to use saved pairs and guesses'),
          exclude: z.array(z.string()).optional().describe("Hook ids not to import (hooks[].id of cc.settings in the plan result)"),
        }), annotations: READ,
      },
      run: async (a: { bundle?: string; syncFrom?: string } & ImportOpts) =>
        runCore("config_import_plan", () => transfer.cmdPlan({
          store: STORE(), ...(a.syncFrom ? { syncFrom: a.syncFrom } : { bundle: a.bundle ?? "" }), ...importArgs(a),
        })),
    },
    {
      name: "config_import_apply",
      meta: {
        title: "Apply Config Import",
        description: "Apply a config_import_plan result as planned. If the targets on this PC changed after the plan, it is refused with plan_stale. Omit ids to apply all new/changed items. " +
          "Changed files and folders are kept in .trash or .bak, and snapshots are taken before and after. The result's import_id can be passed to config_import_undo",
        inputSchema: z.object({
          bundle: z.string(),
          planId: z.string().describe("plan_id from config_import_plan"),
          ids: z.array(z.string()).optional().describe("Item ids to apply. Omit for all new/changed items"),
          installPlugins: z.boolean().optional().describe("true installs, after applying, enabled marketplace plugins that are missing, via the claude CLI (network, up to 20 minutes)"),
          secrets: z.record(z.record(z.string())).optional(),
          choices: z.record(z.union([z.enum(["keep", "take"]), z.record(z.enum(["keep", "take"]))])).optional(),
          roots: z.record(z.string()).optional()
            .describe('Path pairs {"<bundle-side root>": "<absolute folder path on this PC>"}. "" leaves that root unmatched. Omit to use saved pairs and guesses'),
          exclude: z.array(z.string()).optional().describe("Hook ids not to import (hooks[].id of cc.settings in the plan result)"),
        }), annotations: EDIT,
      },
      run: async (a: { bundle: string; planId: string; ids?: string[]; installPlugins?: boolean } & ImportOpts) =>
        runCore("config_import_apply", () => transfer.cmdApply({
          store: STORE(), bundle: a.bundle, planId: a.planId, ...importArgs(a), ids: csv(a.ids), installPlugins: !!a.installPlugins,
        })),
    },
    {
      name: "config_import_roots",
      meta: {
        title: "Save Import Path Roots",
        description: "Check and save path pairs for importing. Config files are not changed; the next config_import_plan uses these pairs (the user compares and applies again in the import screen). " +
          "from is roots[].from from the plan result or a parent folder of unresolved[].source_path; to is a folder that actually exists on this PC. " +
          "If the bundle has no missing path under that root, to does not exist, or the pair resolves no path at all, that pair is not saved and the reason is returned",
        inputSchema: z.object({
          bundle: z.string().optional().describe("Bundle path (.cmbundle zip or folder, absolute path)"),
          syncFrom: z.string().optional().describe("Another PC (profile) in the sync folder, instead of bundle"),
          roots: z.record(z.string()).describe('{"<bundle-side root>": "<absolute folder path on this PC>"}'),
        }), annotations: WRITE,
      },
      run: async (a: { bundle?: string; syncFrom?: string; roots: Record<string, string> }) =>
        runCore("config_import_roots", () => transfer.cmdRoots({
          store: STORE(), ...(a.syncFrom ? { syncFrom: a.syncFrom } : { bundle: a.bundle ?? "" }), roots: JSON.stringify(a.roots),
        })),
    },
    {
      name: "config_import_undo",
      meta: {
        title: "Undo Config Import",
        description: "Undo one import (restores the originals from .trash and .bak; in .claude.json only those server keys are reverted). " +
          "Items changed after the import are skipped and reported in failed as changed_since_import. force=true reverts them anyway",
        inputSchema: z.object({
          importId: z.string().describe("id from a config_import_apply result or from config_import_history"),
          force: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { importId: string; force?: boolean }) =>
        runCore("config_import_undo", () => transfer.cmdUndo({ store: STORE(), importId: a.importId, force: !!a.force })),
    },
    {
      name: "config_sync_setup",
      meta: {
        title: "Set Sync Folder",
        description: "Set the shared folder used to sync between PCs (OneDrive, Syncthing, a git working folder) and this PC's name (profile; defaults to the host name). " +
          "Each PC writes a folder bundle to <dir>/<profile>/. config-monitor does not run git commands",
        inputSchema: z.object({ dir: z.string().describe("Absolute path of the shared folder (must already exist)"), profile: z.string().optional() }),
        annotations: WRITE,
      },
      run: async (a: { dir: string; profile?: string }) =>
        runCore("config_sync_setup", () => transfer.cmdSyncSetup({ store: STORE(), dir: a.dir, profile: a.profile || undefined })),
    },
    {
      name: "config_sync_status",
      meta: {
        title: "Sync Status",
        description: "Without from, lists the PCs in the sync folder. With from, compares item by item with that PC: in-sync / local-ahead (only this PC changed) / " +
          "remote-ahead (only the other PC changed) / diverged (both changed) / untracked (no agreed baseline)",
        inputSchema: z.object({ from: z.string().optional() }), annotations: READ,
      },
      run: async (a: { from?: string }) =>
        runCore("config_sync_status", () => transfer.cmdSyncStatus({ store: STORE(), syncFrom: a.from || undefined })),
    },
    {
      name: "config_sync_push",
      meta: {
        title: "Sync Push",
        description: "Write this PC's config as a folder bundle to <profile>/ in the sync folder (replacing the previous one). By default secrets are left out and only placeholders remain",
        inputSchema: z.object({
          includeSecrets: z.boolean().optional(),
          withOptional: z.array(z.enum(["local", "memory", "agent-memory"])).optional(),
        }), annotations: WRITE,
      },
      run: async (a: { includeSecrets?: boolean; withOptional?: string[] }) =>
        runCore("config_sync_push", () => transfer.cmdSyncPush({ store: STORE(), includeSecrets: !!a.includeSecrets, withOptional: csv(a.withOptional) })),
    },
    {
      name: "config_sync_pull",
      meta: {
        title: "Sync Pull",
        description: "Import another PC from the sync folder. Get a plan_id first with config_import_plan(syncFrom). Behaves like config_import_apply, and " +
          "when done, sets the baseline of imported items and items whose content now matches to that PC (can be reverted with config_import_undo)",
        inputSchema: z.object({
          from: z.string(),
          planId: z.string(),
          ids: z.array(z.string()).optional(),
          installPlugins: z.boolean().optional(),
          secrets: z.record(z.record(z.string())).optional(),
          choices: z.record(z.union([z.enum(["keep", "take"]), z.record(z.enum(["keep", "take"]))])).optional(),
          roots: z.record(z.string()).optional()
            .describe('Path pairs {"<bundle-side root>": "<absolute folder path on this PC>"}. "" leaves that root unmatched. Omit to use saved pairs and guesses'),
          exclude: z.array(z.string()).optional().describe("Hook ids not to import (hooks[].id of cc.settings in the plan result)"),
        }), annotations: EDIT,
      },
      run: async (a: { from: string; planId: string; ids?: string[]; installPlugins?: boolean } & ImportOpts) =>
        runCore("config_sync_pull", () => transfer.cmdSyncPull({
          store: STORE(), syncFrom: a.from, planId: a.planId, ...importArgs(a), ids: csv(a.ids), installPlugins: !!a.installPlugins,
        })),
    },
    {
      name: "config_import_history",
      meta: {
        title: "Import / Export History",
        description: "Record of imports (imports, including ids that can be undone) and exports (exports, bundle paths). Most recent first",
        inputSchema: z.object({}), annotations: READ,
      },
      run: async () => runCore("config_import_history", () => transfer.cmdHistory({ store: STORE() })),
    },

    // ----- watcher 제어 -----
    {
      name: "watcher_status",
      meta: {
        title: "Watcher Status",
        description: "Whether the resident watcher (polling auto-snapshot) is running, and its heartbeat",
        inputSchema: z.object({}), annotations: READ,
      },
      run: async () => runCore("watcher_status", () => cas.cmdWatcherStatus({})),
    },
    {
      name: "watcher_start",
      meta: {
        title: "Start Watcher",
        description: "Start the watcher in the background as a separate Node process (auto-snapshot when a tracked file changes). No-op if it is already running",
        inputSchema: z.object({}), annotations: WRITE,
      },
      run: async () => {
        const store = STORE();
        const cur = await cas.cmdWatcherStatus({ store }) as Record<string, any>;
        if (cur.running) return docResult({ ok: true, code: "noop", message: "Already running", pid: cur.pid, changed: false });
        // 좀비/중복 watcher 정리(상태 신뢰성과 무관하게 단일 인스턴스 보장) 후 새로 기동.
        await killWatchers();
        await fs.rm(path.join(store, "watcher.json"), { force: true }).catch(() => {});
        // 서버가 끝나도 watcher 는 남아야 하므로 분리해 띄운다. stdin 은 MCP 채널이라 물려주지 않는다.
        spawn(process.execPath, entryArgs(scriptDir, WATCHER_FLAG, "--store", store), {
          cwd: scriptDir, detached: true, stdio: "ignore", windowsHide: true,
        }).unref();
        // heartbeat 가 쓰일 때까지 폴링(최대 ~5.6s) 후 실제 상태를 반환(허위 ok 방지).
        let st: Record<string, any> = {};
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 700));
          st = await cas.cmdWatcherStatus({ store });
          if (st.running) break;
        }
        return docResult({
          ok: !!st.running, code: st.running ? "ok" : "watcher_start_failed",
          message: st.running ? "Watcher started" : "Watcher failed to start (watcher.json was not updated; check permissions and PATH)",
          pid: st.pid, changed: true,
        });
      },
    },
    {
      name: "watcher_stop",
      meta: {
        title: "Stop Watcher",
        description: "Stop all running watcher processes of this installation (matched by the command line). Windows only",
        inputSchema: z.object({}), annotations: WRITE,
      },
      run: async () => {
        // pid 하나가 아니라 모든 watcher 를 종료(좀비 누적 정리).
        await killWatchers();
        await fs.rm(path.join(STORE(), "watcher.json"), { force: true }).catch(() => {});
        return docResult({ ok: true, code: "ok", message: "Watcher stopped", changed: true });
      },
    },

    // ----- 편집 (스냅샷-선행 + .bak) -----
    {
      name: "config_perm_add",
      meta: {
        title: "Add Permission Rule",
        description: "Add a rule to permissions.<allow|deny|ask> in settings.json (snapshot and backup before editing). With settings, that file is the target (project settings)",
        inputSchema: z.object({ kind: z.enum(["allow", "deny", "ask"]), rule: z.string(), settings: z.string().optional() }), annotations: EDIT,
      },
      run: async (a: { kind: Kind; rule: string; settings?: string }) =>
        runCore("config_perm_add", () => configEdit.cmdPermAdd({ settings: a.settings || undefined, kind: a.kind, rule: a.rule })),
    },
    {
      name: "config_perm_remove",
      meta: {
        title: "Remove Permission Rule",
        description: "Remove a rule from permissions in settings.json. With settings, that file is the target (project settings)",
        inputSchema: z.object({ kind: z.enum(["allow", "deny", "ask"]), rule: z.string(), settings: z.string().optional() }), annotations: EDIT,
      },
      run: async (a: { kind: Kind; rule: string; settings?: string }) =>
        runCore("config_perm_remove", () => configEdit.cmdPermRemove({ settings: a.settings || undefined, kind: a.kind, rule: a.rule })),
    },
    {
      name: "config_hook_add",
      meta: {
        title: "Add Hook",
        description: "Add a command hook to hooks.<event> in settings.json. With settings, that file is the target (project settings)",
        inputSchema: z.object({ event: z.string(), command: z.string(), matcher: z.string().optional(), settings: z.string().optional() }), annotations: EDIT,
      },
      run: async (a: { event: string; command: string; matcher?: string; settings?: string }) =>
        runCore("config_hook_add", () => configEdit.cmdHookAdd({
          settings: a.settings || undefined, event: a.event, command: a.command, matcher: a.matcher || null,
        })),
    },
    {
      name: "config_hook_remove",
      meta: {
        title: "Remove Hook",
        description: "Remove entries from hooks.<event> in settings.json whose command contains needle as a substring. With settings, that file is the target (project settings)",
        inputSchema: z.object({ event: z.string(), needle: z.string(), settings: z.string().optional() }), annotations: EDIT,
      },
      run: async (a: { event: string; needle: string; settings?: string }) =>
        runCore("config_hook_remove", () => configEdit.cmdHookRemove({ settings: a.settings || undefined, event: a.event, needle: a.needle })),
    },
    {
      name: "config_plugin_toggle",
      meta: {
        title: "Toggle Claude Code Plugin",
        description: "Turn enabledPlugins[<id>] in settings.json on or off, and nothing else. **Takes effect from the next session**, because Claude Code reads it at session start. id is '<plugin name>@<marketplace name>' and comes from the **marketplace manifest entry name** (it can differ from plugin.json's name or display namespace: observed notion vs 'Notion'). Pass the Plugins card's edit.id unchanged; changing the case makes it a different key. For settings, pass the file that set the value (the card's edit.settings). Does not install or remove plugins (that is `claude plugin`'s job)",
        inputSchema: z.object({
          id: z.string().describe("plugin@marketplace, the Plugins card's edit.id verbatim"),
          on: z.boolean(),
          settings: z.string().optional().describe("Target settings.json (the card's edit.settings). Omit for global"),
        }), annotations: EDIT,
      },
      run: async (a: { id: string; on: boolean; settings?: string }) =>
        runCore("config_plugin_toggle", () => configEdit.cmdPluginToggle({ settings: a.settings || undefined, id: a.id, state: a.on ? "on" : "off" })),
    },
    {
      name: "skill_scaffold",
      meta: {
        title: "Scaffold Code Skill",
        description: "Create a skill: <skills>/<name>/SKILL.md. With content, installs it as given; otherwise writes a stub from desc. Default ~/.claude/skills; use skillsDir or project to target a project",
        inputSchema: z.object({
          name: z.string(), desc: z.string().optional(),
          content: z.string().optional().describe("Full SKILL.md content (including frontmatter). When given, installed as is instead of a stub"),
          skillsDir: z.string().optional().describe("Target skills directory (<project>/.claude/skills). Omit for global"),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; desc?: string; content?: string; skillsDir?: string }) =>
        runCore("skill_scaffold", () => configEdit.cmdSkillScaffold({
          skillsDir: a.skillsDir || undefined, name: a.name, desc: a.desc || undefined, content: a.content || null,
        })),
    },
    {
      name: "config_skill_remove",
      meta: {
        title: "Remove Code Skill",
        description: "Move a skill directory to .trash (recoverable). Snapshot before editing. " +
          "With skillsDir, that directory is the target (project-local skills); otherwise ~/.claude/skills",
        inputSchema: z.object({
          name: z.string(),
          skillsDir: z.string().optional().describe("Target skills directory (<project>/.claude/skills). Omit for global ~/.claude/skills"),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; skillsDir?: string }) =>
        runCore("config_skill_remove", () => configEdit.cmdSkillRemove({ skillsDir: a.skillsDir || undefined, name: a.name })),
    },
    {
      name: "config_agent_add",
      meta: {
        title: "Scaffold Agent",
        description: "Create an agent: <agents>/<name>.md. content installs a full definition (including frontmatter); otherwise scaffolds from desc/tools/model. Default ~/.claude/agents; use agentsDir or project to target a project",
        inputSchema: z.object({
          name: z.string(), desc: z.string().optional(),
          tools: z.string().optional(), model: z.string().optional(),
          content: z.string().optional().describe("Full agent md content (including frontmatter). When given, desc/tools/model are ignored"),
          agentsDir: z.string().optional().describe("Target agents directory (<project>/.claude/agents). Omit for global"),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; desc?: string; tools?: string; model?: string; content?: string; agentsDir?: string }) =>
        runCore("config_agent_add", () => configEdit.cmdAgentScaffold({
          agentsDir: a.agentsDir || undefined, name: a.name, desc: a.desc || undefined,
          tools: a.tools || undefined, model: a.model || undefined, content: a.content || null,
        })),
    },
    {
      name: "config_agent_remove",
      meta: {
        title: "Remove Agent",
        description: "Move agent <name> (.md) to .trash (recoverable). Snapshot before editing. " +
          "With agentsDir, that directory is the target (project-local agents); otherwise ~/.claude/agents",
        inputSchema: z.object({
          name: z.string(),
          agentsDir: z.string().optional().describe("Target agents directory (<project>/.claude/agents). Omit for global ~/.claude/agents"),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; agentsDir?: string }) =>
        runCore("config_agent_remove", () => configEdit.cmdAgentRemove({ agentsDir: a.agentsDir || undefined, name: a.name })),
    },
    {
      name: "config_item_add",
      meta: {
        title: "Scaffold Rule / Output Style / Workflow",
        description: "Create a stub for a single-file item (rule/output-style/workflow). Giving a rule paths makes it load LAZY instead of EAGER",
        inputSchema: z.object({
          itemKind: z.enum(["rule", "output-style", "workflow"]),
          name: z.string().describe("Single-segment name (no path separators)"),
          desc: z.string().optional(),
          paths: z.string().optional().describe("rule only. When given, the rule loads only when a matching file is read (LAZY)"),
          dir: z.string().optional().describe("Project target directory (<...>/.claude/<sub>). Omit for global"),
        }), annotations: WRITE,
      },
      run: async (a: { itemKind: configEdit.ItemKind; name: string; desc?: string; paths?: string; dir?: string }) =>
        runCore("config_item_add", () => configEdit.cmdItemScaffold({
          itemsDir: a.dir || null, kind: a.itemKind, name: a.name, desc: a.desc || undefined, paths: a.paths || undefined,
        })),
    },
    {
      name: "config_item_remove",
      meta: {
        title: "Remove Rule / Output Style / Workflow",
        description: "Move a single-file item to .trash (recoverable). With dir, removes it only from that project",
        inputSchema: z.object({
          itemKind: z.enum(["rule", "output-style", "workflow"]),
          name: z.string(),
          dir: z.string().optional().describe("Project target directory. Omit for global"),
        }), annotations: EDIT,
      },
      run: async (a: { itemKind: configEdit.ItemKind; name: string; dir?: string }) =>
        runCore("config_item_remove", () => configEdit.cmdItemRemove({ itemsDir: a.dir || null, kind: a.itemKind, name: a.name })),
    },
    {
      name: "config_outputstyle_set",
      meta: {
        title: "Activate Output Style",
        description: "Set outputStyle in settings (an empty name clears it). This switch decides which style is loaded at session start",
        inputSchema: z.object({
          name: z.string().describe("Name of the style to activate. An empty string clears the selection"),
          settings: z.string().optional().describe("Project settings.json path. Omit for global"),
        }), annotations: WRITE,
      },
      run: async (a: { name: string; settings?: string }) =>
        runCore("config_outputstyle_set", () => configEdit.cmdOutputstyleSet({ settings: a.settings || undefined, name: a.name })),
    },
    {
      name: "config_memory_remove",
      meta: {
        title: "Remove Memory Topic",
        description: "Move a project memory topic file to .trash (recoverable). The MEMORY.md index is not a target",
        inputSchema: z.object({
          name: z.string().describe("Topic name (without extension)"),
          memoryDir: z.string().describe("Path of <...>/projects/<name>/memory"),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; memoryDir: string }) =>
        runCore("config_memory_remove", () => configEdit.cmdMemoryRemove({ memoryDir: a.memoryDir, name: a.name })),
    },
    {
      name: "config_mcp_add",
      meta: {
        title: "Add/Update MCP Server",
        description: "Add or update mcpServers.<name>. scope=user writes ~/.claude.json, scope=desktop writes claude_desktop_config.json (Desktop must be restarted to apply). Snapshot, .bak and atomic write",
        inputSchema: z.object({
          name: z.string(),
          serverJson: z.string().describe('Server config as a JSON string, e.g. {"command":"npx","args":["-y","some-mcp"]}'),
          scope: z.enum(["user", "desktop"]).optional(),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; serverJson: string; scope?: "user" | "desktop" }) =>
        runCore("config_mcp_add", () => configEdit.cmdMcpAdd({ name: a.name, json: a.serverJson, scope: a.scope || "user" })),
    },
    {
      name: "config_mcp_remove",
      meta: {
        title: "Remove MCP Server",
        description: "Remove mcpServers.<name>. scope=user|desktop (desktop requires a restart to apply). Snapshot, .bak and atomic write",
        inputSchema: z.object({ name: z.string(), scope: z.enum(["user", "desktop"]).optional() }), annotations: EDIT,
      },
      run: async (a: { name: string; scope?: "user" | "desktop" }) =>
        runCore("config_mcp_remove", () => configEdit.cmdMcpRemove({ name: a.name, scope: a.scope || "user" })),
    },

    // ----- 라이브러리 토글 (.claude 구조 라이브러리 디렉토리) -----
    {
      name: "library_scan",
      meta: {
        title: "Scan Personal Library",
        description: "List agents/skills/commands in the libraries (locally registered, env, and remote/marketplace caches), compare them by hash with the live config, and return one of four states (not_installed/installed/modified/conflict). Each row carries source (env|registered|remote|market), origin, pinned sha and fetched_at; each item carries origin, and owner on conflict. Each row's units lists tool directories under the library (depth 2) that have hooks/hooks.json or .mcp.json, each with its own origin (local:<path>); pass that origin as is to hooks/mcp-install. **Does not use the network** (works offline). With lib, registers it first and then scans",
        inputSchema: z.object({
          lib: z.string().optional().describe("Library root path (a directory shaped like .claude). For the first-time registration"),
          targetDir: z.string().optional().describe("The .claude root to install into and compare with (default ~/.claude). Set it for a project-local scan"),
        }),
        annotations: READ,
      },
      run: async (a: { lib?: string; targetDir?: string }) =>
        runCore("library_scan", () => library.cmdScan({ target: a.targetDir || undefined, lib: a.lib || null })),
    },
    {
      name: "library_install",
      meta: {
        title: "Install Library Item",
        description: "Install or sync a library item into the target .claude (default ~/.claude; targetDir for project-local). skills can be nested in groups (any depth) and are installed flat under the leaf name (e.g. path=2-stack/java-spring/error-handling -> <target>/skills/error-handling). If the item already exists, it is snapshotted and kept as .bak (file) or .trash (directory) before being overwritten. Refused if targetDir's parent directory does not exist (prevents phantom folders)",
        inputSchema: z.object({
          category: z.enum(["agents", "skills", "commands"]),
          path: z.string().describe("Path relative to the category root. skills may include groups; agents/commands take the name"),
          lib: z.string().optional(),
          origin: z.string().optional().describe("Source identifier (local:/remote:/market:). Required to disambiguate when several caches have the same name"),
          targetDir: z.string().optional().describe("The .claude root to install into (default ~/.claude). Set it for a project-local install"),
        }), annotations: EDIT,
      },
      run: async (a: { category: library.Category; path: string; lib?: string; origin?: string; targetDir?: string }) =>
        runCore("library_install", () => library.cmdInstall({
          target: a.targetDir || undefined, category: a.category, path: a.path, lib: a.lib || null, origin: a.origin || null,
        })),
    },
    {
      name: "library_uninstall",
      meta: {
        title: "Uninstall Library Item",
        description: "Move the item in the target .claude (default ~/.claude; targetDir for project-local) to .trash (recoverable). The library original is not touched. With origin, refused if it differs from the owner in the ledger (an install from another source is not removed)",
        inputSchema: z.object({
          category: z.enum(["agents", "skills", "commands"]),
          name: z.string(),
          origin: z.string().optional().describe("Requesting source. Refused if it differs from the owner in the ledger"),
          targetDir: z.string().optional().describe("The .claude root to remove from (default ~/.claude)"),
        }), annotations: EDIT,
      },
      run: async (a: { category: library.Category; name: string; origin?: string; targetDir?: string }) =>
        runCore("library_uninstall", () => library.cmdUninstall({
          target: a.targetDir || undefined, category: a.category, name: a.name, origin: a.origin || null,
        })),
    },
    {
      name: "library_unregister",
      meta: {
        title: "Unregister Library / Remote / Marketplace",
        description: "Remove a registration. lib = a local path (no cache involved), origin = remote:<id>|market:<id> (its cache is deleted too). Refused if the ledger has hooks/MCP servers that reference that cache, and the blocking entries are reported. Installed items and local library originals are not touched. A path set by env cannot be removed",
        inputSchema: z.object({
          lib: z.string().optional().describe("Local library root path to unregister"),
          origin: z.string().optional().describe("remote:<id> | market:<id>"),
        }),
        annotations: EDIT,
      },
      run: async (a: { lib?: string; origin?: string }) =>
        runCore("library_unregister", () => library.cmdUnregister({ lib: a.lib || null, origin: a.origin || null })),
    },
    {
      name: "library_add",
      meta: {
        title: "Add Remote Library or Marketplace",
        description: "Register a remote source in the config-monitor store. **Uses the network**; library_scan does not, so a scan after registering reads only the cache. " +
          "kind=remote: register any git repo as a library. After cloning, detects the agents/skills/commands layout case-insensitively and persists it in remotes[] of store/config.json. Records a pinned sha; there is no automatic pull. " +
          "kind=market: register a repo that has .claude-plugin/marketplace.json as a catalog. Only the manifest is sparse-checked-out (401K for the official marketplace, 9.7M for a full checkout). Plugins are fetched when selected. There is no official/unofficial distinction; the URL is all there is",
        inputSchema: z.object({
          kind: z.enum(["remote", "market"]).describe("remote = a git repo as a library, market = a marketplace catalog"),
          url: z.string().describe("For remote, a git repo URL (https/ssh/file); for market, the marketplace repo URL. config-monitor does not vet this URL"),
          ref: z.string().optional().describe("Branch or tag. Omit for the default HEAD"),
          id: z.string().optional().describe("Library/marketplace id. Omit to derive it from the repo name in the URL"),
          map: z.string().optional().describe('kind=remote only. Layout mapping JSON, e.g. {"agents":"Agents","skills":"Skills"}. Needed only when detection fails. Refused with kind=market (a marketplace manifest defines the layout)'),
        }), annotations: EDIT,
      },
      run: async (a: { kind: "remote" | "market"; url: string; ref?: string; id?: string; map?: string }) => {
        if (a.kind === "market" && a.map) {
          return docResult({ ok: false, code: "invalid_arg", message: "map can be used only with kind=remote. For a marketplace, the marketplace.json manifest defines the layout" });
        }
        const common = { url: a.url, ref: a.ref || null, id: a.id || null };
        return runCore("library_add", () => a.kind === "market"
          ? library.cmdMarketAdd(common)
          : library.cmdRemoteAdd({ ...common, map: a.map || null }));
      },
    },
    {
      name: "claude_plugin_install",
      meta: {
        title: "Install Plugin into Claude Code",
        description: "Install a plugin **as a whole** into Claude Code by delegating to `claude plugin install <plugin>@<market> --scope`. This is a **different install model** from library_plugin_fetch (which picks individual items and copies them into ~/.claude, with a diff before install, rollback, and Desktop support): here the plugin stays whole in the plugin cache, is injected under the <ns>:<item> namespace, and is turned on and off with config_plugin_toggle. **Uses the network.** Takes effect from the next session. scope=project/local picks the project from cwd, so pass cwd. dryRun shows the command that would run first",
        inputSchema: z.object({
          marketplace: z.string(), plugin: z.string(),
          scope: z.enum(["user", "project", "local"]).optional(),
          cwd: z.string().optional().describe("Base directory for scope=project/local"),
          dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { marketplace: string; plugin: string; scope?: "user" | "project" | "local"; cwd?: string; dryRun?: boolean }) =>
        runCore("claude_plugin_install", () => pluginCli.cmdInstall({
          marketplace: a.marketplace, plugin: a.plugin, scope: a.scope || "user", cwd: a.cwd || undefined, dryRun: !!a.dryRun,
        })),
    },
    {
      name: "claude_plugin_uninstall",
      meta: {
        title: "Uninstall Plugin from Claude Code",
        description: "Delegates to `claude plugin uninstall <plugin>@<market> --scope -y`. Does not touch **items** installed through the Library (a different model; use library_uninstall for those). **To only turn a plugin off, do not uninstall it; use config_plugin_toggle.** keepData keeps ~/.claude/plugins/data/<id>/",
        inputSchema: z.object({
          marketplace: z.string(), plugin: z.string(),
          scope: z.enum(["user", "project", "local"]).optional(),
          keepData: z.boolean().optional(),
          cwd: z.string().optional(), dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { marketplace: string; plugin: string; scope?: "user" | "project" | "local"; keepData?: boolean; cwd?: string; dryRun?: boolean }) =>
        runCore("claude_plugin_uninstall", () => pluginCli.cmdUninstall({
          marketplace: a.marketplace, plugin: a.plugin, scope: a.scope || "user", keepData: !!a.keepData,
          cwd: a.cwd || undefined, dryRun: !!a.dryRun,
        })),
    },
    {
      name: "claude_plugin_update",
      meta: {
        title: "Update Claude Code Plugin",
        description: "Delegates to `claude plugin update <plugin>@<market> --scope`. **Uses the network**. Takes effect from the next session. Only update also accepts managed as a scope. Updating plugins fetched through the Library is unrelated to this; use library_fetch for those (updates the pinned sha, with a diff before install)",
        inputSchema: z.object({
          marketplace: z.string(), plugin: z.string(),
          scope: z.enum(["user", "project", "local", "managed"]).optional(),
          cwd: z.string().optional(), dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { marketplace: string; plugin: string; scope?: "user" | "project" | "local" | "managed"; cwd?: string; dryRun?: boolean }) =>
        runCore("claude_plugin_update", () => pluginCli.cmdUpdate({
          marketplace: a.marketplace, plugin: a.plugin, scope: a.scope || "user", cwd: a.cwd || undefined, dryRun: !!a.dryRun,
        })),
    },
    {
      name: "claude_marketplace_add",
      meta: {
        title: "Register Marketplace in Claude Code",
        description: "Delegates to `claude plugin marketplace add <source> --scope`, registering a marketplace added in the dashboard on the Claude Code side as well (export). source takes four forms: owner/repo, a git URL, a marketplace.json URL, or a local path. **scope=project writes the declaration into the project's .claude/settings.json, which is shared with the team**; set that project with cwd. Registering in config-monitor's own store is library_add(kind=market), which is separate (each keeps its own cache)",
        inputSchema: z.object({
          source: z.string(),
          scope: z.enum(["user", "project", "local"]).optional(),
          sparse: z.array(z.string()).optional().describe("Directories to check out from a monorepo"),
          cwd: z.string().optional(), dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { source: string; scope?: "user" | "project" | "local"; sparse?: string[]; cwd?: string; dryRun?: boolean }) =>
        runCore("claude_marketplace_add", () => pluginCli.cmdMarketAdd({
          source: a.source, scope: a.scope || "user", sparse: a.sparse?.length ? a.sparse : undefined,
          cwd: a.cwd || undefined, dryRun: !!a.dryRun,
        })),
    },
    {
      name: "claude_marketplace_update",
      meta: {
        title: "Update Claude Code Marketplace",
        description: "Delegates to `claude plugin marketplace update [name]`. Without name, updates **all registered marketplaces**. **Uses the network**. Updates only the manifests; installed plugin versions stay as they are (that is claude_plugin_update)",
        inputSchema: z.object({
          name: z.string().optional().describe("Omit for all"),
          cwd: z.string().optional(), dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { name?: string; cwd?: string; dryRun?: boolean }) =>
        runCore("claude_marketplace_update", () => pluginCli.cmdMarketUpdate({ name: a.name || undefined, cwd: a.cwd || undefined, dryRun: !!a.dryRun })),
    },
    {
      name: "claude_marketplace_remove",
      meta: {
        title: "Remove Claude Code Marketplace",
        description: "Delegates to `claude plugin marketplace remove <name>`. **Without scope, removes the declaration from every scope** (claude's default). If plugins installed from that marketplace remain, claude may refuse or warn, so report stderr as is. Unregistering a marketplace from the config-monitor store is library_unregister, which is separate",
        inputSchema: z.object({
          name: z.string(),
          scope: z.enum(["user", "project", "local"]).optional().describe("Omit for all scopes"),
          cwd: z.string().optional(), dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; scope?: "user" | "project" | "local"; cwd?: string; dryRun?: boolean }) =>
        runCore("claude_marketplace_remove", () => pluginCli.cmdMarketRemove({
          name: a.name, scope: a.scope || undefined, cwd: a.cwd || undefined, dryRun: !!a.dryRun,
        })),
    },
    {
      name: "plugin_catalog",
      meta: {
        title: "Plugin Inventory and Token Cost",
        description: "Only reads ~/.claude/plugins/plugin-catalog-cache.json cached by Claude Code, so it **uses neither the network nor a fetch.** That cache covers **only the official marketplace**, so plugins from other marketplaces are not found (this is not an error; in that case the counts are known only after a fetch). " +
          "Without id: a lightweight map to fill the catalog rows, {entries: {id: {installs, components: {kind: count}, total}}}. Component **names are not included** (all 255 would be large); pass id when names are needed. " +
          "With id: returns, **before** install, what that plugin adds and its token cost: components (commands/agents/skills/hooks/mcpServers/lspServers names), unique_installs, tokens (always_on / on_invoke per model), homepage, last_updated",
        inputSchema: z.object({
          id: z.string().optional().describe("<plugin>@<marketplace>. When given, details of that one plugin (including component names); omit for the overall summary (counts only)"),
          cache: z.string().optional(),
        }), annotations: READ,
      },
      run: async (a: { id?: string; cache?: string }) => {
        const cache = a.cache || undefined;
        const id = a.id;
        return runCore("plugin_catalog", () => id ? pluginCatalog.cmdDetails({ id, cache }) : pluginCatalog.cmdSummary({ cache }));
      },
    },
    {
      name: "library_market_discover",
      meta: {
        title: "Discover Marketplaces from Claude Code",
        description: "Read the marketplaces registered in Claude Code (`/plugins`) and compare them with this store. **Does not use the network**: it reads only known_marketplaces.json, and actual registration happens only when the user picks a candidate and triggers library_add(kind=market). new = can be imported / both = registered on both sides (the two tools hold the same repo in separate caches at different points in time, so sha and timestamps are returned side by side) / unusable = cannot be imported because there is no URL",
        inputSchema: z.object({
          pluginsDir: z.string().optional().describe("Default ~/.claude/plugins"),
        }), annotations: READ,
      },
      run: async (a: { pluginsDir?: string }) =>
        runCore("library_market_discover", () => library.cmdMarketDiscover({ pluginsDir: a.pluginsDir || undefined })),
    },
    {
      name: "library_catalog",
      meta: {
        title: "Browse Marketplace Catalog",
        description: "Plugin list of the registered marketplaces (name/description/category/author) and a marketplace summary (marketplaces[]: id/name/url/total). **Does not use the network**: reads only the cached manifests. There is no 'N installable' column (only 4/278 entries declare their components, so it cannot be known before a fetch)",
        inputSchema: z.object({
          marketplace: z.string().optional().describe("When given, only that marketplace; used to page each marketplace separately"),
          query: z.string().optional(),
          category: z.string().optional(),
          limit: z.number().int().optional().describe("A negative value returns only the summary (marketplaces/categories) without rows"),
          offset: z.number().int().optional(),
        }), annotations: READ,
      },
      run: async (a: { marketplace?: string; query?: string; category?: string; limit?: number; offset?: number }) =>
        runCore("library_catalog", () => library.cmdCatalog({
          marketplace: a.marketplace || null, query: a.query || null, category: a.category || null,
          ...(a.limit !== undefined ? { limit: a.limit } : {}), ...(a.offset !== undefined ? { offset: a.offset } : {}),
        })),
    },
    {
      name: "library_plugin_fetch",
      meta: {
        title: "Fetch Marketplace Plugin",
        description: "Materialize one plugin from the catalog and add it to the Library. A bundled plugin extends the marketplace repo's sparse set (+42K); an external one is fetched on its own (~444K). **Uses the network**. Fetched at a pinned sha; the result holds the actual component counts and whether it has hooks/MCP servers",
        inputSchema: z.object({ marketplace: z.string(), plugin: z.string() }), annotations: EDIT,
      },
      run: async (a: { marketplace: string; plugin: string }) =>
        runCore("library_plugin_fetch", () => library.cmdPluginFetch({ marketplace: a.marketplace, plugin: a.plugin })),
    },
    {
      name: "library_fetch",
      meta: {
        title: "Refresh Remote/Marketplace",
        description: "Explicitly refresh a registered remote/market. There is no automatic pull: for hooks, a pull would silently change code that runs every session, so the user has to trigger it. origin format: remote:<id> / market:<id> / market:<id>/<plugin>",
        inputSchema: z.object({ origin: z.string().describe("remote:<id> | market:<id> | market:<id>/<plugin>") }),
        annotations: EDIT,
      },
      run: async (a: { origin: string }) =>
        runCore("library_fetch", () => library.cmdFetch({ origin: a.origin })),
    },
    {
      name: "library_hooks_install",
      meta: {
        title: "Install Plugin Hooks",
        description: "Merge a plugin's hooks/hooks.json into settings.json. ${CLAUDE_PLUGIN_ROOT} is replaced with the absolute cache path, so **the cache must not be deleted** (the hooks run from it). matcher and timeout are kept as is, and existing entries of the same plugin are removed first (idempotent). **Does not use the network**: a plugin that is not materialized is refused and a fetch is required first. Check the substituted command text and interpreter warnings with dryRun first",
        inputSchema: z.object({
          origin: z.string().describe("remote:<id> | market:<id>/<plugin>"),
          settings: z.string().optional().describe("Target settings.json (default <targetDir>/settings.json)"),
          targetDir: z.string().optional(),
          dryRun: z.boolean().optional().describe("Writes nothing and returns only the substituted commands and warnings"),
        }), annotations: EDIT,
      },
      run: async (a: { origin: string; settings?: string; targetDir?: string; dryRun?: boolean }) =>
        runCore("library_hooks_install", () => library.cmdHooksInstall({
          target: a.targetDir || undefined, origin: a.origin, settings: a.settings || null, dryRun: !!a.dryRun,
        })),
    },
    {
      name: "library_hooks_uninstall",
      meta: {
        title: "Uninstall Plugin Hooks",
        description: "Remove this plugin's hook entries from settings.json. The match uses the root recorded in the ledger, so it stays exact after the sha changes. The cache directory is not deleted (other items may reference it)",
        inputSchema: z.object({
          origin: z.string(), settings: z.string().optional(), targetDir: z.string().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { origin: string; settings?: string; targetDir?: string }) =>
        runCore("library_hooks_uninstall", () => library.cmdHooksUninstall({
          target: a.targetDir || undefined, origin: a.origin, settings: a.settings || null,
        })),
    },
    {
      name: "library_mcp_install",
      meta: {
        title: "Install Plugin MCP Servers",
        description: "Install the servers in a plugin's .mcp.json. scope=user writes ~/.claude.json, scope=desktop writes claude_desktop_config.json (Desktop must be restarted). **Claude Desktop has no /plugin marketplace, so this is the only way to add a plugin's MCP servers to Desktop.** ${CLAUDE_PLUGIN_ROOT} is substituted the same way as for hooks. **Does not use the network**: refused if the plugin is not materialized",
        inputSchema: z.object({
          origin: z.string(), server: z.string().optional().describe("Omit for all"),
          scope: z.enum(["user", "desktop"]).optional(), targetDir: z.string().optional(),
          dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { origin: string; server?: string; scope?: "user" | "desktop"; targetDir?: string; dryRun?: boolean }) =>
        runCore("library_mcp_install", () => library.cmdMcpInstall({
          target: a.targetDir || undefined, origin: a.origin, scope: a.scope || "user", server: a.server || null, dryRun: !!a.dryRun,
        })),
    },
    {
      name: "library_mcp_uninstall",
      meta: {
        title: "Uninstall Plugin MCP Servers",
        description: "Remove only the server names recorded in the ledger. A server of the same name that the user added directly is not touched",
        inputSchema: z.object({
          origin: z.string(), server: z.string().optional(),
          scope: z.enum(["user", "desktop"]).optional(), targetDir: z.string().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { origin: string; server?: string; scope?: "user" | "desktop"; targetDir?: string }) =>
        runCore("library_mcp_uninstall", () => library.cmdMcpUninstall({
          target: a.targetDir || undefined, origin: a.origin, scope: a.scope || "user", server: a.server || null,
        })),
    },

    // ----- 브라우저 열기 -----
    {
      name: "open_in_browser",
      meta: {
        title: "Open Live Dashboard in Browser",
        description: "[UI only] Start the live dashboard HTTP server (default port 3002) if needed and open it in the user's default browser. Not for reading or editing config in a conversation",
        inputSchema: z.object({ port: z.number().optional() }), annotations: WRITE,
      },
      run: async (a: { port?: number }) => {
        const port = a.port || Number(process.env.PORT || 3002);
        // 서버가 127.0.0.1 에만 바인딩하므로 주소도 맞춘다. 'localhost' 는 Windows 에서 ::1 로
        // 먼저 해석될 수 있어, IPv4 전용 리스너에 프로브/브라우저가 못 붙는 경우가 생긴다.
        const url = `http://127.0.0.1:${port}/`;
        const log = path.join(STORE(), "dashboard-server.log");
        let up = await fetch(url).then((r) => r.ok).catch(() => false);
        if (!up) {
          // 이 프로세스를 띄운 node 로 같은 진입 파일을 HTTP 모드로 직접 실행한다(npx·cmd·PowerShell 을 거치지 않음).
          // Claude Desktop 은 MCP 서버에 PATHEXT 없는 최소 환경만 넘기는데, 그 환경에서 PowerShell 은
          // PATHEXT=.CPL 을 채워 넣고 자식 cmd 는 npx.cmd 를 못 찾는다("'npx'은(는) ... 아닙니다").
          // 실행 파일 경로를 직접 주면 확장자 탐색 자체가 없어 환경에 좌우되지 않는다.
          // stderr 는 스토어의 로그로 받는다 - 안 뜨는 이유가 어디에도 남지 않던 것이 진단을 막았다.
          let fh: fs.FileHandle | null = null;
          try {
            await fs.mkdir(STORE(), { recursive: true });
            fh = await fs.open(log, "a");
          } catch { /* 로그를 못 열어도 기동은 시도한다 */ }
          const out: number | "ignore" = fh ? fh.fd : "ignore";
          const child = spawn(process.execPath, entryArgs(scriptDir, HTTP_FLAG), {
            cwd: scriptDir, detached: true, windowsHide: true,
            stdio: ["ignore", out, out], env: { ...process.env, PORT: String(port) },
          });
          child.unref();
          await fh?.close();   // 자식은 자기 핸들을 물려받았으므로 부모 쪽은 닫아도 된다
          // 기동 대기(최대 ~15s). tsx 콜드 스타트는 이 PC 에서 4초 안팎이지만 여유를 둔다.
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (await fetch(url).then((r) => r.ok).catch(() => false)) { up = true; break; }
          }
        }
        // 이 도구는 spawn 도 브라우저 실행도 fire-and-forget 이라, 프로브 결과가 실패를 담을 수 있는
        // 유일한 신호다. 버리면 서버가 안 떠도 ok:true 가 나가 호출부의 어떤 가드로도 잡을 수 없다.
        if (!up) return docResult({ ok: false, code: "server_unreachable", message: `The dashboard server is not responding on ${port}. Startup log: ${log}`, target: String(port), url, log });
        openInBrowser(url);
        return docResult({ ok: true, code: "ok", message: "Opened the live dashboard in the browser", url });
      },
    },
  ];
  return defs.map(decorate);

  // 실행 중인 watcher 프로세스를 모두 종료(좀비/중복 정리).
  // Node watcher(이 설치본의 진입 파일 + --watcher)가 대상. 이전 판의 watcher.py(python) 와
  // 구버전 watcher.ps1 상주분도 함께 정리한다.
  // 커맨드라인 매칭만 쓰면 경로를 인자 문자열로 품은 무관한 셸(이 kill 명령 자신을
  // 감싼 셸 포함)까지 죽는다 - 프로세스 이름(node, python/py, powershell)을 함께 걸고, 경로는
  // **이 설치본의 전체 경로**로만 매칭한다(다른 설치본이나 다른 프로젝트의 동명 스크립트 오살 방지.
  // 옛 watcher_start 는 watcher.py 를 forward-slash 경로로 기동했으므로 커맨드라인에 그대로 남는다).
  async function killWatchers(): Promise<void> {
    if (process.platform !== "win32") return;
    await pexec("powershell.exe", ["-NoProfile", "-Command", watcherKillCommand(scriptDir, false, STORE())]).catch(() => {});
  }

  // 기본 브라우저로 경로/URL 열기(로컬 서버이므로 사용자 머신에서 열림).
  function openInBrowser(target: string): void {
    if (process.platform === "win32") {
      spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process '${target}'`],
        { stdio: "ignore", windowsHide: true });
    } else {
      spawn("xdg-open", [target], { stdio: "ignore", detached: true }).unref();
    }
  }
}

// CONFIG_MONITOR_WATCHER=auto 일 때 서버 기동 시 watcher 를 함께 올린다(옵트인, 기본 꺼짐).
// watcher_start 도구를 그대로 재사용한다 - 단일 인스턴스 보장/heartbeat 확인까지 같은 경로.
// 실패해도 서버는 정상 기동해야 하므로 로그만 남긴다.
export async function autoStartWatcher(scriptDir: string): Promise<void> {
  if ((process.env.CONFIG_MONITOR_WATCHER || "").toLowerCase() !== "auto") return;
  const tool = buildTools(scriptDir).find((d) => d.name === "watcher_start");
  try {
    const r = await tool!.run({});
    console.error("[config-monitor] watcher auto-start:", r.content?.[0]?.text ?? "");
  } catch (e) {
    console.error("[config-monitor] watcher auto-start failed:", e);
  }
}

export function registerAll(server: any, scriptDir: string): void {
  for (const d of buildTools(scriptDir)) {
    server.registerTool(d.name, d.meta, d.run);
  }

  // UI 전용 도구 + 리소스 (REST 에는 불필요)
  registerAppTool(server, "show_config_monitor", {
    title: "Show Config Monitor",
    description: "Open the Claude config monitor dashboard (config cards, plus diff history when a file is clicked)",
    inputSchema: {},
    annotations: READ,
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  }, async () => text("Config monitor dashboard opened."));

  registerAppResource(server, RESOURCE_URI, RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    const html = await fs.readFile(path.join(scriptDir, "dist", "dashboard.html"), "utf-8");
    // 위젯 iframe 은 localStorage 가 막힐 수 있어 저장된 언어 선택이 남지 않는다 -> env 로 시작 언어 지정.
    return { contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html.replace("<head>", "<head>" + langScript()) }] };
  });
}
