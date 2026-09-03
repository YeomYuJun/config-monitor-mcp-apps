#!/usr/bin/env python3
r"""
config_edit.py - Claude 설정 파일 안전 편집기 (스냅샷-선행 + atomic write + .bak).

안전장치:
  1) 편집 전 cas.py 스냅샷 시도(추적 중이면 롤백 지점 생성). 실패해도 편집은 진행.
  2) 편집 전 타임스탬프 .bak 백업.
  3) tmp 파일에 쓴 뒤 JSON 파싱 검증 통과해야 os.replace 로 원자적 교체.

대상:
  ~/.claude/settings.json                          permissions / hooks / enabledPlugins
  ~/.claude.json                                   전역 mcpServers (scope=user)
  <Desktop>/claude_desktop_config.json             Desktop mcpServers (scope=desktop)
    <Desktop> = Win32 는 %APPDATA%/Claude, MSIX/Store 는 패키지 하위. paths.py 가 프로브해 해석.
  ~/.claude/skills/<name>/                         code 스킬 (scaffold/remove)
  ~/.claude/agents/<name>.md                       에이전트 (scaffold/remove)
    --skills-dir/--agents-dir 로 프로젝트-로컬(<root>/.claude/skills) 지정 가능.
    형태는 <...>/.claude/<skills|agents> 로 제한(_safe_config_dir).
출력은 항상 JSON 한 줄 ({ok, message, ...}) — MCP 서버가 그대로 파싱.

ops:
  perm-add    <allow|deny|ask> <rule>
  perm-remove <allow|deny|ask> <rule>
  hook-add    <event> <command> [--matcher M]
  hook-remove <event> <command-substring>
  skill-scaffold <name> [--desc D]
  skill-remove   <name>                            (.trash 로 이동 — 복구 가능)
  agent-scaffold <name> [--desc D] [--tools T] [--model M]
  agent-remove   <name>                            (.trash 로 이동)
  mcp-add        <name> --json '<serverConfig>' [--scope user|desktop]
  mcp-remove     <name> [--scope user|desktop]
  plugin-toggle  <id> <on|off>                     enabledPlugins[<id>] (다음 세션부터 적용)

파괴적 삭제는 없다: JSON 편집은 스냅샷+.bak+atomic, 파일/디렉토리 삭제는 .trash 이동.
"""
from __future__ import annotations
import argparse, contextlib, json, os, shutil, sys, time

# Windows 콘솔 기본 인코딩(cp949)에서 한글/em-dash 출력 시 UnicodeEncodeError 방지.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import paths  # read(claude_config.py) 와 동일한 해석기로 Desktop config 경로를 잡는다
import cas    # 스냅샷은 in-process 로 찍는다(락을 편집 전후로 걸쳐 쥐기 위해 - snapshot_before 주석)

HOME = os.path.expanduser("~")
DEFAULT_SETTINGS = os.path.join(HOME, ".claude", "settings.json")
DEFAULT_SKILLS = os.path.join(HOME, ".claude", "skills")
DEFAULT_AGENTS = os.path.join(HOME, ".claude", "agents")

# 단일 파일 항목(하위 디렉토리, 확장자). skills 는 디렉토리형이라 여기 없다 - 이쪽은 파일 하나가
# 항목 하나라서 scaffold/remove 한 쌍이 세 종류를 다 덮는다.
ITEM_KINDS = {
    "rule":         ("rules", ".md"),
    "output-style": ("output-styles", ".md"),
    "workflow":     ("workflows", ".js"),
}


def item_stub(kind, name, desc, paths=""):
    """workflow 는 meta 블록이 없으면 실행되지 않으므로 스텁도 그 형태를 지켜야 한다.
    rule 의 paths: 는 적재 등급을 EAGER 에서 LAZY 로 바꾼다(빈 값이면 넣지 않는다)."""
    if kind == "workflow":
        return (f"export const meta = {{\n"
                f"  name: '{name}',\n"
                f"  description: '{desc}',\n"
                f"  phases: [{{ title: 'Work' }}],\n"
                f"}}\n\nphase('Work')\n")
    fm = [f"name: {name}", f"description: {desc}"]
    if kind == "rule" and paths:
        fm.append(f"paths:\n  - {paths}")
    return "---\n" + "\n".join(fm) + f"\n---\n\n# {name}\n\n작성 중.\n"


