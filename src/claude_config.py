#!/usr/bin/env python3
r"""
claude_config.py - Claude 설정 introspection (정규화 sections JSON)

대상 경로:
  ~\.claude.json                                  Claude Code 전역 (관심 키만 선별 추출)
  ~\.claude\settings.json                         permission allow/deny + hooks
  ~\.claude\skills\*                              Code 스킬
  ~\.claude\agents\*                              Code 에이전트
  ~\Claude\Scheduled\*\SKILL.md                   스케줄러
  <Desktop>\claude_desktop_config.json            Desktop MCP
  <Desktop>\...\skills-plugin\**\manifest.json    Desktop 스킬(서버관리, 동기화 캐시)
    <Desktop> = Win32 설치본은 %APPDATA%\Claude, MSIX/Store 설치본은 패키지 하위 경로.
    설치 방식에 따라 다르므로 paths.py 가 두 후보를 프로브해 해석한다.

CLI:
  python claude_config.py discover            # 어떤 경로가 잡히는지
  python claude_config.py dump                # 정규화 상태(JSON)  ← MCP get_config 가 사용
"""
from __future__ import annotations
import argparse, json, os, glob as globmod, re, sys, tempfile
from dataclasses import dataclass

# Windows 콘솔 기본 인코딩(cp949)에서 한글/em-dash 출력 시 UnicodeEncodeError 방지.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
from datetime import datetime

import paths  # Win32/MSIX 겸용 Claude Desktop 디렉토리 해석(read↔write 동일 경로 보장)
import plugin_state  # 플러그인 레지스트리 조회(읽기 전용). 순수 모듈 - 네트워크/subprocess 없음

HOME = os.path.expanduser("~")
# Desktop 데이터 디렉토리('...\Claude')는 설치 방식(Win32 vs MSIX/Store)에 따라
# 물리 경로가 다르므로 후보를 프로브해 해석한다. config·skills-plugin manifest 둘 다 하위.
DESKTOP_DIR = paths.resolve_desktop_dir()

CANDIDATES = {
    "claude_json":     [os.path.join(HOME, ".claude.json")],
    "code_settings":   [os.path.join(HOME, ".claude", "settings.json"),
                         os.path.join(HOME, ".claude", "settings.local.json")],
    "skills_dir":      [os.path.join(HOME, ".claude", "skills")],
    "agents_dir":      [os.path.join(HOME, ".claude", "agents")],
    "commands_dir":    [os.path.join(HOME, ".claude", "commands")],
    "plugins_dir":     [os.path.join(HOME, ".claude", "plugins")],
    "rules_dir":       [os.path.join(HOME, ".claude", "rules")],
    "output_styles_dir": [os.path.join(HOME, ".claude", "output-styles")],
    "user_claude_md":  [os.path.join(HOME, ".claude", "CLAUDE.md")],
    "workflows_dir":   [os.path.join(HOME, ".claude", "workflows")],
    "themes_dir":      [os.path.join(HOME, ".claude", "themes")],
    "agent_memory_dir": [os.path.join(HOME, ".claude", "agent-memory")],
    "scheduled_dir":   [os.path.join(HOME, "Claude", "Scheduled")],
    "desktop_config":  [os.path.join(DESKTOP_DIR, "claude_desktop_config.json")],
    "desktop_skill_manifest_glob":
                       [os.path.join(DESKTOP_DIR, "local-agent-mode-sessions",
                                     "skills-plugin", "**", "manifest.json")],
}

def first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None

def all_glob(patterns):
    out = []
    for pat in patterns:
        out += globmod.glob(pat, recursive=True)
    return sorted(set(out))

def safe_load(path):
    # utf-8-sig: PowerShell 이 남긴 BOM 을 파싱 오류로 오인하지 않게(BOM 없는 파일도 동일 처리).
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception as e:
        return {"__error__": str(e)}

def _as_dict(v):
    """null/비-dict 를 빈 dict 로. 손편집으로 남은 null 하나에 dump 전체가 죽지 않게 한다."""
    return v if isinstance(v, dict) else {}

def _as_list(v):
    """null/비-list 를 빈 list 로(위와 동일 취지)."""
    return v if isinstance(v, list) else []

def _error_card(cs, scope=None, project=None):
    """파싱 실패를 '항목 없음'으로 렌더하면 설정이 사라진 것으로 오인하게 된다.
    읽지 못했다는 사실 자체를 카드로 드러낸다(.mcp.json 렌더러와 동일 동작)."""
    return card("(파싱 오류)", [("source", os.path.basename(cs)), ("error", "설정을 읽지 못함")],
                scope=scope, project=project, source=cs)

def discover(extra=None):
    found = {}
    for key, cands in CANDIDATES.items():
        if key.endswith("_glob"):
            found[key] = all_glob(cands)
        else:
            found[key] = first_existing(cands)
    if extra:
        for kv in extra:
            if "=" in kv:
                k, v = kv.split("=", 1)
                found[k] = v
    return found

def read_frontmatter(path):
    """SKILL.md / agent md 의 --- ... --- frontmatter 를 얕게 파싱."""
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
            text = f.read()
    except Exception:
        return {}
    m = re.match(r"^\s*---\s*\n(.*?)\n---\s*\n", text, re.S)
    if not m:
        return {}
    meta = {}
    for line in m.group(1).splitlines():
        mm = re.match(r"\s*([A-Za-z0-9_\-]+)\s*:\s*(.*)\s*$", line)
        if mm:
            meta[mm.group(1)] = mm.group(2).strip().strip('"\'')
    return meta

def _short(v, n=160):
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False)
    s = str(v)
    return s if len(s) <= n else s[:n] + "…"

DESC_KEYS = {"desc", "description", "설명", "summary"}

GROUPS = [
    ("instructions", "지시 · 규칙"),
    ("extensions",   "확장"),
    ("connect",      "연결 (MCP)"),
    ("exec",         "실행 · 권한"),
    ("memory",       "기억"),
    ("env",          "환경"),
]


@dataclass(frozen=True)
class Sec:
    """섹션 하나의 정체성. id 는 개수·언어와 무관한 안정 키 - 저장되는 표시 설정의 키가 된다.
    load 가 None 이면 카드마다 다르다는 뜻(rules/output-styles/project-memory)."""
    id: str
    title: str
    group: str
    scopes: tuple = ()
    load: str = None
    note: str = ""


def _sec(*a, **kw):
    s = Sec(*a, **kw)
    return s.id, s


