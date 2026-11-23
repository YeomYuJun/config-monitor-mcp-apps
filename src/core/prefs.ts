// prefs.ts - 대시보드 표시 설정(store/config.json 의 "ui" 블록) 소유 모듈. src/prefs.py 이식.
//
// 스토어가 초기화되지 않았으면 저장은 실패한다 - 조용히 삼키지 않는다.
// UI 는 ok:false 를 받아 세션 한정 상태로 떨어진다.
import { emit, guard, JsonArgumentParser, type CliDoc, type CodeMap } from "./cli_result.ts";
import {
  attributeError, defaultStore, isDict, isValueError, loadCfg, LockTimeoutError, pyLoads, pyTruthy, StoreNotInitialized,
  withEditCfg,
} from "./lib_store.ts";

export interface UiPrefs {
  sections: {
    preset: "all" | "common" | "custom";
    hidden: string[];
    hideEmpty: boolean;
    includeMissingProjects: boolean;
    groupsCollapsed: string[];
  };
  view: {
    selectedPath: string;
    detailOpen: boolean;
    scope: string;
    libTarget: string;
  };
}

// preset 은 '어느 범주를 볼까'만 정한다. '빈 섹션을 감출까'(hideEmpty)는 독립 축이라
// 프리셋 값으로 겸하지 않는다 - 겸하면 preset=X 인데 화면은 Y 인 상태가 저장된다.
const PRESETS = ["all", "common", "custom"];
const LEGACY_PRESET: Record<string, string> = { present: "all" };   // 'present' 는 all + hideEmpty 와 같은 화면이었다

function defaultUi(): UiPrefs {
  return {
    sections: { preset: "all", hidden: [], hideEmpty: true, includeMissingProjects: false, groupsCollapsed: [] },
    // 보던 자리. 호스트가 위젯 iframe 을 다시 올려도 같은 파일·같은 필터로 돌아오게 한다.
    view: { selectedPath: "", detailOpen: true, scope: "all", libTarget: "" },
  };
}

const CODES: CodeMap = [[LockTimeoutError, "lock_timeout"]];

function normPreset(v: unknown): UiPrefs["sections"]["preset"] {
  const x = typeof v === "string" && Object.prototype.hasOwnProperty.call(LEGACY_PRESET, v) ? LEGACY_PRESET[v] : v;
  return (typeof x === "string" && PRESETS.includes(x) ? x : "all") as UiPrefs["sections"]["preset"];
}

/** 저장된 ui 블록 + 기본값 병합. 스토어가 없으면 기본값(읽기는 실패해도 화면이 떠야 한다). */
export function loadUi(store: string): UiPrefs {
  const ui = defaultUi();
  let cfg: unknown;
  try {
    cfg = loadCfg(store);
  } catch {
    return ui;
  }
  if (!isDict(cfg)) throw attributeError(cfg, "get");
  const saved = cfg.ui;
  if (isDict(saved)) mergeKnown(ui, saved);
  ui.sections.preset = normPreset(ui.sections.preset);
  return ui;
}

/** DEFAULT_UI 에 있는 블록·키만 받아들인다. 모르는 키는 저장하지 않는다. */
function mergeKnown(ui: UiPrefs, patch: unknown): void {
  const p = pyTruthy(patch) ? patch : {};
  if (!isDict(p)) throw attributeError(p, "get");
  for (const [block, keys] of Object.entries(ui) as [string, Record<string, unknown>][]) {
    const raw = Object.prototype.hasOwnProperty.call(p, block) ? p[block] : undefined;
    const b = pyTruthy(raw) ? raw : {};
    if (!isDict(b)) throw attributeError(b, "items");
    for (const [k, v] of Object.entries(b)) {
      if (Object.prototype.hasOwnProperty.call(keys, k)) keys[k] = v;
    }
  }
}

/** patch 의 알려진 sections/view 키만 덮어쓴다. 스토어 미초기화면 StoreNotInitialized. */
export async function saveUi(store: string, patch: unknown): Promise<UiPrefs> {
  return withEditCfg(store, (cfg) => {
    const ui = loadUi(store);
    mergeKnown(ui, patch);
    ui.sections.preset = normPreset(ui.sections.preset);
    cfg.ui = ui as unknown as Record<string, unknown>;
    return ui;
  });
}

function doGet(store: string): never {
  emit(true, "ok", "Display settings", { ui: loadUi(store) });
}

async function doSet(store: string, json: string): Promise<never> {
  let patch: unknown;
  try {
    patch = pyLoads(json);
  } catch (e) {
    if (!isValueError(e)) throw e;
    emit(false, "invalid_arg", `Failed to parse --json: ${(e as Error).message}`, { target: "--json" });
  }
  let ui: UiPrefs;
  try {
    ui = await saveUi(store, patch);
  } catch (e) {
    if (!(e instanceof StoreNotInitialized)) throw e;
    emit(false, "store_uninitialized", e.message);
  }
  emit(true, "ok", "Display settings saved", { ui });
}

export async function cmdGet(opts: { store?: string }): Promise<CliDoc> {
  return guard(() => doGet(opts.store ?? defaultStore()), CODES);
}

/** json 은 CLI --json 문자열 그대로. 파싱 실패는 invalid_arg(target "--json"). */
export async function cmdSet(opts: { store?: string; json: string }): Promise<CliDoc> {
  return guard(() => doSet(opts.store ?? defaultStore(), opts.json), CODES);
}

/** argv 는 python prefs.py 의 인자와 같다(--store 는 서브커맨드 뒤). */
export async function main(argv: string[]): Promise<CliDoc> {
  return guard(async () => {
    const ap = new JsonArgumentParser("prefs");
    const sub = ap.addSubparsers({ dest: "cmd", required: true });
    for (const name of ["get", "set"]) {
      const sp = sub.addParser(name);
      sp.addArgument("--store", { default: defaultStore() });
      if (name === "set") sp.addArgument("--json", { required: true });
    }
    const args = ap.parse(argv);
    if (args.cmd === "get") doGet(args.store as string);
    return doSet(args.store as string, args.json as string);
  }, CODES);
}
