#!/usr/bin/env python3
r"""
test_http_guard.py - server.ts 의 Host/Origin 게이트 회귀 가드.

server.ts 는 47개 도구를 REST 로 노출한다(config_mcp_add · config_hook_add · config_restore 포함).
루프백 바인딩은 네트워크만 막고 브라우저 오리진은 못 막으므로, 같은 PC 의 아무 페이지나
fetch 로 닿을 수 있었다. 그 구멍이 다시 열리는지 실제 서버를 띄워 확인한다.

TS 쪽 테스트 러너를 새로 들이지 않고 기존 python 스위트에 붙인다 - 검증 대상이
"빌드된 코드의 HTTP 동작"이라 프로세스 밖에서 보는 편이 오히려 정확하다.
node/npx 가 없으면 건너뛴다.
"""
import json, os, shutil, socket, subprocess, sys, time, unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "src", "server.ts")

NPX = shutil.which("npx") or shutil.which("npx.cmd")


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _req(url, method="GET", headers=None, body=None):
    """(status, body). 4xx/5xx 도 예외 대신 상태코드로 돌려준다."""
    r = urllib.request.Request(url, method=method, data=body,
                               headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8", "replace"), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), dict(e.headers)


@unittest.skipUnless(NPX, "npx 없음 - node 툴체인이 있어야 서버를 띄운다")
class HttpOriginGuard(unittest.TestCase):
    proc = None
    port = None

    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = dict(os.environ)
        env["PORT"] = str(cls.port)
        cls.proc = subprocess.Popen([NPX, "tsx", SERVER], cwd=ROOT, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{cls.port}"
        for _ in range(120):                      # tsx 콜드 스타트가 수 초 걸린다
            if cls.proc.poll() is not None:
                raise RuntimeError("서버가 조기 종료됨: " + cls.proc.stdout.read().decode("utf-8", "replace"))
            try:
                if _req(base + "/health")[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(0.5)
        raise RuntimeError("서버가 준비되지 않음")

    @classmethod
    def tearDownClass(cls):
        if not cls.proc:
            return
        # npx 가 node 자식을 띄우므로 트리째 끊는다(terminate 만으로는 포트가 남는다).
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(cls.proc.pid)],
                           capture_output=True)
        else:
            cls.proc.terminate()
        cls.proc.wait(timeout=30)

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def tool(self, name="list_projects", headers=None):
        h = {"content-type": "application/json"}
        h.update(headers or {})
        return _req(f"{self.base}/api/tool/{name}", "POST", h, b"{}")

    # ----- 막아야 하는 것 -----

    def test_cross_origin_post_is_rejected(self):
        self.assertEqual(self.tool(headers={"Origin": "https://evil.example"})[0], 403)

    def test_cross_origin_preflight_is_rejected(self):
        st, _, hdr = _req(f"{self.base}/api/tool/list_projects", "OPTIONS",
                          {"Origin": "https://evil.example",
                           "Access-Control-Request-Method": "POST"})
        self.assertEqual(st, 403)
        self.assertNotIn("access-control-allow-origin", {k.lower() for k in hdr})

    def test_origin_null_is_rejected(self):
        # sandboxed iframe / file:// 은 문자열 "null" 을 보낸다 - '헤더 없음'과 같이 보면 안 된다.
        self.assertEqual(self.tool(headers={"Origin": "null"})[0], 403)

    def test_other_loopback_port_is_rejected(self):
        # 같은 PC 의 다른 포트에서 도는 페이지도 남의 오리진이다.
        self.assertEqual(self.tool(headers={"Origin": "http://127.0.0.1:1"})[0], 403)

    def test_simple_request_without_preflight_is_rejected(self):
        # no-cors + text/plain 은 프리플라이트를 타지 않는다. CORS 설정이 아니라
        # Origin 게이트가 막아야 하는 경로 - 응답을 못 읽어도 핸들러는 실행되기 때문이다.
        st, _, _ = _req(f"{self.base}/api/tool/watcher_stop", "POST",
                        {"content-type": "text/plain", "Origin": "https://evil.example"}, b"{}")
        self.assertEqual(st, 403)

    def test_dns_rebinding_host_is_rejected(self):
        # 대시보드('/')까지 막아야 한다. 여기서 HTML 을 내주면 그 오리진이 같은-오리진이 된다.
        self.assertEqual(_req(self.base + "/", headers={"Host": "evil.example"})[0], 403)

    def test_mcp_endpoint_is_gated_too(self):
        st, _, _ = _req(f"{self.base}/mcp", "POST",
                        {"content-type": "application/json", "Origin": "https://evil.example",
                         "accept": "application/json, text/event-stream"},
                        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode())
        self.assertEqual(st, 403)

    # ----- 계속 되어야 하는 것 -----

    def test_same_origin_post_still_works(self):
        st, body, hdr = self.tool(headers={"Origin": self.base})
        self.assertEqual(st, 200, body)
        self.assertEqual({k.lower(): v for k, v in hdr.items()}
                         .get("access-control-allow-origin"), self.base)

    def test_request_without_origin_still_works(self):
        # curl · type:http MCP 커넥터는 Origin 을 보내지 않는다. 브라우저가 아니므로 통과.
        self.assertEqual(self.tool()[0], 200)

    def test_mcp_tools_list_without_origin_still_works(self):
        st, body, _ = _req(f"{self.base}/mcp", "POST",
                           {"content-type": "application/json",
                            "accept": "application/json, text/event-stream"},
                           json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode())
        self.assertEqual(st, 200, body)
        self.assertTrue(json.loads(body)["result"]["tools"])


if __name__ == "__main__":
    unittest.main()
