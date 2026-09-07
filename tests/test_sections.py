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


class TestCounting(unittest.TestCase):
    """'＋ 새 …' 카드는 항목이 아니라 입력 폼이다. 개수에 들어가면 규칙 0개인 Rules 가
    '· 1' 로 보이고, 빈 섹션 숨기기도 영영 걸리지 않는다."""

    def test_add_cards_are_excluded_from_the_count(self):
        real = cc.card("real", [("desc", "x")])
        adder = cc.card("＋ 새 규칙", [], badge="add", edit={"kind": "item-add", "itemKind": "rule"})
        self.assertEqual(cc._count([real, adder]), 1)
        self.assertEqual(cc._count([adder]), 0)
        self.assertTrue(cc._is_add_card(adder))
        self.assertFalse(cc._is_add_card(real))

    def test_empty_surface_with_only_an_adder_titles_as_zero(self):
        with tempfile.TemporaryDirectory() as d:
            sec = cc._section("rules", cc._rules_cards(d))
            self.assertTrue(sec["title"].endswith("· 0"), sec["title"])
            self.assertEqual(len(sec["cards"]), 1, "추가 카드 자체는 남아 있어야 한다")

    def test_keybindings_is_not_a_section(self):
        """파일 한 개짜리이고 내용을 파싱하지도 않는다 - 섹션이 할 말이 없다."""
        self.assertNotIn("keybindings", cc.SECTIONS)
        ids = {s["id"] for s in cc.parse(cc.discover())["sections"]}
        self.assertNotIn("keybindings", ids)


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
        for sid in ("workflows", "themes"):
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


class TestConversationalViews(unittest.TestCase):
    """대화용 축약: 필터·compact·summary. 대시보드가 받는 전체 dump 는 건드리지 않는다."""

    def _state(self):
        g = cc.card("brainstorm", [("description", "x" * 800)], badge="skill", ok=True)
        p = cc.card("brainstorm", [("description", "proj")], badge="skill", ok=True,
                    scope="project", project="D:/proj",
                    edit={"kind": "skill", "skillsDir": "D:/proj/.claude/skills"})
        q = cc.card("other", [("description", "unique-needle")], badge="skill", ok=True)
        add = cc.card("＋ 새 스킬", [("형식", "name")], badge="add", edit={"kind": "skill-add"})
        hooks = cc.card("PreToolUse", [("command", "python x.py")], badge="hook", ok=True)
        plug = cc.card("Notion", [("marketplace", "official")], badge="disabled", ok=True)
        return {"generated": "t", "sources": {}, "sections": [
            cc._section("skills", [g, p, q, add]),
            cc._section("hooks", [hooks]),
            cc._section("plugins", [plug]),
        ]}

    def test_filter_by_section_scope_and_query(self):
        st = self._state()
        only = cc.filter_state(st, sections=["hooks"])
        self.assertEqual([s["id"] for s in only["sections"]], ["hooks"])
        proj = cc.filter_state(st, scope="project")["sections"][0]
        self.assertEqual([c["name"] for c in proj["cards"]], ["brainstorm"])
        self.assertEqual(proj["title"], "Skills (code) · 1")
        glob = cc.filter_state(st, scope="global")["sections"][0]
        self.assertEqual([c["name"] for c in glob["cards"]], ["brainstorm", "other"],
                         "필터가 걸리면 입력 폼 카드는 빠져야 한다")
        hit = cc.filter_state(st, query="NEEDLE")["sections"][0]
        self.assertEqual([c["name"] for c in hit["cards"]], ["other"])

    def test_compact_keeps_edit_and_trims_description(self):
        sec = cc.compact_state(self._state())["sections"][0]
        names = [c["name"] for c in sec["cards"]]
        self.assertNotIn("＋ 새 스킬", names)
        g = sec["cards"][0]
        self.assertNotIn("kv", g)
        self.assertLessEqual(len(g["desc"]), 201)
        p = sec["cards"][1]
        self.assertEqual(p["edit"]["skillsDir"], "D:/proj/.claude/skills",
                         "Claude 가 편집 도구에 넘길 경로는 compact 에서도 남아야 한다")
        self.assertEqual(p["scope"], "project")

    def test_summary_counts_names_collisions_and_plugin_states(self):
        s = cc.summarize(self._state())
        skills = next(e for e in s["sections"] if e["id"] == "skills")
        self.assertEqual((skills["count"], skills["global"], skills["project"]), (3, 2, 1))
        self.assertEqual(skills["names"], ["brainstorm", "brainstorm", "other"])
        self.assertEqual(skills["title"], "Skills (code)")
        self.assertEqual(skills["load"], "eager")
        self.assertEqual(s["collisions"], [
            {"section": "skills", "name": "brainstorm", "projects": ["D:/proj"], "wins": "global"}])
        self.assertEqual(s["plugins"], {"disabled": 1})

    def test_dump_cli_accepts_filters_and_summary_subcommand(self):
        import subprocess
        cfg = os.path.join(SRC, "claude_config.py")
        env = dict(os.environ, PYTHONUTF8="1")
        out = subprocess.run([sys.executable, cfg, "dump", "--sections", "hooks", "--compact"],
                             capture_output=True, env=env, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr.decode("utf-8", "replace")[-300:])
        d = json.loads(out.stdout.decode("utf-8"))
        self.assertEqual([s["id"] for s in d["sections"]], ["hooks"])
        out = subprocess.run([sys.executable, cfg, "summary"], capture_output=True, env=env, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr.decode("utf-8", "replace")[-300:])
        d = json.loads(out.stdout.decode("utf-8"))
        self.assertIn("collisions", d)
        self.assertTrue(all("names" in e for e in d["sections"]))
