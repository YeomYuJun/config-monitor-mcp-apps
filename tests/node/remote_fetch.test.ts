// tests/test_remote_library.py 의 LayoutDetect, Materialize, ManifestJsonFetch 를 옮긴 것.
import { test, describe, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { FetchError, GitError, detectLayout, fetchManifestJson, gitAvailable, manifestLimits, materialize, proxyFor } from "../../src/core/remote_fetch.ts";

let tmp = "";
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rf_test_")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("LayoutDetect", () => {
  const mk = (parts: string[], file?: string) => {
    const d = path.join(tmp, ...parts);
    fs.mkdirSync(d, { recursive: true });
    if (file) fs.writeFileSync(path.join(d, file), "x");
    return d;
  };

  test("lowercase root is adopted with identity map", () => {
    mk(["agents"]); mk(["skills"]); mk(["commands"]);
    const r = detectLayout(tmp);
    assert.deepEqual([...r.found].sort(), ["agents", "commands", "skills"]);
    assert.equal(r.map.skills, "skills");
  });

  test("uppercase root is matched case-insensitively", () => {
    mk(["Agents"]); mk(["Skills"]);
    const r = detectLayout(tmp);
    assert.deepEqual([...r.found].sort(), ["agents", "skills"]);
    assert.equal(r.map.agents, "Agents");
    assert.equal(r.map.skills, "Skills");
  });

  test("depth two becomes candidate not auto adopted", () => {
    mk(["packages", "skills"]);
    const r = detectLayout(tmp);
    assert.deepEqual(r.found, []);
    assert.deepEqual(r.candidates, [{ category: "skills", path: path.join("packages", "skills") }]);
  });

  test("lowercase skill.md marker is detected", () => {
    mk(["kit", "my-skill"], "skill.md");
    assert.deepEqual(detectLayout(tmp).candidates, [{ category: "skills", path: "kit" }]);
  });

  test("marker under a dot directory is ignored", () => {
    mk(["kit", ".hidden", "s"], "SKILL.md");
    assert.deepEqual(detectLayout(tmp).candidates, []);
  });

  test("empty repo yields nothing but does not raise", () => {
    assert.deepEqual(detectLayout(tmp), { map: {}, found: [], candidates: [] });
    assert.deepEqual(detectLayout(path.join(tmp, "missing")), { map: {}, found: [], candidates: [] });
  });
});

