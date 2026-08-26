#!/usr/bin/env python3
r"""test_remote_library.py - 원격 라이브러리 & 마켓플레이스 서브시스템 테스트.

의존성 0: 표준 unittest(pytest 로도 실행됨).
  python -m unittest tests.test_remote_library -v
  python -m pytest tests/test_remote_library.py

fetch 계열은 네트워크 대신 로컬 `git init` 픽스처 레포로 검증한다.
"""
import hashlib, http.server, json, os, shutil, subprocess, sys, tempfile, threading, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), "src")
LIB = os.path.join(SRC, "library.py")
CAS = os.path.join(SRC, "cas.py")
sys.path.insert(0, SRC)          # 모듈 직접 import(순수 함수 단위 테스트용)
sys.path.insert(0, HERE)         # test_smoke 의 run() 재사용
from test_smoke import run       # noqa: E402


class LibStore(unittest.TestCase):
    """lib_store.py: store config 원자적 입출력 + 미초기화 시 명시적 실패."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="libstore_test_")
        self.store = os.path.join(self.tmp, "store")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_save_raises_when_store_uninitialized(self):
        # 조용한 등록 실패 회귀 가드: store 가 없으면 False 를 삼키지 말고 예외를 던진다.
        import lib_store
        with self.assertRaises(lib_store.StoreNotInitialized):
            lib_store.save_cfg(self.store, {"libraries": []})

    def test_roundtrip_preserves_unknown_keys(self):
        # 원장/remotes 를 쓰는 코드가 기존 키를 날리지 않아야 한다.
        import lib_store
        run(CAS, "--store", self.store, "init")
        cfg = lib_store.load_cfg(self.store)
        cfg["libraries"] = []                       # library.py 소유 키(cas init 은 안 만듦)
        cfg.setdefault("remotes", []).append({"id": "x", "url": "u"})
        lib_store.save_cfg(self.store, cfg)
        again = lib_store.load_cfg(self.store)
        self.assertEqual(again["remotes"], [{"id": "x", "url": "u"}])
        self.assertIn("libraries", again)
        self.assertIn("tracked", again)             # cas init 이 만든 키 보존


class Ledger(unittest.TestCase):
    """출처 원장: 키는 타깃 경로, origin 은 필드. 방향이 뒤집히면 conflict 가 죽는다."""

    def setUp(self):
        import lib_store
        self.ls = lib_store
        self.cfg = {}
        self.tgt = os.path.join("C:\\Users\\u", ".claude") if os.name == "nt" else "/home/u/.claude"

    def test_two_origins_same_name_collide_on_one_key(self):
        # 이 테스트가 원장 방향의 존재 이유다: 서로 다른 출처의 같은 이름이
        # **같은 키**에 앉아야 두 번째 설치가 첫 번째의 소유권을 본다.
        self.ls.ledger_put(self.cfg, self.tgt, "skills", "code-review",
                           {"origin": "market:official/plugin-a", "src_hash": "h1"})
        got = self.ls.ledger_get(self.cfg, self.tgt, "skills", "code-review")
        self.assertEqual(got["origin"], "market:official/plugin-a")

        rows = self.cfg["installed"][self.ls.ledger_root_key(self.tgt)]
        self.assertEqual(list(rows), ["skills/code-review"])   # 항목 1개 - origin 별로 갈라지지 않음

    def test_key_is_case_and_separator_normalized(self):
        self.ls.ledger_put(self.cfg, self.tgt, "agents", "a1", {"origin": "local:d:\\x"})
        alt = self.tgt.replace("\\", "/") if os.name == "nt" else self.tgt + "/"
        self.assertIsNotNone(self.ls.ledger_get(self.cfg, alt, "agents", "a1"))

    def test_del_is_idempotent(self):
        self.ls.ledger_put(self.cfg, self.tgt, "agents", "a1", {"origin": "local:x"})
        self.ls.ledger_del(self.cfg, self.tgt, "agents", "a1")
        self.ls.ledger_del(self.cfg, self.tgt, "agents", "a1")   # 두 번째도 조용히 no-op
        self.assertIsNone(self.ls.ledger_get(self.cfg, self.tgt, "agents", "a1"))

    def test_refs_root_finds_hooks_holding_a_cache_dir(self):
        # unregister 가드의 근거: 이 캐시를 붙잡고 있는 원장 항목을 찾아낸다.
        root = os.path.join("D:\\cache", "plugins", "sg", "abc123")
        self.ls.ledger_put(self.cfg, self.tgt, "hooks", "security-guidance",
                           {"kind": "hooks", "origin": "market:official/security-guidance", "root": root})
        self.ls.ledger_put(self.cfg, self.tgt, "agents", "a1", {"origin": "local:x"})
        hits = self.ls.ledger_refs_root(self.cfg, root)
        self.assertEqual([h["key"] for h in hits], ["hooks/security-guidance"])
        self.assertEqual(self.ls.ledger_refs_root(self.cfg, os.path.join("D:\\cache", "other")), [])

    def test_refs_root_matches_descendant_but_not_sibling_prefix(self):
        # 번들(str-path) 플러그인의 root 는 <market repo cache>/plugins/<name> 로
        # 마켓 레포 캐시의 하위다. exact-equality 만 보면 unregister --origin market:<id> 가
        # 그 하위 root 를 붙잡은 hooks/MCP 원장을 못 찾아 캐시를 지워버린다(원장은 죽은 경로 참조).
        cache_root = os.path.join("D:\\cache", "markets", "mk", "repo")
        descendant = os.path.join(cache_root, "plugins", "bundled")
        self.ls.ledger_put(self.cfg, self.tgt, "hooks", "bundled-hook",
                           {"kind": "hooks", "origin": "market:mk/bundled", "root": descendant})
        hits = self.ls.ledger_refs_root(self.cfg, cache_root)
        self.assertEqual([h["key"] for h in hits], ["hooks/bundled-hook"])

        # 같은 이름 접두를 공유하는 형제("...\repo-extra")는 매치되면 안 된다 -
        # 문자열 startswith(구분자 없이) 만 쓰면 "...\repo" 가 "...\repo-extra" 에 거짓 매치된다.
        self.cfg = {}
        sibling = os.path.join(os.path.dirname(cache_root), "repo-extra")
        self.ls.ledger_put(self.cfg, self.tgt, "hooks", "sibling-hook",
                           {"kind": "hooks", "origin": "market:mk/other", "root": sibling})
        self.assertEqual(self.ls.ledger_refs_root(self.cfg, cache_root), [])


class LayoutDetect(unittest.TestCase):
    """레이아웃 탐지: 소문자/대문자/깊이2/SKILL.md 마커. 대소문자 구분 FS 를 가정한다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="layout_test_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def mk(self, *parts, file=None, body="x"):
        d = os.path.join(self.tmp, *parts)
        os.makedirs(d, exist_ok=True)
        if file:
            with open(os.path.join(d, file), "w", encoding="utf-8") as f:
                f.write(body)
        return d

    def test_lowercase_root_is_adopted_with_identity_map(self):
        import remote_fetch
        self.mk("agents"); self.mk("skills"); self.mk("commands")
        r = remote_fetch.detect_layout(self.tmp)
        self.assertEqual(sorted(r["found"]), ["agents", "commands", "skills"])
        self.assertEqual(r["map"]["skills"], "skills")

    def test_uppercase_root_is_matched_case_insensitively(self):
        # my-tools 실물 레이아웃: Agents/ Skills/ - Windows 에선 지금도 잡히지만
        # 대소문자 구분 FS 사용자에게도 동작해야 한다.
        import remote_fetch
        self.mk("Agents"); self.mk("Skills")
        r = remote_fetch.detect_layout(self.tmp)
        self.assertEqual(sorted(r["found"]), ["agents", "skills"])
        self.assertEqual(r["map"]["agents"], "Agents")     # 실제 디스크 표기를 돌려준다
        self.assertEqual(r["map"]["skills"], "Skills")

    def test_depth_two_becomes_candidate_not_auto_adopted(self):
        import remote_fetch
        self.mk("packages", "skills")
        r = remote_fetch.detect_layout(self.tmp)
        self.assertEqual(r["found"], [])                   # 루트에 없으므로 자동 채택 안 함
        self.assertIn({"category": "skills", "path": os.path.join("packages", "skills")},
                      r["candidates"])

    def test_lowercase_skill_md_marker_is_detected(self):
        # _iter_items 의 `if "SKILL.md" in names` 는 대소문자를 구분한다.
        # 카테고리 디렉토리만 고치면 skill.md 를 쓴 레포는 여전히 안 잡힌다.
        import remote_fetch
        self.mk("kit", "my-skill", file="skill.md")
        r = remote_fetch.detect_layout(self.tmp)
        self.assertIn({"category": "skills", "path": "kit"}, r["candidates"])

    def test_empty_repo_yields_nothing_but_does_not_raise(self):
        import remote_fetch
        r = remote_fetch.detect_layout(self.tmp)
        self.assertEqual(r["found"], [])
        self.assertEqual(r["candidates"], [])
        self.assertEqual(r["map"], {})


def _git(cwd, *args):
    subprocess.run(["git", "-c", "core.autocrlf=false", *args], cwd=cwd, check=True,
                   capture_output=True, text=True)


def _norm_path(p):
    """행 매칭용 경로 정규화. 등록은 realpath 로 저장하는데 테스트가 넘긴 문자열은 그대로라
    (심볼릭 링크된 임시 디렉토리에서) 문자열 비교가 어긋난다."""
    return os.path.normcase(os.path.realpath(p))


@unittest.skipIf(shutil.which("git") is None, "git 없음")
class Materialize(unittest.TestCase):
    """fetch 는 네트워크 대신 로컬 git 픽스처 레포로 검증한다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mat_test_")
        self.origin = os.path.join(self.tmp, "origin")
        os.makedirs(os.path.join(self.origin, "skills", "s1"))
        os.makedirs(os.path.join(self.origin, "plugins", "p1"))
        for p, body in ((os.path.join("skills", "s1", "SKILL.md"), "---\nname: s1\n---\nbody\n"),
                        (os.path.join("plugins", "p1", "note.md"), "plugin file\n"),
                        ("README.md", "readme\n")):
            with open(os.path.join(self.origin, p), "w", encoding="utf-8") as f:
                f.write(body)
        _git(self.origin, "init", "-q", "-b", "main")
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
        self.head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.origin,
                                   capture_output=True, text=True).stdout.strip()
        self.url = "file:///" + self.origin.replace("\\", "/").lstrip("/")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_materialize_by_ref_returns_resolved_sha(self):
        import remote_fetch
        dest = os.path.join(self.tmp, "cache1")
        sha = remote_fetch.materialize(dest, self.url, ref="main")
        self.assertEqual(sha, self.head)
        self.assertTrue(os.path.exists(os.path.join(dest, "skills", "s1", "SKILL.md")))

    def test_materialize_by_sha_is_reproducible(self):
        import remote_fetch
        dest = os.path.join(self.tmp, "cache2")
        sha = remote_fetch.materialize(dest, self.url, sha=self.head)
        self.assertEqual(sha, self.head)

    def test_sparse_checkout_limits_worktree(self):
        import remote_fetch
        dest = os.path.join(self.tmp, "cache3")
        remote_fetch.materialize(dest, self.url, ref="main", sparse=["plugins/p1"])
        self.assertTrue(os.path.exists(os.path.join(dest, "plugins", "p1", "note.md")))
        self.assertFalse(os.path.exists(os.path.join(dest, "skills", "s1", "SKILL.md")))

    def test_sparse_can_be_expanded_in_place(self):
        # 마켓 지연 확장의 핵심 동작: 매니페스트만 받아둔 클론에 경로를 덧붙인다.
        import remote_fetch
        dest = os.path.join(self.tmp, "cache4")
        remote_fetch.materialize(dest, self.url, ref="main", sparse=["plugins/p1"])
        remote_fetch.materialize(dest, self.url, ref="main", sparse=["plugins/p1", "skills"])
        self.assertTrue(os.path.exists(os.path.join(dest, "skills", "s1", "SKILL.md")))

    def test_bad_url_raises_giterror_without_leaving_partial_cache(self):
        import remote_fetch
        dest = os.path.join(self.tmp, "cache5")
        with self.assertRaises(remote_fetch.GitError):
            remote_fetch.materialize(dest, "file:///definitely/not/a/repo", ref="main")
        self.assertFalse(os.path.exists(os.path.join(dest, ".git", "FETCH_HEAD")))

    def test_autocrlf_is_disabled_in_materialized_clone(self):
        # 줄바꿈 정규화는 내용 해시를 바꿔 허위 modified 를 만든다.
        import remote_fetch
        dest = os.path.join(self.tmp, "cache6")
        remote_fetch.materialize(dest, self.url, ref="main")
        got = subprocess.run(["git", "config", "--local", "core.autocrlf"], cwd=dest,
                             capture_output=True, text=True).stdout.strip()
        self.assertEqual(got, "false")

    def test_longpaths_is_enabled_in_materialized_clone(self):
        # Windows MAX_PATH(260자) 를 넘는 캐시 경로에서 git 이 자기 내부 파일을
        # "Filename too long" 으로 못 쓰는 걸 막는다 - 외부 플러그인은 캐시 아래
        # <market-id>/plugins/<name>/<40자 sha>/ 로 깊이 파고들어 여유가 금방 잠식된다.
        import remote_fetch
        dest = os.path.join(self.tmp, "cache_longpaths")
        remote_fetch.materialize(dest, self.url, ref="main")
        got = subprocess.run(["git", "config", "--local", "core.longpaths"], cwd=dest,
                             capture_output=True, text=True).stdout.strip()
        self.assertEqual(got, "true")

    def test_materialize_rejects_malicious_urls_independently_of_marketplace(self):
        # 리뷰 Finding 2: marketplace.py 를 거치지 않는 호출(사용자가 직접 --url 로 넘긴
        # remote-add/market-add)도 같은 방어가 필요하다 - remote_fetch 는 marketplace 를
        # import 하지 않으므로 독립적으로 재검증한다. 이 머신에서 실제로 전송 헬퍼(ext::)를
        # 실행시키지 않기 위해 비실행형 케이스(--옵션 주입, 허용 목록 밖 스킴)로 확인한다.
        # git 이 실제로 불리기 전에 거부돼야 하므로 실패 사유가 검증 메시지인지도 확인한다
        # (pre-fix 에서는 git 자신이 실패해도 같은 GitError 타입이 나와 구분이 안 됐다).
        import remote_fetch
        dest = os.path.join(self.tmp, "cache7")
        with self.assertRaises(remote_fetch.GitError) as cm:
            remote_fetch.materialize(dest, "--upload-pack=evil", ref="main")
        self.assertIn("옵션처럼", str(cm.exception))
        self.assertFalse(os.path.exists(dest))

        dest2 = os.path.join(self.tmp, "cache8")
        with self.assertRaises(remote_fetch.GitError) as cm:
            remote_fetch.materialize(dest2, "ftp://example.invalid/x.git", ref="main")
        self.assertIn("허용 목록", str(cm.exception))
        self.assertFalse(os.path.exists(dest2))

    def test_materialize_rejects_option_like_ref_and_non_hex_sha(self):
        # 메시지로 판별한다: git 자신도 이런 값에 결국 실패하지만(예: sha 불일치로 뒤늦게),
        # 검증이 있으면 git 을 부르기도 전에 우리 메시지로 즉시 죽는다 - 디렉토리 생성 전이므로
        # dest 도 안 남는다(pre-fix 에서는 git 이 일부 파일을 쓴 뒤 실패해 정리가 완벽하지
        # 않을 수 있다 - 그건 이 수정과 무관한 별개의 Windows rmtree 이슈다).
        import remote_fetch
        dest = os.path.join(self.tmp, "cache9")
        with self.assertRaises(remote_fetch.GitError) as cm:
            remote_fetch.materialize(dest, self.url, ref="--upload-pack=evil")
        self.assertIn("유효하지 않음", str(cm.exception))
        self.assertFalse(os.path.exists(dest))

        dest2 = os.path.join(self.tmp, "cache10")
        with self.assertRaises(remote_fetch.GitError) as cm:
            remote_fetch.materialize(dest2, self.url, sha="not-hex!")
        self.assertIn("hex 아님", str(cm.exception))
        self.assertFalse(os.path.exists(dest2))


class ScanRecords(unittest.TestCase):
    """_load_libs 가 레코드를 돌려주고 cmd_scan 이 source/origin 을 방출한다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="scanrec_test_")
        self.store = os.path.join(self.tmp, "store")
        self.lib = os.path.join(self.tmp, "kit", ".claude")
        self.target = os.path.join(self.tmp, ".claude")
        os.makedirs(os.path.join(self.lib, "agents"))
        with open(os.path.join(self.lib, "agents", "a1.md"), "w", encoding="utf-8") as f:
            f.write("agent body\n")
        run(CAS, "--store", self.store, "init")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def libcmd(self, *args):
        return run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot", *args)

    def test_scan_emits_origin_for_local_library(self):
        rc, out, err = self.libcmd("scan", "--lib", self.lib)
        self.assertEqual(rc, 0, err)
        l = json.loads(out)["libraries"][0]
        self.assertEqual(l["source"], "registered")
        self.assertEqual(l["origin"], "local:" + os.path.normcase(os.path.normpath(self.lib)))
        self.assertEqual(l["categories"]["agents"][0]["origin"], l["origin"])

    def test_uppercase_category_dirs_are_scanned_via_map(self):
        # my-tools 레이아웃: Agents/ Skills/. 대소문자 구분 FS 에서도 잡혀야 한다.
        up = os.path.join(self.tmp, "upkit")
        os.makedirs(os.path.join(up, "Skills", "s1"))
        with open(os.path.join(up, "Skills", "s1", "SKILL.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: s1\n---\n")
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        cfg.setdefault("remotes", []).append(
            {"id": "upkit", "url": "u", "cache": up, "map": {"skills": "Skills"}})
        lib_store.save_cfg(self.store, cfg)
        rc, out, err = self.libcmd("scan")
        self.assertEqual(rc, 0, err)
        rec = [l for l in json.loads(out)["libraries"] if l["lib"] == up][0]
        self.assertEqual(rec["source"], "remote")
        self.assertEqual(rec["origin"], "remote:upkit")
        self.assertEqual([i["name"] for i in rec["categories"]["skills"]], ["s1"])

    def test_missing_remote_cache_reports_error_row_not_silence(self):
        # 캐시가 사라져도 '행 자체'는 남아야 사용자가 다시 받아올 수 있다.
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        gone = os.path.join(self.tmp, "gone")
        cfg.setdefault("remotes", []).append({"id": "gone", "url": "u", "cache": gone})
        lib_store.save_cfg(self.store, cfg)
        rc, out, err = self.libcmd("scan")
        self.assertEqual(rc, 0, err)
        rec = [l for l in json.loads(out)["libraries"] if l["lib"] == gone][0]
        self.assertEqual(rec["error"], "경로 없음")
        self.assertEqual(rec["source"], "remote")

    def test_scan_stays_offline(self):
        # scan 이 git 을 부르면 refreshLibrary 가 매 새로고침마다 멈춘다.
        # --lib 를 쓰면 fast-path 라 _load_libs/remotes[] 자체가 안 돈다 - 이 테스트는
        # 아무것도 검증 못 하고 항상 통과한다. remotes[] 를 심고 --lib 없이 돌려서
        # 실제로 remotes[] 를 순회하는 경로(나중에 누가 fetch 를 여기 넣어도 잡히는 경로)를 태운다.
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        cfg.setdefault("remotes", []).append(
            {"id": "offlinekit", "url": "u", "cache": self.lib})
        lib_store.save_cfg(self.store, cfg)
        rc, out, err = run(LIB, "--store", self.store, "--target", self.target,
                           "--no-snapshot", "scan", env={"PATH": ""})
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])

    def test_install_with_lib_and_origin_resolves_remote_record_not_local(self):
        # UI 조합(Task 9): install 이 --lib 에 캐시 경로, --origin 에 remote:<id> 를 함께 보낸다.
        # --lib 를 무조건 local: 로 재합성하면 --origin 필터가 항상 빈 결과가 되어
        # 원격 레포 설치가 전부 실패한다(리뷰에서 재현된 회귀). 대문자 카테고리 디렉토리(map)도
        # --lib 재합성 시 map 이 None 으로 날아가면 마찬가지로 못 찾는다 - 함께 검증한다.
        up = os.path.join(self.tmp, "upkit2")
        os.makedirs(os.path.join(up, "Agents"))
        with open(os.path.join(up, "Agents", "a1.md"), "w", encoding="utf-8") as f:
            f.write("agent body\n")
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        cfg.setdefault("remotes", []).append(
            {"id": "upkit2", "url": "u", "cache": up, "map": {"agents": "Agents"}})
        lib_store.save_cfg(self.store, cfg)
        rc, out, err = self.libcmd("install", "agents", "a1", "--lib", up, "--origin", "remote:upkit2")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertEqual(res["origin"], "remote:upkit2")
        self.assertTrue(os.path.exists(os.path.join(self.target, "agents", "a1.md")))
        cfg2 = lib_store.load_cfg(self.store)
        rec = lib_store.ledger_get(cfg2, self.target, "agents", "a1")
        self.assertIsNotNone(rec)
        self.assertEqual(rec["origin"], "remote:upkit2")   # local:... 이면 회귀


