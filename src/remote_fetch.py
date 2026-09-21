#!/usr/bin/env python3
r"""remote_fetch.py - 원격 레포 물질화(git) + 라이브러리 레이아웃 탐지.

store 를 모른다(캐시 경로는 호출부가 준다). 네트워크를 타는 유일한 모듈이므로
scan 경로에서는 import 만 하고 호출하지 않는다.

레이아웃 탐지가 별도인 이유: fetch 된 플러그인 루트는 이미 소문자 agents/skills/commands 라
매핑이 0 이다. 매핑이 필요한 건 my-tools 처럼 Agents/Skills 인 임의 레포뿐이다.
"""
from __future__ import annotations
import hashlib, http.client, json, os, re, shutil, subprocess, urllib.error, urllib.request

CATEGORY_NAMES = ("agents", "skills", "commands")
SKILL_MARKER = "skill.md"          # 비교는 항상 casefold 후


def _dirs(path):
    try:
        return [e for e in os.listdir(path) if os.path.isdir(os.path.join(path, e)) and not e.startswith(".")]
    except OSError:
        return []


def _has_skill_marker(path) -> bool:
    """path 하위 어딘가에 SKILL.md(대소문자 무시)를 품은 디렉토리가 있는가."""
    for root, dirs, names in os.walk(path):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        if any(n.casefold() == SKILL_MARKER for n in names):
            return True
    return False


def detect_layout(root: str) -> dict:
    """1) 루트 직계에서 agents/skills/commands 를 대소문자 무시로 찾아 채택.
    2) 실패한 카테고리는 깊이 2 + SKILL.md 마커로 후보만 제안(자동 채택 안 함).

    반환 map 의 값은 **root 기준 상대경로**(실제 디스크 표기 그대로).
    자동 채택은 폴백이 아니라 기본 경로이고, 매핑은 사용자가 확정한다."""
    top = _dirs(root)
    by_fold = {d.casefold(): d for d in top}
    cmap, found = {}, []
    for cat in CATEGORY_NAMES:
        actual = by_fold.get(cat)
        if actual:
            cmap[cat] = actual
            found.append(cat)

    candidates = []
    seen = set()

    def add(cat, rel):
        k = (cat, rel)
        if cat not in found and k not in seen:
            seen.add(k)
            candidates.append({"category": cat, "path": rel})

    for d in top:
        sub = os.path.join(root, d)
        for d2 in _dirs(sub):
            if d2.casefold() in CATEGORY_NAMES:
                add(d2.casefold(), os.path.join(d, d2))
        # SKILL.md 를 품은 디렉토리는 이름이 skills 가 아니어도 스킬 루트 후보다.
        if d.casefold() not in CATEGORY_NAMES and _has_skill_marker(sub):
            add("skills", d)

    return {"map": cmap, "found": found, "candidates": candidates}


# ── git ────────────────────────────────────────────────────────────────────
# 모든 명령에 두 플래그를 고정 + 로컬 config 에도 박는다(이후 checkout 까지 커버):
#   core.autocrlf=false  - 줄바꿈 정규화가 내용 해시를 바꿔 허위 modified 를 만드는 걸 막는다.
#   core.longpaths=true  - Windows MAX_PATH(260자) 를 넘는 캐시 경로에서 git 이 자기
#                          내부 파일(.git/objects/pack/*.promisor, .git/hooks/*.sample 등)을
#                          "Filename too long" 으로 못 쓰는 걸 막는다. 외부 플러그인은
#                          <store>/lib-cache/markets/<mkt>/plugins/<name>/<40자 sha>/ 아래에
#                          물질화되므로 store 경로가 길면 여유(실측: 기본 store 기준 54자)가
#                          금방 잠식된다 - CLAUDE_SNAPSHOT_STORE 는 사용자가 바꿀 수 있다.
#                          주의: 이 플래그는 git 자신의 파일 I/O 에만 적용된다. 이 모듈
#                          바깥의 os.makedirs/shutil.copytree/os.walk 등은 여전히 260자
#                          제한을 받는다(이 머신에서 확인) - \\?\ 접두를 코드베이스 전반에
#                          넣는 건 범위를 벗어나므로 하지 않는다.
# tarball 폴백은 만들지 않는다 - 호스트 하나에서만 되고 얻는 게 없다.

GIT_BASE = ["git", "-c", "core.autocrlf=false", "-c", "core.longpaths=true"]


class FetchError(Exception):
    """원격 물질화 실패의 공통 조상. git 이 아닌 경로(JSON 매니페스트 직접 다운로드)의
    실패가 git 이야기를 하는 메시지로 나가면 안 되므로 계열을 나눈다."""


class GitError(FetchError):
    pass


