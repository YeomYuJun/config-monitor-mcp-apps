#!/usr/bin/env python3
r"""prefs.py - 대시보드 표시 설정(store/config.json 의 "ui" 블록) 소유 모듈.

스토어가 초기화되지 않았으면 저장은 **실패한다** - 조용히 삼키지 않는다.
UI 는 ok:false 를 받아 세션 한정 상태로 떨어진다.
"""
from __future__ import annotations
import argparse, copy, json, os, sys

# Windows 콘솔 기본 인코딩(cp949)에서 한글/em-dash 출력 시 UnicodeEncodeError 방지.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import lib_store

HOME = os.path.expanduser("~")
DEFAULT_STORE = os.environ.get("CLAUDE_SNAPSHOT_STORE") or (
    "D:\\.claude-snapshot" if os.name == "nt" else os.path.join(HOME, ".claude-snapshot"))

# preset 은 '어느 범주를 볼까'만 정한다. '빈 섹션을 감출까'(hideEmpty)는 독립 축이라
# 프리셋 값으로 겸하지 않는다 - 겸하면 preset=X 인데 화면은 Y 인 상태가 저장된다.
PRESETS = ("all", "common", "custom")
_LEGACY_PRESET = {"present": "all"}   # 'present' 는 all + hideEmpty 와 같은 화면이었다

DEFAULT_UI = {
    "sections": {
        "preset": "all",          # all | common | custom
        "hidden": [],             # custom 에서만 의미
        "hideEmpty": True,
        "groupsCollapsed": [],
    }
}


def _norm_preset(v):
    v = _LEGACY_PRESET.get(v, v)
    return v if v in PRESETS else "all"


def load_ui(store):
    """저장된 ui 블록 + 기본값 병합. 스토어가 없으면 기본값(읽기는 실패해도 화면이 떠야 한다)."""
    ui = copy.deepcopy(DEFAULT_UI)
    try:
        cfg = lib_store.load_cfg(store)
    except Exception:
        return ui
    saved = cfg.get("ui")
    if isinstance(saved, dict):
        for k, v in (saved.get("sections") or {}).items():
            if k in ui["sections"]:
                ui["sections"][k] = v
    ui["sections"]["preset"] = _norm_preset(ui["sections"]["preset"])
    return ui


def save_ui(store, patch):
    """patch 의 알려진 sections 키만 덮어쓴다. 스토어 미초기화면 StoreNotInitialized."""
    cfg = lib_store.load_cfg(store)
    ui = load_ui(store)
    for k, v in ((patch or {}).get("sections") or {}).items():
        if k in ui["sections"]:
            ui["sections"][k] = v
    ui["sections"]["preset"] = _norm_preset(ui["sections"]["preset"])
    cfg["ui"] = ui
    lib_store.save_cfg(store, cfg)
    return ui


def main():
    ap = argparse.ArgumentParser(prog="prefs", description="대시보드 표시 설정 조회/저장")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("get", "set"):
        sp = sub.add_parser(name)
        sp.add_argument("--store", default=DEFAULT_STORE)
        if name == "set":
            sp.add_argument("--json", required=True, help='{"sections": {...}} 패치')
    args = ap.parse_args()

    if args.cmd == "get":
        print(json.dumps({"ok": True, "ui": load_ui(args.store)}, ensure_ascii=False))
        return
    try:
        ui = save_ui(args.store, json.loads(args.json))
    except Exception as e:
        print(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps({"ok": True, "ui": ui}, ensure_ascii=False))


if __name__ == "__main__":
    main()
