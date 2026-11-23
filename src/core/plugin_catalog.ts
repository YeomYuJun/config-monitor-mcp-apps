// plugin_catalog.ts - Claude Code 플러그인 카탈로그 캐시 조회(읽기 전용). src/plugin_catalog.py 이식.
//
// plugin_state 는 "내가 설치한 것"을 읽는다. 이 모듈은 그 반대편, "공식 마켓에 무엇이
// 있는가"를 읽는다. Claude Code 가 `~/.claude/plugins/plugin-catalog-cache.json` 에 인벤토리
// 전체(실측 255개)를 캐시해 두는데, 여기에 설치 수/컴포넌트 구성/토큰 비용처럼 매니페스트에는
// 없는 값이 들어 있다. 카탈로그 행을 이 값으로 enrich 하면 "설치하기 전에 얼마나 무거운지"를
// 보여줄 수 있다.
//
// 순수 리더다: 네트워크도, git 도, 프로세스도 없다(plugin_state / plugin_units 와 같은
// 규율). 캐시를 갱신하지 않는다 - 갱신은 Claude Code 가 자기 주기로 한다. 파일이 없으면 그건
// 오류가 아니라 "아직 한 번도 안 받았다"이고, ok=false 로 그대로 드러낸다.
//
// 다른 이식 모듈을 import 하지 않는다(cli_result, paths 만). plugin_state.splitId 가
// 바로 옆에 있지만 가져오지 않는다 - 이 모듈을 독립적으로 유지하는 값이 중복 3줄보다 크다.
//
// 함정 1: components 의 값이 두 형태다
//
// 실측 2340개 항목 중 2062개가 `{"name": ..., "chars": {...}}` dict 이고 278개가 그냥 문자열이다.
// 지금은 종류별로 갈리지만(skills/commands/agents 는 dict, hooks/mcpServers/lspServers 는 문자열)
// 종류로 형태를 가정하지 않는다 - 카탈로그가 형태를 바꾸면 그 가정이 조용히 깨진다.
// 정규화를 빠뜨리면 UI 에 `[object Object]` 가 뜬다. 이름을 못 뽑은 항목은 아예 담지 않는다:
// null 을 끼워 넣으면 같은 증상이 이름만 바꿔 재발한다.
//
// 함정 2: 공식 마켓 전용 데이터다
//
// 키는 `<plugin>@<marketplace>` 인데 실측 255개가 전부 `@claude-plugins-official` 이다.
// 다른 마켓에서 설치한 플러그인은 여기서 조회되지 않으며 그건 오류가 아니다. 호출부는
// details() 가 null 을 돌려주는 것을 정상 경로로 다뤄야 한다.
import fs from "node:fs";
import { checkFields, emit, guard, JsonArgumentParser, SUPPRESS, type CliDoc } from "./cli_result.ts";
import { expanduser } from "./paths.ts";

export interface CatalogLoad {
  ok: boolean;
  path: string;
  fetched_at: string;
  generated_at: string;
  installs_at: string;
  models: string[];
  entries: Record<string, Record<string, unknown>>;
}

type Obj = Record<string, unknown>;

const isDict = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const get = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null);

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

const or = <T, U>(v: T, d: U): T | U => (truthy(v) ? v : d);

function put(o: Obj, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** Python DEFAULT_CACHE(~/.claude/plugins/plugin-catalog-cache.json). 호출 시점의 홈으로 만든다. */
export function defaultCache(): string {
  // os.path.join 처럼 구분자를 바꾸지 않고 잇는다(홈 값의 표기를 그대로 둔다).
  const home = expanduser("~");
  const sep = process.platform === "win32" ? "\\" : "/";
  const glue = /[\\/]$/.test(home) || (process.platform === "win32" && /^[A-Za-z]:$/.test(home)) ? "" : sep;
  return home + glue + [".claude", "plugins", "plugin-catalog-cache.json"].join(sep);
}

// ----- 읽기 -----

/**
 * 캐시 파일 -> dict. 실패는 null 이고 예외로 만들지 않는다.
 *
 * utf-8-sig 로 여는 이유: BOM 이 붙은 JSON 을 utf-8 로 읽으면 파싱이 실패한다
 * (cas 의 watcher.json 에서 이미 겪었다). BOM 이 없으면 utf-8 과 동작이 같다.
 */
function read(p: string): Obj | null {
  let data: unknown;
  try {
    let text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(p));
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    data = JSON.parse(text);
  } catch {
    return null;
  }
  return isDict(data) ? data : null;
}

// ----- 정규화 -----

/** 컴포넌트 목록을 이름 문자열 배열로. 문자열 항목과 dict 항목을 모두 받는다(함정 1). */
function names(value: unknown): string[] {
  const out: string[] = [];
  for (const it of Array.isArray(value) ? value : []) {
    let name: unknown;
    if (typeof it === "string") name = it;
    else if (isDict(it)) name = get(it, "name");
    else continue;
    if (typeof name === "string" && name) out.push(name);
  }
  return out;
}

/**
 * components 를 {kind: [이름]} 으로. 종류 목록을 하드코딩하지 않고 파일이 준 키를
 * 그대로 쓴다 - 카탈로그에 새 종류가 생겨도 코드를 안 고치고 따라간다.
 */