class ScanEnumerationErrors(unittest.TestCase):
    """fix round 2: os.walk 나열 실패(onerror=None 기본값)가 조용히 '항목 0개' 로 둔갑하던
    버그. 진짜 빈 라이브러리(예외 없음)와 나열 실패(예외 있음)는 구분돼야 한다.

    프로세스 안에서 cmd_scan 을 직접 호출하고 os.walk 를 부분적으로 몽키패치한다 - 실제
    260+ 문자 경로를 만들지 않고도 같은 실패 모양(OSError)을 재현하기 위해서다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="scanerr_test_")
        self.store = os.path.join(self.tmp, "store")
        self.target = os.path.join(self.tmp, ".claude")
        self.lib = os.path.join(self.tmp, "kit", ".claude")
        os.makedirs(os.path.join(self.lib, "skills", "s1"))
        with open(os.path.join(self.lib, "skills", "s1", "SKILL.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: s1\n---\n")
        os.makedirs(os.path.join(self.lib, "agents"))
        with open(os.path.join(self.lib, "agents", "a1.md"), "w", encoding="utf-8") as f:
            f.write("agent\n")
        run(CAS, "--store", self.store, "init")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _scan_inprocess(self, lib):
        import argparse, contextlib, io, library
        a = argparse.Namespace(store=self.store, target=self.target, lib=lib)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            library.cmd_scan(a)
        return json.loads(buf.getvalue())

    def test_enumeration_failure_surfaces_error_not_zero_items(self):
        import os as _os
        from unittest import mock
        broken = _os.path.normcase(_os.path.normpath(_os.path.join(self.lib, "skills")))
        real_walk = _os.walk

        def flaky_walk(path, *args, **kwargs):
            if _os.path.normcase(_os.path.normpath(path)) == broken:
                def _gen():
                    raise OSError("simulated: enumeration failed (path too long)")
                    yield  # pragma: no cover - never reached, keeps this a generator
                return _gen()
            return real_walk(path, *args, **kwargs)

        with mock.patch("os.walk", side_effect=flaky_walk):
            res = self._scan_inprocess(self.lib)
        self.assertTrue(res["ok"])
        row = res["libraries"][0]
        self.assertIn("error", row,
                      "나열 실패는 error 로 드러나야 한다 - 항목 0개로 조용히 넘기면 안 됨")
        self.assertEqual(row["categories"]["skills"], [])
        # 한 카테고리의 나열 실패가 다른 카테고리·다른 라이브러리까지 끌고 내려가면 안 된다.
        self.assertEqual([i["name"] for i in row["categories"]["agents"]], ["a1"])

    def test_genuinely_empty_library_reports_zero_items_without_error(self):
        empty_lib = os.path.join(self.tmp, "empty", ".claude")
        os.makedirs(empty_lib)   # agents/skills/commands 서브디렉토리 자체가 없다
        res = self._scan_inprocess(empty_lib)
        self.assertTrue(res["ok"])
        row = res["libraries"][0]
        self.assertNotIn("error", row,
                         "진짜 빈 라이브러리는 error 를 달면 안 된다(나열 실패와 혼동 금지)")
        self.assertEqual(row["categories"], {"agents": [], "skills": [], "commands": []})


class ComponentCounting(unittest.TestCase):
    """fix round 3: _count_components 는 '진짜 0개'와 '못 읽음'을 같은 0 으로 뭉개면 안 된다.
    실패한 카테고리는 counts 에 아예 안 나타나고 failed 로만 갈라져야 한다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cc_test_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_count_components_distinguishes_zero_from_unreadable(self):
        import library
        from unittest import mock
        os.makedirs(os.path.join(self.tmp, "skills", "s1"))
        with open(os.path.join(self.tmp, "skills", "s1", "SKILL.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: s1\n---\n")
        os.makedirs(os.path.join(self.tmp, "commands"))   # 존재하지만 진짜 비어 있음
        # agents/ 는 아예 안 만든다 - 그것도 "진짜 없음" 의 또 다른 모양이다.
        broken = os.path.normcase(os.path.normpath(os.path.join(self.tmp, "skills")))
        real_walk = os.walk

        def flaky_walk(path, *args, **kwargs):
            if os.path.normcase(os.path.normpath(path)) == broken:
                def _gen():
                    raise OSError("simulated: enumeration failed (path too long)")
                    yield  # pragma: no cover - never reached, keeps this a generator
                return _gen()
            return real_walk(path, *args, **kwargs)

        with mock.patch("os.walk", side_effect=flaky_walk):
            result = library._count_components(self.tmp)

        self.assertEqual(result["counts"]["commands"], 0, "진짜 빈 카테고리는 0 이어야 한다")
        self.assertEqual(result["counts"]["agents"], 0, "디렉토리 자체가 없는 것도 0 이어야 한다")
        self.assertNotIn("skills", result["counts"],
                         "나열 실패한 카테고리는 counts 에 0 으로 나타나면 안 된다")
        self.assertIn("skills", result["failed"], "나열 실패는 failed 에 사유와 함께 남아야 한다")
        self.assertTrue(result["failed"]["skills"])   # 사유 문자열이 비어 있지 않다


class ConflictStatus(unittest.TestCase):
    """이름 충돌: 원장이 소유자를 기억해 두 번째 출처의 설치를 조용한 덮어쓰기가 아니라 conflict 로 만든다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="conflict_test_")
        self.store = os.path.join(self.tmp, "store")
        self.target = os.path.join(self.tmp, ".claude")
        os.makedirs(self.target)
        self.libA = self._mkkit("kitA", "from A\n")
        self.libB = self._mkkit("kitB", "from B\n")
        run(CAS, "--store", self.store, "init")

    def _mkkit(self, name, body):
        d = os.path.join(self.tmp, name)
        os.makedirs(os.path.join(d, "agents"))
        with open(os.path.join(d, "agents", "code-reviewer.md"), "w", encoding="utf-8") as f:
            f.write(body)
        return d

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def libcmd(self, *args):
        return run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot", *args)

    def _status_of(self, lib):
        rc, out, err = self.libcmd("scan", "--lib", lib)
        self.assertEqual(rc, 0, err)
        return json.loads(out)["libraries"][0]["categories"]["agents"][0]

    def test_second_origin_sees_conflict_not_modified(self):
        # 이 기능의 존재 이유. B 는 예전이라면 'modified'(=동기화 가능)로 보여서
        # 누르면 A 를 조용히 덮어썼다.
        self.libcmd("scan", "--lib", self.libA)
        rc, out, err = self.libcmd("install", "agents", "code-reviewer", "--lib", self.libA)
        self.assertEqual(rc, 0, err)
        self.assertEqual(self._status_of(self.libA)["status"], "installed")

        it = self._status_of(self.libB)
        self.assertEqual(it["status"], "conflict")
        self.assertEqual(it["owner"], "local:" + os.path.normcase(os.path.normpath(self.libA)))

    def test_ledger_absent_falls_back_to_hash_compare(self):
        # 하위호환: 기능 도입 전 설치분/대시보드 밖에서 생긴 것은 오늘과 동일하게 동작.
        os.makedirs(os.path.join(self.target, "agents"), exist_ok=True)
        with open(os.path.join(self.target, "agents", "code-reviewer.md"), "w", encoding="utf-8") as f:
            f.write("from A\n")
        self.assertEqual(self._status_of(self.libA)["status"], "installed")
        self.assertEqual(self._status_of(self.libB)["status"], "modified")

    def test_uninstall_refuses_when_origin_mismatches_owner(self):
        self.libcmd("scan", "--lib", self.libA)
        self.libcmd("install", "agents", "code-reviewer", "--lib", self.libA)
        rc, out, err = self.libcmd("uninstall", "agents", "code-reviewer",
                                   "--origin", "local:" + os.path.normcase(os.path.normpath(self.libB)))
        self.assertNotEqual(rc, 0)
        res = json.loads(out)
        self.assertFalse(res["ok"])
        self.assertIn("local:", res.get("owner", ""))
        self.assertTrue(os.path.exists(os.path.join(self.target, "agents", "code-reviewer.md")),
                        "거부했으면 파일이 남아 있어야 한다")

    def test_uninstall_clears_ledger_entry(self):
        self.libcmd("scan", "--lib", self.libA)
        self.libcmd("install", "agents", "code-reviewer", "--lib", self.libA)
        rc, out, err = self.libcmd("uninstall", "agents", "code-reviewer")
        self.assertEqual(rc, 0, err)
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        self.assertIsNone(lib_store.ledger_get(cfg, self.target, "agents", "code-reviewer"))
        self.assertEqual(self._status_of(self.libB)["status"], "not_installed")

    def test_overwrite_after_conflict_transfers_ownership(self):
        self.libcmd("scan", "--lib", self.libA)
        self.libcmd("install", "agents", "code-reviewer", "--lib", self.libA)
        rc, out, err = self.libcmd("install", "agents", "code-reviewer", "--lib", self.libB)
        self.assertEqual(rc, 0, err)
        self.assertEqual(self._status_of(self.libB)["status"], "installed")
        self.assertEqual(self._status_of(self.libA)["status"], "conflict")   # 이제 A 가 남


@unittest.skipIf(shutil.which("git") is None, "git 없음")
class RemoteAdd(unittest.TestCase):
    """remote-add: clone -> 레이아웃 탐지 -> 등록 영속화. 등록 실패는 ok:false 로 보고."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="remoteadd_test_")
        self.store = os.path.join(self.tmp, "store")
        self.target = os.path.join(self.tmp, ".claude")
        self.origin = os.path.join(self.tmp, "origin")
        os.makedirs(os.path.join(self.origin, "Skills", "s1"))
        os.makedirs(os.path.join(self.origin, "Agents"))
        with open(os.path.join(self.origin, "Skills", "s1", "SKILL.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: s1\n---\nbody\n")
        with open(os.path.join(self.origin, "Agents", "a1.md"), "w", encoding="utf-8") as f:
            f.write("agent\n")
        _git(self.origin, "init", "-q", "-b", "main")
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
        self.url = "file:///" + self.origin.replace("\\", "/").lstrip("/")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def libcmd(self, *args):
        return run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot", *args)

    def test_remote_add_registers_and_detects_uppercase_layout(self):
        run(CAS, "--store", self.store, "init")
        rc, out, err = self.libcmd("remote-add", "--url", self.url, "--ref", "main")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])
        self.assertEqual(res["id"], "origin")                 # URL 에서 레포명 파생
        self.assertEqual(res["origin"], "remote:origin")
        self.assertEqual(sorted(res["layout"]["found"]), ["agents", "skills"])
        self.assertEqual(res["layout"]["map"]["skills"], "Skills")
        self.assertTrue(os.path.isdir(res["cache"]))
        # 등록이 영속돼 다음 scan 이 --lib 없이 잡는다
        rc, out, err = self.libcmd("scan")
        rec = [l for l in json.loads(out)["libraries"] if l["source"] == "remote"][0]
        self.assertEqual([i["name"] for i in rec["categories"]["skills"]], ["s1"])

    def test_remote_add_reports_store_uninitialized_instead_of_lying(self):
        # 회귀 가드: 예전 _register_lib 은 조용히 False 를 반환했고 UI 는 '등록됨' 토스트를 띄웠다.
        rc, out, err = self.libcmd("remote-add", "--url", self.url, "--ref", "main")
        res = json.loads(out)
        self.assertFalse(res["ok"])
        self.assertIn("초기화", res["message"])

    def test_remote_add_is_idempotent_on_same_id(self):
        run(CAS, "--store", self.store, "init")
        self.libcmd("remote-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("remote-add", "--url", self.url, "--ref", "main")
        self.assertEqual(rc, 0, err)
        import lib_store
        self.assertEqual(len(lib_store.load_cfg(self.store)["remotes"]), 1)

    def test_remote_add_without_git_fails_clearly(self):
        run(CAS, "--store", self.store, "init")
        rc, out, err = run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot",
                           "remote-add", "--url", self.url, "--ref", "main", env={"PATH": ""})
        res = json.loads(out)
        self.assertFalse(res["ok"])
        self.assertIn("git", res["message"])