# git 이 url/ref/sha 문자열 자체를 해석하므로 subprocess 의 인자 리스트 격리로는 주입을
# 막지 못한다(실측: git fetch 가 "--upload-pack=evil" 을 받으면 "evil" 을 서브프로세스로
# 실행 시도했다). marketplace.py 가 같은 검증을 이미 하지만, remote-add/market-add 처럼
# 사용자가 --url 을 직접 넘겨 marketplace.py 를 거치지 않는 경로도 있으므로 여기서
# 독립적으로 다시 검사한다(marketplace 를 import 하지 않는다 - 이 모듈은 그보다 아래
# 계층이다). marketplace.py 의 동일 로직과 의도적으로 중복이다.
_ALLOWED_URL_SCHEMES = ("https://", "http://", "ssh://", "git://", "file://")
_SCP_STYLE_RE = re.compile(r"^[A-Za-z0-9_.~-]+@[A-Za-z0-9_.-]+:[A-Za-z0-9_./~-].*$")
_TRANSPORT_HELPER_RE = re.compile(r"^[A-Za-z0-9+.-]*::")   # 앞에서만 검사 - IPv6 리터럴([::1]) 오탐 방지
_HEX_RE = re.compile(r"^[0-9a-fA-F]+$")


def _validate_url(url):
    if not isinstance(url, str) or not url:
        raise GitError(f"url이 유효하지 않음: {url!r}")
    if url.startswith("-"):
        raise GitError(f"url이 옵션처럼 시작함(주입 위험): {url!r}")
    if _TRANSPORT_HELPER_RE.match(url):
        raise GitError(f"url에 전송 헬퍼 구문은 허용하지 않음(예: ext::): {url!r}")
    low = url.lower()
    if low.startswith(_ALLOWED_URL_SCHEMES) or _SCP_STYLE_RE.match(url):
        return url
    raise GitError(f"url 스킴이 허용 목록에 없음: {url!r}")


def _validate_ref(value, what):
    if value is None:
        return None
    if not isinstance(value, str) or not value or value.startswith("-"):
        raise GitError(f"{what}가 유효하지 않음: {value!r}")
    return value


def _validate_sha(sha):
    if sha is None:
        return None
    if not isinstance(sha, str) or not sha or sha.startswith("-") or not _HEX_RE.match(sha):
        raise GitError(f"sha가 유효하지 않음(hex 아님): {sha!r}")
    return sha


def git_available() -> bool:
    return shutil.which("git") is not None


def _run(cwd, *args, check=True):
    if not git_available():
        raise GitError("git 을 PATH 에서 찾을 수 없습니다")
    p = subprocess.run([*GIT_BASE, *args], cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=600)
    if check and p.returncode != 0:
        raise GitError(f"git {' '.join(args)} 실패(rc={p.returncode}): {(p.stderr or p.stdout).strip()[:500]}")
    return p.stdout.strip()


