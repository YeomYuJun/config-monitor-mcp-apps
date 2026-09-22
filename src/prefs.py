#!/usr/bin/env python3
r"""prefs.py - 대시보드 표시 설정(store/config.json 의 "ui" 블록) 소유 모듈.

스토어가 초기화되지 않았으면 저장은 **실패한다** - 조용히 삼키지 않는다.
UI 는 ok:false 를 받아 세션 한정 상태로 떨어진다.
"""
from __future__ import annotations
import copy, json, os, sys

# Windows 콘솔 기본 인코딩(cp949)에서 한글/em-dash 출력 시 UnicodeEncodeError 방지.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import lib_store
from cli_result import emit, guard, JsonArgumentParser

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
        "includeMissingProjects": False,
        "groupsCollapsed": [],
    },
    # 보던 자리. 호스트가 위젯 iframe 을 다시 올려도 같은 파일·같은 필터로 돌아오게 한다.
    "view": {
        "selectedPath": "",
        "detailOpen": True,
        "scope": "all",           # all | global | <projectPath>
        "libTarget": "",          # "" = 전역, 아니면 프로젝트 .claude
    },
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
        _merge_known(ui, saved)
    ui["sections"]["preset"] = _norm_preset(ui["sections"]["preset"])
    return ui


def _merge_known(ui, patch):
    """DEFAULT_UI 에 있는 블록·키만 받아들인다. 모르는 키는 저장하지 않는다."""
    for block, keys in ui.items():
        for k, v in ((patch or {}).get(block) or {}).items():
            if k in keys:
                keys[k] = v


def save_ui(store, patch):
    """patch 의 알려진 sections/view 키만 덮어쓴다. 스토어 미초기화면 StoreNotInitialized."""
    cfg = lib_store.load_cfg(store)
    ui = load_ui(store)
    _merge_known(ui, patch)
    ui["sections"]["preset"] = _norm_preset(ui["sections"]["preset"])
    cfg["ui"] = ui
    lib_store.save_cfg(store, cfg)
    return ui


def main():
    ap = JsonArgumentParser(prog="prefs", description="대시보드 표시 설정 조회/저장")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("get", "set"):
        sp = sub.add_parser(name)
        sp.add_argument("--store", default=DEFAULT_STORE)
        if name == "set":
            sp.add_argument("--json", required=True, help='{"sections": {...}, "view": {...}} 패치')
    args = ap.parse_args()

    if args.cmd == "get":
        emit(True, "ok", "표시 설정", ui=load_ui(args.store))
    try:
        patch = json.loads(args.json)
    except ValueError as e:
        emit(False, "invalid_arg", f"--json 파싱 실패: {e}", target="--json")
    try:
        ui = save_ui(args.store, patch)
    except lib_store.StoreNotInitialized as e:
        emit(False, "store_uninitialized", str(e))
    emit(True, "ok", "표시 설정 저장됨", ui=ui)


if __name__ == "__main__":
    guard(main)
