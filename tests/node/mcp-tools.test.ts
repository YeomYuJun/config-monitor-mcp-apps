// mcp-tools.ts 의 결과 직렬화와 watcher 프로세스 선택 명령.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTools, entryArgs, resolveLang, serverEntry, watcherKillCommand, WATCHER_FLAG } from "../../src/mcp-tools.ts";

const SRC = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."), "src");

test("a python float in the store config comes back as 1.0 text with no wrapper object", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp_tools_test_"));
  const keep = process.env.CLAUDE_SNAPSHOT_STORE;
  try {
    fs.writeFileSync(path.join(tmp, "config.json"), '{"version": 1, "ui": {"sections": {"hideEmpty": 1.0}}}');
    process.env.CLAUDE_SNAPSHOT_STORE = tmp;
    const tool = buildTools(SRC).find((d) => d.name === "get_prefs")!;
    const r = await tool.run({});
    assert.match(r.content[0].text, /"hideEmpty": 1\.0/);
    assert.equal((r.structuredContent as any).ui.sections.hideEmpty, 1);
  } finally {
    if (keep === undefined) delete process.env.CLAUDE_SNAPSHOT_STORE;
    else process.env.CLAUDE_SNAPSHOT_STORE = keep;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CONFIG_MONITOR_LANG auto and empty leave the language to the dashboard", () => {
  assert.deepEqual(["auto", "", undefined, "en-US", "ko", "fr"].map((v) => resolveLang(v)), [null, null, null, "en", "ko", "ko"]);
});

test("the watcher is started from the server entry and matched by its path and flag", () => {
  assert.equal(serverEntry(SRC), path.join(SRC, "server-stdio.ts"));
  const args = entryArgs(SRC, WATCHER_FLAG, "--store", "S");
  assert.deepEqual(args.slice(-4), [path.join(SRC, "server-stdio.ts"), WATCHER_FLAG, "--store", "S"]);
  const cmd = watcherKillCommand(SRC, true);
  assert.ok(cmd.includes(`Contains('${path.join(SRC, "server-stdio.ts")}')`));
  assert.ok(cmd.includes(`Contains(' ${WATCHER_FLAG} ')`));
  assert.ok(cmd.includes(path.join(SRC, "watcher.py").replace(/\\/g, "/")));
  assert.ok(!cmd.includes("Stop-Process"));
  // 다른 설치 폴더(플러그인 업데이트 전 버전)의 watcher 도 같은 스토어면 고른다.
  assert.ok(watcherKillCommand(SRC, true, "D:\\s s\\store").includes("Contains('D:\\s s\\store')"));
});
