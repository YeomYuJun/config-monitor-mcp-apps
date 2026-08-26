#!/usr/bin/env python3
r"""
library.py - 라이브러리(.claude 구조 디렉토리) <-> 라이브 설정 토글 엔진.

원리 (/plugin 과 동일한 소스<->설치상태 모델):
  - 라이브러리 = 설치 가능한 항목의 소스(read-only 취급).
  - 라이브 설정(~/.claude) = 설치 상태.
  - scan 이 항목별 3상태를 판정: not_installed / installed(내용 동일) / modified(내용 다름).
    상태 판정은 이름이 아니라 **내용 해시** 비교 — 라이브러리가 업데이트되면 modified 가
    "동기화 가능" 신호가 된다.

카테고리: agents(파일), skills(디렉토리), commands(파일).
hooks 는 settings.json 조각 + 경로 재작성이 필요한 복합 유닛이라 미지원.

안전 규율 (config_edit 와 동일):
  - install 덮어쓰기 전: cas 스냅샷 + .bak(파일) / .trash 이동(디렉토리)
  - uninstall: 삭제 대신 .trash 이동(복구 가능)

라이브러리 등록은 store/config.json 의 "libraries": [...] 에 영속화.
출력은 항상 JSON (MCP 서버가 그대로 파싱).
"""
from __future__ import annotations
import argparse, datetime, hashlib, json, os, re, shutil, stat, sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from config_edit import (backup, snapshot_before, trash, out, load, save_atomic,
                         op_mcp_add, op_mcp_remove, _safe_settings_path)  # 동일 안전 규율 재사용
import lib_store
import marketplace
import remote_fetch
import plugin_units
import plugin_state   # Claude Code 플러그인 레지스트리 읽기(마켓 발견용). 순수 리더
import paths
from lib_store import norm as _norm   # 정규화 규칙을 한 곳에서만 정의

HOME = os.path.expanduser("~")
DEFAULT_TARGET = os.path.join(HOME, ".claude")
DEFAULT_STORE = os.environ.get("CLAUDE_SNAPSHOT_STORE") or (
    "D:\\.claude-snapshot" if os.name == "nt" else os.path.join(HOME, ".claude-snapshot"))
DEFAULT_CLAUDE_JSON = os.path.join(HOME, ".claude.json")
DEFAULT_DESKTOP_CONFIG = paths.desktop_config_path()

# 카테고리 -> (라이브러리 하위경로, 항목 종류)
CATEGORIES = {
    "agents":   ("agents", "file"),      # *.md
    "skills":   ("skills", "dir"),       # <name>/ (SKILL.md 포함)
    "commands": ("commands", "file"),    # *.md
}

# 라이브러리 바깥을 가리키는 상대참조 탐지 휴리스틱: CLAUDE_PROJECT_DIR 또는 형제 디렉토리
# (conventions/playbooks/rules/modes/analysis) 참조가 있으면 다른 환경에 설치 시 깨질 수 있어 배지로 표시.
KIT_REF_RE = re.compile(r"CLAUDE_PROJECT_DIR|(?:conventions|playbooks|rules|modes|analysis)/", re.A)


def _hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _walk_strict(path):
    """os.walk 인데 나열 실패를 삼키지 않는다. 기본 onerror=None 은 OSError 를 조용히 버리고
    빈 결과만 낸다 - Windows MAX_PATH(약 260자) 초과 등으로 못 읽은 하위경로가 '항목 없음'
    으로 둔갑해(fix round 2 finding) 진짜 빈 디렉토리와 구분이 안 됐다. 여기서 다시 올려
    보내면 호출부(_hash_dir/_has_kit_ref 는 기존 except OSError 로, _iter_items 는
    cmd_scan 의 카테고리별 try/except 로)가 실패와 '진짜 없음'을 구분할 수 있다."""
    def _raise(err):
        raise err
    return os.walk(path, onerror=_raise)


def _hash_dir(path):
    """디렉토리 해시 = 정렬된 (상대경로, 파일해시) 목록의 해시. 파일 추가/삭제/수정 모두 감지."""
    rows = []
    for root, dirs, names in _walk_strict(path):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for n in sorted(names):
            full = os.path.join(root, n)
            rel = os.path.relpath(full, path).replace("\\", "/")
            rows.append(f"{rel}:{_hash_file(full)}")
    return hashlib.sha256("\n".join(sorted(rows)).encode()).hexdigest()


def _has_kit_ref(path, kind):
    """항목이 라이브러리 바깥의 형제 디렉토리를 참조하는지 휴리스틱 검사(이식성 배지용)."""
    files = []
    if kind == "file":
        files = [path]
    else:
        for root, dirs, names in _walk_strict(path):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            files += [os.path.join(root, n) for n in names if n.endswith((".md", ".js", ".ps1", ".sh", ".py"))]
    for f in files[:50]:
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                if KIT_REF_RE.search(fh.read()):
                    return True
        except OSError:
            continue
    return False


def _env_libs():
    """CLAUDE_CONFIG_LIBRARIES(os.pathsep 구분 복수 경로). env 지정분은 대시보드에서 제거 불가."""
    return [p.strip() for p in os.environ.get("CLAUDE_CONFIG_LIBRARIES", "").split(os.pathsep) if p.strip()]


def _now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def _origin_local(p):
    return "local:" + _norm(p)


def _load_libs(store):
    """라이브러리 레코드 목록 = env + store(libraries/remotes/marketplaces).
    정규화 경로로 중복 제거(첫 표기 유지).

    반환은 dict 레코드다: {"lib", "source", "origin", "map"}.
    libraries 키 자체는 문자열 배열 그대로 둔다 - _norm(os.path.normpath) 이 dict 에서 TypeError.
    """
    recs, seen = [], set()

    def add(p, source, origin, cmap=None):
        if not p:
            return
        k = _norm(p)
        if k in seen:
            return
        seen.add(k)
        recs.append({"lib": p, "source": source, "origin": origin, "map": cmap})

    for p in _env_libs():
        add(p, "env", _origin_local(p))
    cfg = lib_store.load_cfg(store)
    for p in cfg.get("libraries", []):
        add(p, "registered", _origin_local(p))
    for r in cfg.get("remotes", []):
        add(r.get("cache"), "remote", f"remote:{r.get('id')}", r.get("map"))
    for m in cfg.get("marketplaces", []):
        for pl in m.get("plugins", []):
            add(pl.get("cache"), "market", f"market:{m.get('id')}/{pl.get('name')}", pl.get("map"))
    return recs


def _register_lib(store, lib):
    """라이브러리 경로를 store config.json 에 등록(멱등).
    store 미초기화면 lib_store.StoreNotInitialized 가 올라간다 - 호출부가 ok:false 로 보고한다."""
    cfg = lib_store.load_cfg(store)
    libs = cfg.setdefault("libraries", [])
    if all(_norm(x) != _norm(lib) for x in libs):
        libs.append(lib)
        lib_store.save_cfg(store, cfg)
    elif not os.path.exists(lib_store.store_config_path(store)):
        raise lib_store.StoreNotInitialized(f"스토어가 초기화되지 않음: {store}")
    return True


def _unregister_lib(store, lib):
    """store config.json 의 libraries 에서 경로 제거(멱등). env 지정 경로는 여기서 못 지운다."""
    cfg = lib_store.load_cfg(store)
    libs = cfg.get("libraries", [])
    keep = [x for x in libs if _norm(x) != _norm(lib)]
    if len(keep) == len(libs):
        return False
    cfg["libraries"] = keep
    lib_store.save_cfg(store, cfg)
    return True


def _iter_items(lib, category, cmap=None):
    """(leaf, full, kind, relpath) 산출.
    cmap: 카테고리 -> lib 기준 상대경로(원격 레포가 Agents/Skills 처럼 대문자일 때).
    스킬 마커는 대소문자 무시 - skill.md 를 쓴 레포가 대소문자 구분 FS 에서 누락되지 않게.
    file 종류(agents/commands): base 직계 *.md.
    dir 종류(skills): 가변 깊이 재귀 - SKILL.md 를 가진 디렉토리를 스킬 leaf 로 간주.
      (그룹/서브그룹으로 감싸인 구조도 leaf 만 뽑음. leaf 내부 하위폴더로는 안 내려감.)
    relpath 는 base(카테고리 루트) 기준 상대경로 - 그룹 표시·설치 지정에 사용.
    _walk_strict 를 쓰므로 나열 도중 OSError 가 나면(예: 깊은 경로가 Windows 길이 제한을
    넘음) 이 제너레이터가 그대로 raise 한다 - 호출부(cmd_scan)가 카테고리 단위로 잡는다."""
    sub, kind = CATEGORIES[category]
    if cmap and cmap.get(category):
        sub = cmap[category]
    base = os.path.join(lib, sub)
    if not os.path.isdir(base):
        return
    if kind == "file":
        for name in sorted(os.listdir(base)):
            if name.startswith("."):
                continue
            full = os.path.join(base, name)
            if name.lower().endswith(".md") and os.path.isfile(full):
                yield name[:-3], full, kind, name[:-3]
        return
    for root, dirs, names in _walk_strict(base):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        if any(n.casefold() == "skill.md" for n in names):
            rel = os.path.relpath(root, base).replace("\\", "/")
            yield os.path.basename(root), root, kind, rel
            dirs[:] = []  # leaf 확정 - 스킬 내부는 하위 스킬이 아니므로 더 안 내려감


def _target_path(target_root, category, name, kind):
    sub, _ = CATEGORIES[category]
    return os.path.join(target_root, sub, name if kind == "dir" else f"{name}.md")


def _status(lib_path, tgt, kind):
    if not os.path.exists(tgt):
        return "not_installed"
    try:
        if kind == "file":
            same = _hash_file(lib_path) == _hash_file(tgt)
        else:
            same = _hash_dir(lib_path) == _hash_dir(tgt)
    except OSError:
        return "modified"
    return "installed" if same else "modified"


