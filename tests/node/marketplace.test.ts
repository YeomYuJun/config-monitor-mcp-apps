// tests/test_remote_library.py 의 Manifest, PathGuards, Catalog, ClassifySource 를 옮긴 것.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ManifestError, DRIVE_ABS_RE, MANIFEST_REL, catalog, classifySource, displayName, parseManifest, resolvePlugin,
  safeRelpath, safeSegment, sourceSpec, type Manifest,
} from "../../src/core/marketplace.ts";

let tmp = "";
beforeEach(() => { tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mf_test_"))); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(obj: unknown, raw?: Buffer): string {
  const d = path.join(tmp, ".claude-plugin");
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, "marketplace.json");
  fs.writeFileSync(p, raw ?? JSON.stringify(obj));
  return p;
}

describe("Manifest", () => {
  test("parse indexes plugins by name", () => {
    const mf = parseManifest(write({ name: "official", plugins: [
      { name: "convex", displayName: "Convex", source: "./plugins/convex" },
      { name: "superpowers", source: { source: "url", url: "u", sha: "s" } }] }));
    assert.equal(mf.name, "official");
    assert.deepEqual(Object.keys(mf.by_name).sort(), ["convex", "superpowers"]);
  });

  test("renames resolve old name to current entry", () => {
    const mf = parseManifest(write({ name: "official", plugins: [{ name: "convex", source: "./plugins/convex" }],
      renames: { "convex-backend": "convex" } }));
    const [entry, canon] = resolvePlugin(mf, "convex-backend");
    assert.equal(canon, "convex");
    assert.equal(entry!.name, "convex");
  });

  test("renames does not resolve new to old", () => {
    // old-name 엔트리를 살려 둬서 역방향 해석 버그가 있으면 new-name 조회가 old-name 으로 튀는 게 보이게 한다.
    const mf = parseManifest(write({ name: "o", plugins: [{ name: "convex", source: "./p" }, { name: "old-name", source: "./p" }],
      renames: { "convex-backend": "convex", "old-name": "new-name" } }));
    const [entry, canon] = resolvePlugin(mf, "convex");
    assert.deepEqual([canon, entry!.name], ["convex", "convex"]);
    assert.deepEqual(resolvePlugin(mf, "new-name"), [null, null]);
  });

  test("rename chain does not loop forever", () => {
    const mf = parseManifest(write({ name: "o", plugins: [{ name: "c", source: "./p" }], renames: { a: "b", b: "a" } }));
    assert.deepEqual(resolvePlugin(mf, "a"), [null, null]);
  });

  test("display name prefers displayName", () => {
    assert.equal(displayName({ name: "convex", displayName: "Convex" }), "Convex");
    assert.equal(displayName({ name: "qodo" }), "qodo");
  });

  test("malformed manifest raises ManifestError", () => {
    assert.throws(() => parseManifest(write({ name: "o" })), ManifestError);
    assert.throws(() => parseManifest(path.join(tmp, "nope.json")), ManifestError);
    assert.throws(() => parseManifest(write(null, Buffer.from("{not json"))), ManifestError);
  });

  test("malformed entry name is skipped not indexed", () => {
    const mf = parseManifest(write({ name: "o", plugins: [{ name: "..", source: "./p" }, { name: "ok", source: "./p" }] }));
    assert.deepEqual(Object.keys(mf.by_name), ["ok"]);
  });

  test("resolvePlugin rejects unsafe canonical name from renames", () => {
    const mf = parseManifest(write({ name: "o", plugins: [{ name: "../../ESCAPED", source: "./p" }], renames: { good: "../../ESCAPED" } }));
    assert.ok(!("../../ESCAPED" in mf.by_name));
    assert.deepEqual(resolvePlugin(mf, "good"), [null, null]);
  });

  test("resolvePlugin ignores non-string rename target", () => {
    const mf = parseManifest(write({ name: "o", plugins: [{ name: "c", source: "./p" }], renames: { a: { b: "c" } } }));
    assert.deepEqual(resolvePlugin(mf, "a"), [null, null]);
  });

  test("prototype keys are not plugin entries", () => {
    const mf = parseManifest(write({ name: "o", plugins: [{ name: "c", source: "./p" }] }));
    assert.deepEqual(resolvePlugin(mf, "constructor"), [null, null]);
  });

  test("reads a manifest written by Python json.dump with a BOM", () => {
    // Python json.dump 기본값(ensure_ascii, ", " 구분자)과 Windows 도구가 붙이는 BOM.
    const body = '{"name": "\\ud55c\\uae00", "plugins": [{"name": "p", "source": "./p"}]}';
    const mf = parseManifest(write(null, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)])));
    assert.equal(mf.name, "한글");
    assert.deepEqual(Object.keys(mf.by_name), ["p"]);
  });

  test("a manifest is read with python json.load semantics", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    assert.throws(() => parseManifest(write(null, Buffer.concat([bom, Buffer.from('{"name": "x", "plugins": [], }')]))),
      (e: Error) => e instanceof ManifestError && e.message === "Cannot read the manifest: Expecting property name enclosed in double quotes: line 1 column 30 (char 29)");
    const mf = parseManifest(write(null, Buffer.from('{"name": "o", "plugins": [{"name": "p", "source": "./p", "weight": NaN}]}')));
    assert.deepEqual(Object.keys(mf.by_name), ["p"]);
  });

  test("MANIFEST_REL uses the platform separator", () => {
    assert.equal(MANIFEST_REL, path.join(".claude-plugin", "marketplace.json"));
  });
});

