#!/usr/bin/env python3
r"""transfer.py - PC 간 설정 이관 번들(cmbundle v1) 만들기.

  inventory [--with-optional local]                   이관 대상 목록(읽기 전용)
  export --out P [--with-optional local] [--include-secrets]
                                                      번들 쓰기. P 가 .cmbundle 이면 zip, 아니면 폴더

번들에는 ~/.claude, ~/.claude.json 의 mcpServers, Desktop config 의 mcpServers, 스토어 설정만 담는다.
설정이 가리키는 그 밖의 파일(훅 스크립트, MCP 서버 실행 파일, 플러그인 폴더, 라이브러리)은 담지 않고
external 로 경로만 보고한다. 새 PC 에서 같은 경로에 따로 준비해야 하는 목록이다.

JSON 값은 시크릿 치환 -> 경로 토큰화 -> 외부 경로 추출 순서로 처리한다. 이 순서라야 보고·manifest 에
시크릿 값이 섞이지 않는다. 파일·트리 항목은 원문 바이트 그대로 담고 원문으로 해시한다.
"""
from __future__ import annotations
import hashlib, json, os, re, shutil, socket, sys, zipfile
from datetime import datetime

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from cli_result import emit, guard, JsonArgumentParser
import cas
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
}
OPTIONAL = {"local": "cc.settings-local"}

SECRET_KEY = re.compile(r"TOKEN|KEY|SECRET|PASSWORD|AUTHORIZATION")
SECRET_VAL = re.compile(r"(?<![A-Za-z0-9])(sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|"
                        r"github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9\-]{10,})")
HIGH_ENTROPY = re.compile(r"^[A-Za-z0-9+/_=\-]{40,}$")
PATH_START = re.compile(r"[A-Za-z]:[\\/]|\$\{(?:HOME|CLAUDE_HOME|DESKTOP_DIR)\}|~[\\/]")
STORE_MARKET_KEYS = ("id", "url", "ref", "name")


def _sha(b: bytes) -> str:
    return "sha256:" + hashlib.sha256(b).hexdigest()


def _canon(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _load(p):
    with open(p, encoding="utf-8-sig") as f:
        return json.load(f)


def _norm_disp(p: str) -> str:
    return os.path.normpath(p)


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

    def add_tree(self, cat, iid, p):
        rows, size, n = [], 0, 0
        for root, dirs, files in os.walk(p):
            dirs.sort()
            for fn in sorted(files):
                fp = os.path.join(root, fn)
                with open(fp, "rb") as f:
                    data = f.read()
                rows.append(f"{os.path.relpath(fp, p).replace(os.sep, '/')}\0{_sha(data)}\n")
                size += len(data)
                n += 1
        self.items.append({"id": iid, "category": cat, "strategy": "tree", "rel": self.rel(p),
                           "hash": _sha("".join(rows).encode("utf-8")), "size": size, "files": n, "_src": p})
        if size > SIZE_WARN:
            self.warnings.append(f"{iid}: {size // (1024 * 1024)}MB")

    def add_json(self, cat, iid, key, obj, refs):
        found = {}
        obj = scrub(obj, iid, found) if cat in ("cc.mcp-user", "desk.mcp") else obj
        if cat in ("cc.settings", "cc.settings-local") and isinstance(obj.get("env"), dict):
            obj = {**obj, "env": scrub(obj["env"], iid, found, "env")}
        obj = map_strings(obj, lambda s: tokenize(s, self.tokens))
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
                self.warnings.append(f"{cat}: {p} 를 읽지 못함")
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
               "remotes": cfg.get("remotes") or [],
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
        lines = [f"export 결과: {out_path}" if out_path else "이관 대상"]
        counts = self.counts()
        for cat in [c for c, *_ in TREE_CATS] + [c for c, *_ in FILE_CATS] + \
                   ["cc.refs", "cc.settings", "cc.settings-local", "cc.mcp-user", "desk.mcp", "cm.store"]:
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

def _entries(col, include_secrets):
    """(번들 안 상대경로, bytes 또는 원본 파일 경로)."""
    yield "manifest.json", json.dumps(col.manifest(), ensure_ascii=False, indent=2).encode("utf-8")
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
    tmp = f"{out}.{os.getpid()}.tmp"
    try:
        if out.lower().endswith(".cmbundle"):
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
                for name, src in _entries(col, include_secrets):
                    if isinstance(src, bytes):
                        z.writestr(name, src)
                    else:
                        z.write(src, name)
        else:
            for name, src in _entries(col, include_secrets):
                dst = os.path.join(tmp, *name.split("/"))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if isinstance(src, bytes):
                    with open(dst, "wb") as f:
                        f.write(src)
                else:
                    shutil.copyfile(src, dst)
        os.replace(tmp, out)
    except BaseException:
        if os.path.isdir(tmp):
            shutil.rmtree(tmp, ignore_errors=True)
        elif os.path.exists(tmp):
            os.remove(tmp)
        raise


# ── CLI ─────────────────────────────────────────────────────────────────────

def _summary_fields(col, out=None):
    return {"counts": col.counts(), "plugins": col.plugins, "external": col.external,
            "skipped": col.skipped, "warnings": col.warnings,
            "secrets": [{"item": iid, "path": k} for iid, d in col.secrets.items() for k in d],
            "report": col.report(out)}


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
    a = ap.parse_args()

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
    write_bundle(col, out, a.include_secrets)
    extra = {"secrets_file": "secrets.json"} if a.include_secrets and col.secrets else {}
    emit(True, "ok", f"번들을 만들었습니다: {out} (항목 {len(col.items)}개, 외부 경로 {len(col.external)}개)",
         target=out, bundle=out, **extra, **_summary_fields(col, out))


if __name__ == "__main__":
    guard(main)
