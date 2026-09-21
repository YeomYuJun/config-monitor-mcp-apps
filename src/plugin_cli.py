#!/usr/bin/env python3
r"""plugin_cli.py - `claude plugin ...` 위임(플러그인/마켓플레이스 단위 조작).

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

## 여기서 하지 않는 것

- **enable / disable**: `claude plugin enable|disable` 이 있지만 쓰지 않는다. 그 조작은
  settings.json 의 enabledPlugins 한 키를 뒤집는 게 전부라서, config_edit.op_plugin_toggle 로
  직접 쓰면 스냅샷 + .bak + 원자적 쓰기 + 롤백이 공짜로 붙고 claude 가 PATH 에 없어도 된다.
- **auto-update / favorites / mark-for-update**: 셋 다 CLI 서브커맨드가 없다(`claude plugin
  marketplace` 는 add/list/remove/update 뿐). favorites/mark-for-update 는 저장 흔적도 없어 키를
  추측할 수밖에 없고, 추측으로 남의 설정 파일에 키를 만들지 않는다. auto-update 는 저장 위치가
  있지만(known_marketplaces.json 의 autoUpdate ↔ settings 의 extraKnownMarketplaces[].autoUpdate)
  claude 가 그 둘을 자기 규칙으로 동기화하므로 사이에 끼어드는 건 별도 판단이 필요하다.

출력은 항상 JSON 한 줄({ok, code, message, ...}, cli_result 계약) - MCP 서버가 그대로 파싱한다.
"""
from __future__ import annotations
import argparse, json, os, shutil, subprocess, sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import marketplace   # safe_segment - 매니페스트에서 온 이름은 신뢰할 수 없는 입력이다
from cli_result import emit, guard, JsonArgumentParser
import config_edit   # snapshot_once - CLI 가 settings.json 을 직접 쓰므로 전/후를 이력에 남긴다

TIMEOUT = 600        # 설치/갱신은 네트워크 + git 이다. hooks 설치보다 넉넉히 준다.


def out(ok, code, message, **extra):
    emit(ok, code, message, **extra)


def claude_path():
    """PATH 의 claude 실행 파일. 없으면 None.

    Windows 에서 npm 전역 설치면 claude.cmd 로 잡히는데, 실측 결과 subprocess 가 .cmd 를
    그대로 실행한다(CreateProcess 가 처리한다). shell=True 로 올릴 이유가 없다."""
    return shutil.which("claude")


def _no_leading_dash(v, what):
    """리스트 인자라 셸 주입은 없지만, claude CLI 자신이 '-' 로 시작하는 값을 옵션으로 읽는다."""
    if not isinstance(v, str) or not v or v.startswith("-"):
        out(False, "invalid_arg", f"{what}가 유효하지 않음: {v!r}", target=v)
    return v


def _safe_name(v, what):
    """마켓/플러그인 **이름** 검증. 경로 세그먼트 규율(marketplace.safe_segment)까지 적용한다.

    마켓 **소스**(owner/repo, URL, 로컬 경로)에는 쓰면 안 된다 - 그건 세그먼트가 아니다."""
    _no_leading_dash(v, what)
    try:
        marketplace.safe_segment(v, what)
    except marketplace.ManifestError as e:
        out(False, "invalid_arg", str(e), target=v)
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


# ── op 별 argv 조립 ─────────────────────────────────────────────────────────
# 각 함수는 (claude 뒤에 붙을 인자 리스트, 사람이 읽을 대상 이름) 을 돌려준다.
# 검증은 조립 시점에 한다 - 거부되면 프로세스를 아예 띄우지 않는다.

def _plugin_id(a):
    return f"{_safe_name(a.plugin, '플러그인 이름')}@{_safe_name(a.marketplace, '마켓 이름')}"


def _build(a):
    op = a.op
    if op == "install":
        pid = _plugin_id(a)
        return ["plugin", "install", pid, "--scope", a.scope], pid
    if op == "update":
        pid = _plugin_id(a)
        return ["plugin", "update", pid, "--scope", a.scope], pid
    if op == "uninstall":
        pid = _plugin_id(a)
        # -y 를 항상 준다: 우리는 항상 비-TTY 로 부르고, 그 경우 확인 프롬프트가 뜨면
        # 응답할 수 없어 TIMEOUT 까지 매달린다. -y 는 프롬프트를 건너뛸 뿐 대상은 안 늘린다.
        argv = ["plugin", "uninstall", pid, "--scope", a.scope, "-y"]
        if a.keep_data:
            argv.append("--keep-data")
        return argv, pid
    if op == "market-add":
        # 소스는 owner/repo · URL · 로컬 경로 중 무엇이든 될 수 있어 세그먼트 검증을 못 한다.
        # 옵션 오인만 막고 나머지 판정은 claude 에 맡긴다(저쪽이 자기 형식의 주인이다).
        src = _no_leading_dash(a.source, "마켓 소스")
        argv = ["plugin", "marketplace", "add", src, "--scope", a.scope]
        for s in (a.sparse or []):
            _no_leading_dash(s, "sparse 경로")
        if a.sparse:
            argv += ["--sparse", *a.sparse]
        return argv, src
    if op == "market-update":
        # 이름 없이 부르면 전체 갱신이다(claude 의 계약). 그 경우도 명시적으로 보고한다.
        if not a.name:
            return ["plugin", "marketplace", "update"], "(전체)"
        n = _safe_name(a.name, "마켓 이름")
        return ["plugin", "marketplace", "update", n], n
    if op == "market-remove":
        n = _safe_name(a.name, "마켓 이름")
        argv = ["plugin", "marketplace", "remove", n]
        # scope 를 생략하면 claude 가 **모든 스코프**에서 지운다. 그게 기본이지만 조용히
        # 넓게 지우는 셈이라, 호출부가 고를 수 있게 열어 두고 기본은 저쪽 기본을 따른다.
        if a.scope:
            argv += ["--scope", a.scope]
        return argv, n
    out(False, "invalid_arg", f"알 수 없는 op: {op}", target=op)


