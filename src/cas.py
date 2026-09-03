#!/usr/bin/env python3
r"""
cas.py - Custom Content-Addressable Snapshot engine (git 원리, 독립 경로 추적판)

git 과 다른 점:
  - 단일 work-tree 루트를 가정하지 않는다. 흩어진 임의의 절대경로/디렉토리/glob 를
    각각 독립적으로 추적한다. (10~20개 규모 대상)
  - 저장소는 추적 대상과 분리된 한 곳에 모인다. 기본값: CLAUDE_SNAPSHOT_STORE 환경변수,
    없으면 Windows 는 D:\.claude-snapshot / 그 외는 ~/.claude-snapshot (--store 로 오버라이드).

변경 탐지 원리 (git index 모델):
  1) stat fast-path: size + mtime_ns 가 index 와 같으면 내용을 안 읽고 unchanged.
  2) 다르면 내용을 해싱해 hash 비교 (touch 등 내용 무변경 케이스 제거).
  3) index 에 없는 경로 = 신규, 워킹트리에 없는데 index 에 있으면 = 삭제.
"""
from __future__ import annotations
import argparse, contextlib, json, os, re, sys, time, zlib, hashlib, glob as globmod, difflib
from datetime import datetime

# Windows 콘솔 기본 인코딩(cp949)에서 한글/em-dash 출력 시 UnicodeEncodeError 방지.
# newline="" 필수: 기본 텍스트 모드는 쓰기 시 \n 을 \r\n 으로 바꾸는데, cat/diff 처럼
# 파일 내용(이미 \r\n 일 수 있음)을 그대로 내보내면 \r\r\n 이 되어 개행이 2번으로 보인다.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", newline="")
    except (AttributeError, ValueError):
        pass

DEFAULT_STORE = os.environ.get("CLAUDE_SNAPSHOT_STORE") or (
    "D:\\.claude-snapshot" if os.name == "nt" else os.path.expanduser("~/.claude-snapshot")
)

# 존재하면 자동 추적할 기본 대상. untrack 으로 명시 제외한 항목(ignore_defaults)은 다시 넣지 않는다.
# CLAUDE_CAS_NO_DEFAULT_TRACK=1 이면 병합 자체를 끈다(테스트/특수 상황용).
import paths  # Win32/MSIX 겸용 Desktop config 경로 해석(read/write 와 동일 대상)

_HOME = os.path.expanduser("~")
DEFAULT_TRACKED = [
    os.path.join(_HOME, ".claude.json"),
    os.path.join(_HOME, ".claude", "settings.json"),
    paths.desktop_config_path(),   # 설치 방식(Win32/MSIX)에 맞는 실제 desktop config
]

def _parse_iso(s):
    """PowerShell round-trip('o') 포맷은 소수부가 7자리라 Python<3.11 fromisoformat 이 못 읽는다.
    소수부를 마이크로초(6자리)로 잘라 파싱. (예: .1970395+09:00 -> .197039+09:00)"""
    return datetime.fromisoformat(re.sub(r"(\.\d{6})\d+", r"\1", str(s)))

def load_config(p):
    """config.json 로드 + DEFAULT_TRACKED 병합(존재하는 파일만, ignore_defaults 제외).
    병합으로 바뀌었고 store 가 이미 초기화돼 있으면 즉시 영속화."""
    config = load_json(p["config"], {"version": 1, "tracked": []})
    if os.environ.get("CLAUDE_CAS_NO_DEFAULT_TRACK") == "1":
        return config
    tracked = config.setdefault("tracked", [])
    ignored = set(config.get("ignore_defaults", []))
    changed = False
    for d in DEFAULT_TRACKED:
        if d not in tracked and d not in ignored and os.path.isfile(d):
            tracked.append(d)
            changed = True
    if changed and os.path.isdir(p["store"]):
        save_json(p["config"], config)
    return config