describe("junction folders", { skip: process.platform !== "win32" }, () => {
  // 정션은 같은 임시 폴더 안의 픽스처만 가리키게 하고, 정리할 때 링크만 지운다(rmdirSync).
  const withJunction = (target: string, at: string, fn: () => void) => {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, "junction");
    try {
      fn();
    } finally {
      fs.rmdirSync(at);
    }
  };

  test("a skill marker behind a junction is detected, like python os.walk", () => {
    fs.mkdirSync(path.join(tmp, "fixture", "s"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "fixture", "s", "SKILL.md"), "x");
    const repo = path.join(tmp, "repo");
    withJunction(path.join(tmp, "fixture"), path.join(repo, "kit", "linked"), () => {
      assert.deepEqual(detectLayout(repo).candidates, [{ category: "skills", path: "kit" }]);
    });
  });

  test("a junction loop does not recurse forever", () => {
    const repo = path.join(tmp, "repo");
    withJunction(path.join(repo, "kit"), path.join(repo, "kit", "a", "loop"), () => {
      assert.deepEqual(detectLayout(repo).candidates, []);
    });
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf-8" }).trim();
}

describe("Materialize", { skip: !gitAvailable() && "git 없음" }, () => {
  let origin = "";
  let head = "";
  let url = "";

  beforeEach(() => {
    origin = path.join(tmp, "origin");
    for (const [p, body] of [[path.join("skills", "s1", "SKILL.md"), "---\nname: s1\n---\nbody\n"], [path.join("plugins", "p1", "note.md"), "plugin file\n"], ["README.md", "readme\n"]]) {
      fs.mkdirSync(path.dirname(path.join(origin, p)), { recursive: true });
      fs.writeFileSync(path.join(origin, p), body);
    }
    git(origin, "init", "-q", "-b", "main");
    git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
    head = git(origin, "rev-parse", "HEAD");
    url = "file:///" + origin.replaceAll("\\", "/").replace(/^\/+/, "");
  });

  test("by ref returns resolved sha", async () => {
    const dest = path.join(tmp, "cache1");
    assert.equal(await materialize(dest, url, "main"), head);
    assert.ok(fs.existsSync(path.join(dest, "skills", "s1", "SKILL.md")));
  });

  test("by sha is reproducible", async () => {
    assert.equal(await materialize(path.join(tmp, "cache2"), url, null, head), head);
  });

  test("sparse checkout limits worktree", async () => {
    const dest = path.join(tmp, "cache3");
    await materialize(dest, url, "main", null, ["plugins/p1"]);
    assert.ok(fs.existsSync(path.join(dest, "plugins", "p1", "note.md")));
    assert.ok(!fs.existsSync(path.join(dest, "skills", "s1", "SKILL.md")));
  });

  test("sparse can be expanded in place", async () => {
    // 마켓 지연 확장: 매니페스트만 받아둔 클론에 경로를 덧붙인다.
    const dest = path.join(tmp, "cache4");
    await materialize(dest, url, "main", null, ["plugins/p1"]);
    await materialize(dest, url, "main", null, ["plugins/p1", "skills"]);
    assert.ok(fs.existsSync(path.join(dest, "skills", "s1", "SKILL.md")));
  });

  test("bad url raises GitError without leaving partial cache", async () => {
    const dest = path.join(tmp, "cache5");
    await assert.rejects(materialize(dest, "file:///definitely/not/a/repo", "main"), GitError);
    assert.ok(!fs.existsSync(path.join(dest, ".git", "FETCH_HEAD")));
  });

  test("autocrlf disabled and longpaths enabled in the clone", async () => {
    const dest = path.join(tmp, "cache6");
    await materialize(dest, url, "main");
    assert.equal(execFileSync("git", ["config", "--local", "core.autocrlf"], { cwd: dest, encoding: "utf-8" }).trim(), "false");
    assert.equal(execFileSync("git", ["config", "--local", "core.longpaths"], { cwd: dest, encoding: "utf-8" }).trim(), "true");
  });

  test("CRLF content is stored byte for byte", async () => {
    // core.autocrlf=false 가 없으면 Windows git 이 줄바꿈을 바꿔 내용 해시가 달라진다.
    fs.writeFileSync(path.join(origin, "crlf.txt"), "a\r\nb\r\n");
    git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "crlf");
    const dest = path.join(tmp, "cache_crlf");
    await materialize(dest, url, "main");
    assert.deepEqual(fs.readFileSync(path.join(dest, "crlf.txt")), Buffer.from("a\r\nb\r\n"));
  });

  test("rejects malicious urls before touching disk", async () => {
    const dest = path.join(tmp, "cache7");
    await assert.rejects(materialize(dest, "--upload-pack=evil", "main"), (e: Error) => e instanceof GitError && e.message.includes("like an option"));
    assert.ok(!fs.existsSync(dest));
    const dest2 = path.join(tmp, "cache8");
    await assert.rejects(materialize(dest2, "ftp://example.invalid/x.git", "main"), (e: Error) => e instanceof GitError && e.message.includes("allowed list"));
    assert.ok(!fs.existsSync(dest2));
  });

  test("rejects option-like ref and non-hex sha", async () => {
    const dest = path.join(tmp, "cache9");
    await assert.rejects(materialize(dest, url, "--upload-pack=evil"), (e: Error) => e instanceof GitError && e.message === "Invalid ref: '--upload-pack=evil'");
    assert.ok(!fs.existsSync(dest));
    const dest2 = path.join(tmp, "cache10");
    await assert.rejects(materialize(dest2, url, null, "not-hex!"), (e: Error) => e instanceof GitError && e.message === "Invalid sha (not hex): 'not-hex!'");
    assert.ok(!fs.existsSync(dest2));
  });

  test("sha mismatch is a GitError", async () => {
    const dest = path.join(tmp, "cache11");
    await assert.rejects(materialize(dest, url, "main", "0".repeat(40)), GitError);
    assert.ok(!fs.existsSync(dest));
  });
});

describe("ManifestJsonFetch", () => {
  const MANIFEST_BODY = Buffer.from(JSON.stringify({ name: "jsonmarket", plugins: [
    { name: "ext1", description: "remote only", category: "development", source: { source: "url", url: "https://example.invalid/x.git", sha: "0".repeat(40) } }] }));
  const routes: Record<string, [number, Buffer, Record<string, string>?]> = {
    "/ok/marketplace.json": [200, MANIFEST_BODY],
    "/bad/marketplace.json": [200, Buffer.from("{not json")],
    "/noplugins/marketplace.json": [200, Buffer.from('{"name": "x"}')],
    "/big/marketplace.json": [200, Buffer.from('{"plugins": [], "pad": "' + "a".repeat(4096) + '"}')],
    "/bom/marketplace.json": [200, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), MANIFEST_BODY])],
    "/moved/marketplace.json": [302, Buffer.alloc(0), { Location: "/ok/marketplace.json" }],
    "/toftp/marketplace.json": [302, Buffer.alloc(0), { Location: "ftp://example.invalid/m.json" }],
  };
  let srv: http.Server;
  let base = "";
  let agent = "";
  let dest = "";

  before(async () => {
    srv = http.createServer((req, res) => {
      agent = String(req.headers["user-agent"]);
      const hit = routes[req.url ?? ""];
      if (!hit) {
        res.writeHead(404).end();
        return;
      }
      const [status, body, headers] = hit;
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(body.length), ...(headers ?? {}) });
      res.end(body);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });
  after(() => srv.close());
  beforeEach(() => { dest = path.join(tmp, "repo"); });
  const manifestPath = () => path.join(dest, ".claude-plugin", "marketplace.json");

  test("manifest is written where the git path puts it", async () => {
    const sha = await fetchManifestJson(dest, base + "/ok/marketplace.json");
    assert.equal(sha, crypto.createHash("sha256").update(MANIFEST_BODY).digest("hex").slice(0, 12));
    assert.deepEqual(fs.readFileSync(manifestPath()), MANIFEST_BODY);
    assert.equal(agent, "config-monitor");
  });

  test("redirect is followed", async () => {
    await fetchManifestJson(dest, base + "/moved/marketplace.json");
    assert.deepEqual(fs.readFileSync(manifestPath()), MANIFEST_BODY);
  });

  test("redirect to a non-http scheme is refused", async () => {
    await assert.rejects(fetchManifestJson(dest, base + "/toftp/marketplace.json"), FetchError);
    assert.ok(!fs.existsSync(dest));
  });

  test("malformed json leaves no partial cache", async () => {
    await assert.rejects(fetchManifestJson(dest, base + "/bad/marketplace.json"),
      (e: Error) => e instanceof FetchError && e.message === "The manifest is not valid JSON: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)");
    assert.ok(!fs.existsSync(dest));
  });

  test("a body with a BOM is refused like Python json.loads", async () => {
    await assert.rejects(fetchManifestJson(dest, base + "/bom/marketplace.json"),
      (e: Error) => e instanceof FetchError && e.message === "The manifest is not valid JSON: Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)");
    assert.ok(!fs.existsSync(dest));
  });

  test("missing plugins array is rejected", async () => {
    await assert.rejects(fetchManifestJson(dest, base + "/noplugins/marketplace.json"), FetchError);
    assert.ok(!fs.existsSync(dest));
  });

  test("http error status is a FetchError", async () => {
    await assert.rejects(fetchManifestJson(dest, base + "/missing.json"), (e: Error) => e instanceof FetchError && e.message.startsWith("Cannot download the manifest: HTTP Error 404"));
  });

  test("oversized body is refused by the cap", async () => {
    const keep = manifestLimits.maxBytes;
    manifestLimits.maxBytes = 512;
    try {
      await assert.rejects(fetchManifestJson(dest, base + "/big/marketplace.json"), (e: Error) => e instanceof FetchError && e.message === "The manifest exceeds the size limit (512 bytes)");
    } finally {
      manifestLimits.maxBytes = keep;
    }
    assert.ok(!fs.existsSync(dest));
  });

  test("non-http scheme is refused without touching disk", async () => {
    for (const u of ["file:///c:/x/marketplace.json", "ssh://h/m.json", "-x", "git://h/m.json"]) {
      await assert.rejects(fetchManifestJson(dest, u), FetchError, u);
    }
    assert.ok(!fs.existsSync(dest));
  });

  test("failed refetch does not clobber the cached manifest", async () => {
    await fetchManifestJson(dest, base + "/ok/marketplace.json");
    await assert.rejects(fetchManifestJson(dest, base + "/bad/marketplace.json"), FetchError);
    assert.deepEqual(fs.readFileSync(manifestPath()), MANIFEST_BODY);
    assert.ok(!fs.existsSync(manifestPath() + ".tmp"));
  });

  test("error messages do not talk about git", async () => {
    await assert.rejects(fetchManifestJson(dest, base + "/noplugins/marketplace.json"), (e: Error) => e instanceof FetchError && !e.message.toLowerCase().includes("git"));
  });
});