def _recs_for(a, register_new=False):
    """레코드 해석: a.lib 지정 시 이미 알려진 레코드(env/registered/remote/market)와
    norm() 매칭을 시도해, 있으면 그 레코드(정확한 source/origin/map)를 그대로 쓴다.
    없으면(=새 로컬 경로) local: 레코드를 합성한다 - register_new=True(scan 전용)면
    합성 전에 store 에도 등록한다. a.lib 미지정이면 전체 레코드 목록.

    무조건 local: 로 재합성하면(구버전 버그) UI 가 remote 캐시 경로를 --lib 로 보내면서
    --origin 도 같이 보내는 설치 조합(Task 9)에서 origin 필터가 항상 빈 결과가 되어
    원격 레포 설치가 전부 실패한다. 또 이미 remotes[] 에 있는 캐시 경로를 매번 재등록하면
    libraries[] 에도 중복으로 들어가 같은 캐시가 source="registered"/"remote" 두 줄로 쪼개진다.

    StoreNotInitialized 는 register_new 경로에서만 올라올 수 있다 - 호출부(cmd_scan)가 처리."""
    all_recs = _load_libs(a.store)
    if not a.lib:
        return all_recs
    hit = next((r for r in all_recs if _norm(r["lib"]) == _norm(a.lib)), None)
    if hit:
        return [hit]
    if register_new:
        _register_lib(a.store, a.lib)   # StoreNotInitialized 는 호출부로 전파
    return [{"lib": a.lib, "source": "registered", "origin": _origin_local(a.lib), "map": None}]


def _status_ex(cfg, target_root, category, leaf, src, tgt, kind, origin):
    """4상태 판정. (status, owner_origin) 반환.

    원장에 없는 타깃은 기존 해시 비교로 흘린다 - 기능 도입 전 설치분과
    대시보드 밖에서 생긴 항목이 오늘과 완전히 동일하게 동작해야 하므로."""
    if not os.path.exists(tgt):
        return "not_installed", None
    rec = lib_store.ledger_get(cfg, target_root, category, leaf)
    if not rec:
        return _status(src, tgt, kind), None
    owner = rec.get("origin")
    if owner and owner != origin:
        return "conflict", owner
    return _status(src, tgt, kind), owner


def _unit_flags(cfg, target, root, origin):
    """hooks/mcp 보유·설치 플래그. 라이브러리 루트 행과 하위 유닛 행이 같은 규칙을 쓴다.

    hooks/mcp 설치 버튼이 이 플래그에 매달린다(cmd_plugin_fetch 응답에만 있었다 - Task 22
    UI 는 scan 행을 쓰므로 여기 없으면 버튼이 안 뜬다). root 가 없어도 os.path.exists 는
    예외 없이 False 를 준다 - os.walk 가 아니라 exists 2회뿐이라 실패할 여지도 없다.
    설치 여부는 원장(타깃 기준)에서 읽는다. 원장 키는 플러그인 **이름**이라 서로 다른
    마켓의 동명 플러그인이 한 칸을 공유한다 - origin 이 일치할 때만 "설치됨"으로 본다
    (남의 설치를 내 행의 배지로 표시하고 제거 버튼까지 띄우는 오작동 방지)."""
    uname = _unit_name(origin)
    hrec = lib_store.ledger_get(cfg, target, "hooks", uname) or {}
    mrec = lib_store.ledger_get(cfg, target, "mcp", uname) or {}
    h_own = hrec.get("origin") == origin
    m_own = mrec.get("origin") == origin
    return {"has_hooks": os.path.exists(os.path.join(root, plugin_units.HOOKS_REL)),
            "has_mcp": plugin_units.has_mcp(root),   # .mcp.json + plugin.json 인라인 둘 다
            "hooks_installed": h_own, "mcp_installed": m_own,
            "hooks_events": hrec.get("events", []) if h_own else [],
            "mcp_servers": mrec.get("servers", []) if m_own else []}


def _unit_rows(cfg, target, lib):
    """라이브러리 하위 도구 디렉토리(hooks/hooks.json 또는 MCP 선언 보유) 행. origin 은
    local:<그 경로> 라 hooks/mcp-install 이 그대로 치환 루트로 쓴다(_resolve_origin_root)."""
    rows = []
    for root in plugin_units.find_units(lib):
        origin = _origin_local(root)
        rows.append({"lib": root, "name": os.path.basename(root), "origin": origin,
                     **_unit_flags(cfg, target, root, origin)})
    return rows


def cmd_scan(a):
    try:
        recs = _recs_for(a, register_new=True)
    except lib_store.StoreNotInitialized as e:
        print(json.dumps({"ok": False, "message": str(e), "libraries": []}, ensure_ascii=False)); return
    if not recs:
        # 미설정은 오류가 아니라 정상 상태(라이브러리 기능 미사용). 빈 결과로 응답.
        print(json.dumps({"ok": True, "target": a.target, "libraries": []}, ensure_ascii=False)); return
    cfg = lib_store.load_cfg(a.store)
    meta = _source_meta(cfg)          # origin -> {sha, fetched_at, url}
    result = []
    for rec in recs:
        lib, src, origin, cmap = rec["lib"], rec["source"], rec["origin"], rec["map"]
        row = {"lib": lib, "source": src, "origin": origin, "marketplace": _is_marketplace(lib),
               **_unit_flags(cfg, a.target, lib, origin), **meta.get(origin, {})}
        if not os.path.isdir(lib):
            result.append({**row, "error": "경로 없음", "categories": {}, "units": []})
            continue
        row["units"] = _unit_rows(cfg, a.target, lib)
        cats = {}
        enum_errors = []
        for category in CATEGORIES:
            items = []
            try:
                for leaf, full, kind, rel in _iter_items(lib, category, cmap):
                    # 설치는 leaf 이름으로 평탄화(그룹 접두 제거) -> ~/.claude/<sub>/<leaf>
                    tgt = _target_path(a.target, category, leaf, kind)
                    st, owner = _status_ex(cfg, a.target, category, leaf, full, tgt, kind, origin)
                    group = os.path.dirname(rel).replace("\\", "/")  # "" = 그룹 없음(평면)
                    items.append({
                        "name": leaf,
                        "group": group,      # 표시용(가변 깊이 트리): "2-stack/java-spring" 등
                        "relpath": rel,      # 설치 지정용(소스 상대경로, leaf 와 다를 수 있음)
                        "status": st,
                        "owner": owner,       # conflict 일 때 현재 소유자 origin
                        "origin": origin,
                        "kit_ref": _has_kit_ref(full, kind),
                        "lib_path": full,
                        "target": tgt,
                    })
            except OSError as e:
                # 나열이 도중에 죽었다(예: 깊은 하위경로가 Windows MAX_PATH 를 넘음).
                # _walk_strict 가 이제 이걸 삼키지 않고 올려 보낸다(fix round 2 finding) -
                # 이 카테고리만 비우고 계속하되(한 라이브러리의 사고가 scan 전체를 막지 않음),
                # row 에 error 를 남겨 "진짜 항목 0개"와 구분되게 한다.
                enum_errors.append(f"{category}: {e}")
                items = []
            cats[category] = items
        row_out = {**row, "categories": cats}
        if enum_errors:
            row_out["error"] = "일부 항목을 나열하지 못함 - " + "; ".join(enum_errors)
        result.append(row_out)
    print(json.dumps({"ok": True, "target": a.target, "libraries": result}, ensure_ascii=False))


def _source_meta(cfg):
    """origin -> 표시용 메타(고정 sha / fetched_at / url). staleness 배지의 근거."""
    m = {}
    for r in cfg.get("remotes", []):
        m[f"remote:{r.get('id')}"] = {"sha": r.get("sha"), "fetched_at": r.get("fetched_at"), "url": r.get("url")}
    for mk in cfg.get("marketplaces", []):
        for pl in mk.get("plugins", []):
            m[f"market:{mk.get('id')}/{pl.get('name')}"] = {
                "sha": pl.get("sha"), "fetched_at": pl.get("fetched_at"), "url": mk.get("url")}
    return m