describe("PathGuards", () => {
  const BAD_NAMES = ["..", ".", "", "a/b", "a\\b", "C:foo", "a:b", "/abs", "..\\evil"];
  const BAD_PATHS = ["../outside", "plugins/../../etc", "/abs/path", "C:foo\\x", "plugins/a:b", "plugins//", "plugins/./x"];

  test("bad plugin names rejected", () => {
    for (const n of BAD_NAMES) assert.throws(() => safeSegment(n), ManifestError, n);
  });

  test("good plugin names pass", () => {
    for (const n of ["superpowers", "agent-sdk-dev", "wordpress.com", "a_b", "qodo-skills"]) assert.equal(safeSegment(n), n);
  });

  test("trailing dot space segments rejected", () => {
    for (const n of ["..", ".. ", "..\t", "...", ". ", " ", "\t", ".  ."]) assert.throws(() => safeSegment(n), ManifestError, JSON.stringify(n));
  });

  test("reserved device names rejected case and extension insensitive", () => {
    for (const n of ["CON", "con", "Con.txt", "NUL", "nul.md", "COM1", "com9.json", "LPT3", "lpt9.txt"]) assert.throws(() => safeSegment(n), ManifestError, n);
  });

  test("names resembling reserved prefix still pass", () => {
    for (const n of ["conquest", "nullable", "communication", "console-app"]) assert.equal(safeSegment(n), n);
  });

  test("error text matches the Python repr form", () => {
    assert.throws(() => safeSegment("a/b", "plugin name"), { message: "Invalid plugin name: 'a/b'" });
    assert.throws(() => safeSegment("..\t"), { message: "Invalid name: '..\\t'" });
    assert.throws(() => safeSegment("a:'b\""), { message: "Invalid name: 'a:\\'b\"'" });
    assert.throws(() => safeSegment("x:it's"), { message: "Invalid name: \"x:it's\"" });
    assert.throws(() => safeSegment(null), { message: "Invalid name: None" });
    assert.throws(() => safeSegment("Con.txt"), { message: "Reserved name: 'Con.txt'" });
  });

  test("bad relpaths rejected", () => {
    for (const p of BAD_PATHS) assert.throws(() => safeRelpath(p), ManifestError, p);
  });

  test("good relpaths pass and strip dot prefix", () => {
    assert.equal(safeRelpath("./plugins/agent-sdk-dev"), "plugins/agent-sdk-dev");
    assert.equal(safeRelpath("plugins/creative-cloud/adobe"), "plugins/creative-cloud/adobe");
  });

  test("sourceSpec covers all four kinds", () => {
    assert.equal(sourceSpec({ source: "./plugins/p" }).kind, "str-path");
    const gs = sourceSpec({ source: { source: "git-subdir", url: "https://example.invalid/x.git", path: "plugins/x", ref: "v1", sha: "abc" } });
    assert.deepEqual([gs.kind, gs.path, gs.sha], ["git-subdir", "plugins/x", "abc"]);
    assert.equal(sourceSpec({ source: { source: "url", url: "https://example.invalid/x.git", sha: "deadbeef" } }).kind, "url");
    const gh = sourceSpec({ source: { source: "github", repo: "o/r", commit: "c", sha: "deadbeef" } });
    assert.deepEqual([gh.kind, gh.url], ["github", "https://github.com/o/r.git"]);
  });

  test("github repo is validated as two segments", () => {
    assert.throws(() => sourceSpec({ source: { source: "github", repo: "../evil", sha: "deadbeef" } }), ManifestError);
  });

  test("sourceSpec rejects malicious urls", () => {
    const bad = ["ext::sh -c 'touch /tmp/pwned'", "--upload-pack=evil", "ftp://example.invalid/x.git", "javascript:alert(1)"];
    for (const kind of ["url", "git-subdir"]) {
      for (const u of bad) {
        const spec: Record<string, unknown> = { source: kind, url: u, sha: "deadbeef" };
        if (kind === "git-subdir") spec.path = "plugins/x";
        assert.throws(() => sourceSpec({ source: spec }), ManifestError, `${kind} ${u}`);
      }
    }
  });

  test("sourceSpec accepts scp style and common schemes", () => {
    for (const u of ["https://example.invalid/x.git", "http://example.invalid/x.git", "ssh://git@example.invalid/x.git",
      "git://example.invalid/x.git", "file:///tmp/x", "git@github.com:owner/repo.git"]) {
      assert.equal(sourceSpec({ source: { source: "url", url: u } }).url, u);
    }
  });

  test("sourceSpec ipv6 url not falsely rejected as transport helper", () => {
    assert.equal(sourceSpec({ source: { source: "url", url: "https://[::1]/r.git" } }).url, "https://[::1]/r.git");
  });

  test("sourceSpec rejects option-like ref and non-hex sha", () => {
    assert.throws(() => sourceSpec({ source: { source: "url", url: "https://example.invalid/x.git", ref: "--upload-pack=evil" } }), ManifestError);
    assert.throws(() => sourceSpec({ source: { source: "url", url: "https://example.invalid/x.git", sha: "not-hex!" } }), ManifestError);
  });
});

