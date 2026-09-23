#!/usr/bin/env python3
r"""paths.py - Claude Desktop 데이터 디렉토리 해석 (Win32 + MSIX/Store 겸용).

Claude Desktop 의 설정(claude_desktop_config.json)과 skills-plugin manifest 는
"설치 방식"에 따라 서로 다른 물리 경로에 존재한다:

  Win32 설치본(Claude-Setup.exe)  :  %APPDATA%\Claude
  MSIX/Store 설치본               :  %LOCALAPPDATA%\Packages\Claude_<hash>\LocalCache\Roaming\Claude

핵심: MSIX 의 LocalCache 폴더는 "가상화된 %APPDATA%" 지만, 그 물리 경로 자체는
어떤 프로세스에서도 직접 읽을 수 있는 실제 폴더다. 따라서 두 후보를 모두 실제
경로로 프로브하면, config-monitor 가 Desktop 의 자식으로 실행될 때 AppData 리다이렉트가
자식 프로세스에 적용되는지(컨테이너 내부/외부) 여부와 무관하게 올바른 파일을 찾을 수 있다.

read(claude_config.py) 와 write(config_edit.py) 가 반드시 "같은 파일"을 대상으로
삼도록, 경로 해석은 이 모듈 한 곳에서만 한다(드리프트 방지).
"""
from __future__ import annotations
import os, glob as globmod

DESKTOP_CONFIG_NAME = "claude_desktop_config.json"

# ~/.claude/skills 아래의 예약 폴더. claude.ai 계정 스킬이 내려오는 자리라 사용자 스킬이 아니고,
# 편집해도 다음 동기화가 덮는다. 프로젝트 .claude/skills 에서는 예약어가 아니다.
RESERVED_SKILL_DIRS = ("synced",)


def _default(env_key, home, *tail):
    return os.environ.get(env_key, os.path.join(home, *tail))


def desktop_dir_candidates(appdata=None, localappdata=None, home=None):
    r"""Claude Desktop 데이터 디렉토리('...\Claude') 후보를 우선순위 순으로 반환.
    존재 여부와 무관하게 경로 문자열만 만든다(Win32 먼저, 그다음 발견된 MSIX 패키지들).
    appdata/localappdata/home 을 넘기면 env 대신 그 값을 쓴다(테스트/명시 지정용)."""
    home = home or os.path.expanduser("~")
    appdata = appdata or _default("APPDATA", home, "AppData", "Roaming")
    localappdata = localappdata or _default("LOCALAPPDATA", home, "AppData", "Local")

    cands = [os.path.join(appdata, "Claude")]                      # A: Win32
    # B: MSIX/Store. 패키지 패밀리 해시는 게시자 기준 고정이지만 버전/재설치에
    #    견고하도록 글롭으로 탐색(Claude_pzs8sxrjxfjjc 등).
    pkg_glob = os.path.join(localappdata, "Packages", "Claude_*",
                            "LocalCache", "Roaming", "Claude")
    cands += sorted(globmod.glob(pkg_glob))
    return cands


def _config_mtime(d):
    try:
        return os.path.getmtime(os.path.join(d, DESKTOP_CONFIG_NAME))
    except OSError:
        return None


def resolve_desktop_dir(appdata=None, localappdata=None, home=None):
    r"""실제 Claude Desktop 디렉토리를 해석한다.
      1) config 파일이 존재하는 후보 중 config mtime 이 가장 최신인 것
         (A/B 가 모두 있는 재설치·마이그레이션 상황에서 '지금 쓰이는' 파일 우선)
      2) 없으면 디렉토리라도 존재하는 후보 중 첫 번째
      3) 아무것도 없으면 첫 후보(Win32 기본). 결정적 폴백"""
    cands = desktop_dir_candidates(appdata, localappdata, home)

    with_cfg = [(c, _config_mtime(c)) for c in cands]
    with_cfg = [(c, m) for c, m in with_cfg if m is not None]
    if with_cfg:
        return max(with_cfg, key=lambda cm: cm[1])[0]

    for c in cands:
        if os.path.isdir(c):
            return c
    return cands[0]


def desktop_config_path(appdata=None, localappdata=None, home=None):
    """해석된 Claude Desktop 디렉토리 하위의 claude_desktop_config.json 절대경로."""
    return os.path.join(resolve_desktop_dir(appdata, localappdata, home), DESKTOP_CONFIG_NAME)


if __name__ == "__main__":
    # 진단용: 어떤 후보가 잡히고 무엇이 선택되는지 출력.
    import json
    cands = desktop_dir_candidates()
    info = {
        "candidates": [{"dir": c, "dir_exists": os.path.isdir(c),
                        "config_exists": os.path.exists(os.path.join(c, DESKTOP_CONFIG_NAME))}
                       for c in cands],
        "resolved_dir": resolve_desktop_dir(),
        "resolved_config": desktop_config_path(),
    }
    print(json.dumps(info, ensure_ascii=False, indent=2))
