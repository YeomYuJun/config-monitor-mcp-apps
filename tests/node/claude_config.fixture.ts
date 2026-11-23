// claude_config 를 기준 출력(tests/golden)이 다루지 않는 표면까지 걸어 보는 고정 픽스처.
// 플러그인(ok/disabled/project/missing/stale), Desktop manifest 글롭, 워크플로, 테마, 스케줄, 프로젝트 메모리를 담는다.
// 기대값은 Python 판 출력을 저장한 fixtures/claude_config.xcheck.json 이고, 다시 만들 때만
// claude_config.xcheck.capture.ts 로 Python 을 부른다.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXPECTED = path.join(REPO, "tests", "node", "fixtures", "claude_config.xcheck.json");

/** 저장소 드라이브의 cmg-<8 hex>. 길이가 고정이라 160자 절단이 들어가는 값이 실행마다 같다. */
export function makeRoot(): string {
  return path.join(path.parse(REPO).root, `cmg-${randomBytes(4).toString("hex")}`);
}

export interface Fixture {
  root: string;
  env: Record<string, string>;
  cases: string[][];
}

export function build(root: string): Fixture {
  const home = path.join(root, "home");
  const w = (rel: string, body: string | object = "") => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
    return p;
  };
  const C = "home/.claude";
  w(`${C}/settings.json`, { outputStyle: "concise", enabledPlugins: { "sp@m": true, "off@m": false, "ghost@x": true },
    hooks: { Stop: [{ hooks: [{ command: "echo s" }, "bad"] }, null] } });
  w(`${C}/settings.local.json`, { permissions: { allow: ["A"], deny: null } });
  w(`${C}/skills/zeta/SKILL.md`, "---\r\ndescription: \"crlf desc\"\r\n---\r\n");
  w(`${C}/skills/Alpha/README.md`, "x");
  w(`${C}/skills/synced/SKILL.md`, "");
  w(`${C}/agents/dirform/AGENT.md`, "---\nname: dir-agent\ntools: Read\n---\n");
  w(`${C}/agents/nest/deep.md`, "---\ndescription: " + "y".repeat(700) + "\n---\n");
  w(`${C}/workflows/Ship.JS`, "x");
  w(`${C}/workflows/a.js`, "x");
  w(`${C}/themes/dark.json`, "{}");
  w(`${C}/agent-memory/sub/note.md`, "---\ndescription: n\n---\n");
  w(`${C}/output-styles/concise.md`, "---\ndescription: c\n---\n");
  w("home/Claude/Scheduled/daily/SKILL.md", "---\ndescription: d\ncron: 0 9 * * *\n---\n");
  w("home/Claude/Scheduled/fire/SKILL.md", "---\nfireAt: soon\n---\n");
  const DD = "home/AppData/Roaming/Claude";
  w(`${DD}/claude_desktop_config.json`, { mcpServers: { a: { command: "npx", args: [1, true, null, { k: "v" }], env: { X: "1" } }, r: { type: "sse" } } });
  w(`${DD}/local-agent-mode-sessions/skills-plugin/s1/manifest.json`, { skills: [
    { skillId: "k1", name: "b", creatorType: "anthropic", updatedAt: "2" }, { skillId: "k2", name: "a", creatorType: "user", enabled: true }] });
  w(`${DD}/local-agent-mode-sessions/skills-plugin/s2/deep/manifest.json`, { skills: [{ skillId: "k1", name: "b2", creatorType: "anthropic", updatedAt: "3" }] });
  w(`${DD}/local-agent-mode-sessions/skills-plugin/.hid/manifest.json`, { skills: [{ skillId: "h", name: "hidden" }] });
  w("home/.claude.json", { mcpServers: { g: { command: "node", args: ["x"] } }, oauthAccount: { a: 1 }, projects: {
    [path.join(root, "proj").replace(/\\/g, "/")]: { allowedTools: ["a", "b"], mcpServers: { m: {} }, hasTrustDialogAccepted: false },
    [path.join(root, "gone")]: null } });
  const P = "proj/.claude";
  w(`${P}/settings.json`, { enabledPlugins: { "proj@m": true }, permissions: { ask: ["Q"] } });
  w(`${P}/agents/planner.md`, "---\nname: planner\n---\n");
  w(`${P}/rules/r.md`, "---\npaths: x\n---\n");
  w(`${P}/workflows/w.js`, "");
  w(`${P}/agent-memory-local/m.md`, "");
  w("proj/.worktreeinclude", ".env\n");
  w("proj/CLAUDE.local.md", "x");
  const enc = path.join(root, "proj").replace(/[^A-Za-z0-9]/gu, "-");
  w(`${C}/projects/${enc}/memory/MEMORY.md`, "x");
  w(`${C}/projects/${enc}/memory/topic.md`, "---\ndescription: t\n---\n");
  const PD = `${C}/plugins`;
  const sp = path.join(root, PD, "cache/m/sp/1.0.0");
  w(`${PD}/cache/m/sp/1.0.0/.claude-plugin/plugin.json`, { name: "Sp", version: "9", homepage: "h" });
  w(`${PD}/cache/m/sp/1.0.0/skills/s/SKILL.md`, "---\ndescription: ps\n---\n");
  w(`${PD}/cache/m/sp/1.0.0/commands/ns/c.md`, "");
  w(`${PD}/cache/m/sp/1.0.0/rules/pr.md`, "---\ndescription: pr\n---\n");
  w(`${PD}/cache/m/sp/1.0.0/workflows/pw.js`, "");
  w(`${PD}/cache/m/sp/1.0.0/hooks/hooks.json`, { hooks: { Pre: [{ hooks: [{ command: "a" }, { command: "b" }] }], Post: [] } });
  w(`${PD}/cache/m/sp/1.0.0/.mcp.json`, { mcpServers: { s1: { command: "uvx", args: ["q"] }, s0: null } });
  const off = path.join(root, PD, "cache/m/off/1.0.0");
  w(`${PD}/cache/m/off/1.0.0/skills/o/SKILL.md`, "");
  const proj = path.join(root, PD, "cache/m/proj/1.0.0");
  w(`${PD}/cache/m/proj/1.0.0/agents/pa.md`, "---\nname: proj-agent\n---\n");
  w(`${PD}/installed_plugins.json`, { version: 2, plugins: {
    "sp@m": [{ scope: "user", installPath: sp, version: "1" }],
    "off@m": [{ scope: "project", projectPath: "D:\\x", installPath: off }],
    "proj@m": [{ scope: "local", installPath: proj }],
    "gone@m": [{ installPath: path.join(root, "nowhere") }],
  } });
  w(`${PD}/known_marketplaces.json`, { m: { source: { source: "github", repo: "o/r" }, installLocation: "L" } });

  const systemp = path.join(root, "systemp");
  fs.mkdirSync(systemp, { recursive: true });
  const cdir = path.join(root, P);
  return {
    root,
    env: {
      TEMP: systemp, TMP: systemp, TMPDIR: systemp, USERPROFILE: home, HOME: home,
      APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    },
    cases: [
      ["dump", "--projects", cdir],
      ["summary", "--projects", cdir],
      ["dump", "--projects", cdir, "--query", "SP", "--compact"],
      ["dump", "--projects", cdir, "--scope", "global", "--sections", "plugins", "agents"],
      ["projects", "--include-missing"],
      ["dump", "--projects"],
    ],
  };
}

/** 루트 경로를 <ROOT> 로, 그 인코딩을 <ROOT-ENC> 로 바꾸고 실행 시각(generated)을 뺀다. */
export function normalize(doc: unknown, root: string): unknown {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reps: [RegExp, string][] = [
    [new RegExp(esc(root), "gi"), "<ROOT>"],
    [new RegExp(esc(root.replace(/\\/g, "/")), "gi"), "<ROOT>"],
    [new RegExp(esc(root.replace(/[^A-Za-z0-9]/gu, "-")), "gi"), "<ROOT-ENC>"],
  ];
  const str = (s: string) => reps.reduce((a, [re, to]) => a.replace(re, to), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (k !== "generated") out[str(k)] = walk(x);
      return out;
    }
    return v;
  };
  return walk(doc);
}
