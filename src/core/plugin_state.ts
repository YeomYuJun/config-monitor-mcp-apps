// plugin_state.ts - Claude Code 플러그인 레지스트리 조회(읽기 전용). src/plugin_state.py 이식.
//
// 대시보드가 플러그인에 대해 장님이었다: claude_config 는 ~/.claude/skills 만 보는데
// 플러그인이 주는 스킬/에이전트/커맨드/hooks/MCP 는 ~/.claude/plugins/cache/ 에 있다.
// "지금 실제로 적용된 게 뭐냐"에 답하려면 이쪽도 읽어야 한다.
//
// 순수 리더다: 네트워크·git·프로세스를 타지 않는다(lib_store / plugin_units 와 같은 규율).
// `claude plugin list --json` 을 부르지 않는 이유 - scan 경로에 프로세스 기동을 들이지 않고,
// claude 가 PATH 에 없어도 동작해야 하며, 필요한 hooks/MCP 리더가 plugin_units 에 이미 있다.
//
// id 와 ns 는 다르다. 서로에서 유도하지 말 것. 실측(notion):
//     마켓 매니페스트 엔트리 name : "notion"                          <- 소문자
//     plugin.json           name : "Notion"                          <- 대문자
//     enabledPlugins 키           : "notion@claude-plugins-official"  <- 매니페스트 쪽
//     세션 표시                    : "Notion:create-page"             <- plugin.json 쪽
// id 는 토글 키(enabledPlugins / installed_plugins.json 이 쓰는 키)이고 ns 는 표시
// 네임스페이스다. 하나로 합치면 notion 에서 토글이 조용히 no-op 한다.
//
// claude_config 를 import 하지 않는다(역방향 의존이라 순환이 된다). 프론트매터 해석은
// 호출부(claude_config)가 자기 readFrontmatter 로 하고, 여기서는 항목의 이름과 경로만 준다.
import fs from "node:fs";
import path from "node:path";
import { compareCodePoints } from "./cli_result.ts";
import { expanduser } from "./paths.ts";
// 순수 모듈(네트워크/git 없음) - hooks.json / .mcp.json 리더 재사용
import {
  isDict, isLoadError, loadHooksJson, loadJsonSig, loadMcpJson, or, pyExists, pyGet, pyIsdir, pyItems, pyIter,
  pyJoin, pyLen, pyStrip, truthy, withinOnce,
} from "./plugin_units.ts";

export const INSTALLED_REL = "installed_plugins.json";
export const MARKETS_REL = "known_marketplaces.json";
export const PLUGIN_JSON_REL = path.join(".claude-plugin", "plugin.json");

// 컴포넌트 디렉토리. Claude Code 가 읽는 이름 그대로.
const SKILLS_DIR = "skills", AGENTS_DIR = "agents", COMMANDS_DIR = "commands";
// 플러그인이 이 표면들을 내놓는 사례는 아직 실측되지 않았다. 나올 때 어느 섹션에도
// 안 잡히는 상황을 막으려고 미리 걷는다 - 없으면 빈 리스트라 비용이 없다.
const RULES_DIR = "rules", STYLES_DIR = "output-styles", WORKFLOWS_DIR = "workflows";

export interface InstalledRec {
  scope: string;
  project_path: string | null;
  root: string | null;
  version: string | null;
  installed_at: string | null;
  sha: string | null;
  scopes: (string | null)[];
}

export interface MarketRec {
  kind: string | null;
  repo: string | null;
  url: string | null;
  path: string | null;
  location: string | null;
  updated: string | null;
}

export interface PluginRecord {
  id: string;
  name: string;
  ns: string;
  market: string;
  market_src: unknown;
  version: string | null;
  desc: string;
  homepage: string | null;
  scope: string;
  project_path: string | null;
  root: string | null;
  enabled: boolean;
  enabled_explicit: boolean;
  enabled_from: string | null;
  state: "ok" | "disabled" | "missing" | "stale";
  items: Record<string, unknown[]>;
}