def store_paths(store):
    return {
        "store": store,
        "config": os.path.join(store, "config.json"),
        "index": os.path.join(store, "index.json"),
        "objects": os.path.join(store, "objects"),
        "snapshots": os.path.join(store, "snapshots"),
        "log": os.path.join(store, "log"),
    }

def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

def hash_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

def object_path(p, h):
    return os.path.join(p["objects"], h[:2], h[2:])

def write_object(p, content: bytes) -> str:
    h = hash_bytes(content)
    dst = object_path(p, h)
    if not os.path.exists(dst):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(zlib.compress(content, 9))
    return h

def read_object(p, h) -> bytes:
    with open(object_path(p, h), "rb") as f:
        return zlib.decompress(f.read())

def expand_tracked(tracked):
    """config.tracked 항목(파일/디렉토리/glob)을 실제 파일 절대경로 집합으로 전개."""
    files = set()
    for entry in tracked:
        pat = os.path.expanduser(os.path.expandvars(entry))
        if any(c in pat for c in "*?[]"):
            for m in globmod.glob(pat, recursive=True):
                if os.path.isfile(m):
                    files.add(os.path.abspath(m))
        elif os.path.isdir(pat):
            for root, _, names in os.walk(pat):
                for n in names:
                    files.add(os.path.abspath(os.path.join(root, n)))
        elif os.path.isfile(pat):
            files.add(os.path.abspath(pat))
    return files

def norm_entry(entry):
    """단일 파일 tracked 항목을 expand_tracked 와 '동일하게' 정규화.
    status 버킷(new/unchanged/...)에 담기는 문자열과 byte-identical 하게 맞춰,
    UI 가 defaults 로 전역/프로젝트 행을 정확히 매칭하게 한다(경로 구분자/~/env 정규화)."""
    return os.path.abspath(os.path.expanduser(os.path.expandvars(entry)))

def file_stat(path):
    st = os.lstat(path)
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "mode": st.st_mode}

def scan(p, config, index, rehash=True):
    """추적 경로를 스캔해 변경을 분류. 반환: dict(status -> [paths]) + 새 index 후보."""
    current = expand_tracked(config.get("tracked", []))
    result = {"new": [], "modified": [], "deleted": [], "unchanged": []}
    new_index = {}
    for path in sorted(current):
        try:
            stt = file_stat(path)
        except OSError:
            continue
        prev = index.get(path)
        if prev is None:
            h = write_object(p, open(path, "rb").read()) if rehash else None
            new_index[path] = {**stt, "hash": h}
            result["new"].append(path)
            continue
        if prev["size"] == stt["size"] and prev["mtime_ns"] == stt["mtime_ns"]:
            new_index[path] = prev
            result["unchanged"].append(path)
            continue
        # 한 번 읽은 내용으로 해시와 blob 을 함께 만든다 - 두 번 따로 읽으면 그 사이 파일이
        # 또 바뀌었을 때 index 의 해시가 가리키는 blob 이 존재하지 않게 된다(복원 불가).
        data = open(path, "rb").read()
        h = hash_bytes(data)
        if h == prev.get("hash"):
            new_index[path] = {**stt, "hash": h}
            result["unchanged"].append(path)
        else:
            if rehash:
                write_object(p, data)
            new_index[path] = {**stt, "hash": h}
            result["modified"].append(path)
    for path in index:
        if path not in current:
            result["deleted"].append(path)
    return result, new_index

def cmd_init(args):
    p = store_paths(args.store)
    for d in (p["store"], p["objects"], p["snapshots"], p["log"]):
        os.makedirs(d, exist_ok=True)
    if not os.path.exists(p["config"]):
        save_json(p["config"], {"version": 1, "store": args.store, "tracked": []})
    if not os.path.exists(p["index"]):
        save_json(p["index"], {})
    print(f"초기화 완료: {args.store}")

