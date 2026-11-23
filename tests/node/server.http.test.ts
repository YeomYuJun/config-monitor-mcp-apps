// src/server.ts(HTTP 대시보드 서버)를 실제로 띄워 확인한다: Host/Origin 게이트, REST 인자 검증, 대화용 도구 표면.
// tests/test_http_guard.py, tests/test_conversational_tools.py 를 옮긴 것.
// 서버는 임시 홈·스토어로 띄운다(이 PC 의 ~/.claude 와 스냅샷 스토어를 읽거나 쓰지 않는다).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cas from "../../src/core/cas.ts";
import { gitAvailable } from "../../src/core/remote_fetch.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Res { status: number; body: string; headers: http.IncomingHttpHeaders }

function req(port: number, method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8"), headers: res.headers }));
    });
    r.on("error", reject);
    r.setTimeout(60_000, () => r.destroy(new Error("timed out")));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

let tmp = "", store = "", port = 0;
let proc: ChildProcess | null = null;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "server_http_test_"));
  const home = path.join(tmp, "home");
  store = path.join(tmp, "store");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  await cas.cmdInit({ store });
  port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE_|CONFIG_MONITOR_|HOMEDRIVE$|HOMEPATH$)/i.test(k)) env[k] = v;
  Object.assign(env, {
    PORT: String(port), HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"), CLAUDE_SNAPSHOT_STORE: store, CLAUDE_CONFIG_LIBRARIES: path.join(tmp, "nolib"),
  });
  proc = spawn(process.execPath, ["--import", "tsx", path.join(REPO, "src", "server.ts")], { cwd: REPO, env, stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error(`서버가 조기 종료됨: ${proc.exitCode}`);
    if (await req(port, "GET", "/health").then((r) => r.status === 200, () => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("서버가 준비되지 않음");
});

after(async () => {
  if (proc && proc.exitCode === null) {
    const done = new Promise((r) => proc!.once("exit", r));
    proc.kill();
    await done;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${port}`;
const callTool = (name = "list_projects", headers: Record<string, string> = {}, body = "{}") =>
  req(port, "POST", `/api/tool/${name}`, { "content-type": "application/json", ...headers }, body);

async function tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const r = await callTool(name, {}, JSON.stringify(args));
  assert.equal(r.status, 200, r.body);
  return JSON.parse(JSON.parse(r.body).text);
}

describe("Host and Origin gate", () => {
  test("a cross-origin POST is rejected", async () => {
    assert.equal((await callTool("list_projects", { Origin: "https://evil.example" })).status, 403);
  });

  test("a cross-origin preflight is rejected without CORS headers", async () => {
    const r = await req(port, "OPTIONS", "/api/tool/list_projects", { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" });
    assert.equal(r.status, 403);
    assert.ok(!("access-control-allow-origin" in r.headers));
  });

  test("the null origin is rejected", async () => {
    // sandboxed iframe / file:// 은 문자열 "null" 을 보낸다 - '헤더 없음'과 같이 보면 안 된다.
    assert.equal((await callTool("list_projects", { Origin: "null" })).status, 403);
  });

  test("another loopback port is a foreign origin", async () => {
    assert.equal((await callTool("list_projects", { Origin: "http://127.0.0.1:1" })).status, 403);
  });

  test("a simple request without preflight is rejected", async () => {
    // no-cors + text/plain 은 프리플라이트를 타지 않는다. 응답을 못 읽어도 핸들러는 실행되므로 Origin 게이트가 막아야 한다.
    const r = await req(port, "POST", "/api/tool/watcher_stop", { "content-type": "text/plain", Origin: "https://evil.example" }, "{}");
    assert.equal(r.status, 403);
  });

  test("REST rejects arguments that fail the schema", async () => {
    const r = await callTool("get_diff");
    assert.equal(r.status, 400, r.body);
  });

  test("REST does not resolve prototype keys", async () => {
    assert.equal((await callTool("constructor")).status, 404);
  });

  test("a DNS rebinding host is rejected, including the dashboard", async () => {
    // 대시보드('/')까지 막아야 한다. 여기서 HTML 을 내주면 그 오리진이 같은-오리진이 된다.
    assert.equal((await req(port, "GET", "/", { Host: "evil.example" })).status, 403);
  });

  test("the MCP endpoint is gated too", async () => {
    const r = await req(port, "POST", "/mcp", {
      "content-type": "application/json", Origin: "https://evil.example", accept: "application/json, text/event-stream",
    }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    assert.equal(r.status, 403);
  });

  test("a same-origin POST still works and gets the CORS header", async () => {
    const r = await callTool("list_projects", { Origin: base() });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers["access-control-allow-origin"], base());
  });

  test("a request without Origin still works", async () => {
    // curl · type:http MCP 커넥터는 Origin 을 보내지 않는다. 브라우저가 아니므로 통과.
    assert.equal((await callTool()).status, 200);
  });

  test("MCP tools/list without Origin still works", async () => {
    const r = await req(port, "POST", "/mcp", { "content-type": "application/json", accept: "application/json, text/event-stream" },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    assert.equal(r.status, 200, r.body);
    assert.ok(JSON.parse(r.body).result.tools.length);
  });
});

describe("conversational tool surface", () => {
  test("get_config forwards the section filter and compact", async () => {
    const d = await tool("get_config", { sections: ["hooks", "perm"], compact: true });
    assert.deepEqual(d.sections.map((s: any) => s.id).sort(), ["hooks", "perm"]);
    for (const sec of d.sections) for (const c of sec.cards) assert.ok(!("kv" in c), "compact 카드에 kv 가 남아 있다");
  });

  test("summarize_config has the overview shape", async () => {
    const d = await tool("summarize_config");
    assert.ok("collisions" in d && "plugins" in d);
    const ids = new Set(d.sections.map((s: any) => s.id));
    for (const id of ["hooks", "perm", "skills"]) assert.ok(ids.has(id), id);
    assert.ok(d.sections.every((s: any) => "names" in s && "count" in s));
  });

  test("an unknown project is refused with candidates before editing", async () => {
    const d = await tool("config_perm_add", { kind: "allow", rule: "Bash(echo x)", project: "no-such-project-zzz" });
    assert.equal(d.ok, false);
    assert.ok(d.message.includes("no-such-project-zzz"));
    assert.ok(Array.isArray(d.candidates));
  });

  test("a successful write bumps the change marker seen by get_tracked", async () => {
    const before0 = (await tool("get_tracked")).change?.seq ?? 0;
    const probe = path.join(store, "probe.json");
    fs.writeFileSync(probe, "{}");
    const r = await tool("config_track", { path: probe });
    assert.notEqual(r.ok, false, JSON.stringify(r));
    const after0 = (await tool("get_tracked")).change;
    assert.ok(after0.seq > before0);
    assert.equal(after0.tool, "config_track");
    assert.equal(JSON.parse(fs.readFileSync(path.join(store, "changes.json"), "utf-8")).seq, after0.seq);
    await tool("config_untrack", { path: probe });
  });

  test("read-only and UI-only tools do not bump the marker", async () => {
    const a = (await tool("get_tracked")).change?.seq ?? 0;
    await tool("summarize_config");
    await tool("set_prefs", { view: { selectedPath: "x" } });
    const b = (await tool("get_tracked")).change?.seq ?? 0;
    assert.equal(a, b, "화면 옵션 저장은 다른 위젯을 다시 그리게 하지 않는다");
  });

  test("the boot phase is logged for diagnosis, polls are not", async () => {
    await tool("get_tracked", { phase: "boot", instance: "abc123" });
    await tool("get_tracked", { phase: "poll", instance: "abc123" });
    const log = fs.readFileSync(path.join(store, "widget.log"), "utf-8");
    assert.ok(log.includes(" boot abc123"));
    assert.ok(!log.includes(" poll "));
  });

  test("plugin_catalog picks summary or details by id", async () => {
    const cache = path.join(store, "no-such-catalog.json");
    const s = await tool("plugin_catalog", { cache });
    assert.ok("entries" in s && !("id" in s));
    const d = await tool("plugin_catalog", { id: "x@m", cache });
    assert.equal(d.id, "x@m");
    assert.ok(!("entries" in d));
  });

  test("library_add routes by kind and refuses map for a marketplace", { skip: !gitAvailable() && "git 없음" }, async () => {
    const r = await tool("library_add", { kind: "remote", url: "https://example.invalid/r.git", map: "notjson" });
    assert.ok(r.message.includes("--map is not valid JSON"), r.message);
    const m = await tool("library_add", { kind: "market", url: "  " });
    assert.ok(m.message.includes("Market source is empty"), m.message);
    const bad = await tool("library_add", { kind: "market", url: "https://example.invalid/m.git", map: "{}" });
    assert.equal(bad.ok, false);
    assert.ok(bad.message.includes("only with kind=remote"));
  });
});
