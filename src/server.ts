#!/usr/bin/env node
// server.ts - HTTP transport. 3가지를 서빙한다:
//   POST /mcp            MCP Streamable HTTP (type:http 커넥터용)
//   GET  /               라이브 대시보드(standalone 플래그 주입 -> 브라우저에서 fetch REST 사용)
//   POST /api/tool/:name 도구 REST (MCP 와 동일한 buildTools 핸들러 공유)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { autoStartWatcher, registerAll, buildTools, langScript } from "./mcp-tools.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3002);

// REST 용 도구 맵 (MCP 와 동일 핸들러)
const toolMap = new Map(buildTools(__dirname).map((d) => [d.name, d]));

// 루프백 바인딩은 네트워크만 막고 **브라우저 오리진은 못 막는다** - 같은 PC 에서 열린 아무
// 페이지나 fetch 로 여기 닿을 수 있다. /api/tool/:name 은 편집 도구(mcp-add · hook-add · restore)를
// 그대로 노출하므로 두 겹을 건다.
//   Host(전역): DNS 리바인딩 방어. evil.example 이 127.0.0.1 로 풀리면 브라우저는 대시보드를
//     **그 오리진으로** 받아 이후 Origin 검사까지 같은-오리진으로 통과시킨다. 그래서 도구
//     라우트가 아니라 '/' 를 포함한 전 라우트에 건다 - 대시보드를 내주는 순간이 발판이다.
//   Origin(전역): 다른 오리진 페이지의 CSRF. no-cors POST 는 응답을 못 읽어도 핸들러는
//     실행되므로 CORS 설정만으로는 부족하다 - 실제로 막는 건 이 게이트다. 주소창 이동은
//     Origin 을 보내지 않으므로 대시보드를 직접 여는 길은 그대로 열려 있다.
// Origin 부재는 브라우저가 아니다(curl · type:http MCP 커넥터) - 통과시킨다. 반대로 문자열
// "null"(sandboxed iframe · file://)은 값이 있는 것이므로 거부한다.
const loopbackHosts = (p: number) => {
  const names = ["127.0.0.1", "localhost", "[::1]"];
  const withPort = names.map((n) => `${n}:${p}`);
  return p === 80 ? [...withPort, ...names] : withPort;   // 80 이면 브라우저가 포트를 생략한다
};
const ALLOWED_HOSTS = new Set(loopbackHosts(PORT));
const ALLOWED_ORIGINS = new Set(loopbackHosts(PORT).map((h) => `http://${h}`));

const app = express();
app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || "").toLowerCase())) {
    return res.status(403).json({ error: "forbidden host" });
  }
  // 프리플라이트(OPTIONS)까지 여기서 함께 끊는다. cors() 에 맡기면 ACAO 없는 200 이 나가는데,
  // 브라우저는 그것도 차단하지만 재현 스크립트에는 통과처럼 보인다.
  const o = req.headers.origin;
  if (o !== undefined && !ALLOWED_ORIGINS.has(String(o).toLowerCase())) {
    return res.status(403).json({ error: "forbidden origin" });
  }
  next();
});
app.use(cors({ origin: (o, cb) => cb(null, !!o && ALLOWED_ORIGINS.has(o.toLowerCase())) }));
app.use(express.json({ limit: "20mb" }));

// 라이브 대시보드: 빌드된 단일파일에 standalone 플래그를 주입해 서빙.
app.get("/", async (_req, res) => {
  try {
    let html = await fs.readFile(join(__dirname, "dist", "dashboard.html"), "utf-8");
    // standalone 플래그 + (env 지정 시) 시작 언어. 언어는 MCP 위젯 경로와 같은 주입을 쓴다.
    html = html.replace("<head>", '<head><script>window.__CONFIG_MONITOR_HTTP__=true;</script>' + langScript());
    res.type("html").send(html);
  } catch {
    res.status(500).send("dist/dashboard.html 없음 - 먼저 'npm run build' 를 실행하세요.");
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "config-monitor", version: "0.1.0" });
});

// 도구 REST: 브라우저(standalone) 대시보드가 호출. MCP 와 동일 핸들러.
app.post("/api/tool/:name", async (req, res) => {
  const d = toolMap.get(req.params.name);
  if (!d) return res.status(404).json({ error: `unknown tool: ${req.params.name}` });
  const parsed = d.meta.inputSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  try {
    const r = await d.run(parsed.data);
    res.json({ text: r.content?.[0]?.text ?? "" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/mcp", async (req, res) => {
  // stateless 패턴: 요청마다 server+transport 신규. 서버 인스턴스 하나를 재사용하면
  // connect 가 내부 transport 를 덮어써 동시 요청의 응답이 뒤바뀌거나 유실될 수 있다.
  const server = new McpServer({ name: "config-monitor", version: "0.1.0" });
  registerAll(server, __dirname);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// 루프백 전용 바인딩: 이 서버는 로컬 설정 파일을 읽고 쓰는 용도라 원격 사용 자체가 대상이
// 아니므로, 0.0.0.0(기본값)으로 열어 같은 네트워크의 다른 기기에 노출될 이유가 없다.
// 브라우저 오리진은 이걸로 못 막는다 - 그건 위의 Host/Origin 게이트가 맡는다.
app.listen(PORT, "127.0.0.1", () => {
  console.error(`[config-monitor] HTTP at http://127.0.0.1:${PORT}/ (dashboard) · /mcp · /api/tool/:name`);
  void autoStartWatcher(__dirname);   // CONFIG_MONITOR_WATCHER=auto 일 때만(기본 no-op)
});
