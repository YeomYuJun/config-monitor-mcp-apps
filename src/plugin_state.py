#!/usr/bin/env python3
r"""plugin_state.py - Claude Code 플러그인 레지스트리 조회(읽기 전용).

대시보드가 플러그인에 대해 장님이었다: claude_config 는 ~/.claude/skills 만 보는데
플러그인이 주는 스킬/에이전트/커맨드/hooks/MCP 는 ~/.claude/plugins/cache/ 에 있다.
"지금 실제로 적용된 게 뭐냐"에 답하려면 이쪽도 읽어야 한다.

순수 리더다: 네트워크·git·subprocess 를 타지 않는다(lib_store.py / plugin_units.py 와 같은 규율).
`claude plugin list --json` 을 부르지 않는 이유 - scan 경로에 프로세스 기동을 들이지 않고,
claude 가 PATH 에 없어도 동작해야 하며, 필요한 hooks/MCP 리더가 plugin_units 에 이미 있다.

**id 와 ns 는 다르다. 서로에서 유도하지 말 것.** 실측(notion):
    마켓 매니페스트 엔트리 name : "notion"                          <- 소문자
    plugin.json           name : "Notion"                          <- 대문자
    enabledPlugins 키           : "notion@claude-plugins-official"  <- 매니페스트 쪽
    세션 표시                    : "Notion:create-page"             <- plugin.json 쪽
id 는 토글 키(enabledPlugins / installed_plugins.json 이 쓰는 키)이고 ns 는 표시
네임스페이스다. 하나로 합치면 notion 에서 토글이 조용히 no-op 한다.

claude_config 를 import 하지 않는다(역방향 의존이라 순환이 된다). 프론트매터 해석은
호출부(claude_config)가 자기 read_frontmatter 로 하고, 여기서는 항목의 이름과 경로만 준다.
"""
from __future__ import annotations
import json, os

import plugin_units   # 순수 모듈(네트워크/git 없음) - hooks.json / .mcp.json 리더 재사용

HOME = os.path.expanduser("~")
DEFAULT_PLUGINS_DIR = os.path.join(HOME, ".claude", "plugins")
INSTALLED_REL = "installed_plugins.json"
MARKETS_REL = "known_marketplaces.json"
PLUGIN_JSON_REL = os.path.join(".claude-plugin", "plugin.json")

# 컴포넌트 디렉토리. Claude Code 가 읽는 이름 그대로.
SKILLS_DIR, AGENTS_DIR, COMMANDS_DIR = "skills", "agents", "commands"
# 플러그인이 이 표면들을 내놓는 사례는 아직 실측되지 않았다. 나올 때 어느 섹션에도
# 안 잡히는 상황을 막으려고 미리 걷는다 - 없으면 빈 리스트라 비용이 없다.
RULES_DIR, STYLES_DIR, WORKFLOWS_DIR = "rules", "output-styles", "workflows"


def _load(path):
    """읽기 실패를 예외로 만들지 않는다 - scan 경로는 파일 하나가 깨져도 계속 돌아야 한다."""
    try:
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


# ── 레지스트리 3종 ──────────────────────────────────────────────────────────

