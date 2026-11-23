import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pyOracle } from "./py_oracle.ts";
import {
  CliExit, JsonArgumentParser, SUPPRESS, checkFields, emit, exitCode, guard, guardOutcome, makeDoc, pyDumps,
} from "../../src/core/cli_result.ts";
class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("makeDoc keeps emit key order and drops null target/detail", () => {
  const doc = makeDoc(1, "ok", "m", { extra: [1], target: 5, detail: null, n: null });
  assert.deepEqual(Object.keys(doc), ["ok", "code", "message", "target", "extra", "n"]);
  assert.equal(doc.ok, true);
  assert.equal(doc.target, "5");
  assert.equal(doc.n, null);
});

test("checkFields rejects reserved keys", () => {
  assert.throws(() => checkFields({ ok: 1, code: 2, x: 3 }), /Fields clash with reserved keys: \['code', 'ok'\]/);
  assert.throws(() => makeDoc(true, "ok", "m", { message: "x" } as never));
});

test("emit throws CliExit and guard returns the doc", async () => {
  assert.throws(() => emit(false, "not_found", "없음", { target: "/x" }), CliExit);
  const doc = await guard(() => emit(false, "not_found", "없음", { target: "/x" }));
  assert.deepEqual(doc, { ok: false, code: "not_found", message: "없음", target: "/x" });
  assert.equal(exitCode(doc), 1);
  const out = await guardOutcome(() => emit(true, "ok", "m", { indent: 2 }));
  assert.equal(out.indent, 2);
  assert.equal(exitCode(out.doc), 0);
});

test("guard maps exceptions through the code table, else internal", async () => {
  let cleaned = false;
  const a = await guard(() => { throw new LockTimeoutError("busy(8s 대기): x"); }, [[LockTimeoutError, "lock_timeout"]], () => { cleaned = true; });
  assert.equal(a.code, "lock_timeout");
  assert.equal(a.message, "TimeoutError: busy(8s 대기): x");
  assert.equal(a.detail, "busy(8s 대기): x");
  assert.ok(cleaned);
  const b = await guard(async () => { throw new TypeError("bad"); }, [[LockTimeoutError, "lock_timeout"]]);
  assert.equal(b.code, "internal");
  assert.equal(b.message, "TypeError: bad");
});

test("pyDumps matches Python json.dumps byte for byte", () => {
  const v = { b: 1, a: [true, null, "é\n\"\\"], c: {}, d: [] , e: "\u0001\u007f"};
  // python -c 'json.dumps(v, ensure_ascii=False)' 와 같은 문자열
  assert.equal(pyDumps(v, { ensureAscii: false }), '{"b": 1, "a": [true, null, "é\\n\\"\\\\"], "c": {}, "d": [], "e": "\\u0001\u007f"}');
  assert.equal(pyDumps(v), '{"b": 1, "a": [true, null, "\\u00e9\\n\\"\\\\"], "c": {}, "d": [], "e": "\\u0001\\u007f"}');
  assert.equal(pyDumps({ b: 1, a: { y: 2, x: [] } }, { sortKeys: true, separators: [",", ":"] }), '{"a":{"x":[],"y":2},"b":1}');
  assert.equal(pyDumps({ a: [1, { b: [] }] }, { indent: 2 }), '{\n  "a": [\n    1,\n    {\n      "b": []\n    }\n  ]\n}');
});

