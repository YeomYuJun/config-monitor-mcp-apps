// 실제 cas 스토어에 대고 도는 library 테스트. snapshotBefore~snapshotAfter 구간이 config_edit 의 편집 락 안에서
// 돌고, 구간 안에서 예외가 나도 스냅샷 락과 편집 락이 풀리는지 본다.
process.env.CLAUDE_CAS_NO_DEFAULT_TRACK = "1";   // 기본 추적 대상(실사용자 파일)이 테스트 스토어에 합류하지 않게
process.env.CLAUDE_CAS_LOCK_WAIT = "0.2";        // 남은 락이 있으면 8초 대신 바로 드러나게

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cas from "../../src/core/cas.ts";
import * as ce from "../../src/core/config_edit.ts";
import { main } from "../../src/core/library.ts";
import * as libStore from "../../src/core/lib_store.ts";

let tmp = "", store = "", target = "", settings = "", root = "";
const lockPath = () => path.join(store, "snapshot.lock");
const hooksInstall = () => main(["--store", store, "--target", target, "hooks-install", "--origin", "market:mk/sg", "--settings", settings]);

/** p 가 ms 안에 끝나지 않으면 "timeout". 락이 남으면 테스트가 멈추는 대신 실패하게 한다. */
function within<T>(p: Promise<T>, ms = 5000): Promise<T | "timeout"> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<"timeout">((r) => { t = setTimeout(() => r("timeout"), ms); })]).finally(() => clearTimeout(t));
}

beforeEach(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "library_snap_")));
  store = path.join(tmp, "store");
  target = path.join(tmp, ".claude");
  settings = path.join(target, "settings.json");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(settings, '{\n  "keep": true\n}');
  root = path.join(tmp, "cache", "sg");
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] } }));
  await cas.main(["--store", store, "init"]);
  await cas.main(["--store", store, "track", settings]);
  const c = libStore.loadCfg(store) as Record<string, any>;
  c.marketplaces = [{ id: "mk", url: "u", cache: path.join(tmp, "repo"), plugins: [{ name: "sg", sha: "abc", cache: root }] }];
  libStore.saveCfg(store, c);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("library edit span", () => {
  test("a successful install leaves no snapshot lock and names its revision", async () => {
    const r = await hooksInstall();
    assert.equal(r.ok, true, r.message);
    assert.ok(!fs.existsSync(lockPath()));
    const revs = (await cas.main(["--store", store, "history", settings, "--json"])).revisions as { message: string }[];
    assert.equal(revs[revs.length - 1].message, "Hooks installed: sg (1)");
  });

  test("an exception inside the span releases the snapshot lock and the edit lock", async () => {
    fs.mkdirSync(settings + ".tmp");   // saveAtomic 의 임시 파일 쓰기가 EISDIR 로 실패한다
    const r = await hooksInstall();
    assert.deepEqual([r.ok, r.code], [false, "internal"]);
    assert.ok(!fs.existsSync(lockPath()), "snapshot.lock 이 남았다");
    assert.equal(await within(ce.withEditLock(async () => "free")), "free");
    fs.rmdirSync(settings + ".tmp");
    const next = await within(ce.main(["--store", store, "--settings", settings, "perm-add", "allow", "Bash(ls:*)"]));
    assert.notEqual(next, "timeout");
    assert.equal((next as { ok: boolean }).ok, true);
    assert.ok(!fs.existsSync(lockPath()));
  });

  test("a library install and a config edit in one process do not overwrite each other", async () => {
    const [a, b] = await Promise.all([hooksInstall(), ce.main(["--store", store, "--settings", settings, "perm-add", "allow", "Bash(ls:*)"])]);
    assert.deepEqual([a.ok, b.ok], [true, true], `${a.message} / ${b.message}`);
    const s = JSON.parse(fs.readFileSync(settings, "utf-8"));
    assert.deepEqual(s.permissions.allow, ["Bash(ls:*)"]);
    assert.equal(s.hooks.Stop.length, 1);
    assert.ok(!fs.existsSync(lockPath()));
  });
});