def materialize(dest: str, url: str, ref=None, sha=None, sparse=None) -> str:
    """dest 에 레포를 물질화하고 해석된 sha 를 반환. 이미 있으면 재사용(sparse 확장 포함).

    sha 가 있으면 sha 로 직접 fetch 한다(GitHub 은 비-tip SHA 도 허용).
    실패하면 --branch ref 로 받고 결과 sha 를 기록하는 폴백을 탄다.

    git fetch 는 실패해도 .git/FETCH_HEAD 를 빈 파일로 만들어 둔다(전송 시도 시점에
    열어서 truncate 하기 때문). "실패하면 부분 캐시를 남기지 않는다"는 계약은 git 이
    보장해주지 않으므로, 이번 호출이 새로 만든 dest 라면 실패 시 통째로 지운다.

    url/ref/sha 검증은 dest 를 건드리기 전에 한다 - 거부되면 디렉토리 자체가 생기지 않는다."""
    _validate_url(url)
    _validate_ref(ref, "ref")
    _validate_sha(sha)
    os.makedirs(dest, exist_ok=True)
    fresh = not os.path.isdir(os.path.join(dest, ".git"))
    try:
        if fresh:
            _run(dest, "init", "-q")
            _run(dest, "config", "--local", "core.autocrlf", "false")
            _run(dest, "config", "--local", "core.longpaths", "true")
            _run(dest, "remote", "add", "origin", url)
        else:
            _run(dest, "remote", "set-url", "origin", url)

        if sparse:
            _run(dest, "sparse-checkout", "init", "--cone")
            _run(dest, "sparse-checkout", "set", *sparse)

        target = sha or ref or "HEAD"
        try:
            _run(dest, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", target)
        except GitError:
            if not sha:
                raise
            # 서버가 비-tip SHA want 를 거부하는 경우: ref 로 받고 sha 를 검증한다.
            _run(dest, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", ref or "HEAD")
        _run(dest, "checkout", "-q", "FETCH_HEAD")
        got = _run(dest, "rev-parse", "HEAD")
        if sha and got != sha:
            raise GitError(f"sha 불일치: 요청 {sha[:12]} != 실제 {got[:12]}")
        return got
    except GitError:
        if fresh:
            shutil.rmtree(dest, ignore_errors=True)
        raise


# ── marketplace.json 직접 다운로드 ──────────────────────────────────────────
# git 레포가 아닌 마켓(Claude Code 가 받는 4형식 중 하나)은 매니페스트 파일 하나가 전부다.
# 표준 라이브러리만 쓴다(의존성 추가 금지). git 경로와 캐시 레이아웃을 맞춰
# <dest>/.claude-plugin/marketplace.json 에 두면 카탈로그/unregister 가 그대로 동작한다.

MANIFEST_MAX_BYTES = 5 * 1024 * 1024   # 무한 스트림에 디스크를 내주지 않는다. 실측 최대 매니페스트 401K
_JSON_SCHEMES = ("http://", "https://")


def _validate_http_url(url, what="url"):
    """JSON 본문은 http/https 로만 받는다 - ssh/git/file 은 git 전송용이지 본문 전송이 아니고,
    file:// 을 허용하면 로컬 파일을 원격 매니페스트인 척 끌어올 수 있다."""
    if not isinstance(url, str) or not url:
        raise FetchError(f"{what}가 유효하지 않음: {url!r}")
    if url.startswith("-"):
        raise FetchError(f"{what}가 옵션처럼 시작함: {url!r}")
    if not url.lower().startswith(_JSON_SCHEMES):
        raise FetchError(f"{what}는 http/https 여야 합니다: {url!r}")
    return url


def _read_capped(url, timeout):
    """본문을 상한까지만 읽는다. Content-Length 를 믿고 자르면 헤더를 속인 서버에
    그대로 당한다 - 읽는 양 자체를 상한+1 로 제한하고 넘치면 거부한다."""
    req = urllib.request.Request(url, headers={"User-Agent": "config-monitor"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            # 리다이렉트를 따라간 최종 주소도 검사한다. urllib 의 리다이렉트 핸들러는
            # file:// 은 막지만 ftp:// 는 허용하므로 이 검사가 실제로 일한다.
            _validate_http_url(getattr(resp, "url", None) or url, "리다이렉트된 주소")
            data = resp.read(MANIFEST_MAX_BYTES + 1)
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as e:
        # HTTPException 을 따로 적는 이유: 응답이 중간에 끊기는 IncompleteRead 는 OSError 가
        # 아니라 HTTPException 계열이라 이 목록에 없으면 호출부까지 새어 트레이스백이 된다.
        raise FetchError(f"매니페스트를 받을 수 없습니다: {e}") from e
    if len(data) > MANIFEST_MAX_BYTES:
        raise FetchError(f"매니페스트가 상한({MANIFEST_MAX_BYTES} 바이트)을 넘었습니다")
    return data


def fetch_manifest_json(dest: str, url: str, timeout: int = 30) -> str:
    """marketplace.json 을 직접 받아 <dest>/.claude-plugin/marketplace.json 에 쓰고
    내용 sha256 앞 12자를 반환한다(git sha 가 없으므로 그 자리를 대신한다 - 내용이 바뀌면
    값도 바뀌어 갱신 여부가 눈에 보인다).

    파싱 검증을 **쓰기 전에** 끝낸다. materialize 와 같은 계약이다: 실패하면 부분 파일을
    남기지 않고, 이번 호출이 dest 를 새로 만들었다면 통째로 지운다. 검증을 나중에 하면
    잘못된 응답이 이미 등록된 마켓의 매니페스트를 덮어써 카탈로그가 사라진다."""
    _validate_http_url(url)
    data = _read_capped(url, timeout)
    try:
        obj = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise FetchError(f"매니페스트가 올바른 JSON 이 아닙니다: {e}") from e
    if not isinstance(obj, dict) or not isinstance(obj.get("plugins"), list):
        raise FetchError("매니페스트에 plugins 배열이 없습니다")

    fresh = not os.path.isdir(dest)
    path = os.path.join(dest, ".claude-plugin", "marketplace.json")
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)          # 원자적 교체 - 반쯤 쓰인 매니페스트가 보이지 않는다
    except OSError as e:
        if fresh:
            shutil.rmtree(dest, ignore_errors=True)
        else:
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise FetchError(f"매니페스트를 저장할 수 없습니다: {e}") from e
    return hashlib.sha256(data).hexdigest()[:12]
