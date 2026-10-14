#!/usr/bin/env python3
"""transfer.py export 테스트. 가짜 HOME 을 만들어 서브프로세스로 돌린다.

번들은 공유 폴더로 나간다. 시크릿 값이 어디에도 없어야 하고, 번들에 담지 못하는 외부 경로는
빠짐없이 보고돼야 한다.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
TRANSFER = os.path.join(SRC, "transfer.py")
SECRET = "ghp_" + "Ab1" * 12


def write(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


def make_home(root, ext):
    """ext = ~/.claude 밖의 실재 폴더(훅·MCP 가 가리킨다)."""
    home = os.path.join(root, "home")
    ch = os.path.join(home, ".claude")
    write(os.path.join(ch, "skills", "qa", "SKILL.md"), "---\ndescription: q\n---\n")
    write(os.path.join(ch, "skills", "synced", "acct", "x", "SKILL.md"), "synced\n")
    write(os.path.join(ch, "agents", "rev.md"), "---\ndescription: r\n---\n")
    write(os.path.join(ch, "hooks", "guard.py"), "print(1)\n")
    write(os.path.join(ext, "hook.js"), "//\n")
    write(os.path.join(ch, "settings.json"), json.dumps({
        "feedbackDrafts": {"x": 1},
        "statusLine": {"type": "command", "command": f'node "{os.path.join(ch, "hooks", "guard.py")}"'},
        "hooks": {"Stop": [{"hooks": [{"type": "command", "command": f'node "{os.path.join(ext, "hook.js")}"'}]}]},
        "env": {"API_TOKEN": SECRET},
        "model": "sonnet",
        "permissions": {"allow": ["Bash(ls)"]},
    }))
    write(os.path.join(home, ".claude.json"), json.dumps({
        "oauthAccount": {"emailAddress": "a@b"},
        "mcpServers": {"srv": {"command": "node", "args": [os.path.join(ext, "srv", "index.js")],
                               "env": {"GITHUB_TOKEN": SECRET}}},
    }))
    desk = os.path.join(home, "AppData", "Roaming", "Claude")
    write(os.path.join(desk, "claude_desktop_config.json"), json.dumps({
        "mcpServers": {"dsk": {"command": "node", "args": [os.path.join(desk, "dsk.js")]}}}))
    return home


def tree_state(root):
    out = {}
    for d, dirs, files in os.walk(root):
        out.update({os.path.relpath(os.path.join(d, x), root): "dir" for x in dirs})
        for fn in files:
            p = os.path.join(d, fn)
            with open(p, "rb") as f:
                out[os.path.relpath(p, root)] = hashlib.sha256(f.read()).hexdigest()
    return out


def run(home, *args, **extra_env):
    env = dict(os.environ, **extra_env, HOME=home, USERPROFILE=home, CLAUDE_CAS_NO_DEFAULT_TRACK="0",
               APPDATA=os.path.join(home, "AppData", "Roaming"),
               LOCALAPPDATA=os.path.join(home, "AppData", "Local"),
               CLAUDE_SNAPSHOT_STORE=os.path.join(home, "store"))
    p = subprocess.run([sys.executable, TRANSFER, *args], capture_output=True, text=True,
                       encoding="utf-8", env=env, timeout=60)
    return json.loads(p.stdout)


class TestExport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="transfer_test_")
        self.ext = os.path.join(self.tmp, "tools")
        self.home = make_home(self.tmp, self.ext)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_zip_bundle_counts_external_paths_and_keeps_secrets_out(self):
        out = os.path.join(self.tmp, "a.cmbundle")
        res = run(self.home, "export", "--out", out)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["counts"]["cc.skills"], 1)
        self.assertIn({"id": "cc.skills/synced", "reason": "claude.ai 계정 동기화 폴더"}, res["skipped"])

        ext = {(e["kind"], os.path.normcase(e["path"])) for e in res["external"]}
        self.assertIn(("hook", os.path.normcase(os.path.join(self.ext, "hook.js"))), ext)
        self.assertIn(("mcp", os.path.normcase(os.path.join(self.ext, "srv", "index.js"))), ext)
        self.assertTrue(any("번들링 불가능 외부 설정" in l for l in res["report"]))

        with zipfile.ZipFile(out) as z:
            names = z.namelist()
            blobs = b"".join(z.read(n) for n in names)
            settings = json.loads(z.read("json/cc.settings.json"))
        self.assertNotIn(SECRET.encode(), blobs)
        self.assertNotIn(b"a@b", blobs)
        self.assertNotIn("feedbackDrafts", settings)
        self.assertIn("files/${CLAUDE_HOME}/hooks/guard.py", names)   # ~/.claude 안 참조는 번들에 들어간다
        self.assertIn("${CLAUDE_HOME}", settings["statusLine"]["command"])
        self.assertEqual({s["path"] for s in res["secrets"]}, {"env.API_TOKEN", "env.GITHUB_TOKEN"})

    def test_include_secrets_puts_values_only_in_secrets_json_and_says_so(self):
        out = os.path.join(self.tmp, "s.cmbundle")
        res = run(self.home, "export", "--out", out, "--include-secrets")
        self.assertTrue(any("평문" in l for l in res["report"]), res["report"])
        self.assertTrue(res["warnings"])
        with zipfile.ZipFile(out) as z:
            self.assertIn(SECRET, z.read("secrets.json").decode("utf-8"))
            self.assertFalse(any(SECRET.encode() in z.read(n) for n in z.namelist() if n != "secrets.json"))

    def test_same_content_under_another_home_hashes_the_same(self):
        other = make_home(os.path.join(self.tmp, "b"), self.ext)
        a = run(self.home, "inventory")
        b = run(other, "inventory")
        h = lambda r: {i["id"]: i["hash"] for i in r["items"]}
        self.assertEqual(h(a)["cc.settings"], h(b)["cc.settings"])
        self.assertEqual(h(a)["cc.skills/qa"], h(b)["cc.skills/qa"])

    def test_folder_bundle_and_existing_target(self):
        out = os.path.join(self.tmp, "bundle-dir")
        self.assertTrue(run(self.home, "export", "--out", out)["ok"])
        self.assertTrue(os.path.isfile(os.path.join(out, "manifest.json")))
        self.assertEqual(run(self.home, "export", "--out", out)["code"], "exists")


class TestPlan(unittest.TestCase):
    """A 의 번들을 B(사용자명이 다른 빈 PC)에서 plan 한다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="transfer_plan_")
        self.ext = os.path.join(self.tmp, "tools")
        self.a = make_home(os.path.join(self.tmp, "a"), self.ext)
        self.bundle = os.path.join(self.tmp, "a-bundle")
        self.assertTrue(run(self.a, "export", "--out", self.bundle)["ok"])
        self.b = os.path.join(self.tmp, "b", "Users", "other")
        os.makedirs(self.b)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def states(self, res):
        return {i["id"]: i["state"] for i in res["items"]}

    def test_plan_on_empty_pc_writes_nothing(self):
        before = tree_state(os.path.dirname(self.b))
        res = run(self.b, "plan", "--bundle", self.bundle)
        self.assertTrue(res["ok"], res)
        self.assertEqual(before, tree_state(os.path.dirname(self.b)))
        st = self.states(res)
        self.assertEqual(st["cc.skills/qa"], "new")
        self.assertEqual(st["cc.settings"], "new")
        self.assertEqual(st["cc.skills/synced"], "skipped")
        srv = next(i for i in res["items"] if i["id"] == "cc.mcp-user/srv")
        self.assertEqual((srv["state"], srv["code"]), ("blocked", "secret_missing"))
        secrets = json.dumps({"cc.mcp-user/srv": {"env.GITHUB_TOKEN": "x"}})
        self.assertEqual(self.states(run(self.b, "plan", "--bundle", self.bundle, "--secrets", secrets))
                         ["cc.mcp-user/srv"], "new")

    def test_changed_skill_and_settings_conflict(self):
        write(os.path.join(self.b, ".claude", "skills", "qa", "SKILL.md"), "other\n")
        write(os.path.join(self.b, ".claude", "settings.json"),
              json.dumps({"model": "opus", "permissions": {"allow": ["Read"]}}))
        res = run(self.b, "plan", "--bundle", self.bundle)
        qa = next(i for i in res["items"] if i["id"] == "cc.skills/qa")
        self.assertEqual((qa["state"], qa["files"]["modified"]), ("changed", ["SKILL.md"]))
        st = next(i for i in res["items"] if i["id"] == "cc.settings")
        self.assertEqual((st["state"], st["conflicts"]), ("changed", ["model"]))
        self.assertTrue(any("Bash(ls)" in l for l in st["diff"]))

    def test_rejects_bundle_that_writes_outside_its_folder(self):
        mp = os.path.join(self.bundle, "manifest.json")
        with open(mp, encoding="utf-8") as f:
            m = json.load(f)
        next(i for i in m["items"] if i["id"] == "cc.skills/qa")["rel"] = "${CLAUDE_HOME}/../evil"
        with open(mp, "w", encoding="utf-8") as f:
            json.dump(m, f)
        self.assertEqual(run(self.b, "plan", "--bundle", self.bundle)["code"], "bundle_invalid")
        m["version"] = 2
        with open(mp, "w", encoding="utf-8") as f:
            json.dump(m, f)
        self.assertEqual(run(self.b, "plan", "--bundle", self.bundle)["code"], "bundle_version")