def _safe_memory_dir(d):
    """--memory-dir 검증: <...>/projects/<encoded>/memory 형태만 허용.
    메모리는 .claude/<sub> 형태가 아니라 _safe_config_dir 을 못 쓴다. 가드 없이 두면
    도구 파라미터로 들어온 임의 경로가 trash() 까지 도달한다."""
    n = os.path.normpath(d)
    nc = os.path.normcase
    if nc(os.path.basename(n)) != nc("memory") or        nc(os.path.basename(os.path.dirname(os.path.dirname(n)))) != nc("projects"):
        out(False, f"메모리 디렉토리가 유효하지 않음(<...>/projects/<name>/memory 형태만 허용): '{d}'")
    return n
DEFAULT_CLAUDE_JSON = os.path.join(HOME, ".claude.json")
# Win32(%APPDATA%\Claude) vs MSIX/Store(...\Packages\Claude_*\LocalCache\Roaming\Claude)
# 를 프로브해 실제 파일을 대상으로 삼는다. --desktop-config 로 명시 오버라이드 가능.
DEFAULT_DESKTOP_CONFIG = paths.desktop_config_path()
HERE = os.path.dirname(os.path.abspath(__file__))

def out(ok, message, **extra):
    print(json.dumps({"ok": ok, "message": message, **extra}, ensure_ascii=False))
    sys.exit(0 if ok else 1)

def load(path):
    # utf-8-sig: PowerShell Out-File 등이 남기는 BOM 을 견딘다(utf-8 로 열면 json 이 거부해
    # 편집이 전부 트레이스백으로 죽고 stdout 순수 JSON 계약도 깨진다). BOM 없는 파일도 동일 처리.
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)

def _slot_dict(d, key):
    """d[key] 를 dict 로 보장하고 반환. 손편집으로 남은 null 을 빈 값으로 되살린다."""
    v = d.get(key)
    if not isinstance(v, dict):
        v = d[key] = {}
    return v

def _slot_list(d, key):
    """d[key] 를 list 로 보장하고 반환(위와 동일 취지)."""
    v = d.get(key)
    if not isinstance(v, list):
        v = d[key] = []
    return v

def backup(path):
    if os.path.exists(path):
        bak = f"{path}.{time.strftime('%Y%m%d%H%M%S')}.bak"
        shutil.copy2(path, bak)
        return bak
    return None

