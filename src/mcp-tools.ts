// mcp-tools.ts - config-monitor 의 모든 도구 정의 + 등록 (stdio / http 공용).
//
// 설계: 검증된 Python 레이어(cas.py / claude_config.py / config_edit.py)를 child_process 로
//       shell-out 해 재사용. buildTools() 가 도구 정의를 만들고, MCP(registerAll) 와
//       HTTP REST(server.ts) 가 동일한 핸들러를 공유한다.
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

const pexec = promisify(execFile);
export const RESOURCE_URI = "ui://config-monitor/dashboard.html";

// CONFIG_MONITOR_LANG: 대시보드 시작 언어. ko/ko-KR/KO_KR 계열 -> ko, en/en-US/EN 계열 -> en.
// 미지정이면 null 을 돌려 UI 가 스스로 결정하게 둔다(저장된 토글 선택 -> 없으면 ko).
// 인식 못 하는 값은 ko(안전한 기본). 지역 접미사는 '-'/'_' 앞자리만 본다.
export function resolveLang(raw?: string): "ko" | "en" | null {
  const v = String(raw ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (!v) return null;
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
function jsonResult(t: string): ToolResult {
  let parsed: unknown;
  try { parsed = JSON.parse(t); } catch { parsed = undefined; }
  return {
    content: [{ type: "text", text: t }],
    ...(parsed !== undefined ? { structuredContent: parsed as Record<string, unknown> } : {}),
  };
}

export interface ToolDef {
  name: string;
  meta: { title: string; description: string; inputSchema: any; annotations: any };
  run: (args: any) => Promise<ToolResult>;
}

// 모든 데이터/액션 도구 정의(show_config_monitor 같은 UI 전용 도구는 제외).
export function buildTools(scriptDir: string): ToolDef[] {
  const PY = process.env.CONFIG_MONITOR_PYTHON || "python";
  // Windows 콘솔 기본 인코딩(cp949)은 한글/em-dash 출력 시 UnicodeEncodeError 로 Python 을 죽인다.
  // 자식 stdout/stderr 를 UTF-8 로 강제(PYTHONUTF8=1, PYTHONIOENCODING=utf-8).
  const PY_ENV = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  // watcher.py 기본값과 동일한 스토어를 가리키도록.
  const STORE = process.env.CLAUDE_SNAPSHOT_STORE ||
    (process.platform === "win32" ? "D:\\.claude-snapshot" : path.join(process.env.HOME || "", ".claude-snapshot"));
  // timeout 은 그 호출 안에서 순차로 도는 하위 작업 상한의 합보다 커야 한다. 작으면 정상 진행 중인
  // git clone 을 끊는다. 60초는 LOCK_STALE_SEC 와 같아 끊긴 호출이 남긴 락을 다음 호출이 회수할 수 있다.
  const QUERY_OPS: Record<string, Set<string>> = {
    "cas.py": new Set(["status", "history", "cat", "diff", "watcher-status"]),
    "prefs.py": new Set(["get"]),
    "library.py": new Set(["scan", "catalog", "market-discover"]),
  };
  const NET_OPS = new Set(["remote-add", "market-add", "plugin-fetch", "fetch"]);
  const timeoutMs = (script: string, args: string[]): number => {
    if (script === "claude_config.py" || script === "plugin_catalog.py") return 30_000;
    if (script === "plugin_cli.py") return 660_000;
    if (script === "library.py" && args.some((x) => NET_OPS.has(x))) return 1_860_000;
    if (args.some((x) => QUERY_OPS[script]?.has(x))) return 30_000;
    return 60_000;
  };
  const tail = (s: unknown) => (typeof s === "string" ? s.slice(-2048) : "");
  const isJson = (s: string) => { try { JSON.parse(s); return true; } catch { return false; } };
  // 항상 JSON 문자열을 돌려주고 throw 하지 않는다. 판정은 호출부가 stdout 의 ok 로 한다.
  const runPy = async (script: string, args: string[]): Promise<string> => {
    const op = `${script} ${args[0] ?? ""}`.trim();
    try {
      const { stdout } = await pexec(PY, [path.join(scriptDir, script), ...args], {
        env: PY_ENV,
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs(script, args),
      });
      if (isJson(stdout)) return stdout;
      return JSON.stringify({ ok: false, code: "bad_output", message: `${op} 의 출력이 JSON 이 아닙니다`, detail: tail(stdout) });
    } catch (e: any) {
      const stdout: string = typeof e?.stdout === "string" ? e.stdout : "";
      if (stdout.trim() && isJson(stdout)) return stdout;
      const detail = `${tail(stdout)}\n--- stderr ---\n${tail(e?.stderr)}`;
      if (e?.killed && e?.signal) {
        return JSON.stringify({ ok: false, code: "timeout", message: `${op} 가 ${timeoutMs(script, args) / 1000}초 안에 끝나지 않아 중단했습니다`, detail });
      }
      const exit = typeof e?.code === "number" ? e.code : String(e?.code ?? e?.message ?? e);
      return JSON.stringify({ ok: false, code: "crash", message: `${op} 가 exit ${exit} 으로 끝났습니다`, detail });
    }
  };

  // 추적 중인 프로젝트 .claude 디렉토리(전역 기본 추적분 제외). 대시보드가 get_tracked 로 같은
  // 목록을 만들어 넘기던 것을 서버가 스스로 구해, 대화에서 projects 를 몰라도 되게 한다.
  const trackedProjectDirs = async (): Promise<string[]> => {
    try {
      const st = JSON.parse((await runPy("cas.py", ["status", "--json"])).trim().split("\n").pop() || "{}");
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
      const pj = JSON.parse(await runPy("claude_config.py", ["projects"]));
      for (const p of pj.projects || []) if (p.has_claude) dirs.add(p.claude_dir);
    } catch { /* projects 목록이 없어도 추적분만으로 푼다 */ }
    const all = [...dirs];
    const r = norm(ref);
    const byPath = all.filter((d) => norm(d) === r || norm(d) === r + "/.claude");
    if (byPath.length) return { dir: byPath[0] };
    const byName = all.filter((d) => path.basename(path.dirname(d)).toLowerCase() === r);
    if (byName.length === 1) return { dir: byName[0] };
    if (byName.length > 1) return { code: "ambiguous", error: `프로젝트 이름 '${ref}' 이 여러 개에 해당합니다. 경로로 지정해 주세요`, candidates: byName };
    return { code: "project_not_found", error: `프로젝트 '${ref}' 을 찾을 수 없습니다(추적 중이거나 ~/.claude.json 에 있는 프로젝트만 가능)`, candidates: all };
  };

  // 마지막 편집 도구 호출 표식. 파일에 두는 이유: Desktop 위젯과 대화 중인 Claude 가 서로 다른
  // 서버 프로세스를 쓸 수 있어(Cowork 별도 인스턴스 등) 메모리 카운터로는 서로를 못 본다.
  const CHANGE_FILE = path.join(STORE, "changes.json");
  const readChange = async (): Promise<{ seq: number; tool?: string; at?: string }> => {
    try { return JSON.parse(await fs.readFile(CHANGE_FILE, "utf-8")); } catch { return { seq: 0 }; }
  };
  const bumpChange = async (tool: string): Promise<void> => {
    try {
      const prev = await readChange();
      await fs.mkdir(STORE, { recursive: true });
      await fs.writeFile(CHANGE_FILE, JSON.stringify({ seq: Math.max(Date.now(), prev.seq + 1), tool, at: new Date().toISOString() }));
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
        project: z.string().optional().describe("대상 프로젝트(폴더 이름 또는 경로). 지정하면 그 프로젝트의 .claude 를 대상으로 하고 경로 인자를 대신 채운다. 생략 시 전역"),
      }),
    } : d.meta;
    const run = async (a: any) => {
      if (pf && a?.project) {
        const [field, sub] = pf;
        const r = await resolveProject(String(a.project));
        if (!r.dir) return jsonResult(JSON.stringify({ ok: false, code: r.code, target: String(a.project), message: r.error, candidates: r.candidates }));
        const subdir = sub === "*item" ? (ITEM_DIRS[a.itemKind] || a.itemKind) : sub;
        a = { ...a, [field]: a[field] || path.join(r.dir, subdir) };
        delete a.project;
      }
      const res = await d.run(a);
      if (!d.meta.annotations.readOnlyHint && !NO_SIGNAL.has(d.name)) {
        const sc = res.structuredContent as any;
        if (sc?.ok === true && sc.code !== "noop" && sc.code !== "dry_run") await bumpChange(d.name);
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
        description: "Claude 설정 항목의 상세(카드 단위). 대화에서는 먼저 summarize_config 로 개요를 보고, 여기서는 sections/scope/query 로 범위를 좁히고 compact=true 로 받는다 - 전체 dump 는 200KB 를 넘는다. " +
          "각 카드의 edit 에 편집 도구가 받는 경로(settings/skillsDir/dir 등)가 들어 있다. projects 를 생략하면 추적 중인 프로젝트를 자동으로 포함한다",
        inputSchema: z.object({
          projects: z.array(z.string()).optional().describe("프로젝트 .claude 디렉토리들. 생략 시 추적 중인 프로젝트 전부"),
          sections: z.array(z.string()).optional().describe("섹션 id 목록(예: hooks, perm, skills, agents, mcp-desktop, claude-json, plugins). summarize_config 의 id 와 같다"),
          scope: z.enum(["global", "project"]).optional().describe("global=전역(~/.claude · Desktop)만, project=프로젝트 .claude 항목만"),
          query: z.string().optional().describe("이름·값 부분일치(대소문자 무시)"),
          compact: z.boolean().optional().describe("true 면 카드를 이름·배지·스코프·edit·짧은 설명으로 축약. 대화에서는 기본으로 켠다"),
          includeMissing: z.boolean().optional().describe("true 면 .claude.json 프로젝트 카드에 .claude 폴더가 없는 경로도 포함"),
        }), annotations: READ,
      },
      run: async (a: { projects?: string[]; sections?: string[]; scope?: string; query?: string; compact?: boolean; includeMissing?: boolean }) => {
        const args = ["dump"];
        const projects = a.projects ?? await trackedProjectDirs();
        if (projects.length) args.push("--projects", ...projects);
        if (a.sections && a.sections.length) args.push("--sections", ...a.sections);
        if (a.scope) args.push("--scope", a.scope);
        if (a.query) args.push("--query", a.query);
        if (a.compact) args.push("--compact");
        if (a.includeMissing) args.push("--include-missing");
        return jsonResult(await runPy("claude_config.py", args));
      },
    },
    {
      name: "summarize_config",
      meta: {
        title: "Summarize Claude Config",
        description: "현재 Claude 설정의 개요: 섹션별 개수·적재등급(eager/lazy/never)·전역/프로젝트 분포·이름 목록, 전역-프로젝트 이름 충돌(어느 쪽이 적용되는지), 플러그인 상태 분포. " +
          "설정을 분석·정리·불필요 항목 제거를 논의할 때 이걸 먼저 부르고, 특정 항목은 get_config(sections=[...], compact=true) 로 내려간다. 파일은 읽지 않고 상태만 요약한다",
        inputSchema: z.object({
          projects: z.array(z.string()).optional().describe("프로젝트 .claude 디렉토리들. 생략 시 추적 중인 프로젝트 전부"),
        }), annotations: READ,
      },
      run: async (a: { projects?: string[] }) => {
        const args = ["summary"];
        const projects = a.projects ?? await trackedProjectDirs();
        if (projects.length) args.push("--projects", ...projects);
        return jsonResult(await runPy("claude_config.py", args));
      },
    },
    {
      name: "get_prefs",
      meta: {
        title: "Get Dashboard Preferences",
        description: "[UI 전용] 대시보드 표시 설정(섹션 프리셋/숨김 목록/빈 섹션 처리) JSON. 설정 내용과 무관한 화면 옵션이다",
        inputSchema: z.object({}), annotations: READ,
      },
      run: async () => jsonResult(await runPy("prefs.py", ["get", "--store", STORE])),
    },
    {
      name: "set_prefs",
      meta: {
        title: "Set Dashboard Preferences",
        description: "[UI 전용] 대시보드 표시 설정을 저장. 스토어 미초기화면 ok:false 와 사유를 반환(조용히 성공하지 않음)",
        inputSchema: z.object({
          sections: z.object({
            preset: z.enum(["all", "common", "custom"]).optional(),
            hidden: z.array(z.string()).optional(),
            hideEmpty: z.boolean().optional(),
            includeMissingProjects: z.boolean().optional(),
            groupsCollapsed: z.array(z.string()).optional(),
          }).optional().describe("덮어쓸 키만 보낸다"),
          view: z.object({
            selectedPath: z.string().optional(),
            detailOpen: z.boolean().optional(),
            scope: z.string().optional(),
            libTarget: z.string().optional(),
          }).optional().describe("보던 자리(선택 파일·패널·필터). 위젯이 다시 올라올 때 복원한다"),
        }), annotations: WRITE,
      },
      // execFile 은 셸을 거치지 않으므로 JSON 을 argv 한 칸으로 넘겨도 인용 문제가 없다.
      run: async (a: { sections?: Record<string, unknown>; view?: Record<string, unknown> }) =>
        jsonResult(await runPy("prefs.py",
          ["set", "--store", STORE, "--json", JSON.stringify({ sections: a.sections || {}, view: a.view || {} })])),
    },
    {
      name: "get_tracked",
      meta: {
        title: "Get Tracked File Status",
        description: "스냅샷 추적 파일들의 변경 상태(new/modified/deleted/unchanged)와 watcher 상태, 마지막 편집 도구 호출(change.seq). 어떤 설정 파일이 스냅샷 대비 바뀌었는지 볼 때",
        inputSchema: z.object({
          phase: z.enum(["boot", "refresh", "poll"]).optional().describe("[UI 전용] 위젯이 왜 부르는지. 스토어의 widget.log 에 남는다"),
          instance: z.string().optional().describe("[UI 전용] 위젯 인스턴스 id"),
        }), annotations: READ,
      },
      run: async (a: { phase?: string; instance?: string }) => {
        // 호스트가 위젯을 몇 번 다시 올리는지, 동시에 몇 개가 살아 있는지는 서버 밖에서 알 길이 없다.
        // 폴링은 양이 많아 남기지 않고, 부트·전체 refresh 만 한 줄씩 적는다.
        if (a?.phase && a.phase !== "poll") {
          const line = `${new Date().toISOString()} ${a.phase} ${a.instance || "-"}\n`;
          await fs.mkdir(STORE, { recursive: true }).then(() => fs.appendFile(path.join(STORE, "widget.log"), line)).catch(() => {});
        }
        const raw = await runPy("cas.py", ["status", "--json"]);
        // 대시보드 폴링이 이 한 호출로 다른 클라이언트의 편집까지 알아야 한다(호출 하나 = 프로세스 하나).
        try {
          const st = JSON.parse(raw.trim().split("\n").pop() || "");
          st.change = await readChange();
          return jsonResult(JSON.stringify(st));
        } catch { return jsonResult(raw); }
      },
    },
    {
      name: "config_track",
      meta: {
        title: "Track Config Path",
        description: "설정 파일/폴더를 스냅샷 추적 대상에 추가(감시 전용). 프로젝트 폴더나 .claude 를 주면 " +
          "settings.json + settings.local.json 을 자동 감지, 파일 경로면 그 파일만. 편집은 하지 않음",
        inputSchema: z.object({
          path: z.string().describe("프로젝트 폴더 / .claude 폴더 / 설정 파일의 절대경로"),
        }), annotations: WRITE,
      },
      run: async (a: { path: string }) => jsonResult(await runPy("cas.py", ["track", "--json", a.path])),
    },
    {
      name: "config_untrack",
      meta: {
        title: "Untrack Config Path",
        description: "추적 목록에서 파일을 제거(파일 자체는 그대로). 프로젝트 추적 행 제거용",
        inputSchema: z.object({
          path: z.string().describe("추적 중인 파일의 절대경로(행에 표시된 경로)"),
        }), annotations: WRITE,
      },
      run: async (a: { path: string }) => jsonResult(await runPy("cas.py", ["untrack", "--json", a.path])),
    },
    {
      name: "list_projects",
      meta: {
        title: "List Claude Code Projects",
        description: ".claude.json 의 projects 를 {projects:[{path, name, claude_dir, has_claude}]} 로 반환. 기본은 .claude 있는 프로젝트만, includeMissing=true 면 .claude 없는 경로도 낸다. 시스템 임시 폴더와 Claude Desktop 작업 공간(scratch-workspaces) 아래 경로는 항상 제외한다. UI 가 원클릭 track/설치 대상 후보로 사용",
        inputSchema: z.object({
          includeMissing: z.boolean().optional().describe("true 면 .claude 폴더가 없는 프로젝트 경로도 포함"),
        }), annotations: READ,
      },
      run: async (a: { includeMissing?: boolean }) =>
        jsonResult(await runPy("claude_config.py", a.includeMissing ? ["projects", "--include-missing"] : ["projects"])),
    },
    {
      name: "get_file_history",
      meta: {
        title: "Get File History",
        description: "특정 파일의 스냅샷 리비전 이력(git log 스타일). 내용이 바뀐 스냅샷만 추리고, 무시 키 프로필이 있는 파일은 무시 키만 다른 리비전을 접는다",
        inputSchema: z.object({ path: z.string().describe("추적 중인 파일의 절대경로") }), annotations: READ,
      },
      run: async (a: { path: string }) => jsonResult(await runPy("cas.py", ["history", a.path, "--json"])),
    },
    {
      name: "get_file_content",
      meta: {
        title: "Get Current File Content",
        description: "추적 중인 설정 파일의 현재 내용을 그대로 반환(읽기 전용 뷰어). 추적 목록 밖 경로는 거부",
        inputSchema: z.object({ path: z.string().describe("추적 중인 파일의 절대경로") }), annotations: READ,
      },
      run: async (a: { path: string }) => jsonResult(await runPy("cas.py", ["cat", a.path, "--json"])),
    },
    {
      name: "get_diff",
      meta: {
        title: "Get File Diff",
        description: "파일의 두 리비전(또는 스냅샷 vs 현재) 간 unified diff. 무시 키 프로필이 있는 파일은 무시 키를 뺀 diff 에 '무시 목록 항목도 바뀜' 각주가 붙는다(raw=true 면 원문). from/to 미지정 시 최신 스냅샷 vs 작업본",
        inputSchema: z.object({
          path: z.string(),
          from: z.string().optional().describe("스냅샷 id (생략 시 최신 스냅샷)"),
          to: z.string().optional().describe("스냅샷 id 또는 'work'(기본=현재 파일)"),
          raw: z.boolean().optional().describe("true 면 무시 키 프로필을 적용하지 않은 원문 diff"),
        }), annotations: READ,
      },
      run: async (a: { path: string; from?: string; to?: string; raw?: boolean }) => {
        const args = ["diff", a.path, "--json"];
        if (a.from) args.push("--from", a.from);
        if (a.to) args.push("--to", a.to);
        if (a.raw) args.push("--raw");
        return jsonResult(await runPy("cas.py", args));
      },
    },
    {
      name: "snapshot_now",
      meta: {
        title: "Snapshot Now",
        description: "추적 파일 현재 상태로 스냅샷 1개 생성",
        inputSchema: z.object({ message: z.string().optional() }), annotations: WRITE,
      },
      run: async (a: { message?: string }) => jsonResult(await runPy("cas.py", ["snapshot", "-m", a.message || "manual", "--json"])),
    },
    {
      name: "snapshot_gc",
      meta: {
        title: "Snapshot GC",
        description: "보존 기한(기본 90일)이 지난 스냅샷과 미참조 객체를 정리. dryRun=true 면 계산만 하고 지우지 않음. 최신 스냅샷과 현재 index 참조 객체는 항상 보존",
        inputSchema: z.object({
          keepDays: z.number().optional().describe("보존 일수(기본 90)"),
          dryRun: z.boolean().optional().describe("true 면 정리 대상 계산만"),
        }), annotations: WRITE,
      },
      run: async (a: { keepDays?: number; dryRun?: boolean }) => {
        const args = ["gc", "--json", "--keep-days", String(a.keepDays ?? 90)];
        if (a.dryRun) args.push("--dry-run");
        return jsonResult(await runPy("cas.py", args));
      },
    },
    {
      name: "config_restore",
      meta: {
        title: "Restore File From Snapshot",
        description: "추적 파일을 특정 스냅샷 버전으로 복원. 복원 전 현재 상태를 스냅샷(되돌림 지점) + .bak 백업",
        inputSchema: z.object({
          path: z.string().describe("복원할 추적 파일의 절대경로"),
          from: z.string().describe("복원할 스냅샷 id"),
        }), annotations: EDIT,
      },
      run: async (a: { path: string; from: string }) =>
        jsonResult(await runPy("cas.py", ["restore", a.path, "--from", a.from])),
    },

    // ----- watcher 제어 -----
    {
      name: "watcher_status",
      meta: {
        title: "Watcher Status",
        description: "상주 watcher(폴링 자동 스냅샷)의 실행 여부/heartbeat 조회",
        inputSchema: z.object({}), annotations: READ,
      },
      run: async () => jsonResult(await runPy("cas.py", ["watcher-status"])),
    },
    {
      name: "watcher_start",
      meta: {
        title: "Start Watcher",
        description: "watcher.py 를 백그라운드로 기동(추적 파일 변경 시 자동 스냅샷). 이미 실행 중이면 no-op",
        inputSchema: z.object({}), annotations: WRITE,
      },
      run: async () => {
        const cur = JSON.parse(await runPy("cas.py", ["watcher-status"]));
        if (cur.running) return jsonResult(JSON.stringify({ ok: true, code: "noop", message: "이미 실행 중", pid: cur.pid, changed: false }));
        // 좀비/중복 watcher 정리(상태 신뢰성과 무관하게 단일 인스턴스 보장) 후 새로 기동.
        await killWatchers();
        await fs.rm(path.join(STORE, "watcher.json"), { force: true }).catch(() => {});
        // Node 가 detached spawn 하면 (1) 인자 백슬래시가 먹혀 경로가 깨지고 (2) detached 자식이
        // 즉사한다. 검증 패턴: 일회성 powershell 이 Start-Process 로 독립 기동.
        const wpy = path.join(scriptDir, "watcher.py").replace(/\\/g, "/");
        const storeFwd = STORE.replace(/\\/g, "/");
        const cmd = `Start-Process '${PY}' -WindowStyle Hidden -ArgumentList @('${wpy}','--store','${storeFwd}')`;
        spawn("powershell.exe", ["-NoProfile", "-Command", cmd], { stdio: "ignore", windowsHide: true, env: PY_ENV });
        // heartbeat 가 쓰일 때까지 폴링(최대 ~5.6s) 후 실제 상태를 반환(허위 ok 방지).
        let st: any = {};
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 700));
          st = JSON.parse(await runPy("cas.py", ["watcher-status"]));
          if (st.running) break;
        }
        return jsonResult(JSON.stringify({
          ok: !!st.running, code: st.running ? "ok" : "watcher_start_failed",
          message: st.running ? "watcher 기동됨" : "watcher 기동 실패(watcher.json 미갱신 - 권한/PATH 확인)",
          pid: st.pid, changed: true,
        }));
      },
    },
    {
      name: "watcher_stop",
      meta: {
        title: "Stop Watcher",
        description: "실행 중인 watcher 프로세스를 모두 종료(watcher.py 커맨드라인 매칭). Windows 전용",
        inputSchema: z.object({}), annotations: WRITE,
      },
      run: async () => {
        // pid 하나가 아니라 모든 watcher 를 종료(좀비 누적 정리).
        await killWatchers();
        await fs.rm(path.join(STORE, "watcher.json"), { force: true }).catch(() => {});
        return jsonResult(JSON.stringify({ ok: true, code: "ok", message: "watcher 종료", changed: true }));
      },
    },

    // ----- 편집 (스냅샷-선행 + .bak) -----
    {
      name: "config_perm_add",
      meta: {
        title: "Add Permission Rule",
        description: "settings.json permissions.<allow|deny|ask> 에 규칙 추가 (편집 전 스냅샷+백업). settings 지정 시 그 파일 대상(프로젝트 설정)",
        inputSchema: z.object({ kind: z.enum(["allow", "deny", "ask"]), rule: z.string(), settings: z.string().optional() }), annotations: EDIT,
      },
      run: async (a: { kind: string; rule: string; settings?: string }) => {
        // --settings 는 부모 파서 옵션이라 subcommand 앞에 와야 argparse 가 인식.
        const args = a.settings ? ["--settings", a.settings] : [];
        args.push("perm-add", a.kind, a.rule);
        return jsonResult(await runPy("config_edit.py", args));
      },
    },
    {
      name: "config_perm_remove",
      meta: {
        title: "Remove Permission Rule",
        description: "settings.json permissions 에서 규칙 제거. settings 지정 시 그 파일 대상(프로젝트 설정)",
        inputSchema: z.object({ kind: z.enum(["allow", "deny", "ask"]), rule: z.string(), settings: z.string().optional() }), annotations: EDIT,
      },
      run: async (a: { kind: string; rule: string; settings?: string }) => {
        const args = a.settings ? ["--settings", a.settings] : [];
        args.push("perm-remove", a.kind, a.rule);
        return jsonResult(await runPy("config_edit.py", args));
      },
    },
    {
      name: "config_hook_add",
      meta: {
        title: "Add Hook",
        description: "settings.json hooks.<event> 에 command hook 추가. settings 지정 시 그 파일 대상(프로젝트 설정)",
        inputSchema: z.object({ event: z.string(), command: z.string(), matcher: z.string().optional(), settings: z.string().optional() }), annotations: EDIT,
      },
      run: async (a: { event: string; command: string; matcher?: string; settings?: string }) => {
        const args = a.settings ? ["--settings", a.settings] : [];
        args.push("hook-add", a.event, a.command);
        if (a.matcher) args.push("--matcher", a.matcher);
        return jsonResult(await runPy("config_edit.py", args));
      },
    },
    {
      name: "config_hook_remove",
      meta: {
        title: "Remove Hook",
        description: "settings.json hooks.<event> 에서 command substring 매칭 항목 제거. settings 지정 시 그 파일 대상(프로젝트 설정)",
        inputSchema: z.object({ event: z.string(), needle: z.string(), settings: z.string().optional() }), annotations: EDIT,
      },
      run: async (a: { event: string; needle: string; settings?: string }) => {
        const args = a.settings ? ["--settings", a.settings] : [];
        args.push("hook-remove", a.event, a.needle);
        return jsonResult(await runPy("config_edit.py", args));
      },
    },
    {
      name: "config_plugin_toggle",
      meta: {
        title: "Toggle Claude Code Plugin",
        description: "settings.json 의 enabledPlugins[<id>] 만 켜고 끈다. **적용은 다음 세션부터** — Claude Code 가 세션 시작 시 읽기 때문. id 는 '<플러그인 이름>@<마켓 이름>' 이고 **마켓 매니페스트 엔트리 이름** 쪽에서 온다(plugin.json 의 name/표시 네임스페이스와 다를 수 있다: 실측 notion vs 'Notion'). Plugins 카드의 edit.id 를 그대로 넘길 것 — 대소문자를 고치면 다른 키가 된다. settings 는 그 값을 정한 파일(카드의 edit.settings)을 넘긴다. 플러그인 설치/제거는 하지 않는다(그건 `claude plugin` 의 몫)",
        inputSchema: z.object({
          id: z.string().describe("plugin@marketplace — Plugins 카드의 edit.id 원문"),
          on: z.boolean(),
          settings: z.string().optional().describe("대상 settings.json(카드의 edit.settings). 미지정 시 전역"),
        }), annotations: EDIT,
      },
      run: async (a: { id: string; on: boolean; settings?: string }) => {
        const args = a.settings ? ["--settings", a.settings] : [];
        args.push("plugin-toggle", a.id, a.on ? "on" : "off");
        return jsonResult(await runPy("config_edit.py", args));
      },
    },
    {
      name: "skill_scaffold",
      meta: {
        title: "Scaffold Code Skill",
        description: "스킬 생성: <skills>/<name>/SKILL.md. content 를 주면 그대로 설치, 없으면 desc 로 스텁. 기본 ~/.claude/skills, skillsDir 또는 project 로 프로젝트 대상",
        inputSchema: z.object({
          name: z.string(), desc: z.string().optional(),
          content: z.string().optional().describe("SKILL.md 전체 내용(frontmatter 포함). 지정 시 스텁 대신 그대로 설치"),
          skillsDir: z.string().optional().describe("대상 skills 디렉토리(<프로젝트>/.claude/skills). 생략 시 전역"),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; desc?: string; content?: string; skillsDir?: string }) => {
        const args = a.skillsDir ? ["--skills-dir", a.skillsDir] : [];
        args.push("skill-scaffold", a.name);
        if (a.desc) args.push("--desc", a.desc);
        if (a.content) args.push("--content", a.content);
        return jsonResult(await runPy("config_edit.py", args));
      },
    },
    {
      name: "config_skill_remove",
      meta: {
        title: "Remove Code Skill",
        description: "스킬 디렉토리를 .trash 로 이동(복구 가능). 편집 전 스냅샷. " +
          "skillsDir 지정 시 그 디렉토리 대상(프로젝트-로컬 스킬), 생략 시 ~/.claude/skills",
        inputSchema: z.object({
          name: z.string(),
          skillsDir: z.string().optional().describe("대상 skills 디렉토리(<프로젝트>/.claude/skills). 생략 시 전역 ~/.claude/skills"),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; skillsDir?: string }) => {
        // --skills-dir 는 부모 파서 옵션이라 subcommand 앞에 와야 argparse 가 인식.
        const args = a.skillsDir ? ["--skills-dir", a.skillsDir] : [];
        args.push("skill-remove", a.name);
        return jsonResult(await runPy("config_edit.py", args));
      },
    },
    {
      name: "config_agent_add",
      meta: {
        title: "Scaffold Agent",
        description: "에이전트 생성: <agents>/<name>.md. content 로 전체 정의(frontmatter 포함) 설치 가능, 없으면 desc/tools/model 스캐폴드. 기본 ~/.claude/agents, agentsDir 또는 project 로 프로젝트 대상",
        inputSchema: z.object({
          name: z.string(), desc: z.string().optional(),
          tools: z.string().optional(), model: z.string().optional(),
          content: z.string().optional().describe("에이전트 md 전체 내용(frontmatter 포함). 지정 시 desc/tools/model 무시"),
          agentsDir: z.string().optional().describe("대상 agents 디렉토리(<프로젝트>/.claude/agents). 생략 시 전역"),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; desc?: string; tools?: string; model?: string; content?: string; agentsDir?: string }) => {
        const args = a.agentsDir ? ["--agents-dir", a.agentsDir] : [];
        args.push("agent-scaffold", a.name);
        if (a.desc) args.push("--desc", a.desc);
        if (a.tools) args.push("--tools", a.tools);
        if (a.model) args.push("--model", a.model);
        if (a.content) args.push("--content", a.content);
        return jsonResult(await runPy("config_edit.py", args));
      },
    },
    {
      name: "config_agent_remove",
      meta: {
        title: "Remove Agent",
        description: "에이전트 <name>(.md) 을 .trash 로 이동(복구 가능). 편집 전 스냅샷. " +
          "agentsDir 지정 시 그 디렉토리 대상(프로젝트-로컬 에이전트), 생략 시 ~/.claude/agents",
        inputSchema: z.object({
          name: z.string(),
          agentsDir: z.string().optional().describe("대상 agents 디렉토리(<프로젝트>/.claude/agents). 생략 시 전역 ~/.claude/agents"),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; agentsDir?: string }) => {
        // --agents-dir 는 부모 파서 옵션이라 subcommand 앞에 와야 argparse 가 인식.
        const args = a.agentsDir ? ["--agents-dir", a.agentsDir] : [];
        args.push("agent-remove", a.name);
        return jsonResult(await runPy("config_edit.py", args));
      },
    },
    {
      name: "config_item_add",
      meta: {
        title: "Scaffold Rule / Output Style / Workflow",
        description: "단일 파일 항목(rule/output-style/workflow) 스텁 생성. rule 에 paths 를 주면 적재가 EAGER 대신 LAZY 가 됨",
        inputSchema: z.object({
          itemKind: z.enum(["rule", "output-style", "workflow"]),
          name: z.string().describe("단일 세그먼트 이름(경로 구분자 불가)"),
          desc: z.string().optional(),
          paths: z.string().optional().describe("rule 전용. 지정하면 매칭 파일을 읽을 때만 적재(LAZY)"),
          dir: z.string().optional().describe("프로젝트 대상 디렉토리(<...>/.claude/<sub>). 미지정 시 전역"),
        }), annotations: WRITE,
      },
      run: async (a: { itemKind: string; name: string; desc?: string; paths?: string; dir?: string }) => {
        const args = ["item-scaffold", a.itemKind, a.name];
        if (a.desc) args.push("--desc", a.desc);
        if (a.paths) args.push("--paths", a.paths);
        if (a.dir) args.unshift("--items-dir", a.dir);
        return jsonResult(await runPy("config_edit.py", args));
      },
    },
    {
      name: "config_item_remove",
      meta: {
        title: "Remove Rule / Output Style / Workflow",
        description: "단일 파일 항목을 .trash 로 이동(복구 가능). dir 지정 시 그 프로젝트에서만 제거",
        inputSchema: z.object({
          itemKind: z.enum(["rule", "output-style", "workflow"]),
          name: z.string(),
          dir: z.string().optional().describe("프로젝트 대상 디렉토리. 미지정 시 전역"),
        }), annotations: EDIT,
      },
      run: async (a: { itemKind: string; name: string; dir?: string }) => {
        const args = ["item-remove", a.itemKind, a.name];
        if (a.dir) args.unshift("--items-dir", a.dir);
        return jsonResult(await runPy("config_edit.py", args));
      },
    },
    {
      name: "config_outputstyle_set",
      meta: {
        title: "Activate Output Style",
        description: "settings 의 outputStyle 을 지정(빈 이름이면 해제). 어떤 스타일이 세션 시작에 적재될지를 바꾸는 스위치",
        inputSchema: z.object({
          name: z.string().describe("활성화할 스타일 이름. 빈 문자열이면 선택 해제"),
          settings: z.string().optional().describe("프로젝트 settings.json 경로. 미지정 시 전역"),
        }), annotations: WRITE,
      },
      run: async (a: { name: string; settings?: string }) => {
        const args = ["outputstyle-set", a.name];
        if (a.settings) args.unshift("--settings", a.settings);
        return jsonResult(await runPy("config_edit.py", args));
      },
    },
    {
      name: "config_memory_remove",
      meta: {
        title: "Remove Memory Topic",
        description: "프로젝트 메모리 토픽 파일을 .trash 로 이동(복구 가능). MEMORY.md 색인은 대상이 아님",
        inputSchema: z.object({
          name: z.string().describe("토픽 이름(확장자 제외)"),
          memoryDir: z.string().describe("<...>/projects/<name>/memory 경로"),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; memoryDir: string }) =>
        jsonResult(await runPy("config_edit.py",
          ["--memory-dir", a.memoryDir, "memory-remove", a.name])),
    },
    {
      name: "config_mcp_add",
      meta: {
        title: "Add/Update MCP Server",
        description: "mcpServers.<name> 추가/갱신. scope=user 는 ~/.claude.json, scope=desktop 은 claude_desktop_config.json(적용은 Desktop 재시작 필요). 스냅샷+.bak+atomic",
        inputSchema: z.object({
          name: z.string(),
          serverJson: z.string().describe('서버 설정 JSON 문자열, 예: {"command":"npx","args":["-y","some-mcp"]}'),
          scope: z.enum(["user", "desktop"]).optional(),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; serverJson: string; scope?: string }) =>
        jsonResult(await runPy("config_edit.py",
          ["mcp-add", a.name, "--json", a.serverJson, "--scope", a.scope || "user"])),
    },
    {
      name: "config_mcp_remove",
      meta: {
        title: "Remove MCP Server",
        description: "mcpServers.<name> 제거. scope=user|desktop (desktop 적용은 재시작 필요). 스냅샷+.bak+atomic",
        inputSchema: z.object({ name: z.string(), scope: z.enum(["user", "desktop"]).optional() }), annotations: EDIT,
      },
      run: async (a: { name: string; scope?: string }) =>
        jsonResult(await runPy("config_edit.py", ["mcp-remove", a.name, "--scope", a.scope || "user"])),
    },

    // ----- 라이브러리 토글 (.claude 구조 라이브러리 디렉토리) -----
    {
      name: "library_scan",
      meta: {
        title: "Scan Personal Library",
        description: "라이브러리(로컬 등록분 + env + 원격/마켓 캐시)의 agents/skills/commands 를 열거하고 라이브 설정과 해시 비교해 4상태(not_installed/installed/modified/conflict) 반환. 각 행에 source(env|registered|remote|market)·origin·고정 sha·fetched_at, 각 항목에 origin 과 conflict 시 owner 를 붙인다. 각 행의 units 에는 라이브러리 하위(깊이 2)에서 hooks/hooks.json·.mcp.json 을 가진 도구 디렉토리가 자체 origin(local:<경로>)과 함께 실린다 - hooks/mcp-install 에 그 origin 을 그대로 쓴다. **네트워크를 타지 않는다**(오프라인 동작 보장). lib 지정 시 신규 등록 후 스캔",
        inputSchema: z.object({
          lib: z.string().optional().describe("라이브러리 루트 경로(.claude 구조 디렉토리). 최초 1회 등록용"),
          targetDir: z.string().optional().describe("설치/비교 대상 .claude 루트(기본 ~/.claude). 프로젝트-로컬 스캔 시 지정"),
        }),
        annotations: READ,
      },
      run: async (a: { lib?: string; targetDir?: string }) => {
        const args: string[] = [];
        if (a.targetDir) args.push("--target", a.targetDir);
        args.push("scan");
        if (a.lib) args.push("--lib", a.lib);
        return jsonResult(await runPy("library.py", args));
      },
    },
    {
      name: "library_install",
      meta: {
        title: "Install Library Item",
        description: "라이브러리 항목을 대상 .claude(기본 ~/.claude, targetDir 로 프로젝트-로컬 지정)에 설치/동기화. skills 는 그룹 중첩(가변 깊이) 가능하며 leaf 이름으로 평탄 설치(예: path=2-stack/java-spring/error-handling -> <target>/skills/error-handling). 기존 항목 존재 시 스냅샷+.bak(파일)/.trash(디렉토리) 후 덮어씀. targetDir 의 부모 디렉토리가 없으면 거부(phantom 방지)",
        inputSchema: z.object({
          category: z.enum(["agents", "skills", "commands"]),
          path: z.string().describe("카테고리 루트 기준 상대경로. skills 는 그룹 포함 가능, agents/commands 는 이름"),
          lib: z.string().optional(),
          origin: z.string().optional().describe("출처 식별자(local:/remote:/market:). 동일 이름 캐시가 여러 개일 때 모호성 해소용 필수"),
          targetDir: z.string().optional().describe("설치 대상 .claude 루트(기본 ~/.claude). 프로젝트-로컬 설치 시 지정"),
        }), annotations: EDIT,
      },
      run: async (a: { category: string; path: string; lib?: string; origin?: string; targetDir?: string }) => {
        // --target 은 부모 파서 옵션이라 subcommand 앞에 와야 argparse 가 인식(--lib/--origin 은 install 서브파서 옵션).
        const args: string[] = [];
        if (a.targetDir) args.push("--target", a.targetDir);
        args.push("install", a.category, a.path);
        if (a.lib) args.push("--lib", a.lib);
        if (a.origin) args.push("--origin", a.origin);
        return jsonResult(await runPy("library.py", args));
      },
    },
    {
      name: "library_uninstall",
      meta: {
        title: "Uninstall Library Item",
        description: "대상 .claude(기본 ~/.claude, targetDir 로 프로젝트-로컬 지정)의 해당 항목을 .trash 로 이동(복구 가능). 라이브러리 원본은 건드리지 않음. origin 지정 시 원장의 소유자와 다르면 거부(다른 출처의 설치를 지우지 않음)",
        inputSchema: z.object({
          category: z.enum(["agents", "skills", "commands"]),
          name: z.string(),
          origin: z.string().optional().describe("요청 출처. 원장의 소유자와 다르면 거부"),
          targetDir: z.string().optional().describe("제거 대상 .claude 루트(기본 ~/.claude)"),
        }), annotations: EDIT,
      },
      run: async (a: { category: string; name: string; origin?: string; targetDir?: string }) => {
        const args: string[] = [];
        if (a.targetDir) args.push("--target", a.targetDir);
        args.push("uninstall", a.category, a.name);
        if (a.origin) args.push("--origin", a.origin);
        return jsonResult(await runPy("library.py", args));
      },
    },
    {
      name: "library_unregister",
      meta: {
        title: "Unregister Library / Remote / Marketplace",
        description: "등록을 해제한다. lib=로컬 경로(캐시 개념 없음), origin=remote:<id>|market:<id>(캐시도 함께 삭제). 원장이 그 캐시를 참조하는 hooks/MCP 가 있으면 거부하고 무엇이 걸렸는지 알린다. 설치된 항목·로컬 라이브러리 원본은 건드리지 않음. env 지정 경로는 제거 불가",
        inputSchema: z.object({
          lib: z.string().optional().describe("등록 해제할 로컬 라이브러리 루트 경로"),
          origin: z.string().optional().describe("remote:<id> | market:<id>"),
        }),
        annotations: EDIT,
      },
      run: async (a: { lib?: string; origin?: string }) => {
        const args = ["unregister"];
        if (a.lib) args.push("--lib", a.lib);
        if (a.origin) args.push("--origin", a.origin);
        return jsonResult(await runPy("library.py", args));
      },
    },
    {
      name: "library_add",
      meta: {
        title: "Add Remote Library or Marketplace",
        description: "원격 소스를 config-monitor 스토어에 등록한다. **네트워크를 탄다** — library_scan 은 타지 않으므로 등록 후 scan 은 캐시만 읽는다. " +
          "kind=remote: 임의 git 레포를 라이브러리로 등록. clone 후 agents/skills/commands 레이아웃을 대소문자 무시로 탐지하고 store/config.json 의 remotes[] 에 영속화한다. 고정 sha 를 기록하며 자동 pull 은 없다. " +
          "kind=market: .claude-plugin/marketplace.json 을 가진 레포를 카탈로그로 등록. 매니페스트만 sparse checkout 한다(공식 마켓 기준 401K, 전체 체크아웃은 9.7M). 플러그인은 선택 시점에 받는다. 공식/비공식 구분은 없다 — URL 이 전부다",
        inputSchema: z.object({
          kind: z.enum(["remote", "market"]).describe("remote=git 레포를 라이브러리로, market=마켓플레이스 카탈로그로"),
          url: z.string().describe("remote 는 git 레포 URL(https/ssh/file), market 은 마켓 레포 URL. config-monitor 는 이 URL 을 심사하지 않는다"),
          ref: z.string().optional().describe("브랜치/태그. 생략 시 기본 HEAD"),
          id: z.string().optional().describe("라이브러리/마켓 id. 생략 시 URL 의 레포명에서 파생"),
          map: z.string().optional().describe('kind=remote 전용. 레이아웃 매핑 JSON, 예: {"agents":"Agents","skills":"Skills"}. 탐지 실패 시에만 필요. kind=market 에 주면 거부한다(마켓은 매니페스트가 레이아웃을 정한다)'),
        }), annotations: EDIT,
      },
      run: async (a: { kind: "remote" | "market"; url: string; ref?: string; id?: string; map?: string }) => {
        if (a.kind === "market" && a.map) {
          return jsonResult(JSON.stringify({ ok: false, code: "invalid_arg", message: "map 은 kind=remote 에서만 쓸 수 있습니다. 마켓은 marketplace.json 매니페스트가 레이아웃을 정합니다" }));
        }
        const args = [a.kind === "market" ? "market-add" : "remote-add", "--url", a.url];
        if (a.ref) args.push("--ref", a.ref);
        if (a.id) args.push("--id", a.id);
        if (a.map) args.push("--map", a.map);
        return jsonResult(await runPy("library.py", args));
      },
    },
    {
      name: "claude_plugin_install",
      meta: {
        title: "Install Plugin into Claude Code",
        description: "플러그인을 **통째로** Claude Code 에 설치한다 — `claude plugin install <plugin>@<market> --scope` 위임. library_plugin_fetch(항목 단위로 골라 ~/.claude 에 복사, 설치 전 diff·롤백 O, Desktop 가능)와는 **다른 설치 모델**이다: 이쪽은 플러그인 캐시에 통째로 두고 <ns>:<item> 네임스페이스로 주입되며 config_plugin_toggle 로 껐다 켠다. **네트워크를 탄다.** 적용은 다음 세션부터. scope=project/local 은 cwd 로 프로젝트를 정하므로 cwd 를 넘길 것. dryRun 으로 실행될 명령을 먼저 확인할 수 있다",
        inputSchema: z.object({
          marketplace: z.string(), plugin: z.string(),
          scope: z.enum(["user", "project", "local"]).optional(),
          cwd: z.string().optional().describe("scope=project/local 기준 디렉토리"),
          dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { marketplace: string; plugin: string; scope?: string; cwd?: string; dryRun?: boolean }) => {
        const args = ["install", "--marketplace", a.marketplace, "--plugin", a.plugin,
          "--scope", a.scope || "user"];
        if (a.cwd) args.push("--cwd", a.cwd);
        if (a.dryRun) args.push("--dry-run");
        return jsonResult(await runPy("plugin_cli.py", args));
      },
    },
    {
      name: "claude_plugin_uninstall",
      meta: {
        title: "Uninstall Plugin from Claude Code",
        description: "`claude plugin uninstall <plugin>@<market> --scope -y` 위임. Library 로 설치한 **항목**은 건드리지 않는다(모델이 다르다 — 그쪽은 library_uninstall). **끄기만 하려면 지우지 말고 config_plugin_toggle 을 쓸 것.** keepData 는 ~/.claude/plugins/data/<id>/ 를 남긴다",
        inputSchema: z.object({
          marketplace: z.string(), plugin: z.string(),
          scope: z.enum(["user", "project", "local"]).optional(),
          keepData: z.boolean().optional(),
          cwd: z.string().optional(), dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { marketplace: string; plugin: string; scope?: string; keepData?: boolean; cwd?: string; dryRun?: boolean }) => {
        const args = ["uninstall", "--marketplace", a.marketplace, "--plugin", a.plugin,
          "--scope", a.scope || "user"];
        if (a.keepData) args.push("--keep-data");
        if (a.cwd) args.push("--cwd", a.cwd);
        if (a.dryRun) args.push("--dry-run");
        return jsonResult(await runPy("plugin_cli.py", args));
      },
    },
    {
      name: "claude_plugin_update",
      meta: {
        title: "Update Claude Code Plugin",
        description: "`claude plugin update <plugin>@<market> --scope` 위임. **네트워크를 탄다**. 적용은 다음 세션부터. scope 는 update 만 managed 를 추가로 받는다. Library 로 가져온 플러그인의 갱신은 이것과 무관하다 — 그쪽은 library_fetch(고정 sha 갱신 + 설치 전 diff)",
        inputSchema: z.object({
          marketplace: z.string(), plugin: z.string(),
          scope: z.enum(["user", "project", "local", "managed"]).optional(),
          cwd: z.string().optional(), dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { marketplace: string; plugin: string; scope?: string; cwd?: string; dryRun?: boolean }) => {
        const args = ["update", "--marketplace", a.marketplace, "--plugin", a.plugin,
          "--scope", a.scope || "user"];
        if (a.cwd) args.push("--cwd", a.cwd);
        if (a.dryRun) args.push("--dry-run");
        return jsonResult(await runPy("plugin_cli.py", args));
      },
    },
    {
      name: "claude_marketplace_add",
      meta: {
        title: "Register Marketplace in Claude Code",
        description: "`claude plugin marketplace add <source> --scope` 위임 — 대시보드에서 등록한 마켓을 Claude Code 쪽에도 올린다(export). source 는 owner/repo · git URL · marketplace.json URL · 로컬 경로 4형식. **scope=project 는 프로젝트 .claude/settings.json 에 선언이 들어가 팀에 공유된다** — cwd 로 그 프로젝트를 지정할 것. config-monitor 자기 스토어에 등록하는 건 library_add(kind=market) 로, 별개다(캐시를 각자 유지한다)",
        inputSchema: z.object({
          source: z.string(),
          scope: z.enum(["user", "project", "local"]).optional(),
          sparse: z.array(z.string()).optional().describe("모노레포에서 체크아웃할 디렉토리"),
          cwd: z.string().optional(), dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { source: string; scope?: string; sparse?: string[]; cwd?: string; dryRun?: boolean }) => {
        const args = ["market-add", a.source, "--scope", a.scope || "user"];
        if (a.sparse && a.sparse.length) args.push("--sparse", ...a.sparse);
        if (a.cwd) args.push("--cwd", a.cwd);
        if (a.dryRun) args.push("--dry-run");
        return jsonResult(await runPy("plugin_cli.py", args));
      },
    },
    {
      name: "claude_marketplace_update",
      meta: {
        title: "Update Claude Code Marketplace",
        description: "`claude plugin marketplace update [name]` 위임. name 을 생략하면 **등록된 마켓 전체**를 갱신한다. **네트워크를 탄다**. 매니페스트만 갱신하며 설치된 플러그인 버전은 그대로다(그건 claude_plugin_update)",
        inputSchema: z.object({
          name: z.string().optional().describe("생략하면 전체"),
          cwd: z.string().optional(), dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { name?: string; cwd?: string; dryRun?: boolean }) => {
        const args = ["market-update"];
        if (a.name) args.push("--name", a.name);
        if (a.cwd) args.push("--cwd", a.cwd);
        if (a.dryRun) args.push("--dry-run");
        return jsonResult(await runPy("plugin_cli.py", args));
      },
    },
    {
      name: "claude_marketplace_remove",
      meta: {
        title: "Remove Claude Code Marketplace",
        description: "`claude plugin marketplace remove <name>` 위임. **scope 를 생략하면 모든 스코프의 선언을 지운다**(claude 기본). 그 마켓에서 설치한 플러그인이 남아 있으면 claude 가 거절하거나 경고할 수 있으니 stderr 를 그대로 보고할 것. config-monitor 스토어의 마켓 해제는 library_unregister 로, 별개다",
        inputSchema: z.object({
          name: z.string(),
          scope: z.enum(["user", "project", "local"]).optional().describe("생략하면 모든 스코프"),
          cwd: z.string().optional(), dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { name: string; scope?: string; cwd?: string; dryRun?: boolean }) => {
        const args = ["market-remove", "--name", a.name];
        if (a.scope) args.push("--scope", a.scope);
        if (a.cwd) args.push("--cwd", a.cwd);
        if (a.dryRun) args.push("--dry-run");
        return jsonResult(await runPy("plugin_cli.py", args));
      },
    },
    {
      name: "plugin_catalog",
      meta: {
        title: "Plugin Inventory and Token Cost",
        description: "Claude Code 가 캐시해 둔 ~/.claude/plugins/plugin-catalog-cache.json 을 읽을 뿐이라 **네트워크도 fetch 도 타지 않는다.** 다만 그 캐시는 **공식 마켓 전용**이라 다른 마켓 플러그인은 조회되지 않는다(오류가 아니다 — 그 경우 fetch 해야 개수를 알 수 있다). " +
          "id 없음: 카탈로그 행을 채우기 위한 경량 맵 — {entries: {id: {installs, components: {kind: 개수}, total}}}. 컴포넌트 **이름은 담지 않는다**(255개 전부는 크다) — 이름이 필요하면 id 를 준다. " +
          "id 있음: 설치 **전에** 그 플러그인이 무엇을 넣는지와 토큰 비용을 돌려준다 — components(commands/agents/skills/hooks/mcpServers/lspServers 이름), unique_installs, tokens(모델별 always_on / on_invoke), homepage, last_updated",
        inputSchema: z.object({
          id: z.string().optional().describe("<plugin>@<marketplace>. 주면 그 플러그인 하나의 상세(컴포넌트 이름 포함), 생략하면 전체 요약(개수만)"),
          cache: z.string().optional(),
        }), annotations: READ,
      },
      run: async (a: { id?: string; cache?: string }) => {
        const args = a.id ? ["details", a.id] : ["summary"];
        if (a.cache) args.push("--cache", a.cache);
        return jsonResult(await runPy("plugin_catalog.py", args));
      },
    },
    {
      name: "library_market_discover",
      meta: {
        title: "Discover Marketplaces from Claude Code",
        description: "Claude Code(`/plugins`)에 등록된 마켓플레이스를 읽어 이 스토어와 대조한다. **네트워크를 타지 않는다** — known_marketplaces.json 하나만 읽고, 실제 등록은 사용자가 후보를 골라 library_add(kind=market) 를 눌렀을 때만 일어난다. new=가져올 수 있는 것 / both=양쪽 등록(두 도구가 같은 레포를 각자 캐시에 다른 시점으로 들고 있으므로 sha·시각을 나란히 돌려준다) / unusable=URL 이 없어 가져올 수 없는 것",
        inputSchema: z.object({
          pluginsDir: z.string().optional().describe("기본 ~/.claude/plugins"),
        }), annotations: READ,
      },
      run: async (a: { pluginsDir?: string }) => {
        const args = ["market-discover"];
        if (a.pluginsDir) args.push("--plugins-dir", a.pluginsDir);
        return jsonResult(await runPy("library.py", args));
      },
    },
    {
      name: "library_catalog",
      meta: {
        title: "Browse Marketplace Catalog",
        description: "등록된 마켓플레이스의 플러그인 목록(name/description/category/author)과 마켓 요약(marketplaces[]: id/name/url/total). **네트워크를 타지 않는다** — 캐시된 매니페스트만 읽는다. '설치 가능 N개' 칼럼은 없다(컴포넌트 선언 엔트리가 4/278 뿐이라 fetch 전에는 알 수 없음)",
        inputSchema: z.object({
          marketplace: z.string().optional().describe("지정 시 그 마켓만 — 마켓별로 따로 페이징할 때 쓴다"),
          query: z.string().optional(),
          category: z.string().optional(),
          limit: z.number().int().optional().describe("음수면 행 없이 요약(marketplaces/categories)만 반환"),
          offset: z.number().int().optional(),
        }), annotations: READ,
      },
      run: async (a: { marketplace?: string; query?: string; category?: string; limit?: number; offset?: number }) => {
        const args = ["catalog"];
        if (a.marketplace) args.push("--marketplace", a.marketplace);
        if (a.query) args.push("--query", a.query);
        if (a.category) args.push("--category", a.category);
        if (a.limit !== undefined) args.push("--limit", String(a.limit));
        if (a.offset !== undefined) args.push("--offset", String(a.offset));
        return jsonResult(await runPy("library.py", args));
      },
    },
    {
      name: "library_plugin_fetch",
      meta: {
        title: "Fetch Marketplace Plugin",
        description: "카탈로그의 플러그인 1개를 물질화해 Library 에 합류시킨다. 번들이면 마켓 레포의 sparse 집합을 확장(+42K), 외부면 그 플러그인만 별도 fetch(~444K). **네트워크를 탄다**. 고정 sha 로 받으며 반환에 실제 컴포넌트 개수와 hooks/MCP 보유 여부가 담긴다",
        inputSchema: z.object({ marketplace: z.string(), plugin: z.string() }), annotations: EDIT,
      },
      run: async (a: { marketplace: string; plugin: string }) =>
        jsonResult(await runPy("library.py",
          ["plugin-fetch", "--marketplace", a.marketplace, "--plugin", a.plugin])),
    },
    {
      name: "library_fetch",
      meta: {
        title: "Refresh Remote/Marketplace",
        description: "등록된 remote/market 을 명시적으로 갱신한다. 자동 pull 은 없다 — hooks 라면 매 세션 실행되는 코드가 조용히 바뀌는 것이므로 사용자가 눌러야 한다. origin 형식: remote:<id> / market:<id> / market:<id>/<plugin>",
        inputSchema: z.object({ origin: z.string().describe("remote:<id> | market:<id> | market:<id>/<plugin>") }),
        annotations: EDIT,
      },
      run: async (a: { origin: string }) =>
        jsonResult(await runPy("library.py", ["fetch", "--origin", a.origin])),
    },
    {
      name: "library_hooks_install",
      meta: {
        title: "Install Plugin Hooks",
        description: "플러그인의 hooks/hooks.json 을 settings.json 에 병합한다. ${CLAUDE_PLUGIN_ROOT} 를 절대 캐시 경로로 치환하므로 **캐시는 지우면 안 된다**(load-bearing). matcher·timeout 을 그대로 보존하고 같은 플러그인의 기존 엔트리는 먼저 걷어낸다(멱등). **네트워크를 타지 않는다** — 미물질화 플러그인이면 거부하고 fetch 를 먼저 요구한다. dryRun 으로 치환된 명령 원문과 인터프리터 경고를 먼저 확인할 것",
        inputSchema: z.object({
          origin: z.string().describe("remote:<id> | market:<id>/<plugin>"),
          settings: z.string().optional().describe("대상 settings.json(기본 <targetDir>/settings.json)"),
          targetDir: z.string().optional(),
          dryRun: z.boolean().optional().describe("쓰지 않고 치환된 명령·경고만 반환"),
        }), annotations: EDIT,
      },
      run: async (a: { origin: string; settings?: string; targetDir?: string; dryRun?: boolean }) => {
        const args: string[] = [];
        if (a.targetDir) args.push("--target", a.targetDir);
        args.push("hooks-install", "--origin", a.origin);
        if (a.settings) args.push("--settings", a.settings);
        if (a.dryRun) args.push("--dry-run");
        return jsonResult(await runPy("library.py", args));
      },
    },
    {
      name: "library_hooks_uninstall",
      meta: {
        title: "Uninstall Plugin Hooks",
        description: "settings.json 에서 이 플러그인의 hook 엔트리를 걷어낸다. needle 은 원장에 기록된 root 라 sha 가 바뀐 뒤에도 정확하다. 캐시 디렉토리는 지우지 않는다(다른 항목이 참조할 수 있음)",
        inputSchema: z.object({
          origin: z.string(), settings: z.string().optional(), targetDir: z.string().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { origin: string; settings?: string; targetDir?: string }) => {
        const args: string[] = [];
        if (a.targetDir) args.push("--target", a.targetDir);
        args.push("hooks-uninstall", "--origin", a.origin);
        if (a.settings) args.push("--settings", a.settings);
        return jsonResult(await runPy("library.py", args));
      },
    },
    {
      name: "library_mcp_install",
      meta: {
        title: "Install Plugin MCP Servers",
        description: "플러그인의 .mcp.json 서버를 설치. scope=user 는 ~/.claude.json, scope=desktop 은 claude_desktop_config.json(Desktop 재시작 필요). **Claude Desktop 에는 /plugin 마켓플레이스가 없어서 플러그인의 MCP 서버를 Desktop 에 꽂는 경로는 이것뿐이다.** ${CLAUDE_PLUGIN_ROOT} 치환은 hooks 와 동일. **네트워크를 타지 않는다** — 미물질화면 거부",
        inputSchema: z.object({
          origin: z.string(), server: z.string().optional().describe("생략 시 전부"),
          scope: z.enum(["user", "desktop"]).optional(), targetDir: z.string().optional(),
          dryRun: z.boolean().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { origin: string; server?: string; scope?: string; targetDir?: string; dryRun?: boolean }) => {
        const args: string[] = [];
        if (a.targetDir) args.push("--target", a.targetDir);
        args.push("mcp-install", "--origin", a.origin, "--scope", a.scope || "user");
        if (a.server) args.push("--server", a.server);
        if (a.dryRun) args.push("--dry-run");
        return jsonResult(await runPy("library.py", args));
      },
    },
    {
      name: "library_mcp_uninstall",
      meta: {
        title: "Uninstall Plugin MCP Servers",
        description: "원장에 기록된 서버 이름만 제거한다. 사용자가 직접 넣은 동명 서버는 건드리지 않는다",
        inputSchema: z.object({
          origin: z.string(), server: z.string().optional(),
          scope: z.enum(["user", "desktop"]).optional(), targetDir: z.string().optional(),
        }), annotations: EDIT,
      },
      run: async (a: { origin: string; server?: string; scope?: string; targetDir?: string }) => {
        const args: string[] = [];
        if (a.targetDir) args.push("--target", a.targetDir);
        args.push("mcp-uninstall", "--origin", a.origin, "--scope", a.scope || "user");
        if (a.server) args.push("--server", a.server);
        return jsonResult(await runPy("library.py", args));
      },
    },

    // ----- 브라우저 열기 -----
    {
      name: "open_in_browser",
      meta: {
        title: "Open Live Dashboard in Browser",
        description: "[UI 전용] 라이브 대시보드 HTTP 서버(기본 3002)를 필요시 기동하고 사용자의 기본 브라우저에서 연다. 대화에서 설정을 읽거나 고칠 때는 쓰지 않는다",
        inputSchema: z.object({ port: z.number().optional() }), annotations: WRITE,
      },
      run: async (a: { port?: number }) => {
        const port = a.port || Number(process.env.PORT || 3002);
        // 서버가 127.0.0.1 에만 바인딩하므로 주소도 맞춘다. 'localhost' 는 Windows 에서 ::1 로
        // 먼저 해석될 수 있어, IPv4 전용 리스너에 프로브/브라우저가 못 붙는 경우가 생긴다.
        const url = `http://127.0.0.1:${port}/`;
        const log = path.join(STORE, "dashboard-server.log");
        let up = await fetch(url).then((r) => r.ok).catch(() => false);
        if (!up) {
          // 이 프로세스를 띄운 node 로 tsx 를 직접 실행한다(npx·cmd·PowerShell 을 거치지 않음).
          // Claude Desktop 은 MCP 서버에 PATHEXT 없는 최소 환경만 넘기는데, 그 환경에서 PowerShell 은
          // PATHEXT=.CPL 을 채워 넣고 자식 cmd 는 npx.cmd 를 못 찾는다("'npx'은(는) ... 아닙니다").
          // 실행 파일 경로를 직접 주면 확장자 탐색 자체가 없어 환경에 좌우되지 않는다.
          // stderr 는 스토어의 로그로 받는다 - 안 뜨는 이유가 어디에도 남지 않던 것이 진단을 막았다.
          const tsx = path.join(scriptDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
          const srv = path.join(scriptDir, "server.ts");
          let fh: fs.FileHandle | null = null;
          try {
            await fs.mkdir(STORE, { recursive: true });
            fh = await fs.open(log, "a");
          } catch { /* 로그를 못 열어도 기동은 시도한다 */ }
          const out: number | "ignore" = fh ? fh.fd : "ignore";
          const child = spawn(process.execPath, [tsx, srv], {
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
        if (!up) return jsonResult(JSON.stringify({ ok: false, code: "server_unreachable", target: String(port), message: `대시보드 서버가 ${port} 에서 응답하지 않습니다. 기동 로그: ${log}`, url, log }));
        openInBrowser(url);
        return jsonResult(JSON.stringify({ ok: true, code: "ok", message: "라이브 대시보드 브라우저 열기", url }));
      },
    },
  ];
  return defs.map(decorate);

  // 실행 중인 watcher 프로세스를 모두 종료(좀비/중복 정리).
  // watcher.py(python) 가 대상. 구버전 watcher.ps1 상주분도 함께 정리한다.
  // 커맨드라인 매칭만 쓰면 'watcher.py' 를 인자 문자열로 품은 무관한 셸(이 kill 명령 자신을
  // 감싼 셸 포함)까지 죽는다 - 프로세스 이름(python/py, powershell)을 함께 걸고, python 쪽은
  // **이 설치본의 watcher.py 전체 경로**로만 매칭한다(다른 프로젝트의 동명 스크립트 오살 방지.
  // watcher_start 가 같은 forward-slash 경로로 기동하므로 커맨드라인에 그대로 남는다).
  async function killWatchers(): Promise<void> {
    if (process.platform !== "win32") return;
    const wpy = path.join(scriptDir, "watcher.py").replace(/\\/g, "/").replace(/'/g, "''");
    const cmd = "Get-CimInstance Win32_Process | Where-Object { " +
      `((($_.Name -like 'python*') -or ($_.Name -eq 'py.exe')) -and $_.CommandLine -like '*${wpy}*') -or ` +
      "(($_.Name -eq 'powershell.exe') -and $_.CommandLine -like '*-File*watcher.ps1*') } | " +
      "Where-Object { $_.ProcessId -ne $PID } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    await pexec("powershell.exe", ["-NoProfile", "-Command", cmd]).catch(() => {});
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
    description: "Claude 설정 모니터 대시보드(설정 카드 + 파일 클릭 시 diff history) 열기",
    inputSchema: {},
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  }, async () => text("Config monitor dashboard opened."));

  registerAppResource(server, RESOURCE_URI, RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    const html = await fs.readFile(path.join(scriptDir, "dist", "dashboard.html"), "utf-8");
    // 위젯 iframe 은 localStorage 가 막힐 수 있어 저장된 언어 선택이 남지 않는다 -> env 로 시작 언어 지정.
    return { contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html.replace("<head>", "<head>" + langScript()) }] };
  });
}
