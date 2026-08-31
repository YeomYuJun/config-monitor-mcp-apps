#!/usr/bin/env python3
"""섹션 레지스트리와 설정 표면 스캐너 테스트.

레지스트리가 id·그룹·적재등급의 유일한 원천이라, 여기서 깨지면 저장된 표시 설정이
엉뚱한 섹션에 붙는다.
"""
import json
import os
import sys
import tempfile
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)
import claude_config as cc


class TestRegistry(unittest.TestCase):
    def test_ids_unique_and_groups_known(self):
        group_ids = {g for g, _ in cc.GROUPS}
        seen = set()
        for sid, sec in cc.SECTIONS.items():
            self.assertEqual(sid, sec.id, f"{sid} 의 키와 id 가 다름")
            self.assertNotIn(sec.id, seen)
            seen.add(sec.id)
            self.assertIn(sec.group, group_ids, f"{sid} 의 그룹 {sec.group} 이 GROUPS 에 없음")
            self.assertIn(sec.load, (None, "eager", "lazy", "never"))

    def test_every_section_carries_id_and_group(self):
        state = cc.parse(cc.discover())
        for sec in state["sections"]:
            self.assertIn("id", sec, f"{sec['title']} 에 id 가 없음")
            self.assertIn(sec["id"], cc.SECTIONS)
            self.assertIn("group", sec)

    def test_titles_unchanged(self):
        """기존 스모크 테스트가 제목 접두사로 섹션을 고른다 - 제목이 바뀌면 안 된다."""
        titles = [s["title"].split(" · ")[0] for s in cc.parse(cc.discover())["sections"]]
        for expected in ("Permissions", "Hooks", "Skills (code)", "Agents",
                         "Commands", "Plugins", "Scheduled Tasks", "Desktop Skills"):
            self.assertIn(expected, titles)


class TestBuilders(unittest.TestCase):
    def test_md_dir_reads_frontmatter_and_nests(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "sub"))
            with open(os.path.join(d, "a.md"), "w", encoding="utf-8") as f:
                f.write("---\ndescription: 첫째\n---\n본문\n")
            with open(os.path.join(d, "sub", "b.md"), "w", encoding="utf-8") as f:
                f.write("no frontmatter\n")
            cards = cc._md_dir_cards(d, "rule")
            self.assertEqual(sorted(c["name"] for c in cards), ["a", "sub/b"])

    def test_md_dir_load_callback_decides_per_card(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "eager.md"), "w", encoding="utf-8") as f:
                f.write("---\ndescription: x\n---\n")
            with open(os.path.join(d, "lazy.md"), "w", encoding="utf-8") as f:
                f.write("---\npaths:\n  - src/**\n---\n")
            cards = {c["name"]: c for c in cc._md_dir_cards(
                d, "rule", load_of=lambda rel, p, meta: "lazy" if "paths" in meta else "eager")}
            self.assertEqual(cards["eager"]["load"], "eager")
            self.assertEqual(cards["lazy"]["load"], "lazy")

    def test_glob_cards_and_file_card_skip_missing(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "one.json"), "w").close()
            self.assertEqual(len(cc._glob_cards(d, "*.json", "theme")), 1)
            self.assertEqual(cc._file_card(os.path.join(d, "nope.json"), "kb"), [])
            self.assertEqual(len(cc._file_card(os.path.join(d, "one.json"), "kb")), 1)

    def test_builders_tolerate_missing_directories(self):
        self.assertEqual(cc._md_dir_cards(os.path.join("nope", "gone"), "rule"), [])
        self.assertEqual(cc._glob_cards(None, "*.js", "workflow"), [])


class TestInstructionSurfaces(unittest.TestCase):
    def test_rules_load_class_splits_on_paths_frontmatter(self):
        with tempfile.TemporaryDirectory() as rd:
            with open(os.path.join(rd, "style.md"), "w", encoding="utf-8") as f:
                f.write("---\ndescription: 전역 규칙\n---\n")
            with open(os.path.join(rd, "testing.md"), "w", encoding="utf-8") as f:
                f.write("---\npaths:\n  - tests/**\n---\n")
            by = {c["name"]: c for c in cc._rules_cards(rd)}
            self.assertEqual(by["style"]["load"], "eager")
            self.assertEqual(by["testing"]["load"], "lazy")

    def test_output_style_only_selected_is_eager(self):
        with tempfile.TemporaryDirectory() as d:
            for n in ("terse", "verbose"):
                with open(os.path.join(d, n + ".md"), "w", encoding="utf-8") as f:
                    f.write("---\ndescription: x\n---\n")
            by = {c["name"]: c for c in cc._output_style_cards(d, active="terse")}
            self.assertEqual(by["terse"]["load"], "eager")
            self.assertEqual(by["verbose"]["load"], "never")

    def test_output_style_with_no_selection_is_all_never(self):
        """실측: 이 머신의 settings.json 에는 outputStyle 키가 없다. 정상 상태여야 한다."""
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "terse.md"), "w", encoding="utf-8") as f:
                f.write("---\ndescription: x\n---\n")
            self.assertEqual(cc._output_style_cards(d, active=None)[0]["load"], "never")

    def test_active_output_style_lets_local_settings_win(self):
        with tempfile.TemporaryDirectory() as d:
            base = os.path.join(d, "settings.json")
            local = os.path.join(d, "settings.local.json")
            with open(base, "w", encoding="utf-8") as f:
                f.write('{"outputStyle": "terse"}')
            with open(local, "w", encoding="utf-8") as f:
                f.write('{"outputStyle": "verbose"}')
            self.assertEqual(cc._active_output_style([base, local]), "verbose")
            self.assertIsNone(cc._active_output_style([]))

    def test_claude_md_cards_cover_all_three_locations(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, ".claude"))
            for rel in ("CLAUDE.md", "CLAUDE.local.md", os.path.join(".claude", "CLAUDE.md")):
                with open(os.path.join(root, rel), "w", encoding="utf-8") as f:
                    f.write("# hi\n")
            cards = cc._claude_md_cards(root, "project", root)
            self.assertEqual(len(cards), 3)
            self.assertTrue(all(c["load"] == "eager" for c in cards))


