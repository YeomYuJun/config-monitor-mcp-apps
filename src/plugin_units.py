#!/usr/bin/env python3
r"""plugin_units.py - hooks / MCP 서버 설치 유닛.

agents/skills/commands 는 leaf 가 자기완결적이라 ~/.claude 로 복사한다. hooks 는 아니다:
2개 플러그인이 ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/ 를 참조한다(hooks/ 의 형제 디렉토리).
설치 단위는 hooks/ 가 아니라 **플러그인 루트 전체**다.

그래서 vendoring 하지 않는다 - fetch 된 플러그인 루트를 캐시에 그대로 두고
${CLAUDE_PLUGIN_ROOT} 를 그 절대 캐시 경로로 치환한 엔트리를 settings.json 에 병합한다.
결과로 캐시가 load-bearing 이 되고, 원장이 그 삭제를 막는다.

함정: 명령을 정규식으로 뽑으면 이스케이프된 \" 에서 잘려 0건 오답이 난다.
반드시 json.load 로 파싱한 구조에서 읽는다.

이 모듈은 이미 fetch 된 파일 위의 순수 로직이다. library/lib_store/remote_fetch/marketplace 를
import 하지 않는다 - 네트워크도, git 도, subprocess 도 없다.
"""
from __future__ import annotations
import json, os, shutil

PLUGIN_ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}"
HOOKS_REL = os.path.join("hooks", "hooks.json")
MCP_REL = ".mcp.json"
PLUGIN_JSON_REL = os.path.join(".claude-plugin", "plugin.json")


def substitute(obj, root: str):
    """중첩 구조의 모든 문자열에서 ${CLAUDE_PLUGIN_ROOT} 를 root 로 치환. 입력을 변형하지 않는다."""
    if isinstance(obj, str):
        return obj.replace(PLUGIN_ROOT_VAR, root)
    if isinstance(obj, list):
        return [substitute(x, root) for x in obj]
    if isinstance(obj, dict):
        return {k: substitute(v, root) for k, v in obj.items()}
    return obj


def load_hooks_json(plugin_root: str):
    p = os.path.join(plugin_root, HOOKS_REL)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def load_mcp_json(plugin_root: str):
    """플러그인의 MCP 서버 선언. **소스가 둘이다.**

    표준은 루트의 `.mcp.json` 이지만, plugin.json 안에 mcpServers 를 인라인으로 선언하는
    플러그인도 있다(실측: chrome-devtools-mcp 1.6.0). `.mcp.json` 만 보면 그런 플러그인은
    조용히 "MCP 0건"이 되어 설치할 게 없다고 나온다 - 대시보드 표시와 설치 가능 건수가
    어긋나는 자리다. 공식 마켓 레포 내 40개는 전부 파일 방식이고 인라인은 외부 레포에서
    가져온 플러그인 쪽에서 나온다.

    반환 형태는 두 경로가 같다(`{"mcpServers": {...}}`) - 호출부는 구분할 필요가 없다.
    `.mcp.json` 이 있으면 그쪽이 이긴다(명시 파일이 더 구체적인 선언이다)."""
    p = os.path.join(plugin_root, MCP_REL)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    meta = os.path.join(plugin_root, PLUGIN_JSON_REL)
    if not os.path.exists(meta):
        return None
    with open(meta, encoding="utf-8") as f:
        data = json.load(f)
    servers = data.get("mcpServers") if isinstance(data, dict) else None
    return {"mcpServers": servers} if isinstance(servers, dict) and servers else None


def has_mcp(plugin_root: str) -> bool:
    """설치 버튼을 띄울지 판정. load_mcp_json 과 **같은 두 소스**를 본다 -
    exists(".mcp.json") 만 보던 자리가 인라인 선언 플러그인에서 버튼을 안 띄웠다."""
    if os.path.exists(os.path.join(plugin_root, MCP_REL)):
        return True
    try:
        return bool((load_mcp_json(plugin_root) or {}).get("mcpServers"))
    except (OSError, ValueError):
        return False


UNIT_SKIP = ("node_modules", "__pycache__")


def is_unit(root: str) -> bool:
    return os.path.exists(os.path.join(root, HOOKS_REL)) or has_mcp(root)