SECTIONS = dict([
    _sec("claude-md", "CLAUDE.md", "instructions", ("user", "project"), "eager",
         "세션마다 전문 적재"),
    _sec("rules", "Rules", "instructions", ("user", "project"), None,
         "paths: 있으면 LAZY · 없으면 EAGER"),
    _sec("output-styles", "Output Styles", "instructions", ("user", "project"), None,
         "outputStyle 로 선택된 것만 EAGER"),
    _sec("mcp-desktop", "MCP Servers (desktop)", "connect", ("desktop",), "never"),
    _sec("claude-json", "Claude Code (.claude.json)", "connect", ("user",), "never",
         "앱 상태 · 전역 MCP · trust"),
    _sec("mcp-project", "MCP Servers (project)", "connect", ("project",), "lazy", "연결/스키마"),
    _sec("perm", "Permissions", "exec", ("user", "project"), "never", "런타임 판정"),
    _sec("hooks", "Hooks", "exec", ("user", "project"), "never", "런타임 실행"),
    _sec("skills", "Skills (code)", "extensions", ("user", "project"), "eager",
         "name+description 만 · 본문 LAZY"),
    _sec("agents", "Agents", "extensions", ("user", "project"), "eager",
         "description 만 · 본문 LAZY"),
    _sec("commands", "Commands", "extensions", ("user", "project"), "lazy", "본문은 호출 시"),
    _sec("workflows", "Workflows", "extensions", ("user", "project"), "lazy",
         "각 파일이 /<name>"),
    _sec("plugins", "Plugins", "extensions", ("user",), "never",
         "관리 단위 · 항목은 각 섹션에 합류"),
    _sec("project-memory", "Project Memory", "memory", ("user",), None,
         "MEMORY.md EAGER(앞 200줄/25KB) · topic LAZY"),
    _sec("agent-memory", "Agent Memory", "memory", ("user", "project"), "lazy",
         "서브에이전트 memory"),
    _sec("themes", "Themes", "env", ("user",), "never", "/theme 목록 · hot-reload"),
    _sec("worktreeinclude", ".worktreeinclude", "env", ("project",), "lazy",
         "worktree 생성 시 복사 목록"),
    _sec("scheduled", "Scheduled Tasks", "env", ("desktop",)),
    _sec("desktop-skills", "Desktop Skills", "connect", ("desktop",)),
])


def _is_add_card(c):
    """'＋ 새 …' 스캐폴드 카드. 항목이 아니라 입력 폼이므로 개수에 들어가면 안 된다
    - 규칙 0개인 Rules 가 '· 1' 로 보이고, 빈 섹션 숨기기도 걸리지 않는다."""
    return str((c.get("edit") or {}).get("kind", "")).endswith("-add")


def _count(cards):
    return sum(1 for c in cards if not _is_add_card(c))


def _section(sid, cards, source=None):
    """레지스트리 항목 + 카드 -> 섹션 dict. 제목의 ' · N' 은 여기서만 붙인다."""
    s = SECTIONS[sid]
    d = {"id": s.id, "title": f"{s.title} · {_count(cards)}", "group": s.group,
         "source": source, "cards": cards}
    if s.load:
        d["load"] = s.load
    if s.note:
        d["note"] = s.note
    return d


def _recount(sec):
    sec["title"] = f"{SECTIONS[sec['id']].title} · {_count(sec['cards'])}"


def card(name, kv, badge=None, ok=False, edit=None, scope=None, project=None, source=None,
         plugin=None, builtin=False):
    # 서술형 값은 넉넉히 담고(줄 수 표시는 UI 의 -webkit-line-clamp 가 담당),
    # 코드형/경로 값만 160자 선절단 — 슬라이더(2~10줄) 전 구간이 실제 텍스트로 채워지게.
    c = {"name": name, "badge": badge, "ok": ok,
         "kv": [[k, _short(v, 600 if str(k).lower() in DESC_KEYS else 160)] for k, v in kv]}
    if edit:  # UI 가 인라인 add/remove 버튼을 그릴 때 쓰는 구조화 메타
        c["edit"] = edit
    # scope/project 는 프로젝트 전용 항목에만 붙는다(전역 항목은 미부여).
    if scope:
        c["scope"] = scope
    if project:
        c["project"] = project
    # source 는 한 섹션에 여러 파일이 섞이는 항목(perm/hook/plugin)에만 붙는다.
    # 같은 이름의 카드(allow 등)가 파일마다 나오므로 카드 자신이 출처를 들고 있어야 한다.
    if source:
        c["source"] = source
    # plugin 은 이 항목이 플러그인에서 온 것임을 표시(값은 토글 키인 id). 로컬 항목에는 없다.
    # scope/source 와 직교한다 - 플러그인 항목은 파일이 아니라 플러그인 캐시에서 오기 때문.
    if plugin:
        c["plugin"] = plugin
    # builtin = 내가 만든 게 아니라 기본 제공된 항목(Desktop Skills 의 creatorType=anthropic).
    # plugin 과 다른 축이다: 플러그인은 내가 설치한 것이고 이쪽은 처음부터 있던 것이라,
    # 목록을 줄일 때 각각 따로 끄고 싶어진다.
    if builtin:
        c["builtin"] = True
    return c

def _dir_settings(d):
    """디렉토리 d 에서 실제로 적용되는 settings 파일들(존재하는 것만).
    Claude 는 settings.json 과 settings.local.json 을 모두 읽고 local 이 우선한다.
    first_existing 으로 하나만 보면 실제 적용 중인 규칙이 안 보인다."""
    return [p for p in (os.path.join(d, "settings.json"), os.path.join(d, "settings.local.json"))
            if os.path.exists(p)]

def _settings_chain(cs):
    """전역에서 적용되는 settings 파일들. 같은 디렉토리의 settings.json/settings.local.json 을
    함께 본다. cs 가 그 둘 중 하나가 아니면(--paths 로 다른 파일을 직접 지정) 그 파일만."""
    if not cs:
        return []
    files = _dir_settings(os.path.dirname(cs))
    return files if cs in files else [cs]

def _source_label(files):
    """섹션 헤더용 출처 표기. 여러 파일이면 '(+N more)'(Desktop Skills 섹션과 동일 표기)."""
    if not files:
        return None
    return f"{files[0]}  (+{len(files)-1} more)" if len(files) > 1 else files[0]

# --- 섹션별 카드 빌더(전역/프로젝트 공용). scope=None 이면 전역,
#     scope="project" 이면 프로젝트 항목으로 태깅. 프로젝트 항목은 편집 대상 경로를 카드가 직접 들고 간다
#     (perm/hook 은 edit.settings, skills/agents 는 edit.dir) -> 전역 디렉토리 오삭제 없이 로컬 제거 가능.
#     전역 카드에는 그 경로를 붙이지 않는다: 도구 기본값(~/.claude)으로 가는 기존 호출을 그대로 유지.
def _perm_cards(cs, scope=None, project=None):
    cards = []
    if cs and os.path.exists(cs):
        data = _as_dict(safe_load(cs))
        if "__error__" in data:
            return [_error_card(cs, scope, project)]
        perms = _as_dict(data.get("permissions"))
        for kind in ("allow", "deny", "ask"):
            lst = _as_list(perms.get(kind))
            # settings 는 항상 지정 - 같은 이름의 카드가 파일마다 나오므로 편집이 그 카드의 파일로 가야 한다.
            # (전역 settings.json 이면 config_edit 의 기본 대상과 같은 경로라 동작 변화 없음.)
            edit = {"kind": "perm", "permKind": kind, "items": list(lst), "settings": cs}
            cards.append(card(kind, [("source", os.path.basename(cs))],
                              badge=str(len(lst)), ok=(kind == "allow"),
                              edit=edit, scope=scope, project=project, source=cs))
    return cards

def _hook_cards(cs, scope=None, project=None):
    cards = []
    if cs and os.path.exists(cs):
        data = _as_dict(safe_load(cs))
        if "__error__" in data:
            return [_error_card(cs, scope, project)]
        hooks = _as_dict(data.get("hooks"))
        for event, entries in hooks.items():
            entries = _as_list(entries)
            cmds = [hk.get("command", "") for ent in entries
                    for hk in _as_list(_as_dict(ent).get("hooks")) if isinstance(hk, dict)]
            edit = {"kind": "hook", "event": event, "items": cmds, "settings": cs}
            cards.append(card(event, [("matchers", len(entries)),
                                      ("source", os.path.basename(cs))], badge="hook",
                              edit=edit, scope=scope, project=project, source=cs))
    return cards