/** Python DEFAULT_PLUGINS_DIR(~/.claude/plugins). 호출 시점의 홈으로 만든다. */
export function defaultPluginsDir(): string {
  return pyJoin(expanduser("~"), ".claude", "plugins");
}

/** 읽기 실패를 예외로 만들지 않는다 - scan 경로는 파일 하나가 깨져도 계속 돌아야 한다. */
function load(p: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = loadJsonSig(p);
  } catch (e) {
    if (isLoadError(e)) return {};
    throw e;
  }
  return isDict(data) ? data : {};
}

const emptyItems = (): Record<string, unknown[]> => ({ skills: [], agents: [], commands: [], hooks: [], mcp: [] });

// ----- 레지스트리 3종 -----

/**
 * installed_plugins.json -> {id: {scope, root, version, installed_at, sha}}.
 *
 * 형식은 {"version": 2, "plugins": {id: [ {...}, ... ]}} 로 값이 배열이다
 * (같은 플러그인을 user/project 로 각각 설치할 수 있다). 실측은 전부 1개짜리라
 * 첫 항목을 대표로 쓰고, 2개 이상이면 scopes 에 전부 남겨 UI 가 표시할 수 있게 한다.
 */
export function readInstalled(pdir: string): Record<string, InstalledRec> {
  const raw = pyGet(load(pyJoin(pdir, INSTALLED_REL)), "plugins");
  const out: Record<string, InstalledRec> = {};
  if (!isDict(raw)) return out;
  for (const [pid, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries) || !entries.length) continue;
    const e = isDict(entries[0]) ? entries[0] : {};
    const rec = {
      scope: or(pyGet(e, "scope"), "user"),
      // project/local 스코프 설치는 cwd 로 프로젝트를 정한다(claude 에 경로 인자가
      // 없다). 원장이 그 경로를 projectPath 로 들고 있으므로 그대로 꺼내 둔다 - 이게
      // 없으면 제거/갱신이 어느 프로젝트를 향해야 하는지 알 수 없어 user 로 흘러가고,
      // claude 는 "project 스코프에 있다"며 정확히 거절한다(실측).
      project_path: or(pyGet(e, "projectPath"), ""),
      root: or(pyGet(e, "installPath"), ""),
      version: or(pyGet(e, "version"), ""),
      installed_at: or(pyGet(e, "installedAt"), ""),
      sha: or(pyGet(e, "gitCommitSha"), ""),
      scopes: entries.filter(isDict).map((x) => pyGet(x, "scope")),
    } as InstalledRec;
    Object.defineProperty(out, pid, { value: rec, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * known_marketplaces.json -> {name: {kind, repo, url, path, location, updated}}.
 *
 * kind 는 Claude Code 의 source 종류다(실측: url · github · git · npm · file · directory ·
 * skills-dir · settings · seeded · unsupported). import 제안(§마켓 import)이 URL 을
 * 필요로 하므로 github 은 여기서 URL 로 펴 주고, 나머지는 있는 그대로 넘긴다 -
 * URL 이 없는 이유가 종류마다 다르므로(로컬 경로 / npm 패키지 / settings 선언) 호출부가
 * kind 와 path 를 보고 사유를 말할 수 있어야 한다.
 */
export function readMarkets(pdir: string): Record<string, MarketRec> {
  const out: Record<string, MarketRec> = {};
  for (const [name, rec] of Object.entries(or(load(pyJoin(pdir, MARKETS_REL)), {}))) {
    if (!isDict(rec)) continue;
    const srcRaw = pyGet(rec, "source");
    const src = isDict(srcRaw) ? srcRaw : {};
    const kind = or(pyGet(src, "source"), "");
    const repo = or(pyGet(src, "repo"), "");
    const url = or(pyGet(src, "url"), kind === "github" && truthy(repo) ? `https://github.com/${pyFormat(repo)}.git` : "");
    const m = {
      kind,
      repo,
      url,
      path: or(pyGet(src, "path"), ""),
      location: or(pyGet(rec, "installLocation"), ""),
      updated: or(pyGet(rec, "lastUpdated"), ""),
    } as MarketRec;
    Object.defineProperty(out, name, { value: m, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** f-string 의 {repo}: str() 과 같다. */
function pyFormat(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null || v === undefined) return "None";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * settings.json 들의 enabledPlugins 를 병합 -> {id: {"on": bool, "from": path}}.
 *
 * settingsFiles 는 우선순위 오름차순으로 받는다(전역 먼저, 프로젝트 나중).
 * 뒤가 이기고, 이긴 파일 경로를 from 에 남긴다 - 토글이 그 파일을 대상으로 삼아야
 * 프로젝트에서 켠 것을 전역 카드에서 껐다가 안 먹는 상황이 안 생긴다.
 */
export function readEnabled(settingsFiles: string[]): Record<string, { on: boolean; from: string }> {
  const out: Record<string, { on: boolean; from: string }> = {};
  for (const p of settingsFiles || []) {
    if (!p || !pyExists(p)) continue;
    for (const [pid, val] of pyItems(or(pyGet(load(p), "enabledPlugins"), {}))) {
      if (typeof val === "boolean") {
        Object.defineProperty(out, pid, { value: { on: val, from: p }, enumerable: true, writable: true, configurable: true });
      }
    }
  }
  return out;
}

// ----- 플러그인 루트 안의 컴포넌트 -----

function listSorted(d: string): string[] {
  return fs.readdirSync(d).sort(compareCodePoints);
}

/**
 * root 아래 *.md 를 재귀 수집 -> [rel, path]. rel 은 구분자 '/', 확장자 제거.
 *
 * dot 디렉토리는 모든 깊이에서 제외한다. superpowers 는 `agents/` 가 아니라
 * `.agents/` 를 담고 있고 Claude Code 가 그걸 안 읽는다 - 읽으면 세션에 존재하지
 * 않는 에이전트 9개가 대시보드에 유령으로 뜬다(claude_config 의 iterMd 와 같은 규율).
 */
function walkMd(root: string): [string, string][] {
  const items: [string, string][] = [];
  const anc = new Set<string>();
  const walk = (cur: string, prefix: string) => withinOnce(anc, cur, () => {
    let names: string[];
    try {
      names = listSorted(cur);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = pyJoin(cur, name);
      if (pyIsdir(full)) walk(full, prefix + name + "/");
      else if (name.endsWith(".md")) items.push([prefix + name.slice(0, -3), full]);
    }
  });
  if (root && pyIsdir(root)) walk(root, "");
  return items;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** workflows 는 *.js 라 walkMd 를 못 쓴다. 한 단계만 본다(Claude 가 읽는 단위와 동일). */
function jsItems(d: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  try {
    for (const name of listSorted(d)) {
      if (name.endsWith(".js") && isFile(pyJoin(d, name))) out.push({ name: name.slice(0, -3), path: pyJoin(d, name) });
    }
  } catch {
    return [];
  }
  return out;
}

/** <root>/skills/<name>/SKILL.md. 한 단계만 본다(claude_config 의 skillCards 와 동일). */
function skills(root: string): { name: string; path: string }[] {
  const d = pyJoin(root, SKILLS_DIR);
  const out: { name: string; path: string }[] = [];
  let names: string[];
  try {
    names = listSorted(d);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const md = pyJoin(d, name, "SKILL.md");
    if (pyExists(md)) out.push({ name, path: md });
  }
  return out;
}

const mdRows = (d: string) => walkMd(d).map(([name, p]) => ({ name, path: p }));

/**
 * 플러그인 루트가 제공하는 컴포넌트. 프론트매터는 읽지 않는다(호출부 담당).
 *
 * hooks / mcp 는 plugin_units 의 리더를 그대로 쓴다 - 정규식으로 command 를 뽑으면
 * 이스케이프된 \" 에서 잘려 0건 오답이 난다는 게 거기 이미 적혀 있다.
 */
export function scanItems(root: string): Record<string, unknown[]> {
  if (!(root && pyIsdir(root))) return emptyItems();

  let hooksCfg: unknown = null;
  let mcpCfg: unknown = null;
  try {
    hooksCfg = loadHooksJson(root);
  } catch (e) {
    if (!isLoadError(e)) throw e;
  }
  try {
    mcpCfg = loadMcpJson(root);
  } catch (e) {
    if (!isLoadError(e)) throw e;
  }

  const hooks: { event: string; matchers: number; commands: unknown[] }[] = [];
  for (const [event, entries] of pyItems(or(pyGet(or(hooksCfg, {}), "hooks"), {}))) {
    const cmds: unknown[] = [];
    for (const ent of pyIter(or(entries, []))) {
      if (!isDict(ent)) continue;
      for (const h of pyIter(or(pyGet(ent, "hooks"), []))) {
        if (isDict(h)) cmds.push(pyGet(h, "command", ""));
      }
    }
    hooks.push({ event, matchers: pyLen(or(entries, [])), commands: cmds });
  }

  const mcp = pyItems(or(pyGet(or(mcpCfg, {}), "mcpServers"), {})).map(([name, c]) => ({ name, cfg: or(c, {}) }));

  return {
    skills: skills(root),
    agents: mdRows(pyJoin(root, AGENTS_DIR)),
    commands: mdRows(pyJoin(root, COMMANDS_DIR)),
    rules: mdRows(pyJoin(root, RULES_DIR)),
    "output-styles": mdRows(pyJoin(root, STYLES_DIR)),
    workflows: jsItems(pyJoin(root, WORKFLOWS_DIR)),
    hooks: hooks.sort((a, b) => compareCodePoints(a.event, b.event)),
    mcp: mcp.sort((a, b) => compareCodePoints(a.name, b.name)),
  };
}

// ----- 레코드 조립 -----

/**
 * 'notion@claude-plugins-official' -> ['notion', 'claude-plugins-official'].
 *
 * 마지막 '@' 로 자른다. 마켓 이름에 '@' 가 들어가는 쪽이 플러그인 이름보다 흔하다.
 */
export function splitId(pid: string): [string, string] {
  const i = pid.lastIndexOf("@");
  return i >= 0 ? [pid.slice(0, i), pid.slice(i + 1)] : [pid, ""];
}

function marketOf(markets: Record<string, MarketRec>, market: string): unknown {
  return Object.prototype.hasOwnProperty.call(markets, market) ? markets[market] : {};
}

/**
 * 설치 원장 + enabledPlugins 를 합쳐 플러그인 레코드 리스트를 만든다.
 *
 * 항목 소스는 설치 원장이고 enabledPlugins 는 토글 값일 뿐이다. 실측:
 * enabledPlugins 에 `vibe-kit@inline: false` 가 있는데 원장에는 없다. 그런 키를 버리면
 * "왜 목록에 없지"가 되고, 플러그인으로 취급하면 없는 경로를 읽는다 - stale 로 드러낸다.
 *
 * 4상태:
 *   ok       원장 O, 경로 O, enabled       -> 기존 섹션에도 합류시킬 수 있음
 *   disabled 원장 O, 경로 O, enabled=false -> 적용 안 됨. 합류시키지 않는다
 *   missing  원장 O, 경로 X                -> 수동 삭제 / GC 로 캐시가 사라짐
 *   stale    원장 X, enabledPlugins 에만   -> 남은 찌꺼기
 */
export function readPlugins(pdir?: string | null, settingsFiles?: string[] | null): PluginRecord[] {
  const dir = pdir || defaultPluginsDir();
  const installed = readInstalled(dir);
  const markets = readMarkets(dir);
  const enabled = readEnabled(settingsFiles ?? []);
  const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

  const recs: PluginRecord[] = [];
  for (const pid of Object.keys(installed).sort(compareCodePoints)) {
    const inst = installed[pid];
    const [name, market] = splitId(pid);
    const root = inst.root;
    const ex = truthy(root) && typeof root === "string" && pyIsdir(root);
    const meta = ex ? load(pyJoin(root as string, PLUGIN_JSON_REL)) : {};
    // enabledPlugins 에 키가 없는 경우: 설치되어 있으면 적용 중으로 본다. 실측 5/5 가
    // 명시 엔트리를 갖고 있어 부재는 관측되지 않았고, "설치했는데 대시보드에 안 뜸"
    // 쪽이 반대 오탐보다 나쁘다. explicit 로 추정임을 UI 가 구분할 수 있게 남긴다.
    const e = has(enabled, pid) ? enabled[pid] : null;
    const on = e ? e.on : true;
    const state = ex && on ? "ok" : ex ? "disabled" : "missing";
    recs.push({
      id: pid,                                   // 토글 키 - 절대 ns 에서 만들지 말 것
      name,
      ns: or(pyGet(meta, "name"), name) as string,   // 표시 네임스페이스 - plugin.json 쪽
      market,
      market_src: marketOf(markets, market),
      version: or(pyGet(meta, "version"), inst.version) as string | null,
      desc: or(pyGet(meta, "description"), "") as string,
      homepage: or(pyGet(meta, "homepage"), "") as string,
      scope: inst.scope,
      project_path: inst.project_path,
      root,
      enabled: on,
      enabled_explicit: !!e,
      enabled_from: e ? e.from : null,
      state,
      items: ex ? scanItems(root as string) : emptyItems(),
    });
  }

  for (const pid of Object.keys(enabled).sort(compareCodePoints)) {
    if (has(installed, pid)) continue;
    const e = enabled[pid];
    const [name, market] = splitId(pid);
    recs.push({
      id: pid, name, ns: name, market,
      market_src: marketOf(markets, market), version: "", desc: "", homepage: "",
      scope: "", project_path: "", root: "", enabled: e.on, enabled_explicit: true,
      enabled_from: e.from, state: "stale",
      items: emptyItems(),
    });
  }
  return recs;
}

/** 카드 요약용 - 0 인 종류는 뺀다. */
export function itemCounts(rec: PluginRecord): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of pyItems(or(pyGet(rec, "items"), {}))) {
    if (truthy(v)) out[k] = pyLen(v);
  }
  return out;
}

/**
 * Claude Code 에 등록됐는데 config-monitor 스토어에는 없는 마켓 -> 가져오기 후보.
 *
 * URL 비교는 정규화해서 한다(.git 접미/대소문자/트레일링 슬래시). 같은 레포를 두 번
 * 등록하는 게 이 기능의 유일한 실패 모드다.
 */
export function importCandidates(pdir?: string | null, knownUrls?: Iterable<string> | null): { name: string; url: string; kind: string; repo: string | null; updated: string | null }[] {
  const known = new Set<string>();
  for (const u of knownUrls ?? []) if (u) known.add(normUrl(u));
  const markets = readMarkets(pdir || defaultPluginsDir());
  const out: { name: string; url: string; kind: string; repo: string | null; updated: string | null }[] = [];
  for (const name of Object.keys(markets).sort(compareCodePoints)) {
    const m = markets[name];
    if (!truthy(m.url) || known.has(normUrl(m.url as string))) continue;
    out.push({ name, url: m.url as string, kind: m.kind as string, repo: m.repo, updated: m.updated });
  }
  return out;
}

/**
 * URL 비교용 정규화 - .git 접미/트레일링 슬래시/대소문자를 흡수한다.
 * 같은 레포를 두 번 등록하는 게 import 의 유일한 실패 모드다.
 * casefold 는 JS 에 없어 toUpperCase().toLowerCase() 로 근사한다(ß -> ss 같은 확장 접기를 잡는다).
 */
export function normUrl(u: string): string {
  const s = pyStrip(u || "").replace(/\/+$/, "").toUpperCase().toLowerCase();
  return s.endsWith(".git") ? s.slice(0, -4) : s;
}