def read_installed(pdir: str) -> dict:
    """installed_plugins.json -> {id: {scope, root, version, installed_at, sha}}.

    형식은 {"version": 2, "plugins": {id: [ {...}, ... ]}} 로 값이 **배열**이다
    (같은 플러그인을 user/project 로 각각 설치할 수 있다). 실측은 전부 1개짜리라
    첫 항목을 대표로 쓰고, 2개 이상이면 scopes 에 전부 남겨 UI 가 표시할 수 있게 한다."""
    raw = _load(os.path.join(pdir, INSTALLED_REL)).get("plugins")
    out = {}
    if not isinstance(raw, dict):
        return out
    for pid, entries in raw.items():
        if not isinstance(pid, str) or not isinstance(entries, list) or not entries:
            continue
        e = entries[0] if isinstance(entries[0], dict) else {}
        out[pid] = {
            "scope": e.get("scope") or "user",
            # project/local 스코프 설치는 **cwd 로** 프로젝트를 정한다(claude 에 경로 인자가
            # 없다). 원장이 그 경로를 projectPath 로 들고 있으므로 그대로 꺼내 둔다 - 이게
            # 없으면 제거/갱신이 어느 프로젝트를 향해야 하는지 알 수 없어 user 로 흘러가고,
            # claude 는 "project 스코프에 있다"며 정확히 거절한다(실측).
            "project_path": e.get("projectPath") or "",
            "root": e.get("installPath") or "",
            "version": e.get("version") or "",
            "installed_at": e.get("installedAt") or "",
            "sha": e.get("gitCommitSha") or "",
            "scopes": [x.get("scope") for x in entries if isinstance(x, dict)],
        }
    return out


def read_markets(pdir: str) -> dict:
    """known_marketplaces.json -> {name: {kind, repo, url, path, location, updated}}.

    kind 는 Claude Code 의 source 종류다(실측: url · github · git · npm · file · directory ·
    skills-dir · settings · seeded · unsupported). import 제안(§마켓 import)이 URL 을
    필요로 하므로 github 은 여기서 URL 로 펴 주고, 나머지는 있는 그대로 넘긴다 -
    URL 이 없는 이유가 종류마다 다르므로(로컬 경로 / npm 패키지 / settings 선언) 호출부가
    kind 와 path 를 보고 사유를 말할 수 있어야 한다."""
    out = {}
    for name, rec in (_load(os.path.join(pdir, MARKETS_REL)) or {}).items():
        if not isinstance(name, str) or not isinstance(rec, dict):
            continue
        src = rec.get("source") if isinstance(rec.get("source"), dict) else {}
        kind = src.get("source") or ""
        repo = src.get("repo") or ""
        url = src.get("url") or (f"https://github.com/{repo}.git" if kind == "github" and repo else "")
        out[name] = {
            "kind": kind,
            "repo": repo,
            "url": url,
            "path": src.get("path") or "",
            "location": rec.get("installLocation") or "",
            "updated": rec.get("lastUpdated") or "",
        }
    return out


def read_enabled(settings_files) -> dict:
    """settings.json 들의 enabledPlugins 를 병합 -> {id: {"on": bool, "from": path}}.

    settings_files 는 **우선순위 오름차순**으로 받는다(전역 먼저, 프로젝트 나중).
    뒤가 이기고, 이긴 파일 경로를 from 에 남긴다 - 토글이 그 파일을 대상으로 삼아야
    프로젝트에서 켠 것을 전역 카드에서 껐다가 안 먹는 상황이 안 생긴다."""
    out = {}
    for path in (settings_files or []):
        if not path or not os.path.exists(path):
            continue
        for pid, val in (_load(path).get("enabledPlugins") or {}).items():
            if isinstance(pid, str) and isinstance(val, bool):
                out[pid] = {"on": val, "from": path}
    return out


# ── 플러그인 루트 안의 컴포넌트 ──────────────────────────────────────────────

def _walk_md(root):
    """root 아래 *.md 를 재귀 수집 -> [(rel, path)]. rel 은 구분자 '/', 확장자 제거.

    dot 디렉토리는 모든 깊이에서 제외한다. superpowers 는 `agents/` 가 아니라
    `.agents/` 를 담고 있고 Claude Code 가 그걸 안 읽는다 - 읽으면 세션에 존재하지
    않는 에이전트 9개가 대시보드에 유령으로 뜬다(claude_config._iter_md 와 같은 규율)."""
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

    if root and os.path.isdir(root):
        walk(root, "")
    return items


