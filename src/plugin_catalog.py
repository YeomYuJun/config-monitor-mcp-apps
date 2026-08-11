#!/usr/bin/env python3
r"""plugin_catalog.py - Claude Code 플러그인 카탈로그 캐시 조회(읽기 전용).

plugin_state.py 는 "내가 설치한 것"을 읽는다. 이 모듈은 그 반대편, "공식 마켓에 무엇이
있는가"를 읽는다. Claude Code 가 `~/.claude/plugins/plugin-catalog-cache.json` 에 인벤토리
전체(실측 255개)를 캐시해 두는데, 여기에 설치 수/컴포넌트 구성/토큰 비용처럼 매니페스트에는
없는 값이 들어 있다. 카탈로그 행을 이 값으로 enrich 하면 "설치하기 전에 얼마나 무거운지"를
보여줄 수 있다.

순수 리더다: 네트워크도, git 도, subprocess 도 없다(plugin_state.py / plugin_units.py 와 같은
규율). 캐시를 갱신하지 않는다 - 갱신은 Claude Code 가 자기 주기로 한다. 파일이 없으면 그건
오류가 아니라 "아직 한 번도 안 받았다"이고, ok=False 로 그대로 드러낸다.

다른 config-monitor 모듈을 import 하지 않는다(표준 라이브러리만). plugin_state.split_id 가
바로 옆에 있지만 가져오지 않는다 - 이 모듈을 독립적으로 유지하는 값이 중복 3줄보다 크다.

## 함정 1: components 의 값이 두 형태다

실측 2340개 항목 중 2062개가 `{"name": ..., "chars": {...}}` dict 이고 278개가 그냥 문자열이다.
지금은 종류별로 갈리지만(skills/commands/agents 는 dict, hooks/mcpServers/lspServers 는 문자열)
**종류로 형태를 가정하지 않는다** - 카탈로그가 형태를 바꾸면 그 가정이 조용히 깨진다.
정규화를 빠뜨리면 UI 에 `[object Object]` 가 뜬다. 이름을 못 뽑은 항목은 아예 담지 않는다:
None 을 끼워 넣으면 같은 증상이 이름만 바꿔 재발한다.

## 함정 2: 공식 마켓 전용 데이터다

키는 `<plugin>@<marketplace>` 인데 실측 255개가 전부 `@claude-plugins-official` 이다.
다른 마켓에서 설치한 플러그인은 여기서 조회되지 않으며 **그건 오류가 아니다.** 호출부는
details() 가 None 을 돌려주는 것을 정상 경로로 다뤄야 한다.
"""
from __future__ import annotations
import argparse, json, os, sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

HOME = os.path.expanduser("~")
DEFAULT_CACHE = os.path.join(HOME, ".claude", "plugins", "plugin-catalog-cache.json")


# --- 읽기 --------------------------------------------------------------------

def _read(path):
    """캐시 파일 -> dict. 실패는 None 이고 예외로 만들지 않는다.

    utf-8-sig 로 여는 이유: BOM 이 붙은 JSON 을 utf-8 로 읽으면 json.load 가 ValueError 를
    낸다(cas 의 watcher.json 에서 이미 겪었다). BOM 이 없으면 utf-8 과 동작이 같다."""
    try:
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


# --- 정규화 ------------------------------------------------------------------

def _names(value) -> list:
    """컴포넌트 목록을 이름 문자열 배열로. 문자열 항목과 dict 항목을 모두 받는다(함정 1)."""
    out = []
    for it in (value if isinstance(value, list) else []):
        if isinstance(it, str):
            name = it
        elif isinstance(it, dict):
            name = it.get("name")
        else:
            continue
        if isinstance(name, str) and name:
            out.append(name)
    return out


def _components(rec) -> dict:
    """components 를 {kind: [이름]} 으로. 종류 목록을 하드코딩하지 않고 파일이 준 키를
    그대로 쓴다 - 카탈로그에 새 종류가 생겨도 코드를 안 고치고 따라간다."""
    src = rec.get("components")
    if not isinstance(src, dict):
        return {}
    return {k: _names(v) for k, v in src.items() if isinstance(k, str)}


def _author(value) -> str:
    """author 는 {"name", "email"} dict 이거나 아예 없다(실측 170 / 85). 문자열로 주는
    마켓도 있을 수 있어 둘 다 받는다. 없으면 빈 문자열 - None 을 그대로 흘리면 UI 가
    "None" 이라는 저자 이름을 찍는다."""
    if isinstance(value, dict):
        name = value.get("name")
        return name if isinstance(name, str) else ""
    return value if isinstance(value, str) else ""