# 프로젝트 .claude 를 추적할 때 자동 감지할 설정 파일(존재하는 것만). 나머지는 파일 경로 직접 add.
PROJECT_PRESET = ("settings.json", "settings.local.json")
# 산문 설정: 카드로 만들기엔 안 맞지만 바뀌면 Claude 행동이 바뀌므로 diff/복원 가치가 크다.
# 루트(<root>/CLAUDE.md)와 .claude 양쪽 모두 가능해 PROJECT_PRESET 과 탐색 위치가 다르다.
PROSE_PRESET = ("CLAUDE.md", "CLAUDE.local.md")

def _claude_dir_of(path):
    """설정 파일이 있을 '.claude' 폴더 해석: 프로젝트 루트를 주면 <root>/.claude,
    .claude 를 직접 주면 그 폴더."""
    sub = os.path.join(path, ".claude")
    return sub if os.path.isdir(sub) else path

def _project_root_of(path):
    """'.claude' 를 직접 주면 그 부모(프로젝트 루트), 아니면 그대로."""
    p = path.rstrip("/\\")
    return os.path.dirname(p) if os.path.basename(p) == ".claude" else path

def _expand_track_path(path):
    """디렉토리는 프로젝트 프리셋(존재하는 settings*.json)으로 확장, 파일/글롭은 그대로 반환."""
    if any(c in path for c in "*?[]"):
        return [path]                                   # 글롭은 원문 유지(status 시 확장)
    ap = os.path.abspath(os.path.expanduser(path))
    if os.path.isdir(ap):
        cdir = _claude_dir_of(ap)
        out = [os.path.join(cdir, n) for n in PROJECT_PRESET
               if os.path.isfile(os.path.join(cdir, n))]
        # CLAUDE.md 는 루트/.claude 어느 쪽에도 올 수 있다(둘이 같은 디렉토리면 중복 제거).
        for d in dict.fromkeys((_project_root_of(ap), cdir)):
            out += [os.path.join(d, n) for n in PROSE_PRESET
                    if os.path.isfile(os.path.join(d, n))]
        return out
    return [ap]                                         # 파일(미존재도 명시 추적 허용)

def _norm_targets(paths_):
    """untrack 비교용: 파일 경로는 abspath 로도 확장(track 이 abspath 로 저장)."""
    out = set()
    for t in paths_:
        out.add(t)
        if not any(c in t for c in "*?[]"):
            out.add(os.path.abspath(os.path.expanduser(t)))
    return out

def cmd_track(args):
    p = store_paths(args.store)
    with _snapshot_lock(p):                 # 스냅샷과 같은 config/index 를 고쳐 쓴다
        _track_locked(p, args)

def _track_locked(p, args):
    config = load_json(p["config"], {"version": 1, "tracked": []})
    added, already, not_found = [], [], []
    for path in args.paths:
        for ap in _expand_track_path(path):
            # 아직 없는 경로도 추적을 **허용**한다(_expand_track_path 주석 참고: 나중에 생길
            # 파일을 미리 걸어 두는 건 의도된 기능이다). 다만 오타도 같은 모양이라 조용히
            # 넣으면 유령 행으로 남는다 - 어느 것이 아직 없는지 호출부에 알려 화면이 말하게 한다.
            # 글롭은 지금 매칭이 0건이어도 정상이므로 이 판정에서 제외한다.
            if not any(c in ap for c in "*?[]") and not os.path.exists(ap):
                not_found.append(ap)
            if ap in config["tracked"]:
                already.append(ap)
            else:
                config["tracked"].append(ap)
                added.append(ap)
    save_json(p["config"], config)
    if getattr(args, "json", False):
        print(json.dumps({"ok": True, "added": added, "already": already,
                          "not_found": not_found}, ensure_ascii=False))
    else:
        print("추가됨:\n  " + "\n  ".join(added) if added else "추가할 파일 없음 / 이미 추적 중")