describe("Catalog", () => {
  const make = (): Manifest => {
    const plugins = [
      { name: "alpha", description: "A dev tool", category: "development", author: "x", source: "./plugins/alpha" },
      { name: "beta", description: "DB helper", category: "database", source: { source: "url", url: "https://example.invalid/beta.git", sha: "deadbeefcafe" } },
      { name: "gamma", description: "another dev thing", category: "development", source: "./plugins/gamma" },
    ];
    return { name: "official", description: "", owner: null, renames: {}, plugins, by_name: Object.fromEntries(plugins.map((e) => [e.name, e])) };
  };

  test("rows carry metadata but no component count", () => {
    const r = catalog(make(), {});
    assert.equal(r.total, 3);
    const row = r.rows.find((x) => x.name === "beta")!;
    assert.equal(row.category, "database");
    assert.equal(row.kind, "url");
    assert.ok(!("installable" in row));
    assert.equal(row.fetched, false);
  });

  test("category filter and counts", () => {
    const r = catalog(make(), {}, null, "development");
    assert.deepEqual(r.rows.map((x) => x.name), ["alpha", "gamma"]);
    assert.equal(r.categories.development, 2);
  });

  test("query matches name and description case-insensitively", () => {
    assert.deepEqual(catalog(make(), {}, "DEV").rows.map((x) => x.name), ["alpha", "gamma"]);
    assert.deepEqual(catalog(make(), {}, "db").rows.map((x) => x.name), ["beta"]);
  });

  test("pagination is stable", () => {
    const r1 = catalog(make(), {}, null, null, 2, 0);
    const r2 = catalog(make(), {}, null, null, 2, 2);
    assert.deepEqual(r1.rows.map((x) => x.name), ["alpha", "beta"]);
    assert.deepEqual(r2.rows.map((x) => x.name), ["gamma"]);
    assert.equal(r1.total, 3);
  });

  test("limit 0 returns every row and negative limit slices like Python", () => {
    assert.equal(catalog(make(), {}, null, null, 0).rows.length, 3);
    assert.deepEqual(catalog(make(), {}, null, null, -1).rows.map((x) => x.name), ["alpha", "beta"]);
  });

  test("fetched plugins are marked", () => {
    const r = catalog(make(), { alpha: { sha: "abc1234", cache: "/c" } });
    const row = r.rows.find((x) => x.name === "alpha")!;
    assert.equal(row.fetched, true);
    assert.equal(row.sha, "abc1234");
    assert.equal(row.origin, "market:official/alpha");
  });

  test("row keys and values", () => {
    const row = catalog(make(), {}).rows[1];
    assert.deepEqual(row, { name: "beta", display: "beta", description: "DB helper", category: "database", author: "",
      homepage: "", kind: "url", sha: "deadbeefcafe", fetched: false, origin: "market:official/beta" });
  });

  test("malformed entry name excluded from rows", () => {
    const mf: Manifest = { name: "official", description: "", owner: null, renames: {}, by_name: {}, plugins: [
      { name: "..", description: "evil", category: "x", source: "./p" },
      { name: "ok", description: "fine", category: "x", source: "./p" }] };
    const r = catalog(mf, {});
    assert.deepEqual(r.rows.map((x) => x.name), ["ok"]);
    assert.equal(r.total, 1);
  });
});

