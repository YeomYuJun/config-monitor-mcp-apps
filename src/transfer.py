#!/usr/bin/env python3
r"""transfer.py - PC 간 설정 이관 번들(cmbundle v1) 만들기·가져오기.

  inventory [--with-optional local,memory,agent-memory] 이관 대상 목록(읽기 전용)
  export --out P [--with-optional ...] [--include-secrets]
                                                      번들 쓰기. P 가 .cmbundle 이면 zip, 아니면 폴더
  inspect --bundle P                                  번들 요약
  plan --bundle P [--secrets JSON] [--choices JSON]   이 PC 와 비교(읽기 전용). 항목별 new/same/changed/blocked/skipped
  apply --bundle P --plan-id X [--ids a,b] [--install-plugins]
                                                      plan 그대로 적용. 스냅샷 전/후, 스토어 imports[] 원장
  undo --import-id X [--force]                        원장의 휴지통·백업으로 되돌린다
  history                                             가져오기(imports[])·내보내기(exports[]) 기록
  sync-setup --dir D [--profile N]                    공유 폴더 지정(스토어 config.json 의 sync)
  sync-push [--include-secrets]                       이 PC 를 <D>/<N>/ 폴더 번들로 올린다
  sync-status [--from M]                              PC 목록, 또는 M 과 항목별 in-sync/local-ahead/remote-ahead/diverged/untracked
  plan --sync-from M / sync-pull --from M --plan-id X M 의 폴더 번들을 plan/apply 하고 기준을 맞춘다
  roots --bundle P --roots JSON [--by claude|user]   이 PC 경로 짝을 확인해 저장(다음 plan 이 쓴다)

다른 PC 의 번들은 드라이브·도구 폴더가 다르다. plan 은 이 PC 에 없는 경로의 짝을 정해(--roots > 저장된 짝 > 추정)
값을 바꿔 끼우고, 그래도 없는 경로를 쓰는 훅·MCP 서버는 쓰지 않는다. 동작 중인 이 PC 값은 덮지 않는다.

번들에는 ~/.claude, ~/.claude.json 의 mcpServers, Desktop config 의 mcpServers, 스토어 설정만 담는다.
설정이 가리키는 그 밖의 파일(훅 스크립트, MCP 서버 실행 파일, 플러그인 폴더, 라이브러리)은 담지 않고
external 로 경로만 보고한다. 새 PC 에서 같은 경로에 따로 준비해야 하는 목록이다.

JSON 값은 시크릿 치환 -> 경로 토큰화 -> 외부 경로 추출 순서로 처리한다. 이 순서라야 보고·manifest 에
시크릿 값이 섞이지 않는다. 파일·트리 항목은 원문 바이트 그대로 담고 원문으로 해시한다.
"""
from __future__ import annotations
import contextlib, difflib, hashlib, json, os, re, shutil, socket, string, subprocess, sys, time, zipfile
from datetime import datetime

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from cli_result import emit, guard, JsonArgumentParser
import cas
import config_edit
import lib_store
import paths
import plugin_state

FORMAT, VERSION = "cmbundle", 1
HOME = os.path.expanduser("~")
CLAUDE_HOME = os.path.join(HOME, ".claude")
CLAUDE_JSON = os.path.join(HOME, ".claude.json")
SIZE_WARN = 50 * 1024 * 1024

# (category, 하위 디렉토리, 보고 라벨, 디렉토리만 항목인가)
TREE_CATS = [
    ("cc.skills", "skills", "스킬", True),
    ("cc.agents", "agents", "에이전트", False),
    ("cc.commands", "commands", "커맨드", False),
    ("cc.rules", "rules", "규칙", False),
    ("cc.output-styles", "output-styles", "출력 스타일", False),
    ("cc.workflows", "workflows", "워크플로", False),
    ("cc.themes", "themes", "테마", False),
]
FILE_CATS = [
    ("cc.claude-md", "CLAUDE.md", "CLAUDE.md"),
    ("cc.keybindings", "keybindings.json", "keybindings.json"),
]
LABELS = {c: l for c, _, l, _ in TREE_CATS} | {c: l for c, _, l in FILE_CATS} | {
    "cc.settings": "settings.json (권한·훅·env·플러그인 선언)",
    "cc.settings-local": "settings.local.json",
    "cc.refs": "~/.claude 안의 참조 파일(훅·statusLine 스크립트)",
    "cc.mcp-user": "MCP 서버 (Claude Code)",
    "desk.mcp": "MCP 서버 (Desktop)",
    "cm.store": "config-monitor 스토어 설정",
    "cc.project-memory": "프로젝트 메모리",
    "cc.agent-memory": "에이전트 메모리",
}
OPTIONAL = {"local": "cc.settings-local", "memory": "cc.project-memory", "agent-memory": "cc.agent-memory"}

SECRET_KEY = re.compile(r"TOKEN|KEY|SECRET|PASSWORD|AUTHORIZATION")
SECRET_VAL = re.compile(r"(?<![A-Za-z0-9])(sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|"
                        r"github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9\-]{10,})")
HIGH_ENTROPY = re.compile(r"^[A-Za-z0-9+/_=\-]{40,}$")
PATH_START = re.compile(r"[A-Za-z]:[\\/]|\$\{(?:HOME|CLAUDE_HOME|DESKTOP_DIR)\}|~[\\/]")
STORE_MARKET_KEYS = ("id", "url", "ref", "name")
STORE_REMOTE_KEYS = ("id", "url", "ref", "map")
MCP_CATS = ("cc.mcp-user", "desk.mcp")
SETTINGS_CATS = ("cc.settings", "cc.settings-local")


def _sha(b: bytes) -> str:
    return "sha256:" + hashlib.sha256(b).hexdigest()