def _js_items(d):
    """workflows 는 *.js 라 _walk_md 를 못 쓴다. 한 단계만 본다(Claude 가 읽는 단위와 동일)."""
    out = []
    try:
        for name in sorted(os.listdir(d)):
            if name.endswith(".js") and os.path.isfile(os.path.join(d, name)):
                out.append((name[:-3], os.path.join(d, name)))
    except OSError:
        return []
    return [{"name": n, "path": p} for n, p in out]


def _skills(root):
    """<root>/skills/<name>/SKILL.md. 한 단계만 본다(claude_config._skill_cards 와 동일)."""
    d = os.path.join(root, SKILLS_DIR)
    out = []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return out
    for name in names:
        if name.startswith("."):
            continue
        md = os.path.join(d, name, "SKILL.md")
        if os.path.exists(md):
            out.append({"name": name, "path": md})
    return out


def scan_items(root: str) -> dict:
    """플러그인 루트가 제공하는 컴포넌트. 프론트매터는 읽지 않는다(호출부 담당).

    hooks / mcp 는 plugin_units 의 리더를 그대로 쓴다 - 정규식으로 command 를 뽑으면
    이스케이프된 \" 에서 잘려 0건 오답이 난다는 게 거기 이미 적혀 있다."""
    if not (root and os.path.isdir(root)):
        return {"skills": [], "agents": [], "commands": [], "hooks": [], "mcp": []}

    hooks_cfg = None
    mcp_cfg = None
    try:
        hooks_cfg = plugin_units.load_hooks_json(root)
    except (OSError, ValueError):
        pass
    try:
        mcp_cfg = plugin_units.load_mcp_json(root)
    except (OSError, ValueError):
        pass

    hooks = []
    for event, entries in ((hooks_cfg or {}).get("hooks") or {}).items():
        cmds = [h.get("command", "") for ent in (entries or []) if isinstance(ent, dict)
                for h in (ent.get("hooks") or []) if isinstance(h, dict)]
        hooks.append({"event": event, "matchers": len(entries or []), "commands": cmds})

    mcp = [{"name": n, "cfg": c or {}}
           for n, c in ((mcp_cfg or {}).get("mcpServers") or {}).items()]

    return {
        "skills": _skills(root),
        "agents": [{"name": r, "path": p} for r, p in _walk_md(os.path.join(root, AGENTS_DIR))],
        "commands": [{"name": r, "path": p} for r, p in _walk_md(os.path.join(root, COMMANDS_DIR))],
        "rules": [{"name": r, "path": p} for r, p in _walk_md(os.path.join(root, RULES_DIR))],
        "output-styles": [{"name": r, "path": p} for r, p in _walk_md(os.path.join(root, STYLES_DIR))],
        "workflows": _js_items(os.path.join(root, WORKFLOWS_DIR)),
        "hooks": sorted(hooks, key=lambda h: h["event"]),
        "mcp": sorted(mcp, key=lambda m: m["name"]),
    }


# ── 레코드 조립 ─────────────────────────────────────────────────────────────

def split_id(pid: str):
    """'notion@claude-plugins-official' -> ('notion', 'claude-plugins-official').

    마지막 '@' 로 자른다. 마켓 이름에 '@' 가 들어가는 쪽이 플러그인 이름보다 흔하다."""
    if "@" in pid:
        name, market = pid.rsplit("@", 1)
        return name, market
    return pid, ""