function components(rec: Obj): Record<string, string[]> {
  const src = get(rec, "components");
  const out: Record<string, string[]> = {};
  if (!isDict(src)) return out;
  for (const [k, v] of Object.entries(src)) put(out, k, names(v));
  return out;
}

/**
 * author 는 {"name", "email"} dict 이거나 아예 없다(실측 170 / 85). 문자열로 주는
 * 마켓도 있을 수 있어 둘 다 받는다. 없으면 빈 문자열 - null 을 그대로 흘리면 UI 가
 * "None" 이라는 저자 이름을 찍는다.
 */
function author(value: unknown): string {
  if (isDict(value)) {
    const name = get(value, "name");
    return typeof name === "string" ? name : "";
  }
  return typeof value === "string" ? value : "";
}

/**
 * version / sha 계열은 없으면 null 로 남긴다(빈 문자열로 접지 않는다).
 *
 * 실측 255개 중 51개가 sha=null 이고 version 도 최상위가 null 인 경우가 흔하다. author 나
 * description 처럼 UI 가 그대로 렌더하는 텍스트가 아니라 "값이 있을 때만 표시"하는
 * 식별자라, installs 와 같은 이유로 부재를 null 로 드러낸다.
 */
function optStr(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * 'code-review@claude-plugins-official' -> ['code-review', 'claude-plugins-official'].
 * 마지막 '@' 로 자른다(plugin_state.splitId 와 같은 규칙 - 마켓 이름 쪽에 '@' 가 없다).
 */
function splitId(entryId: string): [string, string] {
  const i = entryId.lastIndexOf("@");
  return i >= 0 ? [entryId.slice(0, i), entryId.slice(i + 1)] : [entryId, ""];
}

/** 카탈로그 엔트리 하나를 정규화 레코드로. */
function record(entryId: string, rec: Obj): Obj {
  const [name, market] = splitId(entryId);
  const meRaw = get(rec, "marketplace_entry");
  const me = isDict(meRaw) ? meRaw : {};
  const comps = components(rec);
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(comps)) if (v.length) put(counts, k, v.length);   // 0 인 종류는 뺀다(카드가 지저분해진다)
  const installs = get(rec, "unique_installs");
  const tokens = get(rec, "tokens");
  return {
    id: entryId,
    name: or(get(rec, "plugin"), name),
    marketplace: market,
    description: or(get(me, "description"), ""),
    author: author(get(me, "author")),
    homepage: or(get(me, "homepage"), ""),
    category: or(get(me, "category"), ""),
    // 실측 255개 중 2개가 unique_installs 를 안 갖는다. 0 으로 접으면 "아무도 안 쓰는
    // 플러그인"으로 잘못 보이므로 null(=모름)과 0(=실제로 0)을 구분해서 남긴다.
    installs: typeof installs === "number" && Number.isInteger(installs) ? installs : null,
    last_updated: or(get(rec, "last_updated"), ""),
    // 버전이 두 곳에 있고 둘 다 비는 경우가 있다(실측: 최상위 null 이면서 marketplace_entry
    // 쪽에만 있는 엔트리가 존재). 설치 원장에 가까운 최상위를 먼저 본다.
    version: optStr(get(rec, "version")) || optStr(get(me, "version")),
    sha: optStr(get(rec, "sha")),
    source_sha: optStr(get(rec, "source_sha")),
    components: comps,
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    tokens: isDict(tokens) ? tokens : {},
  };
}

// ----- 공개 API -----

/**
 * 캐시 전체를 정규화해서 읽는다. 예외를 던지지 않는다.
 *
 * ok 는 "엔트리가 있느냐"가 아니라 "읽어서 catalog.plugins 까지 도달했느냐"다.
 * 파일 없음 / 깨진 JSON / catalog 키 없음이 전부 ok=false + entries={} 로 수렴한다 -
 * 호출부(scan 경로)는 카탈로그가 없어도 계속 돌아야 한다.
 */
export function load(path?: string | null): CatalogLoad {
  const p = path || defaultCache();
  const raw = read(p);
  const catRaw = raw ? get(raw, "catalog") : null;
  const cat: Obj = isDict(catRaw) ? catRaw : {};
  const plugins = get(cat, "plugins");
  const ok = isDict(plugins);

  const entries: Record<string, Obj> = {};
  if (ok) {
    for (const [pid, rec] of Object.entries(plugins)) {
      if (isDict(rec)) put(entries, pid, record(pid, rec));
    }
  }

  const models = get(cat, "models");
  return {
    ok,
    path: p,
    // fetchedAt 은 최상위(Claude Code 가 언제 받았나), generated_at 계열은 catalog 안
    // (서버가 언제 만들었나)이다. 섞으면 "받은 시각은 새로운데 데이터가 오래됨"을 설명 못 한다.
    fetched_at: or(raw ? get(raw, "fetchedAt") : null, "") as string,
    generated_at: or(get(cat, "generated_at"), "") as string,
    installs_at: or(get(cat, "installs_generated_at"), "") as string,
    models: (Array.isArray(models) ? models : []).filter((m): m is string => typeof m === "string"),
    entries,
  };
}