def cmd_unregister(a):
    """등록 해제. --lib(로컬 경로) 또는 --origin(remote:/market:[/<plugin>]).
    캐시 삭제는 **원장이 그 캐시를 참조하지 않을 때만** 한다 - hooks/MCP 가 걸려 있으면 거부한다.

    market:<id>/<plugin> 은 그 플러그인 하나만 뺀다 - Library 칸의 플러그인 칩 ✕ 가 이 형태의
    origin 을 그대로 보내므로, 예전처럼 market:<id> 로 뭉뚱그려 mid 만 뽑으면 플러그인 하나를
    지우려다 마켓 등록 전체(레포 + 다른 모든 플러그인)를 날려버린다(fix round 1 finding)."""
    # scan 처럼 항상 exit 0 + JSON 으로 응답(runPy 가 nonzero exit 를 throw 하므로 out() 대신 print).
    if a.origin:
        cfg = lib_store.load_cfg(a.store)
        origin = a.origin

        if origin.startswith("remote:"):
            rid = origin[len("remote:"):]
            arr = cfg.get("remotes", [])
            hit = next((x for x in arr if x.get("id") == rid), None)
            if not hit:
                print(json.dumps({"ok": True, "message": "이미 없음 (no-op)", "removed": False},
                                 ensure_ascii=False)); return
            caches = [hit["cache"]] if hit.get("cache") else []
            held = []
            for c in caches:
                held += lib_store.ledger_refs_root(cfg, c)
            if held:
                print(json.dumps({"ok": False,
                                  "message": f"이 캐시를 참조하는 설치 항목이 {len(held)}건 있어 해제할 수 없습니다",
                                  "held_by": [h["key"] for h in held]}, ensure_ascii=False)); return
            arr.remove(hit)
            lib_store.save_cfg(a.store, cfg)
            for c in caches:
                _rmtree_force(c)
            print(json.dumps({"ok": True, "message": f"등록 해제됨: {origin}", "removed": True},
                             ensure_ascii=False)); return

        if origin.startswith("market:"):
            rest = origin[len("market:"):]
            mid, _, pname = rest.partition("/")
            mks = cfg.get("marketplaces", [])
            mhit = next((x for x in mks if x.get("id") == mid), None)
            if not mhit:
                print(json.dumps({"ok": True, "message": "이미 없음 (no-op)", "removed": False},
                                 ensure_ascii=False)); return

            if pname:
                # 플러그인 단위: 그 플러그인만 빼고 마켓 등록·매니페스트 캐시·다른 플러그인은 안 건드린다.
                pl = mhit.get("plugins", [])
                phit = next((p for p in pl if p.get("name") == pname), None)
                if not phit:
                    print(json.dumps({"ok": True, "message": "이미 없음 (no-op)", "removed": False},
                                     ensure_ascii=False)); return
                pcache = phit.get("cache")
                # 가드는 이 플러그인의 캐시만 본다 - 다른 플러그인이나 마켓 루트를 붙잡은 원장
                # 항목이 이 해제를 막으면 안 된다(ledger_refs_root 는 containment 라 pcache 를
                # 넘기면 pcache 의 하위만 잡고 마켓 루트 같은 조상은 절대 안 잡는다).
                held = lib_store.ledger_refs_root(cfg, pcache) if pcache else []
                if held:
                    print(json.dumps({"ok": False,
                                      "message": f"이 캐시를 참조하는 설치 항목이 {len(held)}건 있어 해제할 수 없습니다",
                                      "held_by": [h["key"] for h in held]}, ensure_ascii=False)); return
                pl.remove(phit)
                lib_store.save_cfg(a.store, cfg)
                # 번들(str-path)은 마켓 레포 워킹트리를 공유한다 - 손으로 지우면 매니페스트나
                # 다른 플러그인까지 같이 날아간다. 등록만 빼고 디스크는 건드리지 않는다.
                # 외부는 plugins/<name>/ 전체가 이 플러그인 전용이라 통째로 지운다.
                if phit.get("kind") != "str-path":
                    _, _, plugins_dir = _market_paths(a.store, mid)
                    _rmtree_force(os.path.join(plugins_dir, pname))
                print(json.dumps({"ok": True, "message": f"등록 해제됨: {origin}", "removed": True},
                                 ensure_ascii=False)); return

            # 마켓 단위(플러그인 세그먼트 없음): 레포 + 모든 플러그인이 한 덩이라 전부 지운다.
            caches = [mhit.get("cache")] + [p.get("cache") for p in mhit.get("plugins", [])]
            caches = [c for c in caches if c]
            held = []
            for c in caches:
                held += lib_store.ledger_refs_root(cfg, c)
            if held:
                print(json.dumps({"ok": False,
                                  "message": f"이 캐시를 참조하는 설치 항목이 {len(held)}건 있어 해제할 수 없습니다",
                                  "held_by": [h["key"] for h in held]}, ensure_ascii=False)); return
            mks.remove(mhit)
            lib_store.save_cfg(a.store, cfg)
            # market 은 repo + plugins 가 <store>/lib-cache/markets/<id>/ 아래 한 덩이라 그 루트를 지운다.
            _rmtree_force(_lib_cache(a.store, "markets", mid))
            print(json.dumps({"ok": True, "message": f"등록 해제됨: {origin}", "removed": True},
                             ensure_ascii=False)); return

        print(json.dumps({"ok": False, "message": f"origin 형식이 아님: {origin}"}, ensure_ascii=False)); return

    if not a.lib:
        print(json.dumps({"ok": False, "message": "제거할 라이브러리 경로(--lib) 또는 --origin 필요"},
                         ensure_ascii=False)); return
    if any(_norm(a.lib) == _norm(e) for e in _env_libs()):
        print(json.dumps({"ok": False, "message": "환경변수(CLAUDE_CONFIG_LIBRARIES)로 지정된 경로는 제거할 수 없습니다"}, ensure_ascii=False)); return
    try:
        removed = _unregister_lib(a.store, a.lib)
    except lib_store.StoreNotInitialized:
        removed = False
    print(json.dumps({"ok": True, "message": "라이브러리 경로 제거됨" if removed else "이미 없음 (no-op)", "removed": removed}, ensure_ascii=False))


def _resolve_item(a):
    """(src, kind, target, origin) 해석. a.path = 카테고리 루트 기준 상대경로(가변 깊이 허용).
    타깃은 leaf 이름으로 평탄화.
    경로 주입 차단: 각 세그먼트는 순수 파일명이어야 함 - 빈/./.. 금지, 콜론 금지
    (드라이브상대 'C:foo' 는 isabs=False 로 새어들어 os.path.join 이 lib 밖으로 튐 + NTFS ADS 'a:b'),
    그리고 basename 과 동일(구분자·드라이브 접두 제거되면 다름)."""
    rel = (a.path or "").replace("\\", "/").strip("/")
    parts = rel.split("/") if rel else []
    seg_bad = any(p in ("", ".", "..") or ":" in p or p != os.path.basename(p) for p in parts)
    if not parts or os.path.isabs(a.path) or seg_bad:
        out(False, f"경로가 유효하지 않음: '{a.path}'")
    sub, kind = CATEGORIES[a.category]
    if kind == "file" and len(parts) != 1:
        out(False, f"경로는 단일 이름이어야 함: '{a.path}'")
    leaf = parts[-1]
    recs = _recs_for(a)
    if getattr(a, "origin", None):
        recs = [r for r in recs if r["origin"] == a.origin]
        if not recs:
            out(False, f"출처를 찾을 수 없음: {a.origin}")
    hits = []
    for r in recs:
        cmap = r.get("map") or {}
        src = os.path.join(r["lib"], cmap.get(a.category) or sub, *parts)
        if kind == "file":
            src += ".md"
        if os.path.exists(src):
            hits.append((src, kind, _target_path(a.target, a.category, leaf, kind), r["origin"]))
    if not hits:
        out(False, f"라이브러리에 없음: {a.category}/{rel}")
    if len(hits) > 1:
        # 캐시가 여러 개면 첫 매치를 조용히 고르는 건 conflict 판정을 우회한다.
        out(False, f"출처가 모호함({len(hits)}개) - --origin 으로 지정하세요",
            candidates=[h[3] for h in hits])
    return hits[0]


def cmd_install(a):
    # phantom 방지: target(.claude 루트)의 부모(프로젝트 폴더 또는 HOME)가 실제로 존재해야 설치.
    # 전역 ~/.claude 는 부모 ~ 가 항상 존재하므로 통과. 없는 프로젝트 경로에 .claude 를 만들지 않는다.
    parent = os.path.dirname(os.path.normpath(a.target))
    if parent and not os.path.isdir(parent):
        out(False, f"설치 대상의 부모 디렉토리가 없음(phantom 방지): {parent}")
    src, kind, tgt, origin = _resolve_item(a)
    existed = os.path.exists(tgt)
    if not a.no_snapshot:
        snapshot_before(a.store)
    bak = None
    if existed:
        # 이미 설치된 항목은 오류 대신 동기화: 라이브러리 버전으로 덮어쓰기 전 백업(파일 .bak / 디렉토리 .trash)
        bak = backup(tgt) if kind == "file" else trash(tgt)
    os.makedirs(os.path.dirname(tgt), exist_ok=True)
    if kind == "file":
        shutil.copy2(src, tgt)
    else:
        shutil.copytree(src, tgt)
    leaf = os.path.basename(a.path.replace("\\", "/").strip("/"))
    warn = None
    try:
        cfg = lib_store.load_cfg(a.store)
        lib_store.ledger_put(cfg, a.target, a.category, leaf, {
            "origin": origin,
            "relpath": a.path,
            "src_hash": _hash_file(src) if kind == "file" else _hash_dir(src),
            "at": _now(),
        })
        lib_store.save_cfg(a.store, cfg)
    except lib_store.StoreNotInitialized:
        # 파일은 이미 설치됐다. 원장만 못 남긴 상태를 숨기지 않는다 -
        # 이 항목은 다음 scan 에서 하위호환(해시 비교) 경로로 흐른다.
        warn = "스토어 미초기화로 출처를 기록하지 못했습니다(설치 자체는 완료)"
    out(True, f"{'동기화' if existed else '설치'}됨: {a.category}/{a.path}",
        target=tgt, backup=bak, synced=existed, origin=origin, warning=warn)


def cmd_uninstall(a):
    if a.name != os.path.basename(a.name) or a.name in (".", "..") or ":" in a.name or any(c in a.name for c in "\\/"):
        out(False, f"이름이 유효하지 않음: '{a.name}'")
    sub, kind = CATEGORIES[a.category]
    tgt = _target_path(a.target, a.category, a.name, kind)
    if not os.path.exists(tgt):
        out(True, f"이미 없음: {a.category}/{a.name} (no-op)", changed=False)
    cfg = lib_store.load_cfg(a.store)
    rec = lib_store.ledger_get(cfg, a.target, a.category, a.name)
    owner = (rec or {}).get("origin")
    if a.origin and owner and owner != a.origin:
        # 요청한 출처가 소유자가 아니다. 남의 설치를 지우지 않는다.
        out(False, f"출처가 다릅니다 - 이 항목의 소유자는 '{owner}' 입니다", owner=owner)
    if not a.no_snapshot:
        snapshot_before(a.store)
    dst = trash(tgt)
    try:
        lib_store.ledger_del(cfg, a.target, a.category, a.name)
        lib_store.save_cfg(a.store, cfg)
    except lib_store.StoreNotInitialized:
        pass          # 원장이 애초에 없었다는 뜻 - 지울 것도 없다
    out(True, f"제거됨(.trash 이동): {a.category}/{a.name}", trashed=dst, owner=owner)


def _lib_cache(store, *parts):
    return os.path.join(store, "lib-cache", *parts)


def _rmtree_force(path):
    """git 캐시(.git/objects 의 pack/idx 는 읽기전용) 도 지우는 rmtree.
    ignore_errors=True 만 쓰면 읽기전용 파일에서 조용히 절반만 지워진 캐시가 남는다 -
    unregister/plugin-fetch 정리가 실제로 끝났다고 오인하게 만든다."""
    if not os.path.exists(path):
        return

    def _onerror(func, p, exc_info):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    shutil.rmtree(path, onerror=_onerror)