class Manifest(unittest.TestCase):
    """매니페스트 파싱 + renames 는 조회 해석 전용(구→신 단방향)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mf_test_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, obj):
        d = os.path.join(self.tmp, ".claude-plugin")
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "marketplace.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(obj, f)
        return p

    def test_parse_indexes_plugins_by_name(self):
        import marketplace
        p = self.write({"name": "official", "plugins": [
            {"name": "convex", "displayName": "Convex", "source": "./plugins/convex"},
            {"name": "superpowers", "source": {"source": "url", "url": "u", "sha": "s"}}]})
        mf = marketplace.parse_manifest(p)
        self.assertEqual(mf["name"], "official")
        self.assertEqual(sorted(mf["by_name"]), ["convex", "superpowers"])

    def test_renames_resolve_old_name_to_current_entry(self):
        # 업스트림 개명 후에도 원장의 옛 origin 이 붕 뜨지 않아야 한다.
        import marketplace
        p = self.write({"name": "official",
                        "plugins": [{"name": "convex", "source": "./plugins/convex"}],
                        "renames": {"convex-backend": "convex"}})
        mf = marketplace.parse_manifest(p)
        entry, canon = marketplace.resolve_plugin(mf, "convex-backend")
        self.assertEqual(canon, "convex")          # 신 이름으로 정규화해 돌려준다
        self.assertEqual(entry["name"], "convex")

    def test_renames_does_not_resolve_new_to_old(self):
        # 방향이 반대면 안 된다(key=구, value=신). 예전 버전은 resolve_plugin(mf, "nope") 로
        # "매니페스트 어디에도 없는 이름"을 던졌는데, 정방향 전용이든 버그로 역방향까지
        # 지원하든 결과가 똑같이 (None, None) 이라 실제로는 방향을 판별하지 못했다(리뷰 지적).
        # 판별 가능한 픽스처: old-name 엔트리를 실제로 살려 둬서, 역방향 해석 버그가 있으면
        # "new-name" 조회가 old-name 엔트리로 튀는 게 관측되게 만든다.
        import marketplace
        p = self.write({"name": "o",
                        "plugins": [{"name": "convex", "source": "./p"},
                                    {"name": "old-name", "source": "./p"}],
                        "renames": {"convex-backend": "convex", "old-name": "new-name"}})
        mf = marketplace.parse_manifest(p)
        # "convex"(신 이름)를 직접 조회하면 hop 없이 그 자신이 canonical 이어야 한다.
        entry, canon = marketplace.resolve_plugin(mf, "convex")
        self.assertEqual((canon, entry["name"]), ("convex", "convex"))
        # "new-name" 은 renames 의 값으로만 존재한다(정방향: old-name -> new-name).
        # 역방향(신->구) 해석이 있다면 old-name 엔트리(실재함)로 튀어 (entry, "old-name") 를
        # 반환할 것이다 - 정방향 전용이면 by_name 에 "new-name" 이 없으므로 (None, None).
        self.assertEqual(marketplace.resolve_plugin(mf, "new-name"), (None, None))

    def test_rename_chain_does_not_loop_forever(self):
        import marketplace
        p = self.write({"name": "o", "plugins": [{"name": "c", "source": "./p"}],
                        "renames": {"a": "b", "b": "a"}})     # 순환
        mf = marketplace.parse_manifest(p)
        self.assertEqual(marketplace.resolve_plugin(mf, "a"), (None, None))

    def test_display_name_prefers_displayName(self):
        import marketplace
        self.assertEqual(marketplace.display_name({"name": "convex", "displayName": "Convex"}), "Convex")
        self.assertEqual(marketplace.display_name({"name": "qodo"}), "qodo")

    def test_malformed_manifest_raises_manifesterror(self):
        import marketplace
        p = self.write({"name": "o"})                          # plugins 없음
        with self.assertRaises(marketplace.ManifestError):
            marketplace.parse_manifest(p)

    def test_malformed_entry_name_is_skipped_not_indexed(self):
        # 이름 자체가 경로 이탈("..")이면 by_name 에 아예 안 실린다 - resolve_plugin 이
        # 원천적으로 도달 못 하게 한다(리뷰 Finding 1).
        import marketplace
        p = self.write({"name": "o", "plugins": [
            {"name": "..", "source": "./p"},
            {"name": "ok", "source": "./p"}]})
        mf = marketplace.parse_manifest(p)
        self.assertEqual(sorted(mf["by_name"]), ["ok"])

    def test_resolve_plugin_rejects_unsafe_canonical_name_from_renames(self):
        # 리뷰 Finding 1 재현: renames 타깃이 경로 이탈이면 그 이름으로 해석해서는 안 된다.
        # plugins[] 에 같은 이름의 엔트리가 있어도(정상이라면 있을 수 없지만, 매니페스트는
        # 신뢰할 수 없는 입력이므로 있다고 가정한다) 여전히 거부해야 한다 - by_name 인덱싱과
        # resolve_plugin 양쪽에서 막는다(방어 심층화).
        import marketplace
        p = self.write({"name": "o",
                        "plugins": [{"name": "../../ESCAPED", "source": "./p"}],
                        "renames": {"good": "../../ESCAPED"}})
        mf = marketplace.parse_manifest(p)
        self.assertNotIn("../../ESCAPED", mf["by_name"])      # by_name 인덱싱 단계에서 걸러짐
        self.assertEqual(marketplace.resolve_plugin(mf, "good"), (None, None))

    def test_resolve_plugin_ignores_non_string_rename_target(self):
        # 매니페스트가 이상해도(rename 값이 dict 등 unhashable) TypeError 로 죽지 않고
        # (None, None) 이어야 한다 - cmd_plugin_fetch 가 이 예외를 잡지 않는다.
        import marketplace
        p = self.write({"name": "o", "plugins": [{"name": "c", "source": "./p"}],
                        "renames": {"a": {"b": "c"}}})
        mf = marketplace.parse_manifest(p)
        self.assertEqual(marketplace.resolve_plugin(mf, "a"), (None, None))


class PathGuards(unittest.TestCase):
    """매니페스트 source.path / 플러그인 이름은 신뢰할 수 없는 입력이다."""

    BAD_NAMES = ["..", ".", "", "a/b", "a\\b", "C:foo", "a:b", "/abs", "..\\evil"]
    BAD_PATHS = ["../outside", "plugins/../../etc", "/abs/path", "C:foo\\x",
                 "plugins/a:b", "plugins//", "plugins/./x"]

    def test_bad_plugin_names_rejected(self):
        import marketplace
        for n in self.BAD_NAMES:
            with self.subTest(name=n), self.assertRaises(marketplace.ManifestError):
                marketplace.safe_segment(n)

    def test_good_plugin_names_pass(self):
        import marketplace
        for n in ["superpowers", "agent-sdk-dev", "wordpress.com", "a_b", "qodo-skills"]:
            with self.subTest(name=n):
                self.assertEqual(marketplace.safe_segment(n), n)

    def test_trailing_dot_space_segments_rejected(self):
        # 리뷰 Finding 3: os.path.normpath 는 트레일링 dot/space 를 먹어치우므로
        # 이 가드의 판정이 OS 의 실제 해석과 어긋나면 안 된다. rstrip(" .\t") 결과가
        # 빈 문자열/./.. 이면 거부한다.
        import marketplace
        for n in ["..", ".. ", "..\t", "...", ". ", " ", "\t", ".  ."]:
            with self.subTest(name=repr(n)), self.assertRaises(marketplace.ManifestError):
                marketplace.safe_segment(n)

    def test_reserved_device_names_rejected_case_and_extension_insensitive(self):
        # CON/PRN/AUX/NUL/COM1-9/LPT1-9 는 확장자·대소문자 무관하게 예약됨(경로 이탈이
        # 아니라 기능적 장애 - 그런 이름으로 파일을 못 만든다).
        import marketplace
        for n in ["CON", "con", "Con.txt", "NUL", "nul.md", "COM1", "com9.json", "LPT3", "lpt9.txt"]:
            with self.subTest(name=n), self.assertRaises(marketplace.ManifestError):
                marketplace.safe_segment(n)

    def test_names_resembling_reserved_prefix_still_pass(self):
        # "con" 으로 시작하지만 예약어 자체가 아닌 이름까지 막으면 과잉 차단이다.
        import marketplace
        for n in ["conquest", "nullable", "communication", "console-app"]:
            with self.subTest(name=n):
                self.assertEqual(marketplace.safe_segment(n), n)

    def test_bad_relpaths_rejected(self):
        import marketplace
        for p in self.BAD_PATHS:
            with self.subTest(path=p), self.assertRaises(marketplace.ManifestError):
                marketplace.safe_relpath(p)

    def test_good_relpaths_pass_and_strip_dot_prefix(self):
        import marketplace
        self.assertEqual(marketplace.safe_relpath("./plugins/agent-sdk-dev"), "plugins/agent-sdk-dev")
        self.assertEqual(marketplace.safe_relpath("plugins/creative-cloud/adobe"), "plugins/creative-cloud/adobe")

    def test_source_spec_covers_all_four_kinds(self):
        # url/sha 는 실제로 검증되므로(리뷰 Finding 2) 플레이스홀더 "u"/"s" 대신
        # 스킴이 있는 URL 과 hex sha 를 쓴다 - 이 테스트가 검증하려는 대상(4종 판별)과
        # 무관한 값이라 결과는 이전과 동일하다.
        import marketplace
        self.assertEqual(marketplace.source_spec({"source": "./plugins/p"})["kind"], "str-path")
        gs = marketplace.source_spec({"source": {"source": "git-subdir", "url": "https://example.invalid/x.git",
                                                 "path": "plugins/x", "ref": "v1", "sha": "abc"}})
        self.assertEqual((gs["kind"], gs["path"], gs["sha"]), ("git-subdir", "plugins/x", "abc"))
        self.assertEqual(marketplace.source_spec(
            {"source": {"source": "url", "url": "https://example.invalid/x.git", "sha": "deadbeef"}})["kind"], "url")
        gh = marketplace.source_spec({"source": {"source": "github", "repo": "o/r",
                                                "commit": "c", "sha": "deadbeef"}})
        self.assertEqual((gh["kind"], gh["url"]), ("github", "https://github.com/o/r.git"))

    def test_github_repo_is_validated_as_two_segments(self):
        import marketplace
        with self.assertRaises(marketplace.ManifestError):
            marketplace.source_spec({"source": {"source": "github", "repo": "../evil", "sha": "deadbeef"}})

    def test_source_spec_rejects_malicious_urls(self):
        # 리뷰 Finding 2 재현: git 이 스스로 해석하는 문자열이라 subprocess 의 인자 리스트
        # 격리가 안 통한다. ext:: 는 전송 헬퍼(명령 실행), --upload-pack= 은 git 옵션 주입,
        # 그 외는 허용 스킴(https/http/ssh/git/file/scp-style) 밖의 임의 스킴이다.
        import marketplace
        bad_urls = [
            "ext::sh -c 'touch /tmp/pwned'",
            "--upload-pack=evil",
            "ftp://example.invalid/x.git",
            "javascript:alert(1)",
        ]
        for kind_src in ("url", "git-subdir"):
            for u in bad_urls:
                spec = {"source": kind_src, "url": u, "sha": "deadbeef"}
                if kind_src == "git-subdir":
                    spec["path"] = "plugins/x"
                with self.subTest(kind=kind_src, url=u), self.assertRaises(marketplace.ManifestError):
                    marketplace.source_spec({"source": spec})

    def test_source_spec_accepts_scp_style_and_common_schemes(self):
        import marketplace
        for u in ["https://example.invalid/x.git", "http://example.invalid/x.git",
                  "ssh://git@example.invalid/x.git", "git://example.invalid/x.git",
                  "file:///tmp/x", "git@github.com:owner/repo.git"]:
            with self.subTest(url=u):
                self.assertEqual(marketplace.source_spec(
                    {"source": {"source": "url", "url": u}})["url"], u)

    def test_source_spec_ipv6_url_not_falsely_rejected_as_transport_helper(self):
        # "::" 서브스트링만 보면 IPv6 리터럴 URL 을 전송 헬퍼로 오판한다 - 앵커된 접두 검사여야 한다.
        import marketplace
        self.assertEqual(marketplace.source_spec(
            {"source": {"source": "url", "url": "https://[::1]/r.git"}})["url"], "https://[::1]/r.git")

    def test_source_spec_rejects_option_like_ref_and_non_hex_sha(self):
        import marketplace
        with self.assertRaises(marketplace.ManifestError):
            marketplace.source_spec({"source": {"source": "url", "url": "https://example.invalid/x.git",
                                                "ref": "--upload-pack=evil"}})
        with self.assertRaises(marketplace.ManifestError):
            marketplace.source_spec({"source": {"source": "url", "url": "https://example.invalid/x.git",
                                                "sha": "not-hex!"}})


class Catalog(unittest.TestCase):
    """카탈로그: 메타데이터만. 네트워크 0, 'installable N' 칼럼 없음."""

    def setUp(self):
        import marketplace
        self.mp = marketplace
        self.mf = {"name": "official", "renames": {}, "by_name": {}, "plugins": [
            {"name": "alpha", "description": "A dev tool", "category": "development",
             "author": "x", "source": "./plugins/alpha"},
            {"name": "beta", "description": "DB helper", "category": "database",
             "source": {"source": "url", "url": "https://example.invalid/beta.git", "sha": "deadbeefcafe"}},
            {"name": "gamma", "description": "another dev thing", "category": "development",
             "source": "./plugins/gamma"},
        ]}
        self.mf["by_name"] = {e["name"]: e for e in self.mf["plugins"]}

    def test_rows_carry_metadata_but_no_component_count(self):
        r = self.mp.catalog(self.mf, {})
        self.assertEqual(r["total"], 3)
        row = [x for x in r["rows"] if x["name"] == "beta"][0]
        self.assertEqual(row["category"], "database")
        self.assertEqual(row["kind"], "url")
        self.assertNotIn("installable", row)      # fetch 전에는 알 수 없다
        self.assertFalse(row["fetched"])

    def test_category_filter_and_counts(self):
        r = self.mp.catalog(self.mf, {}, category="development")
        self.assertEqual([x["name"] for x in r["rows"]], ["alpha", "gamma"])
        self.assertEqual(r["categories"]["development"], 2)

    def test_query_matches_name_and_description_case_insensitively(self):
        self.assertEqual([x["name"] for x in self.mp.catalog(self.mf, {}, query="DEV")["rows"]],
                         ["alpha", "gamma"])
        self.assertEqual([x["name"] for x in self.mp.catalog(self.mf, {}, query="db")["rows"]], ["beta"])

    def test_pagination_is_stable(self):
        r1 = self.mp.catalog(self.mf, {}, limit=2, offset=0)
        r2 = self.mp.catalog(self.mf, {}, limit=2, offset=2)
        self.assertEqual([x["name"] for x in r1["rows"]], ["alpha", "beta"])
        self.assertEqual([x["name"] for x in r2["rows"]], ["gamma"])
        self.assertEqual(r1["total"], 3)

    def test_fetched_plugins_are_marked(self):
        r = self.mp.catalog(self.mf, {"alpha": {"sha": "abc1234", "cache": "/c"}})
        row = [x for x in r["rows"] if x["name"] == "alpha"][0]
        self.assertTrue(row["fetched"])
        self.assertEqual(row["sha"], "abc1234")
        self.assertEqual(row["origin"], "market:official/alpha")

    def test_malformed_entry_name_excluded_from_rows(self):
        # 리뷰 Finding 1: plugins[] 이름이 ".." 처럼 경로 이탈이면 카탈로그 행에도
        # 노출하지 않는다(집계에서도 제외) - by_name 필터와 별개로 catalog() 자체가 방어한다.
        mf = {"name": "official", "renames": {}, "by_name": {}, "plugins": [
            {"name": "..", "description": "evil", "category": "x", "source": "./p"},
            {"name": "ok", "description": "fine", "category": "x", "source": "./p"},
        ]}
        r = self.mp.catalog(mf, {})
        self.assertEqual([x["name"] for x in r["rows"]], ["ok"])
        self.assertEqual(r["total"], 1)


@unittest.skipIf(shutil.which("git") is None, "git 없음")
class MarketAdd(unittest.TestCase):
    """market-add: .claude-plugin 만 sparse checkout -> 카탈로그. catalog 는 네트워크 0."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="market_test_")
        self.store = os.path.join(self.tmp, "store")
        self.target = os.path.join(self.tmp, ".claude")
        self.origin = os.path.join(self.tmp, "mk")
        os.makedirs(os.path.join(self.origin, ".claude-plugin"))
        # 번들 플러그인 1개(str-path) + 외부 1개(url)
        os.makedirs(os.path.join(self.origin, "plugins", "bundled", "skills", "bs1"))
        with open(os.path.join(self.origin, "plugins", "bundled", "skills", "bs1", "SKILL.md"),
                  "w", encoding="utf-8") as f:
            f.write("---\nname: bs1\n---\nbundled skill\n")
        with open(os.path.join(self.origin, ".claude-plugin", "marketplace.json"),
                  "w", encoding="utf-8") as f:
            json.dump({"name": "testmarket", "plugins": [
                {"name": "bundled", "description": "bundled one", "category": "development",
                 "source": "./plugins/bundled"},
                {"name": "external", "description": "remote one", "category": "database",
                 "source": {"source": "url", "url": "https://example.invalid/x.git", "sha": "0" * 40}},
            ]}, f)
        _git(self.origin, "init", "-q", "-b", "main")
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
        self.url = "file:///" + self.origin.replace("\\", "/").lstrip("/")
        run(CAS, "--store", self.store, "init")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def libcmd(self, *args):
        return run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot", *args)

    def test_market_add_sparse_checks_out_manifest_only(self):
        rc, out, err = self.libcmd("market-add", "--url", self.url, "--ref", "main")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])
        self.assertEqual(res["id"], "mk")
        self.assertEqual(res["plugins"], 2)
        # 매니페스트는 있고 번들 플러그인 워킹트리는 아직 없다(지연 fetch)
        self.assertTrue(os.path.exists(os.path.join(res["cache"], ".claude-plugin", "marketplace.json")))
        self.assertFalse(os.path.exists(os.path.join(res["cache"], "plugins", "bundled")))

    def test_catalog_needs_no_network(self):
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot",
                           "catalog", env={"PATH": ""})
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertEqual(res["total"], 2)
        self.assertEqual(res["categories"], {"development": 1, "database": 1})

    def test_catalog_filters(self):
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("catalog", "--category", "database")
        self.assertEqual([r["name"] for r in json.loads(out)["rows"]], ["external"])
        rc, out, err = self.libcmd("catalog", "--query", "BUNDLED")
        self.assertEqual([r["name"] for r in json.loads(out)["rows"]], ["bundled"])

    def test_market_does_not_join_library_until_fetched(self):
        # 278개를 Library 칸에 밀어 넣지 않는다. fetch 한 플러그인만 합류한다.
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("scan")
        self.assertEqual(rc, 0, err)
        self.assertEqual([l for l in json.loads(out)["libraries"] if l["source"] == "market"], [])

    def test_catalog_with_no_marketplace_is_empty_not_error(self):
        rc, out, err = self.libcmd("catalog")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])
        self.assertEqual(res["total"], 0)

    def test_rows_carry_market_provenance(self):
        # 마켓이 여럿이면 플러그인 이름만으로는 어느 URL 에서 온 것인지 알 수 없다.
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rows = json.loads(self.libcmd("catalog")[1])["rows"]
        self.assertTrue(rows)
        for r in rows:
            self.assertEqual(r["marketplace"], "mk")
            self.assertEqual(r["market_name"], "testmarket")
            self.assertEqual(r["market_url"], self.url)

    def test_reregistering_same_url_says_so_instead_of_pretending_its_new(self):
        # 같은 URL 재등록은 정당한 갱신이다 - 거부하지 않되 "새로 등록됨"이라고 말하지도 않는다.
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("market-add", "--url", self.url, "--ref", "main")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])
        self.assertTrue(res["already"])
        self.assertIn("이미 등록", res["message"])

    def test_same_url_under_a_different_id_is_rejected(self):
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("market-add", "--url", self.url + "/", "--ref", "main",
                                   "--id", "other")
        res = json.loads(out)
        self.assertFalse(res["ok"])
        self.assertIn("mk", res["message"])          # 어느 id 로 이미 등록됐는지 알려준다

    def test_id_collision_from_two_different_urls_is_rejected_not_overwritten(self):
        """레포명이 같은 다른 URL 두 개는 같은 id 를 만든다.

        회귀 가드: 조용히 덮어쓰면 뒤엣것이 앞 레코드의 plugins[](이미 fetch 한 캐시 경로)를
        물려받아, 다른 레포의 캐시를 가리키는 레코드가 된다 - 등록이 아니라 손상이다."""
        other = os.path.join(self.tmp, "nest", "mk")
        os.makedirs(os.path.join(other, ".claude-plugin"))
        with open(os.path.join(other, ".claude-plugin", "marketplace.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "impostor", "plugins": []}, f)
        _git(other, "init", "-q", "-b", "main")
        _git(other, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(other, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
        url2 = "file:///" + other.replace("\\", "/").lstrip("/")

        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("market-add", "--url", url2, "--ref", "main")
        res = json.loads(out)
        self.assertFalse(res["ok"])
        self.assertIn("--id", res["message"])
        # 기존 등록은 그대로 살아 있어야 한다
        cat = json.loads(self.libcmd("catalog", "--limit", "-1")[1])
        self.assertEqual([m["name"] for m in cat["marketplaces"]], ["testmarket"])

    def test_summary_lists_markets_and_respects_filters(self):
        """UI 는 마켓별 구획을 그리려고 행보다 마켓 목록을 먼저 받는다(limit<0 = 요약 전용).

        구획 헤더의 개수와 그 구획의 페이저가 이 total 을 쓰므로 필터 후 개수여야 한다."""
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        res = json.loads(self.libcmd("catalog", "--limit", "-1")[1])
        self.assertEqual(res["rows"], [])                      # 요약만 - 행은 싣지 않는다
        self.assertEqual(len(res["marketplaces"]), 1)
        mk = res["marketplaces"][0]
        self.assertEqual((mk["id"], mk["name"], mk["url"], mk["total"]), ("mk", "testmarket", self.url, 2))

        self.assertEqual(mk["total_all"], 2)

        res = json.loads(self.libcmd("catalog", "--limit", "-1", "--category", "database")[1])
        self.assertEqual(res["marketplaces"][0]["total"], 1)   # 필터가 마켓별 개수에도 반영된다
        # total_all 은 필터 전 개수 - UI 가 "1 / 2" 로 필터가 걸려 있음을 드러내는 근거다.
        self.assertEqual(res["marketplaces"][0]["total_all"], 2)
        self.assertEqual((res["total"], res["total_all"]), (1, 2))

    def test_marketplace_filter_pages_that_market_alone(self):
        # UI 의 마켓별 페이징 경로: --marketplace 로 좁히면 offset/limit 이 그 마켓에만 걸린다.
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        res = json.loads(self.libcmd("catalog", "--marketplace", "mk", "--limit", "1", "--offset", "1")[1])
        self.assertEqual(res["total"], 2)
        self.assertEqual(len(res["rows"]), 1)
        self.assertEqual([m["id"] for m in res["marketplaces"]], ["mk"])

    def test_paging_slices_the_merged_list_once(self):
        """페이지는 합친 목록 위에서 한 번 자른다.

        회귀 가드: 마켓별로 limit/offset 을 걸던 구버전은 마켓이 둘이면 offset=1 이
        "마켓마다 1개씩 건너뛰기"가 되고 한 페이지에 limit x 마켓수 행이 실렸다 -
        total 과 어긋나 페이지 이동이 곧바로 깨진다."""
        second = os.path.join(self.tmp, "mk2")
        os.makedirs(os.path.join(second, ".claude-plugin"))
        with open(os.path.join(second, ".claude-plugin", "marketplace.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "second", "plugins": [
                {"name": "p3", "category": "monitoring", "source": "./plugins/p3"},
                {"name": "p4", "category": "monitoring", "source": "./plugins/p4"},
            ]}, f)
        _git(second, "init", "-q", "-b", "main")
        _git(second, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(second, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
        url2 = "file:///" + second.replace("\\", "/").lstrip("/")
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        self.libcmd("market-add", "--url", url2, "--ref", "main")

        seen = []
        for off in (0, 2):
            res = json.loads(self.libcmd("catalog", "--limit", "2", "--offset", str(off))[1])
            self.assertEqual(res["total"], 4)
            self.assertEqual(res["offset"], off)
            self.assertEqual(len(res["rows"]), 2)      # 마켓수만큼 부풀지 않는다
            seen += [r["name"] for r in res["rows"]]
        self.assertEqual(sorted(seen), ["bundled", "external", "p3", "p4"])

        # 목록 밖 offset 은 마지막 페이지로 당겨 빈 화면을 주지 않는다(검색으로 total 이 줄 때).
        res = json.loads(self.libcmd("catalog", "--limit", "2", "--offset", "99")[1])
        self.assertEqual(res["offset"], 2)
        self.assertEqual(len(res["rows"]), 2)


@unittest.skipIf(shutil.which("git") is None, "git 없음")
class PluginFetch(MarketAdd):
    """플러그인 지연 fetch: 번들은 sparse 확장, 외부는 별도 fetch. sha 층은 원자적 교체용."""

    def test_bundled_plugin_expands_sparse_set_in_place(self):
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])
        self.assertEqual(res["origin"], "market:mk/bundled")
        self.assertEqual(res["components"]["skills"], 1)
        self.assertTrue(os.path.exists(os.path.join(res["cache"], "skills", "bs1", "SKILL.md")))

    def test_fetched_plugin_joins_library_with_market_source(self):
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled")
        rc, out, err = self.libcmd("scan")
        rec = [l for l in json.loads(out)["libraries"] if l["source"] == "market"][0]
        self.assertEqual(rec["origin"], "market:mk/bundled")
        self.assertEqual([i["name"] for i in rec["categories"]["skills"]], ["bs1"])

    def test_refetch_is_idempotent_and_keeps_one_sha_dir(self):
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled")
        rc, out, err = self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled")
        self.assertEqual(rc, 0, err)
        import lib_store
        m = lib_store.load_cfg(self.store)["marketplaces"][0]
        self.assertEqual(len(m["plugins"]), 1)
        # 번들(str-path)은 마켓 레포의 sparse 집합을 확장할 뿐 plugins/<name>/<sha> 스테이징을
        # 쓰지 않는다(그건 외부 전용) - 브리프 원문은 plugins_dir 를 검사했지만 번들에서는
        # 그 디렉토리 자체가 생기지 않아 FileNotFoundError 가 난다. 대신 repo 안 같은 경로를
        # 재사용해 늘지 않음을 검증한다.
        mk_root = os.path.join(self.store, "lib-cache", "markets", "mk")
        self.assertFalse(os.path.isdir(os.path.join(mk_root, "plugins")))
        self.assertEqual(m["plugins"][0]["cache"], os.path.join(mk_root, "repo", "plugins", "bundled"))

    def test_unknown_plugin_is_rejected_with_available_hint(self):
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "nope")
        res = json.loads(out)
        self.assertFalse(res["ok"])

    def test_malicious_plugin_name_is_rejected_before_touching_disk(self):
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        for bad in ["../evil", "..", "C:evil", "a/b"]:
            with self.subTest(name=bad):
                rc, out, err = self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", bad)
                self.assertFalse(json.loads(out)["ok"])

    def test_external_plugin_failure_leaves_registry_untouched(self):
        # 외부 URL 이 죽어 있어도 마켓 등록과 기존 플러그인은 멀쩡해야 한다.
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "external")
        self.assertFalse(json.loads(out)["ok"])
        import lib_store
        self.assertEqual(lib_store.load_cfg(self.store)["marketplaces"][0]["plugins"], [])

    def test_external_refetch_with_multisegment_path_replaces_stale_sha_dir(self):
        # git-subdir(실측 80/278, source.path 가 흔히 2단 이상)의 옛 sha 정리 회귀 가드.
        # os.path.dirname(old_root) 로 스테이징 루트를 역산하면 다단 경로일 때 sha 루트보다
        # 한 단계 안쪽을 지워, 옛 sha 디렉토리 자체는 재-fetch 할 때마다 쌓여 남는다.
        ext = os.path.join(self.tmp, "ext")
        os.makedirs(os.path.join(ext, "packages", "tool", "skills", "es1"))
        with open(os.path.join(ext, "packages", "tool", "skills", "es1", "SKILL.md"),
                  "w", encoding="utf-8") as f:
            f.write("---\nname: es1\n---\nv1\n")
        _git(ext, "init", "-q", "-b", "main")
        _git(ext, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(ext, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "v1")
        sha1 = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ext,
                              capture_output=True, text=True).stdout.strip()
        ext_url = "file:///" + ext.replace("\\", "/").lstrip("/")

        def write_manifest(sha):
            with open(os.path.join(self.origin, ".claude-plugin", "marketplace.json"),
                      "w", encoding="utf-8") as f:
                json.dump({"name": "testmarket", "plugins": [
                    {"name": "bundled", "description": "bundled one", "category": "development",
                     "source": "./plugins/bundled"},
                    {"name": "multiseg", "description": "multi-segment external", "category": "database",
                     "source": {"source": "git-subdir", "url": ext_url, "ref": "main",
                                "path": "packages/tool", "sha": sha}},
                ]}, f)
            _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
            _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q",
                 "-m", f"manifest sha={sha[:8]}")

        write_manifest(sha1)
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "multiseg")
        self.assertEqual(rc, 0, err)

        with open(os.path.join(ext, "packages", "tool", "skills", "es1", "SKILL.md"),
                  "w", encoding="utf-8") as f:
            f.write("---\nname: es1\n---\nv2\n")
        _git(ext, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(ext, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "v2")
        sha2 = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ext,
                              capture_output=True, text=True).stdout.strip()
        self.assertNotEqual(sha1, sha2)

        write_manifest(sha2)
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "multiseg")
        self.assertEqual(rc, 0, err)

        plugins_dir = os.path.join(self.store, "lib-cache", "markets", "mk", "plugins", "multiseg")
        # fix round 2: 스테이징 디렉토리 이름은 sha 앞 12자만 쓴다(Windows 260자 제한에 여유를
        # 번다) - 원장의 sha 필드 자체는 여전히 전체 40자 그대로다(아래에서 별도 검증).
        self.assertEqual(sorted(os.listdir(plugins_dir)), [sha2[:12]],
                         "옛 sha 스테이징 디렉토리가 안 지워지고 남음(다단 source.path 정리 버그)")
        import lib_store
        rec = lib_store.load_cfg(self.store)["marketplaces"][0]["plugins"][0]
        self.assertEqual(rec["sha"], sha2, "원장의 sha 는 자르지 않고 전체를 저장해야 한다")

    def test_plugin_fetch_reports_failure_when_materialized_root_is_unreadable(self):
        # 실제 260+ 문자 경로를 만들지 않고 같은 실패 모양을 시뮬레이션한다: 매니페스트가
        # 레포에 실제로 없는 하위경로를 선언하면 git fetch/sparse-checkout 은 성공(rc=0)하지만
        # 결과 root 디렉토리는 생기지 않는다 - Windows MAX_PATH 초과로 root 가 안 생기는
        # 케이스와 정확히 같은 증상(materialize 는 "성공"을 보고하지만 root 를 못 읽음).
        ext = os.path.join(self.tmp, "ext_ghost")
        os.makedirs(ext)
        with open(os.path.join(ext, "README.md"), "w", encoding="utf-8") as f:
            f.write("no ghost subdir here\n")
        _git(ext, "init", "-q", "-b", "main")
        _git(ext, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(ext, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
        ext_url = "file:///" + ext.replace("\\", "/").lstrip("/")

        with open(os.path.join(self.origin, ".claude-plugin", "marketplace.json"),
                  "w", encoding="utf-8") as f:
            json.dump({"name": "testmarket", "plugins": [
                {"name": "ghost", "description": "declared path missing in repo", "category": "development",
                 "source": {"source": "git-subdir", "url": ext_url, "ref": "main", "path": "nope/deep"}},
            ]}, f)
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "ghost plugin")

        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "ghost")
        res = json.loads(out)
        self.assertFalse(res["ok"], "materialize 가 root 를 못 만들었는데 ok:true 를 보고하면 안 된다")
        self.assertIn("찾을 수 없음", res["message"])
        import lib_store
        self.assertEqual(lib_store.load_cfg(self.store)["marketplaces"][0]["plugins"], [],
                         "검증 실패는 원장에 흔적을 남기면 안 된다(거짓 성공 등록 금지)")

    def test_plugin_fetch_warns_when_a_category_cannot_be_enumerated(self):
        # fix round 3: root 자체는 있고(1번 수정 통과) skills/ 나열만 실패하는 상황을
        # 실제 260+ 문자 경로 없이 시뮬레이션한다 - 이미 fetch 된 bundled 캐시에 대해
        # os.walk 를 부분적으로 몽키패치한 뒤 cmd_plugin_fetch 를 프로세스 안에서 재호출한다.
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled")

        import argparse, contextlib, io, library
        from unittest import mock
        cache_root = os.path.join(self.store, "lib-cache", "markets", "mk", "repo", "plugins", "bundled")
        broken = os.path.normcase(os.path.normpath(os.path.join(cache_root, "skills")))
        real_walk = os.walk

        def flaky_walk(path, *args, **kwargs):
            if os.path.normcase(os.path.normpath(path)) == broken:
                def _gen():
                    raise OSError("simulated: enumeration failed (path too long)")
                    yield  # pragma: no cover - never reached, keeps this a generator
                return _gen()
            return real_walk(path, *args, **kwargs)

        a = argparse.Namespace(store=self.store, marketplace="mk", plugin="bundled")
        buf = io.StringIO()
        with mock.patch("os.walk", side_effect=flaky_walk), contextlib.redirect_stdout(buf):
            library.cmd_plugin_fetch(a)
        res = json.loads(buf.getvalue())

        self.assertTrue(res["ok"], "fetch 자체는 성공이다 - 파일은 이미 디스크에 있고 등록도 유효하다")
        self.assertNotIn("skills", res["components"],
                         "나열 실패한 카테고리를 0 으로 보고하면 '진짜 비어있음'으로 오독된다")
        self.assertIn("skills", res["components_failed"])
        self.assertIsNotNone(res["warning"], "실패를 아는 사람은 이 응답을 보는 사람도 알아야 한다")
        self.assertIn("skills", res["warning"])

    def test_plugin_fetch_reports_genuinely_empty_category_as_zero_without_warning(self):
        # bundled 픽스처는 skills/bs1 하나만 있고 agents/commands 는 아예 없다 -
        # 이건 나열 실패가 아니라 진짜 빈 카테고리다. round 3 의 구분이 이 경우를
        # 여전히 조용한 0 으로 다뤄야 한다(경고를 남발하면 그것도 오독을 만든다).
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        rc, out, err = self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertEqual(res["components"]["agents"], 0)
        self.assertEqual(res["components"]["commands"], 0)
        self.assertEqual(res["components"]["skills"], 1)
        self.assertEqual(res["components_failed"], {})
        self.assertIsNone(res["warning"])