def save_atomic(path, data):
    """JSON 직렬화 + 원자 교체. 개행은 기존 파일의 방식(CRLF/LF)을 따라 bytes 로 쓴다.
    텍스트 모드면 Windows 가 \\n 을 \\r\\n 으로 바꿔 LF 파일(Claude Code 가 쓰는 형식)
    전체가 뒤집히고, 이후 diff 가 전량 삭제+추가로 보인다. 새 파일은 LF."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2)
    try:
        with open(path, "rb") as f:
            crlf = b"\r\n" in f.read()
    except OSError:
        crlf = False
    if crlf:
        text = text.replace("\n", "\r\n")
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(text.encode("utf-8"))
    with open(tmp, encoding="utf-8") as f:  # 검증
        json.load(f)
    os.replace(tmp, path)

def _store_p(store):
    return cas.store_paths(store or cas.DEFAULT_STORE)

# snapshot_before 가 잡은 스냅샷 락을 snapshot_after 까지 들고 가는 스팬 상태.
_snap_span = {"lock": None, "p": None}

def _release_span():
    lock = _snap_span["lock"]
    _snap_span["lock"] = _snap_span["p"] = None
    if lock is not None:
        with contextlib.suppress(Exception):
            lock.__exit__(None, None, None)

def snapshot_before(store):
    """편집 직전: 아직 스냅샷 안 된 변경(대시보드 밖 편집)을 롤백 지점으로 보존하고,
    스냅샷 락을 잡은 채 유지한다. 락은 snapshot_after 가 op 스냅샷을 찍은 뒤 푼다 -
    풀어 두면 파일 쓰기와 op 스냅샷 사이에 watcher tick 이 먼저 찍어 편집 결과가
    'auto:' 메시지로 기록되고, 리비전에 작업 이름이 남지 않는다(경합 가드).
    실패는 무시(편집 자체는 진행)."""
    try:
        if _snap_span["p"] is not None:          # 이미 스팬 안 - 드리프트만 추가 캡처
            cas._take_snapshot_locked(_snap_span["p"], "external change (before edit)")
            return
        p = _store_p(store)
        lock = cas._snapshot_lock(p)
        lock.__enter__()
        _snap_span["lock"], _snap_span["p"] = lock, p
        cas._take_snapshot_locked(p, "external change (before edit)")
    except Exception:
        _release_span()

def snapshot_once(store, message):
    """단발 스냅샷(락을 스팬으로 유지하지 않는다). 오래 걸리는 위임 작업(claude CLI 등)의
    전/후 캡처용 - 스팬을 쓰면 60초 뒤 죽은 락으로 판정돼 회수된다(cas.LOCK_STALE_SEC).
    실패는 무시(작업 자체는 진행)."""
    try:
        p = _store_p(store)
        with cas._snapshot_lock(p):
            cas._take_snapshot_locked(p, message)
    except Exception:
        pass

def snapshot_after(store, message):
    """편집 직후: 이 편집의 결과를 op 메시지로 스냅샷 후 락 해제. 전에는 pre-스냅샷만
    있어서 리비전 N 의 diff 가 N-1 편집 내용을 보여주는 오프바이원 귀속이 났다.
    snapshot_before 가 실패했으면 단독 락으로라도 찍는다."""
    try:
        if _snap_span["p"] is not None:
            cas._take_snapshot_locked(_snap_span["p"], message)
        else:
            p = _store_p(store)
            with cas._snapshot_lock(p):
                cas._take_snapshot_locked(p, message)
    except Exception:
        pass
    finally:
        _release_span()

def trash(path):
    """rmtree 대신 형제 .trash/<name>.<ts> 로 이동 — 디렉토리 삭제도 복구 가능하게."""
    parent = os.path.dirname(os.path.normpath(path))
    tdir = os.path.join(parent, ".trash")
    os.makedirs(tdir, exist_ok=True)
    dst = os.path.join(tdir, f"{os.path.basename(os.path.normpath(path))}.{time.strftime('%Y%m%d%H%M%S')}")
    shutil.move(path, dst)
    return dst

def edit_json_file(path, mutate, no_snapshot, store):
    """settings 외 임의 JSON 설정 파일에 동일한 안전 패턴 적용.
    mutate(data) -> (data, msg, changed)."""
    data = load(path)
    data, msg, changed = mutate(data)
    if not changed:
        out(True, msg + " (no-op)", changed=False)
    if not no_snapshot:
        snapshot_before(store)
    bak = backup(path)
    save_atomic(path, data)
    if not no_snapshot:
        snapshot_after(store, msg)
    out(True, msg, changed=True, file=path, backup=bak)

# ── ops (settings 딕셔너리를 받아 (settings, msg) 반환) ──

def op_perm_add(s, kind, rule):
    lst = _slot_list(_slot_dict(s, "permissions"), kind)
    if rule in lst:
        return s, f"이미 존재: {kind} '{rule}'", False
    lst.append(rule)
    return s, f"추가됨: permissions.{kind} += '{rule}'", True

def op_perm_remove(s, kind, rule):
    lst = _slot_list(_slot_dict(s, "permissions"), kind)
    if rule not in lst:
        return s, f"없음(변경 안 함): {kind} '{rule}'", False
    lst.remove(rule)
    return s, f"제거됨: permissions.{kind} -= '{rule}'", True

def op_hook_add(s, event, command, matcher):
    arr = _slot_list(_slot_dict(s, "hooks"), event)
    arr.append({"matcher": matcher or "*", "hooks": [{"type": "command", "command": command}]})
    return s, f"hook 추가됨: {event} (matcher={matcher or '*'}) <- {command}", True

def op_hook_remove(s, event, needle):
    r"""command 가 needle 과 정확히 일치하는 훅만 제거.
    직렬화 JSON 에 부분 문자열로 맞추던 방식은 세 가지가 동시에 틀렸다:
      - 접두가 같은 다른 훅까지 제거('node a.js' 로 'node a.js --verbose' 까지)
      - 명령 속 " 나 \ 가 json.dumps 로 이스케이프돼 매칭 자체가 성립 안 함(제거 불가)
      - 엔트리째 버려서 같은 matcher 안의 형제 훅까지 소실
    훅 단위로 지우고 비게 된 엔트리·이벤트 키·hooks 딕셔너리까지 정리한다 - 빈 껍데기를
    남기면 {"hooks":{"PostToolUse":[]}} 같은 찌꺼기가 사용자 settings.json 에 쌓인다."""
    arr = _slot_list(_slot_dict(s, "hooks"), event)
    removed, kept = 0, []
    for ent in arr:
        if not isinstance(ent, dict):
            kept.append(ent)
            continue
        hooks = _slot_list(ent, "hooks")
        left = [hk for hk in hooks if not (isinstance(hk, dict) and hk.get("command") == needle)]
        removed += len(hooks) - len(left)
        ent["hooks"] = left
        if left:
            kept.append(ent)
    arr[:] = kept
    if removed and not arr:
        hooks_map = s.get("hooks")
        if isinstance(hooks_map, dict):
            hooks_map.pop(event, None)
            if not hooks_map:
                s.pop("hooks", None)
    return s, f"hook 제거됨 {removed}건: {event} ~ '{needle}'", removed > 0

def op_plugin_toggle(s, pid, on):
    """settings.json 의 enabledPlugins[<id>] **만** 건드린다.

    id 는 '<플러그인 이름>@<마켓 이름>' 이고 **마켓 매니페스트 엔트리 이름** 쪽에서 온다.
    plugin.json 의 name(표시 네임스페이스)과 다를 수 있다 - 실측: 매니페스트는 'notion',
    plugin.json 은 'Notion', 세션 표시는 'Notion:create-page', 토글 키는
    'notion@claude-plugins-official'. 그래서 여기서 대소문자 정규화 같은 걸 하지 않는다.
    호출부는 plugin_state 가 준 id 를 그대로 넘겨야 한다.

    대상 파일은 --settings 로 온다. plugin_state.read_enabled 가 **그 값을 정한 파일**을
    enabled_from 에 남기고 카드가 그걸 들고 오므로, 프로젝트에서 켠 플러그인을 전역
    파일에서 껐다가 안 먹는 상황이 생기지 않는다.

    적용은 다음 세션부터다 - Claude Code 가 enabledPlugins 를 세션 시작 시 읽는다."""
    if not pid:
        return s, "플러그인 id 가 비어 있음", False
    m = s.setdefault("enabledPlugins", {})
    if m.get(pid) is on:
        return s, f"이미 {'켜짐' if on else '꺼짐'}: {pid}", False
    m[pid] = on
    return s, f"플러그인 {'켬' if on else '끔'}: {pid} (다음 세션부터 적용)", True

def op_mcp_add(d, name, server):
    servers = _slot_dict(d, "mcpServers")
    existed = name in servers
    servers[name] = server
    return d, f"{'갱신' if existed else '추가'}됨: mcpServers.{name}", True

def op_mcp_remove(d, name):
    servers = d.get("mcpServers") or {}   # 없거나 null 이면 제거할 것도 없음(키를 새로 만들지 않는다)
    if name not in servers:
        return d, f"없음(변경 안 함): mcpServers.{name}", False
    del servers[name]
    return d, f"제거됨: mcpServers.{name}", True

def _safe_name(name):
    """디렉토리 탈출/경로 주입 방지: 이름은 경로 구분자·상대참조 없이 단일 세그먼트만."""
    if not name or name != os.path.basename(name) or name in (".", "..") or \
       any(c in name for c in "\\/"):
        out(False, f"이름이 유효하지 않음: '{name}'")
    return name

def _safe_config_dir(d, sub):
    """--skills-dir/--agents-dir 검증: <...>/.claude/<sub> 형태만 허용.
    이 옵션들이 MCP 도구 파라미터(프로젝트-로컬 삭제)로 노출되면서 임의 경로가 trash() 까지
    도달할 수 있게 됐다. _safe_name 은 이름 세그먼트만 막으므로 디렉토리도 한 겹 막는다.
    전역(~/.claude/skills)과 프로젝트(<root>/.claude/skills) 둘 다 이 형태라 호출부는 그대로."""
    n = os.path.normpath(d)
    nc = os.path.normcase                                  # Win 대소문자 무시 / POSIX 그대로
    if nc(os.path.basename(n)) != nc(sub) or nc(os.path.basename(os.path.dirname(n))) != nc(".claude"):
        out(False, f"설정 디렉토리가 유효하지 않음(<...>/.claude/{sub} 형태만 허용): '{d}'")
    return n

SETTINGS_NAMES = ("settings.json", "settings.local.json")

def _safe_settings_path(p):
    """--settings 검증: <...>/.claude/settings[.local].json 형태만 허용.
    _safe_config_dir 이 디렉토리 인자에 거는 제약을 파일 인자에도 건다 - 이쪽만 비어 있으면
    save_atomic 의 makedirs 가 임의 경로에 트리를 만들며 JSON 을 쓴다(도구 파라미터로 노출된
    값이다). 실제 대상은 전역(~/.claude)과 프로젝트(<root>/.claude) 둘뿐이라 호출부는 그대로.
    Claude 가 읽는 이름은 settings.json / settings.local.json 두 개다(claude_config._settings_in)."""
    n = os.path.normpath(p)
    nc = os.path.normcase
    if nc(os.path.basename(n)) not in tuple(nc(x) for x in SETTINGS_NAMES) or \
       nc(os.path.basename(os.path.dirname(n))) != nc(".claude"):
        out(False, f"settings 경로가 유효하지 않음(<...>/.claude/settings[.local].json 형태만 허용): '{p}'")
    return n

def main():
    ap = argparse.ArgumentParser(prog="config_edit")
    ap.add_argument("--settings", default=DEFAULT_SETTINGS)
    ap.add_argument("--skills-dir", default=DEFAULT_SKILLS)
    ap.add_argument("--agents-dir", default=DEFAULT_AGENTS)
    ap.add_argument("--items-dir", default=None, help="item-* 대상 디렉토리(<...>/.claude/<sub>). 미지정 시 전역")
    ap.add_argument("--memory-dir", default=None, help="memory-remove 대상(<...>/projects/<name>/memory)")
    ap.add_argument("--claude-json", default=DEFAULT_CLAUDE_JSON)
    ap.add_argument("--desktop-config", default=DEFAULT_DESKTOP_CONFIG)
    ap.add_argument("--store", default=os.environ.get("CLAUDE_SNAPSHOT_STORE"))
    ap.add_argument("--no-snapshot", action="store_true", help="편집 전 cas 스냅샷 생략")
    sub = ap.add_subparsers(dest="op", required=True)

    p = sub.add_parser("perm-add");    p.add_argument("kind", choices=["allow", "deny", "ask"]); p.add_argument("rule")
    p = sub.add_parser("perm-remove"); p.add_argument("kind", choices=["allow", "deny", "ask"]); p.add_argument("rule")
    p = sub.add_parser("hook-add");    p.add_argument("event"); p.add_argument("command"); p.add_argument("--matcher")
    p = sub.add_parser("hook-remove"); p.add_argument("event"); p.add_argument("needle")
    p = sub.add_parser("skill-scaffold"); p.add_argument("name"); p.add_argument("--desc", default="TODO")
    p.add_argument("--content", default=None, help="SKILL.md 전체 내용(frontmatter 포함). 지정 시 스텁 대신 그대로 기록")
    p = sub.add_parser("skill-remove");   p.add_argument("name")
    p = sub.add_parser("agent-scaffold"); p.add_argument("name"); p.add_argument("--desc", default="TODO")
    p.add_argument("--tools", default=""); p.add_argument("--model", default="")
    p.add_argument("--content", default=None, help="에이전트 md 전체 내용(frontmatter 포함). 지정 시 desc/tools/model 무시")
    p = sub.add_parser("agent-remove");   p.add_argument("name")
    p = sub.add_parser("item-scaffold"); p.add_argument("kind", choices=list(ITEM_KINDS)); p.add_argument("name")
    p.add_argument("--desc", default="TODO"); p.add_argument("--paths", default="", help="rule 전용: 지정하면 LAZY 가 된다")
    p.add_argument("--content", default=None, help="파일 전체 내용. 지정 시 스텁 대신 그대로 기록")
    p = sub.add_parser("item-remove");   p.add_argument("kind", choices=list(ITEM_KINDS)); p.add_argument("name")
    p = sub.add_parser("memory-remove"); p.add_argument("name")
    p = sub.add_parser("outputstyle-set"); p.add_argument("name", help="빈 문자열이면 선택 해제")
    p = sub.add_parser("plugin-toggle"); p.add_argument("id"); p.add_argument("state", choices=["on", "off"])
    p = sub.add_parser("mcp-add");    p.add_argument("name"); p.add_argument("--json", dest="server_json", required=True)
    p.add_argument("--scope", choices=["user", "desktop"], default="user")
    p = sub.add_parser("mcp-remove"); p.add_argument("name")
    p.add_argument("--scope", choices=["user", "desktop"], default="user")

    a = ap.parse_args()

    # 경로 인자는 쓰이기 전에 형태 검증(_safe_settings_path / _safe_config_dir 주석 참고).
    a.settings = _safe_settings_path(a.settings)
    if a.op in ("skill-scaffold", "skill-remove"):
        a.skills_dir = _safe_config_dir(a.skills_dir, "skills")
    elif a.op in ("agent-scaffold", "agent-remove"):
        a.agents_dir = _safe_config_dir(a.agents_dir, "agents")
    elif a.op in ("item-scaffold", "item-remove"):
        sub_dir, _ext = ITEM_KINDS[a.kind]
        a.items_dir = _safe_config_dir(a.items_dir or os.path.join(HOME, ".claude", sub_dir), sub_dir)
    elif a.op == "memory-remove":
        if not a.memory_dir:
            out(False, "memory-remove 는 --memory-dir 이 필요합니다")
        a.memory_dir = _safe_memory_dir(a.memory_dir)

    # ── 단일 파일 항목 ops (rules / output-styles / workflows) ──
    if a.op == "item-scaffold":
        name = _safe_name(a.name)
        _sub, ext = ITEM_KINDS[a.kind]
        f_path = os.path.join(a.items_dir, name + ext)
        if os.path.exists(f_path):
            out(False, f"이미 존재: {f_path}")
        if not a.no_snapshot:
            snapshot_before(a.store)
        os.makedirs(a.items_dir, exist_ok=True)
        body = a.content if a.content else item_stub(a.kind, name, a.desc, a.paths)
        with open(f_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
        msg = f"{a.kind} {'설치' if a.content else '스캐폴드 생성'}: {f_path}"
        if not a.no_snapshot:
            snapshot_after(a.store, msg)
        out(True, msg, path=f_path)

    if a.op == "item-remove":
        name = _safe_name(a.name)
        _sub, ext = ITEM_KINDS[a.kind]
        f_path = os.path.join(a.items_dir, name + ext)
        if not os.path.exists(f_path):
            out(False, f"{a.kind} 없음: {f_path}")
        if not a.no_snapshot:
            snapshot_before(a.store)
        dst = trash(f_path)
        msg = f"{a.kind} 제거됨(.trash 이동): {name}"
        if not a.no_snapshot:
            snapshot_after(a.store, msg)
        out(True, msg, trashed=dst)

    if a.op == "memory-remove":
        name = _safe_name(a.name)
        f_path = os.path.join(a.memory_dir, name + ".md")
        if not os.path.exists(f_path):
            out(False, f"메모리 없음: {f_path}")
        if not a.no_snapshot:
            snapshot_before(a.store)
        dst = trash(f_path)
        msg = f"메모리 제거됨(.trash 이동): {name}"
        if not a.no_snapshot:
            snapshot_after(a.store, msg)
        out(True, msg, trashed=dst)

    if a.op == "outputstyle-set":
        # 파일을 만드는 게 아니라 '무엇이 EAGER 인가'를 바꾸는 유일한 스위치다.
        def _mut(d):
            cur = d.get("outputStyle")
            if a.name:
                d["outputStyle"] = a.name
                return d, f"output style 활성화: {a.name}", cur != a.name
            d.pop("outputStyle", None)
            return d, "output style 선택 해제", cur is not None
        edit_json_file(a.settings, _mut, a.no_snapshot, a.store)

    # ── 파일/디렉토리 기반 ops (skills / agents) ──
    if a.op == "skill-scaffold":
        name = _safe_name(a.name)
        d = os.path.join(a.skills_dir, name)
        md = os.path.join(d, "SKILL.md")
        if os.path.exists(md):
            out(False, f"이미 존재: {md}")
        if not a.no_snapshot:
            snapshot_before(a.store)
        os.makedirs(d, exist_ok=True)
        body = a.content if a.content else \
            f"---\nname: {name}\ndescription: {a.desc}\n---\n\n# {name}\n\n작성 중.\n"
        with open(md, "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
        msg = f"스킬 {'설치' if a.content else '스캐폴드 생성'}: {md}"
        if not a.no_snapshot:
            snapshot_after(a.store, msg)
        out(True, msg, path=md)

    if a.op == "skill-remove":
        name = _safe_name(a.name)
        d = os.path.join(a.skills_dir, name)
        if not os.path.isdir(d):
            out(False, f"스킬 없음: {d}")
        if not a.no_snapshot:
            snapshot_before(a.store)
        dst = trash(d)
        msg = f"스킬 제거됨(.trash 이동): {name}"
        if not a.no_snapshot:
            snapshot_after(a.store, msg)
        out(True, msg, trashed=dst)

    if a.op == "agent-scaffold":
        name = _safe_name(a.name)
        md = os.path.join(a.agents_dir, f"{name}.md")
        if os.path.exists(md):
            out(False, f"이미 존재: {md}")
        if not a.no_snapshot:
            snapshot_before(a.store)
        os.makedirs(a.agents_dir, exist_ok=True)
        if a.content:
            body = a.content
        else:
            fm = [f"name: {name}", f"description: {a.desc}"]
            if a.tools:
                fm.append(f"tools: {a.tools}")
            if a.model:
                fm.append(f"model: {a.model}")
            body = "---\n" + "\n".join(fm) + f"\n---\n\n# {name}\n\n작성 중.\n"
        with open(md, "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
        msg = f"에이전트 {'설치' if a.content else '스캐폴드 생성'}: {md}"
        if not a.no_snapshot:
            snapshot_after(a.store, msg)
        out(True, msg, path=md)

    if a.op == "agent-remove":
        name = _safe_name(a.name)
        # <name>.md 파일 또는 <name>/ 디렉토리(AGENT.md 형) 둘 다 지원
        cand = [os.path.join(a.agents_dir, f"{name}.md"), os.path.join(a.agents_dir, name)]
        target = next((c for c in cand if os.path.exists(c)), None)
        if target is None:
            out(False, f"에이전트 없음: {name} ({a.agents_dir})")
        if not a.no_snapshot:
            snapshot_before(a.store)
        dst = trash(target)
        msg = f"에이전트 제거됨(.trash 이동): {name}"
        if not a.no_snapshot:
            snapshot_after(a.store, msg)
        out(True, msg, trashed=dst)

    # ── mcpServers ops: scope 에 따라 대상 파일 선택 ──
    if a.op in ("mcp-add", "mcp-remove"):
        target = a.desktop_config if a.scope == "desktop" else a.claude_json
        if a.op == "mcp-add":
            try:
                server = json.loads(a.server_json)
            except json.JSONDecodeError as e:
                out(False, f"--json 파싱 실패: {e}")
            if not isinstance(server, dict):
                out(False, "--json 은 서버 설정 객체여야 함 (예: {\"command\":\"npx\",\"args\":[...]})")
            edit_json_file(target, lambda d: op_mcp_add(d, a.name, server), a.no_snapshot, a.store)
        else:
            edit_json_file(target, lambda d: op_mcp_remove(d, a.name), a.no_snapshot, a.store)

    # ── 이하 settings.json 편집 ──
    s = load(a.settings)
    if a.op == "perm-add":      s, msg, changed = op_perm_add(s, a.kind, a.rule)
    elif a.op == "perm-remove": s, msg, changed = op_perm_remove(s, a.kind, a.rule)
    elif a.op == "hook-add":    s, msg, changed = op_hook_add(s, a.event, a.command, a.matcher)
    elif a.op == "hook-remove": s, msg, changed = op_hook_remove(s, a.event, a.needle)
    elif a.op == "plugin-toggle": s, msg, changed = op_plugin_toggle(s, a.id, a.state == "on")
    else:
        out(False, f"알 수 없는 op: {a.op}")

    if not changed:
        out(True, msg + " (no-op)", changed=False)

    if not a.no_snapshot:
        snapshot_before(a.store)
    bak = backup(a.settings)
    save_atomic(a.settings, s)
    if not a.no_snapshot:
        snapshot_after(a.store, msg)
    out(True, msg, changed=True, settings=a.settings, backup=bak)

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        # stdout 한 줄 JSON 계약 유지: 예기치 못한 실패(권한/디스크 등)도 트레이스백 대신 사유로.
        _release_span()
        print(json.dumps({"ok": False, "message": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        sys.exit(1)