def _norm_url(u):
    """비교 전용 URL 정규화. 후행 슬래시/.git 접미/대소문자만 흡수한다 -
    같은 레포를 가리키는 표기 차이(github.com/a/b vs github.com/a/b.git)를 중복으로 잡기 위한 것이지
    URL 을 정규화해 저장하려는 게 아니다(저장은 사용자가 준 표기 그대로)."""
    s = (u or "").strip().rstrip("/")
    if s.lower().endswith(".git"):
        s = s[:-4]
    return s.casefold()


def _dup_checks(entries, eid, url):
    """(거부 사유, 같은 id 의 기존 레코드). 사유가 있으면 호출부가 ok:false 로 끝낸다.

    id 는 URL 의 레포명에서 파생되므로 서로 다른 두 URL 이 같은 id 를 만들 수 있다
    (.../a/plugins.git 과 .../b/plugins.git). 그대로 두면 뒤에 등록한 쪽이 앞 레코드를
    조용히 덮어쓰는데, 이미 fetch 한 플러그인 목록까지 물려받아 다른 레포의 캐시를
    가리키는 레코드가 된다 - 등록이 아니라 손상이다."""
    same_id = next((e for e in entries if e.get("id") == eid), None)
    same_url = next((e for e in entries
                     if e.get("id") != eid and _norm_url(e.get("url")) == _norm_url(url)), None)
    if same_url:
        return (f"이 URL 은 이미 '{same_url.get('id')}' 로 등록돼 있습니다", None)
    if same_id and _norm_url(same_id.get("url")) != _norm_url(url):
        return (f"id '{eid}' 는 이미 다른 URL 로 등록돼 있습니다({same_id.get('url')}) - "
                f"--id 로 다른 이름을 지정하세요", None)
    return (None, same_id)


def _id_from_url(url):
    """URL 에서 레포명을 파생. 신뢰할 수 없는 입력이므로 세그먼트 검증을 통과해야 한다."""
    base = url.rstrip("/").split("/")[-1]
    if base.endswith(".git"):
        base = base[:-4]
    if not base or base != os.path.basename(base) or base in (".", "..") or \
       ":" in base or any(c in base for c in "\\/"):
        out(False, f"URL 에서 유효한 id 를 만들 수 없습니다: '{url}' - --id 로 지정하세요")
    return base


def cmd_remote_add(a):
    """임의 git 레포를 라이브러리로 등록. 네트워크를 타는 명시 호출 도구다(scan 아님)."""
    if not remote_fetch.git_available():
        print(json.dumps({"ok": False, "message": "git 을 PATH 에서 찾을 수 없습니다"}, ensure_ascii=False)); return
    rid = a.id or _id_from_url(a.url)
    if rid != os.path.basename(rid) or ":" in rid or any(c in rid for c in "\\/"):
        out(False, f"id 가 유효하지 않음: '{rid}'")
    reason, prev = _dup_checks(lib_store.load_cfg(a.store).get("remotes", []), rid, a.url)
    if reason:
        print(json.dumps({"ok": False, "message": reason}, ensure_ascii=False)); return
    cache = _lib_cache(a.store, "remotes", rid)
    cmap = None
    if a.map:
        try:
            cmap = json.loads(a.map)
        except ValueError as e:
            out(False, f"--map 이 JSON 이 아님: {e}")
        if not isinstance(cmap, dict) or any(k not in CATEGORIES for k in cmap):
            out(False, f"--map 키는 {list(CATEGORIES)} 중 하나여야 합니다")
    try:
        sha = remote_fetch.materialize(cache, a.url, ref=a.ref or None)
    except remote_fetch.GitError as e:
        print(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False)); return
    layout = remote_fetch.detect_layout(cache)
    if cmap:
        layout["map"] = {**layout["map"], **cmap}
    try:
        cfg = lib_store.load_cfg(a.store)
        remotes = cfg.setdefault("remotes", [])
        rec = {"id": rid, "url": a.url, "ref": a.ref or None, "sha": sha,
               "fetched_at": _now(), "cache": cache, "map": layout["map"] or None}
        for i, r in enumerate(remotes):
            if r.get("id") == rid:
                remotes[i] = rec
                break
        else:
            remotes.append(rec)
        lib_store.save_cfg(a.store, cfg)
    except lib_store.StoreNotInitialized as e:
        print(json.dumps({"ok": False, "message": str(e), "cache": cache}, ensure_ascii=False)); return
    # clone 이 끝난 뒤에야 매니페스트 유무를 알 수 있다(사전 판별하려면 받아보는 수밖에 없다).
    # 그래서 거절이 아니라 사후 통지다 - .claude 레이아웃이 있으면 원격 등록 자체는 유효하고,
    # 마켓플레이스이기도 하다는 사실만 UI 가 이어서 안내한다.
    print(json.dumps({"ok": True, "id": rid, "origin": f"remote:{rid}", "cache": cache,
                      "sha": sha, "layout": layout, "already": bool(prev),
                      "marketplace": _is_marketplace(cache),
                      "message": (f"이미 등록된 원격입니다 - 갱신했습니다: {rid}" if prev
                                  else f"원격 라이브러리 등록됨: {rid}")}, ensure_ascii=False))


def _market_paths(store, mid):
    base = _lib_cache(store, "markets", mid)
    return base, os.path.join(base, "repo"), os.path.join(base, "plugins")


def _is_marketplace(root):
    """root 가 마켓플레이스 매니페스트를 품고 있는가. 파일 존재 확인 한 번이고 네트워크를
    타지 않는다 - 이미 디스크에 있는 것(로컬 경로 / clone 끝난 캐시)에만 묻는다.

    Library 와 Marketplace 를 가르는 실제 축은 전송 방식(로컬/원격)이 아니라 이 매니페스트의
    유무다. UI 가 잘못 넣은 소스를 반대편으로 안내하려면 그 사실을 응답에 실어야 한다."""
    try:
        return os.path.isfile(os.path.join(root or "", marketplace.MANIFEST_REL))
    except (OSError, ValueError):
        return False


def _local_manifest_sha(path):
    """로컬 마켓은 리비전이 없다 - 매니페스트 내용 해시를 sha 자리에 넣는다.
    None 을 넣으면 '갱신했는데 아무 변화가 없다'로 보이지만, 내용 해시면 사용자가 파일을
    고친 순간 값이 달라져 다시 읽었다는 사실이 눈에 보인다."""
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:12]
    except OSError:
        return None


def cmd_market_add(a):
    """마켓 소스 4형식(owner/repo · git URL · marketplace.json URL · 로컬 경로)을 등록.

    git 이면 .claude-plugin/ 만 sparse checkout 한다(실측: 401K vs 전체 9.7M, 24배).
    json 이면 매니페스트 파일 하나만 받고, local 이면 **복사하지 않고** 그 경로를 그대로
    캐시로 삼는다 - 사용자가 이미 디스크에 들고 있는 걸 스토어에 두 벌로 만들면 어느 쪽이
    진짜인지 모르게 되고, 원본을 고쳐도 반영되지 않는다.
    어느 형식이든 플러그인은 선택 시점에 받는다."""
    try:
        cs = marketplace.classify_source(a.url)
    except marketplace.ManifestError as e:
        print(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False)); return
    kind = cs["kind"]
    # 저장하는 값은 항상 정규화된 표기다(축약 -> 전체 URL, 로컬 -> realpath). cmd_fetch 가
    # 이 값을 다시 classify_source 에 넣으므로, 같은 kind 로 되돌아오지 않으면 갱신이 깨진다.
    url = cs["path"] if kind == "local" else cs["url"]
    if kind == "git" and not remote_fetch.git_available():
        print(json.dumps({"ok": False, "message": "git 을 PATH 에서 찾을 수 없습니다"}, ensure_ascii=False)); return
    mid = a.id or (_id_from_url(url) if kind == "git" else cs["id"])
    if not mid:
        # 여기는 out() 을 쓰지 않는다: out() 은 exit 1 이고 호출부 runPy 는 nonzero 를 throw 라
        # "--id 로 지정하세요" 라는 안내가 UI 에 닿지 못한 채 예외로 바뀐다. 평범한 입력
        # (호스트 루트의 marketplace.json 처럼 id 로 쓸 세그먼트가 없는 주소)으로 닿는 분기다.
        print(json.dumps({"ok": False, "message":
                          f"소스에서 유효한 id 를 만들 수 없습니다: '{a.url}' - --id 로 지정하세요"},
                         ensure_ascii=False)); return
    if mid != os.path.basename(mid) or ":" in mid or any(c in mid for c in "\\/"):
        out(False, f"id 가 유효하지 않음: '{mid}'")
    reason, prev0 = _dup_checks(lib_store.load_cfg(a.store).get("marketplaces", []), mid, url)
    if reason:
        print(json.dumps({"ok": False, "message": reason}, ensure_ascii=False)); return
    _, repo, _ = _market_paths(a.store, mid)
    cache = repo
    try:
        if kind == "git":
            # 축약에 붙여 온 ref(owner/repo#branch)를 명시적 --ref 보다 우선한다 - 사용자가
            # 방금 소스 문자열에 적은 쪽이 더 구체적인 의사표시다.
            sha = remote_fetch.materialize(repo, url, ref=cs.get("ref") or a.ref or None,
                                           sparse=[".claude-plugin"])
        elif kind == "json":
            sha = remote_fetch.fetch_manifest_json(repo, url)
        else:
            cache = url                      # 로컬은 fetch 없이 경로 검증만 한다
            sha = None                       # 매니페스트를 읽은 뒤 내용 해시로 채운다
    except remote_fetch.FetchError as e:
        print(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False)); return
    manifest_path = os.path.join(cache, marketplace.MANIFEST_REL)
    try:
        mf = marketplace.parse_manifest(manifest_path)
    except marketplace.ManifestError as e:
        hint = ("마켓플레이스가 아닙니다(.claude-plugin/marketplace.json 이 없습니다)" if kind == "local"
                else "마켓플레이스가 아닌 것 같습니다(remote-add 를 쓰세요)")
        # code 를 함께 준다: message 는 한국어 문장이라 UI 가 문자열 매칭으로 분기할 수 없다
        # (영어 UI 에서 깨지고, 문구를 고치는 순간 조용히 죽는다). 분기는 code 로만 한다.
        print(json.dumps({"ok": False, "code": "not_a_marketplace",
                          "message": f"{e} - {hint}"}, ensure_ascii=False)); return
    if kind == "local":
        sha = _local_manifest_sha(manifest_path)
    try:
        cfg = lib_store.load_cfg(a.store)
        mks = cfg.setdefault("marketplaces", [])
        prev = next((m for m in mks if m.get("id") == mid), None)
        # kind 를 남긴다. 없는(구버전) 레코드는 읽는 쪽에서 git 으로 간주한다 - 그때는 git 만 있었다.
        # ref 는 git 에서만 의미가 있다(json/local 에는 브랜치라는 게 없다).
        rec = {"id": mid, "url": url, "ref": (a.ref or None) if kind == "git" else None,
               "kind": kind, "sha": sha, "fetched_at": _now(),
               "cache": cache, "name": mf["name"],
               "plugins": (prev or {}).get("plugins", [])}   # 이미 fetch 한 플러그인은 보존
        if prev:
            mks[mks.index(prev)] = rec
        else:
            mks.append(rec)
        lib_store.save_cfg(a.store, cfg)
    except lib_store.StoreNotInitialized as e:
        print(json.dumps({"ok": False, "message": str(e), "cache": cache}, ensure_ascii=False)); return
    cat = marketplace.catalog(mf, {}, limit=0)
    # 같은 URL 을 다시 등록한 경우는 거부하지 않는다(매니페스트 갱신이 정당한 동작이다) -
    # 대신 새로 등록한 것처럼 말하지 않는다. 이미 fetch 한 플러그인은 그대로 보존된다.
    again = ("이미 등록된 마켓플레이스입니다 - 디스크에서 다시 읽었습니다" if kind == "local"
             else "이미 등록된 마켓플레이스입니다 - 매니페스트를 갱신했습니다")
    print(json.dumps({"ok": True, "id": mid, "name": mf["name"], "cache": cache, "sha": sha,
                      "kind": kind, "url": url,
                      "plugins": cat["total"], "categories": cat["categories"],
                      "already": bool(prev0),
                      "message": (f"{again}: {mid} (플러그인 {cat['total']}개)" if prev0
                                  else f"마켓플레이스 등록됨: {mid} (플러그인 {cat['total']}개)")},
                     ensure_ascii=False))