describe("ClassifySource", () => {
  const reject = (s: string) => assert.throws(() => classifySource(s), ManifestError, s);
  const inDir = <T>(d: string, fn: () => T): T => {
    const cwd = process.cwd();
    process.chdir(d);
    try {
      return fn();
    } finally {
      process.chdir(cwd);
    }
  };

  test("owner/repo shorthand becomes github url", () => {
    const r = classifySource("anthropics/claude-code");
    assert.equal(r.kind, "git");
    assert.equal(r.url, "https://github.com/anthropics/claude-code.git");
    assert.equal(r.id, "claude-code");
  });

  test("shorthand id matches full url id", () => {
    // url 정규화(library 의 URL 비교)가 같아지는지는 library 이식 때 확인한다.
    assert.equal(classifySource("anthropics/claude-code").id, classifySource("https://github.com/anthropics/claude-code.git").id);
  });

  test("shorthand ref suffix is split off not glued into the url", () => {
    for (const [src, ref] of [["anthropics/claude-code#main", "main"], ["anthropics/claude-code@v1.0.0", "v1.0.0"], ["anthropics/claude-code#feature/x", "feature/x"]]) {
      const r = classifySource(src);
      assert.equal(r.url, "https://github.com/anthropics/claude-code.git");
      assert.equal(r.ref, ref);
      assert.equal(r.id, "claude-code");
    }
    assert.equal(classifySource("anthropics/claude-code").ref, null);
  });

  test("scp style stays git and is not rewritten", () => {
    const r = classifySource("git@github.com:owner/repo.git");
    assert.deepEqual([r.kind, r.url, r.id], ["git", "git@github.com:owner/repo.git", "repo"]);
  });

  test("https json is json kind", () => {
    const r = classifySource("https://example.com/team/marketplace.json");
    assert.equal(r.kind, "json");
    assert.equal(r.id, "team");
  });

  test("json with query string is not mistaken for git", () => {
    assert.equal(classifySource("https://example.com/a/mk.json?token=x").kind, "json");
  });

  test("json over non-http scheme is rejected", () => {
    reject("ssh://git@example.com/mk.json");
    reject("git@example.com:mk.json");
  });

  test("explicit relative and absolute paths are local", () => {
    const sib = path.join(tmp, "a", "sib");
    fs.mkdirSync(path.join(tmp, "a", "b"), { recursive: true });
    fs.mkdirSync(sib);
    const r = classifySource(tmp);
    assert.equal(r.kind, "local");
    assert.equal(r.path, tmp);
    assert.equal(r.url, null);
    inDir(path.join(tmp, "a", "b"), () => {
      assert.equal(classifySource("../sib").path, sib);
      assert.equal(classifySource("./").path, path.join(tmp, "a", "b"));
    });
  });

  test("drive absolute path is local on any platform", () => {
    assert.ok(DRIVE_ABS_RE.test("C:\\abs\\mk"));
    reject("C:\\definitely\\not\\here\\mk");
  });

  test("existing directory without marker is local but checked last", () => {
    const rel = path.basename(tmp);
    inDir(path.dirname(tmp), () => assert.equal(classifySource(rel).kind, "local"));
    fs.mkdirSync(path.join(tmp, "owner", "repo"), { recursive: true });
    inDir(tmp, () => assert.equal(classifySource("owner/repo").kind, "git"));
  });

  test("parent traversal to nowhere is rejected", () => {
    const deep = path.join(tmp, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    inDir(deep, () => {
      reject("../../etc");
      assert.equal(classifySource("../..").path, tmp);
    });
  });

  test("injection guards run before any branching", () => {
    assert.throws(() => classifySource("-upload-pack=evil"), /option/);
    assert.throws(() => classifySource("ext::sh -c evil"), /transport helper/);
  });

  test("unsafe shorthand segments are rejected", () => {
    for (const bad of ["owner/re:po", "owner/con", "own\\er/repo", "owner/", "owner/..", "/owner/repo/extra", "", "   ", "C:foo", "owner/repo/extra"]) reject(bad);
  });

  test("ipv6 literal url is not mistaken for transport helper", () => {
    assert.equal(classifySource("https://[::1]/r.git").kind, "git");
  });

  test("unknown form names the four forms", () => {
    assert.throws(() => classifySource("C:foo"), { message: "Unknown market source format: 'C:foo' - expected owner/repo, a git URL, a marketplace.json URL or a local path" });
  });
});
