#!/usr/bin/env python3
r"""marketplace.py - .claude-plugin/marketplace.json 카탈로그.

278개를 미리 받지 않는다: 매니페스트만 sparse checkout(401K) 하고 플러그인은 선택 시점에 받는다
(전체 체크아웃은 9.7M - 24배).

renames 는 **조회 해석 전용**이다. key=구 이름, value=신 이름(실측 검증).
origin 은 항상 현재 이름으로 정규화해 저장하고 별칭을 원장에 남기지 않는다.

순수 함수 모듈: 네트워크/git/subprocess 를 타지 않는다. remote_fetch/lib_store/library 를
import 하지 않는다 - 이미 받아둔 매니페스트 파일 위의 로직만 다룬다.
(예외 하나: classify_source 는 '존재하는 디렉토리인가'만 확인한다 - 로컬 경로 형식을
판별하려면 그 질문을 피할 수 없다. 읽기도 쓰기도 하지 않는다.)
"""
from __future__ import annotations
import json, os, re

MANIFEST_REL = os.path.join(".claude-plugin", "marketplace.json")

# Windows 예약 디바이스 이름(확장자·대소문자 무관) - 경로 이탈은 아니지만 그런 이름으로
# 파일/디렉토리를 만들 수 없어 기능적으로 깨진다(Finding 3).
_RESERVED_DEVICE_NAMES = {
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
}

# git 이 url 문자열 자체를 해석한다(subprocess 의 인자 리스트 격리가 안 통함) - 허용 스킴만
# 통과시킨다. scp 스타일(user@host:path)도 정상 git 문법이라 허용한다(Finding 2).
_ALLOWED_URL_SCHEMES = ("https://", "http://", "ssh://", "git://", "file://")
_SCP_STYLE_RE = re.compile(r"^[A-Za-z0-9_.~-]+@[A-Za-z0-9_.-]+:[A-Za-z0-9_./~-].*$")
# 전송 헬퍼 구문(예: ext::, foo::) - 문자열 맨 앞에서만 위험하다. 부분 문자열로 "::" 를
# 찾으면 IPv6 리터럴 URL(https://[::1]/r.git) 을 오탐하므로 앞에 anchor 한다.
_TRANSPORT_HELPER_RE = re.compile(r"^[A-Za-z0-9+.-]*::")
_HEX_RE = re.compile(r"^[0-9a-fA-F]+$")


# 마켓 소스 형식 판별용. Claude Code 의 Add Marketplace 가 받는 4형식 중 이 도구는 git
# 으로 clone 되는 둘(scp/전체 URL)만 받아왔다 - 나머지 둘(owner/repo 축약, marketplace.json
# 직접)과 로컬 경로를 여기서 판정한다. 판정만 하고 물질화는 호출부가 한다.
_LOCAL_PREFIXES = ("./", "../", ".\\", "..\\")
_DRIVE_ABS_RE = re.compile(r"^[A-Za-z]:[\\/]")   # os.path.isabs 는 OS 마다 답이 달라 판정이 흔들린다
_JSON_SCHEMES = ("http://", "https://")          # JSON 본문은 http(s) 로만 받는다
_GENERIC_JSON_STEMS = ("marketplace", "index")   # 파일명이 이거면 id 로 쓸 정보가 없다


class ManifestError(Exception):
    pass