def cmd_market_discover(a):
    """Claude Code(`/plugins`)에 등록된 마켓을 읽어 이 스토어와 대조한다.

    **네트워크를 타지 않는다.** 읽는 파일은 known_marketplaces.json 하나뿐이고, 실제 등록은
    사용자가 후보를 골라 market-add 를 눌렀을 때만 일어난다. Claude Code 의 플러그인 캐시는
    건드리지 않는다 - .in_use / GC 가 딸린 비공개 수명주기다.

    양쪽에 다 등록된 마켓은 숨기지 않고 both 로 돌려준다. 두 도구가 같은 레포를 **각자의
    캐시에 서로 다른 시점으로** 들고 있기 때문에, 그 어긋남은 감추는 것보다 보이는 게 낫다.
    Claude Code 쪽은 sha 를 기록하지 않으므로(lastUpdated 만 있다) 시각끼리 비교한다."""
    pdir = a.plugins_dir or plugin_state.DEFAULT_PLUGINS_DIR
    mks = lib_store.load_cfg(a.store).get("marketplaces", []) or []
    mine = {plugin_state.norm_url(m.get("url")): m for m in mks if m.get("url")}
    new, both, unusable = [], [], []
    for name, m in sorted(plugin_state.read_markets(pdir).items()):
        row = {"name": name, "kind": m["kind"], "repo": m["repo"], "url": m["url"],
               "path": m["path"], "claude_updated": m["updated"]}
        if not m["url"]:
            # 조용히 빼면 "왜 N개가 아니지"가 되므로 이유와 함께 돌려준다. 사유를 한 종류로
            # 못박지 않는다 - URL 이 없는 종류는 file/directory(로컬 경로) 말고도 npm ·
            # settings · seeded 가 있어서, 하나로 적으면 나머지에 거짓말이 된다.
            unusable.append({**row, "reason": f"가져올 URL 이 없는 소스: {m['kind'] or '알 수 없음'}"
                                              + (f" ({m['path']})" if m["path"] else "")})
            continue
        got = mine.get(plugin_state.norm_url(m["url"]))
        if got:
            both.append({**row, "id": got.get("id"), "sha": got.get("sha"),
                         "fetched_at": got.get("fetched_at")})
        else:
            new.append(row)
    print(json.dumps({"ok": True, "plugins_dir": pdir, "new": new, "both": both,
                      "unusable": unusable,
                      "message": (f"가져올 수 있는 마켓 {len(new)}개 · 양쪽 등록 {len(both)}개"
                                  + (f" · 가져올 수 없음 {len(unusable)}개" if unusable else ""))},
                     ensure_ascii=False))