def _skill_cards(sd, scope=None, project=None):
    cards = []
    if sd and os.path.isdir(sd):
        for name in sorted(os.listdir(sd)):
            if name.startswith("."):
                continue
            full = os.path.join(sd, name)
            if os.path.isdir(full):
                has_md = os.path.exists(os.path.join(full, "SKILL.md"))
                meta = read_frontmatter(os.path.join(full, "SKILL.md")) if has_md else {}
                edit = {"kind": "skill", "name": name}
                if scope == "project":
                    edit["dir"] = sd   # 이 프로젝트의 skills 디렉토리를 제거 대상으로 명시
                cards.append(card(name, [("desc", meta.get("description", "-")), ("path", full)],
                                  badge="SKILL.md" if has_md else "no md", ok=has_md,
                                  edit=edit, scope=scope, project=project))
        if scope != "project":
            cards.append(card("＋ 새 스킬", [("형식", "name 설명…")],
                              badge="add", edit={"kind": "skill-add"}))
    return cards

def _iter_agents(ad):
    """agents/ 를 재귀 순회해 (rel, md, disp, top) 목록을 만든다.
    Claude 는 하위 폴더의 에이전트까지 읽으므로 한 단계만 보면 실제로 있는 것을 없다고 표시하게 된다.
      rel  = 표시용 상대 이름(구분자 '/', 확장자 제거)
      md   = frontmatter 를 읽을 파일
      disp = 카드에 보일 경로(파일형은 md 자신, AGENT.md 디렉토리형은 그 디렉토리)
      top  = 편집 가능한 단일 세그먼트 이름. 중첩 항목은 None(제거 op 가 못 받음 -> 뷰 전용).
    dot 디렉토리(.trash 등)는 모든 깊이에서 제외 - 삭제 보관분이 살아있는 항목으로 되살아나면 안 된다."""
    items = []

    def walk(d, prefix):
        try:
            names = sorted(os.listdir(d))
        except OSError:
            return
        for name in names:
            if name.startswith("."):
                continue
            full = os.path.join(d, name)
            if os.path.isdir(full):
                agent_md = os.path.join(full, "AGENT.md")
                if os.path.exists(agent_md):
                    # 디렉토리 자체가 에이전트 한 개(AGENT.md 형): 내부는 리소스이므로 더 내려가지 않는다.
                    items.append((prefix + name, agent_md, full, name if not prefix else None))
                else:
                    walk(full, prefix + name + "/")
            elif name.endswith(".md"):
                stem = name[:-3]
                items.append((prefix + stem, full, full, stem if not prefix else None))

    walk(ad, "")
    return items

def _iter_md(d):
    """디렉토리 d 를 재귀 순회해 (rel, path) 목록. rel 은 구분자 '/', 확장자 제거.
    commands 는 하위 폴더가 네임스페이스가 되므로 한 단계만 보면 있는 것을 없다고 표시하게 된다.
    dot 디렉토리(.trash 등)는 모든 깊이에서 제외."""
    items = []

    def walk(cur, prefix):
        try:
            names = sorted(os.listdir(cur))
        except OSError:
            return
        for name in names:
            if name.startswith("."):
                continue
            full = os.path.join(cur, name)
            if os.path.isdir(full):
                walk(full, prefix + name + "/")
            elif name.endswith(".md"):
                items.append((prefix + name[:-3], full))

    walk(d, "")
    return items

def _command_cards(cd, scope=None, project=None):
    """commands/ 의 *.md(슬래시 커맨드). config_edit 에 제거 op 가 없으므로 뷰 전용."""
    cards = []
    if cd and os.path.isdir(cd):
        for rel, full in _iter_md(cd):
            meta = read_frontmatter(full)
            cards.append(card(rel, [
                ("desc", meta.get("description", "-")),
                ("path", full),
            ], badge="command", ok=True, scope=scope, project=project))
    return cards

def _size_kv(path):
    """적재 비용을 말하려면 크기가 필요하다 - EAGER 표면에서 이게 요점이다."""
    try:
        return [("size", f"{os.path.getsize(path):,} B")]
    except OSError:
        return []


def _md_dir_cards(d, badge, scope=None, project=None, load_of=None, edit_of=None):
    """*.md 디렉토리를 재귀 순회해 카드로. rel 은 '/' 구분 · 확장자 제거(_iter_md 와 동일).
    load_of(rel, path, meta) 를 주면 카드마다 적재등급을 따로 정한다."""
    cards = []
    if not (d and os.path.isdir(d)):
        return cards
    for rel, full in _iter_md(d):
        meta = read_frontmatter(full)
        c = card(rel, [("desc", meta.get("description", "-"))] + _size_kv(full) + [("path", full)],
                 badge=badge, ok=True, scope=scope, project=project)
        if load_of:
            c["load"] = load_of(rel, full, meta)
        if edit_of:
            e = edit_of(rel, full, meta)
            if e:
                c["edit"] = e
        cards.append(c)
    return cards


def _glob_cards(d, pattern, badge, scope=None, project=None, edit_of=None):
    cards = []
    if not (d and os.path.isdir(d)):
        return cards
    for full in sorted(globmod.glob(os.path.join(d, pattern))):
        rel = os.path.splitext(os.path.basename(full))[0]
        c = card(rel, _size_kv(full) + [("path", full)],
                 badge=badge, ok=True, scope=scope, project=project)
        if edit_of:
            e = edit_of(rel, full, {})
            if e:
                c["edit"] = e
        cards.append(c)
    return cards


def _file_card(path, badge, scope=None, project=None, load=None):
    """단일 파일 -> 카드 0개 또는 1개. 없으면 빈 리스트(섹션이 알아서 빈다)."""
    if not (path and os.path.exists(path)):
        return []
    c = card(os.path.basename(path), _size_kv(path) + [("path", path)],
             badge=badge, ok=True, scope=scope, project=project, source=path)
    if load:
        c["load"] = load
    return [c]


def _item_edit(item_kind, rel, d, scope, extra=None):
    """중첩 항목(하위 폴더)은 제거 op 가 단일 세그먼트만 받으므로 뷰 전용이다.
    전역 카드에는 dir 을 붙이지 않는다 - 도구 기본값(~/.claude/<sub>)으로 가게 둔다."""
    if "/" in rel:
        return None
    e = {"kind": "item", "itemKind": item_kind, "name": rel}
    if scope == "project":
        e["dir"] = d
    if extra:
        e.update(extra)
    return e


def _add_card(item_kind, label):
    return card(label, [("형식", "name 설명…")], badge="add",
                edit={"kind": "item-add", "itemKind": item_kind})


def _rules_cards(d, scope=None, project=None):
    """paths: frontmatter 가 있으면 매칭 파일을 읽을 때만(LAZY), 없으면 세션 시작에 적재(EAGER)."""
    cards = _md_dir_cards(d, "rule", scope, project,
                          load_of=lambda rel, p, meta: "lazy" if "paths" in meta else "eager",
                          edit_of=lambda rel, p, meta: _item_edit("rule", rel, d, scope))
    if scope != "project":
        cards.append(_add_card("rule", "＋ 새 규칙"))
    return cards