class TestProjectOutputStyleInheritsGlobal(unittest.TestCase):
    """프로젝트는 전역 settings 를 상속한다. 전역에만 outputStyle 이 있으면 그 프로젝트
    세션도 그 스타일로 도는데, 프로젝트 카드가 전부 NEVER 로 뜨면 배지가 거짓말을 한다."""

    def _build(self, global_style, project_style):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        gdir = os.path.join(self.tmp.name, "home", ".claude")
        pdir = os.path.join(self.tmp.name, "proj", ".claude")
        os.makedirs(os.path.join(pdir, "output-styles"))
        os.makedirs(gdir)
        for name in ("terse", "verbose"):
            with open(os.path.join(pdir, "output-styles", name + ".md"), "w", encoding="utf-8") as f:
                f.write("---\ndescription: x\n---\n")
        gset = os.path.join(gdir, "settings.json")
        with open(gset, "w", encoding="utf-8") as f:
            json.dump({"outputStyle": global_style} if global_style else {}, f)
        with open(os.path.join(pdir, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"outputStyle": project_style} if project_style else {}, f)
        state = cc.parse(cc.discover([f"code_settings={gset}"]), [pdir])
        sec = next(s for s in state["sections"] if s["id"] == "output-styles")
        return {c["name"]: c for c in sec["cards"]
                if c.get("scope") == "project" and c.get("badge") != "add"}

    def test_global_style_marks_the_project_card_eager(self):
        by = self._build("terse", None)
        self.assertEqual(by["terse"]["load"], "eager",
                         "전역에서 켠 스타일이 프로젝트 카드에서 NEVER 로 보이면 안 된다")
        self.assertEqual(by["verbose"]["load"], "never")

    def test_project_setting_overrides_global(self):
        by = self._build("terse", "verbose")
        self.assertEqual(by["verbose"]["load"], "eager")
        self.assertEqual(by["terse"]["load"], "never")

    def test_no_style_anywhere_leaves_all_never(self):
        by = self._build(None, None)
        self.assertEqual({c["load"] for c in by.values()}, {"never"})


class TestEnvSurfaces(unittest.TestCase):
    def test_workflows_and_themes_are_globbed(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "ship.js"), "w").close()
            open(os.path.join(d, "notes.txt"), "w").close()
            self.assertEqual([c["name"] for c in cc._glob_cards(d, "*.js", "workflow")], ["ship"])

    def test_missing_surfaces_yield_empty_sections_not_errors(self):
        """실측: 이 머신에 rules/themes/workflows 가 아예 없다. 없는 게 정상이어야 한다."""
        by_id = {s["id"]: s for s in cc.parse(cc.discover())["sections"]}
        for sid in ("workflows", "keybindings", "themes"):
            self.assertIn(sid, by_id)
            self.assertIsInstance(by_id[sid]["cards"], list)


class TestMemorySurfaces(unittest.TestCase):
    def test_project_dir_encoding_matches_observed(self):
        """실측 기준: 영숫자가 아닌 문자를 전부 '-' 로."""
        self.assertEqual(cc._encode_project_dir(r"d:\config-monitor"), "d--config-monitor")
        self.assertEqual(cc._encode_project_dir(r"C:\Users\YEOMYU~1\AppData\Local\Temp"),
                         "C--Users-YEOMYU-1-AppData-Local-Temp")

    def test_memory_index_is_eager_and_topics_are_lazy(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "MEMORY.md"), "w", encoding="utf-8") as f:
                f.write("- [t](t.md)\n")
            with open(os.path.join(d, "t.md"), "w", encoding="utf-8") as f:
                f.write("---\ndescription: 토픽\n---\n")
            by = {c["name"]: c for c in cc._memory_cards(d)}
            self.assertEqual(by["MEMORY"]["load"], "eager")
            self.assertEqual(by["t"]["load"], "lazy")


if __name__ == "__main__":
    unittest.main()