/**
 * 한 플러그인의 정규화 레코드. 없으면 null.
 *
 * 다른 마켓의 플러그인이거나 캐시가 아직 없으면 null 이 정상 결과다(함정 2).
 */
export function details(entryId: string, path?: string | null): Record<string, unknown> | null {
  const e = load(path).entries;
  return Object.prototype.hasOwnProperty.call(e, entryId) ? e[entryId] : null;
}

/**
 * 이미 읽은 entries 를 경량 맵으로. load() 를 다시 타지 않게 분리해 뒀다 -
 * CLI 는 메타데이터 때문에 load() 결과를 이미 손에 들고 있는데, 거기서 summary() 를
 * 부르면 400KB 파일을 한 번 더 파싱한다(UI 가 목록을 그릴 때마다 타는 경로다).
 */
function light(entries: Record<string, Obj>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [pid, rec] of Object.entries(entries)) {
    put(out, pid, {
      installs: rec.installs,
      components: { ...(rec.counts as Obj) },   // 복사본 - 호출부 변형이 새지 않게
      total: rec.total,
    });
  }
  return out;
}

/**
 * 카탈로그 행 enrich 용 경량 맵 -> {id: {installs, components: {kind: 개수}, total}}.
 *
 * 이름 배열을 담지 않는다. 255개 x 컴포넌트 이름 전부(실측 2340개 문자열)를 UI 로
 * 보내면 목록 한 번 그리는 데 카탈로그 본문보다 큰 페이로드가 붙는다. 이름이 필요한
 * 시점은 카드 하나를 펼칠 때뿐이고 그건 details() 가 판다.
 */
export function summary(path?: string | null): Record<string, unknown> {
  return light(load(path).entries);
}

// ----- CLI -----

const broken = (cat: CatalogLoad) => `Cannot read the catalog cache: ${cat.path}`;

// 두 서브커맨드의 키 이름은 호출부(TypeScript UI)가 그대로 읽는 계약이다. 이름을 바꾸면
// 화면이 조용히 빈 채로 뜬다(테스트가 키 집합을 고정한다).
// 캐시가 아직 없는 것도 ok:false 다 - 호출부는 exit code 와 무관하게 문서를 받으므로
// 카탈로그 화면은 entries={} 로 그대로 그려진다.

export async function cmdSummary(opts: { cache?: string }): Promise<CliDoc> {
  return guard(() => {
    const cat = load(opts.cache);
    // 실패해도 entries 를 빼지 않는다 - 없으면 호출부가 undefined 를 순회한다.
    if (!cat.ok) {
      emit(false, "cache_unavailable", broken(cat), { entries: {}, fetched_at: "", generated_at: "", installs_at: "", models: [] });
    }
    emit(true, "ok", `Plugins: ${Object.keys(cat.entries).length}`, {
      entries: light(cat.entries), fetched_at: cat.fetched_at,
      generated_at: cat.generated_at, installs_at: cat.installs_at, models: cat.models,
    });
  });
}

export async function cmdDetails(opts: { id: string; cache?: string }): Promise<CliDoc> {
  return guard(() => {
    const cat = load(opts.cache);
    const rec = Object.prototype.hasOwnProperty.call(cat.entries, opts.id) ? cat.entries[opts.id] : null;
    if (rec === null) {
      // 다른 마켓 플러그인이면 캐시에 없는 게 정상이다(모듈 머리말 함정 2). 그래도
      // ok=false 로 보고하고, 무엇을 찾다 못 찾았는지 id 를 그대로 되돌려준다.
      if (!cat.ok) emit(false, "cache_unavailable", broken(cat), { id: opts.id });
      emit(false, "not_found", `Plugin not in catalog: ${opts.id} (only official marketplace plugins are cached)`,
        { target: opts.id, id: opts.id });
    }
    // 레코드를 top level 로 편다(중첩 금지) - UI 가 필드 이름을 그대로 읽는다.
    emit(true, "ok", opts.id, checkFields(rec));
  });
}

/** argv 는 python plugin_catalog.py 의 인자와 같다(--cache 는 서브커맨드 앞뒤 어디든). */
export async function main(argv: string[]): Promise<CliDoc> {
  return guard(async () => {
    const ap = new JsonArgumentParser("plugin_catalog");
    // --cache 를 서브커맨드 앞/뒤 어디에 써도 받는다. 서브파서 쪽 기본값을 SUPPRESS 로 둬야
    // 앞에 준 값이 뒤의 기본값 null 에 덮이지 않는다.
    ap.addArgument("--cache", { default: null });
    const sub = ap.addSubparsers({ dest: "op", required: true });
    for (const name of ["summary", "details"]) {
      const p = sub.addParser(name);
      p.addArgument("--cache", { default: SUPPRESS });
      if (name === "details") p.addArgument("id");
    }
    const a = ap.parse(argv);
    const cache = (a.cache as string | null) ?? undefined;
    if (a.op === "summary") return cmdSummary({ cache });
    return cmdDetails({ id: a.id as string, cache });
  });
}
