#!/usr/bin/env python3
r"""
test_conversational_tools.py - 대화에서 Claude 가 부르는 도구 표면의 회귀 가드.

server.ts 의 REST 는 MCP 와 같은 buildTools 핸들러를 쓰므로, 여기서 확인하는 것은
도구 정의 한 겹(필터 전달 · project 해석 · 변경 표식) 그 자체다. 임시 스토어를 초기화해
띄우므로 이 PC 의 실제 스냅샷 스토어는 건드리지 않는다. node/npx 가 없으면 건너뛴다.
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time, unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "src", "server.ts")
CAS = os.path.join(ROOT, "src", "cas.py")

NPX = shutil.which("npx") or shutil.which("npx.cmd")


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _post(url, body):
    r = urllib.request.Request(url, method="POST", data=json.dumps(body).encode("utf-8"),
                               headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


@unittest.skipUnless(NPX, "npx 없음 - node 툴체인이 있어야 서버를 띄운다")
class ConversationalTools(unittest.TestCase):
    proc = None

    @classmethod
    def setUpClass(cls):
        cls.store = tempfile.mkdtemp(prefix="cm-store-")
        subprocess.run([sys.executable, CAS, "--store", cls.store, "init"], check=True,
                       capture_output=True, timeout=60)
        cls.port = _free_port()
        env = dict(os.environ, PORT=str(cls.port), CLAUDE_SNAPSHOT_STORE=cls.store)
        cls.proc = subprocess.Popen([NPX, "tsx", SERVER], cwd=ROOT, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{cls.port}"
        for _ in range(120):
            if cls.proc.poll() is not None:
                raise RuntimeError("서버가 조기 종료됨: " + cls.proc.stdout.read().decode("utf-8", "replace"))
            try:
                with urllib.request.urlopen(base + "/health", timeout=5) as r:
                    if r.status == 200:
                        return
            except OSError:
                pass
            time.sleep(0.5)
        raise RuntimeError("서버가 준비되지 않음")

    @classmethod
    def tearDownClass(cls):
        if cls.proc:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(cls.proc.pid)], capture_output=True)
            else:
                cls.proc.terminate()
            cls.proc.wait(timeout=30)
        shutil.rmtree(cls.store, ignore_errors=True)

    def tool(self, name, **args):
        status, body = _post(f"http://127.0.0.1:{self.port}/api/tool/{name}", args)
        self.assertEqual(status, 200, body)
        return json.loads(body["text"])

    def test_get_config_forwards_section_filter_and_compact(self):
        d = self.tool("get_config", sections=["hooks", "perm"], compact=True)
        self.assertEqual(sorted(s["id"] for s in d["sections"]), ["hooks", "perm"])
        for sec in d["sections"]:
            for c in sec["cards"]:
                self.assertNotIn("kv", c, "compact 카드에 kv 가 남아 있다")

    def test_summarize_config_has_overview_shape(self):
        d = self.tool("summarize_config")
        self.assertIn("collisions", d)
        self.assertIn("plugins", d)
        ids = {s["id"] for s in d["sections"]}
        self.assertTrue({"hooks", "perm", "skills"} <= ids, ids)
        self.assertTrue(all("names" in s and "count" in s for s in d["sections"]))

    def test_unknown_project_is_refused_with_candidates_before_editing(self):
        d = self.tool("config_perm_add", kind="allow", rule="Bash(echo x)",
                      project="no-such-project-zzz")
        self.assertFalse(d["ok"])
        self.assertIn("no-such-project-zzz", d["message"])
        self.assertIsInstance(d["candidates"], list)

    def test_successful_write_bumps_the_change_marker_seen_by_get_tracked(self):
        before = self.tool("get_tracked").get("change", {}).get("seq", 0)
        r = self.tool("set_prefs", sections={"hideEmpty": True})
        self.assertNotEqual(r.get("ok"), False, r)
        after = self.tool("get_tracked")["change"]
        self.assertGreater(after["seq"], before)
        self.assertEqual(after["tool"], "set_prefs")
        marker = json.load(open(os.path.join(self.store, "changes.json"), encoding="utf-8-sig"))
        self.assertEqual(marker["seq"], after["seq"])

    def test_read_only_tool_does_not_bump_the_marker(self):
        a = self.tool("get_tracked").get("change", {}).get("seq", 0)
        self.tool("summarize_config")
        b = self.tool("get_tracked").get("change", {}).get("seq", 0)
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
