#!/usr/bin/env node
// server-stdio.ts - stdio transport (포트 불필요, 호스트가 프로세스를 spawn).
// 같은 진입 파일이 --watcher 로 watcher 를, --http 로 HTTP 대시보드 서버(server.ts)를 돌린다.
// 번들(plugin/config-monitor/server.js)이 파일 하나라서 서버가 띄우는 자식도 이 파일을 다시 실행한다.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main as watcherMain } from "./core/watcher.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { autoStartWatcher, HTTP_FLAG, registerAll, WATCHER_FLAG } from "./mcp-tools.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];

if (mode === WATCHER_FLAG) {
  process.exitCode = await watcherMain(process.argv.slice(3));
} else if (mode === HTTP_FLAG) {
  await import("./server.ts");
} else {
  const server = new McpServer({ name: "config-monitor", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerAll(server, __dirname);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[config-monitor] stdio server ready");
  void autoStartWatcher(__dirname);   // CONFIG_MONITOR_WATCHER=auto 일 때만(기본 no-op)
}
