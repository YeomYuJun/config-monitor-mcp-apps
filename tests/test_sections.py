#!/usr/bin/env python3
"""섹션 레지스트리와 설정 표면 스캐너 테스트.

레지스트리가 id·그룹·적재등급의 유일한 원천이라, 여기서 깨지면 저장된 표시 설정이
엉뚱한 섹션에 붙는다.
"""
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


if __name__ == "__main__":
    unittest.main()