def cmd_untrack(args):
    p = store_paths(args.store)
    with _snapshot_lock(p):                 # 스냅샷과 같은 config/index 를 고쳐 쓴다
        _untrack_locked(p, args)

def _untrack_locked(p, args):
    config = load_json(p["config"], {"version": 1, "tracked": []})
    before = len(config["tracked"])
    targets = _norm_targets(args.paths)
    config["tracked"] = [t for t in config["tracked"] if t not in targets]
    # 기본 추적 대상을 명시적으로 뺀 경우, load_config 의 자동 병합이 되살리지 않도록 기록.
    ignored = set(config.get("ignore_defaults", []))
    for t in targets:
        if t in DEFAULT_TRACKED:
            ignored.add(t)
    if ignored:
        config["ignore_defaults"] = sorted(ignored)
    save_json(p["config"], config)
    # index 에서도 제거: status 의 'deleted' 는 index(스냅샷된 파일) 기준이라 tracked 에서 빠져도
    # index 에 남아 있으면 계속 삭제됨 상태로 표시된다. 추적 해제 = index 에서도 완전 제외.
    # 디렉토리 항목(구버전 track 의 raw 저장분)은 index 에 '하위 파일' 경로로 들어 있어
    # 정확 일치로는 안 지워진다 — prefix 매칭으로 하위 경로까지 함께 제거.
    dir_prefixes = tuple(t + os.sep for t in targets if not any(c in t for c in "*?[]"))
    index = load_json(p["index"], {})
    idx_removed = 0
    for k in list(index):
        ak = os.path.abspath(os.path.expanduser(k))
        if k in targets or ak in targets or ak.startswith(dir_prefixes):
            del index[k]
            idx_removed += 1
    if idx_removed:
        save_json(p["index"], index)
    removed = before - len(config["tracked"])
    if getattr(args, "json", False):
        print(json.dumps({"ok": True, "removed": removed, "index_removed": idx_removed}, ensure_ascii=False))
    else:
        print(f"제거됨: {removed}개 (index {idx_removed}개)")

def cmd_status(args):
    p = store_paths(args.store)
    config = load_config(p)
    index = load_json(p["index"], {})
    result, _ = scan(p, config, index, rehash=False)
    if args.json:  # 머신용: 순수 JSON 만
        out = {k: result[k] for k in result}
        # 전역(기본 추적) 대상 분류용. UI 가 전역(editable) vs 프로젝트(view-only) 행 구분에 사용.
        # 버킷 문자열과 동일 정규화(norm_entry)로 내보내야 UI 의 정확 매칭이 성립.
        out["defaults"] = [norm_entry(t) for t in config.get("tracked", []) if t in DEFAULT_TRACKED]
        # UI 폴링이 status 한 번으로 watcher 생존과 새 스냅샷 여부까지 아는 데 쓴다
        # (별도 watcher_status/log 호출 = 폴링마다 프로세스 하나씩 추가라 여기 얹는다).
        out["watcher"] = _watcher_state(args.store)
        ids = _snapshot_ids(p)
        out["last_snapshot"] = ids[-1] if ids else None
        print(json.dumps(out, ensure_ascii=False))
        return
    def show(key, sym):
        for path in result[key]:
            print(f"  {sym} {path}")
    print(f"추적 대상: {len(config.get('tracked', []))} 항목  /  저장소: {args.store}")
    if result["new"]:      print("신규(new):");      show("new", "+")
    if result["modified"]: print("수정(modified):");  show("modified", "~")
    if result["deleted"]:  print("삭제(deleted):");   show("deleted", "-")
    if sum(len(result[k]) for k in ("new", "modified", "deleted")) == 0:
        print("변경 없음 (clean).")