def find_units(lib: str, depth: int = 2) -> list:
    """lib 아래 깊이 depth 까지에서 hooks/hooks.json 또는 MCP 선언을 가진 디렉토리.

    라이브러리 하나가 도구 여러 개를 나란히 담는 구조(Hooks/<name>, servers/<name>)를 위한
    것이라 lib 자체는 제외하고(루트는 호출부가 따로 본다) 유닛 안으로는 더 내려가지 않는다.
    나열 실패는 그 가지만 포기한다 - 목록 전체가 비는 것보다 한 가지가 빠지는 쪽이 낫다."""
    found = []

    def walk(d, level):
        try:
            entries = sorted(os.scandir(d), key=lambda e: e.name)
        except OSError:
            return
        for e in entries:
            if e.name.startswith(".") or e.name in UNIT_SKIP or not e.is_dir(follow_symlinks=False):
                continue
            if is_unit(e.path):
                found.append(e.path)
            elif level < depth:
                walk(e.path, level + 1)

    walk(lib, 1)
    return found


def hook_commands(hooks_cfg) -> list:
    """파싱된 구조에서 모든 command 문자열을 뽑는다(정규식 금지).

    hooks_cfg 가 None 이면 아무것도 하지 않는다 - load_hooks_json 은 hooks.json 이 없는
    (39개 중 33개가 이 경우다) 흔한 케이스에서 None 을 돌려주며, 그건 오류가 아니다."""
    cmds = []
    for entries in ((hooks_cfg or {}).get("hooks") or {}).values():
        for entry in entries or []:
            for h in (entry.get("hooks") or []):
                c = h.get("command")
                if isinstance(c, str):
                    cmds.append(c)
    return cmds


def _norm(p):
    return os.path.normcase(os.path.normpath(p))


def hook_refs_root(hook, root: str) -> bool:
    """이 hook 하나가 root 아래를 가리키는가.

    **문자열 매칭을 쓰지 않는다.** config_edit.op_hook_remove 는
    `needle not in json.dumps(h, ensure_ascii=False)` 로 직렬화 결과에 매칭하는데,
    JSON 이 \\ 를 \\\\ 로 이스케이프하므로 raw Windows 경로 needle 은 영원히 0건이 된다.
    조용히 실패해서 재설치마다 엔트리가 중복 누적된다(findings.md §8 실측).

    대신 파싱된 구조의 command 를 직접 읽고 정규화 경로로 비교한다."""
    c = hook.get("command") if isinstance(hook, dict) else None
    if not isinstance(c, str):
        return False
    # 명령은 따옴표/인자와 섞여 있다. 정규화 후 접두 비교로 판정한다.
    return _norm(root) in _norm(c)


def entry_refs_root(entry, root: str) -> bool:
    """엔트리의 hook 중 하나라도 root 를 가리키는가. entry 가 None 이면 False - 크래시 대신 no-op."""
    if not entry:
        return False
    return any(hook_refs_root(h, root) for h in (entry.get("hooks") or []))


def hooks_remove(settings: dict, root: str):
    """settings 에서 root 를 가리키는 hook 을 전부 제거. (settings, 제거한 hook 수).

    엔트리가 아니라 **hook 단위**로 지운다. 한 엔트리(같은 matcher)에 다른 도구의 hook 이
    나란히 들어 있을 수 있어서(실측: PostToolUse Edit|Write 한 엔트리에 comment-linter 와
    convention-enforcer), 엔트리째 지우면 남의 hook 이 딸려 나간다. hook 이 하나도 안 남은
    엔트리만 떨어진다."""
    hooks = settings.get("hooks") or {}
    removed = 0
    for event in list(hooks):
        keep = []
        for e in hooks[event]:
            hs = (e.get("hooks") or []) if isinstance(e, dict) else []
            left = [h for h in hs if not hook_refs_root(h, root)]
            removed += len(hs) - len(left)
            if len(left) == len(hs):
                keep.append(e)
            elif left:
                keep.append({**e, "hooks": left})
        if keep:
            hooks[event] = keep
        else:
            del hooks[event]          # 빈 배열을 남기지 않는다(설정 파일이 지저분해진다)
    if hooks:
        settings["hooks"] = hooks
    else:
        settings.pop("hooks", None)
    return settings, removed