def _active_output_style(chain):
    """settings 체인에서 실제로 선택된 output style. local 이 뒤에 오므로 뒤가 이긴다.
    키가 없으면 None - '선택된 스타일 없음'은 정상 상태다(실측: 이 키가 없는 settings 가 흔하다)."""
    active = None
    for cs in chain or []:
        v = _as_dict(safe_load(cs)).get("outputStyle")
        if isinstance(v, str) and v:
            active = v
    return active


def _output_style_cards(d, active=None, scope=None, project=None, settings=None):
    """선택된 하나만 컨텍스트에 들어간다. 나머지는 파일로만 존재한다.
    active 여부를 edit 에 실어 보낸다 - '무엇이 EAGER 인가'를 바꾸는 유일한 스위치라
    배지로 보여주기만 하고 바꿀 수단이 없으면 반쪽이다."""
    def _edit(rel, p, meta):
        extra = {"active": rel == active}
        if settings:
            extra["settings"] = settings
        return _item_edit("output-style", rel, d, scope, extra)
    cards = _md_dir_cards(d, "output-style", scope, project,
                          load_of=lambda rel, p, meta: "eager" if rel == active else "never",
                          edit_of=_edit)
    if scope != "project":
        cards.append(_add_card("output-style", "＋ 새 출력 스타일"))
    return cards


CLAUDE_MD_RELS = ("CLAUDE.md", "CLAUDE.local.md", os.path.join(".claude", "CLAUDE.md"))


def _claude_md_cards(root, scope=None, project=None):
    """CLAUDE.md · CLAUDE.local.md · .claude/CLAUDE.md 를 한 섹션의 세 카드로.
    같은 종류라 섹션을 셋으로 쪼개면 목록만 길어진다."""
    cards = []
    for rel in CLAUDE_MD_RELS:
        cards += _file_card(os.path.join(root, rel), rel, scope, project, load="eager")
    return cards