# 스냅샷은 index.json 을 read-modify-write 하고 parent 를 snaps[-1] 로 고른다. 편집(config_edit)과
# watcher 가 이걸 동시에 도는 건 예외가 아니라 정상 흐름이다 - 편집 -> 파일 변경 -> watcher 감지가
# 항상 겹친다. os.replace 는 쓰기만 원자적이라 시퀀스 전체는 못 막고, 두 프로세스가 같은 parent 를
# 읽으면 이력 체인이 갈라진다. 파일 내용은 content-addressed 라 안전하지만 이력이 어긋나는 건
# 이 도구가 파는 것 자체가 깨지는 일이다.
# 대기 상한은 config_edit.snapshot_before 의 subprocess timeout(30s)보다 충분히 짧아야 한다 -
# 거기서는 모든 예외가 삼켜지므로, 오래 기다리면 스냅샷이 조용히 생략된 채 편집만 진행된다.
LOCK_WAIT_SEC = float(os.environ.get("CLAUDE_CAS_LOCK_WAIT", "8"))
LOCK_STALE_SEC = 60.0

@contextlib.contextmanager
def _snapshot_lock(p):
    os.makedirs(p["store"], exist_ok=True)          # init 전에도 잠글 수 있어야 한다
    lock = os.path.join(p["store"], "snapshot.lock")
    deadline = time.monotonic() + LOCK_WAIT_SEC
    fd = None
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            # 죽은 프로세스가 남긴 락은 **나이로만** 판정한다(pid 재사용을 신뢰하지 않는다).
            try:
                if time.time() - os.path.getmtime(lock) > LOCK_STALE_SEC:
                    os.unlink(lock)
                    continue
            except OSError:
                pass                                 # 그 사이 남이 풀었다 - 다음 루프에서 재시도
            if time.monotonic() > deadline:
                raise TimeoutError(f"다른 스냅샷이 진행 중입니다({LOCK_WAIT_SEC:.0f}s 대기): {lock}")
            time.sleep(0.05)
    try:
        os.write(fd, json.dumps({"pid": os.getpid(), "at": datetime.now().isoformat()}).encode())
        os.close(fd)
        fd = None
        yield
    finally:
        if fd is not None:
            os.close(fd)
        with contextlib.suppress(OSError):
            os.unlink(lock)

def _take_snapshot(p, message, force=False):
    """스냅샷 코어. 새 스냅샷 id 를 반환(변경 없고 force 아니면 None). cmd_snapshot/cmd_restore 공용."""
    with _snapshot_lock(p):
        return _take_snapshot_locked(p, message, force)

def _take_snapshot_locked(p, message, force=False):
    config = load_config(p)
    index = load_json(p["index"], {})
    result, new_index = scan(p, config, index, rehash=True)
    changed = sum(len(result[k]) for k in ("new", "modified", "deleted"))
    if changed == 0 and not force:
        return None, result
    snaps = sorted(os.listdir(p["snapshots"])) if os.path.isdir(p["snapshots"]) else []
    parent = snaps[-1] if snaps else None
    ts = datetime.now().strftime("%Y%m%dT%H%M%S_%f")
    manifest = {
        "time": datetime.now().isoformat(),
        "message": message or "",
        "parent": parent,
        "changes": {k: result[k] for k in ("new", "modified", "deleted")},
        "entries": {path: {"hash": e.get("hash"), "size": e["size"]} for path, e in new_index.items()},
    }
    save_json(os.path.join(p["snapshots"], ts + ".json"), manifest)
    save_json(p["index"], new_index)
    return ts, result

def cmd_snapshot(args):
    p = store_paths(args.store)
    try:
        ts, result = _take_snapshot(p, args.message, args.force)
    except TimeoutError as e:
        print(f"스냅샷 생략: {e}"); sys.exit(1)
    if ts is None:
        print("변경 없음 — 스냅샷 생략 (--force 로 강제)")
        return
    print(f"스냅샷 {ts}  (+{len(result['new'])} ~{len(result['modified'])} -{len(result['deleted'])})")

