#!/usr/bin/env python3
r"""test_plugin_state.py - 플러그인 가시화 + 토글.

의존성 0: 표준 unittest(pytest 로도 실행됨). 네트워크 없음 - 가짜 플러그인 트리를
임시 디렉토리에 만들어 검증한다.

위험한 순수 함수만 본다(docs/PLUGIN-VISIBILITY.md §검증):
  - id != ns 분리(notion 회귀 픽스처). 합치면 토글이 조용히 no-op 한다
  - 4상태 ok / disabled / stale / missing
  - dot 디렉토리(.agents) 제외. 읽으면 세션에 없는 항목이 유령으로 뜬다
  - plugin.json 인라인 mcpServers
  - 토글 대상 파일 격리(프로젝트 토글이 전역 파일을 안 건드릴 것)
"""
import json, os, shutil, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), "src")
EDIT = os.path.join(SRC, "config_edit.py")
sys.path.insert(0, SRC)
sys.path.insert(0, HERE)
from test_smoke import run       # noqa: E402

import plugin_state              # noqa: E402
import plugin_units              # noqa: E402
import config_edit               # noqa: E402


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def wjson(path, obj):
    write(path, json.dumps(obj, ensure_ascii=False, indent=2))


class Fixture(unittest.TestCase):
    """<tmp>/plugins 아래에 Claude Code 와 같은 배치의 가짜 레지스트리를 만든다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="plugin_state_test_")
        self.pdir = os.path.join(self.tmp, "plugins")
        self.cache = os.path.join(self.pdir, "cache")
        self.settings = os.path.join(self.tmp, "settings.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def plugin(self, market, name, version="1.0.0", meta=None, files=None):
        """플러그인 루트를 만들고 절대경로를 돌려준다. meta 는 plugin.json 에 병합."""
        root = os.path.join(self.cache, market, name, version)
        m = {"name": name, "version": version, "description": f"{name} desc"}
        m.update(meta or {})
        wjson(os.path.join(root, ".claude-plugin", "plugin.json"), m)
        for rel, body in (files or {}).items():
            write(os.path.join(root, rel.replace("/", os.sep)), body)
        return root

    def installed(self, mapping, scope="user", project_path=None):
        """mapping: {id: root}. installed_plugins.json(version 2) 로 기록."""
        entry = {"scope": scope, "version": "1.0.0"}
        if project_path:
            entry["projectPath"] = project_path
        wjson(os.path.join(self.pdir, "installed_plugins.json"), {
            "version": 2,
            "plugins": {pid: [{**entry, "installPath": root}] for pid, root in mapping.items()},
        })

    def enabled(self, mapping, path=None):
        wjson(path or self.settings, {"enabledPlugins": mapping})

    def read(self, settings=None):
        return {r["id"]: r for r in
                plugin_state.read_plugins(self.pdir, settings or [self.settings])}


class IdVersusNamespace(Fixture):
    """토글 키(id)와 표시 네임스페이스(ns)는 다르다. 실측 회귀 픽스처: notion."""

    def test_ns_comes_from_plugin_json_and_id_is_untouched(self):
        # 마켓 매니페스트 엔트리는 'notion'(소문자), plugin.json 은 'Notion'(대문자).
        root = self.plugin("official", "notion", meta={"name": "Notion"})
        self.installed({"notion@official": root})
        self.enabled({"notion@official": True})
        r = self.read()["notion@official"]
        self.assertEqual(r["id"], "notion@official")     # 토글 키는 매니페스트 쪽 그대로
        self.assertEqual(r["ns"], "Notion")              # 표시는 plugin.json 쪽
        self.assertEqual(r["name"], "notion")

    def test_ns_falls_back_to_id_name_when_plugin_json_missing(self):
        root = os.path.join(self.cache, "m", "solo", "1.0.0")
        os.makedirs(root)                                 # plugin.json 없음
        self.installed({"solo@m": root})
        self.enabled({"solo@m": True})
        self.assertEqual(self.read()["solo@m"]["ns"], "solo")

    def test_split_id_uses_last_at(self):
        self.assertEqual(plugin_state.split_id("a@b"), ("a", "b"))
        self.assertEqual(plugin_state.split_id("we@ird@market"), ("we@ird", "market"))
        self.assertEqual(plugin_state.split_id("bare"), ("bare", ""))


class FourStates(Fixture):
    """ok / disabled / stale / missing. 설치됨 != 적용됨."""

    def test_ok_and_disabled(self):
        a = self.plugin("m", "on")
        b = self.plugin("m", "off")
        self.installed({"on@m": a, "off@m": b})
        self.enabled({"on@m": True, "off@m": False})
        got = self.read()
        self.assertEqual(got["on@m"]["state"], "ok")
        self.assertEqual(got["off@m"]["state"], "disabled")

    def test_missing_when_install_path_gone(self):
        root = self.plugin("m", "ghost")
        self.installed({"ghost@m": root})
        self.enabled({"ghost@m": True})
        shutil.rmtree(root)                               # 캐시 GC / 수동 삭제
        r = self.read()["ghost@m"]
        self.assertEqual(r["state"], "missing")
        self.assertEqual(r["items"]["skills"], [])        # 없는 경로를 읽지 않는다

    def test_stale_key_without_install_record_is_surfaced_not_dropped(self):
        # 실측: enabledPlugins 에 vibe-kit@inline 이 있는데 설치 원장에는 없다.
        self.installed({})
        self.enabled({"vibe-kit@inline": False})
        r = self.read()["vibe-kit@inline"]
        self.assertEqual(r["state"], "stale")
        self.assertEqual(r["root"], "")

    def test_absent_enabled_key_defaults_to_enabled(self):
        # enabledPlugins 에 키가 없으면 설치=적용으로 본다. 추정임을 explicit 가 알린다.
        root = self.plugin("m", "implicit")
        self.installed({"implicit@m": root})
        self.enabled({})
        r = self.read()["implicit@m"]
        self.assertEqual(r["state"], "ok")
        self.assertFalse(r["enabled_explicit"])
        self.assertIsNone(r["enabled_from"])


class ComponentScan(Fixture):
    def test_dot_directories_are_not_scanned(self):
        # superpowers 는 agents/ 가 아니라 .agents/ 를 담고 있고 Claude Code 가 안 읽는다.
        root = self.plugin("m", "sp", files={
            "skills/alpha/SKILL.md": "---\nname: alpha\n---\n",
            ".agents/ghost.md": "---\nname: ghost\n---\n",
            "agents/.hidden.md": "---\nname: hidden\n---\n",
            "commands/ns/deep.md": "---\ndescription: d\n---\n",
        })
        items = plugin_state.scan_items(root)
        self.assertEqual([s["name"] for s in items["skills"]], ["alpha"])
        self.assertEqual(items["agents"], [])
        self.assertEqual([c["name"] for c in items["commands"]], ["ns/deep"])

    def test_skill_without_skill_md_is_not_counted(self):
        root = self.plugin("m", "s", files={"skills/empty/README.md": "x"})
        self.assertEqual(plugin_state.scan_items(root)["skills"], [])

    def test_hooks_are_read_through_plugin_units(self):
        root = self.plugin("m", "h", files={"hooks/hooks.json": json.dumps(
            {"hooks": {"PostToolUse": [{"matcher": "Edit",
                                        "hooks": [{"type": "command", "command": 'node "a b.js"'}]}]}})})
        hooks = plugin_state.scan_items(root)["hooks"]
        self.assertEqual(len(hooks), 1)
        self.assertEqual(hooks[0]["event"], "PostToolUse")
        # 정규식으로 뽑으면 따옴표에서 잘린다. 파싱된 구조에서 읽는지 확인.
        self.assertEqual(hooks[0]["commands"], ['node "a b.js"'])


class InlineMcpDeclaration(Fixture):
    """plugin.json 이 mcpServers 를 인라인 선언할 수 있다(실측: chrome-devtools-mcp)."""

    def test_inline_mcp_servers_are_found(self):
        root = self.plugin("m", "cdp", meta={
            "mcpServers": {"chrome-devtools": {"command": "npx", "args": ["chrome-devtools-mcp"]}}})
        self.assertTrue(plugin_units.has_mcp(root))
        self.assertEqual([m["name"] for m in plugin_state.scan_items(root)["mcp"]],
                         ["chrome-devtools"])

    def test_mcp_json_file_wins_over_inline(self):
        root = self.plugin("m", "both", meta={"mcpServers": {"inline": {"command": "a"}}},
                           files={".mcp.json": json.dumps({"mcpServers": {"fromfile": {"command": "b"}}})})
        self.assertEqual([m["name"] for m in plugin_state.scan_items(root)["mcp"]], ["fromfile"])

    def test_no_declaration_at_all(self):
        root = self.plugin("m", "none")
        self.assertFalse(plugin_units.has_mcp(root))
        self.assertIsNone(plugin_units.load_mcp_json(root))


class EnabledPrecedence(Fixture):
    """settings 는 우선순위 오름차순으로 들어온다. 이긴 파일이 토글 대상이 된다."""

    def test_later_file_wins_and_records_its_path(self):
        root = self.plugin("m", "p")
        self.installed({"p@m": root})
        proj = os.path.join(self.tmp, "proj", "settings.json")
        self.enabled({"p@m": True})                       # 전역
        self.enabled({"p@m": False}, proj)                # 프로젝트(뒤 = 우선)
        r = self.read([self.settings, proj])["p@m"]
        self.assertFalse(r["enabled"])
        self.assertEqual(r["enabled_from"], proj)         # 토글은 이 파일로 가야 한다
        self.assertEqual(r["state"], "disabled")


class MarketDiscovery(Fixture):
    def _markets(self, mapping):
        wjson(os.path.join(self.pdir, "known_marketplaces.json"), mapping)

    def test_github_source_is_expanded_to_url(self):
        self._markets({"ua": {"source": {"source": "github", "repo": "o/r"}}})
        self.assertEqual(plugin_state.read_markets(self.pdir)["ua"]["url"],
                         "https://github.com/o/r.git")

    def test_candidate_matching_ignores_git_suffix_and_case(self):
        self._markets({"ua": {"source": {"source": "github", "repo": "O/R"}}})
        # 스토어에 .git 없이 등록돼 있어도 같은 레포로 봐야 한다(중복 등록이 유일한 실패 모드).
        self.assertEqual(plugin_state.import_candidates(self.pdir, ["https://github.com/o/r"]), [])
        self.assertEqual(len(plugin_state.import_candidates(self.pdir, [])), 1)

    def test_source_without_url_is_not_a_candidate(self):
        self._markets({"local": {"source": {"source": "path", "path": "/x"}}})
        self.assertEqual(plugin_state.import_candidates(self.pdir, []), [])


class CardScopeTagging(Fixture):
    """enabled_from 이 전역 체인 밖이면 project 스코프로 태깅. 안 하면 스코프 칩이
    프로젝트가 끈 플러그인을 전역으로 분류해서 어디서 꺼졌는지 화면에서 못 찾는다."""

    def setUp(self):
        super().setUp()
        import claude_config
        self.cc = claude_config
        self.root = self.plugin("m", "p")
        self.installed({"p@m": self.root})
        self.proj = os.path.join(self.tmp, "myproj", ".claude", "settings.json")

    def cards(self, files):
        recs = plugin_state.read_plugins(self.pdir, files)
        return {c["name"]: c for c in
                self.cc._plugin_section_cards(recs, self.settings, [self.settings])}

    def test_global_card_has_no_scope(self):
        self.enabled({"p@m": True})
        c = self.cards([self.settings])["p"]
        self.assertIsNone(c.get("scope"))
        self.assertEqual(c["edit"]["settings"], self.settings)

    def test_project_card_is_tagged_with_its_root(self):
        self.enabled({"p@m": True})
        self.enabled({"p@m": False}, self.proj)
        c = self.cards([self.settings, self.proj])["p"]
        self.assertEqual(c["scope"], "project")
        # <root>/.claude/settings.json -> <root> (_append_project_cards 와 같은 라벨 기준)
        self.assertEqual(c["project"], os.path.join(self.tmp, "myproj"))
        self.assertEqual(c["edit"]["settings"], self.proj)   # 토글도 그 파일로 간다

    def test_implicit_enable_is_not_tagged_project(self):
        # enabled_from 이 None 이면(설정에 키가 아예 없음) 전역으로 둔다.
        self.enabled({})
        c = self.cards([self.settings])["p"]
        self.assertIsNone(c.get("scope"))


class InstallScopeRoundTrip(Fixture):
    """설치 스코프가 카드까지 살아 돌아와야 제거/갱신이 같은 자리를 향한다.

    회귀 가드: 이게 빠져 있어서 project 스코프로 설치한 플러그인을 대시보드에서 지울 수
    없었다. UI 가 CLI 기본값 user 로 보내고, claude 는 "is enabled at project scope" 로
    정확히 거절했다(실측). 대시보드에서 빠져나갈 길이 없는 상태였다."""

    def setUp(self):
        super().setUp()
        import claude_config
        self.cc = claude_config
        self.root = self.plugin("official", "code-review")

    def card(self):
        recs = plugin_state.read_plugins(self.pdir, [self.settings])
        return self.cc._plugin_section_cards(recs, self.settings, [self.settings])[0]

    def test_project_scope_and_path_reach_the_card(self):
        self.installed({"code-review@official": self.root},
                       scope="project", project_path="D:\\")
        self.enabled({"code-review@official": True})
        c = self.card()
        self.assertEqual(c["edit"]["scope"], "project")
        self.assertEqual(c["edit"]["cwd"], "D:\\")          # claude 는 cwd 로 프로젝트를 정한다
        # 어디에 설치됐는지가 카드에 보여야 한다 - 안 보이면 왜 못 지우는지 알 수 없다.
        self.assertIn("project", dict(c["kv"]).get("installed", ""))

    def test_user_scope_needs_no_cwd(self):
        self.installed({"code-review@official": self.root})
        self.enabled({"code-review@official": True})
        c = self.card()
        self.assertEqual(c["edit"]["scope"], "user")
        self.assertEqual(c["edit"]["cwd"], "")
        self.assertNotIn("installed", dict(c["kv"]))        # user 는 기본이라 줄을 늘리지 않는다

    def test_stale_record_has_no_scope_fields_but_does_not_crash(self):
        self.installed({})
        self.enabled({"ghost@inline": True})
        recs = {r["id"]: r for r in plugin_state.read_plugins(self.pdir, [self.settings])}
        self.assertEqual(recs["ghost@inline"]["project_path"], "")


class ToggleOp(unittest.TestCase):
    """enabledPlugins 만 건드리고, id 를 정규화하지 않으며, 대상 파일을 넘나들지 않는다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="plugin_toggle_test_")
        self.g = os.path.join(self.tmp, ".claude", "settings.json")
        self.p = os.path.join(self.tmp, "proj", ".claude", "settings.json")
        wjson(self.g, {"permissions": {"allow": ["Read(**)"]},
                       "enabledPlugins": {"notion@official": True}})
        wjson(self.p, {"enabledPlugins": {"notion@official": True}})

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def load(self, path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def test_op_is_idempotent(self):
        s = {"enabledPlugins": {"a@m": False}}
        _, _, changed = config_edit.op_plugin_toggle(s, "a@m", False)
        self.assertFalse(changed)
        _, _, changed = config_edit.op_plugin_toggle(s, "a@m", True)
        self.assertTrue(changed)

    def test_op_does_not_normalize_case(self):
        # 'notion' 과 'Notion' 은 서로 다른 키다. 고쳐 주면 토글이 엉뚱한 키를 만든다.
        s, _, _ = config_edit.op_plugin_toggle({}, "Notion@official", True)
        self.assertEqual(list(s["enabledPlugins"]), ["Notion@official"])

    def test_cli_touches_only_target_file_and_only_that_key(self):
        rc, out, _ = run(EDIT, "--settings", self.p, "--no-snapshot",
                         "plugin-toggle", "notion@official", "off")
        self.assertEqual(rc, 0, out)
        self.assertTrue(json.loads(out)["ok"])
        self.assertFalse(self.load(self.p)["enabledPlugins"]["notion@official"])
        # 전역은 손대지 않는다 - 프로젝트에서 켠 것을 전역에서 끄는 오작동의 반대 방향 가드.
        g = self.load(self.g)
        self.assertTrue(g["enabledPlugins"]["notion@official"])
        self.assertEqual(g["permissions"]["allow"], ["Read(**)"])

    def test_cli_backs_up_before_writing(self):
        run(EDIT, "--settings", self.g, "--no-snapshot", "plugin-toggle", "notion@official", "off")
        self.assertTrue([f for f in os.listdir(os.path.dirname(self.g)) if f.endswith(".bak")])


class ClaudeCliDelegation(unittest.TestCase):
    """plugin_cli.py: `claude plugin install/uninstall` 위임.

    실제로 설치하지는 않는다 - dry-run 으로 조립된 argv 와 거부 경로만 본다.
    이름은 매니페스트에서 오는 신뢰할 수 없는 입력이라 가드가 핵심이다."""

    CLI = os.path.join(SRC, "plugin_cli.py")

    def call(self, *args, env=None):
        rc, so, se = run(self.CLI, *args, env=env)
        self.assertTrue(so.strip(), f"stdout 없음 (rc={rc}): {se}")
        return rc, json.loads(so)

    def test_install_dry_run_builds_id_and_scope(self):
        _, r = self.call("install", "--marketplace", "official", "--plugin", "notion",
                         "--scope", "project", "--dry-run")
        self.assertTrue(r["ok"])
        self.assertEqual(r["target"], "notion@official")
        self.assertEqual(r["command"][1:], ["plugin", "install", "notion@official", "--scope", "project"])

    def test_uninstall_always_passes_yes(self):
        # 비-TTY 로 부르므로 확인 프롬프트가 뜨면 응답할 수 없어 타임아웃까지 매달린다.
        _, r = self.call("uninstall", "--marketplace", "m", "--plugin", "p", "--dry-run")
        self.assertEqual(r["command"][1:],
                         ["plugin", "uninstall", "p@m", "--scope", "user", "-y"])

    def test_update_accepts_managed_scope(self):
        # managed 는 update 만 받는다(claude plugin update --help 실측).
        _, r = self.call("update", "--marketplace", "m", "--plugin", "p",
                         "--scope", "managed", "--dry-run")
        self.assertEqual(r["command"][1:], ["plugin", "update", "p@m", "--scope", "managed"])
        rc, _, _ = run(self.CLI, "install", "--marketplace", "m", "--plugin", "p",
                       "--scope", "managed", "--dry-run")
        self.assertNotEqual(rc, 0)          # install 은 managed 를 받지 않는다

    def test_market_ops_build_expected_argv(self):
        _, r = self.call("market-add", "owner/repo", "--scope", "project", "--dry-run")
        self.assertEqual(r["command"][1:],
                         ["plugin", "marketplace", "add", "owner/repo", "--scope", "project"])
        _, r = self.call("market-update", "--dry-run")
        self.assertEqual(r["command"][1:], ["plugin", "marketplace", "update"])
        _, r = self.call("market-remove", "--name", "m", "--dry-run")
        # scope 생략 = 모든 스코프에서 제거(claude 기본). 임의로 user 를 끼워 넣지 않는다.
        self.assertEqual(r["command"][1:], ["plugin", "marketplace", "remove", "m"])

    def test_market_source_only_guards_option_injection(self):
        # 소스는 owner/repo · URL · 로컬 경로 중 무엇이든 될 수 있어 세그먼트 검증을 못 한다.
        _, r = self.call("market-add", "./some/local/path", "--dry-run")
        self.assertTrue(r["ok"])
        rc, r = self.call("market-add", "--dry-run", "--", "-upload-pack=evil")
        self.assertFalse(r["ok"])

    def test_option_like_name_is_refused(self):
        # 리스트 인자라 셸 주입은 없지만, claude CLI 자신이 옵션으로 오인한다.
        rc, r = self.call("install", "--marketplace", "m", "--plugin=-upload-pack", "--dry-run")
        self.assertFalse(r["ok"])
        self.assertEqual(rc, 1)

    def test_path_escape_and_colon_are_refused(self):
        for bad in ("../../etc", "a/b", "a:b", ".."):
            _, r = self.call("install", "--marketplace", "m", "--plugin", bad, "--dry-run")
            self.assertFalse(r["ok"], bad)

    def test_missing_cwd_is_refused(self):
        _, r = self.call("install", "--marketplace", "m", "--plugin", "p",
                         "--cwd", os.path.join(SRC, "no-such-dir"), "--dry-run")
        self.assertFalse(r["ok"])

    def test_reports_clearly_when_claude_is_not_on_path(self):
        # dry-run 이 아닌 실행 경로에서만 막는다(dry-run 은 명령을 보여주는 게 목적이라 통과).
        rc, r = self.call("install", "--marketplace", "m", "--plugin", "p",
                          env={"PATH": os.path.join(SRC, "no-such-dir")})
        self.assertFalse(r["ok"])
        self.assertIn("claude", r["message"])
        self.assertEqual(r["target"], "p@m")        # 무엇을 하려 했는지는 그대로 보고한다

    def test_dry_run_works_without_claude_and_says_so(self):
        _, r = self.call("install", "--marketplace", "m", "--plugin", "p", "--dry-run",
                         env={"PATH": os.path.join(SRC, "no-such-dir")})
        self.assertTrue(r["ok"])
        self.assertFalse(r["available"])


if __name__ == "__main__":
    unittest.main()
