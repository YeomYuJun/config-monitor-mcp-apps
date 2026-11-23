// tests/test_smoke.py 의 DesktopPaths 를 옮긴 것 + 이식 중 확인한 Python 과의 차이점.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopConfigPath, desktopDirCandidates, expanduser, resolveDesktopDir, RESERVED_SKILL_DIRS, DESKTOP_CONFIG_NAME } from "../../src/core/paths.ts";

let tmp = "";
let appdata = "";
let localappdata = "";
const win32Dir = () => path.join(appdata, "Claude");
const msixDir = (pkg = "Claude_pzs8sxrjxfjjc") => path.join(localappdata, "Packages", pkg, "LocalCache", "Roaming", "Claude");

function makeConfig(d: string, mtime?: number): string {
  fs.mkdirSync(d, { recursive: true });
  const cfg = path.join(d, DESKTOP_CONFIG_NAME);
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: {} }));
  if (mtime !== undefined) fs.utimesSync(cfg, mtime, mtime);
  return cfg;
}

const resolve = () => resolveDesktopDir(appdata, localappdata);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paths_test_"));
  appdata = path.join(tmp, "Roaming");
  localappdata = path.join(tmp, "Local");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("win32 only", () => {
  makeConfig(win32Dir());
  assert.equal(resolve(), win32Dir());
});

test("msix only", () => {
  // Win32 후보 디렉토리는 아예 없고 MSIX 패키지 폴더에만 config 존재.
  makeConfig(msixDir());
  assert.equal(resolve(), msixDir());
});

test("both prefers most recent config", () => {
  makeConfig(win32Dir(), 1000);
  makeConfig(msixDir(), 2000);
  assert.equal(resolve(), msixDir());
  fs.utimesSync(path.join(win32Dir(), DESKTOP_CONFIG_NAME), 3000, 3000);
  assert.equal(resolve(), win32Dir());
});

test("mtime tie keeps the earlier candidate", () => {
  // Python max() 는 동률이면 앞 후보를 돌려준다.
  makeConfig(win32Dir(), 1000);
  makeConfig(msixDir(), 1000);
  assert.equal(resolve(), win32Dir());
});

test("none falls back to win32", () => {
  assert.equal(resolve(), win32Dir());
});

test("existing dir without config wins over the fallback", () => {
  fs.mkdirSync(msixDir(), { recursive: true });
  assert.equal(resolve(), msixDir());
});

test("desktop config path appends filename", () => {
  makeConfig(msixDir());
  assert.equal(desktopConfigPath(appdata, localappdata), path.join(msixDir(), DESKTOP_CONFIG_NAME));
});

test("msix candidates are sorted and matched like Python glob", () => {
  fs.mkdirSync(msixDir("Claude_b"), { recursive: true });
  fs.mkdirSync(msixDir("Claude_a"), { recursive: true });
  fs.mkdirSync(path.join(localappdata, "Packages", "Claude_nodata"), { recursive: true });
  fs.mkdirSync(path.join(localappdata, "Packages", "Other_x", "LocalCache", "Roaming", "Claude"), { recursive: true });
  const want = [win32Dir(), msixDir("Claude_a"), msixDir("Claude_b")];
  if (process.platform === "win32") {
    // Windows 의 Python glob 은 대소문자를 무시한다.
    fs.mkdirSync(msixDir("claude_c"), { recursive: true });
    want.push(msixDir("claude_c"));
  }
  assert.deepEqual(desktopDirCandidates(appdata, localappdata), want);
});

test("env defaults: empty string is kept as a value, missing falls back to home", () => {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  try {
    delete process.env.APPDATA;
    process.env.LOCALAPPDATA = path.join(tmp, "L2");
    assert.equal(desktopDirCandidates(null, null, tmp)[0], path.join(tmp, "AppData", "Roaming", "Claude"));
    process.env.APPDATA = "";
    assert.equal(desktopDirCandidates(null, null, tmp)[0], "Claude");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("expanduser follows Python ntpath/posixpath rules", () => {
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  try {
    if (process.platform === "win32") {
      process.env.USERPROFILE = "X:\\Users\\demo";
      assert.equal(expanduser("~"), "X:\\Users\\demo");
      assert.equal(expanduser("~\\.claude"), "X:\\Users\\demo\\.claude");
      assert.equal(expanduser("~/.claude"), "X:\\Users\\demo/.claude");
    } else {
      process.env.HOME = "/home/demo/";
      assert.equal(expanduser("~/.claude"), "/home/demo/.claude");
    }
    assert.equal(expanduser("~other/x"), "~other/x");
    assert.equal(expanduser("a/~"), "a/~");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("constants", () => {
  assert.equal(DESKTOP_CONFIG_NAME, "claude_desktop_config.json");
  assert.deepEqual(RESERVED_SKILL_DIRS, ["synced"]);
});
