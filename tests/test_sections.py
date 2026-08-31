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


if __name__ == "__main__":
    unittest.main()