class TestApply(TestPlan):
    """B 는 사용자명이 다르고 Desktop 이 MSIX 설치본이다."""

    def setUp(self):
        super().setUp()
        self.msix = os.path.join(self.b, "AppData", "Local", "Packages", "Claude_x", "LocalCache", "Roaming", "Claude")
        os.makedirs(self.msix)

    def apply(self, bundle, *extra):
        pid = run(self.b, "plan", "--bundle", bundle, *extra)["plan_id"]
        return run(self.b, "apply", "--bundle", bundle, "--plan-id", pid, *extra)

    def load(self, *parts):
        with open(os.path.join(self.b, *parts), encoding="utf-8-sig") as f:
            return json.load(f)

    def test_apply_on_empty_pc_then_plan_is_all_same(self):
        sb = os.path.join(self.tmp, "a-secrets.cmbundle")
        self.assertTrue(run(self.a, "export", "--out", sb, "--include-secrets")["ok"])
        res = self.apply(sb)
        self.assertEqual(res["code"], "ok", res)
        self.assertTrue(res["post_snapshot"])
        again = run(self.b, "plan", "--bundle", sb)
        self.assertEqual({i["state"] for i in again["items"]} - {"skipped"}, {"same"}, again["items"])

        settings = self.load(".claude", "settings.json")
        self.assertNotIn("${", json.dumps(settings))
        self.assertIn(os.path.join(self.b, ".claude", "hooks", "guard.py").lower(),
                      settings["statusLine"]["command"].lower())
        self.assertEqual(self.load(".claude.json")["mcpServers"]["srv"]["env"]["GITHUB_TOKEN"], SECRET)
        dsk = self.load("AppData", "Local", "Packages", "Claude_x", "LocalCache", "Roaming", "Claude",
                        "claude_desktop_config.json")["mcpServers"]["dsk"]
        self.assertTrue(dsk["args"][0].lower().startswith(self.msix.lower()), dsk)
        self.assertFalse(os.path.exists(os.path.join(self.b, "AppData", "Roaming", "Claude")))

    def test_merge_trash_and_undo_restore_bytes(self):
        skill = os.path.join(self.b, ".claude", "skills", "qa", "SKILL.md")
        sp = os.path.join(self.b, ".claude", "settings.json")
        write(skill, "other\n")
        write(sp, json.dumps({"model": "opus", "permissions": {"allow": ["Read"]}}))
        with open(sp, "rb") as f, open(skill, "rb") as g:
            orig, orig_skill = f.read(), g.read()
        res = self.apply(self.bundle)
        self.assertEqual(res["code"], "ok", res)
        settings = self.load(".claude", "settings.json")
        self.assertEqual(settings["model"], "opus")
        self.assertEqual(settings["permissions"]["allow"], ["Read", "Bash(ls)"])
        self.assertFalse(os.path.exists(os.path.join(self.b, ".claude.json")))  # 시크릿 없는 서버는 쓰지 않는다
        self.assertEqual(len(os.listdir(os.path.join(self.b, ".claude", "skills", ".trash"))), 1)

        self.assertEqual(run(self.b, "history")["imports"][0]["id"], res["import_id"])
        undo = run(self.b, "undo", "--import-id", res["import_id"])
        self.assertEqual(undo["code"], "ok", undo)
        with open(skill, "rb") as f:
            self.assertEqual(f.read(), orig_skill)
        with open(sp, "rb") as f:
            self.assertEqual(f.read(), orig)
        self.assertFalse(os.path.exists(os.path.join(self.b, ".claude", "agents", "rev.md")))
        self.assertEqual(run(self.b, "undo", "--import-id", res["import_id"])["code"], "noop")

    def test_apply_refuses_when_target_changed_after_plan(self):
        pid = run(self.b, "plan", "--bundle", self.bundle)["plan_id"]
        write(os.path.join(self.b, ".claude", "skills", "qa", "SKILL.md"), "late\n")
        res = run(self.b, "apply", "--bundle", self.bundle, "--plan-id", pid)
        self.assertEqual(res["code"], "plan_stale")