def _opt_str(value):
    """version / sha 계열은 없으면 None 으로 남긴다(빈 문자열로 접지 않는다).

    실측 255개 중 51개가 sha=null 이고 version 도 최상위가 null 인 경우가 흔하다. author 나
    description 처럼 UI 가 그대로 렌더하는 텍스트가 아니라 "값이 있을 때만 표시"하는
    식별자라, installs 와 같은 이유로 부재를 None 으로 드러낸다."""
    return value if isinstance(value, str) and value else None


def _split_id(entry_id: str):
    """'code-review@claude-plugins-official' -> ('code-review', 'claude-plugins-official').
    마지막 '@' 로 자른다(plugin_state.split_id 와 같은 규칙 - 마켓 이름 쪽에 '@' 가 없다)."""
    if "@" in entry_id:
        name, market = entry_id.rsplit("@", 1)
        return name, market
    return entry_id, ""


def _record(entry_id: str, rec: dict) -> dict:
    """카탈로그 엔트리 하나를 정규화 레코드로."""
    name, market = _split_id(entry_id)
    me = rec.get("marketplace_entry")
    me = me if isinstance(me, dict) else {}
    comps = _components(rec)
    counts = {k: len(v) for k, v in comps.items() if v}   # 0 인 종류는 뺀다(카드가 지저분해진다)
    installs = rec.get("unique_installs")
    tokens = rec.get("tokens")
    return {
        "id": entry_id,
        "name": rec.get("plugin") or name,
        "marketplace": market,
        "description": me.get("description") or "",
        "author": _author(me.get("author")),
        "homepage": me.get("homepage") or "",
        "category": me.get("category") or "",
        # 실측 255개 중 2개가 unique_installs 를 안 갖는다. 0 으로 접으면 "아무도 안 쓰는
        # 플러그인"으로 잘못 보이므로 None(=모름)과 0(=실제로 0)을 구분해서 남긴다.
        "installs": installs if isinstance(installs, int) and not isinstance(installs, bool) else None,
        "last_updated": rec.get("last_updated") or "",
        # 버전이 두 곳에 있고 둘 다 비는 경우가 있다(실측: 최상위 None 이면서 marketplace_entry
        # 쪽에만 있는 엔트리가 존재). 설치 원장에 가까운 최상위를 먼저 본다.
        "version": _opt_str(rec.get("version")) or _opt_str(me.get("version")),
        "sha": _opt_str(rec.get("sha")),
        "source_sha": _opt_str(rec.get("source_sha")),
        "components": comps,
        "counts": counts,
        "total": sum(counts.values()),
        "tokens": tokens if isinstance(tokens, dict) else {},
    }


# --- 공개 API ----------------------------------------------------------------

def load(path=None) -> dict:
    """캐시 전체를 정규화해서 읽는다. 예외를 던지지 않는다.

    ok 는 "엔트리가 있느냐"가 아니라 "읽어서 catalog.plugins 까지 도달했느냐"다.
    파일 없음 / 깨진 JSON / catalog 키 없음이 전부 ok=False + entries={} 로 수렴한다 -
    호출부(scan 경로)는 카탈로그가 없어도 계속 돌아야 한다."""
    path = path or DEFAULT_CACHE
    raw = _read(path)
    cat = (raw or {}).get("catalog")
    cat = cat if isinstance(cat, dict) else {}
    plugins = cat.get("plugins")
    ok = isinstance(plugins, dict)

    entries = {}
    if ok:
        for pid, rec in plugins.items():
            if isinstance(pid, str) and isinstance(rec, dict):
                entries[pid] = _record(pid, rec)

    models = cat.get("models")
    return {
        "ok": ok,
        "path": path,
        # fetchedAt 은 최상위(Claude Code 가 언제 받았나), generated_at 계열은 catalog 안
        # (서버가 언제 만들었나)이다. 섞으면 "방금 받았는데 데이터가 오래됨"을 설명 못 한다.
        "fetched_at": (raw or {}).get("fetchedAt") or "",
        "generated_at": cat.get("generated_at") or "",
        "installs_at": cat.get("installs_generated_at") or "",
        "models": [m for m in (models if isinstance(models, list) else []) if isinstance(m, str)],
        "entries": entries,
    }