def read_plugins(pdir=None, settings_files=None) -> list:
    """설치 원장 + enabledPlugins 를 합쳐 플러그인 레코드 리스트를 만든다.

    **항목 소스는 설치 원장이고 enabledPlugins 는 토글 값일 뿐이다.** 실측:
    enabledPlugins 에 `vibe-kit@inline: false` 가 있는데 원장에는 없다. 그런 키를 버리면
    "왜 목록에 없지"가 되고, 플러그인으로 취급하면 없는 경로를 읽는다 - stale 로 드러낸다.

    4상태:
      ok       원장 O, 경로 O, enabled       -> 기존 섹션에도 합류시킬 수 있음
      disabled 원장 O, 경로 O, enabled=false -> 적용 안 됨. 합류시키지 않는다
      missing  원장 O, 경로 X                -> 수동 삭제 / GC 로 캐시가 사라짐
      stale    원장 X, enabledPlugins 에만   -> 남은 찌꺼기
    """
    pdir = pdir or DEFAULT_PLUGINS_DIR
    installed = read_installed(pdir)
    markets = read_markets(pdir)
    enabled = read_enabled(settings_files)

    recs = []
    for pid, inst in sorted(installed.items()):
        name, market = split_id(pid)
        root = inst["root"]
        exists = bool(root) and os.path.isdir(root)
        meta = _load(os.path.join(root, PLUGIN_JSON_REL)) if exists else {}
        # enabledPlugins 에 키가 없는 경우: 설치되어 있으면 적용 중으로 본다. 실측 5/5 가
        # 명시 엔트리를 갖고 있어 부재는 관측되지 않았고, "설치했는데 대시보드에 안 뜸"
        # 쪽이 반대 오탐보다 나쁘다. explicit 로 추정임을 UI 가 구분할 수 있게 남긴다.
        e = enabled.get(pid)
        on = e["on"] if e else True
        state = "ok" if exists and on else ("disabled" if exists else "missing")
        recs.append({
            "id": pid,                              # 토글 키 - 절대 ns 에서 만들지 말 것
            "name": name,
            "ns": (meta.get("name") or name),       # 표시 네임스페이스 - plugin.json 쪽
            "market": market,
            "market_src": markets.get(market, {}),
            "version": meta.get("version") or inst["version"],
            "desc": meta.get("description") or "",
            "homepage": meta.get("homepage") or "",
            "scope": inst["scope"],
            "project_path": inst["project_path"],
            "root": root,
            "enabled": on,
            "enabled_explicit": bool(e),
            "enabled_from": e["from"] if e else None,
            "state": state,
            "items": scan_items(root) if exists else
                     {"skills": [], "agents": [], "commands": [], "hooks": [], "mcp": []},
        })

    for pid, e in sorted(enabled.items()):
        if pid in installed:
            continue
        name, market = split_id(pid)
        recs.append({
            "id": pid, "name": name, "ns": name, "market": market,
            "market_src": markets.get(market, {}), "version": "", "desc": "", "homepage": "",
            "scope": "", "project_path": "", "root": "", "enabled": e["on"], "enabled_explicit": True,
            "enabled_from": e["from"], "state": "stale",
            "items": {"skills": [], "agents": [], "commands": [], "hooks": [], "mcp": []},
        })
    return recs


def item_counts(rec: dict) -> dict:
    """카드 요약용 - 0 인 종류는 뺀다."""
    return {k: len(v) for k, v in (rec.get("items") or {}).items() if v}


def import_candidates(pdir=None, known_urls=None) -> list:
    """Claude Code 에 등록됐는데 config-monitor 스토어에는 없는 마켓 -> 가져오기 후보.

    URL 비교는 정규화해서 한다(.git 접미/대소문자/트레일링 슬래시). 같은 레포를 두 번
    등록하는 게 이 기능의 유일한 실패 모드다."""
    known = {norm_url(u) for u in (known_urls or []) if u}
    out = []
    for name, m in sorted(read_markets(pdir or DEFAULT_PLUGINS_DIR).items()):
        if not m["url"] or norm_url(m["url"]) in known:
            continue
        out.append({"name": name, "url": m["url"], "kind": m["kind"],
                    "repo": m["repo"], "updated": m["updated"]})
    return out


def norm_url(u: str) -> str:
    """URL 비교용 정규화 - .git 접미/트레일링 슬래시/대소문자를 흡수한다.
    같은 레포를 두 번 등록하는 게 import 의 유일한 실패 모드다."""
    s = (u or "").strip().rstrip("/").casefold()
    return s[:-4] if s.endswith(".git") else s
