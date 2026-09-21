#!/usr/bin/env python3
"""스냅샷 저장소(cas)와 watcher 회귀 테스트.

  - 쓰기: save_atomic 의 EOL 보존, 중단된 객체 쓰기가 blob 을 남기지 않음, 락 소유 확인 후 해제
  - diff: EOL/BOM 차이 무시, 무시 키 프로필과 이력 접기, 추적 목록 밖 경로 거부
  - 스냅샷: 편집 후행 귀속(리비전 N 의 diff 가 N 의 편집을 보여줌), 구간 락, CLI 위임, gc
  - watcher: tick, 상태 JSON, 손상된 watcher.json·읽기 실패·tick 예외에도 멈추지 않음
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
sys.path.insert(0, SRC)

# 기본 추적 대상(실사용자 파일)이 테스트 스토어에 합류하지 않게 - import 전 설정.
os.environ["CLAUDE_CAS_NO_DEFAULT_TRACK"] = "1"
# 락 경합 테스트가 기본 8초 대기를 하지 않게 - cas 가 import 시점에 읽는다.
os.environ["CLAUDE_CAS_LOCK_WAIT"] = "0.2"

import cas
import config_edit
import watcher

CAS = os.path.join(SRC, "cas.py")
EDIT = os.path.join(SRC, "config_edit.py")


def run(script, *args):
    env = dict(os.environ, CLAUDE_CAS_NO_DEFAULT_TRACK="1", PYTHONUTF8="1")
    p = subprocess.run([sys.executable, script, *args], capture_output=True, text=True,
                       encoding="utf-8", env=env)
    return p.stdout


class TestSaveAtomicEol(unittest.TestCase):
    """save_atomic 은 기존 파일의 개행 방식을 따라야 한다(새 파일은 LF)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "settings.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_lf_file_stays_lf(self):
        with open(self.path, "wb") as f:
            f.write(b'{\n  "a": 1\n}')
        config_edit.save_atomic(self.path, {"a": 1, "b": 2})
        data = open(self.path, "rb").read()
        self.assertNotIn(b"\r\n", data)
        self.assertIn(b"\n", data)

    def test_crlf_file_stays_crlf(self):
        with open(self.path, "wb") as f:
            f.write(b'{\r\n  "a": 1\r\n}')
        config_edit.save_atomic(self.path, {"a": 1, "b": 2})
        data = open(self.path, "rb").read()
        self.assertEqual(data.count(b"\n"), data.count(b"\r\n"))
        self.assertIn(b"\r\n", data)

    def test_new_file_is_lf(self):
        config_edit.save_atomic(self.path, {"a": 1})
        self.assertNotIn(b"\r\n", open(self.path, "rb").read())


