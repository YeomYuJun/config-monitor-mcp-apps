#!/usr/bin/env python3
r"""lib_store.py - 라이브러리 스토어(store/config.json) 소유 모듈.

여기가 다루는 것:
  - libraries[]      기존 로컬 경로 배열(문자열 그대로 - 형태 변경 금지)
  - remotes[]        원격 git 레포 등록
  - marketplaces[]   마켓 레포 등록 + fetch 된 플러그인
  - installed{}      출처 원장. **키는 정규화된 타깃 루트**, 그 아래 "<category>/<name>".

원장 키 방향이 중요하다: origin 으로 키를 잡으면 두 플러그인의 skills/code-review 가
각자 원장을 가져 conflict 가 영원히 발동하지 않는다. 타깃 경로 하나당 원장 항목 하나.

네트워크도 git 도 여기 없다(scan 경로에서 import 되므로).
"""
from __future__ import annotations
import json, os


class StoreNotInitialized(Exception):
    """store/config.json 이 없어 영속화할 수 없음.

    기존 _register_lib 은 이 상황에서 조용히 False 를 반환했고 호출부가 그걸 무시해
    'UI 는 등록됐다고 말하는데 실제로는 안 된' 상태를 만들었다. 예외로 바꿔 호출부가
    ok:false 로 보고하게 강제한다."""


def store_config_path(store: str) -> str:
    return os.path.join(store, "config.json")


def norm(p: str) -> str:
    """경로 비교용 정규화(대소문자/구분자/./.. 흡수). library._norm 과 동일 규칙."""
    return os.path.normcase(os.path.normpath(p))


def load_cfg(store: str) -> dict:
    p = store_config_path(store)
    if not os.path.exists(p):
        return {}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def save_cfg(store: str, cfg: dict) -> None:
    """원자적 쓰기(.tmp -> os.replace). store 미초기화면 StoreNotInitialized."""
    p = store_config_path(store)
    if not os.path.exists(p):
        raise StoreNotInitialized(f"스토어가 초기화되지 않음: {p}")
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


# ── 출처 원장 ───────────────────────────────────────────────────────────────
# 구조: cfg["installed"][<정규화 타깃루트>]["<category>/<name>"] = {origin, src_hash, …}
# category 는 agents/skills/commands 외에 hooks/mcp 도 온다(설치 단위가 다르지만 소유권 모델은 같다).

def ledger_root_key(target_root: str) -> str:
    return norm(target_root)


def _rows(cfg: dict, target_root: str, create: bool):
    inst = cfg.setdefault("installed", {}) if create else cfg.get("installed", {})
    k = ledger_root_key(target_root)
    if create:
        return inst.setdefault(k, {})
    return inst.get(k, {})


def ledger_get(cfg: dict, target_root: str, category: str, name: str):
    return _rows(cfg, target_root, False).get(f"{category}/{name}")


def ledger_put(cfg: dict, target_root: str, category: str, name: str, rec: dict) -> None:
    _rows(cfg, target_root, True)[f"{category}/{name}"] = rec


def ledger_del(cfg: dict, target_root: str, category: str, name: str) -> None:
    _rows(cfg, target_root, False).pop(f"{category}/{name}", None)


def ledger_refs_root(cfg: dict, cache_root: str) -> list:
    """cache_root 를 rec["root"] 로 붙잡고 있는 원장 항목 전부(그 아래도 포함).

    equality 만 보면 안 된다: 번들(str-path) 플러그인의 root 는
    <market repo cache>/plugins/<name> 로 마켓 레포 캐시의 **하위**다.
    unregister --origin market:<id> 는 <store>/lib-cache/markets/<id>/ 전체를
    지우므로, 그 상위 캐시 자체가 아니라 하위 root 를 붙잡은 hooks/MCP 원장도
    찾아내야 가드가 뚫리지 않는다. 접두 비교는 구분자를 붙여서 해
    "...\\abc" 가 "...\\abcdef" 에 거짓 매치되지 않게 한다.

    unregister 가 캐시를 지워도 되는지 판단하는 유일한 근거다."""
    want = norm(cache_root)
    pref = want if want.endswith(os.sep) else want + os.sep
    hits = []
    for tgt, rows in (cfg.get("installed") or {}).items():
        for key, rec in rows.items():
            r = rec.get("root")
            if not r:
                continue
            n = norm(r)
            if n == want or n.startswith(pref):
                hits.append({"target": tgt, "key": key, "rec": rec})
    return hits
