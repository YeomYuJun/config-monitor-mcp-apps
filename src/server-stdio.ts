#!/usr/bin/env node
// server-stdio.ts — stdio transport (포트 불필요, 호스트가 프로세스를 spawn).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { autoStartWatcher, registerAll } from "./mcp-tools.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const server = new McpServer({ name: "config-monitor", version: "0.1.0" });
registerAll(server, __dirname);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[config-monitor] stdio server ready");
void autoStartWatcher(__dirname);   // CONFIG_MONITOR_WATCHER=auto 일 때만(기본 no-op)
