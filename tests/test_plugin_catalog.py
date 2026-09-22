#!/usr/bin/env python3
r"""test_plugin_catalog.py - 플러그인 카탈로그 캐시 리더.

의존성 0: 표준 unittest(pytest 로도 실행됨). 네트워크 없음 - 가짜 캐시 파일을 임시
디렉토리에 만들어 검증한다. **실사용자의 ~/.claude/plugins/plugin-catalog-cache.json 을
읽는 호출은 한 건도 없다**(전부 path/--cache 를 명시). 그래야 머신에 따라 결과가 안 바뀐다.

위험한 자리만 본다:
  - components 의 문자열 배열 / dict 배열 두 형태 정규화(최우선 회귀 가드).
    빠뜨리면 UI 에 [object Object] 가 뜬다
  - 파일 없음 / 깨진 JSON / catalog 키 없음 -> 예외 없이 ok=False
  - counts 에서 0 인 종류 제외, total 일치
  - author dict / 문자열 / 부재
  - summary() 의 경량 계약(이름 배열을 담지 않는다)
  - CLI 두 서브커맨드가 JSON 한 줄
"""
import json, os, shutil, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), "src")
sys.path.insert(0, SRC)
sys.path.insert(0, HERE)
from test_smoke import run       # noqa: E402

import plugin_catalog            # noqa: E402

CLI = os.path.join(SRC, "plugin_catalog.py")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def entry(**over):
    """실측 형태의 카탈로그 엔트리 하나. over 로 필드를 갈아끼운다."""
    rec = {
        "plugin": "code-review",
        "tokens": {"claude-opus-4-7": {"always_on": 25, "on_invoke": 2489}},
        "components": {"commands": [], "agents": [], "skills": [],
                       "hooks": [], "mcpServers": [], "lspServers": []},
        "unique_installs": 404331,
        "last_updated": "2026-02-20T01:06:49Z",
        "marketplace_entry": {"name": "code-review", "description": "자동 코드 리뷰",
                              "author": {"name": "Anthropic", "email": "s@a.com"},
                              "source": "./plugins/code-review", "category": "productivity",
                              "homepage": "https://example.invalid/code-review"},
        "source": "code-review@claude-plugins-official",
        "sha": None, "source_sha": "aecd4c85",
    }
    rec.update(over)
    return rec


def has_list(obj) -> bool:
    """중첩 어디에라도 list 가 있으면 True. summary() 경량 계약 검사용."""
    if isinstance(obj, list):
        return True
    if isinstance(obj, dict):
        return any(has_list(v) for v in obj.values())
    return False