describe("ManifestJsonProxy", () => {
  const BODY = Buffer.from(JSON.stringify({ name: "viaproxy", plugins: [] }));
  let proxy: http.Server;
  let proxyUrl = "";
  const seen: string[] = [];
  const keep: Record<string, string | undefined> = {};
  const KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];

  before(async () => {
    // http 대상은 절대 주소 GET 을, https 대상은 CONNECT 를 받는 최소 프록시. CONNECT 는 거부해 터널 실패 경로를 본다.
    proxy = http.createServer((req, res) => {
      seen.push(`GET ${req.url} auth=${req.headers["proxy-authorization"] ?? ""}`);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(BODY.length) }).end(BODY);
    });
    proxy.on("connect", (req, socket) => {
      seen.push(`CONNECT ${req.url}`);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyUrl = `http://user:p%40ss@127.0.0.1:${(proxy.address() as { port: number }).port}`;
    for (const k of KEYS) keep[k] = process.env[k];
  });
  after(() => proxy.close());
  beforeEach(() => {
    seen.length = 0;
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (keep[k] === undefined) delete process.env[k];
      else process.env[k] = keep[k];
    }
  });

  test("proxyFor follows the proxy env and NO_PROXY", () => {
    const env = { HTTPS_PROXY: "proxy.local:8080", http_proxy: "http://p2:3128", NO_PROXY: "internal.example, .corp" };
    assert.equal(proxyFor(new URL("https://github.com/x"), env)?.host, "proxy.local:8080");
    assert.equal(proxyFor(new URL("http://github.com/x"), env)?.host, "p2:3128");
    assert.equal(proxyFor(new URL("https://internal.example/x"), env), null);
    assert.equal(proxyFor(new URL("https://a.corp/x"), env), null);
    assert.equal(proxyFor(new URL("https://github.com/x"), {}), null);
  });

  test("an http manifest is fetched through HTTP_PROXY with proxy credentials", async () => {
    process.env.HTTP_PROXY = proxyUrl;
    const dest = path.join(tmp, "viaproxy");
    await fetchManifestJson(dest, "http://market.example.invalid/m.json");
    assert.deepEqual(fs.readFileSync(path.join(dest, ".claude-plugin", "marketplace.json")), BODY);
    assert.deepEqual(seen, [`GET http://market.example.invalid/m.json auth=Basic ${Buffer.from("user:p@ss").toString("base64")}`]);
  });

  test("an https manifest opens a CONNECT tunnel through HTTPS_PROXY", async () => {
    process.env.HTTPS_PROXY = proxyUrl;
    await assert.rejects(fetchManifestJson(path.join(tmp, "tunnel"), "https://market.example.invalid/m.json"),
      (e: Error) => e instanceof FetchError && e.message.includes("Tunnel connection failed: 403"));
    assert.deepEqual(seen, ["CONNECT market.example.invalid:443"]);
  });
});
