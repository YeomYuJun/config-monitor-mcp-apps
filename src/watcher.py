#!/usr/bin/env python3
r"""watcher.py - 추적 파일 폴링 감시(변경 시 자동 스냅샷). watcher.ps1 대체.

FileSystemWatcher(PS 상주 스크립트) 대신 폴링을 쓰는 이유:
  - 감시 대상이 10~20개 파일 규모라 stat 폴링(기본 2초)이 이벤트 방식보다 단순하고 확실하다.
    FSW 는 버퍼 오버플로/에디터의 원자 교체(os.replace)에서 이벤트를 놓치고,
    PS 5.1 은 BOM 없는 스크립트를 CP949 로 읽는 등 이 환경의 취약 지점이 많았다.
  - cas.scan 의 stat fast-path 를 그대로 재사용한다(내용 해싱은 stat 이 바뀐 파일만).

heartbeat 계약(watcher.json)은 기존과 동일: pid/started/heartbeat/debounceMs/dirs/lastEvent.
cas.py watcher-status(_watcher_state) 가 이 파일로 실행 여부를 판정한다.

사용: python watcher.py [--store D:\.claude-snapshot] [--interval-ms 2000]
      이 프로세스가 떠 있는 동안만 동작(상주). 종료는 Ctrl+C 또는 MCP watcher_stop.
"""
from __future__ import annotations
import argparse, contextlib, json, os, sys, time
from datetime import datetime

# Windows 콘솔 기본 인코딩(cp949)에서 한글/em-dash 출력 시 UnicodeEncodeError 방지.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import cas


def tick(p):
    """폴링 1사이클: 변경 검사 -> 있으면 자동 스냅샷. (스냅샷 메시지 or None) 반환.
    다른 프로세스(config_edit 의 후행 스냅샷 등)가 먼저 찍었으면 변경이 비어 그냥 지나간다."""
    config = cas.load_config(p)
    index = cas.load_json(p["index"], {})
    result, new_index = cas.scan(p, config, index, rehash=False)
    changed = result["modified"] + result["new"] + result["deleted"]
    if not changed:
        with contextlib.suppress(TimeoutError, OSError, ValueError):   # 깨진 매니페스트/캐시 쓰기 실패로 상주가 죽지 않게
            if new_index != index:
                cas.refresh_index(p)          # 무시 키만 저장된 파일: 스냅샷 없이 index 의 stat 만 따라간다
            else:
                cas.warm_sig_cache(p, config)  # 유휴 틱에 타임라인 접기용 sig 를 조금씩 미리 계산
        return None
    names = ", ".join(os.path.basename(x) for x in changed[:3])
    if len(changed) > 3:
        names += f" 외 {len(changed) - 3}"
    msg = f"auto: {names}"
    try:
        sid, _ = cas._take_snapshot(p, msg)
    except TimeoutError:
        return None            # 편집 프로세스가 스냅샷 중 - 다음 틱에 다시 잡힌다
    return msg if sid else None  # 락 대기 사이 남이 먼저 찍은 경우 None


def write_state(p, interval_ms, started, last_event):
    """heartbeat 갱신(살아있음 신호). BOM 없는 UTF-8 - cas 쪽은 utf-8-sig 로 읽어 양쪽 호환."""
    state = {
        "pid": os.getpid(),
        "started": started,
        "heartbeat": datetime.now().astimezone().isoformat(),
        "debounceMs": interval_ms,
        "dirs": sorted(cas.expand_tracked(cas.load_config(p).get("tracked", []))),
        "lastEvent": last_event,
    }
    cas.save_json(os.path.join(p["store"], "watcher.json"), state)


def main():
    ap = argparse.ArgumentParser(prog="watcher", description="추적 파일 폴링 감시(자동 스냅샷)")
    ap.add_argument("--store", default=cas.DEFAULT_STORE)
    ap.add_argument("--interval-ms", type=int, default=2000)
    args = ap.parse_args()
    p = cas.store_paths(args.store)
    if not os.path.exists(p["config"]):
        print(f"config.json 없음: {p['config']} - 먼저 'cas.py init' 후 'track' 하세요")
        sys.exit(1)
    started = datetime.now().astimezone().isoformat()
    last_event = ""
    print(f"watcher 시작 - 저장소: {args.store} (polling {args.interval_ms}ms)")
    try:
        while True:
            msg = tick(p)
            if msg:
                last_event = f"{msg} @ {datetime.now().strftime('%H:%M:%S')}"
                print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
            write_state(p, args.interval_ms, started, last_event)
            time.sleep(args.interval_ms / 1000.0)
    except KeyboardInterrupt:
        pass
    finally:
        with contextlib.suppress(OSError):
            os.remove(os.path.join(p["store"], "watcher.json"))
        print("watcher 종료.")


if __name__ == "__main__":
    main()