class Fixture(unittest.TestCase):
    """<tmp>/plugin-catalog-cache.json 에 Claude Code 와 같은 배치의 가짜 캐시를 만든다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="plugin_catalog_test_")
        self.cache = os.path.join(self.tmp, "plugin-catalog-cache.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def raw(self, doc):
        """최상위 문서를 통째로 기록(망가진 형태를 만들 때 쓴다)."""
        write(self.cache, json.dumps(doc, ensure_ascii=False))
        return self.cache

    def cache_with(self, plugins, **cat_over):
        cat = {"generated_at": "2026-08-06T04:00:00Z",
               "installs_generated_at": "2026-08-05T00:00:00Z",
               "marketplace_sha": "deadbeef",
               "models": ["claude-opus-4-7", "claude-sonnet-4-6"],
               "plugins": plugins}
        cat.update(cat_over)
        return self.raw({"version": 1, "fetchedAt": "2026-08-06T04:31:43.504Z", "catalog": cat})

    def load(self):
        return plugin_catalog.load(self.cache)


class ComponentShapes(Fixture):
    """**최우선 회귀 가드.** components 의 항목이 문자열일 때도 dict 일 때도 이름 문자열로
    나와야 한다. 실측 파일은 2062개가 dict({"name","chars"}), 278개가 문자열이다.
    같은 종류(skills)를 양쪽 형태로 둬서 종류별 우연 통과를 막는다."""

    def setUp(self):
        super().setUp()
        self.cache_with({
            "dictish@m": entry(components={
                "skills": [{"name": "alpha", "chars": {"always_on": 50, "on_invoke": 7170}},
                           {"name": "beta", "chars": {}}],
                "commands": [{"name": "review", "chars": {}}],
                "agents": [], "hooks": [], "mcpServers": [], "lspServers": []}),
            "stringy@m": entry(components={
                "skills": ["alpha", "beta"],
                "hooks": ["PreToolUse", "PostToolUse"],
                "mcpServers": ["chrome-devtools"],
                "commands": [], "agents": [], "lspServers": []}),
        })

    def test_dict_items_become_name_strings(self):
        c = plugin_catalog.details("dictish@m", self.cache)["components"]
        self.assertEqual(c["skills"], ["alpha", "beta"])
        self.assertEqual(c["commands"], ["review"])
        # UI 로 나가는 값에 dict 가 하나라도 남으면 [object Object] 가 뜬다.
        for names in c.values():
            self.assertTrue(all(isinstance(n, str) for n in names), c)

    def test_string_items_pass_through_unchanged(self):
        c = plugin_catalog.details("stringy@m", self.cache)["components"]
        self.assertEqual(c["skills"], ["alpha", "beta"])
        self.assertEqual(c["hooks"], ["PreToolUse", "PostToolUse"])
        self.assertEqual(c["mcpServers"], ["chrome-devtools"])

    def test_both_shapes_of_the_same_kind_agree(self):
        a = plugin_catalog.details("dictish@m", self.cache)["components"]["skills"]
        b = plugin_catalog.details("stringy@m", self.cache)["components"]["skills"]
        self.assertEqual(a, b)

    def test_unnameable_items_are_dropped_not_nulled(self):
        # name 이 없거나 문자열이 아닌 항목, str/dict 도 아닌 항목은 담지 않는다.
        # None 을 끼워 넣으면 [object Object] 가 이름만 바꿔 재발한다.
        self.cache_with({"weird@m": entry(components={
            "skills": [{"chars": {}}, {"name": 7}, {"name": ""}, 42, None,
                       {"name": "ok"}, "plain"]})})
        c = plugin_catalog.details("weird@m", self.cache)["components"]
        self.assertEqual(c["skills"], ["ok", "plain"])

    def test_malformed_components_do_not_raise(self):
        # components 자체가 dict 가 아니거나 종류의 값이 리스트가 아닌 경우.
        self.cache_with({"a@m": entry(components="nope"),
                         "b@m": entry(components={"skills": "nope", "hooks": None}),
                         "c@m": entry(components=None)})
        got = self.load()
        self.assertTrue(got["ok"])
        self.assertEqual(got["entries"]["a@m"]["components"], {})
        self.assertEqual(got["entries"]["b@m"]["components"], {"skills": [], "hooks": []})
        self.assertEqual(got["entries"]["c@m"]["components"], {})
        self.assertEqual(got["entries"]["b@m"]["total"], 0)

    def test_unknown_component_kind_is_carried_through(self):
        # 종류 목록을 하드코딩하지 않는다 - 카탈로그에 새 종류가 생겨도 따라가야 한다.
        self.cache_with({"a@m": entry(components={"widgets": [{"name": "w1"}]})})
        rec = plugin_catalog.details("a@m", self.cache)
        self.assertEqual(rec["components"]["widgets"], ["w1"])
        self.assertEqual(rec["counts"], {"widgets": 1})


class BrokenInput(Fixture):
    """읽기 실패는 예외가 아니라 ok=False + entries={} 다. scan 경로가 계속 돌아야 한다."""

    def test_missing_file(self):
        got = plugin_catalog.load(os.path.join(self.tmp, "no-such-file.json"))
        self.assertFalse(got["ok"])
        self.assertEqual(got["entries"], {})
        self.assertEqual(got["models"], [])
        self.assertEqual(got["fetched_at"], "")

    def test_corrupt_json(self):
        write(self.cache, '{"version": 1, "catalog": {"plugins": {')
        got = self.load()
        self.assertFalse(got["ok"])
        self.assertEqual(got["entries"], {})

    def test_no_catalog_key(self):
        self.raw({"version": 1, "fetchedAt": "2026-08-06T04:31:43.504Z"})
        got = self.load()
        self.assertFalse(got["ok"])
        self.assertEqual(got["entries"], {})

    def test_catalog_without_plugins_or_wrong_type(self):
        for cat in ({"generated_at": "x"}, {"plugins": []}, {"plugins": "nope"}):
            self.raw({"catalog": cat})
            self.assertFalse(self.load()["ok"], cat)

    def test_top_level_is_not_an_object(self):
        write(self.cache, "[1, 2, 3]")
        self.assertFalse(self.load()["ok"])

    def test_non_dict_entries_are_skipped_not_fatal(self):
        self.cache_with({"good@m": entry(), "bad@m": "nope", "also-bad@m": None})
        got = self.load()
        self.assertTrue(got["ok"])
        self.assertEqual(sorted(got["entries"]), ["good@m"])

    def test_summary_and_details_survive_a_broken_file(self):
        write(self.cache, "not json at all")
        self.assertEqual(plugin_catalog.summary(self.cache), {})
        # 없는 id 와 못 읽은 파일은 서로 다른 경로지만 결과는 같다.
        self.assertIsNone(plugin_catalog.details("code-review@m", self.cache))

    def test_empty_plugins_is_ok_not_broken(self):
        # 플러그인 0건은 읽기 성공이다. 건수로 ok 를 판정하면 빈 카탈로그가 오류로 보인다.
        self.cache_with({})
        got = self.load()
        self.assertTrue(got["ok"])
        self.assertEqual(got["entries"], {})


class Details(Fixture):
    def test_full_record_fields(self):
        self.cache_with({"code-review@claude-plugins-official": entry(components={
            "commands": [{"name": "code-review", "chars": {}}],
            "agents": [], "skills": [], "hooks": [], "mcpServers": [], "lspServers": []})})
        r = plugin_catalog.details("code-review@claude-plugins-official", self.cache)
        self.assertEqual(r["id"], "code-review@claude-plugins-official")
        self.assertEqual(r["name"], "code-review")
        self.assertEqual(r["marketplace"], "claude-plugins-official")
        self.assertEqual(r["installs"], 404331)
        self.assertEqual(r["components"]["commands"], ["code-review"])
        self.assertEqual(r["counts"], {"commands": 1})
        self.assertEqual(r["total"], 1)
        self.assertEqual(r["category"], "productivity")
        self.assertEqual(r["last_updated"], "2026-02-20T01:06:49Z")
        self.assertEqual(r["source_sha"], "aecd4c85")
        self.assertIsNone(r["sha"])                         # 부재는 null 로 드러낸다
        self.assertIsNone(r["version"])
        self.assertEqual(r["tokens"]["claude-opus-4-7"]["on_invoke"], 2489)

    def test_unknown_id_is_none(self):
        self.cache_with({"a@m": entry()})
        self.assertIsNone(plugin_catalog.details("b@m", self.cache))
        self.assertIsNone(plugin_catalog.details("", self.cache))

    def test_counts_drop_zero_kinds_and_total_matches(self):
        self.cache_with({"a@m": entry(components={
            "commands": [{"name": "c1"}, {"name": "c2"}],
            "skills": [{"name": "s1"}],
            "agents": [], "hooks": [], "mcpServers": [], "lspServers": []})})
        r = plugin_catalog.details("a@m", self.cache)
        self.assertEqual(r["counts"], {"commands": 2, "skills": 1})
        self.assertNotIn("agents", r["counts"])             # 0 인 종류는 빠진다
        self.assertIn("agents", r["components"])            # 이름 배열 쪽에는 남는다
        self.assertEqual(r["total"], 3)

    def test_id_without_marketplace(self):
        self.cache_with({"bare": entry(plugin="bare")})
        r = plugin_catalog.details("bare", self.cache)
        self.assertEqual((r["name"], r["marketplace"]), ("bare", ""))

    def test_id_split_uses_last_at(self):
        self.cache_with({"we@ird@market": entry(plugin=None)})
        r = plugin_catalog.details("we@ird@market", self.cache)
        self.assertEqual((r["name"], r["marketplace"]), ("we@ird", "market"))

    def test_missing_installs_stays_none_not_zero(self):
        # 실측 255개 중 2개가 unique_installs 를 안 갖는다. 0 으로 접으면
        # "아무도 안 쓰는 플러그인"으로 잘못 보인다.
        self.cache_with({"a@m": entry(unique_installs=None),
                         "b@m": entry(unique_installs="많음"),
                         "c@m": entry(unique_installs=0)})
        d = self.load()["entries"]
        self.assertIsNone(d["a@m"]["installs"])
        self.assertIsNone(d["b@m"]["installs"])
        self.assertEqual(d["c@m"]["installs"], 0)           # 0 과 모름은 다르다

    def test_version_falls_back_to_marketplace_entry(self):
        me = dict(entry()["marketplace_entry"], version="2.1.0")
        self.cache_with({"a@m": entry(version="1.0.0"),
                         "b@m": entry(version=None, marketplace_entry=me),
                         "c@m": entry(version=None)})
        d = self.load()["entries"]
        self.assertEqual(d["a@m"]["version"], "1.0.0")      # 최상위가 이긴다
        self.assertEqual(d["b@m"]["version"], "2.1.0")
        self.assertIsNone(d["c@m"]["version"])              # 빈 문자열이 아니라 null

    def test_sha_fields_are_null_when_absent(self):
        self.cache_with({"a@m": entry(sha=None, source_sha=""),
                         "b@m": entry(sha=7, source_sha="abc")})
        d = self.load()["entries"]
        self.assertIsNone(d["a@m"]["sha"])
        self.assertIsNone(d["a@m"]["source_sha"])
        self.assertIsNone(d["b@m"]["sha"])                  # 문자열이 아니면 null
        self.assertEqual(d["b@m"]["source_sha"], "abc")

    def test_marketplace_entry_missing_or_wrong_type(self):
        self.cache_with({"a@m": entry(marketplace_entry=None),
                         "b@m": entry(marketplace_entry="nope")})
        for pid in ("a@m", "b@m"):
            r = plugin_catalog.details(pid, self.cache)
            self.assertEqual((r["description"], r["author"], r["homepage"], r["category"]),
                             ("", "", "", ""))


class Author(Fixture):
    """author 는 dict / 문자열 / 부재 세 형태가 다 온다. 어느 쪽이든 이름 문자열로."""

    def test_dict_author_yields_name_only(self):
        self.cache_with({"a@m": entry()})
        self.assertEqual(plugin_catalog.details("a@m", self.cache)["author"], "Anthropic")

    def test_string_author_is_kept(self):
        me = dict(entry()["marketplace_entry"], author="Anthropic")
        self.cache_with({"a@m": entry(marketplace_entry=me)})
        self.assertEqual(plugin_catalog.details("a@m", self.cache)["author"], "Anthropic")

    def test_absent_or_unusable_author_is_empty_string(self):
        # 실측 255개 중 85개가 author 없음. None 을 흘리면 UI 가 "None" 을 저자로 찍는다.
        for value in (None, {}, {"email": "x@y.z"}, {"name": 7}, 42):
            me = dict(entry()["marketplace_entry"], author=value)
            self.cache_with({"a@m": entry(marketplace_entry=me)})
            self.assertEqual(plugin_catalog.details("a@m", self.cache)["author"], "", value)


class Meta(Fixture):
    def test_timestamps_come_from_their_own_levels(self):
        # fetchedAt 은 최상위(언제 받았나), generated_at 계열은 catalog 안(언제 만들어졌나).
        self.cache_with({"a@m": entry()})
        got = self.load()
        self.assertEqual(got["fetched_at"], "2026-08-06T04:31:43.504Z")
        self.assertEqual(got["generated_at"], "2026-08-06T04:00:00Z")
        self.assertEqual(got["installs_at"], "2026-08-05T00:00:00Z")
        self.assertEqual(got["models"], ["claude-opus-4-7", "claude-sonnet-4-6"])
        self.assertEqual(got["path"], self.cache)

    def test_models_are_filtered_to_strings(self):
        self.cache_with({}, models=["ok", 7, None, {"name": "x"}])
        self.assertEqual(self.load()["models"], ["ok"])
        self.cache_with({}, models="nope")
        self.assertEqual(self.load()["models"], [])

    def test_utf8_bom_is_tolerated(self):
        # PowerShell 로 쓰인 JSON 은 BOM 이 붙는다. utf-8 로 읽으면 ValueError 로 ok=False.
        self.cache_with({"a@m": entry()})
        with open(self.cache, encoding="utf-8") as f:
            body = f.read()
        with open(self.cache, "w", encoding="utf-8-sig", newline="\n") as f:
            f.write(body)
        self.assertTrue(self.load()["ok"])

    def test_default_cache_points_at_the_claude_plugins_dir(self):
        # 경로 모양만 본다 - 실제로 읽으면 테스트가 머신에 따라 달라진다.
        self.assertTrue(isinstance(plugin_catalog.DEFAULT_CACHE, str))
        self.assertTrue(plugin_catalog.DEFAULT_CACHE.endswith("plugin-catalog-cache.json"))
        self.assertIn("plugins", plugin_catalog.DEFAULT_CACHE)


class Summary(Fixture):
    """경량 계약: 255개 x 컴포넌트 이름 전부를 UI 로 보내지 않는다."""

    def setUp(self):
        super().setUp()
        self.cache_with({
            "a@m": entry(components={"commands": [{"name": "c1"}], "skills": ["s1", "s2"],
                                     "agents": [], "hooks": []}),
            "b@m": entry(unique_installs=None, components={"hooks": ["PreToolUse"]}),
        })

    def test_counts_and_installs(self):
        s = plugin_catalog.summary(self.cache)
        self.assertEqual(sorted(s), ["a@m", "b@m"])
        self.assertEqual(s["a@m"]["components"], {"commands": 1, "skills": 2})
        self.assertEqual(s["a@m"]["total"], 3)
        self.assertEqual(s["a@m"]["installs"], 404331)
        self.assertIsNone(s["b@m"]["installs"])
        self.assertEqual(s["b@m"]["components"], {"hooks": 1})

    def test_no_name_arrays_anywhere(self):
        # 스팟 체크가 아니라 구조로 본다 - 형제 키로 이름이 새도 잡힌다.
        s = plugin_catalog.summary(self.cache)
        self.assertFalse(has_list(s), f"summary 가 배열을 담고 있다: {s}")
        for rec in s.values():
            self.assertEqual(sorted(rec), ["components", "installs", "total"])

    def test_summary_does_not_alias_details_counts(self):
        # summary 의 components 를 손대도 details 의 counts 가 안 변해야 한다(복사본).
        s = plugin_catalog.summary(self.cache)
        s["a@m"]["components"]["commands"] = 999
        self.assertEqual(plugin_catalog.details("a@m", self.cache)["counts"]["commands"], 1)


class Cli(Fixture):
    """출력은 JSON 한 줄이고 **키 이름이 호출부(TypeScript UI)와의 계약**이다.

    이름이 어긋나면 UI 가 예외 없이 빈 화면을 낸다 - 그래서 값뿐 아니라 키 집합을 고정한다.
    종료코드는 ok 와 일치한다(ok:false 면 1)."""

    PID = "code-review@claude-plugins-official"

    def setUp(self):
        super().setUp()
        self.cache_with({self.PID: entry(components={
            "commands": [{"name": "code-review", "chars": {}}],
            "agents": [], "skills": [], "hooks": [], "mcpServers": [], "lspServers": []})})

    def call(self, *args):
        rc, so, se = run(CLI, *args)
        self.assertTrue(so.strip(), f"stdout 없음 (rc={rc}): {se}")
        self.assertEqual(len(so.strip().splitlines()), 1, f"JSON 한 줄이 아니다: {so!r}")
        r = json.loads(so)
        self.assertEqual(rc, 0 if r["ok"] else 1, so)
        return r

    # -- summary -------------------------------------------------------------

    def test_summary_keys_are_pinned(self):
        r = self.call("summary", "--cache", self.cache)
        self.assertEqual(sorted(r), ["code", "entries", "fetched_at", "generated_at",
                                     "installs_at", "message", "models", "ok"])
        self.assertTrue(r["ok"])
        self.assertEqual(sorted(r["entries"]), [self.PID])
        self.assertEqual(sorted(r["entries"][self.PID]), ["components", "installs", "total"])
        self.assertEqual(r["entries"][self.PID],
                         {"installs": 404331, "components": {"commands": 1}, "total": 1})
        self.assertEqual(r["fetched_at"], "2026-08-06T04:31:43.504Z")
        self.assertEqual(r["generated_at"], "2026-08-06T04:00:00Z")
        self.assertEqual(r["installs_at"], "2026-08-05T00:00:00Z")
        self.assertEqual(r["models"], ["claude-opus-4-7", "claude-sonnet-4-6"])

    def test_summary_failure_still_carries_an_empty_entries_map(self):
        # entries 를 빼면 호출부가 undefined 를 순회한다.
        r = self.call("summary", "--cache", os.path.join(self.tmp, "gone.json"))
        self.assertFalse(r["ok"])
        self.assertEqual(r["code"], "cache_unavailable")
        self.assertEqual(r["entries"], {})
        self.assertIn("gone.json", r["message"])

    def test_cache_option_before_subcommand_also_works(self):
        r = self.call("--cache", self.cache, "summary")
        self.assertEqual(sorted(r["entries"]), [self.PID])

    # -- details -------------------------------------------------------------

    def test_details_record_is_flattened_to_top_level(self):
        r = self.call("details", self.PID, "--cache", self.cache)
        self.assertEqual(sorted(r), sorted(
            ["ok", "code", "message", "id", "name", "marketplace", "description", "author", "homepage",
             "category", "installs", "last_updated", "version", "sha", "source_sha",
             "components", "counts", "total", "tokens"]))
        self.assertTrue(r["ok"])
        self.assertEqual(r["id"], self.PID)
        self.assertEqual(r["installs"], 404331)
        self.assertEqual(r["components"]["commands"], ["code-review"])
        self.assertEqual(r["counts"], {"commands": 1})
        self.assertEqual(r["total"], 1)
        self.assertNotIn("details", r)          # 중첩 금지

    def test_details_author_is_a_string_and_components_are_string_arrays(self):
        # 이번 작업의 핵심 회귀 가드가 프로세스 경계(JSON)를 넘어서도 유지되는지.
        r = self.call("details", self.PID, "--cache", self.cache)
        self.assertIsInstance(r["author"], str)
        self.assertEqual(r["author"], "Anthropic")
        for kind, names in r["components"].items():
            self.assertTrue(all(isinstance(n, str) for n in names), (kind, names))

    def test_unknown_id_reports_failure_with_the_requested_id(self):
        r = self.call("details", "nope@other-market", "--cache", self.cache)
        self.assertEqual(sorted(r), ["code", "id", "message", "ok", "target"])
        self.assertFalse(r["ok"])
        self.assertEqual(r["code"], "not_found")
        self.assertEqual(r["id"], "nope@other-market")

    def test_details_on_a_missing_cache_reports_failure(self):
        r = self.call("details", self.PID, "--cache", os.path.join(self.tmp, "gone.json"))
        self.assertFalse(r["ok"])
        self.assertEqual(r["code"], "cache_unavailable")
        self.assertEqual(r["id"], self.PID)
        self.assertIn("gone.json", r["message"])


if __name__ == "__main__":
    unittest.main()