def cmd_catalog(a):
    """등록된 마켓의 카탈로그. **네트워크를 타지 않는다** - 캐시된 매니페스트만 읽는다.

    페이지는 **합친 목록 위에서 한 번** 자른다. 마켓별로 limit/offset 을 걸면(구버전)
    offset=40 이 "마켓마다 40개씩 건너뛰기"가 되고 한 페이지에 limit×마켓수 행이 실려
    total 과 어긋난다 - 마켓이 둘 이상이면 페이지 이동이 곧바로 깨진다.
    (UI 는 --marketplace 로 마켓 하나씩 따로 페이징한다. 그 경우 이 슬라이스가 곧 그 마켓의
    슬라이스가 되므로 같은 코드가 두 용도를 함께 만족한다.)

    각 행에는 어느 마켓/URL 에서 왔는지를 붙인다 - 합쳐 자른 뒤에도 출처가 유지되도록
    별도 메타 배열이 아니라 행 자체에 담는다. marketplaces 요약은 그와 별개로 항상 싣는다:
    UI 가 마켓별 구획을 그리려면 행을 한 줄도 받기 전에 마켓 목록과 각 개수가 필요하다.
    limit 이 음수면 행을 아예 싣지 않는다(요약 전용 조회)."""
    cfg = lib_store.load_cfg(a.store)
    mks = [m for m in cfg.get("marketplaces", []) if not a.marketplace or m.get("id") == a.marketplace]
    rows, counts, summary = [], {}, []
    for m in mks:
        mpath = os.path.join(m.get("cache") or "", marketplace.MANIFEST_REL)
        if not os.path.exists(mpath):
            continue      # 캐시가 사라졌으면 그 마켓만 건너뛴다(전체를 죽이지 않음)
        try:
            mf = marketplace.parse_manifest(mpath)
        except marketplace.ManifestError:
            continue
        fetched = {p.get("name"): p for p in m.get("plugins", [])}
        r = marketplace.catalog(mf, fetched, query=a.query, category=a.category, limit=0)
        mname = mf.get("name") or m.get("name") or m.get("id")
        # total 은 필터 후 개수(페이저가 쓴다), total_all 은 필터 전 개수다.
        # 둘 다 보내야 UI 가 "2 / 284" 로 필터가 걸려 있다는 사실 자체를 드러낼 수 있다 -
        # 필터 후 개수만 보이면 접힌 섹션에서는 왜 2개인지 알 방법이 없다.
        # categories 집계는 marketplace.catalog 안에서 필터 **전에** 세므로 그 합이 곧 전체 개수다.
        summary.append({"id": m.get("id"), "name": mname, "url": m.get("url") or "",
                        "total": r["total"], "total_all": sum(r["categories"].values())})
        for k, v in r["categories"].items():
            counts[k] = counts.get(k, 0) + v
        for row in r["rows"]:
            rows.append({**row, "marketplace": m.get("id"),
                         "market_name": mname, "market_url": m.get("url") or ""})
    total = len(rows)
    limit = a.limit if a.limit and a.limit > 0 else 0
    # 검색/필터로 total 이 줄면 옛 offset 이 목록 밖을 가리킨다 - 마지막 페이지로 당긴다.
    offset = max(0, a.offset or 0)
    if limit and offset >= total:
        offset = max(0, ((total - 1) // limit) * limit) if total else 0
    if a.limit is not None and a.limit < 0:
        page = []
    else:
        page = rows[offset:offset + limit] if limit else rows[offset:]
    print(json.dumps({"ok": True, "total": total, "total_all": sum(counts.values()),
                      "offset": offset, "limit": a.limit,
                      "categories": counts, "marketplaces": summary, "rows": page},
                     ensure_ascii=False))


def _count_components(root, cmap=None):
    """fetch 직후 실제 개수. 카탈로그에는 이 칼럼이 없다 - fetch 이후에만 알 수 있으므로.

    _iter_items 는 나열 실패를 삼키지 않는다(fix round 2) - root 자체의 존재는
    cmd_plugin_fetch 가 이미 등록 전에 확인했지만(같은 라운드의 1번 수정), root 안쪽 더
    깊은 경로 하나가 읽기 실패할 수는 있다. round 2 는 그 실패를 0 으로 뭉개 크래시만
    막았는데, 그 결과 "가져옴: 성공, skills 0개" 라는 응답이 나갔다 - 사용자에게는
    "fetch 는 됐는데 진짜 비어 있다"로 읽혀, 곧바로 이어지는 scan 의 error 와 모순됐다
    (fix round 3 finding). 0 은 '읽었더니 진짜 없다'와 '못 읽었다'를 구분하지 못하므로
    실패는 별도 dict 로 갈라 둔다 - 호출부가 실수로 실패를 0 으로 오독할 수 없게 한다.

    반환: {"counts": {카테고리: 성공적으로 읽은 개수, ...},   # 실패한 카테고리는 여기 없음
           "failed": {카테고리: 실패 사유(str(OSError)), ...}} # 성공한 카테고리는 여기 없음
    두 dict 의 키 집합은 항상 서로소다 - 카테고리 하나가 동시에 양쪽에 나타나지 않는다."""
    counts, failed = {}, {}
    for c in CATEGORIES:
        try:
            counts[c] = sum(1 for _ in _iter_items(root, c, cmap))
        except OSError as e:
            failed[c] = str(e)
    return {"counts": counts, "failed": failed}


def cmd_plugin_fetch(a):
    """카탈로그의 플러그인 1개를 물질화해 Library 에 합류시킨다.

    번들(str-path)이면 마켓 레포의 sparse 집합을 그 경로만큼 확장하고(+42K),
    외부면 그 플러그인만 별도 fetch 한다(~444K). 278개를 미리 받지 않는다."""
    mid = a.marketplace
    cfg = lib_store.load_cfg(a.store)
    m = next((x for x in cfg.get("marketplaces", []) if x.get("id") == mid), None)
    if not m:
        out(False, f"등록되지 않은 마켓플레이스: {mid}")
    try:
        # 플러그인 이름은 신뢰할 수 없는 입력이다. 디스크를 만지기 전에 검증한다.
        marketplace.safe_segment(a.plugin, "플러그인 이름")
        mf = marketplace.parse_manifest(os.path.join(m.get("cache") or "", marketplace.MANIFEST_REL))
    except (marketplace.ManifestError,) as e:
        print(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False)); return
    entry, canon = marketplace.resolve_plugin(mf, a.plugin)
    if not entry:
        print(json.dumps({"ok": False, "message": f"카탈로그에 없는 플러그인: {a.plugin}"},
                         ensure_ascii=False)); return
    try:
        spec = marketplace.source_spec(entry)
    except marketplace.ManifestError as e:
        print(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False)); return

    _, repo, plugins_dir = _market_paths(a.store, mid)
    prev = next((p for p in m.get("plugins", []) if p.get("name") == canon), None)
    old_root = (prev or {}).get("cache")          # 0단계: 옛 root 를 먼저 읽어 둔다
    old_staging = (prev or {}).get("staging")      # 외부 플러그인의 옛 sha 스테이징 루트(있으면)

    if spec["kind"] == "str-path" and (m.get("kind") or "git") != "git":
        # 번들 플러그인은 "마켓 레포의 워킹트리를 넓힌다"는 뜻이라 git 마켓에서만 성립한다.
        # json/local 마켓에는 넓힐 레포가 없다 - 그대로 두면 매니페스트 URL 이나 로컬 경로를
        # clone 하려다 엉뚱한 git 오류를 뱉으므로 여기서 이유를 밝히고 끝낸다.
        print(json.dumps({"ok": False, "message":
                          f"이 마켓({m.get('kind')})은 레포가 없어 번들 플러그인을 가져올 수 없습니다: {canon}"
                          " - 로컬 경로라면 라이브러리 경로(--lib)로 등록해 쓰세요"},
                         ensure_ascii=False)); return
    try:
        if spec["kind"] == "str-path":
            # 번들: 마켓 레포의 sparse 집합을 확장한다(별도 클론 없음). 지울 전용 스테이징이 없다.
            keep = sorted({".claude-plugin", *[p.get("sparse") for p in m.get("plugins", []) if p.get("sparse")],
                           spec["path"]})
            sha = remote_fetch.materialize(repo, m["url"], ref=m.get("ref") or None, sparse=keep)
            root = os.path.join(repo, *spec["path"].split("/"))
            sparse = spec["path"]
            staging = None
        else:
            # 외부: plugins/<name>/<sha12>/ 에 완전히 물질화한 뒤에야 옛 sha 를 지운다(1단계).
            # 디렉토리 이름에는 sha 앞 12자만 쓴다(Windows MAX_PATH 에 28자 여유를 번다,
            # fix round 2) - 12자는 이 용도로 충돌 걱정 없이 유일하다. 원장/레지스트리에는
            # 항상 spec["sha"](또는 materialize 가 돌려준 전체 sha)를 그대로 저장한다 -
            # 식별/비교/원장 참조는 전체 sha 에 의존하므로 여기서 자르면 안 된다.
            sha_tag = spec["sha"][:12] if spec["sha"] else "head"
            staging = os.path.join(plugins_dir, canon, sha_tag)
            sha = remote_fetch.materialize(
                staging, spec["url"], ref=spec["ref"], sha=spec["sha"],
                sparse=[spec["path"]] if spec["path"] else None)
            root = os.path.join(staging, *spec["path"].split("/")) if spec["path"] else staging
            sparse = None
    except remote_fetch.GitError as e:
        print(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False)); return

    # materialize 가 성공을 보고해도(git rc=0, 예외 없음) 결과 디렉토리가 실제로 없을 수 있다 -
    # 실측: Windows MAX_PATH(약 260자) 를 넘는 경로는 git 이 파일을 못 쓰는데도 조용히 넘어가고,
    # 이후 os.path.isdir/os.walk 는 예외 대신 False/빈 결과를 낸다. 그 상태로 원장에 쓰면
    # "가져옴: 성공, 컴포넌트 0개" 라는 거짓 성공이 나간다(fix round 2 finding) - 등록(원장 쓰기)
    # 전에 여기서 반드시 확인한다. 번들/외부 두 경로 모두 이 한 지점에서 걸러진다.
    if not os.path.isdir(root):
        length = len(root)
        hint = ""
        if os.name == "nt" and length >= 200:
            hint = (" Windows 경로 길이 제한(MAX_PATH≈260자)을 넘었을 가능성이 높습니다 - "
                    "CLAUDE_SNAPSHOT_STORE 를 더 짧은 경로로 재설정한 뒤 다시 시도하세요.")
        msg = f"플러그인 캐시 디렉토리를 찾을 수 없음(길이 {length}자): {root}.{hint}"
        print(json.dumps({"ok": False, "message": msg, "root": root, "root_length": length},
                         ensure_ascii=False)); return

    layout = remote_fetch.detect_layout(root)
    # staging 을 rec 에 그대로 들고 있는다 - source.path 가 다단(예: "plugins/sub")이면
    # os.path.dirname(root) 로 스테이징 루트를 역산하는 건 한 단계 안쪽을 지워 옛 sha 디렉토리
    # 자체가 살아남는다(git-subdir 가 80/278 로 흔한 종류라 실사용에서 매번 재현된다).
    rec = {"name": canon, "sha": sha, "fetched_at": _now(), "cache": root, "staging": staging,
           "map": layout["map"] or None, "sparse": sparse, "kind": spec["kind"]}
    try:
        cfg = lib_store.load_cfg(a.store)      # 다시 읽는다(위에서 시간이 흘렀다)
        m2 = next(x for x in cfg["marketplaces"] if x.get("id") == mid)
        pl = m2.setdefault("plugins", [])
        if prev and prev in pl:
            pl[pl.index(prev)] = rec
        else:
            pl.append(rec)
        lib_store.save_cfg(a.store, cfg)       # 3단계: 원장/레지스트리 갱신
    except lib_store.StoreNotInitialized as e:
        print(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False)); return

    # 4단계: 등록이 성공한 뒤에만 옛 sha 스테이징 디렉토리를 지운다.
    # 여기 도달하기 전에 실패하면 옛 설치가 계속 동작한다 - 그것이 sha 층을 두는 이유다.
    # old_staging 이 없으면(번들이었거나 첫 fetch) 지울 전용 디렉토리가 없다는 뜻이니 건드리지 않는다.
    if old_staging and lib_store.norm(old_staging) != lib_store.norm(staging or "") and \
       not lib_store.ledger_refs_root(cfg, old_root):
        _rmtree_force(old_staging)

    comp = _count_components(root, layout["map"])
    warning = None
    if comp["failed"]:
        # fetch 자체는 성공이다(파일은 디스크에 있고 등록도 유효하다) - ok:true 를 유지하되,
        # "성공 + 0개" 로는 못 읽게 경고를 명시적으로 붙인다(fix round 3). cmd_scan 이 이미
        # 쓰는 것과 같은 근거(경로 길이 / CLAUDE_SNAPSHOT_STORE)를 재사용한다.
        length = len(root)
        hint = ""
        if os.name == "nt" and length >= 200:
            hint = (" Windows 경로 길이 제한(MAX_PATH≈260자)을 넘었을 가능성이 높습니다 - "
                    "CLAUDE_SNAPSHOT_STORE 를 더 짧은 경로로 재설정한 뒤 다시 시도하세요.")
        cats = ", ".join(sorted(comp["failed"]))
        warning = f"다음 카테고리는 나열하지 못해 개수를 알 수 없음(0개가 아님): {cats}.{hint}"
    print(json.dumps({"ok": True, "origin": f"market:{mid}/{canon}", "plugin": canon,
                      "cache": root, "sha": sha, "components": comp["counts"],
                      "components_failed": comp["failed"],
                      "has_hooks": os.path.exists(os.path.join(root, "hooks", "hooks.json")),
                      "has_mcp": plugin_units.has_mcp(root),
                      "message": f"가져옴: {canon}", "warning": warning}, ensure_ascii=False))