def hooks_merge(settings: dict, hooks_cfg, new_root: str, old_root=None):
    """hooks.json 을 matcher·timeout 그대로 병합. (settings, 제거 hook 수, 추가 hook 수).

    hooks_cfg 가 None 이면(플러그인에 hooks.json 자체가 없는 흔한 경우 - load_hooks_json 이
    돌려주는 값) 아무것도 하지 않는다.

    멱등성은 **두 가지 독립된 메커니즘**으로 이룬다. 서로 다른 실패 모드를 잡기 때문에
    하나가 다른 하나를 대체하지 못한다:

    1. root 기반 제거(기존): 삽입 전에 old_root(원장의 root, 없으면 new_root)를 가리키는
       엔트리를 먼저 걷어낸다. old_root 를 쓰는 이유 - 캐시 경로가 plugins/<name>/<sha>/ 로
       sha 를 품고 있어서 sha 가 바뀌면 settings 의 기존 엔트리는 옛 경로를 가리킨다.
       새 경로로 지우면 못 걷어내고 새 엔트리가 나란히 쌓인다.
    2. identity 기반 제거(신규): root 기반 제거는 command 안에 root 문자열이 있는 엔트리만
       찾는다. hooks.json 의 command 가 ${CLAUDE_PLUGIN_ROOT} 를 전혀 안 쓰고 전역 도구를
       그대로 부르는 형태(유효한 hooks.json 이다)면 root 로는 절대 못 찾아서, 삽입할 때마다
       그 엔트리가 그대로 쌓인다 - uninstall 도 못 찾는 영구 중복. 그래서 삽입 직전에,
       이번에 추가하려는(치환 후) 엔트리와 **구조적으로 동일한** 기존 엔트리를 이벤트별로
       먼저 걷어낸다. 부작용: 사용자의 hook 이 플러그인 것과 완전히 같으면 하나로 합쳐진다 -
       둘이 구분 불가능하므로 결과 동작은 동일해서 괜찮다. 내용이 다른 사용자 hook 은
       이 필터에 걸리지 않으므로 그대로 남는다.

    빈 이벤트 배열(hooks.json 에 이벤트가 [] 로 선언된 경우)은 settings 에 빈 키를
    만들지 않는다."""
    if not hooks_cfg:
        return settings, 0, 0
    settings, removed = hooks_remove(settings, old_root or new_root)
    if old_root and _norm(old_root) != _norm(new_root):
        settings, extra = hooks_remove(settings, new_root)   # 부분 실패 잔재도 정리
        removed += extra
    subbed = substitute(hooks_cfg, new_root)
    hooks = settings.get("hooks") or {}
    added = 0
    for event, entries in (subbed.get("hooks") or {}).items():
        entries = entries or []
        if not entries:
            continue                                  # 빈 배열은 빈 키를 만들지 않는다
        existing = hooks.get(event, [])
        keep = [e for e in existing if e not in entries]   # identity 기반 제거
        removed += sum(len(e.get("hooks") or []) for e in existing if e in entries)
        hooks[event] = keep + entries
        added += sum(len(e.get("hooks") or []) for e in entries)
    if hooks:
        settings["hooks"] = hooks
    else:
        settings.pop("hooks", None)
    return settings, removed, added


def first_token(command: str) -> str:
    """명령의 첫 토큰(인터프리터). 따옴표로 감싼 경로를 지원한다."""
    s = (command or "").strip()
    if not s:
        return ""
    if s[0] in ('"', "'"):
        q = s[0]
        end = s.find(q, 1)
        return s[1:end] if end > 0 else s[1:]
    return s.split()[0]


def check_interpreter(command: str, which=None) -> dict:
    """설치 전 인터프리터 점검. 차단하지 않고 경고 배지 재료를 돌려준다.

    WindowsApps 별칭 스텁을 따로 잡는 이유: 이 머신의 python3 는 shutil.which 로 찾아지지만
    실행하면 'Python was not found' 를 낸다 - 설치해도 조용히 실패할 hook 이다."""
    which = which or shutil.which
    interp = first_token(command)
    if not interp:
        return {"interp": "", "ok": True, "reason": ""}
    if os.sep in interp or (os.altsep and os.altsep in interp):
        ok = os.path.exists(interp)     # 절대/상대 경로로 준 경우
        return {"interp": interp, "ok": ok, "reason": "" if ok else "missing"}
    found = which(interp)
    if not found:
        return {"interp": interp, "ok": False, "reason": "missing"}
    if "windowsapps" in _norm(found):
        return {"interp": interp, "ok": False, "reason": "stub", "path": found}
    return {"interp": interp, "ok": True, "reason": "", "path": found}


def interpreter_warnings(hooks_cfg: dict, which=None) -> list:
    """문제 있는 인터프리터만(정상은 안 담는다). 중복 제거."""
    seen, warns = set(), []
    for c in hook_commands(hooks_cfg):
        r = check_interpreter(c, which)
        if not r["ok"] and r["interp"] not in seen:
            seen.add(r["interp"])
            warns.append(r)
    return warns