def _canon(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _load(p):
    with open(p, encoding="utf-8-sig") as f:
        return json.load(f)


def _norm_disp(p: str) -> str:
    return os.path.normpath(p)


def _walk_key(rel):
    """os.walk(디렉토리 정렬) 순서: 한 폴더 안에서 파일이 하위 폴더보다 먼저 온다."""
    parts = rel.split("/")
    return [(1, d) for d in parts[:-1]] + [(0, parts[-1])]


def tree_digest(rows):
    """rows = [(트리 안 상대경로 '/', 파일 해시)]. export 와 import 가 같은 값을 내야 한다."""
    rows = sorted(rows, key=lambda r: _walk_key(r[0]))
    return _sha("".join(f"{r}\0{h}\n" for r, h in rows).encode("utf-8"))


def tree_rows(p):
    """(rows, 총 바이트)."""
    rows, size = [], 0
    for root, dirs, files in os.walk(p):
        dirs.sort()
        for fn in sorted(files):
            fp = os.path.join(root, fn)
            with open(fp, "rb") as f:
                data = f.read()
            rows.append((os.path.relpath(fp, p).replace(os.sep, "/"), _sha(data)))
            size += len(data)
    return rows, size


def prepare_json(cat, iid, obj, tokens):
    """시크릿 치환 -> 토큰화. (결과, {경로: 원래 값}). 대상 PC 의 현재 값도 같은 함수로 해시해 비교한다."""
    found = {}
    if cat in MCP_CATS:
        obj = scrub(obj, iid, found)
    if cat in SETTINGS_CATS and isinstance(obj.get("env"), dict):
        obj = {**obj, "env": scrub(obj["env"], iid, found, "env")}
    return (map_strings(obj, lambda s: tokenize(s, tokens)) if tokens else obj), found


# ── 경로 토큰 ────────────────────────────────────────────────────────────────

def make_tokens(desktop_dir):
    """긴 접두부터 치환해야 ${CLAUDE_HOME} 이 ${HOME}/.claude 로 쪼개지지 않는다."""
    toks = [("${CLAUDE_HOME}", CLAUDE_HOME), ("${DESKTOP_DIR}", desktop_dir), ("${HOME}", HOME)]
    toks.sort(key=lambda t: -len(t[1]))
    flags = re.I if os.name == "nt" else 0
    out = []
    for tok, base in toks:
        segs = [re.escape(s) for s in re.split(r"[\\/]+", base) if s]
        lead = "/" if base.startswith("/") else ""
        pat = re.compile(re.escape(lead) + r"[\\/]+".join(segs) + r"(?=[\\/\"'\s;]|$)", flags)
        out.append((tok, base, pat))
    return out


def tokenize(s: str, tokens) -> str:
    for tok, _base, pat in tokens:
        s = pat.sub(lambda _m, t=tok: t, s)
    return s


def detokenize(s: str, tokens) -> str:
    for tok, base, _pat in tokens:
        s = s.replace(tok, base)
    return s


def map_strings(obj, fn):
    if isinstance(obj, str):
        return fn(obj)
    if isinstance(obj, list):
        return [map_strings(v, fn) for v in obj]
    if isinstance(obj, dict):
        return {k: map_strings(v, fn) for k, v in obj.items()}
    return obj


# ── 시크릿 ──────────────────────────────────────────────────────────────────

def _looks_secret_value(v: str) -> bool:
    if SECRET_VAL.search(v):
        return True
    return bool(HIGH_ENTROPY.match(v)) and re.search(r"\d", v) and re.search(r"[A-Za-z]", v) \
        and not PATH_START.match(v)


def scrub(obj, item_id, found, prefix="", key_hit=False):
    """키 이름이 시크릿 패턴이면 그 아래 문자열 전부, 아니면 값 패턴에 걸린 문자열만 치환한다.
    found 에 {path: 원래 값} 을 모은다(값은 secrets.json 에만 간다)."""
    if isinstance(obj, dict):
        return {k: scrub(v, item_id, found, f"{prefix}.{k}" if prefix else k,
                         key_hit or bool(SECRET_KEY.search(k.upper())))
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub(v, item_id, found, f"{prefix}[{i}]", key_hit) for i, v in enumerate(obj)]
    if isinstance(obj, str) and obj and (key_hit or _looks_secret_value(obj)):
        found[prefix] = obj
        return "${CM_SECRET:%s:%s}" % (item_id, prefix)
    return obj


# ── 외부 경로 ────────────────────────────────────────────────────────────────

def find_paths(s: str, lists=False):
    """명령 문자열·env 값에서 절대경로 후보를 뽑는다. 따옴표 안은 공백을 포함한 한 덩어리로 본다.
    POSIX 의 '/' 시작 토큰은 소스가 POSIX 일 때만 - Windows 명령의 '/c' 같은 스위치를 경로로 오인한다."""
    out = []
    for piece in (s.split(";") if lists else [s]):
        quoted = [a or b for a, b in re.findall(r'"([^"]*)"|\'([^\']*)\'', piece)]
        rest = re.sub(r'"[^"]*"|\'[^\']*\'', " ", piece).split()
        for c in quoted + rest:
            m = PATH_START.search(c)
            if m:
                out.append(c[m.start():].rstrip(",)"))
            elif os.name != "nt" and c.startswith("/") and len(c) > 1 and not c.startswith("//"):
                out.append(c)
    return out


def _settings_refs(obj):
    """(kind, owner, field, 문자열, 목록 여부). 훅 command, statusLine, env 만 본다(실측에서 경로가 나온 곳)."""
    for event, entries in (obj.get("hooks") or {}).items():
        for i, ent in enumerate(entries if isinstance(entries, list) else []):
            for j, hk in enumerate((ent or {}).get("hooks") or [] if isinstance(ent, dict) else []):
                if isinstance(hk, dict) and isinstance(hk.get("command"), str):
                    yield "hook", event, f"hooks.{event}[{i}].hooks[{j}].command", hk["command"], False
    sl = obj.get("statusLine")
    if isinstance(sl, dict) and isinstance(sl.get("command"), str):
        yield "statusline", "statusLine", "statusLine.command", sl["command"], False
    for k, v in (obj.get("env") or {}).items():
        if isinstance(v, str):
            yield ("plugin-dirs" if k == "CLAUDE_CODE_PLUGIN_DIRS" else "env"), k, f"env.{k}", v, True


def _mcp_refs(name, server):
    if isinstance(server.get("command"), str):
        yield "mcp", name, "command", server["command"], False
    for i, a in enumerate(server.get("args") or []):
        if isinstance(a, str):
            yield "mcp", name, f"args[{i}]", a, False
    if isinstance(server.get("cwd"), str):
        yield "mcp", name, "cwd", server["cwd"], False
    for k, v in (server.get("env") or {}).items():
        if isinstance(v, str):
            yield "mcp", name, f"env.{k}", v, True


# ── 경로 맞춤 ────────────────────────────────────────────────────────────────
# ${HOME}·${CLAUDE_HOME}·${DESKTOP_DIR} 는 토큰이라 이 PC 값으로 이미 풀린다. 남는 것은 도구를 둔 드라이브·폴더처럼
# PC 마다 다른 절대경로다. 다른 PC 번들을 그대로 쓰면 이 PC 에 없는 경로가 설정에 들어가 매 턴 훅이 실패한다.
# 원칙 둘을 어디서 온 짝(추정·사람·Claude)이든 똑같이 지킨다.
#   - 이 PC 에 없는 경로는 쓰지 않는다. 맞출 짝이 없으면 그 경로를 쓰는 훅 하나·서버 하나를 뺀다.
#   - 동작 중인 이 PC 값을 동작하지 않는 값으로 덮지 않는다.

def _exists(p):
    return os.path.exists(os.path.expanduser(p))


def _ncase(p):
    return os.path.normcase(os.path.normpath(p))


def _under(p, root):
    a, b = _ncase(p), _ncase(root)
    return a == b or a.startswith(b.rstrip("\\/") + os.sep)


def _rebase(p, frm, to):
    """_under(p, frm) 인 p 의 frm 부분만 to 로 바꾼다."""
    rest = os.path.normpath(p)[len(os.path.normpath(frm)):].lstrip("\\/")
    return os.path.join(to, rest) if rest else os.path.normpath(to)


def _top_missing(p, exists):
    """p 의 조상 가운데 이 PC 에 없는 가장 위 폴더(그 부모는 있다). p 가 있으면 None."""
    cur = os.path.normpath(p)
    if exists(cur):
        return None
    while True:
        parent = os.path.dirname(cur)
        if parent == cur or exists(parent):
            return cur
        cur = parent


def local_drives():
    if os.name != "nt":
        return []
    return [f"{c}:\\" for c in string.ascii_uppercase if os.path.exists(f"{c}:\\")]


def _same_name(a, b):
    return os.path.basename(os.path.normpath(a)).lower() == os.path.basename(os.path.normpath(b)).lower()


def infer_roots(missing, src_libs=(), local_libs=(), exists=_exists, drives=None):
    """이 PC 에서 찾지 못한 경로들의 짝 루트를 추정한다. [{from, to, source, total, resolved}].
    근거는 둘뿐이다 - 같은 역할의 이 PC 폴더(config-monitor 라이브러리 루트), 드라이브 글자만 다른 같은 폴더.
    파일 이름으로 디스크를 뒤지지 않는다 - index.js 처럼 흔한 이름은 엉뚱한 도구에 붙는다.
    하나도 풀지 못하는 짝은 내지 않는다(그런 짝은 확인할 거리만 늘린다)."""
    drives = local_drives() if drives is None else drives
    left, roots = list(missing), []

    def take(frm, to, source):
        mine = [p for p in left if _under(p, frm)]
        ok = sum(1 for p in mine if exists(_rebase(p, frm, to)))
        if not ok:
            return False
        roots.append({"from": os.path.normpath(frm), "to": os.path.normpath(to), "source": source,
                      "total": len(mine), "resolved": ok})
        left[:] = [p for p in left if p not in mine]
        return True

    for src in src_libs:
        if exists(src):
            continue
        cands = [lib for lib in local_libs if _same_name(lib, src) and exists(lib)]
        if not cands and len(local_libs) == 1 and exists(local_libs[0]):
            cands = list(local_libs)
        for loc in cands:
            if take(src, loc, "library"):
                break
    tops = []
    for p in left:
        t = _top_missing(p, exists)
        if t and not any(_ncase(t) == _ncase(x) for x in tops):
            tops.append(t)
    for top in tops:
        drive, rest = os.path.splitdrive(top)
        if not drive:
            continue
        best = None
        for d in drives:
            if _ncase(d) == _ncase(drive + os.sep):
                continue
            to = os.path.join(d, rest.lstrip("\\/"))
            n = sum(1 for p in left if _under(p, top) and exists(_rebase(p, top, to)))
            if n and (best is None or n > best[0]):
                best = (n, to)
        if best:
            take(top, best[1], "drive")
    return roots


class PathMap:
    """from 루트를 to 로 바꾼다. 문자열 어디에 있든(명령 인자 안이라도) 경로 경계에서만 맞추고, 긴 루트가 이긴다.
    원래 글이 '/' 를 쓰면 바꾼 부분도 '/' 로 쓴다."""

    def __init__(self, pairs):
        self.pairs = sorted(((os.path.normpath(f), os.path.normpath(t)) for f, t in pairs if f and t),
                            key=lambda x: -len(x[0]))
        alts = []
        for i, (f, _t) in enumerate(self.pairs):
            segs = [re.escape(s) for s in re.split(r"[\\/]+", f) if s]
            lead = r"[\\/]" if f[:1] in "\\/" else ""
            alts.append(f"(?P<r{i}>" + lead + r"[\\/]+".join(segs) + ")")
        flags = re.I if os.name == "nt" else 0
        self.rx = re.compile(r"(?<![A-Za-z0-9_.])(?:" + "|".join(alts) + r")(?=[\\/\"'\s;,)]|$)", flags) \
            if alts else None

    def sub(self, s, used=None):
        if not self.rx or not isinstance(s, str):
            return s

        def rep(m):
            f, t = self.pairs[int(m.lastgroup[1:])]
            if used is not None:
                used.add((f, t))
            nxt = m.string[m.end():m.end() + 1]
            out = t.rstrip("\\/") if nxt in ("\\", "/") else t
            return out.replace("\\", "/") if "/" in m.group(0) or nxt == "/" else out
        return self.rx.sub(rep, s)


def _dead(s, lists=False, alive=_exists):
    return [p for p in find_paths(s, lists) if not alive(p)]


def _norm_cmd(cmd):
    """같은 훅인지 비교할 때만 쓴다. 경로는 normcase·normpath 로, 따옴표·공백 차이는 없앤다.
    이게 없으면 대소문자·구분자만 다른 같은 스크립트(C:/my-tools/Hooks/x.js, c:/my-tools/hooks/x.js)가
    다른 훅으로 보여 같은 훅이 두 번 돈다."""
    s = cmd
    for p in find_paths(cmd):
        s = s.replace(p, _ncase(os.path.expanduser(p)))
    s = " ".join(s.replace('"', " ").replace("'", " ").split())
    return s.lower() if os.name == "nt" else s


def _hook_id(event, norm):
    return "hook:" + hashlib.sha256(f"{event}\0{norm}".encode("utf-8")).hexdigest()[:10]


def _dead_server(name, server, alive=_exists):
    """실행에 쓰는 경로(command·args·cwd) 가운데 이 PC 에 없는 것. env 의 경로는 서버가 만들 데이터 폴더일 수 있어 보지 않는다."""
    return [p for kind, _o, field, s, lists in _mcp_refs(name, server) if not field.startswith("env.")
            for p in _dead(s, lists, alive)]


# ── 수집 ────────────────────────────────────────────────────────────────────

class Collector:
    def __init__(self, store, optional=(), include_secrets=False):
        self.store = store
        self.optional = set(optional)
        self.include_secrets = include_secrets
        self.desktop_dir = paths.resolve_desktop_dir()
        self.desktop_config = os.path.join(self.desktop_dir, paths.DESKTOP_CONFIG_NAME)
        self.tokens = make_tokens(self.desktop_dir)
        self.items = []          # {id, category, strategy, rel, hash, size, files, secrets, _src | _json}
        self.skipped = []        # {id, reason}
        self.refs = []           # (kind, owner, scope, field, tokenized path)
        self.secrets = {}        # item id -> {path: value}
        self.warnings = []
        self.plugins = {}

    def rel(self, p):
        return tokenize(p, self.tokens).replace("\\", "/")

    # file / tree
    def add_file(self, cat, iid, p):
        with open(p, "rb") as f:
            data = f.read()
        self.items.append({"id": iid, "category": cat, "strategy": "file", "rel": self.rel(p),
                           "hash": _sha(data), "size": len(data), "files": 1, "_src": p})

    def add_tree(self, cat, iid, p, **extra):
        rows, size = tree_rows(p)
        self.items.append({"id": iid, "category": cat, "strategy": "tree", "rel": self.rel(p),
                           "hash": tree_digest(rows), "size": size, "files": len(rows), **extra, "_src": p})
        if size > SIZE_WARN:
            self.warnings.append(f"{disp_id(iid)}: {size // (1024 * 1024)}MB 로 {SIZE_WARN // (1024 * 1024)}MB 를 넘음")

    def add_json(self, cat, iid, key, obj, refs):
        obj, found = prepare_json(cat, iid, obj, self.tokens)
        if found:
            self.secrets[iid] = found
        self.items.append({"id": iid, "category": cat, "strategy": "json-keys", "key": key,
                           "hash": _sha(_canon(obj)), "size": len(_canon(obj)), "files": 0,
                           "secrets": sorted(found), "_json": obj})
        for kind, owner, field, s, lists in refs(obj):
            for p in find_paths(s, lists):
                self.refs.append((kind, owner, cat, field, p))

    def collect(self):
        self._trees_and_files()
        self._memories()
        self._settings()
        self._mcp()
        self._store()
        self._resolve_refs()
        return self

    def _trees_and_files(self):
        for cat, sub, _label, dirs_only in TREE_CATS:
            d = os.path.join(CLAUDE_HOME, sub)
            if not os.path.isdir(d):
                continue
            for name in sorted(os.listdir(d)):
                full = os.path.join(d, name)
                if name.startswith("."):
                    continue
                if cat == "cc.skills" and name in paths.RESERVED_SKILL_DIRS:
                    self.skipped.append({"id": f"{cat}/{name}", "reason": "claude.ai 계정 동기화 폴더"})
                    continue
                if os.path.isdir(full):
                    self.add_tree(cat, f"{cat}/{name}", full)
                elif not dirs_only:
                    self.add_file(cat, f"{cat}/{name}", full)
        for cat, fn, _label in FILE_CATS:
            p = os.path.join(CLAUDE_HOME, fn)
            if os.path.isfile(p):
                self.add_file(cat, cat, p)

    def _memories(self):
        """기본 제외. 프로젝트 메모리 폴더 이름은 프로젝트 경로를 인코딩한 것이라 대상 PC 에서 다시
        인코딩해야 한다 - 원래 경로를 ~/.claude.json 의 projects 에서 찾아 project 로 남긴다."""
        if "cc.agent-memory" in self.optional:
            d = os.path.join(CLAUDE_HOME, "agent-memory")
            for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
                if not name.startswith(".") and os.path.isdir(os.path.join(d, name)):
                    self.add_tree("cc.agent-memory", f"cc.agent-memory/{name}", os.path.join(d, name))
        if "cc.project-memory" not in self.optional:
            return
        from claude_config import _encode_project_dir
        try:
            projects = _load(CLAUDE_JSON).get("projects") or {}
        except (OSError, ValueError, AttributeError):
            projects = {}
        known = {_encode_project_dir(pp): pp for pp in projects}
        d = os.path.join(CLAUDE_HOME, "projects")
        for enc in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            mem = os.path.join(d, enc, "memory")
            if not os.path.isdir(mem):
                continue
            if enc not in known:
                self.skipped.append({"id": f"cc.project-memory/{enc}",
                                     "reason": "어느 프로젝트의 메모리인지 알 수 없음(~/.claude.json 에 경로가 없음)"})
                continue
            self.add_tree("cc.project-memory", f"cc.project-memory/{enc}", mem, project=self.rel(known[enc]))

    def _settings(self):
        sp = os.path.join(CLAUDE_HOME, "settings.json")
        if os.path.isfile(sp):
            obj = _load(sp)
            prof = cas.ignore_profile({}, sp)
            if prof:
                obj = cas._strip(obj, prof["rules"], prof["keep"])
            obj = self._plugin_decls(obj)
            self.add_json("cc.settings", "cc.settings", "settings.json", obj, _settings_refs)
        lp = os.path.join(CLAUDE_HOME, "settings.local.json")
        if os.path.isfile(lp):
            if "cc.settings-local" in self.optional:
                self.add_json("cc.settings-local", "cc.settings-local", "settings.local.json",
                              _load(lp), _settings_refs)
            else:
                self.skipped.append({"id": "cc.settings-local",
                                     "reason": "기본 제외(--with-optional local 로 포함)"})

    def _plugin_decls(self, obj):
        """enabledPlugins 를 대상 PC 에서 그대로 쓸 수 있게 다듬는다.
        - 원장에 없는 마켓 플러그인 키는 뺀다(대상에서 설치 실패로 남는다). @builtin·@inline 은 원장에 오지
          않는 종류라 남긴다.
        - user 스코프로 설치됐는데 키가 없는 플러그인은 true 를 명시한다. 대상은 선언된 키만 받아 온다.
        - 쓰는 마켓이 extraKnownMarketplaces 에 없으면 known_marketplaces.json 의 source 로 보탠다."""
        pdir = os.path.join(CLAUDE_HOME, "plugins")
        installed = plugin_state.read_installed(pdir)
        enabled = dict(obj.get("enabledPlugins") or {})
        kinds = {"market": [], "builtin": [], "inline": []}
        dropped, added = [], []
        for pid in list(enabled):
            _name, market = plugin_state.split_id(pid)
            if market in ("builtin", "inline"):
                kinds[market].append(pid)
            elif pid in installed:
                kinds["market"].append(pid)
            else:
                dropped.append(pid)
                del enabled[pid]
                self.skipped.append({"id": f"cc.plugins/{pid}", "reason": "설치 원장에 없는 플러그인 선언"})
        for pid, rec in sorted(installed.items()):
            if pid not in enabled and "user" in (rec.get("scopes") or [rec.get("scope")]):
                enabled[pid] = True
                added.append(pid)
                kinds["market"].append(pid)
        ekm = dict(obj.get("extraKnownMarketplaces") or {})
        try:
            known = _load(os.path.join(pdir, "known_marketplaces.json"))
        except (OSError, ValueError):
            known = {}
        markets_added = []
        for pid in kinds["market"]:
            m = plugin_state.split_id(pid)[1]
            if m and m not in ekm and isinstance((known.get(m) or {}).get("source"), dict):
                ekm[m] = {"source": known[m]["source"]}
                markets_added.append(m)
        self.plugins = {"declared": sum(len(v) for v in kinds.values()),
                        **{k: sorted(v) for k, v in kinds.items()},
                        "added_explicit": added, "dropped": dropped, "markets_added": markets_added}
        obj = dict(obj)
        if enabled or "enabledPlugins" in obj:
            obj["enabledPlugins"] = enabled
        if ekm:
            obj["extraKnownMarketplaces"] = ekm
        return obj

    def _mcp(self):
        sources = [("cc.mcp-user", CLAUDE_JSON, "user"), ("desk.mcp", self.desktop_config, "desktop")]
        for cat, p, _scope in sources:
            if not os.path.isfile(p):
                continue
            try:
                servers = _load(p).get("mcpServers") or {}
            except (OSError, ValueError):
                self.warnings.append(f"{LABELS[cat]}: {p} 를 읽지 못함")
                continue
            for name, server in sorted(servers.items()):
                if isinstance(server, dict):
                    self.add_json(cat, f"{cat}/{name}", f"mcpServers.{name}", server,
                                  lambda o, n=name: _mcp_refs(n, o))

    def _store(self):
        try:
            cfg = lib_store.load_cfg(self.store)
        except (OSError, ValueError):
            cfg = {}
        if not cfg:
            self.skipped.append({"id": "cm.store", "reason": f"스토어 설정 없음: {self.store}"})
            return
        obj = {"libraries": cfg.get("libraries") or [],
               "remotes": [{k: r.get(k) for k in STORE_REMOTE_KEYS}
                           for r in cfg.get("remotes") or [] if isinstance(r, dict)],
               "marketplaces": [{k: m.get(k) for k in STORE_MARKET_KEYS}
                                for m in cfg.get("marketplaces") or [] if isinstance(m, dict)],
               "ui": cfg.get("ui") or {}}

        def refs(o):
            for i, lib in enumerate(o.get("libraries") or []):
                if isinstance(lib, str):
                    yield "library", lib, f"libraries[{i}]", lib, False
        self.add_json("cm.store", "cm.store", "config.json", obj, refs)

    def _resolve_refs(self):
        """${CLAUDE_HOME} 안을 가리키면 번들에 넣고(이미 들어간 항목 안이면 그대로), 나머지는 external."""
        bundled = [(it["_src"], it["strategy"]) for it in self.items if "_src" in it]
        inside = lambda p: any(os.path.normcase(p) == os.path.normcase(s) or
                               os.path.normcase(p).startswith(os.path.normcase(s) + os.sep)
                               for s, _ in bundled)
        ext = {}
        for kind, owner, scope, field, tp in self.refs:
            local = _norm_disp(os.path.expanduser(detokenize(tp, self.tokens)))
            if tp.rstrip("\\/") in TOKEN_NAMES:
                continue                       # 홈·Desktop 폴더 자체는 대상 PC 에서 토큰으로 다시 풀린다
            if tp.startswith("${CLAUDE_HOME}") and os.path.exists(local):
                if not inside(local):
                    iid = "cc.refs/" + os.path.relpath(local, CLAUDE_HOME).replace(os.sep, "/")
                    (self.add_tree if os.path.isdir(local) else self.add_file)("cc.refs", iid, local)
                    bundled.append((local, None))
                continue
            k = (kind, os.path.normcase(local))
            e = ext.setdefault(k, {"kind": kind, "path": local, "token": tp,
                                   "exists": os.path.exists(local), "owners": [], "scopes": [], "fields": []})
            for lst, v in ((e["owners"], owner), (e["scopes"], scope)):
                if v not in lst:
                    lst.append(v)
            e["fields"].append(f"{scope}:{field}")
        self.external = sorted(ext.values(), key=lambda e: (EXT_ORDER.index(e["kind"]), e["path"].lower()))

    # 결과
    def counts(self):
        c = {}
        for it in self.items:
            c[it["category"]] = c.get(it["category"], 0) + 1
        return c

    def report(self, out_path=None):
        """영어 화면은 이 줄 대신 src/ui/transfer.ts reportLines 가 같은 구성으로 그린다."""
        lines = [f"export 결과: {out_path}" if out_path else "이관 대상"]
        counts = self.counts()
        for cat in [c for c, *_ in TREE_CATS] + [c for c, *_ in FILE_CATS] + \
                   ["cc.project-memory", "cc.agent-memory", "cc.refs", "cc.settings", "cc.settings-local", "cc.mcp-user", "desk.mcp", "cm.store"]:
            if counts.get(cat):
                n = counts[cat]
                lines.append(f"- {LABELS[cat]} {n}건" if cat not in SINGLE else f"- {LABELS[cat]}")
        p = self.plugins
        if p:
            lines.append(f"- 플러그인 선언 {p['declared']}건 (마켓 {len(p['market'])}, 내장 {len(p['builtin'])}, "
                         f"inline {len(p['inline'])}) - 새 PC 에서 Claude Code 가 다음 실행 때 내려받음")
            if p["added_explicit"]:
                lines.append(f"  - 설치돼 있지만 선언이 없던 플러그인에 true 를 보탬: {', '.join(p['added_explicit'])}")
            if p["dropped"]:
                lines.append(f"  - 설치 원장에 없는 선언은 뺌: {', '.join(p['dropped'])}")
        sec = [(iid, k) for iid, d in self.secrets.items() for k in d]
        if sec:
            lines.append(f"- 시크릿 {len(sec)}건을 secrets.json 에 평문으로 넣음 (번들을 공유 폴더에 둘 때 주의)"
                         if self.include_secrets else
                         f"- 시크릿 {len(sec)}건은 값을 빼고 자리표시자로 남김 (새 PC 에서 입력)")
            lines += [f"  - {disp_id(iid)}: {k}" for iid, k in sec]
        if self.external:
            lines.append("- 번들링 불가능 외부 설정 (새 PC 의 같은 경로에 따로 준비해야 함)")
            for kind in EXT_ORDER:
                rows = [e for e in self.external if e["kind"] == kind]
                if not rows:
                    continue
                lines.append(f"  - {EXT_LABELS[kind]}")
                disp = lambda e: e["path"] + ("" if e["exists"] else " [이 PC 에도 없음]")
                if kind == "mcp":
                    # 서버 하나가 실행 파일·데이터 폴더를 여럿 가리킨다 - 서버 단위로 모은다.
                    by = {}
                    for e in rows:
                        for o in e["owners"]:
                            g = by.setdefault(o.lower(), {"name": o, "scopes": [], "paths": []})
                            g["paths"].append(disp(e))
                            g["scopes"] += [s for s in e["scopes"] if s not in g["scopes"]]
                    for g in sorted(by.values(), key=lambda g: g["name"].lower()):
                        where = ", ".join(SCOPE_LABELS[s] for s in sorted(g["scopes"], key=SCOPE_ORDER.index))
                        lines.append(f"    - {g['name']} ({where}): {', '.join(g['paths'])}")
                elif kind in ("plugin-dirs", "library"):
                    lines += [f"    - {disp(e)}" for e in rows]
                else:
                    lines += [f"    - {disp(e)} ({', '.join(e['owners'])})" for e in rows]
        if self.skipped:
            lines.append(f"- 제외 {len(self.skipped)}건")
            lines += [f"  - {disp_id(s['id'])}: {s['reason']}" for s in self.skipped]
        if self.warnings:
            lines.append("- 경고")
            lines += [f"  - {w}" for w in self.warnings]
        return lines

    def manifest(self):
        return {
            "format": FORMAT, "version": VERSION,
            "created": datetime.now().astimezone().isoformat(timespec="seconds"),
            "source": {"host": socket.gethostname(), "os": sys.platform, "home": HOME,
                       "claude_home": CLAUDE_HOME, "desktop_dir": self.desktop_dir},
            "tokens": {tok: base for tok, base, _ in self.tokens},
            "items": [{k: v for k, v in it.items() if not k.startswith("_")} for it in self.items],
            "skipped": self.skipped,
            "plugins": self.plugins,
            "external": self.external,
        }


SINGLE = {"cc.claude-md", "cc.keybindings", "cc.settings", "cc.settings-local", "cm.store"}
EXT_ORDER = ["mcp", "hook", "statusline", "plugin-dirs", "env", "library"]
EXT_LABELS = {"mcp": "MCP 서버", "hook": "훅", "statusline": "statusLine",
              "plugin-dirs": "플러그인 폴더 (CLAUDE_CODE_PLUGIN_DIRS)", "env": "settings env",
              "library": "config-monitor 라이브러리"}
SCOPE_LABELS = {"cc.mcp-user": "Claude Code", "desk.mcp": "Desktop"}
SCOPE_ORDER = list(SCOPE_LABELS)
TOKEN_NAMES = {"${HOME}", "${CLAUDE_HOME}", "${DESKTOP_DIR}"}


def disp_id(iid: str) -> str:
    """보고용: 'cc.mcp-user/remote-memory' -> 'MCP 서버 (Claude Code) remote-memory'."""
    cat, _, name = iid.partition("/")
    label = LABELS.get(cat) or ("플러그인 선언" if cat == "cc.plugins" else cat)
    return f"{label} {name}".strip()


# ── 번들 쓰기 ────────────────────────────────────────────────────────────────

def _entries(col, include_secrets, mbytes):
    """(번들 안 상대경로, bytes 또는 원본 파일 경로)."""
    yield "manifest.json", mbytes
    yield "report.json", json.dumps({"lines": col.report(), "external": col.external,
                                     "skipped": col.skipped}, ensure_ascii=False, indent=2).encode("utf-8")
    for it in col.items:
        if it["strategy"] == "json-keys":
            yield f"json/{it['id']}.json", json.dumps(it["_json"], ensure_ascii=False, indent=2).encode("utf-8")
        elif it["strategy"] == "file":
            yield f"files/{it['rel']}", it["_src"]
        else:
            for root, _dirs, files in os.walk(it["_src"]):
                for fn in files:
                    fp = os.path.join(root, fn)
                    yield f"files/{it['rel']}/{os.path.relpath(fp, it['_src']).replace(os.sep, '/')}", fp
    if include_secrets and col.secrets:
        yield "secrets.json", json.dumps(col.secrets, ensure_ascii=False, indent=2).encode("utf-8")


def write_bundle(col, out, include_secrets):
    """번들 해시(= manifest 바이트 해시, import 의 plan_id 와 같은 기준)를 돌려준다."""
    tmp = f"{out}.{os.getpid()}.tmp"
    mbytes = json.dumps(col.manifest(), ensure_ascii=False, indent=2).encode("utf-8")
    try:
        if out.lower().endswith(".cmbundle"):
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
                for name, src in _entries(col, include_secrets, mbytes):
                    if isinstance(src, bytes):
                        z.writestr(name, src)
                    else:
                        z.write(src, name)
        else:
            for name, src in _entries(col, include_secrets, mbytes):
                dst = os.path.join(tmp, *name.split("/"))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if isinstance(src, bytes):
                    with open(dst, "wb") as f:
                        f.write(src)
                else:
                    shutil.copyfile(src, dst)
        os.replace(tmp, out)
        return _sha(mbytes)
    except BaseException:
        if os.path.isdir(tmp):
            shutil.rmtree(tmp, ignore_errors=True)
        elif os.path.exists(tmp):
            os.remove(tmp)
        raise


# ── 번들 읽기 ────────────────────────────────────────────────────────────────

class BundleError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _safe_member(name):
    """번들은 공유 폴더에서 오는 입력이다. 상대 이동·드라이브·역슬래시가 섞인 이름은 받지 않는다."""
    parts = name.split("/")
    if not name or "\\" in name or any(p in ("", ".", "..") or ":" in p for p in parts):
        raise BundleError("bundle_invalid", f"번들 안 경로가 유효하지 않음: {name}")
    return parts


class Bundle:
    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.zip = None
        if os.path.isfile(self.path) and zipfile.is_zipfile(self.path):
            self.zip = zipfile.ZipFile(self.path)
        elif not os.path.isdir(self.path):
            raise BundleError("bundle_invalid", f"번들이 아님(폴더나 .cmbundle zip 이어야 함): {self.path}")
        raw = self.read("manifest.json")
        try:
            m = json.loads(raw.decode("utf-8-sig"))
        except ValueError as e:
            raise BundleError("bundle_invalid", f"manifest.json 을 읽지 못함: {e}")
        if not isinstance(m, dict) or m.get("format") != FORMAT:
            raise BundleError("bundle_invalid", f"cmbundle manifest 가 아님: {self.path}")
        if m.get("version") != VERSION:
            raise BundleError("bundle_version", f"번들 버전 {m.get('version')} 은 읽지 못함(지원: {VERSION})")
        self.manifest, self.hash = m, _sha(raw)
        self.secrets = self.json("secrets.json") if self.exists("secrets.json") else {}

    def _fs(self, name):
        return os.path.join(self.path, *_safe_member(name))

    def exists(self, name):
        if self.zip:
            _safe_member(name)
            return name in self.zip.NameToInfo
        return os.path.isfile(self._fs(name))

    def read(self, name):
        try:
            if self.zip:
                _safe_member(name)
                return self.zip.read(name)
            with open(self._fs(name), "rb") as f:
                return f.read()
        except (KeyError, FileNotFoundError):
            raise BundleError("bundle_invalid", f"번들에 없음: {name}")

    def json(self, name):
        try:
            return json.loads(self.read(name).decode("utf-8-sig"))
        except ValueError as e:
            raise BundleError("bundle_invalid", f"{name} 을 읽지 못함: {e}")

    def tree(self, rel):
        """[(트리 안 상대경로, bytes)]."""
        pref = f"files/{rel}/"
        if self.zip:
            names = [n for n in self.zip.namelist() if n.startswith(pref) and not n.endswith("/")]
        else:
            base, names = self._fs(f"files/{rel}"), []
            for root, _dirs, files in os.walk(base):
                names += [pref + os.path.relpath(os.path.join(root, fn), base).replace(os.sep, "/") for fn in files]
        out = []
        for n in names:
            _safe_member(n[len(pref):])
            out.append((n[len(pref):], self.read(n)))
        return out


# ── import plan ─────────────────────────────────────────────────────────────

PH = re.compile(r"^\$\{CM_SECRET:([^:}]+):([^}]*)\}$")
DIFF_MAX = 400
STORE_KEYS = ("libraries", "remotes", "marketplaces", "ui")
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
# cc.refs 가 쓰면 안 되는 ~/.claude 바로 아래 이름. 설정 파일은 병합 경로로만 바꾸고 상태 폴더는 건드리지 않는다.
REF_DENY = {"settings.json", "settings.local.json", "plugins", "projects", "backups", "history.jsonl"}
CAT_SUB = {c: (sub, d) for c, sub, _l, d in TREE_CATS}
CAT_FILE = {c: fn for c, fn, _l in FILE_CATS}


def _read_bytes(p):
    try:
        with open(p, "rb") as f:
            return f.read()
    except (FileNotFoundError, IsADirectoryError, PermissionError):
        return None


def text_diff(a, b):
    if b"\0" in (a or b"") or b"\0" in (b or b""):
        return ["(바이너리 파일)"]
    lines = list(difflib.unified_diff(cas._diff_lines(a or b""), cas._diff_lines(b or b""),
                                      "현재", "번들", lineterm="", n=2))
    return lines[:DIFF_MAX] + ([f"... {len(lines) - DIFF_MAX}줄 생략"] if len(lines) > DIFF_MAX else [])


def json_diff(a, b):
    dump = lambda o: json.dumps(o, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
    return text_diff(dump(a), dump(b))


def resolve_secrets(obj, sources):
    """자리표시자를 값으로 바꾼다. sources 는 {item id: {경로: 값}} 목록이고 앞쪽이 우선. 못 푼 경로도 돌려준다."""
    missing = []

    def fn(s):
        m = PH.match(s)
        if not m:
            return s
        for src in sources:
            v = (src.get(m.group(1)) or {}).get(m.group(2))
            if isinstance(v, str):
                return v
        missing.append(m.group(2))
        return s
    return map_strings(obj, fn), missing


def _is_hook_entry(x):
    return isinstance(x, dict) and isinstance(x.get("hooks"), list)


def _entry_key(x):
    return _canon({k: v for k, v in x.items() if k != "hooks"})


def union(cur, inc):
    """배열은 합집합(대상 순서 유지). 훅 항목은 matcher 가 같으면 한 항목 안에서 hooks 를 합친다 -
    따로 붙이면 같은 훅이 두 번 돈다."""
    out = list(cur)
    for x in inc:
        if any(_canon(x) == _canon(y) for y in out):
            continue
        if _is_hook_entry(x):
            j = next((i for i, y in enumerate(out) if _is_hook_entry(y) and _entry_key(y) == _entry_key(x)), None)
            if j is not None:
                out[j] = {**out[j], "hooks": union(out[j]["hooks"], x["hooks"])}
                continue
        out.append(x)
    return out


def merge(cur, inc, take, conflicts, path=""):
    """객체는 키 단위, 배열은 합집합, 스칼라가 다르면 take(path) 가 참일 때만 번들 값."""
    if isinstance(cur, dict) and isinstance(inc, dict):
        out = dict(cur)
        for k, v in inc.items():
            sub = f"{path}.{k}" if path else k
            out[k] = merge(cur[k], v, take, conflicts, sub) if k in cur else v
        return out
    if isinstance(cur, list) and isinstance(inc, list):
        return union(cur, inc)
    if cur == inc:
        return cur
    conflicts.append(path)
    return inc if take(path) else cur


def _same_val(a, b):
    """경로 표기(대소문자·구분자·겹친 구분자)만 다른 값은 같은 값이다."""
    if isinstance(a, str) and isinstance(b, str):
        return a == b or _norm_cmd(a) == _norm_cmd(b)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same_val(x, y) for x, y in zip(a, b))
    return a == b


def merge_server(cur, inc, take, conflicts):
    """이 PC 에서 동작 중인 MCP 서버에 번들 서버를 합친다. 이 PC 에만 있는 키(env 포함)는 남기고, 번들에만 있는
    키는 더하고, 둘 다 있는데 다르면 conflicts 에 올리고 take(path) 일 때만 번들 값. 통째로 바꾸면
    이 PC 에만 있는 env(라이브러리 폴더 등)가 사라진다."""
    out = dict(cur)
    for k, v in inc.items():
        if k not in cur:
            out[k] = v
        elif k == "env" and isinstance(cur[k], dict) and isinstance(v, dict):
            env = dict(cur[k])
            for ek, ev in v.items():
                if ek not in env:
                    env[ek] = ev
                elif not _same_val(env[ek], ev):
                    conflicts.append(f"env.{ek}")
                    if take(f"env.{ek}"):
                        env[ek] = ev
            out[k] = env
        elif not _same_val(cur[k], v):
            conflicts.append(k)
            if take(k):
                out[k] = v
    return out


def chooser(choice):
    if isinstance(choice, dict):
        return lambda p: choice.get(p) == "take"
    return lambda p: choice == "take"


def merge_store(cur, inc, store, take, conflicts):
    """libraries 는 경로 합집합. remotes·marketplaces 는 대상에 없는 id 만 보태고 캐시는 이 PC 스토어
    자리로 둔다(라이브러리 fetch 가 그 자리에 받는다). ui 는 일반 병합. (병합 결과, 새로 보탠 origin)."""
    libs = list(cur.get("libraries") or [])
    seen = {lib_store.norm(x) for x in libs if isinstance(x, str)}
    for x in inc.get("libraries") or []:
        if isinstance(x, str) and lib_store.norm(x) not in seen:
            libs.append(x)
            seen.add(lib_store.norm(x))
    added = []
    rem, mks = list(cur.get("remotes") or []), list(cur.get("marketplaces") or [])
    have_r = {r.get("id") for r in rem if isinstance(r, dict)}
    have_m = {m.get("id") for m in mks if isinstance(m, dict)}
    for r in inc.get("remotes") or []:
        rid = isinstance(r, dict) and r.get("id")
        if rid and SAFE_ID.match(rid) and rid not in have_r:
            rem.append({**{k: r.get(k) for k in STORE_REMOTE_KEYS},
                        "cache": os.path.join(store, "lib-cache", "remotes", rid), "sha": None, "fetched_at": None})
            added.append(f"remote:{rid}")
    for m in inc.get("marketplaces") or []:
        mid = isinstance(m, dict) and m.get("id")
        if mid and SAFE_ID.match(mid) and mid not in have_m:
            mks.append({**{k: m.get(k) for k in STORE_MARKET_KEYS}, "cache": None, "plugins": []})
            added.append(f"market:{mid}")
    ui = merge(cur.get("ui") or {}, inc.get("ui") or {}, take, conflicts, "ui")
    return {"libraries": libs, "remotes": rem, "marketplaces": mks, "ui": ui}, added


def _mask(cat, iid, obj):
    return prepare_json(cat, iid, obj, None)[0] if isinstance(obj, dict) else obj


class ProjectMissing(Exception):
    pass


class Planner:
    """번들 항목마다 이 PC 의 현재 상태와 비교한다. 아무것도 쓰지 않는다(스냅샷·스토어 초기화 경로도
    타지 않는다). 각 항목의 _fp 는 plan 이 읽은 대상 상태의 지문이고 plan_id 가 이를 묶는다."""

    def __init__(self, bundle, store, secrets=None, choices=None, roots=None, exclude=None):
        self.b = bundle
        self.store = store
        self.secrets = secrets or {}
        self.choices = choices or {}
        self.roots_arg = roots or {}            # {from: to | ""} - "" 는 이 루트를 맞추지 않음
        self.exclude = set(exclude or ())       # 체크를 끈 훅 id
        self.desktop_dir = paths.resolve_desktop_dir()
        self.desktop_config = os.path.join(self.desktop_dir, paths.DESKTOP_CONFIG_NAME)
        self.tokens = make_tokens(self.desktop_dir)
        self.items, self.warnings, self.external = [], [], []
        self.pmap, self.roots, self.unresolved, self.missing, self.explicit = PathMap([]), [], [], [], {}
        self.incoming = []                      # 이 번들이 쓰는 파일·폴더 자리 - 적용하면 생긴다
        src = bundle.manifest.get("source") or {}
        self.source_key = f"{src.get('host') or ''}|{src.get('home') or ''}"
        self._files = {}

    def detok(self, obj):
        return map_strings(obj, lambda s: detokenize(s, self.tokens))

    def alive(self, p):
        """이 PC 에 있거나, 이 가져오기가 함께 만들 자리(~/.claude 의 훅 스크립트 등)면 산 경로다."""
        return _exists(p) or any(_under(os.path.expanduser(p), t) for t in self.incoming)

    def remap(self, obj, used=None):
        return map_strings(obj, lambda s: self.pmap.sub(s, used))

    def _local_libs(self):
        libs = [p.strip() for p in os.environ.get("CLAUDE_CONFIG_LIBRARIES", "").split(os.pathsep) if p.strip()]
        try:
            libs += [x for x in lib_store.load_cfg(self.store).get("libraries") or [] if isinstance(x, str)]
        except (OSError, ValueError):
            pass
        return [x for x in libs if os.path.isdir(x)]

    def setup_paths(self):
        """번들 external 가운데 이 PC 에 없는 경로의 짝을 정한다. 우선순위: 이번 요청의 roots > 저장된 짝
        (사람·Claude 가 확정한 것) > 추정. 사람이 끈 루트("")는 추정이 다시 채우지 않는다."""
        ext = []
        for e in self.b.manifest.get("external") or []:
            if isinstance(e, dict):
                tok = str(e.get("token") or e.get("path") or "")
                ext.append((e, tok, _norm_disp(os.path.expanduser(detokenize(tok, self.tokens)))))
        self.missing = [p for _e, tok, p in ext if not tok.startswith("${") and not _exists(p)]
        try:
            saved = ((lib_store.load_cfg(self.store).get("import_roots") or {}).get(self.source_key) or {})
        except (OSError, ValueError):
            saved = {}
        chosen = {}
        for f, v in saved.items():
            if isinstance(v, dict) and isinstance(f, str):
                chosen[os.path.normpath(f)] = (v.get("to") or "", v.get("by") or "user")
        for f, t in self.roots_arg.items():
            if isinstance(f, str) and isinstance(t, str):
                chosen[os.path.normpath(f)] = (t.strip(), "user")
                self.explicit[os.path.normpath(f)] = t.strip()
        report, pairs = [], []
        for f, (t, by) in chosen.items():
            err = None
            if not os.path.isabs(f):
                err = "절대경로가 아님"
            elif t and not (os.path.isabs(t) and os.path.isdir(t)):
                err = "이 PC 에 없는 폴더"
            if err:
                report.append({"from": f, "to": t or None, "source": by, "error": err})
                self.explicit.pop(f, None)
                continue
            report.append({"from": f, "to": t or None, "source": by})
            if t:
                pairs.append((f, t))
        rest = [p for p in self.missing if not any(_under(p, r["from"]) for r in report if not r.get("error"))]
        libs = [p for e, _t, p in ext if e.get("kind") == "library"]
        inferred = infer_roots(rest, libs, self._local_libs())
        pairs += [(r["from"], r["to"]) for r in inferred]
        report += [{k: r[k] for k in ("from", "to", "source")} for r in inferred]
        self.pmap = PathMap(pairs)
        # 경로마다 가장 긴 루트 하나에만 센다(겹치는 루트가 같은 경로를 두 번 세지 않게).
        live = [r for r in report if not r.get("error")]
        for r in live:
            r["total"] = r["resolved"] = 0
        orphans = []
        for p in self.missing:
            own = max((r for r in live if _under(p, r["from"])), key=lambda r: len(r["from"]), default=None)
            if own is None:
                orphans.append(p)
                continue
            own["total"] += 1
            own["resolved"] += bool(own["to"] and _exists(_rebase(p, own["from"], own["to"])))
        # 짝이 없는 경로는 가장 위의 없는 폴더로 묶어 빈 칸 줄로 낸다 - 사람이나 Claude 가 채울 자리다.
        for p in orphans:
            top = _top_missing(p, _exists) or p
            r = next((x for x in report if x["source"] == "none" and _ncase(x["from"]) == _ncase(top)), None)
            if r is None:
                r = {"from": top, "to": None, "source": "none", "total": 0, "resolved": 0}
                report.append(r)
            r["total"] += 1
        self.roots = report
        for e, tok, p in ext:
            q = _norm_disp(self.pmap.sub(p))
            row = {**{k: e.get(k) for k in ("kind", "owners", "scopes", "fields")},
                   "path": q, "source_path": e.get("path"), "exists": _exists(q), "in_home": tok.startswith("${")}
            if _ncase(q) != _ncase(p):
                row["mapped_from"] = p
            self.external.append(row)
        self.unresolved = [{k: e[k] for k in ("path", "kind", "owners", "source_path", "in_home")}
                           for e in self.external if not e["exists"]]

    def json_file(self, p):
        """(내용 또는 None, 오류 문구 또는 None)."""
        if p not in self._files:
            try:
                self._files[p] = (_load(p), None) if os.path.isfile(p) else (None, None)
            except (OSError, ValueError) as e:
                self._files[p] = (None, f"대상 파일을 읽지 못함: {p} ({e})")
        return self._files[p]

    def target_of(self, it):
        cat, rel = it.get("category"), it.get("rel") or ""
        head, _, tail = rel.partition("/")
        bad = BundleError("bundle_invalid", f"{it.get('id')}: 쓰기 경로가 허용 범위 밖: {rel}")
        if head != "${CLAUDE_HOME}" or not tail:
            raise bad
        parts = _safe_member(tail)
        if cat in CAT_SUB:
            sub, dirs_only = CAT_SUB[cat]
            ok = len(parts) == 2 and parts[0] == sub and not parts[1].startswith(".") and \
                (cat != "cc.skills" or parts[1] not in paths.RESERVED_SKILL_DIRS) and \
                (it["strategy"] == "tree" or not dirs_only)
        elif cat in CAT_FILE:
            ok = parts == [CAT_FILE[cat]] and it["strategy"] == "file"
        elif cat == "cc.agent-memory":
            ok = len(parts) == 2 and parts[0] == "agent-memory" and not parts[1].startswith(".") and \
                it["strategy"] == "tree"
        elif cat == "cc.project-memory":
            if not (len(parts) == 3 and parts[0] == "projects" and parts[2] == "memory" and it["strategy"] == "tree"
                    and isinstance(it.get("project"), str) and it["project"]):
                raise bad
            from claude_config import _encode_project_dir
            proj = _norm_disp(self.pmap.sub(detokenize(it["project"], self.tokens)))
            if not os.path.isdir(proj):
                raise ProjectMissing(proj)
            return os.path.join(CLAUDE_HOME, "projects", _encode_project_dir(proj), "memory")
        elif cat == "cc.refs":
            ok = parts[0] not in REF_DENY and not parts[0].startswith(".") and \
                not (parts[0] == "skills" and len(parts) > 1 and parts[1] in paths.RESERVED_SKILL_DIRS)
        else:
            ok = False
        if not ok:
            raise bad
        return os.path.join(CLAUDE_HOME, *parts)

    def run(self):
        m = self.b.manifest
        for it in m.get("items") or []:
            if isinstance(it, dict) and it.get("strategy") in ("file", "tree"):
                try:
                    self.incoming.append(self.target_of(it))
                except (BundleError, ProjectMissing):
                    pass                        # 그 항목의 plan 이 같은 사유로 막는다
        self.setup_paths()
        for it in m.get("items") or []:
            if not isinstance(it, dict) or not isinstance(it.get("id"), str):
                raise BundleError("bundle_invalid", "manifest items 형식이 아님")
            row = {"id": it["id"], "category": it.get("category"), "strategy": it.get("strategy")}
            row.update(self._plan(it))
            self.items.append(row)
        for s in m.get("skipped") or []:
            if isinstance(s, dict):
                self.items.append({"id": s.get("id"), "category": str(s.get("id")).partition("/")[0],
                                   "state": "skipped", "reason": s.get("reason")})
        if self.unresolved:
            self.warnings.append(f"이 PC 에 없는 경로 {len(self.unresolved)}개 - 그 경로를 쓰는 훅·MCP 서버는 빼고 가져옵니다")
        cats = {r["category"] for r in self.items if r.get("state") in ("new", "changed")}
        if cats & set(MCP_CATS):
            self.warnings.append("Claude Code·Desktop 이 실행 중이면 적용 직후 설정 파일을 다시 쓸 수 있습니다. 적용 뒤 재시작하세요")
        if "desk.mcp" in cats and not os.path.isdir(self.desktop_dir):
            self.warnings.append(f"Claude Desktop 설치 폴더가 없어 새로 만듭니다: {self.desktop_dir}")
        if not os.path.isfile(lib_store.store_config_path(self.store)):
            self.warnings.append(f"스토어가 아직 없어 적용할 때 새로 만듭니다: {self.store}")
        fps = "".join(f"{r['id']}\0{r['_fp']}\n" for r in sorted(self.items, key=lambda r: r["id"]) if "_fp" in r)
        # 경로 짝은 화면에 보인 값 자체를 바꾸므로 plan_id 에 묶는다 - 다른 짝으로 apply 하면 plan_stale.
        # 끈 훅(exclude)은 ids 와 같은 선택이라 묶지 않는다(비교 뒤 체크를 바꿔도 적용할 수 있어야 한다).
        fps += _canon(self.pmap.pairs).decode("utf-8")
        self.plan_id = _sha((self.b.hash + "\n" + fps).encode("utf-8"))[7:23]
        return self

    def _plan(self, it):
        s, cat = it.get("strategy"), it.get("category")
        if s == "file":
            return self._plan_file(it)
        if s == "tree":
            return self._plan_tree(it)
        if s == "json-keys" and cat in SETTINGS_CATS:
            return self._plan_settings(it)
        if s == "json-keys" and cat in MCP_CATS:
            return self._plan_mcp(it)
        if s == "json-keys" and cat == "cm.store":
            return self._plan_store(it)
        raise BundleError("bundle_invalid", f"알 수 없는 항목: {it['id']}")

    def _plan_file(self, it):
        tgt = self.target_of(it)
        data = self.b.read(f"files/{it['rel']}")
        if _sha(data) != it.get("hash"):
            raise BundleError("bundle_invalid", f"{it['id']}: 내용 해시가 manifest 와 다름")
        if os.path.isdir(tgt):
            return {"target": tgt, "state": "blocked", "reason": "같은 이름의 폴더가 있음", "_fp": "dir"}
        cur = _read_bytes(tgt)
        row = {"target": tgt, "_fp": _sha(cur) if cur is not None else None, "_data": data}
        if cur is None:
            row["state"] = "new"
        elif row["_fp"] == it["hash"]:
            row["state"] = "same"
        else:
            row.update(state="changed", diff=text_diff(cur, data))
        return row

    def _plan_tree(self, it):
        try:
            tgt = self.target_of(it)
        except ProjectMissing as e:
            return {"target": str(e), "state": "blocked", "code": "project_missing", "_fp": "missing",
                    "reason": f"이 PC 에 대상 프로젝트가 없음: {e}"}
        files = self.b.tree(it["rel"])
        rows = [(r, _sha(d)) for r, d in files]
        if tree_digest(rows) != it.get("hash"):
            raise BundleError("bundle_invalid", f"{it['id']}: 내용 해시가 manifest 와 다름")
        if os.path.isfile(tgt):
            return {"target": tgt, "state": "blocked", "reason": "같은 이름의 파일이 있음", "_fp": "file"}
        cur = tree_rows(tgt)[0] if os.path.isdir(tgt) else None
        row = {"target": tgt, "_fp": tree_digest(cur) if cur is not None else None, "_data": files}
        if cur is None:
            row["state"] = "new"
        elif row["_fp"] == it["hash"]:
            row["state"] = "same"
        else:
            a, c = dict(rows), dict(cur)
            row.update(state="changed", files={"added": sorted(set(a) - set(c)), "removed": sorted(set(c) - set(a)),
                                               "modified": sorted(k for k in a if k in c and a[k] != c[k])})
        return row

    def _plan_settings(self, it):
        iid, cat = it["id"], it["category"]
        tgt = os.path.join(CLAUDE_HOME, "settings.json" if cat == "cc.settings" else "settings.local.json")
        cur, err = self.json_file(tgt)
        if err or (cur is not None and not isinstance(cur, dict)):
            return {"target": tgt, "state": "blocked", "reason": err or "대상 파일이 JSON 객체가 아님", "_fp": "bad"}
        inc = self.detok(self.b.json(f"json/{iid}.json"))
        if not isinstance(inc, dict):
            raise BundleError("bundle_invalid", f"{iid}: JSON 객체가 아님")
        cur_d = cur or {}
        inc, missing = resolve_secrets(inc, [self.secrets, self.b.secrets, {iid: prepare_json(cat, iid, cur_d, None)[1]}])
        row = {"target": tgt, "_fp": _sha(_canon(cur)) if cur is not None else None}
        if missing and isinstance(inc.get("env"), dict):
            left = {k: v for k, v in inc["env"].items() if not (isinstance(v, str) and PH.match(v))}
            row["warnings"] = ["시크릿 값이 없어 env 의 다음 키는 가져오지 않음: " +
                               ", ".join(k for k in inc["env"] if k not in left)]
            inc = {**inc, "env": left}
        used = set()
        inc, hooks, dropped = self._adapt_settings(inc, cur_d, used)
        conflicts = []
        merged = merge(cur_d, inc, chooser(self.choices.get(iid)), conflicts)
        row["_value"] = merged
        if hooks:
            row["hooks"] = hooks
        if dropped:
            row["dropped"] = dropped
        if used:
            row["remapped"] = [{"from": f, "to": t} for f, t in sorted(used)]
        if cur is None:
            row["state"] = "new"
        elif merged == cur_d and not conflicts:
            row["state"] = "same"
        else:
            row.update(state="changed", diff=json_diff(_mask(cat, iid, cur_d), _mask(cat, iid, merged)))
        if conflicts:
            row["conflicts"] = conflicts
        return row

    def _adapt_settings(self, inc, cur_d, used):
        """(이 PC 에 맞춘 inc, 훅 줄, 뺀 것). 훅은 명령 하나가 한 줄이다.
        이 PC 에 없는 경로를 쓰는 훅은 불가, 이 PC 에 이미 같은 훅이 있으면 동일, 나머지는 신규."""
        have = set()
        for ev, ents in (cur_d.get("hooks") or {}).items() if isinstance(cur_d.get("hooks"), dict) else ():
            for e in ents if isinstance(ents, list) else ():
                for h in e["hooks"] if _is_hook_entry(e) else ():
                    if isinstance(h, dict) and isinstance(h.get("command"), str):
                        have.add((ev, _norm_cmd(h["command"])))
        subs, dropped, hooks = [], [], {}
        src = inc.get("hooks") if isinstance(inc.get("hooks"), dict) else {}
        for ev, ents in src.items():
            if not isinstance(ents, list):
                hooks[ev] = ents
                continue
            keep = []
            for e in ents:
                if not _is_hook_entry(e):
                    keep.append(self.remap(e, used))
                    continue
                kept = []
                for h in e["hooks"]:
                    if not (isinstance(h, dict) and isinstance(h.get("command"), str)):
                        kept.append(h)
                        continue
                    mine = set()
                    cmd = self.pmap.sub(h["command"], mine)
                    norm = _norm_cmd(cmd)
                    sub = {"id": _hook_id(ev, norm), "event": ev, "matcher": e.get("matcher"), "command": cmd}
                    if mine:
                        sub["remapped"] = [{"from": f, "to": t} for f, t in sorted(mine)]
                    dead = _dead(cmd, alive=self.alive)
                    if dead:
                        sub.update(state="blocked", code="path_missing", target=dead[0])
                        dropped.append({"what": "hook", "event": ev, "target": dead[0]})
                    elif (ev, norm) in have:
                        sub.update(state="same", code="dup")
                    else:
                        sub["state"] = "new"
                        if sub["id"] in self.exclude:
                            sub["excluded"] = True
                        else:
                            kept.append({**h, "command": cmd})
                            used |= mine
                    subs.append(sub)
                if kept:
                    keep.append({**e, "hooks": kept})
            if keep:
                hooks[ev] = keep
        out = {}
        for k, v in inc.items():
            if k != "hooks":
                out[k] = self.remap(v, used)
            elif hooks:
                out[k] = hooks
        sl = out.get("statusLine")
        dead = _dead(sl["command"], alive=self.alive) if isinstance(sl, dict) and isinstance(sl.get("command"), str) else []
        if dead:
            dropped.append({"what": "statusLine", "target": dead[0]})
            out.pop("statusLine")
        env = out.get("env")
        if isinstance(env, dict) and isinstance(env.get("CLAUDE_CODE_PLUGIN_DIRS"), str):
            parts = [x for x in env["CLAUDE_CODE_PLUGIN_DIRS"].split(";") if x.strip()]
            alive = [x for x in parts if not _dead(x, alive=self.alive)]
            dropped += [{"what": "plugin-dir", "target": x.strip()} for x in parts if x not in alive]
            env = dict(env)
            if alive:
                env["CLAUDE_CODE_PLUGIN_DIRS"] = ";".join(alive)
            else:
                env.pop("CLAUDE_CODE_PLUGIN_DIRS")
            out["env"] = env
        return out, subs, dropped

    def _plan_mcp(self, it):
        iid, cat = it["id"], it["category"]
        key, name = it.get("key") or "", iid.partition("/")[2]
        if key != f"mcpServers.{name}" or not name:
            raise BundleError("bundle_invalid", f"{iid}: key 가 서버 이름과 맞지 않음")
        tgt = CLAUDE_JSON if cat == "cc.mcp-user" else self.desktop_config
        doc, err = self.json_file(tgt)
        if err or (doc is not None and not isinstance(doc, dict)):
            return {"target": tgt, "state": "blocked", "reason": err or "대상 파일이 JSON 객체가 아님", "_fp": "bad"}
        servers = (doc or {}).get("mcpServers")
        cur = servers.get(name) if isinstance(servers, dict) else None
        inc = self.detok(self.b.json(f"json/{iid}.json"))
        if not isinstance(inc, dict):
            raise BundleError("bundle_invalid", f"{iid}: JSON 객체가 아님")
        tfound = prepare_json(cat, iid, cur, None)[1] if isinstance(cur, dict) else {}
        inc, missing = resolve_secrets(inc, [self.secrets, self.b.secrets, {iid: tfound}])
        used = set()
        inc = self.remap(inc, used)
        row = {"target": tgt, "key": name, "_fp": _sha(_canon(cur)) if cur is not None else None, "_value": inc}
        if used:
            row["remapped"] = [{"from": f, "to": t} for f, t in sorted(used)]
        dead = _dead_server(name, inc, self.alive)
        cur_ok = isinstance(cur, dict) and not _dead_server(name, cur, self.alive)
        conflicts = []
        if cur_ok and not dead:
            inc = merge_server(cur, inc, chooser(self.choices.get(iid)), conflicts)
            row["_value"] = inc
        if cur is None:
            row["state"] = "new"
        elif isinstance(cur, dict) and not conflicts and (
                _canon(cur) == _canon(inc) or
                _sha(_canon(prepare_json(cat, iid, cur, self.tokens)[0])) == it.get("hash")):
            row["state"] = "same"
        else:
            row.update(state="changed", diff=json_diff(_mask(cat, iid, cur), _mask(cat, iid, inc)))
        if conflicts:
            row["conflicts"] = conflicts
        if dead and row["state"] != "same":
            if cur_ok:
                row.update(state="blocked", code="keep_working", missing_paths=dead,
                           reason=f"이 PC 의 값은 동작하고 번들 값은 이 PC 에 없는 경로를 가리켜 바꾸지 않음: {dead[0]}")
            else:
                row.update(state="blocked", code="path_missing", missing_paths=dead,
                           reason=f"이 PC 에 없는 경로: {dead[0]}")
        if missing and row["state"] not in ("same", "blocked"):
            row.update(state="blocked", code="secret_missing", missing_secrets=missing,
                       reason="시크릿 값이 없음: " + ", ".join(missing))
        return row

    def _plan_store(self, it):
        tgt = lib_store.store_config_path(self.store)
        cur, err = self.json_file(tgt)
        if err or (cur is not None and not isinstance(cur, dict)):
            return {"target": tgt, "state": "blocked", "reason": err or "대상 파일이 JSON 객체가 아님", "_fp": "bad"}
        inc = self.detok(self.b.json("json/cm.store.json"))
        if not isinstance(inc, dict):
            raise BundleError("bundle_invalid", "cm.store: JSON 객체가 아님")
        used = set()
        inc = self.remap(inc, used)
        libs = [x for x in inc.get("libraries") or [] if isinstance(x, str)]
        dropped = [{"what": "library", "target": x} for x in libs if not _exists(x)]
        inc = {**inc, "libraries": [x for x in libs if _exists(x)]}
        cur_d = cur or {}
        conflicts = []
        merged, added = merge_store(cur_d, inc, self.store, chooser(self.choices.get("cm.store")), conflicts)
        before = {"libraries": cur_d.get("libraries") or [], "remotes": cur_d.get("remotes") or [],
                  "marketplaces": cur_d.get("marketplaces") or [], "ui": cur_d.get("ui") or {}}
        row = {"target": tgt, "_fp": _sha(_canon({k: cur_d.get(k) for k in STORE_KEYS})) + str(cur is not None),
               "_value": merged}
        if merged == before and not conflicts:
            row["state"] = "same"
        else:
            row.update(state="new" if cur is None else "changed", diff=json_diff(before, merged))
        if conflicts:
            row["conflicts"] = conflicts
        if added:
            row["warnings"] = ["내용을 받으려면 라이브러리 fetch 가 필요함: " + ", ".join(added)]
        if dropped:
            row["dropped"] = dropped
        if used:
            row["remapped"] = [{"from": f, "to": t} for f, t in sorted(used)]
        return row

    def public(self):
        return [{k: v for k, v in r.items() if not k.startswith("_")} for r in self.items]

    def summary(self):
        s = {k: 0 for k in ("new", "same", "changed", "blocked", "skipped")}
        for r in self.items:
            s[r["state"]] = s.get(r["state"], 0) + 1
        return s


# ── import apply / undo ─────────────────────────────────────────────────────

IMPORTS_KEEP = 50


class Changed(Exception):
    pass


def _ts():
    return datetime.now().strftime("%Y%m%d%H%M%S")


def _unique(base):
    dst, n = base, 1
    while os.path.exists(dst):
        dst, n = f"{base}.{n}", n + 1
    return dst


def _trash(path):
    """config_edit.trash 와 같은 자리(.trash/<이름>.<시각>). 같은 초에 다시 와도 겹치지 않게 번호를 붙인다."""
    tdir = os.path.join(os.path.dirname(os.path.normpath(path)), ".trash")
    os.makedirs(tdir, exist_ok=True)
    dst = _unique(os.path.join(tdir, f"{os.path.basename(os.path.normpath(path))}.{_ts()}"))
    shutil.move(path, dst)
    return dst


def _backup(path):
    if not os.path.exists(path):
        return None
    dst = _unique(f"{path}.{_ts()}.bak")
    shutil.copy2(path, dst)
    return dst


def _put_bytes(target, data):
    tmp = f"{target}.import.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, target)


def _write_file(target, data):
    """새 내용을 먼저 다 쓴 뒤 기존 것을 휴지통으로 옮기고 교체한다. (휴지통 경로 또는 None)."""
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = f"{target}.import.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    old = _trash(target) if os.path.exists(target) else None
    os.replace(tmp, target)
    return old


def _write_tree(target, files):
    parent = os.path.dirname(target)
    tmp = os.path.join(parent, f".{os.path.basename(target)}.import-{os.getpid()}")
    if os.path.isdir(tmp):
        shutil.rmtree(tmp)
    os.makedirs(tmp)
    for rel, data in files:
        dst = os.path.join(tmp, *rel.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(data)
    old = _trash(target) if os.path.exists(target) else None
    os.replace(tmp, target)
    return old


def _file_hash(p):
    b = _read_bytes(p)
    return _sha(b) if b is not None else None


def _tree_hash(p):
    return tree_digest(tree_rows(p)[0]) if os.path.isdir(p) else None


def ensure_store(store):
    """새 PC 에는 스토어가 없다. 원장과 스냅샷을 남길 자리라 cas init 과 같은 최소 구성을 만든다."""
    p = cas.store_paths(store)
    for d in (p["store"], p["objects"], p["snapshots"], p["log"]):
        os.makedirs(d, exist_ok=True)
    if not os.path.exists(p["config"]):
        cas.save_json(p["config"], {"version": 1, "store": store, "tracked": []})
    if not os.path.exists(p["index"]):
        cas.save_json(p["index"], {})
    return p


def _write_one(r):
    tgt = r["target"]
    existed = os.path.exists(tgt)
    if r["strategy"] == "file":
        old = _write_file(tgt, r["_data"])
        post = _file_hash(tgt)
    else:
        old = _write_tree(tgt, r["_data"])
        post = _tree_hash(tgt)
    return [{"id": r["id"], "kind": r["strategy"], "target": tgt, "trash": old,
             "action": "replaced" if existed else "created", "post_hash": post}]


def _write_settings(r):
    tgt = r["target"]
    existed = os.path.exists(tgt)
    bak = _backup(tgt)
    config_edit.save_atomic(tgt, r["_value"])
    return [{"id": r["id"], "kind": "json-file", "target": tgt, "backup": bak,
             "action": "merged" if existed else "created", "post_hash": _file_hash(tgt)}]


def _write_servers(tgt, group):
    """같은 파일의 서버는 한 번에 쓴다(백업·저장 1회)."""
    doc = config_edit.load(tgt)
    servers = config_edit._slot_dict(doc, "mcpServers")
    for r in group:
        servers[r["key"]] = r["_value"]
    bak = _backup(tgt)
    config_edit.save_atomic(tgt, doc)
    return [{"id": r["id"], "kind": "json-key", "target": tgt, "key": r["key"], "backup": bak,
             "action": "replaced" if r["state"] == "changed" else "created",
             "post_hash": _sha(_canon(r["_value"]))} for r in group]


def _write_store(r, store):
    with lib_store.edit_cfg(store) as cfg:
        prev = {k: cfg[k] for k in STORE_KEYS if k in cfg}
        cfg.update(r["_value"])
    return [{"id": r["id"], "kind": "store", "target": r["target"], "prev": prev, "action": "merged",
             "post_hash": _sha(_canon({k: r["_value"].get(k) for k in STORE_KEYS}))}]


def apply_rows(rows, store):
    """(적용 기록, 실패). 파일 하나가 실패해도 나머지는 계속한다."""
    jobs = [([r], lambda r=r: _write_one(r)) for r in rows if r["strategy"] in ("file", "tree")]
    jobs += [([r], lambda r=r: _write_settings(r)) for r in rows if r["category"] in SETTINGS_CATS]
    by_file = {}
    for r in rows:
        if r["category"] in MCP_CATS:
            by_file.setdefault(r["target"], []).append(r)
    jobs += [(g, lambda t=t, g=g: _write_servers(t, g)) for t, g in by_file.items()]
    jobs += [([r], lambda r=r: _write_store(r, store)) for r in rows if r["category"] == "cm.store"]
    applied, failed = [], []
    for group, fn in jobs:
        try:
            applied += fn()
        except Exception as e:                      # 실패는 결과에 담고 다음 파일로 간다
            failed += [{"id": r["id"], "code": "write_failed", "reason": f"{type(e).__name__}: {e}"} for r in group]
    return applied, failed


def undo_record(rec, force):
    kind, tgt = rec["kind"], rec["target"]
    if kind in ("file", "tree"):
        cur = _file_hash(tgt) if kind == "file" else _tree_hash(tgt)
        if cur != rec.get("post_hash") and not force:
            raise Changed(tgt)
        if os.path.exists(tgt):
            _trash(tgt)
        if rec.get("trash"):
            shutil.move(rec["trash"], tgt)
    elif kind == "json-file":
        if _file_hash(tgt) != rec.get("post_hash") and not force:
            raise Changed(tgt)
        if rec.get("backup"):
            _put_bytes(tgt, _read_bytes(rec["backup"]))
        elif os.path.exists(tgt):
            _trash(tgt)
    elif kind == "json-key":
        # 파일째 되돌리면 그 사이 Claude Code 가 이 파일에 쓴 다른 키까지 되돌아간다. 서버 하나만 되돌린다.
        doc = config_edit.load(tgt)
        servers = config_edit._slot_dict(doc, "mcpServers")
        if _sha(_canon(servers.get(rec["key"]))) != rec.get("post_hash") and not force:
            raise Changed(tgt)
        prev = ((config_edit.load(rec["backup"]).get("mcpServers") or {}).get(rec["key"])
                if rec.get("backup") else None)
        if prev is None:
            servers.pop(rec["key"], None)
        else:
            servers[rec["key"]] = prev
        config_edit.save_atomic(tgt, doc)
    elif kind == "store":
        with lib_store.edit_cfg(os.path.dirname(tgt)) as cfg:
            if _sha(_canon({k: cfg.get(k) for k in STORE_KEYS})) != rec.get("post_hash") and not force:
                raise Changed(tgt)
            for k in STORE_KEYS:
                if k in rec.get("prev", {}):
                    cfg[k] = rec["prev"][k]
                else:
                    cfg.pop(k, None)


# ── CLI ─────────────────────────────────────────────────────────────────────

def _summary_fields(col, out=None):
    return {"counts": col.counts(), "plugins": col.plugins, "external": col.external,
            "skipped": col.skipped, "warnings": col.warnings,
            "secrets": [{"item": iid, "path": k} for iid, d in col.secrets.items() for k in d],
            "include_secrets": col.include_secrets, "report": col.report(out)}


def _json_arg(v, name):
    if not v:
        return {}
    try:
        o = json.loads(v)
    except ValueError as e:
        emit(False, "invalid_arg", f"{name} JSON 파싱 실패: {e}", target=name)
    if not isinstance(o, dict):
        emit(False, "invalid_arg", f"{name} 은 JSON 객체여야 함", target=name)
    return o


def _open_bundle(path):
    try:
        return Bundle(path)
    except BundleError as e:
        emit(False, e.code, str(e), target=path)


def _exclude_arg(a):
    return [x.strip() for x in (getattr(a, "exclude", "") or "").split(",") if x.strip()]


def _make_plan(a, b):
    try:
        return Planner(b, a.store, _json_arg(a.secrets, "--secrets"), _json_arg(a.choices, "--choices"),
                       _json_arg(getattr(a, "roots", ""), "--roots"), _exclude_arg(a)).run()
    except BundleError as e:
        emit(False, e.code, str(e), target=b.path)


def _plan_message(pl):
    s = pl.summary()
    msg = (f"plan {pl.plan_id}: 신규 {s['new']} · 변경 {s['changed']} · 동일 {s['same']} · "
           f"불가 {s['blocked']} · 제외 {s['skipped']}")
    if pl.unresolved:
        msg += f". 이 PC 에 없는 경로 {len(pl.unresolved)}개는 쓰지 않음(roots 로 짝을 정하면 다시 계산)"
    return msg


def cmd_export(a):
    opts = [x.strip() for x in a.with_optional.split(",") if x.strip()]
    bad = [x for x in opts if x not in OPTIONAL]
    if bad:
        emit(False, "invalid_arg", f"알 수 없는 선택 항목: {', '.join(bad)}", target="--with-optional")
    col = Collector(a.store, [OPTIONAL[x] for x in opts],
                    include_secrets=getattr(a, "include_secrets", False)).collect()
    if col.include_secrets and col.secrets:
        col.warnings.append("시크릿 값이 secrets.json 에 평문으로 들어갑니다")

    if a.op == "inventory":
        items = [{k: v for k, v in it.items() if not k.startswith("_")} for it in col.items]
        emit(True, "ok", f"이관 대상 {len(items)}개, 외부 경로 {len(col.external)}개",
             items=items, **_summary_fields(col))

    out = os.path.abspath(a.out)
    if os.path.exists(out):
        emit(False, "exists", f"이미 있음: {out}", target=out)
    bundle_hash = write_bundle(col, out, a.include_secrets)
    extra = {"secrets_file": "secrets.json"} if a.include_secrets and col.secrets else {}
    record_export(a.store, {"at": _now_iso(), "path": out, "hash": bundle_hash, "items": len(col.items),
                            "secrets": bool(a.include_secrets and col.secrets)})
    emit(True, "ok", f"번들을 만들었습니다: {out} (항목 {len(col.items)}개, 외부 경로 {len(col.external)}개)",
         target=out, bundle=out, **extra, **_summary_fields(col, out))


EXPORTS_KEEP = 20


def record_export(store, rec):
    """위젯이 최근 번들 목록을 보여 줄 수 있게 남긴다. 스토어가 없는 PC 에서는 남기지 않는다(export 는 소스를
    바꾸지 않는다)."""
    try:
        with lib_store.edit_cfg(store) as cfg:
            ex = cfg.setdefault("exports", [])
            ex.append(rec)
            del ex[:-EXPORTS_KEEP]
    except (lib_store.StoreNotInitialized, TimeoutError, OSError, ValueError):
        pass


def cmd_history(a):
    cfg = lib_store.load_cfg(a.store)
    imports = [{"id": x.get("id"), "at": x.get("at"), "bundle": x.get("bundle"), "source_host": x.get("source_host"),
                "items": [r.get("id") for r in x.get("applied") or []], "undone_at": x.get("undone_at"),
                "undone": [r.get("id") for r in x.get("applied") or [] if r.get("undone")],
                "dropped": len(x.get("dropped") or [])}
               for x in reversed(cfg.get("imports") or [])]
    exports = list(reversed(cfg.get("exports") or []))
    emit(True, "ok", f"가져오기 기록 {len(imports)}개, 내보내기 기록 {len(exports)}개",
         imports=imports, exports=exports, sync=cfg.get("sync"))


# ── sync ────────────────────────────────────────────────────────────────────
# <sync dir>/<profile>/ 는 PC 마다 하나인 폴더 번들이다. base[<상대 profile>][<item id>] 는 그 PC 와 마지막으로
# 내용이 같았던 해시이고, 이것으로 어느 쪽이 바뀌었는지 가른다.

def _sync_cfg(store):
    s = lib_store.load_cfg(store).get("sync") or {}
    if not s.get("dir"):
        emit(False, "sync_unconfigured", "동기화 폴더가 설정되지 않았습니다. sync-setup --dir 로 정하세요")
    return s


def _profiles(d):
    out = []
    for n in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        mp = os.path.join(d, n, "manifest.json")
        if n.startswith(".") or not os.path.isfile(mp):
            continue
        try:
            m = _load(mp)
        except (OSError, ValueError):
            continue
        out.append({"profile": n, "host": (m.get("source") or {}).get("host"), "created": m.get("created"),
                    "items": len(m.get("items") or [])})
    return out


def _profile_dir(s, name):
    if not SAFE_ID.match(name or ""):
        emit(False, "invalid_arg", f"profile 이름이 유효하지 않음: {name}", target=name)
    p = os.path.join(s["dir"], name)
    if not os.path.isfile(os.path.join(p, "manifest.json")):
        emit(False, "not_found", f"동기화 폴더에 그 PC 가 없음: {name}", target=p)
    return p


def _remote_hashes(pdir):
    try:
        return {it["id"]: it.get("hash") for it in Bundle(pdir).manifest.get("items") or []}
    except BundleError as e:
        emit(False, e.code, str(e), target=pdir)


def _local_hashes(store, opts):
    return {it["id"]: it["hash"] for it in Collector(store, [OPTIONAL[x] for x in opts if x in OPTIONAL]).collect().items}


def sync_state(local, remote, base):
    if local == remote:
        return "in-sync"
    if base is None:
        return "untracked"
    if remote == base:
        return "local-ahead"
    if local == base:
        return "remote-ahead"
    return "diverged"


def _agree(cfg, profile, local, remote, taken=()):
    """내용이 같은 항목과 방금 가져온 항목(taken)의 기준을 그 PC 의 해시로 맞춘다."""
    base = cfg.setdefault("sync", {}).setdefault("base", {}).setdefault(profile, {})
    for iid in set(local) | set(remote):
        if iid in taken and remote.get(iid):
            base[iid] = remote[iid]
        elif local.get(iid) and local.get(iid) == remote.get(iid):
            base[iid] = local[iid]


def _opts(raw):
    opts = [x.strip() for x in (raw or "").split(",") if x.strip()]
    bad = [x for x in opts if x not in OPTIONAL]
    if bad:
        emit(False, "invalid_arg", f"알 수 없는 선택 항목: {', '.join(bad)}", target="--with-optional")
    return opts


def cmd_sync_setup(a):
    d = os.path.abspath(a.dir)
    if not os.path.isdir(d):
        emit(False, "not_found", f"동기화 폴더가 없음: {d}", target=d)
    profile = a.profile or re.sub(r"[^A-Za-z0-9._-]", "-", socket.gethostname())
    if not SAFE_ID.match(profile):
        emit(False, "invalid_arg", f"profile 이름이 유효하지 않음: {profile}", target=profile)
    ensure_store(a.store)
    with lib_store.edit_cfg(a.store) as cfg:
        s = cfg.setdefault("sync", {})
        s.update(dir=d, profile=profile)
        s.setdefault("base", {})
    emit(True, "ok", f"동기화 폴더: {d} (이 PC 는 {profile})", target=d,
         sync={"dir": d, "profile": profile}, profiles=_profiles(d))


def cmd_sync_push(a):
    s = _sync_cfg(a.store)
    opts = _opts(a.with_optional)
    col = Collector(a.store, [OPTIONAL[x] for x in opts], include_secrets=a.include_secrets).collect()
    if col.include_secrets and col.secrets:
        col.warnings.append("시크릿 값이 secrets.json 에 평문으로 들어갑니다")
    dst = os.path.join(s["dir"], s["profile"])
    new = os.path.join(s["dir"], f".{s['profile']}.push")
    if os.path.isdir(new):
        shutil.rmtree(new)
    h = write_bundle(col, new, a.include_secrets)
    old = None
    if os.path.isdir(dst):
        old = os.path.join(s["dir"], f".{s['profile']}.old.{os.getpid()}")
        os.replace(dst, old)
    os.replace(new, dst)
    if old:
        shutil.rmtree(old, ignore_errors=True)
    local = {it["id"]: it["hash"] for it in col.items}
    others = [p["profile"] for p in _profiles(s["dir"]) if p["profile"] != s["profile"]]
    remotes = {p: _remote_hashes(os.path.join(s["dir"], p)) for p in others}
    with lib_store.edit_cfg(a.store) as cfg:
        cfg["sync"].update(with_optional=opts, pushed_at=_now_iso())
        for p, remote in remotes.items():
            _agree(cfg, p, local, remote)
    emit(True, "ok", f"올렸습니다: {dst} (항목 {len(col.items)}개)", target=dst, bundle=dst, hash=h,
         **_summary_fields(col, dst))


def cmd_sync_status(a):
    s = _sync_cfg(a.store)
    profiles = _profiles(s["dir"])
    pub = {k: s.get(k) for k in ("dir", "profile", "pushed_at")}
    if not a.sync_from:
        emit(True, "ok", f"동기화 폴더의 PC {len(profiles)}개", target=s["dir"], sync=pub, profiles=profiles)
    remote = _remote_hashes(_profile_dir(s, a.sync_from))
    local = _local_hashes(a.store, s.get("with_optional") or [])
    base = (s.get("base") or {}).get(a.sync_from) or {}
    items = [{"id": i, "state": sync_state(local.get(i), remote.get(i), base.get(i)),
              "local": local.get(i), "remote": remote.get(i), "base": base.get(i)}
             for i in sorted(set(local) | set(remote))]
    summary = {}
    for it in items:
        summary[it["state"]] = summary.get(it["state"], 0) + 1
    emit(True, "ok", f"{a.sync_from} 와 비교: " + " · ".join(f"{k} {v}" for k, v in sorted(summary.items())),
         target=a.sync_from, sync=pub, profiles=profiles, items=items, summary=summary)


def cmd_sync_pull(a):
    s = _sync_cfg(a.store)
    a.bundle = _profile_dir(s, a.sync_from)

    def on_done(ids):
        local = _local_hashes(a.store, s.get("with_optional") or [])
        remote = _remote_hashes(a.bundle)
        with lib_store.edit_cfg(a.store) as cfg:
            _agree(cfg, a.sync_from, local, remote, set(ids))
        return {"sync_from": a.sync_from}
    cmd_apply(a, on_done)


def cmd_inspect(a):
    b = _open_bundle(a.bundle)
    m = b.manifest
    counts = {}
    for it in m.get("items") or []:
        counts[it.get("category")] = counts.get(it.get("category"), 0) + 1
    emit(True, "ok", f"번들 {os.path.basename(b.path)}: {m.get('source', {}).get('host')} 에서 "
         f"{m.get('created')} 에 만듦, 항목 {sum(counts.values())}개",
         target=b.path, bundle=b.path, hash=b.hash, created=m.get("created"), source=m.get("source"),
         counts=counts, skipped=m.get("skipped") or [], external=m.get("external") or [],
         plugins=m.get("plugins") or {}, has_secrets=bool(b.secrets))


def cmd_plan(a):
    if a.sync_from:
        a.bundle = _profile_dir(_sync_cfg(a.store), a.sync_from)
    elif not a.bundle:
        emit(False, "invalid_arg", "--bundle 이나 --sync-from 중 하나가 필요합니다", target="--bundle")
    b = _open_bundle(a.bundle)
    pl = _make_plan(a, b)
    emit(True, "ok", _plan_message(pl), target=b.path, bundle=b.path, plan_id=pl.plan_id,
         source=b.manifest.get("source"), items=pl.public(), summary=pl.summary(),
         external=pl.external, warnings=pl.warnings, roots=pl.roots, unresolved=pl.unresolved)


def _dropped(pl, sel_ids):
    """이 PC 에 없는 경로 때문에 들이지 않은 것. 고른 항목 안에서 뺀 훅·statusLine 등과, 통째로 막힌 서버."""
    out = []
    for r in pl.items:
        if r["id"] in sel_ids:
            out += [{"id": r["id"], **d} for d in r.get("dropped") or []]
        if r.get("code") in ("path_missing", "keep_working"):
            out.append({"id": r["id"], "what": "item", "code": r["code"], "target": (r.get("missing_paths") or [""])[0]})
    return out


def save_roots(store, key, roots, by):
    """확정된 짝만 남긴다(추정은 매번 다시 계산하면 같은 답이라 남길 필요가 없다)."""
    if not roots:
        return
    ensure_store(store)
    with lib_store.edit_cfg(store) as cfg:
        cfg.setdefault("import_roots", {}).setdefault(key, {}).update(
            {f: {"to": t, "by": by, "at": _now_iso()} for f, t in roots.items()})


def cmd_roots(a):
    """Claude·사람이 정한 경로 짝을 확인해 저장한다. 다음 plan 이 이 짝을 쓴다. 설정 파일은 바꾸지 않는다."""
    if a.sync_from:
        a.bundle = _profile_dir(_sync_cfg(a.store), a.sync_from)
    elif not a.bundle:
        emit(False, "invalid_arg", "--bundle 이나 --sync-from 중 하나가 필요합니다", target="--bundle")
    b = _open_bundle(a.bundle)
    pl = Planner(b, a.store)
    pl.setup_paths()
    results, good = [], {}
    for f, t in _json_arg(a.roots, "--roots").items():
        f2 = os.path.normpath(f) if isinstance(f, str) else ""
        mine = [p for p in pl.missing if f2 and os.path.isabs(f2) and _under(p, f2)]
        if not mine:
            results.append({"from": f, "to": t, "ok": False, "reason": "번들에 이 루트 아래의 없는 경로가 없음"})
            continue
        if not (isinstance(t, str) and os.path.isabs(t) and os.path.isdir(t)):
            results.append({"from": f, "to": t, "ok": False, "reason": "이 PC 에 없는 폴더"})
            continue
        n = sum(1 for p in mine if _exists(_rebase(p, f2, t)))
        if not n:
            results.append({"from": f, "to": t, "ok": False, "total": len(mine), "resolved": 0,
                            "reason": "이 짝으로 풀리는 경로가 없음"})
            continue
        good[f2] = os.path.normpath(t)
        results.append({"from": f2, "to": good[f2], "ok": True, "total": len(mine), "resolved": n})
    save_roots(a.store, pl.source_key, good, a.by)
    ok = bool(good)
    emit(ok, "ok" if ok else "invalid_arg",
         f"경로 짝 {len(good)}개를 저장했습니다. 가져오기 화면에서 다시 비교하면 반영됩니다" if ok
         else "저장한 짝이 없습니다", target=b.path, roots=results)


def _now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _open_span(p, message):
    """스냅샷 락을 잡고 pre 스냅샷을 찍는다. 락은 쓰기와 post 스냅샷이 끝날 때까지 쥔다 -
    풀어 두면 watcher 가 사이에 찍어 리비전에 이 작업의 이름이 남지 않는다."""
    span = cas._snapshot_lock(p)
    try:
        span.__enter__()
        pre, _ = cas._take_snapshot_locked(p, message)
    except TimeoutError as e:
        with contextlib.suppress(Exception):
            span.__exit__(None, None, None)
        emit(False, "lock_timeout", "되돌릴 지점(스냅샷)을 만들지 못해 아무것도 바꾸지 않았습니다", detail=e)
    return span, pre


def _close_span(span, p, message):
    try:
        post, _ = cas._take_snapshot_locked(p, message)
    except TimeoutError:
        post = None
    finally:
        with contextlib.suppress(Exception):
            span.__exit__(None, None, None)
    return post


def _public_rec(rec):
    return {k: rec[k] for k in ("id", "action", "target", "key", "trash", "backup") if rec.get(k) is not None}


PLUGIN_CALL_SEC = 660
PLUGIN_BUDGET_SEC = 1200    # 프로세스 시작부터 잰다. mcp-tools.ts 의 --install-plugins 타임아웃(1260초)보다 짧아야 한다
STARTED = time.monotonic()
PLUGIN_CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plugin_cli.py")


def _market_source(src):
    """extraKnownMarketplaces 의 source 객체 -> claude plugin marketplace add 가 받는 문자열."""
    if not isinstance(src, dict):
        return None
    return {"github": src.get("repo"), "git": src.get("url"), "url": src.get("url"),
            "directory": src.get("path"), "file": src.get("path")}.get(src.get("source"))


def _plugin_cli(args, store):
    try:
        p = subprocess.run([sys.executable, PLUGIN_CLI, *args, *(["--store", store] if store else [])],
                           capture_output=True, text=True, encoding="utf-8", timeout=PLUGIN_CALL_SEC)
        return json.loads(p.stdout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "code": "timeout", "message": f"{PLUGIN_CALL_SEC}초 안에 끝나지 않음"}
    except ValueError:
        return {"ok": False, "code": "bad_output", "message": "plugin_cli 출력이 JSON 이 아님"}


def install_plugins(store):
    """settings 에서 켜진 마켓 플러그인 중 이 PC 원장에 없는 것을 claude CLI 로 설치한다. 마켓을 Claude Code 가
    모르면 extraKnownMarketplaces 의 출처로 먼저 등록한다. 순차 실행이고 시간 예산을 넘으면 나머지는 남긴다."""
    st = config_edit.load(os.path.join(CLAUDE_HOME, "settings.json"))
    pdir = os.path.join(CLAUDE_HOME, "plugins")
    installed = plugin_state.read_installed(pdir)
    try:
        known = set(_load(os.path.join(pdir, "known_marketplaces.json")))
    except (OSError, ValueError, TypeError):
        known = set()
    ekm = st.get("extraKnownMarketplaces") or {}
    want = [pid for pid, v in sorted((st.get("enabledPlugins") or {}).items())
            if v is True and pid not in installed and plugin_state.split_id(pid)[1] not in (None, "", "builtin", "inline")]
    markets, out = {}, []
    for pid in want:
        name, m = plugin_state.split_id(pid)
        if time.monotonic() - STARTED + PLUGIN_CALL_SEC > PLUGIN_BUDGET_SEC:
            out.append({"id": pid, "ok": False, "code": "timeout", "reason": "시간 예산을 넘어 설치하지 않았습니다. 다시 실행하세요"})
            continue
        if m not in known and m not in markets:
            src = _market_source((ekm.get(m) or {}).get("source"))
            r = _plugin_cli(["market-add", src], store) if src else \
                {"ok": False, "code": "not_found", "message": f"마켓 {m} 의 출처가 settings 에 없음"}
            markets[m] = r
        if m in markets and not markets[m].get("ok"):
            out.append({"id": pid, "ok": False, "code": markets[m].get("code"), "reason": markets[m].get("message")})
            continue
        r = _plugin_cli(["install", "--marketplace", m, "--plugin", name, "--scope", "user"], store)
        out.append({"id": pid, "ok": bool(r.get("ok")), "code": r.get("code"), "reason": r.get("message")})
    return out


def _plugins(a, failed):
    plugins = install_plugins(a.store) if getattr(a, "install_plugins", False) else []
    failed += [{"id": f"cc.plugins/{x['id']}", "code": x["code"], "reason": x["reason"]} for x in plugins if not x["ok"]]
    return plugins


def _plugin_msg(plugins):
    return f", 플러그인 {sum(1 for x in plugins if x['ok'])}/{len(plugins)}개 설치" if plugins else ""


def cmd_apply(a, on_done=None):
    """on_done(적용된 id 목록) 은 끝날 때 결과 필드를 보탠다(sync-pull 의 기준 갱신)."""
    def finish(ok, code, msg, ids, **fields):
        if on_done:
            fields.update(on_done(ids))
        emit(ok, code, msg, **fields)

    b = _open_bundle(a.bundle)
    pl = _make_plan(a, b)
    if a.plan_id != pl.plan_id:
        emit(False, "plan_stale", "plan 뒤에 이 PC 의 대상이 바뀌었습니다. 다시 plan 해서 확인하세요",
             target=b.path, plan_id=pl.plan_id)
    rows = {r["id"]: r for r in pl.items}
    want = [x.strip() for x in a.ids.split(",") if x.strip()] if a.ids else \
        [r["id"] for r in pl.items if r["state"] in ("new", "changed")]
    unknown = [x for x in want if x not in rows]
    if unknown:
        emit(False, "invalid_arg", f"plan 에 없는 항목: {', '.join(unknown)}", target="--ids")
    sel = [rows[x] for x in want if rows[x]["state"] in ("new", "changed")]
    failed = [{"id": x, "code": rows[x].get("code") or "blocked", "reason": rows[x].get("reason")}
              for x in want if rows[x]["state"] == "blocked"]
    if not sel:
        # 설정은 이미 같아도 플러그인 설치만 따로 요청할 수 있다.
        plugins = _plugins(a, failed)
        if failed:
            finish(False, "partial", "적용할 수 있는 항목이 없습니다", [], applied=[], failed=failed, plugins=plugins)
        finish(True, "ok" if plugins else "noop", "바꿀 항목이 없습니다" + _plugin_msg(plugins), [],
               applied=[], failed=[], plugins=plugins)

    p = ensure_store(a.store)
    short = b.hash[7:15]
    span, pre = _open_span(p, f"before import {short}")
    applied, wfailed = [], []
    try:
        applied, wfailed = apply_rows(sel, a.store)
    finally:
        done = {x["id"] for x in applied}
        n_new = sum(1 for r in sel if r["id"] in done and r["state"] == "new")
        post = _close_span(span, p, f"import {short}: +{n_new} ~{len(done) - n_new}")
    failed += wfailed

    dropped = _dropped(pl, done)
    rec = {"at": _now_iso(), "bundle": b.path, "bundle_hash": b.hash,
           "source_host": (b.manifest.get("source") or {}).get("host"), "plan_id": pl.plan_id,
           "pre_snapshot": pre, "post_snapshot": post, "applied": applied, "dropped": dropped}
    import_id = None
    if applied:
        with lib_store.edit_cfg(a.store) as cfg:
            imps = cfg.setdefault("imports", [])
            have = {x.get("id") for x in imps}
            import_id = base = f"{_ts()}-{short}"
            n = 1
            while import_id in have:
                import_id, n = f"{base}.{n}", n + 1
            imps.append({"id": import_id, **rec})
            del imps[:-IMPORTS_KEEP]
        save_roots(a.store, pl.source_key, pl.explicit, "user")
    plugins = _plugins(a, failed)
    msg = (f"가져오기 {import_id}: {len(done)}개 적용" if import_id else "적용된 항목이 없습니다") + _plugin_msg(plugins)
    if failed:
        msg += f", {len(failed)}개 실패"
    if dropped:
        msg += f". 이 PC 에 없는 경로를 쓰는 설정 {len(dropped)}개는 빼고 가져옴"
    finish(not failed, "partial" if failed else "ok", msg, sorted(done), target=b.path, import_id=import_id,
           applied=[_public_rec(x) for x in applied], failed=failed, pre_snapshot=pre, post_snapshot=post,
           warnings=pl.warnings, plugins=plugins, dropped=dropped)


def cmd_undo(a):
    ent = next((x for x in lib_store.load_cfg(a.store).get("imports") or [] if x.get("id") == a.import_id), None)
    if not ent:
        emit(False, "not_found", f"가져오기 기록이 없음: {a.import_id}", target=a.import_id)
    if ent.get("undone_at"):
        emit(True, "noop", f"이미 되돌렸습니다: {a.import_id} ({ent['undone_at']})", target=a.import_id)
    p = cas.store_paths(a.store)
    restored, failed = [], []
    span, pre = _open_span(p, f"before undo import {a.import_id}")
    try:
        for i in reversed(range(len(ent["applied"]))):
            rec = ent["applied"][i]
            if rec.get("undone"):
                continue
            try:
                undo_record(rec, a.force)
                restored.append(i)
            except Changed:
                failed.append({"id": rec["id"], "code": "changed_since_import", "target": rec["target"],
                               "reason": "가져온 뒤에 바뀌어 되돌리지 않았습니다(force 로 덮어쓸 수 있음)"})
            except Exception as e:                  # 실패는 결과에 담고 나머지를 계속 되돌린다
                failed.append({"id": rec["id"], "code": "write_failed", "target": rec["target"],
                               "reason": f"{type(e).__name__}: {e}"})
    finally:
        post = _close_span(span, p, f"undo import {a.import_id}")
    with lib_store.edit_cfg(a.store) as cfg:
        cur = next((x for x in cfg.get("imports") or [] if x.get("id") == a.import_id), None)
        if cur:
            for i in restored:
                cur["applied"][i]["undone"] = True
            if not failed:
                cur["undone_at"] = _now_iso()
    out = [ent["applied"][i]["id"] for i in restored]
    msg = f"가져오기 {a.import_id} 되돌림: {len(out)}개" + (f", {len(failed)}개 실패" if failed else "")
    emit(not failed, "partial" if failed else "ok", msg, target=a.import_id, restored=out, failed=failed,
         pre_snapshot=pre, post_snapshot=post)


def main():
    ap = JsonArgumentParser(prog="transfer")
    ap.add_argument("--store", default=lib_store.default_store())
    sub = ap.add_subparsers(dest="op", required=True)
    for name in ("inventory", "export"):
        p = sub.add_parser(name)
        p.add_argument("--with-optional", default="", help="쉼표 구분: " + ",".join(OPTIONAL))
        if name == "export":
            p.add_argument("--out", required=True, help=".cmbundle 이면 zip, 아니면 폴더")
            p.add_argument("--include-secrets", action="store_true")
    p = sub.add_parser("inspect")
    p.add_argument("--bundle", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--bundle", default="")
    p.add_argument("--sync-from", default="", help="동기화 폴더의 다른 PC(profile) 를 번들로 쓴다")
    p.add_argument("--secrets", default="", help='{"<item id>": {"<경로>": "<값>"}}')
    p.add_argument("--choices", default="", help='스칼라 충돌: {"<item id>": "take" | {"<경로>": "take"}}. 기본 keep')
    p.add_argument("--roots", default="", help='경로 짝 {"<번들 쪽 루트>": "<이 PC 폴더>" | ""}. "" 는 맞추지 않음')
    p.add_argument("--exclude", default="", help="쉼표 구분 훅 id(hook:...). 가져오지 않는다")
    p = sub.add_parser("apply")
    p.add_argument("--bundle", required=True)
    p.add_argument("--plan-id", required=True, help="plan 결과의 plan_id. 그 뒤 대상이 바뀌었으면 plan_stale")
    p.add_argument("--ids", default="", help="쉼표 구분 항목 id. 생략하면 new/changed 전부")
    p.add_argument("--secrets", default="")
    p.add_argument("--choices", default="")
    p.add_argument("--roots", default="")
    p.add_argument("--exclude", default="")
    p.add_argument("--install-plugins", action="store_true",
                   help="적용 뒤 켜진 마켓 플러그인 중 없는 것을 claude CLI 로 설치(네트워크)")
    sub.add_parser("history")
    p = sub.add_parser("sync-setup")
    p.add_argument("--dir", required=True)
    p.add_argument("--profile", default="", help="이 PC 의 폴더 이름. 생략하면 호스트명")
    p = sub.add_parser("sync-push")
    p.add_argument("--with-optional", default="")
    p.add_argument("--include-secrets", action="store_true")
    p = sub.add_parser("sync-status")
    p.add_argument("--from", dest="sync_from", default="")
    p = sub.add_parser("sync-pull")
    p.add_argument("--from", dest="sync_from", required=True)
    p.add_argument("--plan-id", required=True)
    p.add_argument("--install-plugins", action="store_true")
    p.add_argument("--ids", default="")
    p.add_argument("--secrets", default="")
    p.add_argument("--choices", default="")
    p.add_argument("--roots", default="")
    p.add_argument("--exclude", default="")
    p = sub.add_parser("roots")
    p.add_argument("--bundle", default="")
    p.add_argument("--from", dest="sync_from", default="")
    p.add_argument("--roots", required=True, help='{"<번들 쪽 루트>": "<이 PC 폴더>"}')
    p.add_argument("--by", default="claude", choices=("claude", "user"))
    p = sub.add_parser("undo")
    p.add_argument("--import-id", required=True)
    p.add_argument("--force", action="store_true", help="가져온 뒤 바뀐 항목도 되돌린다")
    a = ap.parse_args()
    {"inventory": cmd_export, "export": cmd_export, "inspect": cmd_inspect, "plan": cmd_plan,
     "apply": cmd_apply, "undo": cmd_undo, "history": cmd_history, "sync-setup": cmd_sync_setup,
     "sync-push": cmd_sync_push, "sync-status": cmd_sync_status, "sync-pull": cmd_sync_pull,
     "roots": cmd_roots}[a.op](a)


if __name__ == "__main__":
    guard(main)