@unittest.skipIf(shutil.which("git") is None, "git 없음")
class MarketUnregister(MarketAdd):
    """unregister --origin market:<id>/<plugin> 은 그 플러그인만 지운다(fix round 1 회귀 가드).
    market:<id> (플러그인 세그먼트 없음)는 여전히 마켓 전체(레포+모든 플러그인)를 지운다."""

    def _external_fixture(self, name="ext"):
        """실제로 fetch 가능한 로컬 git 픽스처 하나를 만들어 (url, sha) 를 돌려준다."""
        ext = os.path.join(self.tmp, name)
        os.makedirs(os.path.join(ext, "skills", "es1"))
        with open(os.path.join(ext, "skills", "es1", "SKILL.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: es1\n---\nbody\n")
        _git(ext, "init", "-q", "-b", "main")
        _git(ext, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(ext, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
        sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ext,
                             capture_output=True, text=True).stdout.strip()
        url = "file:///" + ext.replace("\\", "/").lstrip("/")
        return url, sha

    def _add_two_fetchable_plugins(self):
        """bundled(str-path) + real2(외부, 실제로 fetch 가능) 두 개를 매니페스트에 심고 fetch 까지 한다.
        MarketAdd.setUp 의 "external" 은 죽은 URL(https://example.invalid) 이라 실제 fetch 테스트엔
        못 쓴다 - 여기서는 실제로 물질화되는 두 번째 플러그인이 필요하다."""
        url, sha = self._external_fixture()
        with open(os.path.join(self.origin, ".claude-plugin", "marketplace.json"),
                  "w", encoding="utf-8") as f:
            json.dump({"name": "testmarket", "plugins": [
                {"name": "bundled", "description": "bundled one", "category": "development",
                 "source": "./plugins/bundled"},
                {"name": "real2", "description": "real external", "category": "database",
                 "source": {"source": "url", "url": url, "sha": sha}},
            ]}, f)
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "two real plugins")
        self.libcmd("market-add", "--url", self.url, "--ref", "main")
        self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "bundled")
        self.libcmd("plugin-fetch", "--marketplace", "mk", "--plugin", "real2")

    def test_plugin_level_unregister_removes_only_that_plugin(self):
        self._add_two_fetchable_plugins()
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        real2_cache = next(p["cache"] for p in cfg["marketplaces"][0]["plugins"] if p["name"] == "real2")
        self.assertTrue(os.path.isdir(real2_cache))

        rc, out, err = self.libcmd("unregister", "--origin", "market:mk/real2")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])

        cfg2 = lib_store.load_cfg(self.store)
        self.assertEqual(len(cfg2.get("marketplaces", [])), 1, "마켓 등록 자체는 살아있어야 한다")
        m = cfg2["marketplaces"][0]
        self.assertEqual(m["id"], "mk")
        self.assertEqual([p["name"] for p in m["plugins"]], ["bundled"], "다른 플러그인은 살아있어야 한다")
        self.assertFalse(os.path.exists(real2_cache), "지운 플러그인 캐시는 사라져야 한다")
        self.assertTrue(os.path.exists(os.path.join(m["cache"], ".claude-plugin", "marketplace.json")),
                        "매니페스트 캐시는 살아있어야 한다")
        # bundled 는 여전히 스캔에 걸려야 한다(공유 레포가 안 다쳤다는 증거)
        rc, out, err = self.libcmd("scan")
        recs = [l for l in json.loads(out)["libraries"] if l["source"] == "market"]
        self.assertEqual([r["origin"] for r in recs], ["market:mk/bundled"])

    def test_market_level_unregister_still_removes_everything(self):
        self._add_two_fetchable_plugins()
        import lib_store
        market_cache = lib_store.load_cfg(self.store)["marketplaces"][0]["cache"]
        market_root = os.path.join(self.store, "lib-cache", "markets", "mk")

        rc, out, err = self.libcmd("unregister", "--origin", "market:mk")
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])
        self.assertEqual(lib_store.load_cfg(self.store).get("marketplaces", []), [])
        self.assertFalse(os.path.exists(market_root))
        self.assertFalse(os.path.exists(market_cache))

    def test_plugin_level_unregister_refused_when_its_own_cache_is_held(self):
        self._add_two_fetchable_plugins()
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        real2_cache = next(p["cache"] for p in cfg["marketplaces"][0]["plugins"] if p["name"] == "real2")
        lib_store.ledger_put(cfg, self.target, "hooks", "real2-hook",
                             {"kind": "hooks", "origin": "market:mk/real2", "root": real2_cache})
        lib_store.save_cfg(self.store, cfg)

        rc, out, err = self.libcmd("unregister", "--origin", "market:mk/real2")
        res = json.loads(out)
        self.assertFalse(res["ok"])
        self.assertIn("hooks/real2-hook", json.dumps(res, ensure_ascii=False))
        self.assertTrue(os.path.exists(real2_cache), "거부했으면 캐시가 남아 있어야 한다")
        self.assertEqual(len(lib_store.load_cfg(self.store)["marketplaces"][0]["plugins"]), 2,
                         "거부했으면 등록도 그대로여야 한다")

    def test_plugin_level_unregister_allowed_when_a_different_plugins_cache_is_held(self):
        self._add_two_fetchable_plugins()
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        bundled_cache = next(p["cache"] for p in cfg["marketplaces"][0]["plugins"] if p["name"] == "bundled")
        # bundled 소유의 hooks 가 걸려 있어도 real2 해제는(다른 플러그인 캐시라) 막지 않아야 한다.
        lib_store.ledger_put(cfg, self.target, "hooks", "bundled-hook",
                             {"kind": "hooks", "origin": "market:mk/bundled", "root": bundled_cache})
        lib_store.save_cfg(self.store, cfg)

        rc, out, err = self.libcmd("unregister", "--origin", "market:mk/real2")
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])
        m = lib_store.load_cfg(self.store)["marketplaces"][0]
        self.assertEqual([p["name"] for p in m["plugins"]], ["bundled"])

    def test_bundled_plugin_unregister_does_not_delete_shared_repo_files(self):
        # 번들 플러그인 캐시는 마켓 레포 워킹트리 안이다 - 손으로 지우면 매니페스트나
        # 다른(외부) 플러그인까지 함께 날아갈 수 있다.
        self._add_two_fetchable_plugins()
        import lib_store
        m = lib_store.load_cfg(self.store)["marketplaces"][0]
        manifest_path = os.path.join(m["cache"], ".claude-plugin", "marketplace.json")
        real2_cache = next(p["cache"] for p in m["plugins"] if p["name"] == "real2")

        rc, out, err = self.libcmd("unregister", "--origin", "market:mk/bundled")
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])
        self.assertTrue(os.path.exists(manifest_path), "매니페스트는 살아있어야 한다")
        self.assertTrue(os.path.exists(real2_cache), "다른(외부) 플러그인 캐시는 살아있어야 한다")
        m2 = lib_store.load_cfg(self.store)["marketplaces"][0]
        self.assertEqual([p["name"] for p in m2["plugins"]], ["real2"])


