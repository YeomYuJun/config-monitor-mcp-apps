#!/usr/bin/env python3
"""추적 의미론 회귀 테스트: EOL 보존 / EOL 불감 diff / 편집 후행 스냅샷 귀속 / watcher 폴링.

가드하는 결함 세 가지:
  - save_atomic 이 텍스트 모드로 써서 LF 파일 전체가 CRLF 로 뒤집히던 것(diff 전량 재작성 표기)
  - diff 가 EOL/BOM 차이를 내용 변경으로 세던 것
  - 스냅샷이 편집 '전'에만 찍혀 리비전 N 의 diff 가 N-1 편집을 보여주던 오프바이원 귀속
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
