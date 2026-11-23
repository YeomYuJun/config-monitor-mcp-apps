// watcher.ts - 추적 파일 폴링 감시(변경 시 자동 스냅샷). src/watcher.py 이식.
//
// FileSystemWatcher(PS 상주 스크립트) 대신 폴링을 쓰는 이유:
//   - 감시 대상이 10~20개 파일 규모라 stat 폴링(기본 2초)이 이벤트 방식보다 단순하고 확실하다.
//     FSW 는 버퍼 오버플로/에디터의 원자 교체(os.replace)에서 이벤트를 놓치고,
//     PS 5.1 은 BOM 없는 스크립트를 CP949 로 읽는 등 이 환경의 취약 지점이 많았다.
//   - cas.scan 의 stat fast-path 를 그대로 재사용한다(내용 해싱은 stat 이 바뀐 파일만).
//
// heartbeat 계약(watcher.json): pid/started/heartbeat/debounceMs/dirs/lastEvent.
// cas watcher-status(watcherState) 가 이 파일로 실행 여부를 판정한다.
//
// 서버가 진입 파일을 --watcher 로 다시 실행해 별도 Node 프로세스로 띄운다(src/server-stdio.ts):
//   node --import tsx src/server-stdio.ts --watcher --store <store> --interval-ms 2000
// 이 프로세스가 떠 있는 동안만 동작(상주). 종료는 Ctrl+C 또는 MCP watcher_stop.
import fs from "node:fs";
import * as cas from "./cas.ts";
import type { StorePaths } from "./cas.ts";
import { CliExit, compareCodePoints, JsonArgumentParser } from "./cli_result.ts";
import { basename, isOSError, isoLocal, isValueError, LockTimeoutError, pjoin, pyErrorName, pyEq, pyNow } from "./lib_store.ts";

export interface WatcherOpts {
  /** 생략 시 cas.defaultStore(). */
  store?: string;
  /** 기본 2000. */
  intervalMs?: number;
}

/**
 * 폴링 1사이클: 변경 검사 -> 있으면 자동 스냅샷. 스냅샷을 찍었으면 메시지("auto: ..."), 아니면 null.
 * 다른 프로세스(config_edit 의 후행 스냅샷 등)가 먼저 찍었으면 변경이 비어 그냥 지나간다.
 */
export async function tick(p: StorePaths): Promise<string | null> {
  const config = await cas.loadConfig(p);
  const index = cas.loadIndex(p);
  const [result, newIndex] = cas.scan(p, config, index, false);
  const changed = [...result.modified, ...result.new, ...result.deleted];
  if (!changed.length) {
    try {   // 깨진 매니페스트/캐시 쓰기 실패로 상주가 죽지 않게
      if (!pyEq(newIndex, index)) await cas.refreshIndex(p);   // 무시 키만 저장된 파일: 스냅샷 없이 index 의 stat 만 따라간다
      else cas.warmSigCache(p, config);                        // 유휴 틱에 타임라인 접기용 sig 를 조금씩 미리 계산
    } catch (e) {
      if (!(e instanceof LockTimeoutError) && !isOSError(e) && !isValueError(e)) throw e;
    }
    return null;
  }
  let names = changed.slice(0, 3).map((x) => basename(x)).join(", ");
  if (changed.length > 3) names += ` +${changed.length - 3} more`;
  const msg = `auto: ${names}`;
  let sid: string | null;
  try {
    [sid] = await cas.takeSnapshot(p, msg);
  } catch (e) {
    if (e instanceof LockTimeoutError) return null;   // 편집 프로세스가 스냅샷 중 - 다음 틱에 다시 잡힌다
    throw e;
  }
  return sid ? msg : null;   // 락 대기 사이 남이 먼저 찍은 경우 null
}

/** tick 1회. 예외는 "<Type>: <message>" 오류 문자열로 돌려 상주 루프가 끝나지 않게 한다. */
export async function safeTick(p: StorePaths): Promise<[string | null, string | null]> {
  try {
    return [await tick(p), null];
  } catch (e) {
    return [null, `${pyErrorName(e)}: ${e instanceof Error ? e.message : String(e)}`];
  }
}

/**
 * heartbeat 갱신(살아있음 신호). BOM 없는 UTF-8 - cas 쪽은 utf-8-sig 로 읽어 양쪽 호환.
 * dirs 는 Python 판처럼 기본 추적 파일까지 병합한 목록이다. 병합 결과의 저장은 같은 틱의 tick 이 이미 했다.
 */
export function writeState(p: StorePaths, intervalMs: number, started: string, lastEvent: string): void {
  const config = cas.loadConfigMerged(p);
  const state = {
    pid: process.pid,
    started,
    heartbeat: isoLocal(pyNow(), true),
    debounceMs: intervalMs,
    dirs: [...cas.expandTracked(config.tracked ?? [])].sort(compareCodePoints),
    lastEvent,
  };
  cas.saveJson(pjoin(p.store, "watcher.json"), state);
}

function hms(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** 종료될 때까지 돈다. config.json 이 없으면 1 을 돌려준다. 끝나면 watcher.json 을 지운다. */
export async function runWatcher(opts: WatcherOpts): Promise<number> {
  const store = opts.store ?? cas.defaultStore();
  const intervalMs = opts.intervalMs ?? 2000;
  const p = cas.storePaths(store);
  if (!fs.existsSync(p.config)) {
    console.log(`config.json not found: ${p.config} - initialize the store and track files first`);
    return 1;
  }
  const started = isoLocal(pyNow(), true);
  let lastEvent = "";
  let stop = false;
  let wake: (() => void) | null = null;
  const onSignal = () => {
    stop = true;
    wake?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  console.log(`Watcher started - store: ${store} (polling ${intervalMs}ms)`);
  try {
    while (!stop) {
      const [msg, err] = await safeTick(p);
      const now = hms();
      if (msg) {
        lastEvent = `${msg} @ ${now}`;
        console.log(`[${now}] ${msg}`);
      } else if (err) {
        lastEvent = `error: ${err} @ ${now}`;
        console.log(`[${now}] error: ${err}`);
      }
      try {   // heartbeat 쓰기 실패도 상주를 끝내지 않는다
        writeState(p, intervalMs, started, lastEvent);
      } catch (e) {
        if (!isOSError(e) && !isValueError(e)) throw e;
      }
      if (stop) break;
      await new Promise<void>((r) => {
        const t = setTimeout(r, intervalMs);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
      wake = null;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      fs.unlinkSync(pjoin(p.store, "watcher.json"));
    } catch {
      // 이미 없으면 그만이다
    }
    console.log("Watcher stopped");
  }
  return 0;
}

/** argv 는 python watcher.py 의 인자와 같다(--store, --interval-ms). 종료 코드를 돌려준다. 인자 오류는 argparse 처럼 stderr 와 2. */
export async function main(argv: string[]): Promise<number> {
  const ap = new JsonArgumentParser("watcher");
  ap.addArgument("--store", { default: cas.defaultStore() });
  ap.addArgument("--interval-ms", { type: "int", default: 2000 });
  let args: Record<string, unknown>;
  try {
    args = ap.parse(argv);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    process.stderr.write(`usage: watcher [-h] [--store STORE] [--interval-ms INTERVAL_MS]\nwatcher: error: ${e.doc.message.replace(/^watcher: /, "")}\n`);
    return 2;
  }
  return runWatcher({ store: args.store as string, intervalMs: args.interval_ms as number });
}