DONE = {"install": "설치됨", "uninstall": "제거됨", "update": "갱신됨",
        "market-add": "마켓 등록됨", "market-update": "마켓 갱신됨", "market-remove": "마켓 제거됨"}
# 마켓 등록/제거는 세션 재시작과 무관하다(선언만 바뀐다). 컴포넌트가 오가는 조작만 안내한다.
NEEDS_RESTART = {"install", "uninstall", "update"}


def main():
    ap = JsonArgumentParser(prog="plugin_cli",
                                 description="claude plugin / marketplace 조작 위임")
    sub = ap.add_subparsers(dest="op", required=True)

    made = []

    def parser(name):
        p = sub.add_parser(name)
        made.append(p)
        return p

    def plugin_op(name, scopes):
        p = parser(name)
        p.add_argument("--marketplace", required=True)
        p.add_argument("--plugin", required=True)
        p.add_argument("--scope", choices=scopes, default="user")
        return p

    plugin_op("install", ["user", "project", "local"])
    # update 만 managed 스코프를 받는다(claude plugin update --help 실측).
    plugin_op("update", ["user", "project", "local", "managed"])
    p = plugin_op("uninstall", ["user", "project", "local"])
    p.add_argument("--keep-data", action="store_true",
                   help="플러그인의 영속 데이터(~/.claude/plugins/data/<id>/)를 남긴다")

    p = parser("market-add")
    p.add_argument("source", help="owner/repo · git URL · marketplace.json URL · 로컬 경로")
    p.add_argument("--scope", choices=["user", "project", "local"], default="user")
    p.add_argument("--sparse", nargs="*", default=None, help="모노레포에서 체크아웃할 디렉토리")
    p = parser("market-update")
    p.add_argument("--name", default=None, help="생략하면 등록된 마켓 전체")
    p = parser("market-remove")
    p.add_argument("--name", required=True)
    p.add_argument("--scope", choices=["user", "project", "local"], default=None,
                   help="생략하면 모든 스코프에서 제거(claude 기본)")

    # 모든 op 이 공유하는 옵션. 서브파서마다 따로 달아야 하위 파서가 인식한다.
    for sp in made:
        sp.add_argument("--cwd", default=None,
                        help="scope=project/local 기준 디렉토리(claude 는 cwd 로 프로젝트를 정한다)")
        sp.add_argument("--dry-run", action="store_true", help="실행할 명령만 돌려준다")
        sp.add_argument("--store", default=os.environ.get("CLAUDE_SNAPSHOT_STORE"))
        sp.add_argument("--no-snapshot", action="store_true", help="전/후 cas 스냅샷 생략")

    a = ap.parse_args()
    tail, target = _build(a)
    exe = claude_path()
    argv = [exe or "claude", *tail]
    cwd = a.cwd or None
    if cwd and not os.path.isdir(cwd):
        out(False, "invalid_arg", f"cwd 가 디렉토리가 아님: {cwd}", target=cwd)

    if a.dry_run:
        out(True, "dry_run", "실행하지 않음(dry-run)", dry_run=True, target=target, command=argv,
            cwd=cwd, available=bool(exe))
    if not exe:
        out(False, "tool_missing", "claude 를 PATH 에서 찾을 수 없습니다 - 플러그인/마켓 조작은 Claude Code CLI 에 위임합니다",
            target=target, command=argv)

    # CLI 는 추적 대상(settings.json 의 enabledPlugins 등)을 직접 쓴다 - 편집 경로처럼
    # 전/후를 스냅샷해 이력 공백을 막는다. 단, 위임은 최대 600초라 락을 걸쳐 쥘 수 없어
    # (60초 뒤 죽은 락으로 회수됨) 단발 2회로 하고, 그 사이 watcher 가 중간 상태를
    # auto: 로 찍을 수 있는 건 수용한다.
    if not a.no_snapshot:
        config_edit.snapshot_once(a.store, "external change (before edit)")
    rc, so, se = _run(argv, cwd)
    if rc != 0:
        out(False, "external_failed", f"claude {' '.join(tail)} 실패 (rc={rc})", detail=se or so or None,
            target=target, command=argv, cwd=cwd, stdout=so, stderr=se, rc=rc)
    tail_msg = " (다음 세션부터 적용)" if a.op in NEEDS_RESTART else ""
    if not a.no_snapshot:
        config_edit.snapshot_once(a.store, f"{DONE[a.op]}: {target} (claude CLI)")
    out(True, "ok", f"{DONE[a.op]}: {target}{tail_msg}",
        target=target, command=argv, cwd=cwd, stdout=so, stderr=se,
        scope=getattr(a, "scope", None))


if __name__ == "__main__":
    guard(main)
