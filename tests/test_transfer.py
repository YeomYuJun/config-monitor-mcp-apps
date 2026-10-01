#!/usr/bin/env python3
"""transfer.py export 테스트. 가짜 HOME 을 만들어 서브프로세스로 돌린다.

번들은 공유 폴더로 나간다. 시크릿 값이 어디에도 없어야 하고, 번들에 담지 못하는 외부 경로는
빠짐없이 보고돼야 한다.
"""
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
    }))
    write(os.path.join(home, ".claude.json"), json.dumps({
        "oauthAccount": {"emailAddress": "a@b"},
        "mcpServers": {"srv": {"command": "node", "args": [os.path.join(ext, "srv", "index.js")],
                               "env": {"GITHUB_TOKEN": SECRET}}},
    }))
    return home


def run(home, *args):
    env = dict(os.environ, HOME=home, USERPROFILE=home,
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


if __name__ == "__main__":
    unittest.main()
