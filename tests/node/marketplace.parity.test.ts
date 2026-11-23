// marketplace.parity.json 의 Python 판 출력과 TS 판 출력을 비교한다. 두 모듈은 tests/golden 에 케이스가 없다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as m from "../../src/core/marketplace.ts";
import * as rf from "../../src/core/remote_fetch.ts";

interface Parity {
  files: Record<string, string>;
  dirs: string[];
  inputs: Record<string, any>;
  expected: Record<string, unknown>;
}

const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "marketplace.parity.json"), "utf-8")) as Parity;
let root = "";
let cwd = "";
const actual: Record<string, unknown> = {};

function call(fn: (...a: any[]) => unknown, ...a: unknown[]): unknown {
  try {
    return { ok: fn(...a) };
  } catch (e) {
    if (e instanceof m.ManifestError) return { err: "ManifestError" };
    return { err: (e as Error).name };
  }
}

function dropMsg(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropMsg);
  if (v === null || typeof v !== "object") return v;
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!(k === "msg" && "err" in v)) o[k] = dropMsg(x);
  return o;
}

before(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mp_parity_")));
  for (const d of fixture.dirs) fs.mkdirSync(path.join(root, ...d.split("/")), { recursive: true });
  for (const [rel, body] of Object.entries(fixture.files)) fs.writeFileSync(path.join(root, ...rel.split("/")), body, "utf-8");
  cwd = process.cwd();
  process.chdir(root);
  const inp = fixture.inputs;
  const fx = path.join(root, "fx");
  const stripMf = (r: any) => ("ok" in r
    ? { ok: { name: r.ok.name, description: r.ok.description, owner: r.ok.owner, plugins: r.ok.plugins, renames: r.ok.renames, by_name: Object.keys(r.ok.by_name).sort() } }
    : r);
  actual.segments = inp.segments.map((s: unknown) => call(m.safeSegment, s));
  actual.segments_what = inp.segments.map((s: unknown) => call(m.safeSegment, s, "플러그인 이름"));
  actual.relpaths = inp.relpaths.map((p: unknown) => call(m.safeRelpath, p));
  actual.classify = inp.classify.map((s: string) => call(m.classifySource, s));
  actual.classify_local = inp.classify_local.map((s: string) => call(m.classifySource, s.replace("<ROOT>", root)));
  actual.specs = inp.specs.map((e: Record<string, unknown>) => call(m.sourceSpec, e));
  actual.parse = inp.parse_files.map((p: string) => stripMf(call(m.parseManifest, path.join(fx, p))));
  const mf0 = m.parseManifest(path.join(fx, "m0.json"));
  actual.catalog = inp.queries.map((q: [string | null, string | null, number, number]) => call(m.catalog, mf0, inp.fetched, ...q));
  actual.resolve = inp.resolves.map((n: string) => call((x: string) => m.resolvePlugin(mf0, x), n));
  actual.display = mf0.plugins.filter((e) => e !== null && typeof e === "object" && !Array.isArray(e)).map((e) => m.displayName(e as Record<string, unknown>));
  actual.layout = rf.detectLayout(path.join(fx, "layout"));
  const esc = (s: string) => JSON.stringify(s).slice(1, -1);
  const text = JSON.stringify(actual)
    .replaceAll(esc(m.pyRepr(root).slice(1, -1)), "<ROOT-REPR>")
    .replaceAll(esc(root), "<ROOT>");
  Object.assign(actual, JSON.parse(text));
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(root, { recursive: true, force: true });
});

for (const [group, raw] of Object.entries(fixture.expected)) {
  const exp = dropMsg(raw);
  test(`parity ${group}`, () => {
    if (!Array.isArray(exp)) {
      assert.deepEqual(actual[group], exp);
      return;
    }
    const act = actual[group] as unknown[];
    assert.equal(act.length, exp.length);
    exp.forEach((e, i) => assert.deepEqual(act[i], e, `${group}[${i}] ${JSON.stringify(fixture.inputs[group]?.[i] ?? null)}`));
  });
}
