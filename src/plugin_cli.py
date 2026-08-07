#!/usr/bin/env python3
r"""plugin_cli.py - `claude plugin ...` 위임(플러그인 통째 설치/제거).

**config-monitor 에서 claude CLI 를 부르는 유일한 자리다.** scan 경로는 여기를 import 하지
않는다(claude_config -> plugin_state 는 파일만 읽는다). 명령 경로에서만 쓴다.

## 왜 손으로 안 쓰고 위임하는가

플러그인 통째 설치는 `~/.claude/plugins/installed_plugins.json` 에 기록되는데 그건
`"version": 2` 가 붙은 비공개 포맷이고 이미 한 번 마이그레이션했다. 손으로 쓰면 다음
버전에서 조용히 깨진다. 설치 자체도 매니페스트 해석 + 소스별 fetch(url / git-subdir /
str-path / github 4종) + 캐시 배치 + .in_use 마킹이라 재구현할 이유가 없다.

## 두 설치 모델을 합치지 않는 이유

  Library 모델   항목 1개를 ~/.claude/skills/<name> 로 복사. 이름 평탄. 설치 전 diff·롤백 O.
                 Claude Desktop 에도 넣을 수 있다(Desktop 엔 플러그인 개념이 없다).
  Plugins 모델   플러그인 통째를 캐시에 두고 참조. 이름은 <ns>:<item>. 토글로 on/off.

Claude Code 원장에는 "12개 중 3개를 설치했음"을 담을 필드가 **없다**. 그래서 Library 모델의
설치를 저쪽에 반영하는 건 불가능하고, 반대로 이 모듈이 하는 플러그인 단위 조작은 전부 된다.
두 모델은 마켓플레이스라는 같은 출처를 공유할 뿐 서로를 대체하지 않는다.

출력은 항상 JSON 한 줄({ok, message, ...}) - MCP 서버가 그대로 파싱한다.
"""
from __future__ import annotations
import argparse, json, os, shutil, subprocess, sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import marketplace   # safe_segment - 매니페스트에서 온 이름은 신뢰할 수 없는 입력이다

TIMEOUT = 600        # 설치는 네트워크 + git 이다. hooks 설치보다 넉넉히 준다.


def out(ok, message, **extra):
    print(json.dumps({"ok": ok, "message": message, **extra}, ensure_ascii=False))
    sys.exit(0 if ok else 1)


def claude_path():
    """PATH 의 claude 실행 파일. 없으면 None.

    Windows 에서 npm 전역 설치면 claude.cmd 로 잡히는데, 실측 결과 subprocess 가 .cmd 를
    그대로 실행한다(CreateProcess 가 처리한다). shell=True 로 올릴 이유가 없다."""
    return shutil.which("claude")


def _safe_name(v, what):
    """마켓/플러그인 이름 검증. 경로 세그먼트 규율(marketplace.safe_segment)에 더해
    '-' 로 시작하는 값을 막는다 - CLI 가 옵션으로 오인한다."""
    if not isinstance(v, str) or not v or v.startswith("-"):
        out(False, f"{what}가 유효하지 않음: {v!r}")
    try:
        marketplace.safe_segment(v, what)
    except marketplace.ManifestError as e:
        out(False, str(e))
    return v


def _run(argv, cwd=None):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", cwd=cwd, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, "", f"{TIMEOUT}초 안에 끝나지 않았습니다"
    except OSError as e:
        return None, "", str(e)
    return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()


def _dispatch(a, verb):
    """install / uninstall 공통. verb 만 다르고 인자 구성과 보고 형식은 같다."""
    exe = claude_path()
    pid = f"{_safe_name(a.plugin, '플러그인 이름')}@{_safe_name(a.marketplace, '마켓 이름')}"
    argv = [exe or "claude", "plugin", verb, pid]
    # scope 는 install 만 받는다(uninstall 은 설치된 스코프에서 지운다).
    if verb == "install":
        argv += ["--scope", a.scope]
    # scope=project/local 은 **cwd 로** 프로젝트를 정한다(경로 인자가 없다).
    cwd = a.cwd or None
    if cwd and not os.path.isdir(cwd):
        out(False, f"cwd 가 디렉토리가 아님: {cwd}")

    if a.dry_run:
        out(True, "실행하지 않음(dry-run)", dry_run=True, id=pid, command=argv, cwd=cwd,
            available=bool(exe))
    if not exe:
        out(False, "claude 를 PATH 에서 찾을 수 없습니다 - 플러그인 통째 설치는 Claude Code CLI 에 위임합니다",
            id=pid, command=argv)

    rc, so, se = _run(argv, cwd)
    if rc != 0:
        out(False, se or so or f"claude plugin {verb} 실패 (rc={rc})",
            id=pid, command=argv, cwd=cwd, stdout=so, stderr=se, code=rc)
    # 컴포넌트는 세션 시작 시 로드된다 - 설치 직후 세션에는 반영되지 않는다.
    done = "설치됨" if verb == "install" else "제거됨"
    out(True, f"플러그인 {done}: {pid} (다음 세션부터 적용)",
        id=pid, command=argv, cwd=cwd, stdout=so, stderr=se,
        scope=(a.scope if verb == "install" else None))


def main():
    ap = argparse.ArgumentParser(prog="plugin_cli",
                                 description="claude plugin install/uninstall 위임")
    sub = ap.add_subparsers(dest="op", required=True)
    for name in ("install", "uninstall"):
        p = sub.add_parser(name)
        p.add_argument("--marketplace", required=True)
        p.add_argument("--plugin", required=True)
        p.add_argument("--cwd", default=None,
                       help="scope=project/local 일 때 기준 디렉토리(claude 는 cwd 로 프로젝트를 정한다)")
        p.add_argument("--dry-run", action="store_true", help="실행할 명령만 돌려준다")
        if name == "install":
            p.add_argument("--scope", choices=["user", "project", "local"], default="user")
    a = ap.parse_args()
    _dispatch(a, a.op)


if __name__ == "__main__":
    main()
