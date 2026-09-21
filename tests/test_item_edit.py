#!/usr/bin/env python3
"""단일 파일 항목(rules / output-styles / workflows) 편집 op + output style 활성화 테스트.

조회만 되던 새 섹션에 편집을 붙이면서, 경로 가드가 도구 파라미터로 뚫리지 않는지가 핵심이다.
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
import claude_config as cc

EDIT = os.path.join(SRC, "config_edit.py")


def run(*args, cwd=None):
    p = subprocess.run([sys.executable, EDIT, *args], capture_output=True, text=True,
                       encoding="utf-8", cwd=cwd)
    return json.loads(p.stdout)


class ItemEditCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.cdir = os.path.join(self.root, ".claude")
        os.makedirs(self.cdir)
        self.settings = os.path.join(self.cdir, "settings.json")
        with open(self.settings, "w", encoding="utf-8") as f:
            f.write("{}")

    def tearDown(self):
        self.tmp.cleanup()

    def items(self, sub):
        return os.path.join(self.cdir, sub)

    def scaffold(self, kind, sub, name, *extra):
        return run("--settings", self.settings, "--items-dir", self.items(sub),
                   "--no-snapshot", "item-scaffold", kind, name, *extra)


class TestItemScaffold(ItemEditCase):
    def test_rule_paths_flag_round_trips_to_lazy_badge(self):
        """스캐폴드가 만든 paths: 를 스캐너가 LAZY 로 읽어야 한 바퀴가 닫힌다."""
        self.assertTrue(self.scaffold("rule", "rules", "eager-one")["ok"])
        self.assertTrue(self.scaffold("rule", "rules", "lazy-one", "--paths", "tests/**")["ok"])
        by = {c["name"]: c for c in cc._rules_cards(self.items("rules"))}
        self.assertEqual(by["eager-one"]["load"], "eager")
        self.assertEqual(by["lazy-one"]["load"], "lazy")

    def test_workflow_stub_carries_a_meta_block(self):
        """meta 블록이 없는 workflow 는 실행되지 않는다 - 스텁이 그 형태를 지켜야 한다."""
        self.assertTrue(self.scaffold("workflow", "workflows", "ship")["ok"])
        body = open(os.path.join(self.items("workflows"), "ship.js"), encoding="utf-8").read()
        self.assertIn("export const meta", body)
        self.assertIn("name: 'ship'", body)

    def test_duplicate_scaffold_is_refused(self):
        self.assertTrue(self.scaffold("rule", "rules", "dup")["ok"])
        r = self.scaffold("rule", "rules", "dup")
        self.assertEqual((r["ok"], r["code"]), (False, "exists"))

    def test_remove_moves_to_trash_not_delete(self):
        self.scaffold("output-style", "output-styles", "terse")
        r = run("--settings", self.settings, "--items-dir", self.items("output-styles"),
                "--no-snapshot", "item-remove", "output-style", "terse")
        self.assertTrue(r["ok"])
        self.assertFalse(os.path.exists(os.path.join(self.items("output-styles"), "terse.md")))
        self.assertTrue(os.path.exists(r["trashed"]), "복구 가능해야 한다")

    def test_remove_missing_item_reports_failure(self):
        r = run("--settings", self.settings, "--items-dir", self.items("rules"),
                "--no-snapshot", "item-remove", "rule", "nope")
        self.assertFalse(r["ok"])


class TestGuards(ItemEditCase):
    def test_items_dir_outside_claude_is_refused(self):
        """도구 파라미터로 임의 경로가 들어와도 trash() 까지 도달하면 안 된다."""
        r = run("--settings", self.settings, "--items-dir", self.root,
                "--no-snapshot", "item-scaffold", "rule", "x")
        self.assertFalse(r["ok"])

    def test_items_dir_with_wrong_subdir_is_refused(self):
        r = run("--settings", self.settings, "--items-dir", os.path.join(self.cdir, "skills"),
                "--no-snapshot", "item-scaffold", "rule", "x")
        self.assertFalse(r["ok"])

    def test_name_cannot_escape_the_directory(self):
        for bad in ("../evil", "a/b", ".."):
            r = self.scaffold("rule", "rules", bad)
            self.assertFalse(r["ok"], f"{bad} 가 통과했다")

    def test_memory_remove_requires_a_projects_memory_dir(self):
        r = run("--settings", self.settings, "--memory-dir", self.cdir,
                "--no-snapshot", "memory-remove", "x")
        self.assertFalse(r["ok"])


class TestMemoryRemove(ItemEditCase):
    def test_memory_file_moves_to_trash(self):
        mdir = os.path.join(self.root, "projects", "d--proj", "memory")
        os.makedirs(mdir)
        with open(os.path.join(mdir, "stale.md"), "w", encoding="utf-8") as f:
            f.write("---\ndescription: 낡음\n---\n")
        r = run("--settings", self.settings, "--memory-dir", mdir,
                "--no-snapshot", "memory-remove", "stale")
        self.assertTrue(r["ok"], r.get("message"))
        self.assertFalse(os.path.exists(os.path.join(mdir, "stale.md")))
        self.assertTrue(os.path.exists(r["trashed"]))


class TestOutputStyleSet(ItemEditCase):
    def _style(self):
        return json.load(open(self.settings, encoding="utf-8-sig")).get("outputStyle")

    def test_set_then_clear(self):
        self.assertTrue(run("--settings", self.settings, "--no-snapshot",
                            "outputstyle-set", "terse")["ok"])
        self.assertEqual(self._style(), "terse")
        self.assertTrue(run("--settings", self.settings, "--no-snapshot",
                            "outputstyle-set", "")["ok"])
        self.assertIsNone(self._style())

    def test_activation_moves_the_eager_badge(self):
        """활성화가 실제로 '무엇이 EAGER 인가'를 바꿔야 한다 - 이 버튼의 존재 이유다."""
        osd = self.items("output-styles")
        self.scaffold("output-style", "output-styles", "terse")
        self.scaffold("output-style", "output-styles", "verbose")
        def loads():
            # '＋ 새 …' 스캐폴드 카드는 항목이 아니라 적재 등급이 없다.
            return {c["name"]: c["load"] for c in
                    cc._output_style_cards(osd, cc._active_output_style([self.settings]))
                    if c.get("badge") != "add"}

        self.assertEqual(set(loads().values()), {"never"}, "선택 전에는 아무것도 EAGER 가 아니다")
        run("--settings", self.settings, "--no-snapshot", "outputstyle-set", "terse")
        after = loads()
        self.assertEqual(after["terse"], "eager")
        self.assertEqual(after["verbose"], "never")

    def test_settings_keys_are_preserved(self):
        with open(self.settings, "w", encoding="utf-8") as f:
            json.dump({"model": "opus", "permissions": {"allow": ["Bash"]}}, f)
        run("--settings", self.settings, "--no-snapshot", "outputstyle-set", "terse")
        d = json.load(open(self.settings, encoding="utf-8-sig"))
        self.assertEqual(d["model"], "opus")
        self.assertEqual(d["permissions"]["allow"], ["Bash"])


if __name__ == "__main__":
    unittest.main()
