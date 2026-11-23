// claude_config.fixture.ts 의 픽스처에서 TS 판 출력을 저장된 Python 판 출력과 비교한다(실행에 Python 이 필요 없다).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { main } from "../../src/core/claude_config.ts";
import { build, EXPECTED, makeRoot, normalize, type Fixture } from "./claude_config.fixture.ts";

const expected = JSON.parse(fs.readFileSync(EXPECTED, "utf-8")) as { argv: string[]; exit: number; doc: unknown }[];
let fx: Fixture;
let saved: Record<string, string | undefined> = {};

before(() => {
  fx = build(makeRoot());
  saved = Object.fromEntries(Object.keys(fx.env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, fx.env);
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(fx.root, { recursive: true, force: true });
});

expected.forEach((exp, i) => {
  test(`python parity: ${exp.argv.join(" ")}`, async () => {
    const doc = await main(fx.cases[i]);
    assert.equal(doc.ok ? 0 : 1, exp.exit);
    const { message: _got, ...got } = normalize(doc, fx.root) as Record<string, unknown>;
    const { message: _want, ...want } = exp.doc as Record<string, unknown>;
    assert.deepEqual(got, want);
  });
});