class TestOptional(TestApply):
    """기본 제외 항목: 프로젝트 메모리, 에이전트 메모리, 플러그인 설치."""
    test_plan_on_empty_pc_writes_nothing = test_changed_skill_and_settings_conflict = None
    test_rejects_bundle_that_writes_outside_its_folder = test_apply_on_empty_pc_then_plan_is_all_same = None
    test_merge_trash_and_undo_restore_bytes = test_apply_refuses_when_target_changed_after_plan = None

    def setUp(self):
        super().setUp()
        ch = os.path.join(self.a, ".claude")
        self.proj_a = os.path.join(self.a, "work", "p1")
        os.makedirs(self.proj_a)
        with open(os.path.join(self.a, ".claude.json"), encoding="utf-8") as f:
            cj = json.load(f)
        cj["projects"] = {self.proj_a: {}}
        write(os.path.join(self.a, ".claude.json"), json.dumps(cj))
        enc = "".join(c if c.isalnum() and c.isascii() else "-" for c in self.proj_a)
        write(os.path.join(ch, "projects", enc, "memory", "MEMORY.md"), "- note\n")
        write(os.path.join(ch, "projects", "orphan", "memory", "MEMORY.md"), "x\n")
        write(os.path.join(ch, "agent-memory", "rev", "notes.md"), "n\n")
        write(os.path.join(ch, "plugins", "installed_plugins.json"),
              json.dumps({"version": 2, "plugins": {"x@mk": [{"scope": "user", "installPath": "c"}]}}))
        with open(os.path.join(ch, "settings.json"), encoding="utf-8") as f:
            st = json.load(f)
        st["extraKnownMarketplaces"] = {"mk": {"source": {"source": "github", "repo": "o/mk"}}}
        write(os.path.join(ch, "settings.json"), json.dumps(st))
        self.obundle = os.path.join(self.tmp, "opt-bundle")
        res = run(self.a, "export", "--out", self.obundle, "--with-optional", "memory,agent-memory")
        self.assertTrue(res["ok"], res)
        self.assertIn("cc.project-memory/orphan", {x["id"] for x in res["skipped"]})

    def test_project_memory_follows_the_project_path_on_this_pc(self):
        mid = next(i["id"] for i in run(self.b, "plan", "--bundle", self.obundle)["items"]
                   if i["id"].startswith("cc.project-memory/"))
        st = lambda: {i["id"]: i for i in run(self.b, "plan", "--bundle", self.obundle)["items"]}
        self.assertEqual(st()[mid]["code"], "project_missing")
        proj_b = os.path.join(self.b, "work", "p1")
        os.makedirs(proj_b)
        row = st()[mid]
        enc_b = "".join(c if c.isalnum() and c.isascii() else "-" for c in proj_b)
        self.assertEqual(row["target"], os.path.join(self.b, ".claude", "projects", enc_b, "memory"))
        self.assertEqual(self.apply(self.obundle)["code"], "ok")
        self.assertTrue(os.path.isfile(os.path.join(row["target"], "MEMORY.md")))
        self.assertTrue(os.path.isfile(os.path.join(self.b, ".claude", "agent-memory", "rev", "notes.md")))

    def test_install_plugins_reports_each_plugin(self):
        pid = run(self.b, "plan", "--bundle", self.obundle)["plan_id"]
        res = run(self.b, "apply", "--bundle", self.obundle, "--plan-id", pid, "--install-plugins",
                  PATH=os.path.dirname(sys.executable))
        self.assertEqual(res["code"], "partial", res)
        self.assertEqual([(p["id"], p["code"]) for p in res["plugins"]], [("x@mk", "tool_missing")])
        self.assertEqual(self.load(".claude", "settings.json")["enabledPlugins"], {"x@mk": True})
        pid = run(self.b, "plan", "--bundle", self.obundle)["plan_id"]       # 설정은 이미 같고 설치만 남았다
        again = run(self.b, "apply", "--bundle", self.obundle, "--plan-id", pid, "--install-plugins",
                    PATH=os.path.dirname(sys.executable))
        self.assertEqual((again["code"], [p["id"] for p in again["plugins"]]), ("partial", ["x@mk"]))