@unittest.skipIf(shutil.which("git") is None, "git 없음")
class FetchAndUnregister(RemoteAdd):
    """명시적 fetch 만(자동 pull 없음) + unregister 는 원장이 붙잡은 캐시를 못 지운다."""

    def test_fetch_updates_sha_and_refreshes_content(self):
        run(CAS, "--store", self.store, "init")
        self.libcmd("remote-add", "--url", self.url, "--ref", "main")
        with open(os.path.join(self.origin, "Agents", "a2.md"), "w", encoding="utf-8") as f:
            f.write("second agent\n")
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "more")
        rc, out, err = self.libcmd("fetch", "--origin", "remote:origin")
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])
        rc, out, err = self.libcmd("scan")
        rec = [l for l in json.loads(out)["libraries"] if l["source"] == "remote"][0]
        self.assertEqual(sorted(i["name"] for i in rec["categories"]["agents"]), ["a1", "a2"])

    def test_scan_never_pulls_by_itself(self):
        # 자동 pull 금지: 업스트림이 앞서 나가도 fetch 를 부르기 전까지 캐시는 그대로다.
        run(CAS, "--store", self.store, "init")
        self.libcmd("remote-add", "--url", self.url, "--ref", "main")
        with open(os.path.join(self.origin, "Agents", "a3.md"), "w", encoding="utf-8") as f:
            f.write("third\n")
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
        _git(self.origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "third")
        rc, out, err = self.libcmd("scan")
        rec = [l for l in json.loads(out)["libraries"] if l["source"] == "remote"][0]
        self.assertEqual([i["name"] for i in rec["categories"]["agents"]], ["a1"])

    def test_unregister_removes_registration_and_cache(self):
        run(CAS, "--store", self.store, "init")
        rc, out, err = self.libcmd("remote-add", "--url", self.url, "--ref", "main")
        cache = json.loads(out)["cache"]
        rc, out, err = self.libcmd("unregister", "--origin", "remote:origin")
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])
        import lib_store
        self.assertEqual(lib_store.load_cfg(self.store).get("remotes", []), [])
        self.assertFalse(os.path.exists(cache))

    def test_unregister_refuses_when_ledger_still_holds_cache(self):
        # 캐시는 load-bearing 이다(hooks/MCP 가 참조). 붙잡혀 있으면 거부하고 무엇이 걸렸는지 알린다.
        run(CAS, "--store", self.store, "init")
        rc, out, err = self.libcmd("remote-add", "--url", self.url, "--ref", "main")
        cache = json.loads(out)["cache"]
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        lib_store.ledger_put(cfg, self.target, "hooks", "some-hook",
                             {"kind": "hooks", "origin": "remote:origin", "root": cache})
        lib_store.save_cfg(self.store, cfg)
        rc, out, err = self.libcmd("unregister", "--origin", "remote:origin")
        res = json.loads(out)
        self.assertFalse(res["ok"])
        self.assertIn("hooks/some-hook", json.dumps(res, ensure_ascii=False))
        self.assertTrue(os.path.exists(cache), "거부했으면 캐시가 남아 있어야 한다")

    def test_fetch_unknown_origin_is_rejected(self):
        run(CAS, "--store", self.store, "init")
        rc, out, err = self.libcmd("fetch", "--origin", "remote:nope")
        self.assertFalse(json.loads(out)["ok"])