test("pyDumps agrees with Python on a sample", () => {
  const sample = { "한": ["x", 1, -2.5, null, false], z: { "": "\t" }, "😀": "\u2028" };
  const script = "import json,sys; v=json.loads(sys.stdin.read()); " +
    "print(json.dumps([json.dumps(v, ensure_ascii=False, indent=2), json.dumps(v, sort_keys=True, separators=(',',':'))]))";
  const [pretty, compact] = pyOracle("cli_result")(`${script} ${JSON.stringify(sample)}`, {}, () => {
    const py = spawnSync("python", ["-c", script], {
      input: JSON.stringify(sample), encoding: "utf-8", env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    assert.equal(py.status, 0, py.stderr);
    return JSON.parse(py.stdout) as [string, string];
  });
  assert.equal(pyDumps(sample, { indent: 2, ensureAscii: false }), pretty);
  assert.equal(pyDumps(sample, { sortKeys: true, separators: [",", ":"] }), compact);
});

function parser(): JsonArgumentParser {
  const ap = new JsonArgumentParser("demo");
  ap.addArgument("--store", { default: "S" });
  ap.addArgument("--cache", { default: null });
  const sub = ap.addSubparsers({ dest: "op", required: true });
  const t = sub.addParser("track");
  t.addArgument("paths", { nargs: "+" });
  t.addArgument("--json", { action: "store_true" });
  const c = sub.addParser("catalog");
  c.addArgument("--limit", { type: "int", default: 50 });
  c.addArgument("--include-missing", { action: "store_true" });
  c.addArgument("--projects", { nargs: "*", default: null });
  c.addArgument("--scope", { choices: ["global", "project"] });
  c.addArgument("--cache", { default: SUPPRESS });
  const r = sub.addParser("restore");
  r.addArgument("path");
  r.addArgument("--from", { dest: "frm", required: true });
  r.addArgument("-m", "--message", { default: "" });
  return ap;
}

test("parser: parent options, subcommand, positionals, flags", () => {
  assert.deepEqual(parser().parse(["--store", "X", "track", "--json", "a", "b"]), { store: "X", cache: null, op: "track", paths: ["a", "b"], json: true });
  assert.deepEqual(parser().parse(["--cache=C", "catalog", "--limit", "-1", "--projects", "p1", "p2", "--include"]),
    { store: "S", cache: "C", op: "catalog", limit: -1, include_missing: true, projects: ["p1", "p2"], scope: null });
  assert.deepEqual(parser().parse(["catalog", "--projects"]).projects, []);
  assert.deepEqual(parser().parse(["restore", "p", "--from", "s1", "-m", "msg"]), { store: "S", cache: null, op: "restore", path: "p", frm: "s1", message: "msg" });
});

test("parser: '-' values follow CPython 3.12 _parse_optional", () => {
  // 공백이 있으면 값, 음수 모양이면 값, 짧은 옵션은 값을 붙여 쓸 수 있다.
  const a = parser().parse(["restore", "--x y", "--from", "--- x", "-m", "---\ndescription: x\n---\n"]);
  assert.equal(a.path, "--x y");
  assert.equal(a.frm, "--- x");
  assert.equal(a.message, "---\ndescription: x\n---\n");
  assert.equal(parser().parse(["restore", "p", "--from", "s", "-mfoo"]).message, "foo");
  assert.equal(parser().parse(["restore", "p", "--from", "-1.5"]).frm, "-1.5");
  assert.equal(parser().parse(["restore", "p", "--fr=s", "--mess", "-"]).message, "-");
});

// 이 PC 의 Python 3.12.10 에서 json.dumps 로 뽑은 값(경계: 1e-4, 1e16, 지수 두 자리, e+ 부호).
const PY_FLOATS = [
  "0.0001", "9.999e-05", "1.234e-05", "1e-07", "0.00012", "1e-05", "0.000123456", "5e-324",
  "2.2250738585072014e-308", "1.7976931348623157e+308", "1000000000000000.5", "9999999999999998.0",
  "9007199254740994.0", "1e+16", "1.5e+16", "1e+17", "1e+21", "1e+22", "1.2345678901234568e+20", "0.1",
  "0.30000000000000004", "0.3333333333333333", "0.6666666666666666", "-1.5e-10", "-0.5", "123.456", "2.5",
  "1e+100", "1.5e-100", "3.14159", "100.5", "-1e+16", "-9.999e-05", "0.001", "12345678.9", "1e-10",
  "-2.5e-300", "4.35e+18", "1234567890123456.8",
];

test("pyDumps writes floats like Python repr", () => {
  for (const s of PY_FLOATS) assert.equal(pyDumps(Number(s)), s, s);
  assert.equal(pyDumps([1e-7, 1.234e-5, 1.2345678901234568e20]), "[1e-07, 1.234e-05, 1.2345678901234568e+20]");
});

test("pyDumps keeps safe integers as int", () => {
  // JSON.parse 가 1.0 과 1 을 구분하지 못하므로 정수 값은 int 로 쓴다(기존 동작).
  assert.equal(pyDumps(1.0), "1");
  assert.equal(pyDumps(-3), "-3");
  assert.equal(pyDumps(1e15), "1000000000000000");
  assert.equal(pyDumps(Number.MAX_SAFE_INTEGER), "9007199254740991");
  assert.equal(pyDumps(0), "0");
});

async function parseError(argv: string[]): Promise<string> {
  const doc = await guard(() => parser().parse(argv));
  assert.equal(doc.code, "invalid_arg");
  assert.equal(doc.ok, false);
  return doc.message;
}

test("parser: errors are invalid_arg with argparse wording", async () => {
  assert.equal(await parseError([]), "demo: the following arguments are required: op");
  assert.equal(await parseError(["nope"]), "demo: argument op: invalid choice: 'nope' (choose from track, catalog, restore)");
  assert.equal(await parseError(["track"]), "demo track: the following arguments are required: paths");
  assert.equal(await parseError(["restore", "p"]), "demo restore: the following arguments are required: --from");
  assert.equal(await parseError(["catalog", "--limit", "x"]), "demo catalog: argument --limit: invalid int value: 'x'");
  assert.equal(await parseError(["catalog", "--scope", "all"]), "demo catalog: argument --scope: invalid choice: 'all' (choose from global, project)");
  assert.equal(await parseError(["catalog", "--scope", "it's"]), "demo catalog: argument --scope: invalid choice: \"it's\" (choose from global, project)");
  assert.equal(await parseError(["track", "a", "--json=1"]), "demo track: argument --json: ignored explicit argument '1'");
  // 공백 없이 줄바꿈만 있는 '-' 시작 값은 Python 3.12 에서도 옵션으로 읽혀 값이 없다고 나온다.
  assert.equal(await parseError(["restore", "p", "--from", "---\nx"]), "demo restore: argument --from: expected one argument");
  assert.equal(await parseError(["restore", "p", "--from"]), "demo restore: argument --from: expected one argument");
  assert.equal(await parseError(["track", "a", "--store"]), "demo: unrecognized arguments: --store");
});

test("runMain prints one JSON line and sets the exit code", () => {
  const code = `import { runMain, emit } from "./src/core/cli_result.ts"; await runMain(() => emit(false, "x", "한글"));`;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: ROOT, encoding: "utf-8" });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, '{"ok": false, "code": "x", "message": "한글"}\n');
});