class CasStoreCase(unittest.TestCase):
    """임시 스토어 + 추적 파일 1개를 준비하는 공통 베이스."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = os.path.join(self.tmp.name, "store")
        self.work = os.path.join(self.tmp.name, "proj", ".claude")
        os.makedirs(self.work)
        self.file = os.path.join(self.work, "settings.json")
        self.write_lf('{\n  "keep": true\n}')
        run(CAS, "--store", self.store, "init")
        run(CAS, "--store", self.store, "track", self.file)

    def tearDown(self):
        self.tmp.cleanup()

    def write_lf(self, text):
        with open(self.file, "wb") as f:
            f.write(text.encode("utf-8"))

    def snapshot(self, msg):
        run(CAS, "--store", self.store, "snapshot", "-m", msg)

    def history(self):
        out = run(CAS, "--store", self.store, "history", self.file, "--json")
        return json.loads(out)["revisions"]

    def diff(self):
        return run(CAS, "--store", self.store, "diff", self.file)


class TestDiffEolInsensitive(CasStoreCase):
    def test_eol_only_change_reports_no_content_diff(self):
        self.snapshot("base")
        self.write_lf('{\r\n  "keep": true\r\n}')
        self.assertIn("줄 내용 동일", self.diff())

    def test_empty_ref_shows_first_revision_as_full_addition(self):
        # UI 의 '직전 리비전 (기본)' 비교에서 첫 리비전은 empty 와 비교된다.
        self.snapshot("base")
        rev = self.history()[0]["snapshot"]
        d = run(CAS, "--store", self.store, "diff", self.file, "--from", "empty", "--to", rev)
        self.assertIn('+  "keep": true', d)
        self.assertNotIn("\n-", d)   # 삭제 줄이 없어야 전체 추가다

    def test_real_change_shows_only_changed_lines(self):
        self.snapshot("base")
        # EOL 도 뒤집고 값도 바꾼다 - 바뀐 줄만 diff 에 나와야 한다.
        with open(self.file, "wb") as f:
            f.write(b'{\r\n  "keep": false\r\n}')
        d = self.diff()
        self.assertIn('-  "keep": true', d)
        self.assertIn('+  "keep": false', d)
        self.assertNotIn("-{", d)  # 여는 중괄호 줄까지 지워지면 전량 재작성 표기다


class TestEditSnapshotAttribution(CasStoreCase):
    """편집 후행 스냅샷: 리비전 메시지가 그 리비전의 diff 내용과 같은 편집을 가리켜야 한다."""

    def edit(self, rule):
        return json.loads(run(EDIT, "--store", self.store, "--settings", self.file,
                              "perm-add", "allow", rule))

    def test_op_message_lands_on_its_own_revision(self):
        self.assertTrue(self.edit("Bash(one*)")["ok"])
        revs = self.history()
        self.assertTrue(revs and "permissions.allow" in revs[-1]["message"])

    def test_consecutive_edits_skip_pre_snapshot(self):
        self.snapshot("base")               # 추적 직후 상태를 먼저 확정(이후 드리프트 없음)
        self.edit("Bash(one*)")
        self.edit("Bash(two*)")
        msgs = [r["message"] for r in self.history()]
        # 연속 편집 사이에는 드리프트가 없으므로 pre-스냅샷이 발화하면 안 된다.
        self.assertNotIn("external change (before edit)", msgs)
        self.assertIn("추가됨: permissions.allow += 'Bash(one*)'", msgs)
        self.assertIn("추가됨: permissions.allow += 'Bash(two*)'", msgs)

    def test_external_drift_is_captured_before_edit(self):
        self.snapshot("base")
        self.edit("Bash(one*)")
        # 대시보드 밖 편집(드리프트) 후 다음 편집 - pre-스냅샷이 드리프트를 제 이름으로 잡아야 한다.
        self.write_lf('{\n  "hand": "edit"\n}')
        self.edit("Bash(two*)")
        msgs = [r["message"] for r in self.history()]
        self.assertIn("external change (before edit)", msgs)


class TestSnapshotSpanLock(CasStoreCase):
    """snapshot_before~snapshot_after 가 락을 걸쳐 쥐어, 그 사이 watcher tick 이
    편집 결과를 'auto:' 메시지로 가로채지 못해야 한다(op 메시지 소실 방지)."""

    def test_span_blocks_watcher_and_records_op_message(self):
        self.snapshot("base")
        p = cas.store_paths(self.store)
        lock = os.path.join(self.store, "snapshot.lock")
        self.write_lf('{\n  "keep": "drift"\n}')            # 대시보드 밖 편집
        config_edit.snapshot_before(self.store)
        try:
            self.assertTrue(os.path.exists(lock))            # 스팬 동안 락 유지
            self.write_lf('{\n  "keep": "op-result"\n}')     # 편집 본문에 해당
            self.assertIsNone(watcher.tick(p))               # 락에 막혀 못 가로챔
        finally:
            config_edit.snapshot_after(self.store, "op done")
        self.assertFalse(os.path.exists(lock))
        msgs = [r["message"] for r in self.history()]
        self.assertIn("external change (before edit)", msgs)
        self.assertEqual("op done", msgs[-1])


class TestGc(CasStoreCase):
    """gc: 기한 지난 매니페스트 삭제 + 미참조 객체 sweep. 최신 스냅샷과 index 참조는 보존."""

    def _snap_files(self):
        d = os.path.join(self.store, "snapshots")
        return sorted(n for n in os.listdir(d) if n.endswith(".json"))

    def _obj_count(self):
        d = os.path.join(self.store, "objects")
        return sum(len(ns) for _r, _d, ns in os.walk(d)) if os.path.isdir(d) else 0

    def _age(self, name):
        f = os.path.join(self.store, "snapshots", name)
        m = json.load(open(f, encoding="utf-8"))
        m["time"] = "2020-01-01T00:00:00"
        with open(f, "w", encoding="utf-8") as fh:
            json.dump(m, fh)

    def test_gc_drops_old_keeps_latest_and_current_objects(self):
        self.snapshot("old")
        self.write_lf('{\n  "keep": 2\n}')
        self.snapshot("new")
        self._age(self._snap_files()[0])
        objs_before = self._obj_count()
        out = json.loads(run(CAS, "--store", self.store, "gc", "--json",
                             "--keep-days", "30", "--dry-run"))
        self.assertEqual(out["removed_snapshots"], 1)
        self.assertEqual(len(self._snap_files()), 2)          # dry-run 은 지우지 않는다
        out = json.loads(run(CAS, "--store", self.store, "gc", "--json", "--keep-days", "30"))
        self.assertEqual(out["removed_snapshots"], 1)
        self.assertEqual(len(self._snap_files()), 1)
        self.assertEqual(self._obj_count(), objs_before - 1)  # old 전용 blob 만 sweep
        # 남은 리비전은 여전히 복원 가능해야 한다
        rev = self.history()[-1]["snapshot"]
        r = json.loads(run(CAS, "--store", self.store, "restore", self.file, "--from", rev))
        self.assertTrue(r["ok"], r)

    def test_gc_never_drops_the_newest_manifest(self):
        self.snapshot("only")
        self._age(self._snap_files()[0])
        out = json.loads(run(CAS, "--store", self.store, "gc", "--json", "--keep-days", "30"))
        self.assertEqual(out["removed_snapshots"], 0)
        self.assertEqual(len(self._snap_files()), 1)


class TestCliDelegationSnapshots(CasStoreCase):
    """plugin_cli 위임이 전/후 스냅샷으로 이력 공백을 막는지. 가짜 claude 가 추적 파일을
    실제로 고쳐, 후행 스냅샷이 위임 결과를 제 메시지로 잡는 것까지 본다."""

    @unittest.skipUnless(os.name == "nt", "가짜 claude.bat 는 Windows 전용")
    def test_delegation_wraps_run_with_snapshots(self):
        fake = os.path.join(self.tmp.name, "bin")
        os.makedirs(fake)
        with open(os.path.join(fake, "claude.bat"), "w", encoding="ascii") as f:
            f.write('@echo delegated>>"%CM_TEST_FILE%"\r\n@exit /b 0\r\n')
        env = dict(os.environ, CLAUDE_CAS_NO_DEFAULT_TRACK="1", PYTHONUTF8="1",
                   CM_TEST_FILE=self.file,
                   PATH=fake + os.pathsep + os.environ.get("PATH", ""))
        p = subprocess.run([sys.executable, os.path.join(SRC, "plugin_cli.py"), "install",
                            "--marketplace", "m", "--plugin", "p", "--store", self.store],
                           capture_output=True, text=True, encoding="utf-8", env=env)
        r = json.loads(p.stdout)
        self.assertTrue(r["ok"], r)
        msgs = [x["message"] for x in self.history()]
        self.assertIn("external change (before edit)", msgs)   # 위임 전 미스냅샷 상태 캡처
        self.assertEqual("설치됨: p@m (claude CLI)", msgs[-1])  # 위임 결과가 제 메시지로


class TestWatcherTick(CasStoreCase):
    def test_tick_snapshots_changes_and_idles_when_clean(self):
        p = cas.store_paths(self.store)
        first = watcher.tick(p)          # 추적 직후: 신규 파일 = 변경
        self.assertTrue(first and first.startswith("auto:"))
        self.assertIsNone(watcher.tick(p))
        self.write_lf('{\n  "keep": false\n}')
        again = watcher.tick(p)
        self.assertTrue(again and "settings.json" in again)

    def test_status_json_carries_watcher_and_last_snapshot(self):
        out = json.loads(run(CAS, "--store", self.store, "status", "--json"))
        self.assertIn("watcher", out)
        self.assertFalse(out["watcher"]["running"])
        self.assertIn("last_snapshot", out)
        p = cas.store_paths(self.store)
        watcher.write_state(p, 2000, "2026-01-01T00:00:00", "")
        self.assertTrue(cas._watcher_state(self.store)["running"])

    def test_corrupt_watcher_json_does_not_kill_status(self):
        with open(os.path.join(self.store, "watcher.json"), "w", encoding="utf-8") as f:
            f.write("{broken")
        st = cas._watcher_state(self.store)
        self.assertFalse(st["running"])
        self.assertIn("판독 실패", st["reason"])

    def test_scan_keeps_previous_entry_when_file_is_unreadable(self):
        p = cas.store_paths(self.store)
        watcher.tick(p)
        config = cas.load_config(p)
        index = cas.load_json(p["index"], {})
        key = next(iter(index))
        self.write_lf('{\n  "keep": "size changed"\n}')
        with mock.patch("cas.open", side_effect=PermissionError("locked"), create=True):
            result, new_index = cas.scan(p, config, index, rehash=False)
        self.assertIn(key, result["unchanged"])
        self.assertEqual(new_index[key], index[key])

    def test_safe_tick_reports_exception_instead_of_raising(self):
        p = cas.store_paths(self.store)
        with mock.patch.object(watcher, "tick", side_effect=PermissionError("locked")):
            msg, err = watcher.safe_tick(p)
        self.assertIsNone(msg)
        self.assertIn("PermissionError", err)


class TestIgnoreProfile(CasStoreCase):
    """무시 키 프로필: 기계 상태 키만 바뀐 저장은 리비전이 되지 않고 기본 diff 본문에서 빠진다.
    blob 은 원문이라 --raw 와 복원에는 그대로 남는다. settings.json 의 기본 규칙은 feedbackDrafts."""

    def set_ignore(self, rules):
        cfg = os.path.join(self.store, "config.json")
        with open(cfg, encoding="utf-8") as f:
            c = json.load(f)
        c["ignore_keys"] = {"settings.json": rules}
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump(c, f)

    def modified(self):
        return json.loads(run(CAS, "--store", self.store, "status", "--json"))["modified"]

    def diff_revs(self, a, b, *extra):
        return run(CAS, "--store", self.store, "diff", self.file, "--from", a, "--to", b, *extra)

    def test_ignored_only_change_is_not_a_revision(self):
        self.snapshot("base")
        self.write_lf('{\n  "keep": true,\n  "feedbackDrafts": {"x": 1}\n}')
        self.assertEqual(self.modified(), [])
        self.assertIsNone(watcher.tick(cas.store_paths(self.store)))
        config_edit.snapshot_before(self.store)            # 편집 전 드리프트 캡처도 같은 판정을 탄다
        config_edit.snapshot_after(self.store, "op")
        self.assertEqual(len(self.history()), 1)
        self.assertIn("무시 목록 항목만 다름: feedbackDrafts", self.diff())
        self.assertIn("feedbackDrafts", run(CAS, "--store", self.store, "diff", self.file, "--raw"))

    def test_mixed_change_shows_significant_keys_and_notes_the_rest(self):
        self.snapshot("base")
        self.write_lf('{\n  "keep": false,\n  "feedbackDrafts": {"x": 1}\n}')
        self.snapshot("edit")
        r0, r1 = [r["snapshot"] for r in self.history()]
        body, _, note = self.diff_revs(r0, r1).partition("\n# ")
        self.assertIn('-  "keep": true', body)
        self.assertIn('+  "keep": false', body)
        self.assertNotIn("feedbackDrafts", body)
        self.assertIn("무시 목록 항목도 바뀜: feedbackDrafts", note)
        self.assertIn("feedbackDrafts", self.diff_revs(r0, r1, "--raw"))

    def test_config_rules_wildcard_subtree_and_keep_exceptions(self):
        self.set_ignore(["!feedbackDrafts", "hooks", "!hooks.b", "meta.*.ts"])
        base = ('{\n  "keep": true,\n  "hooks": {"a": {"ts": 1}, "b": {"ts": 2}},\n'
                '  "meta": {"x": {"ts": 1}},\n  "feedbackDrafts": 1\n}')
        self.write_lf(base)
        self.snapshot("base")
        self.write_lf(base.replace('"a": {"ts": 1}', '"a": {"ts": 9}').replace('"x": {"ts": 1}', '"x": {"ts": 9}'))
        self.assertEqual(self.modified(), [])                 # hooks 하위와 meta.*.ts 는 무시
        self.write_lf(base.replace('"b": {"ts": 2}', '"b": {"ts": 8}'))
        self.assertEqual(self.modified(), [self.file])        # !hooks.b 는 무시 규칙 안의 예외
        self.write_lf(base.replace('"feedbackDrafts": 1', '"feedbackDrafts": 2'))
        self.assertEqual(self.modified(), [self.file])        # 기본 규칙을 껐으니 보인다

    def test_unparsable_content_falls_back_to_raw_hash(self):
        self.snapshot("base")
        self.write_lf('{ broken')
        self.assertEqual(self.modified(), [self.file])
        self.snapshot("broken")
        r0, r1 = [r["snapshot"] for r in self.history()]
        self.assertIn("@@", self.diff_revs(r0, r1))

    def test_history_folds_revisions_that_differ_only_in_ignored_keys(self):
        self.set_ignore(["!feedbackDrafts"])               # 프로필 없이 잡음 리비전을 쌓는다
        for i in range(3):
            self.write_lf('{\n  "keep": true,\n  "feedbackDrafts": %d\n}' % i)
            self.snapshot(f"noise {i}")
        self.assertEqual(len(self.history()), 3)
        self.set_ignore([])
        self.assertEqual(len(self.history()), 1)
        cache = os.path.join(self.store, "sig-cache.json")
        self.assertTrue(os.path.exists(cache))
        os.remove(cache)
        p = cas.store_paths(self.store)
        config = cas.load_config(p)
        self.assertEqual(cas.warm_sig_cache(p, config, budget=1), 2)
        self.assertEqual(cas.warm_sig_cache(p, config, budget=8), 0)
        self.assertEqual(cas.warm_sig_cache(p, config, budget=8), 0)   # warmed: 매니페스트를 다시 돌지 않는다

    def test_default_valued_project_entries_are_ignored(self):
        f = os.path.join(self.work, ".claude.json")        # 이름으로 기본 프로필을 탄다

        def write(s):
            with open(f, "wb") as fh:
                fh.write(s.encode("utf-8"))
        write('{"projects": {}}')
        run(CAS, "--store", self.store, "track", f)
        self.snapshot("base")
        write('{"projects": {"/a": {"allowedTools": [], "hasTrustDialogAccepted": false}}}')
        self.assertEqual(self.modified(), [])
        write('{"projects": {"/a": {"allowedTools": [], "hasTrustDialogAccepted": true}}}')
        self.assertEqual(self.modified(), [f])
        self.snapshot("trust")
        revs = json.loads(run(CAS, "--store", self.store, "history", f, "--json"))["revisions"]
        d = run(CAS, "--store", self.store, "diff", f, "--from", revs[0]["snapshot"], "--to", revs[1]["snapshot"])
        self.assertIn('+      "hasTrustDialogAccepted": true', d)
        self.assertNotIn("# 무시 목록", d)                    # 빈 항목이 한쪽에서만 빠진 것은 숨긴 변경이 아니다


class TestStoreWrites(CasStoreCase):
    def test_interrupted_object_write_leaves_no_blob(self):
        p = cas.store_paths(self.store)
        with mock.patch("cas.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                cas.write_object(p, b"partial-content")
        self.assertFalse(os.path.exists(cas.object_path(p, cas.hash_bytes(b"partial-content"))))

    def test_release_keeps_a_lock_taken_over_by_another_holder(self):
        p = cas.store_paths(self.store)
        lock = os.path.join(self.store, "snapshot.lock")
        with cas._snapshot_lock(p):
            with open(lock, "w", encoding="utf-8") as f:
                json.dump({"pid": 0, "token": "other-holder"}, f)
        self.assertTrue(os.path.exists(lock))
        os.unlink(lock)

    def test_release_removes_own_lock(self):
        p = cas.store_paths(self.store)
        with cas._snapshot_lock(p):
            pass
        self.assertFalse(os.path.exists(os.path.join(self.store, "snapshot.lock")))


class TestDiffGuard(CasStoreCase):
    def test_untracked_path_is_refused(self):
        self.snapshot("s1")
        other = os.path.join(self.tmp.name, "secret.txt")
        with open(other, "w", encoding="utf-8") as f:
            f.write("secret-value")
        out = run(CAS, "--store", self.store, "diff", other)
        self.assertNotIn("secret-value", out)
        self.assertFalse(json.loads(out)["ok"])

    def test_untracked_file_with_snapshot_history_still_diffs(self):
        self.snapshot("s1")
        sid = cas._snapshot_ids(cas.store_paths(self.store))[-1]
        run(CAS, "--store", self.store, "untrack", self.file)
        self.write_lf('{\n  "keep": false\n}')
        out = run(CAS, "--store", self.store, "diff", "--from", sid, self.file)
        self.assertIn('+  "keep": false', out)


if __name__ == "__main__":
    unittest.main()
