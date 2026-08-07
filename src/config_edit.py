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
import argparse, json, os, shutil, subprocess, sys, time

# Windows 콘솔 기본 인코딩(cp949)에서 한글/em-dash 출력 시 UnicodeEncodeError 방지.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import paths  # read(claude_config.py) 와 동일한 해석기로 Desktop config 경로를 잡는다

HOME = os.path.expanduser("~")
DEFAULT_SETTINGS = os.path.join(HOME, ".claude", "settings.json")
DEFAULT_SKILLS = os.path.join(HOME, ".claude", "skills")
DEFAULT_AGENTS = os.path.join(HOME, ".claude", "agents")
DEFAULT_CLAUDE_JSON = os.path.join(HOME, ".claude.json")
# Win32(%APPDATA%\Claude) vs MSIX/Store(...\Packages\Claude_*\LocalCache\Roaming\Claude)
# 를 프로브해 실제 파일을 대상으로 삼는다. --desktop-config 로 명시 오버라이드 가능.
DEFAULT_DESKTOP_CONFIG = paths.desktop_config_path()
HERE = os.path.dirname(os.path.abspath(__file__))

def out(ok, message, **extra):
    print(json.dumps({"ok": ok, "message": message, **extra}, ensure_ascii=False))
    sys.exit(0 if ok else 1)

def load(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def backup(path):
    if os.path.exists(path):
        bak = f"{path}.{time.strftime('%Y%m%d%H%M%S')}.bak"
        shutil.copy2(path, bak)
        return bak
    return None

def save_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    with open(tmp, encoding="utf-8") as f:  # 검증
        json.load(f)
    os.replace(tmp, path)

def snapshot_before(store):
    """cas.py 스냅샷 시도(있으면). 실패는 무시(편집 자체는 진행)."""
    try:
        env = dict(os.environ)
        if store:
            env["CLAUDE_SNAPSHOT_STORE"] = store
        subprocess.run([sys.executable, os.path.join(HERE, "cas.py"), "snapshot",
                        "-m", "before config edit"], cwd=HERE, env=env,
                       capture_output=True, timeout=30)
    except Exception:
        pass

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
    out(True, msg, changed=True, file=path, backup=bak)

# ── ops (settings 딕셔너리를 받아 (settings, msg) 반환) ──

def op_perm_add(s, kind, rule):
    lst = s.setdefault("permissions", {}).setdefault(kind, [])
    if rule in lst:
        return s, f"이미 존재: {kind} '{rule}'", False
    lst.append(rule)
    return s, f"추가됨: permissions.{kind} += '{rule}'", True

def op_perm_remove(s, kind, rule):
    lst = s.get("permissions", {}).get(kind, [])
    if rule not in lst:
        return s, f"없음(변경 안 함): {kind} '{rule}'", False
    lst.remove(rule)
    return s, f"제거됨: permissions.{kind} -= '{rule}'", True

def op_hook_add(s, event, command, matcher):
    arr = s.setdefault("hooks", {}).setdefault(event, [])
    arr.append({"matcher": matcher or "*", "hooks": [{"type": "command", "command": command}]})
    return s, f"hook 추가됨: {event} (matcher={matcher or '*'}) <- {command}", True

def op_hook_remove(s, event, needle):
    """command 문자열에 needle 이 든 hook 만 제거. 비게 된 matcher 엔트리·이벤트 키도 정리.

    직렬화 결과(json.dumps)에 매칭하면 안 된다: JSON 이 \\ 를 \\\\ 로 이스케이프하므로
    Windows 경로를 담은 needle(대시보드가 카드에 그대로 표시하는 command 원문)은 영원히
    0건이 되어 조용히 no-op 으로 끝났다 — plugin_units.entry_refs_root 주석이 짚은
    findings.md §8 과 같은 결함이다. 파싱된 구조의 command 를 직접 읽는다.
    matcher 엔트리 통째가 아니라 그 안의 hook 하나만 지운다 — UI 가 나열하는 단위가
    command 이므로, 같은 matcher 에 묶인 다른 hook 까지 날아가면 안 된다."""
    hooks = s.get("hooks", {})
    arr = hooks.get(event, [])
    kept_entries, removed = [], 0
    for ent in arr:
        inner = ent.get("hooks") if isinstance(ent, dict) else None
        if not isinstance(inner, list) or not inner:
            kept_entries.append(ent)          # 형식이 다르거나 빈 엔트리는 이 op 의 대상이 아니다
            continue
        # dict 가 아닌 항목(오염된 설정)은 command 를 가질 수 없으니 매칭 대상이 아니다 - 보존.
        kept = [h for h in inner if not (isinstance(h, dict) and needle in str(h.get("command", "")))]
        removed += len(inner) - len(kept)
        if kept:
            ent["hooks"] = kept
            kept_entries.append(ent)
    if removed:
        if kept_entries:
            hooks[event] = kept_entries
        else:
            hooks.pop(event, None)            # 빈 배열을 남기지 않는다
        if hooks:
            s["hooks"] = hooks
        else:
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
    servers = d.setdefault("mcpServers", {})
    existed = name in servers
    servers[name] = server
    return d, f"{'갱신' if existed else '추가'}됨: mcpServers.{name}", True

def op_mcp_remove(d, name):
    servers = d.get("mcpServers", {})
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

def main():
    ap = argparse.ArgumentParser(prog="config_edit")
    ap.add_argument("--settings", default=DEFAULT_SETTINGS)
    ap.add_argument("--skills-dir", default=DEFAULT_SKILLS)
    ap.add_argument("--agents-dir", default=DEFAULT_AGENTS)
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
    p = sub.add_parser("plugin-toggle"); p.add_argument("id"); p.add_argument("state", choices=["on", "off"])
    p = sub.add_parser("mcp-add");    p.add_argument("name"); p.add_argument("--json", dest="server_json", required=True)
    p.add_argument("--scope", choices=["user", "desktop"], default="user")
    p = sub.add_parser("mcp-remove"); p.add_argument("name")
    p.add_argument("--scope", choices=["user", "desktop"], default="user")

    a = ap.parse_args()

    # skills/agents 디렉토리 인자는 쓰이기 전에 형태 검증(_safe_config_dir 주석 참고).
    if a.op in ("skill-scaffold", "skill-remove"):
        a.skills_dir = _safe_config_dir(a.skills_dir, "skills")
    elif a.op in ("agent-scaffold", "agent-remove"):
        a.agents_dir = _safe_config_dir(a.agents_dir, "agents")

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
        out(True, f"스킬 {'설치' if a.content else '스캐폴드 생성'}: {md}", path=md)

    if a.op == "skill-remove":
        name = _safe_name(a.name)
        d = os.path.join(a.skills_dir, name)
        if not os.path.isdir(d):
            out(False, f"스킬 없음: {d}")
        if not a.no_snapshot:
            snapshot_before(a.store)
        dst = trash(d)
        out(True, f"스킬 제거됨(.trash 이동): {name}", trashed=dst)

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
        out(True, f"에이전트 {'설치' if a.content else '스캐폴드 생성'}: {md}", path=md)

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
        out(True, f"에이전트 제거됨(.trash 이동): {name}", trashed=dst)

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
    out(True, msg, changed=True, settings=a.settings, backup=bak)

if __name__ == "__main__":
    main()