def cmd_fetch(a):
    """등록된 remote/market 을 명시적으로 갱신한다. 자동 pull 은 없다 -
    hooks 라면 매 세션 실행되는 코드가 조용히 바뀌는 것이므로 사용자가 눌러야 한다.

    remotes[]/marketplaces[] 가 별도 배열이고 id 를 레포명에서 파생하므로 둘 다 'my-tools' 일 수 있다.
    그래서 접두 붙은 origin 형식으로 받는다."""
    origin = a.origin or ""
    cfg = lib_store.load_cfg(a.store)
    if origin.startswith("remote:"):
        rid = origin[len("remote:"):]
        r = next((x for x in cfg.get("remotes", []) if x.get("id") == rid), None)
        if not r:
            print(json.dumps({"ok": False, "message": f"등록되지 않은 원격: {rid}"}, ensure_ascii=False)); return
        try:
            sha = remote_fetch.materialize(r["cache"], r["url"], ref=r.get("ref") or None)
        except remote_fetch.GitError as e:
            print(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False)); return
        r["sha"], r["fetched_at"] = sha, _now()
        r["map"] = remote_fetch.detect_layout(r["cache"])["map"] or r.get("map")
        lib_store.save_cfg(a.store, cfg)
        print(json.dumps({"ok": True, "origin": origin, "sha": sha, "message": f"갱신됨: {rid}"},
                         ensure_ascii=False)); return
    if origin.startswith("market:"):
        rest = origin[len("market:"):]
        mid, _, pname = rest.partition("/")
        if pname:
            a.marketplace, a.plugin = mid, pname
            return cmd_plugin_fetch(a)          # 플러그인 갱신 = 재-fetch(원자적 교체 포함)
        m = next((x for x in cfg.get("marketplaces", []) if x.get("id") == mid), None)
        if not m:
            print(json.dumps({"ok": False, "message": f"등록되지 않은 마켓: {mid}"}, ensure_ascii=False)); return
        a.url, a.ref, a.id = m["url"], m.get("ref"), mid
        # 매니페스트만 다시 받는다(플러그인은 보존). kind 별로 하는 일이 다르다:
        #   git/json  - 원격에서 다시 받는다.
        #   local     - 받을 원격이 없다. 그래도 no-op 으로 두지 않고 디스크에서 매니페스트를
        #               다시 읽는다: 사용자가 그 파일을 직접 고치는 게 로컬 마켓의 갱신이므로,
        #               다시 읽어야 카탈로그와 sha(내용 해시)가 실제 내용과 맞는다. 버튼이
        #               아무 일도 안 하는 것처럼 보이는 게 조용한 실패다.
        return cmd_market_add(a)
    print(json.dumps({"ok": False, "message": f"origin 형식이 아님(remote:<id> / market:<id>[/<plugin>]): {origin}"},
                     ensure_ascii=False))


def _unit_name(origin):
    """origin -> hooks/mcp 원장 이름. 경로/설정을 읽지 않는 순수 문자열 파생이라
    scan 처럼 행마다 부르는 자리에서도 store 를 다시 읽지 않는다."""
    if origin.startswith("remote:"):
        return origin[len("remote:"):]
    if origin.startswith("market:"):
        mid, _, pname = origin[len("market:"):].partition("/")
        return pname or mid
    if origin.startswith("local:"):
        # 경로 전체를 쓴다. basename 으로 줄이면 라이브러리 루트가 대개 ".claude" 라
        # 등록된 로컬 라이브러리 둘이 같은 원장 칸을 쓰고 뒤에 설치한 쪽이 앞을 덮어써,
        # 앞 라이브러리의 hooks 를 대시보드에서 제거할 수 없게 된다.
        return origin[len("local:"):] or origin
    return origin


def _resolve_origin_root(store, origin):
    """origin -> (플러그인 루트 경로, 표시 이름). 미물질화면 (None, name)."""
    if origin.startswith("remote:"):
        rid = origin[len("remote:"):]
        cfg = lib_store.load_cfg(store)
        r = next((x for x in cfg.get("remotes", []) if x.get("id") == rid), None)
        return ((r or {}).get("cache"), rid)
    if origin.startswith("market:"):
        rest = origin[len("market:"):]
        mid, _, pname = rest.partition("/")
        cfg = lib_store.load_cfg(store)
        m = next((x for x in cfg.get("marketplaces", []) if x.get("id") == mid), None)
        if not m:
            return (None, pname or mid)
        p = next((x for x in m.get("plugins", []) if x.get("name") == pname), None)
        return ((p or {}).get("cache"), pname)
    if origin.startswith("local:"):
        # 로컬 라이브러리도 hooks/hooks.json / .mcp.json 을 가질 수 있다. origin 이 곧 경로라
        # 물질화 여부를 물을 것도 없다 - 호출부가 isdir 로 존재만 확인한다.
        p = origin[len("local:"):]
        return (p, _unit_name(origin))
    return (None, origin)


def _safe_target_dir(d):
    """--target 검증: .claude 루트만 허용(도구 파라미터 targetDir 의 계약 그대로).
    install 은 <target>/<category>/<name> 에 라이브러리 내용을 쓰는데, cmd_install 의 부모 존재
    검사(phantom 방지)는 '존재하는 아무 디렉토리'를 다 통과시킨다 - 그 경로로 임의 위치에
    파일을 심을 수 있다. UI 도 basename 이 .claude 인 후보만 대상 목록에 올린다(tracked.ts)."""
    n = os.path.normpath(d)
    if os.path.normcase(os.path.basename(n)) != os.path.normcase(".claude"):
        out(False, f"설치 대상이 유효하지 않음(<...>/.claude 형태만 허용): '{d}'")
    return n


def _settings_path(a):
    # --settings 와 --target 은 둘 다 도구 파라미터로 노출돼 있고 여기서 합류한다. 검증을
    # 합류 지점에 두어야 --target 이 '--settings 를 다른 이름으로 넘기는 통로'가 되지 않는다.
    return _safe_settings_path(a.settings or os.path.join(a.target, "settings.json"))


def cmd_hooks_install(a):
    """플러그인의 hooks 를 settings.json 에 병합한다. **네트워크를 타지 않는다.**

    미물질화 플러그인이면 암묵적으로 받아오지 않고 거부한다 -
    fetch 는 항상 사용자가 명시적으로 누른 결과여야 한다."""
    root, name = _resolve_origin_root(a.store, a.origin)
    if not root or not os.path.isdir(root):
        print(json.dumps({"ok": False, "message": f"아직 가져오지 않은 항목입니다 - fetch 먼저 실행하세요: {a.origin}"},
                         ensure_ascii=False)); return
    hooks_cfg = plugin_units.load_hooks_json(root)
    if not hooks_cfg:
        print(json.dumps({"ok": False, "message": f"hooks/hooks.json 이 없습니다: {a.origin}"},
                         ensure_ascii=False)); return

    warns = plugin_units.interpreter_warnings(hooks_cfg)
    commands = plugin_units.hook_commands(plugin_units.substitute(hooks_cfg, root))
    if a.dry_run:
        # 치환된 명령 원문을 그대로 보여준다. 설치 = 매 세션 임의 코드 실행이므로 별도 확인 단계다.
        print(json.dumps({"ok": True, "dry_run": True, "origin": a.origin, "root": root,
                          "commands": commands, "warnings": warns,
                          "events": sorted((hooks_cfg.get("hooks") or {}).keys())},
                         ensure_ascii=False)); return

    sp = _settings_path(a)
    cfg = lib_store.load_cfg(a.store)
    prev = lib_store.ledger_get(cfg, a.target, "hooks", name) or {}
    old_root = prev.get("root")          # needle 은 원장의 root 이지 현재 캐시 경로가 아니다

    s = load(sp)
    s, removed, added = plugin_units.hooks_merge(s, hooks_cfg, root, old_root)
    if not a.no_snapshot:
        snapshot_before(a.store)
    bak = backup(sp)
    save_atomic(sp, s)

    warn = None
    try:
        cfg = lib_store.load_cfg(a.store)
        lib_store.ledger_put(cfg, a.target, "hooks", name, {
            "kind": "hooks", "origin": a.origin, "root": root,
            "events": sorted((hooks_cfg.get("hooks") or {}).keys()),
            "src_hash": _hash_file(os.path.join(root, plugin_units.HOOKS_REL)), "at": _now(),
        })
        lib_store.save_cfg(a.store, cfg)
    except lib_store.StoreNotInitialized:
        warn = "스토어 미초기화로 출처를 기록하지 못했습니다 - 제거 시 --root 로 경로를 직접 지정해야 합니다"

    print(json.dumps({"ok": True, "origin": a.origin, "root": root, "settings": sp,
                      "removed": removed, "added": added, "backup": bak,
                      "warnings": warns, "warning": warn,
                      "message": f"hooks 설치됨: {name} ({added}건)"}, ensure_ascii=False))


def _hooks_remove_all(settings, root, hooks_cfg):
    """settings 에서 이 플러그인의 hook 엔트리를 제거한다 - root 매칭 + (있으면) 구조적 동일성,
    hooks_merge 가 삽입 중복을 막는 두 메커니즘을 그대로 대칭 적용한다.

    root 매칭만으로는 ${CLAUDE_PLUGIN_ROOT} 를 전혀 안 쓰는 hook(전역 도구를 직접 부르는
    유효한 hooks.json)을 못 찾는다 - 그런 엔트리는 설치 때 identity 매칭으로 들어갔으므로
    제거도 identity 매칭이어야 대칭이다. hooks_cfg 가 None 이면(캐시가 이미 사라졌거나
    hooks.json 을 못 읽음) root 매칭만 수행한다 - 호출부가 이 축소된 결과를 degraded 로 알린다.
    (settings, 제거수) 반환."""
    settings, removed = plugin_units.hooks_remove(settings, root)
    if not hooks_cfg:
        return settings, removed
    subbed = plugin_units.substitute(hooks_cfg, root)
    hooks = settings.get("hooks") or {}
    for event, entries in (subbed.get("hooks") or {}).items():
        entries = entries or []
        if not entries or event not in hooks:
            continue
        existing = hooks[event]
        keep = [e for e in existing if e not in entries]   # 사용자 hook 은 이 필터에 안 걸린다
        removed += len(existing) - len(keep)
        if keep:
            hooks[event] = keep
        else:
            del hooks[event]                                 # 빈 배열을 남기지 않는다
    if hooks:
        settings["hooks"] = hooks
    else:
        settings.pop("hooks", None)
    return settings, removed


