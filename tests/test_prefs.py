#!/usr/bin/env python3
"""대시보드 표시 설정(store/config.json 의 "ui" 블록) 테스트.

핵심은 degrade 경로다: 스토어가 없을 때 저장했다고 거짓말하면 안 된다.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)
import prefs


class TestPrefs(unittest.TestCase):
    def test_defaults_when_store_missing(self):
        with tempfile.TemporaryDirectory() as d:
            ui = prefs.load_ui(d)
            self.assertEqual(ui["sections"]["preset"], "all")
            self.assertTrue(ui["sections"]["hideEmpty"])
            self.assertEqual(ui["sections"]["hidden"], [])

    def test_set_then_get_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
                json.dump({"version": 1}, f)
            prefs.save_ui(d, {"sections": {"preset": "custom", "hidden": ["themes"]}})
            ui = prefs.load_ui(d)
            self.assertEqual(ui["sections"]["preset"], "custom")
            self.assertEqual(ui["sections"]["hidden"], ["themes"])
            self.assertTrue(ui["sections"]["hideEmpty"], "패치하지 않은 키는 기본값이 유지되어야 함")

    def test_include_missing_projects_defaults_off_and_persists(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
                json.dump({"version": 1}, f)
            self.assertFalse(prefs.load_ui(d)["sections"]["includeMissingProjects"])
            prefs.save_ui(d, {"sections": {"includeMissingProjects": True}})
            self.assertTrue(prefs.load_ui(d)["sections"]["includeMissingProjects"])

    def test_view_block_round_trips_and_ignores_unknown_keys(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
                json.dump({"version": 1}, f)
            prefs.save_ui(d, {"view": {"selectedPath": "C:/x/settings.json", "detailOpen": False, "bogus": 1}})
            ui = prefs.load_ui(d)
            self.assertEqual(ui["view"]["selectedPath"], "C:/x/settings.json")
            self.assertFalse(ui["view"]["detailOpen"])
            self.assertEqual(ui["view"]["scope"], "all", "패치하지 않은 view 키는 기본값")
            self.assertNotIn("bogus", ui["view"])
            self.assertEqual(ui["sections"]["preset"], "all", "다른 블록은 건드리지 않는다")

    def test_save_preserves_unrelated_store_keys(self):
        """prefs 저장이 tracked/libraries 를 날리면 안 된다."""
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
                json.dump({"version": 1, "tracked": ["a"], "libraries": ["b"]}, f)
            prefs.save_ui(d, {"sections": {"preset": "all"}})
            with open(os.path.join(d, "config.json"), encoding="utf-8-sig") as f:
                cfg = json.load(f)
            self.assertEqual(cfg["tracked"], ["a"])
            self.assertEqual(cfg["libraries"], ["b"])

    def test_save_without_store_raises(self):
        """저장했다고 거짓말하지 않는다 - lib_store 도입부가 지적한 실패 양식."""
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(Exception):
                prefs.save_ui(d, {"sections": {"preset": "all"}})

    def test_cli_set_reports_ok_false_without_store(self):
        with tempfile.TemporaryDirectory() as d:
            p = subprocess.run([sys.executable, os.path.join(SRC, "prefs.py"), "set",
                                "--store", d, "--json", '{"sections":{"preset":"all"}}'],
                               capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(json.loads(p.stdout)["ok"], False)

    def test_cli_set_reports_lock_timeout_while_config_is_locked(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
                json.dump({"version": 1}, f)
            with open(os.path.join(d, "config.lock"), "w", encoding="utf-8") as f:
                f.write('{"pid": 1}')
            p = subprocess.run([sys.executable, os.path.join(SRC, "prefs.py"), "set",
                                "--store", d, "--json", '{"sections":{"preset":"custom"}}'],
                               capture_output=True, text=True, encoding="utf-8",
                               env=dict(os.environ, CLAUDE_CAS_LOCK_WAIT="0.3"))
            self.assertEqual((p.returncode, json.loads(p.stdout)["code"]), (1, "lock_timeout"))
            self.assertEqual(prefs.load_ui(d)["sections"]["preset"], "all")

    def test_cli_get_returns_defaults_without_store(self):
        with tempfile.TemporaryDirectory() as d:
            p = subprocess.run([sys.executable, os.path.join(SRC, "prefs.py"), "get",
                                "--store", d], capture_output=True, text=True, encoding="utf-8")
            out = json.loads(p.stdout)
            self.assertTrue(out["ok"])
            self.assertEqual(out["ui"]["sections"]["preset"], "all")

    def test_bom_json_is_readable(self):
        """윈도우에서 만들어진 config.json 에는 BOM 이 붙어 온다."""
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "config.json"), "w", encoding="utf-8-sig") as f:
                json.dump({"version": 1, "ui": {"sections": {"preset": "all"}}}, f)
            self.assertEqual(prefs.load_ui(d)["sections"]["preset"], "all")

    def test_legacy_present_preset_migrates_to_all(self):
        """0.1 은 preset 에 'present' 를 썼다. all + hideEmpty 와 같은 화면이므로 그리 옮긴다."""
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
                json.dump({"version": 1, "ui": {"sections": {"preset": "present"}}}, f)
            self.assertEqual(prefs.load_ui(d)["sections"]["preset"], "all")

    def test_unknown_preset_falls_back_to_all(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
                json.dump({"version": 1, "ui": {"sections": {"preset": "bogus"}}}, f)
            self.assertEqual(prefs.load_ui(d)["sections"]["preset"], "all")

    def test_preset_and_hide_empty_stay_independent(self):
        """한쪽이 다른 쪽을 써주면 preset 은 X 인데 화면은 Y 인 상태가 저장된다."""
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
                json.dump({"version": 1}, f)
            ui = prefs.save_ui(d, {"sections": {"preset": "common"}})
            self.assertTrue(ui["sections"]["hideEmpty"], "preset 변경이 hideEmpty 를 건드리면 안 된다")
            ui = prefs.save_ui(d, {"sections": {"hideEmpty": False}})
            self.assertEqual(ui["sections"]["preset"], "common", "hideEmpty 변경이 preset 을 건드리면 안 된다")

    def test_unknown_keys_are_ignored(self):
        """UI 가 보낸 오타/구버전 키가 저장소를 오염시키지 않게."""
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
                json.dump({"version": 1}, f)
            ui = prefs.save_ui(d, {"sections": {"bogus": 1, "preset": "common"}})
            self.assertNotIn("bogus", ui["sections"])
            self.assertEqual(ui["sections"]["preset"], "common")


if __name__ == "__main__":
    unittest.main()