def cmd_restore(args):
    """특정 스냅샷의 blob 으로 파일을 복원. 안전장치: 복원 전 스냅샷(되돌릴 지점) + .bak + atomic write.
    출력은 JSON 한 줄 (MCP 가 파싱)."""
    p = store_paths(args.store)
    target = os.path.abspath(os.path.expanduser(args.path))
    sid = args.frm
    blob = _content_at(p, sid, target)
    if blob is None:
        print(json.dumps({"ok": False, "message": f"스냅샷 {sid} 에 '{target}' 내용 없음(추적 안 됨/삭제됨)"},
                         ensure_ascii=False))
        sys.exit(1)
    # 전/후 스냅샷과 파일 쓰기를 한 락 안에서 - 사이가 벌어지면 watcher tick 이 먼저 찍어
    # 복원 결과가 'auto:' 메시지로 기록되고, 리비전에 복원이라는 사실이 남지 않는다.
    pre_snapshot = post_snapshot = bak = None
    try:
        with (contextlib.nullcontext() if args.no_snapshot else _snapshot_lock(p)):
            if not args.no_snapshot:
                # 되돌릴 지점을 못 만들면 복원을 하지 않는다 - 조용히 진행하면 롤백 불가 상태가 된다.
                pre_snapshot, _ = _take_snapshot_locked(p, f"before restore of {os.path.basename(target)}")
            if os.path.exists(target) and not args.no_backup:
                bak = f"{target}.{datetime.now().strftime('%Y%m%d%H%M%S')}.bak"
                with open(bak, "wb") as f:
                    f.write(open(target, "rb").read())
            os.makedirs(os.path.dirname(target), exist_ok=True)
            tmp = target + ".restore.tmp"
            with open(tmp, "wb") as f:
                f.write(blob)
            os.replace(tmp, target)
            # 복원 결과도 즉시 스냅샷: 안 찍으면 다음 편집의 pre-스냅샷이 이 상태를 제 이름 없이
            # 흡수해, 리비전 행의 메시지와 실제 diff 내용이 한 칸 어긋난다(편집 후행 스냅샷과 동일 원칙).
            if not args.no_snapshot:
                post_snapshot, _ = _take_snapshot_locked(p, f"restore: {os.path.basename(target)} <- {sid}")
    except TimeoutError as e:
        print(json.dumps({"ok": False, "message": f"복원 전 스냅샷 실패: {e}"}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps({"ok": True, "message": f"복원 완료: {os.path.basename(target)} <- {sid}",
                      "path": target, "from": sid, "backup": bak, "pre_snapshot": pre_snapshot,
                      "post_snapshot": post_snapshot},
                     ensure_ascii=False))

def cmd_log(args):
    p = store_paths(args.store)
    if not os.path.isdir(p["snapshots"]):
        print("스냅샷 없음"); return
    # _snapshot_ids 와 같은 필터: 저장 중단이 남긴 .tmp 등을 스냅샷으로 세지 않는다.
    names = [n for n in sorted(os.listdir(p["snapshots"]), reverse=True) if n.endswith(".json")]
    for name in names[: args.limit]:
        m = load_json(os.path.join(p["snapshots"], name), {})
        c = m.get("changes", {})
        print(f"{name[:-5]}  +{len(c.get('new',[]))} ~{len(c.get('modified',[]))} -{len(c.get('deleted',[]))}  {m.get('message','')}")

def _latest_hash_for(p, path):
    index = load_json(p["index"], {})
    e = index.get(os.path.abspath(path))
    return e.get("hash") if e else None

def _snapshot_ids(p):
    if not os.path.isdir(p["snapshots"]):
        return []
    return [n[:-5] for n in sorted(os.listdir(p["snapshots"])) if n.endswith(".json")]

def _manifest(p, sid):
    return load_json(os.path.join(p["snapshots"], sid + ".json"), {})

def _hash_in_snapshot(p, sid, target):
    e = _manifest(p, sid).get("entries", {}).get(target)
    return e.get("hash") if e else None

def _content_at(p, ref, target):
    """ref: 'work'/None -> 현재 파일, 'empty' -> 빈 내용, 그 외 -> 스냅샷 id 의 blob."""
    if ref in (None, "work", "WORK"):
        return open(target, "rb").read() if os.path.exists(target) else None
    if ref == "empty":
        return b""   # 직전 리비전이 없는 첫 리비전과의 비교용 - 전체가 추가로 표시된다
    h = _hash_in_snapshot(p, ref, target)
    if not h:
        return None
    try:
        return read_object(p, h)
    except Exception:
        return None

def cmd_history(args):
    """파일별 리비전 이력: 해시가 바뀐 스냅샷만 추려 git log 처럼."""
    p = store_paths(args.store)
    target = os.path.abspath(os.path.expanduser(args.path))   # restore/cat 과 같은 해석
    rows = []
    last = "__init__"
    for sid in _snapshot_ids(p):
        m = _manifest(p, sid)
        e = m.get("entries", {}).get(target)
        h = e.get("hash") if e else None
        if h != last:
            rows.append({"snapshot": sid, "time": m.get("time"), "message": m.get("message", ""),
                         "hash": (h[:12] if h else None), "present": e is not None})
            last = h
    print(json.dumps({"path": target, "revisions": rows}, ensure_ascii=False,
                     indent=None if args.json else 2))

def _diff_lines(b: bytes):
    """diff 비교용 줄 목록: 개행 방식(CRLF/LF/CR)과 선두 BOM 을 정규화한다.
    keepends 로 비교하면 저장 주체가 바뀔 때 EOL 이 뒤집힌 파일이 전량 삭제+추가로
    보인다(내용은 그대로인데). blob 은 원본 바이트 그대로 두고 표기만 불감으로."""
    t = b.decode("utf-8", "replace")
    return t.lstrip("﻿").splitlines()

def cmd_diff(args):
    p = store_paths(args.store)
    target = os.path.abspath(os.path.expanduser(args.path))
    ids = _snapshot_ids(p)
    frm = args.frm or (ids[-1] if ids else None)
    to = args.to or "work"
    if frm is None:
        print("스냅샷 없음 (아직 snapshot 안 됨)"); return
    a = _content_at(p, frm, target)
    b = _content_at(p, to, target)
    if a is None and b is None:
        print("양쪽 모두 내용 없음(추적 안 됨/삭제됨)"); return
    diff = "\n".join(difflib.unified_diff(_diff_lines(a or b""), _diff_lines(b or b""),
                                          fromfile=str(frm), tofile=str(to), lineterm=""))
    if diff:
        print(diff)
    elif (a or b"") != (b or b""):
        print("줄 내용 동일 — 개행 방식(CRLF/LF)이나 BOM 만 다름")
    else:
        print("텍스트 변경 없음")

def cmd_show(args):
    p = store_paths(args.store)
    h = _latest_hash_for(p, os.path.abspath(os.path.expanduser(args.path)))
    if not h:
        print("index 에 없음"); return
    sys.stdout.buffer.write(read_object(p, h))

def cmd_cat(args):
    """추적 중인 파일의 현재 내용을 그대로 출력(읽기 전용 뷰어용).
    추적 목록 밖 경로는 거부 — 임의 파일 읽기 통로가 되지 않게."""
    p = store_paths(args.store)
    config = load_config(p)
    target = os.path.abspath(os.path.expanduser(args.path))
    if target not in expand_tracked(config.get("tracked", [])):
        print(json.dumps({"ok": False, "message": f"추적 중인 파일이 아님: {target}"}, ensure_ascii=False))
        sys.exit(1)
    with open(target, "rb") as f:
        sys.stdout.write(f.read().decode("utf-8", "replace"))

def _watcher_state(store):
    """watcher.py 가 쓰는 watcher.json(heartbeat) 을 읽어 상주 여부를 판정.
    heartbeat 가 폴링 간격의 3배 + 5초 안이면 running, 아니면 stale(죽었거나 멈춤).
    watcher-status 와 status --json(watcher 블록) 공용."""
    state_path = os.path.join(store, "watcher.json")
    if not os.path.exists(state_path):
        return {"running": False, "reason": "watcher.json 없음 (watcher 미실행)"}
    try:
        with open(state_path, encoding="utf-8-sig") as f:  # 다른 도구가 BOM 을 붙여도 견디게
            st = json.load(f)
    except (OSError, ValueError) as e:
        # exists 확인과 open 사이에 watcher 종료가 파일을 지울 수 있고(폴링과 겹침),
        # 깨진 JSON 도 있을 수 있다. 여기서 죽으면 status --json 전체(추적 목록)가 죽는다.
        return {"running": False, "reason": f"watcher.json 판독 실패: {type(e).__name__}: {e}"}
    age = None
    stale = True
    err = None
    try:
        hb = _parse_iso(st.get("heartbeat"))
        now = datetime.now(hb.tzinfo) if hb.tzinfo else datetime.now()  # tz-aware/naive 일치
        age = (now - hb).total_seconds()
        thresh = (st.get("debounceMs", 2000) / 1000.0) * 3 + 5
        stale = age > thresh
    except Exception as e:  # 어떤 파싱 이상도 null 대신 원인 보고
        err = f"{type(e).__name__}: {e}"
    return {
        "running": (not stale), "stale": stale, "age_sec": age, "error": err,
        "pid": st.get("pid"), "started": st.get("started"), "heartbeat": st.get("heartbeat"),
        "dirs": st.get("dirs", []), "lastEvent": st.get("lastEvent", ""),
    }

def cmd_watcher_status(args):
    print(json.dumps(_watcher_state(args.store), ensure_ascii=False))

def main():
    ap = argparse.ArgumentParser(prog="cas", description="Custom CAS snapshot engine")
    ap.add_argument("--store", default=DEFAULT_STORE, help=f"저장소 경로 (기본 {DEFAULT_STORE})")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init").set_defaults(func=cmd_init)
    sp = sub.add_parser("track"); sp.add_argument("paths", nargs="+")
    sp.add_argument("--json", action="store_true"); sp.set_defaults(func=cmd_track)
    sp = sub.add_parser("untrack"); sp.add_argument("paths", nargs="+")
    sp.add_argument("--json", action="store_true"); sp.set_defaults(func=cmd_untrack)
    sp = sub.add_parser("status"); sp.add_argument("--json", action="store_true"); sp.set_defaults(func=cmd_status)
    sp = sub.add_parser("snapshot"); sp.add_argument("-m", "--message", default="")
    sp.add_argument("--force", action="store_true"); sp.set_defaults(func=cmd_snapshot)
    sp = sub.add_parser("log"); sp.add_argument("-n", "--limit", type=int, default=20); sp.set_defaults(func=cmd_log)
    sp = sub.add_parser("history"); sp.add_argument("path"); sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_history)
    sp = sub.add_parser("diff"); sp.add_argument("path")
    sp.add_argument("--from", dest="frm"); sp.add_argument("--to", dest="to"); sp.set_defaults(func=cmd_diff)
    sp = sub.add_parser("show"); sp.add_argument("path"); sp.set_defaults(func=cmd_show)
    sp = sub.add_parser("cat"); sp.add_argument("path"); sp.set_defaults(func=cmd_cat)
    sub.add_parser("watcher-status").set_defaults(func=cmd_watcher_status)
    sp = sub.add_parser("restore"); sp.add_argument("path")
    sp.add_argument("--from", dest="frm", required=True, help="복원할 스냅샷 id")
    sp.add_argument("--no-snapshot", action="store_true", help="복원 전 스냅샷 생략")
    sp.add_argument("--no-backup", action="store_true", help=".bak 백업 생략")
    sp.set_defaults(func=cmd_restore)

    args = ap.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
