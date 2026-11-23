// tests/test_prefs.py 를 옮긴 것. 핵심은 degrade 경로다: 스토어가 없을 때 저장했다고 거짓말하면 안 된다.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as prefs from "../../src/core/prefs.ts";

let d = "";
beforeEach(() => { d = fs.mkdtempSync(path.join(os.tmpdir(), "prefs_test_")); });
afterEach(() => fs.rmSync(d, { recursive: true, force: true }));

const writeCfg = (cfg: unknown, bom = false) => fs.writeFileSync(path.join(d, "config.json"), (bom ? "\ufeff" : "") + JSON.stringify(cfg), "utf8");

test("defaults when store missing", () => {
  const ui = prefs.loadUi(d);
  assert.equal(ui.sections.preset, "all");
  assert.equal(ui.sections.hideEmpty, true);
  assert.deepEqual(ui.sections.hidden, []);
});

test("set then get round trip", async () => {
  writeCfg({ version: 1 });
  await prefs.saveUi(d, { sections: { preset: "custom", hidden: ["themes"] } });
  const ui = prefs.loadUi(d);
  assert.equal(ui.sections.preset, "custom");
  assert.deepEqual(ui.sections.hidden, ["themes"]);
  assert.equal(ui.sections.hideEmpty, true, "패치하지 않은 키는 기본값이 유지되어야 함");
});

test("includeMissingProjects defaults off and persists", async () => {
  writeCfg({ version: 1 });
  assert.equal(prefs.loadUi(d).sections.includeMissingProjects, false);
  await prefs.saveUi(d, { sections: { includeMissingProjects: true } });
  assert.equal(prefs.loadUi(d).sections.includeMissingProjects, true);
});

test("view block round trips and ignores unknown keys", async () => {
  writeCfg({ version: 1 });
  await prefs.saveUi(d, { view: { selectedPath: "C:/x/settings.json", detailOpen: false, bogus: 1 } });
  const ui = prefs.loadUi(d);
  assert.equal(ui.view.selectedPath, "C:/x/settings.json");
  assert.equal(ui.view.detailOpen, false);
  assert.equal(ui.view.scope, "all");
  assert.ok(!("bogus" in ui.view));
  assert.equal(ui.sections.preset, "all");
});

test("save preserves unrelated store keys", async () => {
  writeCfg({ version: 1, tracked: ["a"], libraries: ["b"] });
  await prefs.saveUi(d, { sections: { preset: "all" } });
  const cfg = JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8"));
  assert.deepEqual([cfg.tracked, cfg.libraries], [["a"], ["b"]]);
});

test("save without store raises; cli reports ok:false", async () => {
  await assert.rejects(prefs.saveUi(d, { sections: { preset: "all" } }));
  const r = await prefs.main(["set", "--store", d, "--json", '{"sections":{"preset":"all"}}']);
  assert.deepEqual([r.ok, r.code], [false, "store_uninitialized"]);
});

test("cli set reports lock_timeout while config is locked", async () => {
  writeCfg({ version: 1 });
  fs.writeFileSync(path.join(d, "config.lock"), '{"pid": 1}');
  const saved = process.env.CLAUDE_CAS_LOCK_WAIT;
  process.env.CLAUDE_CAS_LOCK_WAIT = "0.3";
  try {
    const r = await prefs.main(["set", "--store", d, "--json", '{"sections":{"preset":"custom"}}']);
    assert.deepEqual([r.ok, r.code], [false, "lock_timeout"]);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CAS_LOCK_WAIT;
    else process.env.CLAUDE_CAS_LOCK_WAIT = saved;
  }
  assert.equal(prefs.loadUi(d).sections.preset, "all");
});

test("cli get returns defaults without store; cmdGet/cmdSet match main", async () => {
  const out = await prefs.main(["get", "--store", d]);
  assert.equal(out.ok, true);
  assert.equal((out.ui as prefs.UiPrefs).sections.preset, "all");
  assert.deepEqual(await prefs.cmdGet({ store: d }), out);
  writeCfg({ version: 1 });
  const s = await prefs.cmdSet({ store: d, json: '{"view":{"scope":"global"}}' });
  assert.equal((s.ui as prefs.UiPrefs).view.scope, "global");
  const bad = await prefs.cmdSet({ store: d, json: "{not json" });
  assert.deepEqual([bad.code, bad.target, bad.message], ["invalid_arg", "--json",
    "Failed to parse --json: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"]);
});

test("bom json is readable; legacy and unknown presets fall back to all", () => {
  writeCfg({ version: 1, ui: { sections: { preset: "all" } } }, true);
  assert.equal(prefs.loadUi(d).sections.preset, "all");
  writeCfg({ version: 1, ui: { sections: { preset: "present" } } });
  assert.equal(prefs.loadUi(d).sections.preset, "all");
  writeCfg({ version: 1, ui: { sections: { preset: "bogus" } } });
  assert.equal(prefs.loadUi(d).sections.preset, "all");
});

test("preset and hideEmpty stay independent; unknown keys are ignored", async () => {
  writeCfg({ version: 1 });
  let ui = await prefs.saveUi(d, { sections: { preset: "common" } });
  assert.equal(ui.sections.hideEmpty, true);
  ui = await prefs.saveUi(d, { sections: { hideEmpty: false } });
  assert.equal(ui.sections.preset, "common");
  ui = await prefs.saveUi(d, { sections: { bogus: 1, preset: "custom" } });
  assert.ok(!("bogus" in ui.sections));
  assert.equal(ui.sections.preset, "custom");
});

test("python truthiness of the patch: falsy is empty, truthy non-object is internal", async () => {
  writeCfg({ version: 1 });
  for (const p of ["[]", "0", "null", "{}", '{"sections": []}', '{"sections": 0}']) {
    assert.equal((await prefs.main(["set", "--store", d, "--json", p])).ok, true, p);
  }
  for (const p of ["[1]", '"x"', '{"sections": [1]}']) {
    const r = await prefs.main(["set", "--store", d, "--json", p]);
    assert.deepEqual([r.ok, r.code], [false, "internal"], p);
    assert.match(r.message, /^AttributeError: /);
  }
});