def parse_manifest(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise ManifestError(f"매니페스트를 읽을 수 없음: {e}") from e
    plugins = raw.get("plugins")
    if not isinstance(plugins, list):
        raise ManifestError("매니페스트에 plugins 배열이 없습니다")
    by_name = {}
    for e in plugins:
        if not isinstance(e, dict) or not e.get("name"):
            continue
        name = e["name"]
        try:
            safe_segment(name, "플러그인 이름")
        except ManifestError:
            continue    # 이름 자체가 경로 이탈이면 조회 대상에서 제외 - 매니페스트 전체는 안 죽인다
        by_name[name] = e
    return {
        "name": raw.get("name") or "",
        "description": raw.get("description") or "",
        "owner": raw.get("owner"),
        "plugins": plugins,
        "renames": raw.get("renames") or {},
        "by_name": by_name,
    }


def resolve_plugin(mf: dict, name: str):
    """(entry, 정규 이름). renames 를 따라가되 순환/미도달은 (None, None).

    별칭은 결과에 남기지 않는다 - 호출부는 항상 정규 이름으로 origin 을 만든다.
    canonical 이름은 반환 직전 safe_segment 로 재검증한다: by_name 이 이미 안전한 이름만
    담고 있지만(위 parse_manifest), 이 함수는 그 불변식이 깨져도(호출부가 by_name 을
    직접 조립하는 테스트/미래 코드) 마지막 방어선이 되도록 한다 - cmd_plugin_fetch 가
    이 반환값으로 바로 os.path.join 하기 때문이다(Finding 1).
    cur 가 문자열이 아니면(예: renames 값이 dict 인 오염된 매니페스트) 즉시 포기한다 -
    dict.get() 에 unhashable 값을 넣으면 TypeError 로 죽는다."""
    seen = set()
    cur = name
    while isinstance(cur, str) and cur and cur not in seen:
        entry = mf["by_name"].get(cur)
        if entry:
            try:
                safe_segment(cur, "플러그인 이름")
            except ManifestError:
                return None, None
            return entry, cur
        seen.add(cur)
        cur = mf["renames"].get(cur)
    return None, None


def display_name(entry: dict) -> str:
    return entry.get("displayName") or entry.get("name") or ""


def safe_segment(s, what="이름"):
    """단일 경로 세그먼트 검증. _resolve_item 과 같은 규율:
    빈/./.. 금지(트레일링 dot/space 를 벗겨낸 뒤에도), 콜론 금지(드라이브 상대 'C:foo' 와
    NTFS ADS 'a:b'), 구분자 금지, Windows 예약 디바이스 이름(확장자·대소문자 무관) 금지.

    트레일링 dot/space 를 따로 가려내는 이유: os.path.normpath 가 이를 먹어치우므로
    이 가드의 판정이 OS 의 실제 해석과 어긋나면 안 된다(Finding 3, 리뷰 지적)."""
    if not isinstance(s, str) or not s or ":" in s or any(c in s for c in "\\/") or \
       s != os.path.basename(s):
        raise ManifestError(f"{what}가 유효하지 않음: {s!r}")
    stripped = s.rstrip(" .\t")
    if stripped in ("", ".", ".."):
        raise ManifestError(f"{what}가 유효하지 않음: {s!r}")
    stem = stripped.split(".", 1)[0].casefold()
    if stem in _RESERVED_DEVICE_NAMES:
        raise ManifestError(f"{what}가 예약된 이름임: {s!r}")
    return s


def safe_relpath(p, what="경로"):
    """레포 내 상대경로 검증. './' 접두만 벗기고 나머지는 세그먼트별로 safe_segment."""
    if not isinstance(p, str) or not p:
        raise ManifestError(f"{what}가 유효하지 않음: {p!r}")
    q = p.replace("\\", "/")
    if q.startswith("./"):
        q = q[2:]
    if q.startswith("/") or os.path.isabs(p):
        raise ManifestError(f"{what}는 상대경로여야 합니다: {p!r}")
    parts = q.split("/")
    for seg in parts:
        safe_segment(seg, what)
    return "/".join(parts)


def _validate_source_url(url, what="source.url"):
    """git 이 스스로 해석하는 문자열이라 remote_fetch 가 subprocess 에 리스트 인자로 넘겨도
    주입을 막지 못한다(git 자신이 "ext::" 전송 헬퍼나 "--upload-pack=" 같은 옵션형 값을
    해석해 임의 명령을 실행한다 - Finding 2, 실측: git fetch 가 --upload-pack=evil 을 받으면
    "evil" 을 서브프로세스로 실행 시도하는 게 재현됐다). 허용 스킴 allowlist 로 막는다."""
    if not isinstance(url, str) or not url:
        raise ManifestError(f"{what}가 유효하지 않음: {url!r}")
    if url.startswith("-"):
        raise ManifestError(f"{what}가 옵션처럼 시작함(주입 위험): {url!r}")
    if _TRANSPORT_HELPER_RE.match(url):
        raise ManifestError(f"{what}에 전송 헬퍼 구문은 허용하지 않음(예: ext::): {url!r}")
    low = url.lower()
    if low.startswith(_ALLOWED_URL_SCHEMES) or _SCP_STYLE_RE.match(url):
        return url
    raise ManifestError(f"{what} 스킴이 허용 목록에 없음: {url!r}")


def _validate_ref(ref, what="ref"):
    """옵션처럼(-로 시작) 시작하는 ref/branch 이름은 git 명령에서 옵션으로 오인된다."""
    if ref is None:
        return None
    if not isinstance(ref, str) or not ref or ref.startswith("-"):
        raise ManifestError(f"{what}가 유효하지 않음: {ref!r}")
    return ref


def _validate_sha(sha, what="sha"):
    if sha is None:
        return None
    if not isinstance(sha, str) or not sha or sha.startswith("-") or not _HEX_RE.match(sha):
        raise ManifestError(f"{what}가 유효하지 않음(hex 아님): {sha!r}")
    return sha


def _url_path_part(u):
    """쿼리/프래그먼트를 떼어낸 부분. 이걸 안 떼면 '.../marketplace.json?token=x' 가
    .json 으로 안 끝나 git 으로 오판되고, 결국 JSON 주소를 clone 하려 든다."""
    for sep in ("#", "?"):
        u = u.split(sep, 1)[0]
    return u


def _last_segment(u):
    return _url_path_part(u).replace("\\", "/").rstrip("/").split("/")[-1]


def _safe_id(cand):
    """id 후보를 세그먼트 규칙으로 거른다. 못 만들면 빈 문자열 - 호출부가 --id 를 요구한다."""
    try:
        return safe_segment(cand or "", "id")
    except ManifestError:
        return ""


def _id_for_json(url):
    """.../marketplace.json 처럼 파일명이 정보가 없으면 한 단계 위 세그먼트를 쓴다.
    등록된 마켓 여럿이 전부 'marketplace' 라는 같은 id 를 두고 싸우는 걸 막는다."""
    segs = [s for s in _url_path_part(url).split("//")[-1].split("/") if s]
    base = segs[-1] if segs else ""
    stem = base[:-5] if base.lower().endswith(".json") else base
    if stem.casefold() in _GENERIC_JSON_STEMS or not stem:
        return _safe_id(segs[-2] if len(segs) >= 2 else "")
    return _safe_id(stem)


def _id_for_git(url):
    """library._id_from_url 과 같은 규칙(레포명에서 .git 제거) - 두 경로가 같은 id 를 내야
    owner/repo 축약과 전체 URL 이 서로 중복으로 잡힌다."""
    base = _last_segment(url)
    return _safe_id(base[:-4] if base.lower().endswith(".git") else base)


def _local_source(p):
    """로컬 경로는 복사하지 않고 그 자리를 캐시로 삼으므로 realpath 로 고정해 둔다 -
    같은 디렉토리를 ./x 와 절대경로로 두 번 등록하는 걸 중복 검사가 잡아내려면 표기가
    하나여야 한다. 없는 경로는 여기서 거부한다: '../../etc' 같은 값이 형식만 맞다고
    통과하면 존재하지도 않는 캐시를 가리키는 레코드가 스토어에 남는다."""
    real = os.path.realpath(p)
    if not os.path.isdir(real):
        raise ManifestError(f"로컬 마켓 경로가 디렉토리가 아닙니다: {p!r}")
    return {"kind": "local", "url": None, "path": real,
            "id": _safe_id(os.path.basename(real.rstrip("\\/")))}


def classify_source(src: str) -> dict:
    """마켓 소스 문자열을 {"kind": "git"|"json"|"local", "url", "path", "id"} 로 판별.

    id 는 **제안값**이다 - 최종 id 는 library 가 --id 와 중복 검사를 거쳐 정한다.

    주입 가드(옵션형 시작, 전송 헬퍼 구문)를 분기보다 **먼저** 돌린다. 뒤쪽 분기가 어차피
    거부한다는 이유로 가드를 건너뛰면 분기 하나만 늘어도 가드가 조용히 무력해지고, 거부
    사유도 실제 위험과 다른 걸 말하게 된다.

    판정 순서가 곧 규칙이다:
      1) 명시적 로컬 표기(./ ../ 절대경로 드라이브)  - 축약보다 먼저 본다
      2) 허용 스킴 URL / scp 스타일
      3) owner/repo 축약
      4) 마지막에만 '존재하는 디렉토리'로 본다 - 이 검사를 3)보다 앞에 두면 cwd 아래에
         우연히 owner/repo 디렉토리가 있는 사람에게만 축약이 로컬로 바뀐다(cwd 의존)."""
    if not isinstance(src, str) or not src.strip():
        raise ManifestError(f"마켓 소스가 비어 있습니다: {src!r}")
    s = src.strip()
    if s.startswith("-"):
        raise ManifestError(f"마켓 소스가 옵션처럼 시작함(주입 위험): {s!r}")
    if _TRANSPORT_HELPER_RE.match(s):
        raise ManifestError(f"마켓 소스에 전송 헬퍼 구문은 허용하지 않음(예: ext::): {s!r}")

    if s.startswith(_LOCAL_PREFIXES) or s in (".", "..") or \
       s.startswith(("/", "\\")) or _DRIVE_ABS_RE.match(s):
        return _local_source(s)

    low = s.lower()
    if low.startswith(_ALLOWED_URL_SCHEMES) or _SCP_STYLE_RE.match(s):
        _validate_source_url(s, "마켓 소스")
        if _url_path_part(s).lower().endswith(".json"):
            # .json 은 git 레포가 아니라 매니페스트 본문이다. 본문은 http(s) 로만 받으므로
            # ssh/git/file 로 온 .json 은 등록해봤자 영원히 못 가져온다 - 여기서 끊는다.
            if not low.startswith(_JSON_SCHEMES):
                raise ManifestError(f"marketplace.json 은 http/https 로만 받습니다: {s!r}")
            return {"kind": "json", "url": s, "path": None, "id": _id_for_json(s)}
        return {"kind": "git", "url": s, "path": None, "id": _id_for_git(s)}

    if s.count("/") == 1:
        owner, repo = s.split("/")
        safe_segment(owner, "마켓 소스")
        safe_segment(repo, "마켓 소스")
        return {"kind": "git", "url": f"https://github.com/{owner}/{repo}.git",
                "path": None, "id": _safe_id(repo)}

    if os.path.isdir(s):
        return _local_source(s)

    raise ManifestError(
        f"마켓 소스 형식을 알 수 없습니다: {src!r} - owner/repo, git URL, "
        f"marketplace.json URL, 로컬 경로 중 하나여야 합니다")


def source_spec(entry: dict) -> dict:
    """엔트리의 source 를 4종으로 정규화. 실측 분포: url 143 / git-subdir 80 / str-path 53 / github 2.

    url/ref/sha 는 여기서 검증하지만, marketplace.py 를 거치지 않는 호출 경로(사용자가
    remote-add/market-add 에 직접 --url 을 넘기는 경우)도 있으므로 remote_fetch.materialize 에
    독립적으로 같은 검증이 한 번 더 있다(방어 심층화, Finding 2)."""
    src = entry.get("source")
    if isinstance(src, str):
        return {"kind": "str-path", "url": None, "path": safe_relpath(src, "source.path"),
                "ref": None, "sha": None}
    if not isinstance(src, dict):
        raise ManifestError(f"source 형식을 알 수 없음: {src!r}")
    kind = src.get("source")
    sha = _validate_sha(src.get("sha"))
    if kind == "github":
        repo = src.get("repo") or ""
        segs = repo.split("/")
        if len(segs) != 2:
            raise ManifestError(f"github repo 형식이 아님: {repo!r}")
        for s in segs:
            safe_segment(s, "github repo")
        return {"kind": "github", "url": f"https://github.com/{repo}.git", "path": None,
                "ref": _validate_ref(src.get("commit")), "sha": sha}
    if kind == "git-subdir":
        return {"kind": "git-subdir", "url": _validate_source_url(src.get("url")),
                "path": safe_relpath(src.get("path") or "", "source.path"),
                "ref": _validate_ref(src.get("ref")), "sha": sha}
    if kind == "url":
        path = src.get("path")
        return {"kind": "url", "url": _validate_source_url(src.get("url")),
                "path": safe_relpath(path, "source.path") if path else None,
                "ref": _validate_ref(src.get("ref")), "sha": sha}
    raise ManifestError(f"지원하지 않는 source 종류: {kind!r}")


def catalog(mf: dict, fetched: dict, query=None, category=None, limit=50, offset=0) -> dict:
    """메타데이터 행만 돌려준다. 네트워크를 타지 않는다.

    'installable N' 칼럼은 만들지 않는다 - 컴포넌트를 선언한 엔트리가 4/278 뿐이라
    원격 225개는 fetch 전에 개수를 알 수 없다. 개수는 fetch 이후에만 나타난다."""
    mname = mf.get("name") or ""
    q = (query or "").casefold()
    rows, counts = [], {}
    for e in mf["plugins"]:
        if not isinstance(e, dict) or not e.get("name"):
            continue
        name = e["name"]
        try:
            safe_segment(name, "플러그인 이름")
        except ManifestError:
            continue        # 이름 자체가 경로 이탈이면 카탈로그에 노출하지 않는다(집계 제외, Finding 1)
        cat = e.get("category") or ""
        counts[cat] = counts.get(cat, 0) + 1
        if category and cat != category:
            continue
        if q and q not in name.casefold() and q not in (e.get("description") or "").casefold():
            continue
        try:
            kind = source_spec(e)["kind"]
        except ManifestError:
            kind = "invalid"       # 매니페스트가 이상해도 카탈로그 전체를 죽이지 않는다
        got = fetched.get(name) or {}
        src = e.get("source")
        manifest_sha = src.get("sha") if isinstance(src, dict) else None
        rows.append({
            "name": name,
            "display": display_name(e),
            "description": e.get("description") or "",
            "category": cat,
            "author": e.get("author") if isinstance(e.get("author"), str) else "",
            "homepage": e.get("homepage") or "",
            "kind": kind,
            "sha": got.get("sha") or manifest_sha,   # fetch 한 sha 우선, 없으면 매니페스트의 고정 sha
            "fetched": bool(got),
            "origin": f"market:{mname}/{name}",
        })
    total = len(rows)
    page = rows[offset:offset + limit] if limit else rows[offset:]
    return {"total": total, "offset": offset, "limit": limit, "categories": counts, "rows": page}