def cmd_hooks_uninstall(a):
    """settings.json 에서 이 플러그인의 hook 엔트리를 걷어낸다. 캐시는 지우지 않는다.

    구조적 동일성 판정에는 그 플러그인의 hooks.json 이 다시 필요하다 - 원장의 root 는
    캐시가 아직 살아있다는 보장이다(unregister 가 원장이 참조하는 캐시를 지우지 못하게 막는다).
    사용자가 도구 밖에서 캐시를 직접 지웠다면 그 보장이 깨지므로 root 매칭만으로 폴백하고,
    무엇을 못 했는지 결과에 명시한다(조용히 덜 하지 않는다)."""
    cfg = lib_store.load_cfg(a.store)
    _, name = _resolve_origin_root(a.store, a.origin)
    rec = lib_store.ledger_get(cfg, a.target, "hooks", name) or {}
    root = rec.get("root") or _resolve_origin_root(a.store, a.origin)[0]
    if not root:
        print(json.dumps({"ok": True, "message": "설치 기록이 없습니다 (no-op)", "changed": False},
                         ensure_ascii=False)); return
    cache_present = os.path.isdir(root)
    hooks_cfg = plugin_units.load_hooks_json(root) if cache_present else None
    sp = _settings_path(a)
    s = load(sp)
    s, removed = _hooks_remove_all(s, root, hooks_cfg)
    if removed:
        if not a.no_snapshot:
            snapshot_before(a.store)
        backup(sp)
        save_atomic(sp, s)
    try:
        lib_store.ledger_del(cfg, a.target, "hooks", name)
        lib_store.save_cfg(a.store, cfg)
    except lib_store.StoreNotInitialized:
        pass
    degraded = not cache_present
    warn = ("플러그인 캐시가 이미 사라져 경로 매칭 hook만 제거했습니다 - 플러그인 루트를 "
            "참조하지 않는(전역 도구를 직접 호출하는) hook 이 남아 있을 수 있습니다") if degraded else None
    print(json.dumps({"ok": True, "origin": a.origin, "removed": removed, "changed": bool(removed),
                      "degraded": degraded, "warning": warn,
                      "message": f"hooks 제거됨: {name} ({removed}건)"}, ensure_ascii=False))


def _mcp_target(a):
    """scope -> 대상 파일. config_edit.main() 의 선택 로직과 같은 기준.
    desktop 이 실질 가치다 - Claude Desktop 에는 /plugin 마켓플레이스가 없다."""
    return a.desktop_config if a.scope == "desktop" else a.claude_json


def cmd_mcp_install(a):
    """플러그인의 .mcp.json 서버를 ~/.claude.json 또는 Desktop config 에 넣는다.
    **네트워크를 타지 않는다.** 미물질화면 거부한다."""
    root, name = _resolve_origin_root(a.store, a.origin)
    if not root or not os.path.isdir(root):
        print(json.dumps({"ok": False, "message": f"아직 가져오지 않은 항목입니다 - fetch 먼저 실행하세요: {a.origin}"},
                         ensure_ascii=False)); return
    mcp = plugin_units.load_mcp_json(root)
    servers = (mcp or {}).get("mcpServers") or {}
    if a.server:
        if a.server not in servers:
            print(json.dumps({"ok": False, "message": f"해당 서버가 없습니다: {a.server}",
                              "available": sorted(servers)}, ensure_ascii=False)); return
        servers = {a.server: servers[a.server]}
    if not servers:
        print(json.dumps({"ok": False, "message": f"MCP 서버 선언이 없습니다(.mcp.json / plugin.json): {a.origin}"},
                         ensure_ascii=False)); return
    servers = plugin_units.substitute(servers, root)

    tgt = _mcp_target(a)
    if a.dry_run:
        print(json.dumps({"ok": True, "dry_run": True, "origin": a.origin, "root": root,
                          "target": tgt, "servers": sorted(servers),
                          "detail": servers}, ensure_ascii=False)); return

    d = load(tgt)
    for sname, sconf in servers.items():
        d, _msg, _ch = op_mcp_add(d, sname, sconf)
    if not a.no_snapshot:
        snapshot_before(a.store)
    bak = backup(tgt)
    save_atomic(tgt, d)

    warn = None
    try:
        cfg = lib_store.load_cfg(a.store)
        prev = lib_store.ledger_get(cfg, a.target, "mcp", name) or {}
        merged = sorted(set(prev.get("servers", [])) | set(servers))
        lib_store.ledger_put(cfg, a.target, "mcp", name, {
            "kind": "mcp", "origin": a.origin, "root": root, "scope": a.scope,
            "target": tgt, "servers": merged, "at": _now(),
        })
        lib_store.save_cfg(a.store, cfg)
    except lib_store.StoreNotInitialized:
        warn = "스토어 미초기화로 출처를 기록하지 못했습니다(설치 자체는 완료)"
    print(json.dumps({"ok": True, "origin": a.origin, "target": tgt, "backup": bak,
                      "servers": sorted(servers), "warning": warn,
                      "message": f"MCP 서버 설치됨: {name} ({len(servers)}개, scope={a.scope})"},
                     ensure_ascii=False))


def cmd_mcp_uninstall(a):
    """원장에 기록된 서버 이름만 지운다. 사용자가 직접 넣은 서버는 건드리지 않는다."""
    cfg = lib_store.load_cfg(a.store)
    _, name = _resolve_origin_root(a.store, a.origin)
    rec = lib_store.ledger_get(cfg, a.target, "mcp", name) or {}
    names = [a.server] if a.server else rec.get("servers", [])
    tgt = rec.get("target") or _mcp_target(a)
    if not names:
        print(json.dumps({"ok": True, "message": "설치 기록이 없습니다 (no-op)", "changed": False},
                         ensure_ascii=False)); return
    d = load(tgt)
    removed = 0
    for sname in names:
        d, _msg, ch = op_mcp_remove(d, sname)
        removed += 1 if ch else 0
    if removed:
        if not a.no_snapshot:
            snapshot_before(a.store)
        backup(tgt)
        save_atomic(tgt, d)
    try:
        if a.server and rec.get("servers"):
            rec["servers"] = [s for s in rec["servers"] if s != a.server]
            if rec["servers"]:
                lib_store.ledger_put(cfg, a.target, "mcp", name, rec)
            else:
                lib_store.ledger_del(cfg, a.target, "mcp", name)
        else:
            lib_store.ledger_del(cfg, a.target, "mcp", name)
        lib_store.save_cfg(a.store, cfg)
    except lib_store.StoreNotInitialized:
        pass
    print(json.dumps({"ok": True, "origin": a.origin, "target": tgt, "removed": removed,
                      "changed": bool(removed),
                      "message": f"MCP 서버 제거됨: {name} ({removed}개)"}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(prog="library")
    ap.add_argument("--store", default=DEFAULT_STORE)
    ap.add_argument("--target", default=DEFAULT_TARGET, help="설치 대상 루트(기본 ~/.claude)")
    ap.add_argument("--no-snapshot", action="store_true")
    ap.add_argument("--claude-json", default=DEFAULT_CLAUDE_JSON)
    ap.add_argument("--desktop-config", default=DEFAULT_DESKTOP_CONFIG)
    sub = ap.add_subparsers(dest="op", required=True)

    p = sub.add_parser("scan"); p.add_argument("--lib", default=None)
    p.set_defaults(func=cmd_scan)
    p = sub.add_parser("unregister"); p.add_argument("--lib", default=None)
    p.add_argument("--origin", default=None, help="remote:<id> / market:<id> 등록 해제")
    p.set_defaults(func=cmd_unregister)
    p = sub.add_parser("install"); p.add_argument("category", choices=list(CATEGORIES))
    p.add_argument("path", help="카테고리 루트 기준 상대경로(예: 2-stack/java-spring/error-handling). agents/commands 는 이름")
    p.add_argument("--lib", default=None)
    p.add_argument("--origin", default=None, help="출처 식별자(local:/remote:/market:). 캐시 다수일 때 필수")
    p.set_defaults(func=cmd_install)
    p = sub.add_parser("uninstall"); p.add_argument("category", choices=list(CATEGORIES))
    p.add_argument("name")
    p.add_argument("--origin", default=None, help="요청 출처. 원장의 소유자와 다르면 거부")
    p.set_defaults(func=cmd_uninstall)
    p = sub.add_parser("remote-add")
    p.add_argument("--url", required=True); p.add_argument("--ref", default=None)
    p.add_argument("--id", default=None); p.add_argument("--map", default=None,
                   help='카테고리 매핑 JSON, 예: {"agents":"Agents","skills":"Skills"}')
    p.set_defaults(func=cmd_remote_add)
    p = sub.add_parser("market-add")
    p.add_argument("--url", required=True,
                   help="마켓 소스 4형식: owner/repo · git URL(https/ssh/scp) · "
                        "https://.../marketplace.json · 로컬 경로(./x, /abs, C:\\abs)")
    p.add_argument("--ref", default=None, help="git 마켓에서만 의미가 있다")
    p.add_argument("--id", default=None)
    p.set_defaults(func=cmd_market_add)
    p = sub.add_parser("market-discover")
    p.add_argument("--plugins-dir", default=None, help="기본 ~/.claude/plugins")
    p.set_defaults(func=cmd_market_discover)
    p = sub.add_parser("catalog")
    p.add_argument("--marketplace", default=None); p.add_argument("--query", default=None)
    p.add_argument("--category", default=None)
    p.add_argument("--limit", type=int, default=50); p.add_argument("--offset", type=int, default=0)
    p.set_defaults(func=cmd_catalog)
    p = sub.add_parser("plugin-fetch")
    p.add_argument("--marketplace", required=True); p.add_argument("--plugin", required=True)
    p.set_defaults(func=cmd_plugin_fetch)
    p = sub.add_parser("fetch"); p.add_argument("--origin", required=True)
    p.set_defaults(func=cmd_fetch)
    p = sub.add_parser("hooks-install"); p.add_argument("--origin", required=True)
    p.add_argument("--settings", default=None, help="대상 settings.json(기본 <target>/settings.json)")
    p.add_argument("--dry-run", action="store_true", help="쓰지 않고 치환된 명령·경고만 반환")
    p.set_defaults(func=cmd_hooks_install)
    p = sub.add_parser("hooks-uninstall"); p.add_argument("--origin", required=True)
    p.add_argument("--settings", default=None)
    p.set_defaults(func=cmd_hooks_uninstall)
    p = sub.add_parser("mcp-install"); p.add_argument("--origin", required=True)
    p.add_argument("--server", default=None); p.add_argument("--dry-run", action="store_true")
    p.add_argument("--scope", choices=["user", "desktop"], default="user")
    p.set_defaults(func=cmd_mcp_install)
    p = sub.add_parser("mcp-uninstall"); p.add_argument("--origin", required=True)
    p.add_argument("--server", default=None)
    p.add_argument("--scope", choices=["user", "desktop"], default="user")
    p.set_defaults(func=cmd_mcp_uninstall)

    a = ap.parse_args()
    a.target = _safe_target_dir(a.target)
    a.func(a)


if __name__ == "__main__":
    main()