class Substitution(unittest.TestCase):
    """${CLAUDE_PLUGIN_ROOT} 치환. 픽스처는 hooks/ 바깥 참조 2건을 재현한다."""

    HOOKS = {
        "description": "test hooks",
        "hooks": {
            "SessionStart": [{"hooks": [{"type": "command",
                "command": 'bash "${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh"'}]}],
            "PostToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command",
                "command": 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/post.py"', "timeout": 10}]}],
        },
    }

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="subst_test_")
        self.root = os.path.join(self.tmp, "plugins", "sg", "abc123")
        os.makedirs(os.path.join(self.root, "hooks"))
        os.makedirs(os.path.join(self.root, "hooks-handlers"))
        with open(os.path.join(self.root, "hooks", "hooks.json"), "w", encoding="utf-8") as f:
            json.dump(self.HOOKS, f)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_substitute_replaces_in_nested_structures(self):
        import plugin_units
        got = plugin_units.substitute(self.HOOKS, self.root)
        cmd = got["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        self.assertIn(self.root, cmd)
        self.assertNotIn("${CLAUDE_PLUGIN_ROOT}", json.dumps(got, ensure_ascii=False))

    def test_substitute_does_not_mutate_input(self):
        import plugin_units
        plugin_units.substitute(self.HOOKS, self.root)
        self.assertIn("${CLAUDE_PLUGIN_ROOT}",
                      self.HOOKS["hooks"]["SessionStart"][0]["hooks"][0]["command"])

    def test_substitute_preserves_matcher_and_timeout(self):
        import plugin_units
        got = plugin_units.substitute(self.HOOKS, self.root)
        e = got["hooks"]["PostToolUse"][0]
        self.assertEqual(e["matcher"], "Edit|Write")
        self.assertEqual(e["hooks"][0]["timeout"], 10)

    def test_sibling_directory_reference_survives(self):
        # hooks/ 만 복사하면 깨지는 실물 2건의 재현. 플러그인 루트 전체가 설치 단위인 근거.
        import plugin_units
        got = plugin_units.substitute(self.HOOKS, self.root)
        cmd = got["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        ref = cmd.split('"')[1]
        self.assertTrue(os.path.isdir(os.path.dirname(ref)), f"참조 대상이 실재해야 한다: {ref}")

    def test_hook_commands_are_read_from_parsed_json_not_regex(self):
        # 정규식 '"command"\s*:\s*"([^"]+)"' 은 이스케이프된 \" 에서 잘려 0건을 낸다.
        import re, plugin_units
        cfg = plugin_units.load_hooks_json(self.root)
        cmds = plugin_units.hook_commands(cfg)
        self.assertEqual(len(cmds), 2)
        serialized = json.dumps(cfg, ensure_ascii=False)
        regex_hits = re.findall(r'"command"\s*:\s*"([^"]+)"', serialized)
        self.assertNotEqual(regex_hits, cmds,
                            "이 픽스처는 정규식이 오답을 내는 케이스여야 의미가 있다")

    def test_load_hooks_json_returns_none_when_absent(self):
        import plugin_units
        self.assertIsNone(plugin_units.load_hooks_json(os.path.join(self.tmp, "nope")))


class HooksMerge(Substitution):
    """hooks 병합 멱등성 + sha 변경 케이스. 문자열 매칭이면 Windows 에서 전부 실패한다."""

    def test_windows_path_matching_is_not_string_based(self):
        # 이 테스트가 op_hook_remove 재사용을 막는 이유다.
        import plugin_units
        root = "D:\\cache\\plugins\\sg\\abc123" if os.name == "nt" else "/c/plugins/sg/abc123"
        entry = {"matcher": "*", "hooks": [{"type": "command",
                 "command": 'bash "' + root + '/hooks/run.sh"'}]}
        self.assertTrue(plugin_units.entry_refs_root(entry, root))
        # 직렬화 매칭이었다면 여기서 False 가 나왔을 것(Windows 에서 \ -> \\ 이스케이프)
        if os.name == "nt":
            self.assertNotIn(root, json.dumps(entry, ensure_ascii=False))

    def test_entry_refs_root_does_not_match_a_different_plugin(self):
        import plugin_units
        entry = {"hooks": [{"type": "command", "command": 'bash "' + self.root + '/hooks/x.sh"'}]}
        other = os.path.join(self.tmp, "plugins", "other", "def456")
        self.assertFalse(plugin_units.entry_refs_root(entry, other))

    def test_entry_refs_root_ignores_case_and_separators(self):
        import plugin_units
        entry = {"hooks": [{"type": "command",
                 "command": 'bash "' + self.root.replace("\\", "/") + '/hooks/x.sh"'}]}
        self.assertTrue(plugin_units.entry_refs_root(entry, self.root))

    def test_merge_twice_does_not_duplicate(self):
        import plugin_units
        cfg = plugin_units.load_hooks_json(self.root)
        s, _, added1 = plugin_units.hooks_merge({}, cfg, self.root, None)
        s, removed2, added2 = plugin_units.hooks_merge(s, cfg, self.root, self.root)
        self.assertEqual(added1, 2)
        self.assertEqual(removed2, 2)                  # 자기 엔트리를 먼저 걷어낸다
        self.assertEqual(len(s["hooks"]["SessionStart"]), 1)
        self.assertEqual(len(s["hooks"]["PostToolUse"]), 1)

    def test_sha_change_removes_old_root_entries(self):
        # 갱신 멱등성의 핵심. needle 은 원장의 옛 root 이지 새 캐시 경로가 아니다.
        import plugin_units
        cfg = plugin_units.load_hooks_json(self.root)
        s, _, _ = plugin_units.hooks_merge({}, cfg, self.root, None)
        new_root = os.path.join(self.tmp, "plugins", "sg", "def456")
        s, removed, added = plugin_units.hooks_merge(s, cfg, new_root, self.root)
        self.assertEqual(removed, 2)
        self.assertEqual(len(s["hooks"]["SessionStart"]), 1)
        cmd = s["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        self.assertIn(new_root, cmd)
        self.assertNotIn(self.root, cmd)

    def test_merge_preserves_unrelated_user_hooks(self):
        import plugin_units
        mine = {"matcher": "*", "hooks": [{"type": "command", "command": "echo mine"}]}
        s = {"hooks": {"SessionStart": [mine]}}
        cfg = plugin_units.load_hooks_json(self.root)
        s, removed, _ = plugin_units.hooks_merge(s, cfg, self.root, None)
        self.assertEqual(removed, 0)
        self.assertIn(mine, s["hooks"]["SessionStart"])
        self.assertEqual(len(s["hooks"]["SessionStart"]), 2)

    def test_remove_leaves_empty_event_key_absent(self):
        import plugin_units
        cfg = plugin_units.load_hooks_json(self.root)
        s, _, _ = plugin_units.hooks_merge({}, cfg, self.root, None)
        s, removed = plugin_units.hooks_remove(s, self.root)
        self.assertEqual(removed, 2)
        self.assertNotIn("SessionStart", s.get("hooks", {}))   # 빈 배열을 남기지 않는다

    def test_remove_is_idempotent(self):
        import plugin_units
        cfg = plugin_units.load_hooks_json(self.root)
        s, _, _ = plugin_units.hooks_merge({}, cfg, self.root, None)
        s, _ = plugin_units.hooks_remove(s, self.root)
        s, again = plugin_units.hooks_remove(s, self.root)
        self.assertEqual(again, 0)

    def test_remove_keeps_other_tools_hooks_in_a_shared_entry(self):
        # 실측: PostToolUse Edit|Write 한 엔트리에 두 도구의 hook 이 나란히 있다. 엔트리째
        # 지우면 남의 hook 이 딸려 나간다 - 내 hook 만 빠지고 엔트리와 matcher 는 남아야 한다.
        import plugin_units
        mine = {"type": "command", "command": 'node "' + self.root + '/index.js"'}
        theirs = {"type": "command", "command": 'node "D:/elsewhere/comment-linter/index.js"'}
        s = {"hooks": {"PostToolUse": [{"matcher": "Edit|Write", "hooks": [theirs, mine]}]}}
        s, removed = plugin_units.hooks_remove(s, self.root)
        self.assertEqual(removed, 1)
        self.assertEqual(s["hooks"]["PostToolUse"], [{"matcher": "Edit|Write", "hooks": [theirs]}])

    def test_merge_into_a_shared_entry_replaces_only_its_own_hook(self):
        import plugin_units
        theirs = {"type": "command", "command": 'node "D:/elsewhere/comment-linter/index.js"'}
        old = {"type": "command", "command": 'python3 "' + self.root + '/hooks/post.py"', "timeout": 10}
        s = {"hooks": {"PostToolUse": [{"matcher": "Edit|Write", "hooks": [theirs, old]}]}}
        cfg = plugin_units.load_hooks_json(self.root)
        s, removed, added = plugin_units.hooks_merge(s, cfg, self.root, self.root)
        self.assertEqual((removed, added), (1, 2))
        post = s["hooks"]["PostToolUse"]
        self.assertEqual(post[0], {"matcher": "Edit|Write", "hooks": [theirs]})
        self.assertEqual(len(post), 2)
        self.assertIn(self.root, post[1]["hooks"][0]["command"])


class InterpreterCheck(unittest.TestCase):
    """인터프리터 사전 점검: 없음 / WindowsApps 스텁 / 정상. 차단이 아니라 경고다."""

    def test_first_token_handles_quotes_and_paths(self):
        import plugin_units
        self.assertEqual(plugin_units.first_token('bash "${X}/a.sh"'), "bash")
        self.assertEqual(plugin_units.first_token('python3 "${X}/p.py" --flag'), "python3")
        self.assertEqual(plugin_units.first_token('"C:/Program Files/x/y.exe" a'), "C:/Program Files/x/y.exe")
        self.assertEqual(plugin_units.first_token(""), "")

    def test_missing_interpreter_is_flagged(self):
        import plugin_units
        r = plugin_units.check_interpreter("nosuchinterp x", which=lambda n: None)
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "missing")

    def test_windowsapps_stub_is_flagged_even_though_which_finds_it(self):
        # findings §5 실측: python3 는 PATH 에 있는 것처럼 보이지만 실행이 실패한다.
        # shutil.which 만으로는 못 거른다.
        import plugin_units
        stub = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe"
        r = plugin_units.check_interpreter('python3 "${X}/p.py"', which=lambda n: stub)
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "stub")
        self.assertEqual(r["interp"], "python3")

    def test_real_interpreter_passes(self):
        import plugin_units
        r = plugin_units.check_interpreter("bash x.sh", which=lambda n: "/usr/bin/bash")
        self.assertTrue(r["ok"])
        self.assertEqual(r["reason"], "")

    def test_warnings_collect_only_problems(self):
        import plugin_units
        cfg = {"hooks": {"S": [{"hooks": [
            {"type": "command", "command": "bash a.sh"},
            {"type": "command", "command": "python3 b.py"},
        ]}]}}
        stub = "C:\\WindowsApps\\python3.exe"
        w = plugin_units.interpreter_warnings(
            cfg, which=lambda n: stub if n == "python3" else "/usr/bin/" + n)
        self.assertEqual([x["interp"] for x in w], ["python3"])
        self.assertEqual(w[0]["reason"], "stub")


class HooksInstall(unittest.TestCase):
    """hooks 설치: 캐시를 참조하는 엔트리를 settings 에 병합. 캐시는 load-bearing 이 된다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hooksinst_test_")
        self.store = os.path.join(self.tmp, "store")
        self.target = os.path.join(self.tmp, ".claude")
        os.makedirs(self.target)
        self.settings = os.path.join(self.target, "settings.json")
        with open(self.settings, "w", encoding="utf-8") as f:
            json.dump({"permissions": {"allow": ["Bash(ls:*)"]}}, f)
        self.root = os.path.join(self.tmp, "cache", "plugins", "sg", "abc123")
        os.makedirs(os.path.join(self.root, "hooks"))
        os.makedirs(os.path.join(self.root, "hooks-handlers"))
        with open(os.path.join(self.root, "hooks", "hooks.json"), "w", encoding="utf-8") as f:
            json.dump({"hooks": {"SessionStart": [{"hooks": [{"type": "command",
                       "command": 'bash "${CLAUDE_PLUGIN_ROOT}/hooks-handlers/s.sh"',
                       "timeout": 5}]}]}}, f)
        run(CAS, "--store", self.store, "init")
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        cfg["marketplaces"] = [{"id": "mk", "url": "u", "cache": os.path.join(self.tmp, "repo"),
                                "plugins": [{"name": "sg", "sha": "abc123", "cache": self.root}]}]
        lib_store.save_cfg(self.store, cfg)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def libcmd(self, *args):
        return run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot", *args)

    def _settings(self):
        with open(self.settings, encoding="utf-8") as f:
            return json.load(f)

    def test_install_merges_entry_with_absolute_cache_path(self):
        rc, out, err = self.libcmd("hooks-install", "--origin", "market:mk/sg",
                                   "--settings", self.settings)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])
        s = self._settings()
        cmd = s["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        self.assertIn(self.root, cmd)
        self.assertNotIn("${CLAUDE_PLUGIN_ROOT}", cmd)
        self.assertEqual(s["hooks"]["SessionStart"][0]["hooks"][0]["timeout"], 5)
        self.assertEqual(s["permissions"]["allow"], ["Bash(ls:*)"])   # 기존 키 보존

    def test_install_is_idempotent(self):
        self.libcmd("hooks-install", "--origin", "market:mk/sg", "--settings", self.settings)
        self.libcmd("hooks-install", "--origin", "market:mk/sg", "--settings", self.settings)
        self.assertEqual(len(self._settings()["hooks"]["SessionStart"]), 1)

    def test_scan_reports_hooks_install_state_for_the_owning_origin(self):
        # Library 의 Hooks 토글이 설치됨/미설치와 제거 버튼을 이 플래그로 그린다.
        row = lambda: next(l for l in json.loads(self.libcmd("scan")[1])["libraries"]
                           if l["origin"] == "market:mk/sg")
        before = row()
        self.assertTrue(before["has_hooks"])
        self.assertFalse(before["hooks_installed"])
        self.libcmd("hooks-install", "--origin", "market:mk/sg", "--settings", self.settings)
        after = row()
        self.assertTrue(after["hooks_installed"])
        self.assertEqual(after["hooks_events"], ["SessionStart"])

        # 원장 키는 플러그인 **이름**이라 다른 마켓의 동명 플러그인이 같은 칸을 본다.
        # origin 이 다르면 남의 설치를 내 행의 배지로 표시하지 않는다.
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        cfg["marketplaces"][0]["id"] = "other"
        lib_store.save_cfg(self.store, cfg)
        other = next(l for l in json.loads(self.libcmd("scan")[1])["libraries"]
                     if l["origin"] == "market:other/sg")
        self.assertFalse(other["hooks_installed"])

    def test_install_records_root_in_ledger(self):
        self.libcmd("hooks-install", "--origin", "market:mk/sg", "--settings", self.settings)
        import lib_store
        rec = lib_store.ledger_get(lib_store.load_cfg(self.store), self.target, "hooks", "sg")
        self.assertEqual(rec["kind"], "hooks")
        self.assertEqual(rec["root"], self.root)
        self.assertEqual(rec["origin"], "market:mk/sg")

    def test_uninstall_uses_ledger_root_after_sha_change(self):
        # 갱신 멱등성의 핵심. 캐시가 새 sha 로 옮겨간 뒤에도 옛 엔트리를 정확히 걷어낸다.
        self.libcmd("hooks-install", "--origin", "market:mk/sg", "--settings", self.settings)
        new_root = os.path.join(self.tmp, "cache", "plugins", "sg", "def456")
        shutil.copytree(self.root, new_root)
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        cfg["marketplaces"][0]["plugins"][0].update({"sha": "def456", "cache": new_root})
        lib_store.save_cfg(self.store, cfg)
        rc, out, err = self.libcmd("hooks-install", "--origin", "market:mk/sg", "--settings", self.settings)
        self.assertEqual(rc, 0, err)
        arr = self._settings()["hooks"]["SessionStart"]
        self.assertEqual(len(arr), 1, "옛 경로 엔트리가 남으면 중복이 쌓인다")
        self.assertIn(new_root, arr[0]["hooks"][0]["command"])

    def test_uninstall_removes_entry_and_ledger(self):
        self.libcmd("hooks-install", "--origin", "market:mk/sg", "--settings", self.settings)
        rc, out, err = self.libcmd("hooks-uninstall", "--origin", "market:mk/sg", "--settings", self.settings)
        self.assertEqual(rc, 0, err)
        s = self._settings()
        self.assertNotIn("hooks", s)
        self.assertEqual(s["permissions"]["allow"], ["Bash(ls:*)"])   # 무관 키 보존(uninstall 도 검증)
        import lib_store
        self.assertIsNone(lib_store.ledger_get(lib_store.load_cfg(self.store), self.target, "hooks", "sg"))

    def test_install_refuses_unmaterialized_plugin(self):
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        cfg["marketplaces"][0]["plugins"] = []
        lib_store.save_cfg(self.store, cfg)
        rc, out, err = self.libcmd("hooks-install", "--origin", "market:mk/sg", "--settings", self.settings)
        res = json.loads(out)
        self.assertFalse(res["ok"])
        self.assertIn("fetch", res["message"])

    def test_install_takes_no_network(self):
        rc, out, err = run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot",
                           "hooks-install", "--origin", "market:mk/sg", "--settings", self.settings,
                           env={"PATH": ""})
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])

    def test_dry_run_returns_commands_and_warnings_without_writing(self):
        # 설치 = 매 세션 임의 코드 실행. 치환된 명령 원문을 그대로 보여주고 확인받는다.
        rc, out, err = self.libcmd("hooks-install", "--origin", "market:mk/sg",
                                   "--settings", self.settings, "--dry-run")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])
        self.assertTrue(res["dry_run"])
        self.assertIn(self.root, res["commands"][0])
        self.assertIn("warnings", res)
        self.assertNotIn("hooks", self._settings())     # 쓰지 않았다


class McpInstall(HooksInstall):
    """MCP 서버 설치. scope=user(~/.claude.json) / desktop(claude_desktop_config.json).

    --claude-json/--desktop-config 는 부모 파서 옵션이라 subcommand 앞에 와야 argparse 가
    인식한다(경험적으로 확인됨 - subcommand 뒤에 두면 "unrecognized arguments" 로 rc=2).
    libcmd 를 오버라이드해 이 두 플래그를 자동으로 subcommand 앞으로 끌어올린다 - 그래서
    개별 테스트 메서드는 다른 서브클래스와 같은 모양으로 인자를 나열할 수 있다."""

    def setUp(self):
        super().setUp()
        with open(os.path.join(self.root, ".mcp.json"), "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {
                "sg-server": {"command": "node",
                              "args": ["${CLAUDE_PLUGIN_ROOT}/server/index.js"]},
                "other": {"command": "python", "args": ["${CLAUDE_PLUGIN_ROOT}/o.py"]},
            }}, f)
        self.claude_json = os.path.join(self.tmp, "claude.json")
        with open(self.claude_json, "w", encoding="utf-8") as f:
            json.dump({"projects": {}}, f)

    def libcmd(self, *args):
        args = list(args)
        prefix, rest, i = [], [], 0
        while i < len(args):
            if args[i] in ("--claude-json", "--desktop-config") and i + 1 < len(args):
                prefix += [args[i], args[i + 1]]
                i += 2
            else:
                rest.append(args[i])
                i += 1
        return run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot",
                  *prefix, *rest)

    def _cj(self):
        with open(self.claude_json, encoding="utf-8") as f:
            return json.load(f)

    def test_install_substitutes_root_in_args(self):
        rc, out, err = self.libcmd("mcp-install", "--origin", "market:mk/sg",
                                   "--claude-json", self.claude_json)
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"])
        srv = self._cj()["mcpServers"]["sg-server"]
        self.assertIn(self.root, srv["args"][0])
        self.assertNotIn("${CLAUDE_PLUGIN_ROOT}", json.dumps(srv))
        self.assertEqual(self._cj()["projects"], {})       # 기존 키 보존

    def test_install_single_server_only(self):
        self.libcmd("mcp-install", "--origin", "market:mk/sg", "--server", "sg-server",
                    "--claude-json", self.claude_json)
        self.assertEqual(list(self._cj()["mcpServers"]), ["sg-server"])

    def test_install_is_idempotent(self):
        for _ in range(2):
            self.libcmd("mcp-install", "--origin", "market:mk/sg", "--claude-json", self.claude_json)
        self.assertEqual(sorted(self._cj()["mcpServers"]), ["other", "sg-server"])

    def test_uninstall_removes_only_this_plugins_servers(self):
        cj = self._cj(); cj["mcpServers"] = {"mine": {"command": "x"}}
        with open(self.claude_json, "w", encoding="utf-8") as f:
            json.dump(cj, f)
        self.libcmd("mcp-install", "--origin", "market:mk/sg", "--claude-json", self.claude_json)
        rc, out, err = self.libcmd("mcp-uninstall", "--origin", "market:mk/sg",
                                   "--claude-json", self.claude_json)
        self.assertEqual(rc, 0, err)
        cj2 = self._cj()
        self.assertEqual(list(cj2["mcpServers"]), ["mine"])
        self.assertEqual(cj2["projects"], {})               # 무관 키 보존(uninstall 도 검증)

    def test_install_records_ledger_with_server_names(self):
        self.libcmd("mcp-install", "--origin", "market:mk/sg", "--claude-json", self.claude_json)
        import lib_store
        rec = lib_store.ledger_get(lib_store.load_cfg(self.store), self.target, "mcp", "sg")
        self.assertEqual(rec["kind"], "mcp")
        self.assertEqual(sorted(rec["servers"]), ["other", "sg-server"])
        self.assertEqual(rec["root"], self.root)

    def test_install_refuses_unmaterialized(self):
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        cfg["marketplaces"][0]["plugins"] = []
        lib_store.save_cfg(self.store, cfg)
        rc, out, err = self.libcmd("mcp-install", "--origin", "market:mk/sg",
                                   "--claude-json", self.claude_json)
        self.assertIn("fetch", json.loads(out)["message"])

    def test_dry_run_shows_servers_without_writing(self):
        rc, out, err = self.libcmd("mcp-install", "--origin", "market:mk/sg",
                                   "--claude-json", self.claude_json, "--dry-run")
        res = json.loads(out)
        self.assertTrue(res["dry_run"])
        self.assertEqual(sorted(res["servers"]), ["other", "sg-server"])
        self.assertNotIn("mcpServers", self._cj())

    def test_install_desktop_scope_writes_desktop_config_not_claude_json(self):
        # scope=desktop 이 실질 가치다 - Claude Desktop 은 /plugin 마켓플레이스가 없어서
        # 플러그인의 MCP 서버를 Desktop 에 꽂는 경로는 현재 이것뿐이다.
        desktop_config = os.path.join(self.tmp, "claude_desktop_config.json")
        with open(desktop_config, "w", encoding="utf-8") as f:
            json.dump({}, f)
        rc, out, err = self.libcmd("mcp-install", "--origin", "market:mk/sg", "--scope", "desktop",
                                   "--claude-json", self.claude_json,
                                   "--desktop-config", desktop_config)
        self.assertEqual(rc, 0, err)
        with open(desktop_config, encoding="utf-8") as f:
            dcfg = json.load(f)
        self.assertEqual(sorted(dcfg["mcpServers"]), ["other", "sg-server"])
        self.assertNotIn("mcpServers", self._cj())          # user scope 파일은 안 건드림


class HooksMergeIdempotency(unittest.TestCase):
    """root 를 참조하지 않는 hook 도 재설치마다 중복 누적되면 안 된다.

    hooks_remove 는 root 를 포함하는 command 만 걷어낼 수 있다. hooks.json 안의 command 가
    ${CLAUDE_PLUGIN_ROOT} 를 전혀 쓰지 않으면(전역 도구를 그대로 부르는 hook - 유효한 형태다)
    root 기반 제거로는 절대 못 찾는다. hooks_merge 는 삽입 전에 '이번에 추가하려는 엔트리와
    구조적으로 동일한' 기존 엔트리도 함께 걷어내야 한다 - root 매칭과는 독립적인 두 번째 메커니즘.
    """

    HOOKS = {
        "description": "mixed hooks - root 참조/비참조 혼합",
        "hooks": {
            "SessionStart": [],
            "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "echo pre"}]}],
            "Stop": [{"hooks": [{"type": "command", "command": "echo hi"}]}],
            "PostToolUse": [{"hooks": [{"type": "command",
                "command": 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/p.sh"'}]}],
        },
    }

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hooksmerge_id_test_")
        self.root = os.path.join(self.tmp, "plugins", "sg", "abc123")
        os.makedirs(os.path.join(self.root, "hooks"))
        with open(os.path.join(self.root, "hooks", "hooks.json"), "w", encoding="utf-8") as f:
            json.dump(self.HOOKS, f)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_install_three_times_yields_exactly_one_entry_per_event(self):
        import plugin_units
        cfg = plugin_units.load_hooks_json(self.root)
        s = {}
        for _ in range(3):
            s, removed, added = plugin_units.hooks_merge(s, cfg, self.root, self.root)
        self.assertEqual(len(s["hooks"]["PreToolUse"]), 1)
        self.assertEqual(len(s["hooks"]["Stop"]), 1)
        self.assertEqual(len(s["hooks"]["PostToolUse"]), 1)

    def test_empty_event_list_does_not_create_key(self):
        # hooks.json 의 SessionStart 가 빈 배열이면 settings 에도 빈 키를 남기면 안 된다.
        import plugin_units
        cfg = plugin_units.load_hooks_json(self.root)
        s, _, _ = plugin_units.hooks_merge({}, cfg, self.root, None)
        self.assertNotIn("SessionStart", s.get("hooks", {}))

    def test_user_own_different_hook_survives_repeated_merge(self):
        # 사용자의 다른 hook(내용이 다름)은 identity 기반 제거에 걸리지 않고 살아남아야 한다.
        import plugin_units
        mine = {"hooks": [{"type": "command", "command": "echo mine"}]}
        s = {"hooks": {"Stop": [mine]}}
        cfg = plugin_units.load_hooks_json(self.root)
        for _ in range(3):
            s, _, _ = plugin_units.hooks_merge(s, cfg, self.root, self.root)
        self.assertIn(mine, s["hooks"]["Stop"])
        self.assertEqual(len(s["hooks"]["Stop"]), 2)   # mine 1 + 플러그인 것 1(중복 없음)

    def test_hooks_remove_after_repeated_merge_clears_root_entry_without_duplicates(self):
        # root 로 추적 가능한 엔트리는 merge 의 identity 중복 방지 덕에 1건만 남고,
        # hooks_remove 가 그 1건을 온전히 걷어낸다(중복이 쌓였다면 1보다 큰 수가 나왔을 것).
        import plugin_units
        cfg = plugin_units.load_hooks_json(self.root)
        s = {}
        for _ in range(3):
            s, _, _ = plugin_units.hooks_merge(s, cfg, self.root, self.root)
        s, removed = plugin_units.hooks_remove(s, self.root)
        self.assertEqual(removed, 1)
        self.assertNotIn("PostToolUse", s.get("hooks", {}))

    def test_sha_change_still_deduplicates_non_root_entries(self):
        # root 기반 제거(sha 변경 케이스)와 identity 기반 제거(비-root 엔트리)가 함께 작동해야 한다.
        import plugin_units
        cfg = plugin_units.load_hooks_json(self.root)
        s, _, _ = plugin_units.hooks_merge({}, cfg, self.root, None)
        new_root = os.path.join(self.tmp, "plugins", "sg", "def456")
        s, removed, added = plugin_units.hooks_merge(s, cfg, new_root, self.root)
        self.assertEqual(len(s["hooks"]["PostToolUse"]), 1)
        cmd = s["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
        self.assertIn(new_root, cmd)
        self.assertNotIn(self.root, cmd)
        self.assertEqual(len(s["hooks"]["PreToolUse"]), 1)   # root 와 무관하게 identity 로 dedup
        self.assertEqual(len(s["hooks"]["Stop"]), 1)


class NoneInputsAreNoops(unittest.TestCase):
    """load_hooks_json 이 흔히 돌려주는 None(hooks.json 없음)을 받아도 크래시하지 않는다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="none_input_test_")
        self.root = os.path.join(self.tmp, "plugins", "sg", "abc123")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_hooks_merge_none_cfg_is_a_noop(self):
        import plugin_units
        s = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo mine"}]}]}}
        before = json.loads(json.dumps(s))
        s2, removed, added = plugin_units.hooks_merge(s, None, self.root, None)
        self.assertEqual((removed, added), (0, 0))
        self.assertEqual(s2, before)

    def test_hook_commands_none_is_empty_list(self):
        import plugin_units
        self.assertEqual(plugin_units.hook_commands(None), [])

    def test_entry_refs_root_none_entry_is_false(self):
        import plugin_units
        self.assertFalse(plugin_units.entry_refs_root(None, self.root))

    def test_interpreter_warnings_none_cfg_is_empty_list(self):
        import plugin_units
        self.assertEqual(plugin_units.interpreter_warnings(None), [])