def details(entry_id, path=None):
    """한 플러그인의 정규화 레코드. 없으면 None.

    다른 마켓의 플러그인이거나 캐시가 아직 없으면 None 이 정상 결과다(함정 2)."""
    return load(path)["entries"].get(entry_id)


def _light(entries: dict) -> dict:
    """이미 읽은 entries 를 경량 맵으로. load() 를 다시 타지 않게 분리해 뒀다 -
    CLI 는 메타데이터 때문에 load() 결과를 이미 손에 들고 있는데, 거기서 summary() 를
    부르면 400KB 파일을 한 번 더 파싱한다(UI 가 목록을 그릴 때마다 타는 경로다)."""
    return {pid: {"installs": rec["installs"],
                  "components": dict(rec["counts"]),   # 복사본 - 호출부 변형이 새지 않게
                  "total": rec["total"]}
            for pid, rec in entries.items()}


def summary(path=None) -> dict:
    """카탈로그 행 enrich 용 경량 맵 -> {id: {installs, components: {kind: 개수}, total}}.

    **이름 배열을 담지 않는다.** 255개 x 컴포넌트 이름 전부(실측 2340개 문자열)를 UI 로
    보내면 목록 한 번 그리는 데 카탈로그 본문보다 큰 페이로드가 붙는다. 이름이 필요한
    시점은 카드 하나를 펼칠 때뿐이고 그건 details() 가 판다."""
    return _light(load(path)["entries"])


# --- CLI ---------------------------------------------------------------------

def out(ok, **extra):
    """JSON 한 줄. **실패해도 종료코드는 0 이다.**

    형제 CLI(plugin_cli / config_edit)는 실패에 1 을 쓰지만 여기는 조회 전용이고, 캐시가
    아직 없는 것은 정상 상태다. 0 이 아니면 호출부(UI)가 조회 실패를 치명적 오류로 다뤄
    카탈로그 화면 전체가 빈 채로 뜬다. 실패 여부는 ok 로만 전달한다."""
    print(json.dumps({"ok": ok, **extra}, ensure_ascii=False))
    sys.exit(0)


def main():
    ap = argparse.ArgumentParser(prog="plugin_catalog",
                                 description="플러그인 카탈로그 캐시 조회(읽기 전용)")
    # --cache 를 서브커맨드 앞/뒤 어디에 써도 받는다. 서브파서 쪽 기본값을 SUPPRESS 로 둬야
    # 앞에 준 값이 뒤의 기본값 None 에 덮이지 않는다.
    ap.add_argument("--cache", default=None, help="캐시 파일 경로(기본: ~/.claude/plugins/plugin-catalog-cache.json)")
    sub = ap.add_subparsers(dest="op", required=True)
    for name in ("summary", "details"):
        p = sub.add_parser(name)
        p.add_argument("--cache", default=argparse.SUPPRESS)
        if name == "details":
            p.add_argument("id")
    a = ap.parse_args()

    cat = load(a.cache)
    broken = f"카탈로그 캐시를 읽을 수 없습니다: {cat['path']}"

    # 두 서브커맨드의 키 이름은 호출부(TypeScript UI)가 그대로 읽는 계약이다. 이름을 바꾸면
    # 화면이 조용히 빈 채로 뜬다(테스트가 키 집합을 고정한다).
    if a.op == "summary":
        # 실패해도 entries 를 빼지 않는다 - 없으면 호출부가 undefined 를 순회한다.
        if not cat["ok"]:
            out(False, entries={}, message=broken, fetched_at="", generated_at="",
                installs_at="", models=[])
        out(True, entries=_light(cat["entries"]), fetched_at=cat["fetched_at"],
            generated_at=cat["generated_at"], installs_at=cat["installs_at"],
            models=cat["models"])

    rec = cat["entries"].get(a.id)
    if rec is None:
        # 다른 마켓 플러그인이면 캐시에 없는 게 정상이다(모듈 docstring 함정 2). 그래도
        # ok=False 로 보고하고, 무엇을 찾다 못 찾았는지 id 를 그대로 되돌려준다.
        out(False, id=a.id,
            message=broken if not cat["ok"] else
            f"카탈로그에 없는 플러그인: {a.id} (공식 마켓 외 플러그인은 캐시되지 않습니다)")
    # 레코드를 top level 로 편다(중첩 금지) - UI 가 필드 이름을 그대로 읽는다.
    out(True, **rec)


if __name__ == "__main__":
    main()
