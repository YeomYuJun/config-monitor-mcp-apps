// transfer.xcheck.fixture.ts 의 입력으로 TS 판 출력을 저장된 Python 판 출력·번들과 비교한다(실행에 Python 이 필요 없다).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unifiedDiff } from "../../src/core/cas.ts";
import { Bundle, treeDigest, treeRows } from "../../src/core/transfer.ts";
import {
  buildSource, buildTree, bundleArgs, bundlePath, diffCases, EXPECTED, KINDS, layout, leaks, makeRoot, materialize, members,
  miscArgs, normalize, rootReps, runTs, SECRET_VALUE, type Layout, type Run, type XcheckFixture,
} from "./transfer.xcheck.fixture.ts";

const text = fs.readFileSync(EXPECTED, "utf-8");
const fx = JSON.parse(text) as XcheckFixture;
let L: Layout;

before(() => {
  L = layout(makeRoot(), makeRoot());
  for (const who of ["py", "ts"] as const) for (const kind of KINDS) materialize(fx.bundles[`${who}-${kind}`], bundlePath(L, who, kind));
  fs.mkdirSync(L.b, { recursive: true });
});

after(() => {
  for (const r of [L.root, L.src]) fs.rmSync(r, { recursive: true, force: true });
});

const sha = (x: Uint8Array | string) => "sha256:" + crypto.createHash("sha256").update(x).digest("hex");

const TEXT_KEYS = new Set(["message", "warnings", "report", "reason", "error"]);
const isDiffHeader = (l: unknown, i: number) => i < 2 && typeof l === "string" && (l.startsWith("--- ") || l.startsWith("+++ "));

function maskText(v: unknown, key = ""): unknown {
  if (TEXT_KEYS.has(key) && typeof v === "string") return "<TEXT>";
  if (TEXT_KEYS.has(key) && Array.isArray(v)) return v.map((x) => (typeof x === "string" ? "<TEXT>" : maskText(x)));
  if (key === "diff" && Array.isArray(v)) return v.map((l, i) => (isDiffHeader(l, i) ? "<HEADER>" : l));
  if (Array.isArray(v)) return v.map((x) => maskText(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskText(x, k)]));
  return v;
}

function maskBundleText(s: string): string {
  return s.replace(/("reason": )"(?:[^"\\]|\\.)*"/g, '$1"<TEXT>"')
    .replace(/("lines": \[\n)([\s\S]*?)(\n {2}\])/, (_m, a: string, body: string, c: string) =>
      a + body.split("\n").map((l) => l.replace(/^(\s*)"(?:[^"\\]|\\.)*"(,?)$/, '$1"<TEXT>"$2')).join("\n") + c);
}

async function sameAsPython(argvs: string[][], want: Run[]): Promise<void> {
  assert.equal(argvs.length, want.length);
  for (const [i, argv] of argvs.entries()) {
    const doc = await runTs(L.b, argv);
    assert.equal(doc.ok ? 0 : 1, want[i].exit, argv.join(" "));
    assert.deepEqual(maskText(normalize(doc, [L.root, fx.capture_src])), maskText(want[i].doc), argv.join(" "));
  }
}

test("fixture holds no real home path or host name", () => {
  assert.deepEqual(leaks(fx, text), []);
});

test("unified diff matches stored python difflib output", () => {
  const cases = diffCases();
  assert.equal(cases.length, fx.difflib.length);
  cases.forEach(([a, b, n], i) => assert.deepEqual(unifiedDiff(a, b, "현재", "번들", n, ""), fx.difflib[i], `case ${i}`));
});

test("tree rows and digest match stored python output", () => {
  buildTree(L.tree);
  const [rows, size] = treeRows(L.tree);
  assert.deepEqual({ rows, size, digest: treeDigest(rows) }, fx.tree);
});

for (const kind of KINDS) {
  test(`python-written ${kind} bundle is read by ts and plans like python`, async () => {
    const p = bundlePath(L, "py", kind);
    const bnd = new Bundle(p);
    assert.equal(bnd.hash, sha(bnd.read("manifest.json")));
    for (const it of bnd.manifest.items as any[]) {
      if (it.strategy === "file") assert.equal(sha(bnd.read(`files/${it.rel}`)), it.hash, it.id);
      else if (it.strategy === "tree") assert.equal(treeDigest(bnd.tree(it.rel).map(([r, d]) => [r, sha(d)])), it.hash, it.id);
    }
    assert.equal((bnd.secrets as any)["cc.settings"]["env.API_TOKEN"], SECRET_VALUE);
    await sameAsPython(bundleArgs(p), fx.runs[`py-${kind}`]);
  });

  test(`ts-written ${kind} bundle was read by python, and both plan it the same`, async () => {
    const p = bundlePath(L, "ts", kind);
    const py = fx.py_read_ts[`ts-${kind}`];
    assert.equal(new Bundle(p).hash, py.hash);
    assert.deepEqual(Object.values(py.ok), Array(7).fill(true), JSON.stringify(py.ok));
    assert.equal(py.secrets["cc.mcp-user/srv"]["env.GITHUB_TOKEN"], SECRET_VALUE);
    await sameAsPython(bundleArgs(p), fx.runs[`ts-${kind}`]);
  });
}

test("plan without a bundle fails like python", async () => {
  await sameAsPython(miscArgs(L), fx.runs.misc);
});

for (const kind of KINDS) {
  test(`ts still writes the stored ts ${kind} bundle`, async () => {
    if (!fs.existsSync(L.a)) buildSource(L);
    const out = path.join(L.bundles, kind === "zip" ? "new.cmbundle" : "new-bundle");
    const res = await runTs(L.a, ["export", "--out", out, "--include-secrets"]);
    assert.ok(res.ok, JSON.stringify(res));
    // 캡처 때 원본 루트로 바꿔 끼우면 경로가 든 내용도 같은 바이트가 된다(루트 길이가 같다). 만든 시각과 해시만 다르다.
    const cr = fx.capture_src;
    const forms = [cr.replace(/\\/g, "\\\\"), cr, cr.replace(/\\/g, "/")];   // rootReps 의 순서(두 겹, 원형, '/')
    const toCapture = (s: string) => rootReps([L.src]).reduce((a, [re], i) => a.replace(re, () => forms[i]), s);
    const mask = (name: string, s: string) => (name === "manifest.json" || name === "report.json"
      ? maskBundleText(s.replace(/sha256:[0-9a-f]{64}/g, "sha256:<HASH>").replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d/g, "<TIME>")) : s);
    const got = members(out).map(([n, b]) => [n, mask(n, toCapture(b.toString("utf8")))]);
    const want = members(bundlePath(L, "ts", kind)).map(([n, b]) => [n, mask(n, b.toString("utf8"))]);
    assert.deepEqual(got.map(([n]) => n), want.map(([n]) => n));
    for (const [i, [n, s]] of got.entries()) assert.equal(s, want[i][1], n);
  });
}