def _encode_project_dir(path):
    """<project path> -> ~/.claude/projects/<encoded>. 영숫자가 아닌 문자는 전부 '-'.
    실측: d:\\config-monitor -> d--config-monitor."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def _memory_cards(d, scope=None, project=None):
    """MEMORY.md 는 세션마다 적재(앞 200줄/25KB), 나머지 토픽은 필요할 때 Read.
    MEMORY.md 에는 제거를 붙이지 않는다 - 색인이라 지우면 나머지 토픽으로 가는 길이 끊긴다."""
    def _edit(rel, p, meta):
        if rel == "MEMORY" or "/" in rel:
            return None
        return {"kind": "memory", "name": rel, "memoryDir": d}
    return _md_dir_cards(d, "memory", scope, project,
                         load_of=lambda rel, p, meta: "eager" if rel == "MEMORY" else "lazy",
                         edit_of=_edit)


def _project_memory_dir(root):
    """인코딩으로 먼저 찾고, 없으면 projects/ 목록에서 대소문자 무시 역매칭으로 폴백."""
    base = os.path.join(HOME, ".claude", "projects")
    enc = _encode_project_dir(root)
    d = os.path.join(base, enc, "memory")
    if os.path.isdir(d):
        return d
    want = enc.lower()
    try:
        for name in os.listdir(base):
            if name.lower() == want:
                cand = os.path.join(base, name, "memory")
                if os.path.isdir(cand):
                    return cand
    except OSError:
        pass
    return None


def _mcp_json_cards(root, scope=None, project=None):
    """<root>/.mcp.json 의 mcpServers. MCP Project 스코프 - 커밋되어 팀 전체에 영향인데
    대시보드에 존재 자체가 없었다. 편집 op 가 없으므로 뷰 전용.
    env 는 값 없이 키 이름만(Desktop MCP 카드와 동일)."""
    cards = []
    mj = os.path.join(root, ".mcp.json")
    if os.path.exists(mj):
        data = safe_load(mj)
        if "__error__" in data:
            cards.append(card("(파싱 오류)", [("error", data["__error__"]), ("path", mj)],
                              scope=scope, project=project, source=mj))
        else:
            for name, cfg in ((data.get("mcpServers") or {}) if isinstance(data, dict) else {}).items():
                cfg = cfg or {}
                cards.append(card(name, [
                    ("command", cfg.get("command", "-")),
                    ("args", " ".join(cfg.get("args", []) or []) or "-"),
                    ("env", ", ".join((cfg.get("env") or {}).keys()) or "-"),
                ], badge="stdio" if cfg.get("command") else cfg.get("type", "?"), ok=True,
                   scope=scope, project=project, source=mj))
    return cards

def _agent_cards(ad, scope=None, project=None):
    cards = []
    if ad and os.path.isdir(ad):
        for rel, md, disp, top in _iter_agents(ad):
            meta = read_frontmatter(md) if os.path.exists(md) else {}
            # 제거 op 는 파일시스템 이름 기준 - frontmatter name 과 다를 수 있다.
            # 중첩 항목(top=None)은 제거 op 가 단일 세그먼트만 받으므로 뷰 전용(전역/프로젝트 동일).
            edit = {"kind": "agent", "name": top} if top else None
            if edit and scope == "project":
                edit["dir"] = ad   # 이 프로젝트의 agents 디렉토리를 제거 대상으로 명시
            cards.append(card(meta.get("name", rel), [
                ("desc", meta.get("description", "-")),
                ("tools", meta.get("tools", "-")),
                ("path", disp),
            ], badge="agent", edit=edit, scope=scope, project=project))
        if scope != "project":
            cards.append(card("＋ 새 에이전트", [("형식", "name 설명…")],
                              badge="add", edit={"kind": "agent-add"}))
    return cards

def _append_project_cards(sections, projects, global_chain=()):
    """추적 중인 프로젝트 .claude 디렉토리들의 permissions/hooks/skills/agents 를 스캔해
    해당 전역 섹션 뒤에 프로젝트 항목으로 append(전역 카드는 불변). title 개수도 재계산."""
    by_id = {sec["id"]: sec for sec in sections}
    def add_to(sid, cards):
        sec = by_id.get(sid)
        if sec is not None and cards:
            sec["cards"].extend(cards)
    for cdir in projects:
        if not cdir or not os.path.isdir(cdir):
            continue
        root = os.path.dirname(cdir.rstrip("/\\"))   # <root>/.claude -> <root> (칩 라벨 = 마지막 세그먼트)
        for cs in _dir_settings(cdir):
            add_to("perm", _perm_cards(cs, "project", root))
            add_to("hooks", _hook_cards(cs, "project", root))
        add_to("skills", _skill_cards(os.path.join(cdir, "skills"), "project", root))
        add_to("agents", _agent_cards(os.path.join(cdir, "agents"), "project", root))
        add_to("commands", _command_cards(os.path.join(cdir, "commands"), "project", root))
        add_to("mcp-project", _mcp_json_cards(root, "project", root))
        add_to("claude-md", _claude_md_cards(root, "project", root))
        add_to("rules", _rules_cards(os.path.join(cdir, "rules"), "project", root))
        add_to("output-styles", _output_style_cards(
            os.path.join(cdir, "output-styles"),
            # 프로젝트는 전역 settings 를 상속한다 - 전역 체인을 앞에 두고 프로젝트가 이긴다.
            # 프로젝트만 보면 전역에서 켠 스타일이 그 프로젝트에서 NEVER 로 보인다.
            _active_output_style(list(global_chain) + _dir_settings(cdir)),
            "project", root, settings=os.path.join(cdir, "settings.json")))
        pwd_ = os.path.join(cdir, "workflows")
        add_to("workflows", _glob_cards(pwd_, "*.js", "workflow", "project", root,
                                        edit_of=lambda rel, p, meta:
                                            _item_edit("workflow", rel, pwd_, "project")))
        add_to("worktreeinclude", _file_card(os.path.join(root, ".worktreeinclude"),
                                             "worktree", "project", root, load="lazy"))
        md = _project_memory_dir(root)
        if md:
            add_to("project-memory", _memory_cards(md, "project", root))
        for sub, badge in (("agent-memory", "agent-memory"),
                           ("agent-memory-local", "agent-memory-local")):
            add_to("agent-memory", _md_dir_cards(os.path.join(cdir, sub), badge,
                                                 "project", root))
    for sec in sections:
        if sec["id"] in SECTIONS:
            _recount(sec)


# --- 플러그인(~/.claude/plugins) --------------------------------------------
# 플러그인 항목은 세션에서 <ns>:<item> 으로 네임스페이스가 붙어 로컬 항목과 이름이 겹치지
# 않는다(실측: superpowers:brainstorming, Notion:create-page). 그래서 override/conflict
# 배지를 붙이지 않는다 - 붙이면 없는 충돌을 만들어낸다.
# 편집(제거) op 도 붙이지 않는다: 플러그인 항목을 끄는 단위는 항목이 아니라 플러그인이고,
# 그 토글은 Plugins 섹션 카드에 있다.

# 플러그인 항목이 합류할 기존 섹션 id.
PLUGIN_MERGE_IDS = ("skills", "agents", "commands", "hooks", "claude-json",
                    "rules", "output-styles", "workflows")
_STATE_BADGE = {"ok": "plugin", "disabled": "disabled", "stale": "stale", "missing": "missing"}


def norm_path(p):
    """경로 비교용 정규화(대소문자/구분자/./.. 흡수). lib_store.norm 과 같은 규칙."""
    return os.path.normcase(os.path.normpath(p))


def _plugin_scope(r, gset):
    """플러그인을 켠 파일이 전역 체인 밖이면 프로젝트 스코프다 -> ("project", <root>).
    <root>/.claude/settings.json -> <root> (_append_project_cards 와 같은 라벨 기준)."""
    src = r["enabled_from"]
    if src and norm_path(src) not in gset:
        return "project", os.path.dirname(os.path.dirname(src))
    return None, None


def _plugin_section_cards(plugins, settings_fallback, global_settings=()):
    """Plugins 섹션 - 플러그인 단위 카드. 토글이 여기 붙는다(토글 단위가 플러그인이므로).

    global_settings 는 전역 settings 체인이다. enabled_from 이 그 안에 없으면 프로젝트
    settings 가 정한 값이므로 카드를 project 스코프로 태깅한다 - 안 하면 스코프 칩이
    전역으로 분류해서 "어느 프로젝트가 이걸 껐는지"를 화면에서 못 찾는다."""
    gset = {norm_path(p) for p in (global_settings or []) if p}
    cards = []
    for r in plugins:
        counts = plugin_state.item_counts(r)
        kv = [("desc", r["desc"] or "-"),
              ("market", r["market"] or "-"),
              ("version", r["version"] or "-"),
              ("gives", " · ".join(f"{k} {v}" for k, v in counts.items()) or "-")]
        # 표시 접두(ns)는 plugin.json 에서, 토글 키(id)는 마켓 매니페스트에서 온다.
        # 실측으로 갈리는 경우가 있어(notion -> "Notion:") 다를 때만 따로 보여준다.
        if r["ns"] and r["ns"] != r["name"]:
            kv.append(("namespace", f'{r["ns"]}:'))
        kv.append(("id", r["id"]))
        if r["state"] == "stale":
            kv.append(("note", "enabledPlugins 에만 남은 키 - 설치 기록이 없습니다"))
        elif r["state"] == "missing":
            kv.append(("note", f'설치 경로가 없습니다: {r["root"] or "-"}'))
        else:
            kv.append(("path", r["root"]))
        # 설치 스코프는 토글 스코프와 다른 축이다(토글은 enabledPlugins 를 정한 파일,
        # 이쪽은 원장이 기록한 설치 위치). 제거/갱신이 향할 곳이라 카드에 보이게 둔다.
        if r["scope"] and r["scope"] != "user":
            kv.append(("installed", f'{r["scope"]}  {r["project_path"] or "-"}'))
        # 카드에는 파일명만, 전체 경로는 출처 그룹 헤더가 든다(_perm_cards 와 같은 규율).
        # 같은 프로젝트의 settings.json 과 settings.local.json 이 갈리는 유일한 자리다 -
        # 스코프 필은 전역/프로젝트 2치라 project 설치와 local 설치를 구분하지 못한다.
        src = r["enabled_from"] or settings_fallback
        kv.append(("source", os.path.basename(src) if src else "-"))
        # 토글 대상은 **그 값을 정한 파일**이다. 프로젝트에서 켠 것을 전역 파일에서 끄면
        # 안 먹으므로 카드가 자기 대상 경로를 들고 간다(_perm_cards 와 같은 규율).
        edit = None
        if r["state"] in ("ok", "disabled"):
            # scope/cwd 는 claude 위임(제거·갱신)이 쓴다. 안 넘기면 CLI 기본값 user 로 흘러가
            # project 스코프 설치를 영영 못 지운다 - claude 가 "project 스코프에 있다"며
            # 거절하고, 사용자는 대시보드에서 빠져나갈 길이 없다(실측 재현).
            edit = {"kind": "plugin", "id": r["id"], "on": r["enabled"], "settings": src,
                    "scope": r["scope"] or "user", "cwd": r["project_path"] or ""}
        scope, proj = _plugin_scope(r, gset)
        cards.append(card(r["name"], kv, badge=_STATE_BADGE.get(r["state"], r["state"]),
                          ok=(r["state"] == "ok"), edit=edit, plugin=r["id"],
                          scope=scope, project=proj, source=src))
    return cards


def _plugin_mcp_kv(cfg):
    """stdio 는 command/args, 원격은 type/url. 해당 없는 키를 '-' 로 채우지 않는다."""
    cfg = cfg or {}
    if cfg.get("command"):
        return [("command", cfg["command"]),
                ("args", " ".join(cfg.get("args") or []) or "-")]
    return [("type", cfg.get("type", "-")), ("url", cfg.get("url", "-"))]


def _plugin_item_cards(r, scope=None, project=None):
    """state == ok 인 플러그인 하나가 기존 섹션에 낼 카드들 -> {섹션 id: [card]}.

    scope/project 는 그 플러그인을 켠 파일에서 온다(_plugin_scope). 안 붙이면 프로젝트에서만
    켠 플러그인의 스킬 수십 개가 전역 항목으로 잡혀, 그 프로젝트 칩을 눌렀을 때 오히려 사라진다."""
    pid, ns, items = r["id"], r["ns"], r["items"]
    out = {sid: [] for sid in PLUGIN_MERGE_IDS}
    tag = {"plugin": pid, "scope": scope, "project": project}

    for it in items["skills"]:
        meta = read_frontmatter(it["path"])
        out["skills"].append(card(f'{ns}:{it["name"]}', [
            ("desc", meta.get("description", "-")), ("from", pid), ("path", it["path"]),
        ], badge="plugin", ok=True, **tag))

    for it in items["agents"]:
        meta = read_frontmatter(it["path"])
        # 에이전트는 frontmatter name 이 실제 호출 이름이다(_agent_cards 와 같은 기준).
        out["agents"].append(card(f'{ns}:{meta.get("name") or it["name"]}', [
            ("desc", meta.get("description", "-")), ("tools", meta.get("tools", "-")),
            ("from", pid), ("path", it["path"]),
        ], badge="plugin", ok=True, **tag))

    for it in items["commands"]:
        meta = read_frontmatter(it["path"])
        out["commands"].append(card(f'{ns}:{it["name"]}', [
            ("desc", meta.get("description", "-")), ("from", pid), ("path", it["path"]),
        ], badge="plugin", ok=True, **tag))

    # 아직 이런 플러그인은 실측되지 않았다. 나왔을 때 어느 섹션에도 안 잡히는 것을 막는다.
    for key in ("rules", "output-styles", "workflows"):
        for it in items.get(key, []):
            meta = read_frontmatter(it["path"]) if key != "workflows" else {}
            out[key].append(card(f'{ns}:{it["name"]}', [
                ("desc", meta.get("description", "-")), ("from", pid), ("path", it["path"]),
            ], badge="plugin", ok=True, **tag))

    hooks_src = os.path.join(r["root"], "hooks", "hooks.json")
    for h in items["hooks"]:
        out["hooks"].append(card(h["event"], [
            ("matchers", h["matchers"]),
            ("commands", " ; ".join(h["commands"]) or "-"),
            ("from", pid), ("path", hooks_src),
        ], badge="plugin", **tag))

    # 플러그인 MCP 는 .claude.json 에 기록되지 않고 Claude Code 가 세션에 직접 주입한다.
    # 그래도 "Code 에서 실제로 붙는 MCP 서버"라는 점에서 이 섹션이 가장 가깝다.
    for m in items["mcp"]:
        out["claude-json"].append(card(
            f'{ns}:{m["name"]}', _plugin_mcp_kv(m["cfg"]) + [("from", pid)],
            badge="plugin mcp", ok=True, **tag))
    return out


def _append_plugin_cards(sections, plugins, global_settings=()):
    """state == ok 인 플러그인의 항목을 해당 전역 섹션 뒤에 append. title 개수 재계산.

    disabled / stale / missing 은 합류시키지 않는다 - 지금 적용되고 있지 않기 때문이다.
    (설치됨 ≠ 적용됨. 실측: chrome-devtools-mcp 는 설치돼 있고 enabled=false 다.)"""
    gset = {norm_path(p) for p in (global_settings or []) if p}
    by_id = {sec["id"]: sec for sec in sections}
    touched = set()
    for r in plugins:
        if r["state"] != "ok":
            continue
        scope, proj = _plugin_scope(r, gset)
        for sid, cards in _plugin_item_cards(r, scope, proj).items():
            sec = by_id.get(sid)
            if sec is not None and cards:
                sec["cards"].extend(cards)
                touched.add(sid)
    for sid in touched:
        _recount(by_id[sid])


def parse(found, project_dirs=None, include_missing=False):
    # 주의: 아래 섹션2 에서 지역변수 projects(=.claude.json 의 projects 맵)를 쓰므로
    # 파라미터명은 project_dirs 로 구분(같은 이름이면 섀도잉으로 프로젝트 append 가 오작동).
    state = {"generated": datetime.now().isoformat(), "sources": found, "sections": []}
    add = state["sections"].append

    # 1) Desktop MCP servers (카드 단위 제거 + 섹션 add 카드)
    cards = []
    dc = found.get("desktop_config")
    if dc and os.path.exists(dc):
        dd = _as_dict(safe_load(dc))
        if "__error__" in dd:
            cards.append(_error_card(dc))
        servers = _as_dict(dd.get("mcpServers"))
        for name, cfg in servers.items():
            cfg = _as_dict(cfg)   # 항목이 null 이어도 카드 하나가 비는 선에서 끝나게
            cards.append(card(name, [
                ("command", cfg.get("command", "-")),
                ("args", " ".join(str(x) for x in _as_list(cfg.get("args"))) or "-"),
                ("env", ", ".join(_as_dict(cfg.get("env")).keys()) or "-"),
            ], badge="stdio" if cfg.get("command") else cfg.get("type", "?"), ok=True,
               edit={"kind": "mcp", "scope": "desktop", "name": name}))
        if "__error__" not in dd:
            cards.append(card("＋ 새 MCP 서버", [("형식", 'name {"command":"npx","args":[...]}')],
                              badge="add", edit={"kind": "mcp-add", "scope": "desktop"}))
    add(_section("mcp-desktop", cards, dc))

    # 2) Claude Code 전역 (.claude.json, 관심 키만)
    cards = []
    cj = found.get("claude_json")
    if cj and os.path.exists(cj):
        data = safe_load(cj)
        if "__error__" in data:
            cards.append(card("(파싱 오류)", [("error", data["__error__"])]))
        else:
            g_mcp = list((data.get("mcpServers") or {}).keys())
            projects = data.get("projects") or {}
            cards.append(card("전역 요약", [
                ("global MCP", ", ".join(g_mcp) or "-"),
                ("projects", len(projects)),
                ("account", "set" if data.get("oauthAccount") else "-"),
                ("dropped", "history(노이즈) 제외 · 관심 키만 선별 추출"),
            ], badge="claude.json", ok=True))
            # 전역 mcpServers 를 카드 단위로 노출(제거 가능) + add 카드
            for name, cfg in _as_dict(data.get("mcpServers")).items():
                cfg = _as_dict(cfg)
                cards.append(card(name, [
                    ("command", cfg.get("command", "-")),
                    ("args", " ".join(str(x) for x in _as_list(cfg.get("args"))) or "-"),
                ], badge="global mcp", ok=True,
                   edit={"kind": "mcp", "scope": "user", "name": name}))
            cards.append(card("＋ 새 전역 MCP 서버", [("형식", 'name {"command":"npx","args":[...]}')],
                              badge="add", edit={"kind": "mcp-add", "scope": "user"}))
            roots = _excluded_roots()
            shown = [(path, pj) for path, pj in projects.items() if _project_shown(path, include_missing, roots)]
            for path, pj in shown[:20]:
                pj = pj or {}
                cards.append(card(os.path.basename(path.rstrip("/\\")) or path, [
                    ("path", path),
                    ("allowedTools", len(pj.get("allowedTools", []) or [])),
                    ("mcpServers", ", ".join((pj.get("mcpServers") or {}).keys()) or "-"),
                    ("trust", pj.get("hasTrustDialogAccepted", "-")),
                ], badge="project"))
    add(_section("claude-json", cards, cj))

    # 2-1) MCP Servers (project): <root>/.mcp.json. 프로젝트를 지정했을 때만 의미가 있다
    #      (전역 .mcp.json 개념은 없음 - 전역 MCP 는 .claude.json). 카드는 _append_project_cards 가 채운다.
    if project_dirs:
        add(_section("mcp-project", [], None))

    # 3) Permissions + 4) Hooks (settings.json + settings.local.json 을 각각 출처로)
    chain = _settings_chain(found.get("code_settings"))
    perm_cards, hook_cards = [], []
    for f in chain:
        perm_cards += _perm_cards(f)
        hook_cards += _hook_cards(f)
    src = _source_label(chain)
    add(_section("perm", perm_cards, src))
    add(_section("hooks", hook_cards, src))

    # 지시 · 규칙. 전역 CLAUDE.md 는 ~/.claude/CLAUDE.md 하나뿐이다(아티팩트 기준).
    ucm = found.get("user_claude_md")
    add(_section("claude-md", _file_card(ucm, "CLAUDE.md", load="eager"), ucm))
    rd = found.get("rules_dir")
    add(_section("rules", _rules_cards(rd), rd))
    osd = found.get("output_styles_dir")
    add(_section("output-styles", _output_style_cards(osd, _active_output_style(chain)), osd))

    wd = found.get("workflows_dir")
    wf = _glob_cards(wd, "*.js", "workflow",
                     edit_of=lambda rel, p, meta: _item_edit("workflow", rel, wd, None))
    wf.append(_add_card("workflow", "＋ 새 워크플로"))
    add(_section("workflows", wf, wd))
    td = found.get("themes_dir")
    add(_section("themes", _glob_cards(td, "*.json", "theme"), td))
    amd = found.get("agent_memory_dir")
    add(_section("agent-memory", _md_dir_cards(amd, "agent-memory"), amd))
    # 프로젝트별 메모리와 .worktreeinclude 는 프로젝트를 지정했을 때만 채워진다.
    add(_section("project-memory", [], os.path.join(HOME, ".claude", "projects")))
    if project_dirs:
        add(_section("worktreeinclude", [], None))

    # 5) Code Skills
    sd = found.get("skills_dir")
    skill_cards = _skill_cards(sd)
    add(_section("skills", skill_cards, sd))

    # 6) Agents
    ad = found.get("agents_dir")
    agent_cards = _agent_cards(ad)
    add(_section("agents", agent_cards, ad))

    # 6-1) Commands (슬래시 커맨드). 라이브러리는 commands 설치를 지원하는데 조회가 없었다.
    cmd_dir = found.get("commands_dir")
    cmd_cards = _command_cards(cmd_dir)
    add(_section("commands", cmd_cards, cmd_dir))

    # 6-2) Plugins (~/.claude/plugins). 여기가 사각지대였다 - 플러그인이 주는
    #      스킬/에이전트/커맨드/hooks/MCP 는 ~/.claude/skills 가 아니라 플러그인 캐시에 있어서
    #      위 섹션들에 하나도 안 잡혔다.
    pdir = found.get("plugins_dir") or plugin_state.DEFAULT_PLUGINS_DIR
    # enabledPlugins 우선순위 오름차순: 전역 먼저, 프로젝트 나중(프로젝트가 이긴다).
    psettings = list(chain)
    for cdir in (project_dirs or []):
        if cdir and os.path.isdir(cdir):
            psettings += _dir_settings(cdir)
    plugins = plugin_state.read_plugins(pdir, psettings)
    pcards = _plugin_section_cards(plugins, found.get("code_settings"), chain)
    add(_section("plugins", pcards, pdir))

    # 7) Scheduled tasks
    cards = []
    schd = found.get("scheduled_dir")
    if schd and os.path.isdir(schd):
        for name in sorted(os.listdir(schd)):
            full = os.path.join(schd, name)
            skill_md = os.path.join(full, "SKILL.md")
            if os.path.isdir(full) and os.path.exists(skill_md):
                meta = read_frontmatter(skill_md)
                cards.append(card(name, [
                    ("desc", meta.get("description", "-")),
                    ("schedule", meta.get("cron") or meta.get("schedule") or meta.get("fireAt", "-")),
                    ("path", full),
                ], badge="scheduled", ok=True))
    add(_section("scheduled", cards, schd))

    # 8) Desktop Skills (서버관리: 모든 manifest 머지 + creatorType 구분)
    cards = []
    mans = found.get("desktop_skill_manifest_glob")
    if isinstance(mans, str):
        mans = [mans]
    merged = {}
    for mp in (mans or []):
        if not (mp and os.path.exists(mp)):
            continue
        data = safe_load(mp)
        for s in (data.get("skills") or []) if isinstance(data, dict) else []:
            if isinstance(s, dict):
                sid = s.get("skillId") or s.get("name")
                prev = merged.get(sid)
                if prev is None or str(s.get("updatedAt") or "") >= str(prev.get("updatedAt") or ""):
                    merged[sid] = s
    items = sorted(merged.values(), key=lambda s: (s.get("creatorType") != "user", s.get("name", "")))
    n_user = sum(1 for s in items if s.get("creatorType") == "user")
    for s in items:
        ct = s.get("creatorType", "?")
        cards.append(card(s.get("name", "?"), [
            ("desc", s.get("description", "-")),
            ("creator", ct),
            ("enabled", s.get("enabled", "-")),
            ("updated", s.get("updatedAt") or "-"),
        ], badge=("user" if ct == "user" else "anthropic"), ok=(ct == "user"),
           builtin=(ct != "user")))
    src = (f"{mans[0]}  (+{len(mans)-1} more)" if mans and len(mans) > 1 else (mans[0] if mans else None))
    d = _section("desktop-skills", cards, src)
    d["note"] = f"user {n_user} / anthropic {len(items) - n_user}"
    add(d)

    # 플러그인 항목을 먼저 합류시킨 뒤 프로젝트 항목을 얹는다. 양쪽 다 자기 접두사의
    # title 개수를 재계산하므로 순서가 개수를 어긋나게 만들지 않는다.
    _append_plugin_cards(state["sections"], plugins, chain)
    if project_dirs:
        _append_project_cards(state["sections"], project_dirs, chain)
    return state

# --- 대화용 축약(필터 · compact · summary) -----------------------------------
# 전체 dump 는 이 PC 에서 200KB 를 넘는다. 대시보드는 그걸 한 번 받아 그리지만, 대화에서
# Claude 가 "hooks 뭐 있어" 에 답하려고 전부를 받으면 컨텍스트가 그 질문 하나로 찬다.
# 필터는 섹션·스코프·이름 세 축이고, compact 는 카드에서 UI 전용 폼과 긴 kv 를 뺀다.

def _card_text(c):
    parts = [c.get("name", ""), c.get("badge") or "", c.get("project") or "", c.get("plugin") or ""]
    parts += [str(v) for _, v in c.get("kv", [])]
    return " ".join(str(p) for p in parts).lower()


def filter_state(state, sections=None, scope=None, query=None):
    """sections=섹션 id 목록, scope=global|project, query=이름·값 부분일치(대소문자 무시).
    필터가 하나라도 걸리면 '＋ 새 …' 폼 카드는 뺀다 - 항목을 묻는 질문에 입력 폼은 답이 아니다."""
    q = (query or "").strip().lower()
    out = dict(state)
    out["sections"] = []
    for sec in state["sections"]:
        if sections and sec["id"] not in sections:
            continue
        cards = sec["cards"]
        if scope or q:
            cards = [c for c in cards if not _is_add_card(c)]
        if scope == "global":
            cards = [c for c in cards if c.get("scope") != "project"]
        elif scope == "project":
            cards = [c for c in cards if c.get("scope") == "project"]
        if q:
            cards = [c for c in cards if q in _card_text(c)]
        sec = dict(sec, cards=cards)
        if sec["id"] in SECTIONS:
            _recount(sec)
        out["sections"].append(sec)
    return out


_COMPACT_KEEP = ("name", "badge", "scope", "project", "source", "plugin", "builtin", "load", "edit")


def compact_state(state):
    """카드를 식별·조작에 필요한 필드만으로 줄인다. edit 는 남긴다 - Claude 가 편집 도구에
    넘길 settings/dir 경로가 거기 있다. 서술은 첫 설명 키 하나를 200자로 자른다."""
    out = dict(state)
    out["sections"] = []
    for sec in state["sections"]:
        cards = []
        for c in sec["cards"]:
            if _is_add_card(c):
                continue
            n = {k: c[k] for k in _COMPACT_KEEP if k in c and c[k] not in (None, False, "")}
            for k, v in c.get("kv", []):
                if str(k).lower() in DESC_KEYS and v:
                    n["desc"] = _short(v, 200)
                    break
            cards.append(n)
        sec = dict(sec, cards=cards)
        if sec["id"] in SECTIONS:
            _recount(sec)
        out["sections"].append(sec)
    return out


# 같은 이름이 전역과 프로젝트에 함께 있을 때 실제로 적용되는 쪽. UI 의 배지 규칙과 같다:
# 에이전트·커맨드는 프로젝트가, 스킬은 전역(개인)이 이긴다.
_COLLISION_WINNER = {"skills": "global", "agents": "project", "commands": "project"}


_TRAIL_SEPS = "/\\"


def _summary_name(sec_id, c):
    """perm 카드 이름(allow/deny/ask)은 파일마다 반복되므로 출처를 붙여야 구별된다."""
    if sec_id != "perm" or not c.get("source"):
        return c["name"]
    src = os.path.basename(c["source"])
    if c.get("project"):
        proj = os.path.basename(str(c["project"]).rstrip(_TRAIL_SEPS))
        src = f"{proj}/{src}"
    return f"{c['name']} ({src})"


def summarize(state):
    """섹션별 개수·적재등급·이름 목록과 이름 충돌·플러그인 상태만 담은 개요.
    상세는 filter_state 로 내려간다(2단 구조)."""
    secs = []
    collisions = []
    plugin_states = {}
    for sec in state["sections"]:
        cards = [c for c in sec["cards"] if not _is_add_card(c)]
        reg = SECTIONS.get(sec["id"])
        glob_names, proj_names = {}, {}
        n_plugin = n_builtin = 0
        for c in cards:
            if c.get("plugin"):
                n_plugin += 1
            if c.get("builtin"):
                n_builtin += 1
            if c.get("scope") == "project":
                proj_names.setdefault(c["name"], []).append(c.get("project") or "")
            else:
                glob_names.setdefault(c["name"], True)
        entry = {
            "id": sec["id"],
            "title": reg.title if reg else sec["title"].split(" · ")[0],
            "group": sec.get("group"),
            "load": sec.get("load"),
            "count": len(cards),
            "global": sum(1 for c in cards if c.get("scope") != "project"),
            "project": sum(1 for c in cards if c.get("scope") == "project"),
            "names": [_summary_name(sec["id"], c) for c in cards],
        }
        if n_plugin:
            entry["plugin"] = n_plugin
        if n_builtin:
            entry["builtin"] = n_builtin
        if sec.get("note"):
            entry["note"] = sec["note"]
        secs.append(entry)
        if sec["id"] in _COLLISION_WINNER:
            for name, projs in proj_names.items():
                if name in glob_names:
                    collisions.append({"section": sec["id"], "name": name, "projects": projs,
                                       "wins": _COLLISION_WINNER[sec["id"]]})
        if sec["id"] == "plugins":
            for c in cards:
                b = c.get("badge") or "?"
                plugin_states[b] = plugin_states.get(b, 0) + 1
    return {"generated": state["generated"], "sources": state.get("sources", {}),
            "sections": secs, "collisions": collisions, "plugins": plugin_states}


def _excluded_roots():
    """지워진 경로는 realpath 가 8.3 표기를 긴 이름으로 못 풀므로 원래 표기와 realpath 를 둘 다 둔다."""
    bases = [tempfile.gettempdir()]
    if os.environ.get("APPDATA"):
        bases.append(os.path.join(os.environ["APPDATA"], "Claude", "scratch-workspaces"))
    return {os.path.normcase(f(b)).rstrip("\\/") + os.sep
            for b in bases for f in (os.path.normpath, os.path.realpath)}


def _is_excluded_project(path, roots):
    cands = {os.path.normcase(f(path)) + os.sep for f in (os.path.normpath, os.path.realpath)}
    return any(c.startswith(r) for c in cands for r in roots)


def _project_shown(path, include_missing, roots):
    if _is_excluded_project(path, roots):
        return False
    return include_missing or os.path.isdir(os.path.join(path, ".claude"))


def list_projects(found, include_missing=False):
    """~/.claude.json 의 projects 맵을 {path, name, claude_dir, has_claude} 리스트로. UI 의 원클릭 track 후보.
    has_claude=False 행(.claude 없음 또는 경로 없음)은 include_missing 일 때만 낸다."""
    cj = found.get("claude_json")
    out = []
    if not (cj and os.path.exists(cj)):
        return out
    data = safe_load(cj)
    if not isinstance(data, dict) or "__error__" in data:
        return out
    # 세션 CWD 표기가 그대로 키가 되어 같은 폴더가 대소문자·구분자·8.3 단축명만 다른 키로 남는다. 먼저 나온 표기만 낸다.
    seen = set()
    roots = _excluded_roots()
    for path in (data.get("projects") or {}):
        key = os.path.normcase(os.path.realpath(path))
        if key in seen:
            continue
        seen.add(key)
        if not _project_shown(path, include_missing, roots):
            continue
        cdir = os.path.join(path, ".claude")
        out.append({
            "path": path,
            "name": os.path.basename(path.rstrip("/\\")) or path,
            "claude_dir": cdir,
            "has_claude": os.path.isdir(cdir),
        })
    return out

def main():
    ap = argparse.ArgumentParser(prog="claude_config", description="Claude 설정 introspection")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("discover", "dump", "summary", "projects"):
        sp = sub.add_parser(name)
        sp.add_argument("--paths", nargs="*", help="key=path 로 후보 직접 지정")
        if name in ("dump", "summary", "projects"):
            sp.add_argument("--include-missing", action="store_true",
                            help=".claude 가 없는 프로젝트 경로도 낸다(임시 폴더·Desktop 작업 공간은 항상 제외)")
        if name in ("dump", "summary"):
            sp.add_argument("--projects", nargs="*", default=None,
                            help="프로젝트 .claude 디렉토리들 - 각각의 permissions/hooks/skills/agents 를 프로젝트 항목으로 추가")
        if name == "dump":
            sp.add_argument("--sections", nargs="*", default=None, help="이 섹션 id 들만")
            sp.add_argument("--scope", choices=("global", "project"), default=None)
            sp.add_argument("--query", default=None, help="이름·값 부분일치(대소문자 무시)")
            sp.add_argument("--compact", action="store_true", help="카드를 식별 필드+짧은 설명으로 축약")
    args = ap.parse_args()
    found = discover(getattr(args, "paths", None))
    projects = getattr(args, "projects", None)

    if args.cmd == "discover":
        print(json.dumps(found, ensure_ascii=False, indent=2))
    elif args.cmd == "projects":
        # MCP structuredContent 는 객체여야 함(배열 금지) -> {projects:[...]} 로 감쌈.
        print(json.dumps({"projects": list_projects(found, args.include_missing)}, ensure_ascii=False, indent=2))
    elif args.cmd == "summary":
        print(json.dumps(summarize(parse(found, projects, args.include_missing)), ensure_ascii=False, indent=2))
    elif args.cmd == "dump":
        state = parse(found, projects, args.include_missing)
        if args.sections or args.scope or args.query:
            state = filter_state(state, args.sections, args.scope, args.query)
        if args.compact:
            state = compact_state(state)
        print(json.dumps(state, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