class HooksUninstallStructural(unittest.TestCase):
    """hooks-uninstall fix round 1: root 문자열 매칭만으로는 ${CLAUDE_PLUGIN_ROOT} 를 전혀
    안 쓰는(전역 도구를 직접 부르는) hook 을 못 찾는다. hooks_merge 가 이제 root 매칭 +
    구조적 동일성 두 메커니즘으로 설치 중복을 막듯, uninstall 도 대칭으로 제거해야 한다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hooksuninst_test_")
        self.store = os.path.join(self.tmp, "store")
        self.target = os.path.join(self.tmp, ".claude")
        os.makedirs(self.target)
        self.settings = os.path.join(self.target, "settings.json")
        # settings.json 에 사용자 자신의 Stop hook 을 미리 심는다 - 플러그인 것과 같은
        # 이벤트에 있지만 내용이 다르므로 uninstall 후에도 살아남아야 한다.
        with open(self.settings, "w", encoding="utf-8") as f:
            json.dump({"hooks": {"Stop": [{"matcher": "*",
                       "hooks": [{"type": "command", "command": "echo user-own"}]}]}}, f)
        self.root = os.path.join(self.tmp, "cache", "plugins", "sg", "abc123")
        os.makedirs(os.path.join(self.root, "hooks"))
        with open(os.path.join(self.root, "hooks", "hooks.json"), "w", encoding="utf-8") as f:
            json.dump({"hooks": {
                # root 를 참조하는 엔트리(기존 메커니즘으로도 잡힌다) - 대조군.
                "PreToolUse": [{"hooks": [{"type": "command",
                    "command": 'bash "${CLAUDE_PLUGIN_ROOT}/hooks-handlers/pre.sh"'}]}],
                # root 를 전혀 참조하지 않는 엔트리 - 전역 도구를 직접 부른다.
                # 이게 finding 1 이 재현하는 케이스: root 매칭으로는 절대 못 찾는다.
                "Stop": [{"matcher": "*", "hooks": [{"type": "command",
                    "command": "global-lint-tool --check"}]}],
            }}, f)
        run(CAS, "--store", self.store, "init")
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        cfg["marketplaces"] = [{"id": "mk", "url": "u", "cache": os.path.join(self.tmp, "repo"),
                                "plugins": [{"name": "sg", "sha": "abc123", "cache": self.root}]}]
        lib_store.save_cfg(self.store, cfg)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def libcmd(self, *args):
        return run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot", *args)

    def _settings(self):
        with open(self.settings, encoding="utf-8") as f:
            return json.load(f)

    def test_uninstall_removes_hook_not_referencing_plugin_root(self):
        self.libcmd("hooks-install", "--origin", "market:mk/sg", "--settings", self.settings)
        # 설치 직후: PreToolUse 1건(root 참조), Stop 은 사용자 것 + 플러그인 것 = 2건.
        before = self._settings()
        self.assertEqual(len(before["hooks"]["PreToolUse"]), 1)
        self.assertEqual(len(before["hooks"]["Stop"]), 2)

        rc, out, err = self.libcmd("hooks-uninstall", "--origin", "market:mk/sg",
                                   "--settings", self.settings)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])

        after = self._settings()
        self.assertNotIn("PreToolUse", after.get("hooks", {}))
        # global-lint-tool 엔트리(root 미참조)가 실제로 사라졌는지 - fix round 1 의 핵심 검증.
        stop_cmds = [h["hooks"][0]["command"] for h in after.get("hooks", {}).get("Stop", [])]
        self.assertNotIn("global-lint-tool --check", stop_cmds)
        # PreToolUse 가 빈 배열로 낙오되지 않았는지(hooks_remove 가 지우고, 그 뒤 identity
        # 제거 루프가 다른 이벤트를 건드리다 빈 형제 키를 남기면 이 assert 가 잡는다).
        self.assertEqual(sorted(after["hooks"]), ["Stop"])

    def test_uninstall_leaves_users_own_hook_in_same_event(self):
        self.libcmd("hooks-install", "--origin", "market:mk/sg", "--settings", self.settings)
        self.libcmd("hooks-uninstall", "--origin", "market:mk/sg", "--settings", self.settings)
        after = self._settings()
        stop_cmds = [h["hooks"][0]["command"] for h in after["hooks"]["Stop"]]
        self.assertEqual(stop_cmds, ["echo user-own"])

    def test_uninstall_degrades_gracefully_when_cache_gone(self):
        self.libcmd("hooks-install", "--origin", "market:mk/sg", "--settings", self.settings)
        shutil.rmtree(self.root)   # 사용자가 도구 밖에서 캐시를 직접 지운 상황을 재현.

        rc, out, err = self.libcmd("hooks-uninstall", "--origin", "market:mk/sg",
                                   "--settings", self.settings)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])
        self.assertTrue(res.get("degraded"), "캐시가 없으면 축소된 결과임을 명시해야 한다")
        self.assertTrue(res.get("warning"))

        after = self._settings()
        # root 매칭 엔트리는 캐시가 없어도 여전히 제거된다(hooks_remove 는 command 문자열만 본다).
        self.assertNotIn("PreToolUse", after.get("hooks", {}))
        # 구조적 동일성은 hooks.json 을 다시 읽어야 하는데 캐시가 없어 읽을 수 없다 -
        # root 미참조 엔트리는 "할 수 있는 만큼만" 원칙에 따라 남는다(조용히 사라지면 안 됨).
        stop_cmds = [h["hooks"][0]["command"] for h in after.get("hooks", {}).get("Stop", [])]
        self.assertIn("global-lint-tool --check", stop_cmds)
        self.assertIn("echo user-own", stop_cmds)   # 사용자 hook 은 이 경로에서도 안 건드림


class ScanHooksMcpFlags(unittest.TestCase):
    """scan 이 has_hooks/has_mcp 를 방출해야 대시보드의 hooks/mcp 설치 버튼이 뜬다(fix round 1
    Finding 2 - 이전에는 cmd_plugin_fetch 응답에만 있어 scan 행에는 없었다)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="scanflags_test_")
        self.store = os.path.join(self.tmp, "store")
        self.target = os.path.join(self.tmp, ".claude")
        run(CAS, "--store", self.store, "init")

        self.lib_both = os.path.join(self.tmp, "plugin-both")
        os.makedirs(os.path.join(self.lib_both, "hooks"))
        with open(os.path.join(self.lib_both, "hooks", "hooks.json"), "w", encoding="utf-8") as f:
            json.dump({"hooks": {}}, f)
        with open(os.path.join(self.lib_both, ".mcp.json"), "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {}}, f)

        self.lib_neither = os.path.join(self.tmp, "plugin-neither")
        os.makedirs(self.lib_neither)

        self.lib_missing = os.path.join(self.tmp, "plugin-missing")   # 등록만 하고 실제로는 안 만든다

        import lib_store
        cfg = lib_store.load_cfg(self.store)
        cfg["libraries"] = [self.lib_both, self.lib_neither]
        cfg.setdefault("remotes", []).append({"id": "gone", "url": "u", "cache": self.lib_missing})
        lib_store.save_cfg(self.store, cfg)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def libcmd(self, *args):
        return run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot", *args)

    def _rows(self):
        rc, out, err = self.libcmd("scan")
        self.assertEqual(rc, 0, err)
        return {r["lib"]: r for r in json.loads(out)["libraries"]}

    def test_plugin_with_both_reports_true(self):
        row = self._rows()[self.lib_both]
        self.assertTrue(row["has_hooks"])
        self.assertTrue(row["has_mcp"])

    def test_plugin_with_neither_reports_false(self):
        row = self._rows()[self.lib_neither]
        self.assertFalse(row["has_hooks"])
        self.assertFalse(row["has_mcp"])

    def test_missing_cache_row_reports_false_without_raising(self):
        row = self._rows()[self.lib_missing]
        self.assertEqual(row.get("error"), "경로 없음")
        self.assertFalse(row["has_hooks"])
        self.assertFalse(row["has_mcp"])
        self.assertEqual(row["units"], [])

    def test_sub_units_are_listed_and_install_by_their_own_origin(self):
        # 라이브러리 하나가 도구 여러 개를 나란히 담는 구조(Hooks/<name>, servers/<name>). 루트에
        # 매니페스트가 없어도 하위 유닛이 각자 행으로 나와야 설치 버튼이 뜨고, 유닛 origin 으로
        # 설치하면 치환 루트가 라이브러리가 아니라 그 유닛 디렉토리여야 한다.
        lib = os.path.join(self.tmp, "tools")
        alpha = os.path.join(lib, "Hooks", "alpha")
        os.makedirs(os.path.join(alpha, "hooks"))
        with open(os.path.join(alpha, "hooks", "hooks.json"), "w", encoding="utf-8") as f:
            json.dump({"hooks": {"Stop": [{"hooks": [{"type": "command",
                       "command": 'node "${CLAUDE_PLUGIN_ROOT}/index.js"'}]}]}}, f)
        beta = os.path.join(lib, "servers", "beta")
        os.makedirs(beta)
        with open(os.path.join(beta, ".mcp.json"), "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {"beta": {"command": "python",
                                               "args": ["${CLAUDE_PLUGIN_ROOT}/s.py"]}}}, f)
        os.makedirs(os.path.join(lib, "Hooks", "bare"))                        # 매니페스트 없음
        deep = os.path.join(lib, "deep", "x", "gamma", "hooks")                # 깊이 3 - 안 본다
        os.makedirs(deep)
        with open(os.path.join(deep, "hooks.json"), "w", encoding="utf-8") as f:
            json.dump({"hooks": {}}, f)
        os.makedirs(self.target)
        with open(os.path.join(self.target, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({}, f)
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        cfg["libraries"].append(lib)
        lib_store.save_cfg(self.store, cfg)

        row = self._rows()[lib]
        self.assertFalse(row["has_hooks"])
        self.assertFalse(row["has_mcp"])
        units = {u["name"]: u for u in row["units"]}
        self.assertEqual(sorted(units), ["alpha", "beta"])
        self.assertTrue(units["alpha"]["has_hooks"])
        self.assertFalse(units["alpha"]["has_mcp"])
        self.assertTrue(units["beta"]["has_mcp"])
        self.assertFalse(units["beta"]["has_hooks"])
        self.assertTrue(units["alpha"]["origin"].startswith("local:"))

        rc, out, err = self.libcmd("hooks-install", "--origin", units["alpha"]["origin"], "--dry-run")
        self.assertEqual(rc, 0, err)
        dry = json.loads(out)
        self.assertTrue(dry["ok"], dry)
        self.assertIn(os.path.normcase(alpha), os.path.normcase(dry["commands"][0]))
        rc, out, err = self.libcmd("hooks-install", "--origin", units["alpha"]["origin"])
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"], out)
        unit = {u["name"]: u for u in self._rows()[lib]["units"]}["alpha"]
        self.assertTrue(unit["hooks_installed"])
        self.assertEqual(unit["hooks_events"], ["Stop"])


class ClassifySource(unittest.TestCase):
    """classify_source: Claude Code 가 받는 4형식 판별 + 주입성 입력 거부.

    순수 함수라 네트워크/git 이 필요 없다. 디스크는 '그 경로가 디렉토리인가'만 본다."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="classify_test_"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cs(self, s):
        import marketplace
        return marketplace.classify_source(s)

    def reject(self, s):
        import marketplace
        with self.assertRaises(marketplace.ManifestError, msg=s):
            marketplace.classify_source(s)

    def test_owner_repo_shorthand_becomes_github_url(self):
        r = self.cs("anthropics/claude-code")
        self.assertEqual(r["kind"], "git")
        self.assertEqual(r["url"], "https://github.com/anthropics/claude-code.git")
        self.assertEqual(r["id"], "claude-code")

    def test_shorthand_id_matches_full_url_id_so_both_notations_dedupe(self):
        # 중복 검사는 정규화된 url 로 한다 - 축약과 전체 URL 이 같은 값으로 수렴해야
        # 같은 레포를 두 번 등록하는 걸 잡는다.
        import library
        short = self.cs("anthropics/claude-code")
        full = self.cs("https://github.com/anthropics/claude-code.git")
        self.assertEqual(library._norm_url(short["url"]), library._norm_url(full["url"]))
        self.assertEqual(short["id"], full["id"])

    def test_shorthand_ref_suffix_is_split_off_not_glued_into_the_url(self):
        # Claude Code 의 Add Marketplace 는 owner/repo#branch · owner/repo@tag 를 받는다.
        # 떼어내지 않으면 '#'/'@' 가 세그먼트 검증을 통과해 URL 뒤에 붙고(.../repo#main.git)
        # clone 단계에서야 깨진다 - 거부도 아니고 동작도 아닌 최악의 조합이었다.
        for src, ref in (("anthropics/claude-code#main", "main"),
                         ("anthropics/claude-code@v1.0.0", "v1.0.0"),
                         ("anthropics/claude-code#feature/x", "feature/x")):
            with self.subTest(src=src):
                r = self.cs(src)
                self.assertEqual(r["url"], "https://github.com/anthropics/claude-code.git")
                self.assertEqual(r["ref"], ref)
                self.assertEqual(r["id"], "claude-code")
        self.assertIsNone(self.cs("anthropics/claude-code")["ref"])

    def test_scp_style_stays_git_and_is_not_rewritten(self):
        r = self.cs("git@github.com:owner/repo.git")
        self.assertEqual(r["kind"], "git")
        self.assertEqual(r["url"], "git@github.com:owner/repo.git")
        self.assertEqual(r["id"], "repo")

    def test_https_json_is_json_kind(self):
        r = self.cs("https://example.com/team/marketplace.json")
        self.assertEqual(r["kind"], "json")
        self.assertEqual(r["id"], "team")          # 파일명이 generic 이라 한 단계 위를 쓴다

    def test_json_with_query_string_is_not_mistaken_for_git(self):
        self.assertEqual(self.cs("https://example.com/a/mk.json?token=x")["kind"], "json")

    def test_json_over_non_http_scheme_is_rejected_not_stored(self):
        # 등록은 되는데 영원히 못 받는 레코드를 만들지 않는다.
        self.reject("ssh://git@example.com/mk.json")
        self.reject("git@example.com:mk.json")

    def test_explicit_relative_and_absolute_paths_are_local(self):
        sib = os.path.join(self.tmp, "a", "sib")
        os.makedirs(os.path.join(self.tmp, "a", "b"))
        os.makedirs(sib)
        r = self.cs(self.tmp)
        self.assertEqual(r["kind"], "local")
        self.assertEqual(r["path"], self.tmp)
        self.assertIsNone(r["url"])
        cwd = os.getcwd()
        os.chdir(os.path.join(self.tmp, "a", "b"))
        try:
            self.assertEqual(self.cs("../sib")["path"], sib)
            self.assertEqual(self.cs("./")["path"], os.path.join(self.tmp, "a", "b"))
        finally:
            os.chdir(cwd)

    def test_drive_absolute_path_is_local_on_any_platform(self):
        # 판정이 os.path.isabs 에 의존하면 POSIX 에서 'C:\x' 가 상대경로로 새어 축약 분기로 간다.
        import marketplace
        self.assertTrue(marketplace._DRIVE_ABS_RE.match(r"C:\abs\mk"))
        self.reject(r"C:\definitely\not\here\mk")   # 형식은 로컬, 없으면 거부

    def test_existing_directory_without_marker_is_local_but_checked_last(self):
        rel = os.path.basename(self.tmp)
        cwd = os.getcwd()
        os.chdir(os.path.dirname(self.tmp))
        try:
            self.assertEqual(self.cs(rel)["kind"], "local")
            # 같은 이름의 디렉토리가 cwd 에 있어도 축약이 로컬로 바뀌면 안 된다(cwd 의존 금지).
            os.makedirs(os.path.join(self.tmp, "owner", "repo"))
            os.chdir(self.tmp)
            self.assertEqual(self.cs("owner/repo")["kind"], "git")
        finally:
            os.chdir(cwd)

    def test_parent_traversal_to_nowhere_is_rejected(self):
        """로컬 소스의 거부 근거는 '상위로 올라갔다'가 아니라 '그런 디렉토리가 없다'이다.
        사용자는 어차피 절대경로로 아무 데나 가리킬 수 있으므로 이탈 자체는 막을 것이 아니고,
        막아야 하는 건 존재하지 않는 캐시를 가리키는 레코드가 스토어에 남는 것이다."""
        deep = os.path.join(self.tmp, "a", "b")
        os.makedirs(deep)
        cwd = os.getcwd()
        os.chdir(deep)
        try:
            self.reject("../../etc")
            self.assertEqual(self.cs("../..")["path"], self.tmp)   # 실재하면 로컬이 맞다
        finally:
            os.chdir(cwd)

    def test_injection_guards_run_before_any_branching(self):
        """뒤쪽 분기가 어차피 거부한다는 이유로 가드를 건너뛰면 분기 추가만으로 무력해진다 -
        거부 '사유'까지 확인해 가드가 실제로 돌았음을 못 박는다."""
        import marketplace
        with self.assertRaises(marketplace.ManifestError) as e1:
            marketplace.classify_source("-upload-pack=evil")
        self.assertIn("옵션", str(e1.exception))
        with self.assertRaises(marketplace.ManifestError) as e2:
            marketplace.classify_source("ext::sh -c evil")
        self.assertIn("전송 헬퍼", str(e2.exception))

    def test_unsafe_shorthand_segments_are_rejected(self):
        for bad in ("owner/re:po", "owner/con", "own\\er/repo", "owner/", "owner/..",
                    "/owner/repo/extra", "", "   ", "C:foo", "owner/repo/extra"):
            self.reject(bad)

    def test_ipv6_literal_url_is_not_mistaken_for_transport_helper(self):
        self.assertEqual(self.cs("https://[::1]/r.git")["kind"], "git")


def _start_json_server(routes):
    """로컬 픽스처 HTTP 서버. 테스트는 네트워크로 나가지 않는다.
    routes: {"/경로": (status, body_bytes)}"""
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            hit = routes.get(self.path)
            if hit is None:
                self.send_error(404)
                return
            status, body = hit
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


MANIFEST_BODY = json.dumps({"name": "jsonmarket", "plugins": [
    {"name": "ext1", "description": "remote only", "category": "development",
     "source": {"source": "url", "url": "https://example.invalid/x.git", "sha": "0" * 40}},
]}).encode()


class ManifestJsonFetch(unittest.TestCase):
    """fetch_manifest_json: 검증 -> 쓰기 순서, 크기 상한, http(s) 전용."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="jsonfetch_test_")
        self.dest = os.path.join(self.tmp, "repo")
        self.srv, self.base = _start_json_server({
            "/ok/marketplace.json": (200, MANIFEST_BODY),
            "/bad/marketplace.json": (200, b"{not json"),
            "/noplugins/marketplace.json": (200, b'{"name": "x"}'),
            "/big/marketplace.json": (200, b'{"plugins": [], "pad": "' + b"a" * 4096 + b'"}'),
        })

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def manifest_path(self):
        return os.path.join(self.dest, ".claude-plugin", "marketplace.json")

    def test_manifest_is_written_where_the_git_path_puts_it(self):
        import remote_fetch
        sha = remote_fetch.fetch_manifest_json(self.dest, self.base + "/ok/marketplace.json")
        self.assertEqual(sha, hashlib.sha256(MANIFEST_BODY).hexdigest()[:12])
        with open(self.manifest_path(), "rb") as f:
            self.assertEqual(f.read(), MANIFEST_BODY)

    def test_malformed_json_leaves_no_partial_cache(self):
        import remote_fetch
        with self.assertRaises(remote_fetch.FetchError):
            remote_fetch.fetch_manifest_json(self.dest, self.base + "/bad/marketplace.json")
        self.assertFalse(os.path.exists(self.dest))

    def test_missing_plugins_array_is_rejected(self):
        import remote_fetch
        with self.assertRaises(remote_fetch.FetchError):
            remote_fetch.fetch_manifest_json(self.dest, self.base + "/noplugins/marketplace.json")
        self.assertFalse(os.path.exists(self.dest))

    def test_oversized_body_is_refused_by_the_cap(self):
        import remote_fetch
        keep = remote_fetch.MANIFEST_MAX_BYTES
        remote_fetch.MANIFEST_MAX_BYTES = 512
        try:
            with self.assertRaises(remote_fetch.FetchError) as e:
                remote_fetch.fetch_manifest_json(self.dest, self.base + "/big/marketplace.json")
            self.assertIn("상한", str(e.exception))
        finally:
            remote_fetch.MANIFEST_MAX_BYTES = keep
        self.assertFalse(os.path.exists(self.dest))

    def test_non_http_scheme_is_refused_without_touching_disk(self):
        import remote_fetch
        for url in ("file:///c:/x/marketplace.json", "ssh://h/m.json", "-x", "git://h/m.json"):
            with self.assertRaises(remote_fetch.FetchError):
                remote_fetch.fetch_manifest_json(self.dest, url)
        self.assertFalse(os.path.exists(self.dest))

    def test_failed_refetch_does_not_clobber_the_cached_manifest(self):
        """검증을 쓰기 뒤에 하면 잘못된 응답 한 번이 멀쩡한 카탈로그를 지운다."""
        import remote_fetch
        remote_fetch.fetch_manifest_json(self.dest, self.base + "/ok/marketplace.json")
        with self.assertRaises(remote_fetch.FetchError):
            remote_fetch.fetch_manifest_json(self.dest, self.base + "/bad/marketplace.json")
        with open(self.manifest_path(), "rb") as f:
            self.assertEqual(f.read(), MANIFEST_BODY)
        self.assertFalse(os.path.exists(self.manifest_path() + ".tmp"))

    def test_error_messages_do_not_talk_about_git(self):
        import remote_fetch
        with self.assertRaises(remote_fetch.FetchError) as e:
            remote_fetch.fetch_manifest_json(self.dest, self.base + "/noplugins/marketplace.json")
        self.assertNotIn("git", str(e.exception).lower())


class MarketSourceForms(unittest.TestCase):
    """market-add 가 git 이외의 형식(json/local)을 받는다. git 회귀는 MarketAdd 가 지킨다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mksrc_test_")
        self.store = os.path.join(self.tmp, "store")
        self.target = os.path.join(self.tmp, ".claude")
        self.local = os.path.join(self.tmp, "localmk")
        os.makedirs(os.path.join(self.local, ".claude-plugin"))
        with open(os.path.join(self.local, ".claude-plugin", "marketplace.json"),
                  "w", encoding="utf-8") as f:
            json.dump({"name": "localmarket", "plugins": [
                {"name": "bundled", "description": "on disk", "category": "development",
                 "source": "./plugins/bundled"},
            ]}, f)
        self.srv, self.base = _start_json_server({
            "/mk/marketplace.json": (200, MANIFEST_BODY),
            "/mk/broken.json": (200, b"nope"),
            "/marketplace.json": (200, MANIFEST_BODY),
        })
        run(CAS, "--store", self.store, "init")

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def libcmd(self, *args, env=None):
        return run(LIB, "--store", self.store, "--target", self.target, "--no-snapshot",
                   *args, env=env)

    def rec(self, mid):
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        return next(m for m in cfg["marketplaces"] if m["id"] == mid)

    def test_local_directory_registers_without_git_or_copying(self):
        # PATH 를 비워 git 이 없는 상태를 만든다 - 로컬 등록이 git 게이트를 타면 여기서 죽는다.
        rc, out, err = self.libcmd("market-add", "--url", self.local, env={"PATH": ""})
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["kind"], "local")
        self.assertEqual(res["name"], "localmarket")
        self.assertEqual(res["cache"], os.path.realpath(self.local))   # 복사하지 않는다
        self.assertFalse(os.path.exists(os.path.join(self.store, "lib-cache", "markets",
                                                     "localmk", "repo")))

    def test_local_without_manifest_is_refused_as_not_a_marketplace(self):
        plain = os.path.join(self.tmp, "plain")
        os.makedirs(plain)
        rc, out, err = self.libcmd("market-add", "--url", plain)
        res = json.loads(out)
        self.assertFalse(res["ok"])
        self.assertIn("마켓플레이스가 아닙니다", res["message"])
        # UI 는 이 거절에서 Library 등록으로 건너뛸 길을 제시한다. message 는 한국어 문장이라
        # 매칭할 수 없으므로 그 분기는 code 로만 한다 - 없으면 유도가 조용히 죽는다.
        self.assertEqual(res.get("code"), "not_a_marketplace")

    def test_scan_flags_a_library_that_is_also_a_marketplace(self):
        # 매니페스트를 품은 디렉토리를 라이브러리로 등록하면, 등록은 되고 그 사실만 알린다.
        # (거절하면 skills 를 함께 가진 레포가 Library 로 들어올 길이 사라진다.)
        rc, out, err = self.libcmd("scan", "--lib", self.local)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        row = next(r for r in res["libraries"] if _norm_path(r["lib"]) == _norm_path(self.local))
        self.assertTrue(row["marketplace"], row)

    def test_scan_does_not_flag_a_plain_library(self):
        plain = os.path.join(self.tmp, "plainlib")
        os.makedirs(os.path.join(plain, "skills"))
        rc, out, err = self.libcmd("scan", "--lib", plain)
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        row = next(r for r in res["libraries"] if _norm_path(r["lib"]) == _norm_path(plain))
        self.assertFalse(row["marketplace"], row)

    def test_local_notations_of_the_same_dir_are_one_registration(self):
        self.libcmd("market-add", "--url", self.local)
        rc, out, err = self.libcmd("market-add", "--url",
                                   os.path.join(self.local, "sub", "..") + os.sep)
        res = json.loads(out)
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["already"])          # 다른 표기라고 두 번 등록되지 않는다
        self.assertIn("디스크에서 다시 읽었습니다", res["message"])

    def test_local_fetch_rereads_the_edited_manifest_instead_of_no_op(self):
        """로컬 마켓의 '갱신'은 사용자가 파일을 고치는 것이다 - fetch 는 다시 읽어야 한다."""
        before = json.loads(self.libcmd("market-add", "--url", self.local)[1])
        mpath = os.path.join(self.local, ".claude-plugin", "marketplace.json")
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump({"name": "localmarket", "plugins": [
                {"name": "bundled", "category": "development", "source": "./plugins/bundled"},
                {"name": "added", "category": "database", "source": "./plugins/added"},
            ]}, f)
        rc, out, err = self.libcmd("fetch", "--origin", "market:localmk")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["plugins"], 2)
        self.assertNotEqual(res["sha"], before["sha"])     # 내용 해시가 바뀌어 갱신이 보인다
        self.assertEqual(self.rec("localmk")["kind"], "local")   # kind 가 왕복해도 유지된다

    def test_local_bundled_plugin_fetch_says_why_instead_of_a_git_error(self):
        self.libcmd("market-add", "--url", self.local)
        rc, out, err = self.libcmd("plugin-fetch", "--marketplace", "localmk",
                                   "--plugin", "bundled")
        res = json.loads(out)
        self.assertFalse(res["ok"])
        self.assertIn("레포가 없어", res["message"])

    def test_unregistering_a_local_market_never_deletes_the_users_directory(self):
        """로컬 마켓의 캐시는 사용자 소유 디렉토리다. 해제가 캐시를 지우는 기존 규칙을
        그대로 적용하면 사용자의 원본을 지운다 - 지우는 건 스토어 안쪽뿐이어야 한다."""
        self.libcmd("market-add", "--url", self.local)
        rc, out, err = self.libcmd("unregister", "--origin", "market:localmk")
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["removed"])
        self.assertTrue(os.path.exists(os.path.join(self.local, ".claude-plugin",
                                                    "marketplace.json")))

    def test_json_url_registers_and_lands_in_the_catalog(self):
        rc, out, err = self.libcmd("market-add", "--url", self.base + "/mk/marketplace.json")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["kind"], "json")
        self.assertEqual(res["id"], "mk")          # generic 파일명이면 한 단계 위 세그먼트
        self.assertEqual(res["plugins"], 1)
        cat = json.loads(self.libcmd("catalog")[1])
        self.assertEqual([r["name"] for r in cat["rows"]], ["ext1"])

    def test_undeducible_id_asks_for_id_with_exit_zero_not_a_thrown_error(self):
        """호스트 루트의 marketplace.json 은 id 로 쓸 세그먼트가 없다(호스트는 콜론 때문에
        세그먼트가 못 된다). 이때 exit 1 로 끝내면 호출부(runPy)가 throw 해서 안내 문구가
        UI 에 닿지 못한다 - 평범한 입력이므로 JSON 으로 답해야 한다."""
        rc, out, err = self.libcmd("market-add", "--url", self.base + "/marketplace.json")
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertFalse(res["ok"])
        self.assertIn("--id", res["message"])
        # --id 를 주면 같은 주소가 그대로 등록된다.
        rc, out, err = self.libcmd("market-add", "--url", self.base + "/marketplace.json",
                                   "--id", "root")
        self.assertEqual(rc, 0, err)
        self.assertTrue(json.loads(out)["ok"], out)

    def test_json_market_survives_a_fetch_round_trip(self):
        self.libcmd("market-add", "--url", self.base + "/mk/marketplace.json")
        rc, out, err = self.libcmd("fetch", "--origin", "market:mk")
        res = json.loads(out)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["kind"], "json")
        self.assertEqual(self.rec("mk")["kind"], "json")

    def test_broken_json_url_is_refused_and_registers_nothing(self):
        rc, out, err = self.libcmd("market-add", "--url", self.base + "/mk/broken.json")
        res = json.loads(out)
        self.assertFalse(res["ok"])
        import lib_store
        self.assertEqual(lib_store.load_cfg(self.store).get("marketplaces", []), [])

    def test_unknown_source_form_is_refused_with_the_four_forms_named(self):
        rc, out, err = self.libcmd("market-add", "--url", "ext::sh -c evil")
        res = json.loads(out)
        self.assertFalse(res["ok"])
        self.assertIn("전송 헬퍼", res["message"])

    def test_existing_records_without_kind_are_treated_as_git(self):
        """하위호환: kind 필드가 없던 시절의 레코드도 그대로 동작해야 한다."""
        import lib_store
        cfg = lib_store.load_cfg(self.store)
        cfg["marketplaces"] = [{"id": "old", "url": "https://example.invalid/x.git",
                                "cache": self.local, "name": "old", "plugins": []}]
        lib_store.save_cfg(self.store, cfg)
        rc, out, err = self.libcmd("plugin-fetch", "--marketplace", "old", "--plugin", "bundled")
        res = json.loads(out)
        # kind 가 없으니 git 으로 보고 예전 경로를 탄다(= 여기서는 clone 실패). 새 가드에 걸리지 않는다.
        self.assertFalse(res["ok"])
        self.assertNotIn("레포가 없어", res["message"])