class TestSync(unittest.TestCase):
    """두 PC 가 공유 폴더 하나로 push / pull 하고, 양쪽이 바뀌면 diverged 로 본다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="transfer_sync_")
        self.sync = os.path.join(self.tmp, "sync")
        os.makedirs(self.sync)
        self.a = make_home(os.path.join(self.tmp, "a"), os.path.join(self.tmp, "tools"))
        self.b = os.path.join(self.tmp, "b", "home")
        os.makedirs(self.b)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def states(self, home, frm):
        res = run(home, "sync-status", "--from", frm)
        self.assertTrue(res["ok"], res)
        return {i["id"]: i["state"] for i in res["items"]}

    def test_push_pull_then_both_sides_change(self):
        self.assertEqual(run(self.b, "sync-push")["code"], "sync_unconfigured")
        for home, name in ((self.a, "pc-a"), (self.b, "pc-b")):
            self.assertTrue(run(home, "sync-setup", "--dir", self.sync, "--profile", name)["ok"])
        self.assertTrue(run(self.a, "sync-push")["ok"])
        self.assertEqual([p["profile"] for p in run(self.b, "sync-status")["profiles"]], ["pc-a"])

        pid = run(self.b, "plan", "--sync-from", "pc-a")["plan_id"]
        self.assertEqual(run(self.b, "sync-pull", "--from", "pc-a", "--plan-id", pid)["code"], "ok")
        st = self.states(self.b, "pc-a")
        self.assertEqual((st["cc.skills/qa"], st["cc.agents/rev.md"]), ("in-sync", "in-sync"))
        self.assertEqual(st["cc.mcp-user/srv"], "untracked")        # 시크릿이 없어 가져오지 못했다

        write(os.path.join(self.a, ".claude", "skills", "qa", "SKILL.md"), "a2\n")
        write(os.path.join(self.a, ".claude", "agents", "rev.md"), "a2\n")
        self.assertTrue(run(self.a, "sync-push")["ok"])
        write(os.path.join(self.b, ".claude", "skills", "qa", "SKILL.md"), "b2\n")
        st = self.states(self.b, "pc-a")
        self.assertEqual((st["cc.skills/qa"], st["cc.agents/rev.md"]), ("diverged", "remote-ahead"))


if __name__ == "__main__":
    unittest.main()
