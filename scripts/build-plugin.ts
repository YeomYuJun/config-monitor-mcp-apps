// build-plugin.ts - 서버를 축소 없는 단일 JS 로 묶어 plugin/config-monitor/ 에 쓰고, 같은 파일로 Desktop 용 .mcpb 를 만든다.
//
//   npm run build:plugin      (vite build 로 src/dist/dashboard.html 을 먼저 만든다)
//
// 쓰는 것: plugin/config-monitor/server.js, plugin/config-monitor/dist/dashboard.html,
//          release/config-monitor-<version>.mcpb(manifest.json + 같은 server.js + dashboard.html).
// .mcpb 는 디렉토리 제출물이 아니라 GitHub 릴리스에 올릴 파일이라 플러그인 폴더 밖에 둔다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { writeZip } from "../src/core/transfer.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(REPO, "plugin", "config-monitor");
const RELEASE = path.join(REPO, "release");
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf-8")) as {
  name: string; version: string; description: string; author: { name: string; url?: string }; license: string; homepage?: string; repository?: string;
};

const html = path.join(REPO, "src", "dist", "dashboard.html");
if (!fs.existsSync(html)) throw new Error(`${html} not found - run 'npm run build' first`);

const serverJs = path.join(PLUGIN, "server.js");
await build({
  entryPoints: [path.join(REPO, "src", "server-stdio.ts")],
  outfile: serverJs,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  legalComments: "inline",
  // 묶인 CommonJS 의존성(express 등)이 require 를 부르므로 ESM 출력에 require 를 만들어 준다.
  banner: { js: 'import { createRequire as __cmCreateRequire } from "node:module"; const require = __cmCreateRequire(import.meta.url);' },
  logLevel: "warning",
});
fs.mkdirSync(path.join(PLUGIN, "dist"), { recursive: true });
fs.copyFileSync(html, path.join(PLUGIN, "dist", "dashboard.html"));

// Desktop 채팅용 .mcpb. 형식은 https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md (manifest_version 0.3).
const mcpb = {
  manifest_version: "0.3",
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  author: manifest.author,
  license: manifest.license,
  ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
  ...(manifest.repository ? { repository: { type: "git", url: manifest.repository } } : {}),
  server: {
    type: "node",
    entry_point: "server.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server.js"],
      env: { CONFIG_MONITOR_LANG: "${user_config.language}" },
    },
  },
  user_config: {
    language: {
      type: "string",
      title: "Dashboard language",
      description: "auto keeps the language chosen in the dashboard (Korean by default), en starts in English, ko starts in Korean",
      default: "auto",
      required: false,
    },
  },
  tools_generated: false,
  compatibility: { platforms: ["win32"], runtimes: { node: ">=20.0.0" } },
};
fs.mkdirSync(RELEASE, { recursive: true });
const out = path.join(RELEASE, `${manifest.name}-${manifest.version}.mcpb`);
const now = new Date();
const attr = (0o100644 << 16) >>> 0;
writeZip(out, [
  { name: "manifest.json", data: Buffer.from(JSON.stringify(mcpb, null, 2) + "\n", "utf-8"), date: now, attr },
  { name: "server.js", data: fs.readFileSync(serverJs), date: now, attr },
  { name: "dist/dashboard.html", data: fs.readFileSync(html), date: now, attr },
]);

const kib = (p: string) => (fs.statSync(p).size / 1024).toFixed(1);
for (const p of [serverJs, path.join(PLUGIN, "dist", "dashboard.html"), out]) console.log(`${path.relative(REPO, p)}  ${kib(p)} KiB`);
