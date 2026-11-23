// 도구 실행기의 자식 프로세스 진입점: node --import tsx tests/golden/tool-entry.ts <root> <steps JSON>
// 데모 프로필 env 로 띄운 한 프로세스에서 buildTools 의 도구를 단계마다 차례로 부르고(서버와 같은 상주 조건),
// 단계별 결과 문서(정규화 전)를 JSON 배열 한 줄로 쓴다. 자리표시자는 Demo.resolve 로 단계 직전에 푼다.
import fs from "node:fs";
import path from "node:path";
import { Demo, REPO, type StepResult } from "./golden.ts";
import { buildTools } from "../../src/mcp-tools.ts";

const [root, spec] = process.argv.slice(2);
const steps = JSON.parse(spec) as [string, Record<string, unknown>, string[]?][];
const demo = Demo.at(root);
const tools = new Map(buildTools(path.join(REPO, "src")).map((d) => [d.name, d]));
const raw: StepResult[] = [];

const resolve = (v: unknown): unknown => {
  if (typeof v === "string") return demo.resolve(v, raw);
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [demo.resolve(k, raw), resolve(x)]));
  return v;
};

const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`도구 없음: ${name}`);
  const r = await tool.run(resolve(args));
  return JSON.parse(r.content[0].text) as unknown;
};

if (process.argv[4] === "parallel") {
  // 동시에 들어온 호출(서버가 요청을 겹쳐 받는 경우). 단계 사이의 자리표시자는 쓰지 않는다.
  const docs = await Promise.all(steps.map(([name, args]) => call(name, args)));
  for (const doc of docs) raw.push({ argv: [], exit: 0, doc });
} else {
  for (const [name, args, mkdir] of steps) {
    for (const m of mkdir ?? []) fs.mkdirSync(demo.resolve(m, raw), { recursive: true });
    raw.push({ argv: [name], exit: 0, doc: await call(name, args) });
  }
}
process.stdout.write(JSON.stringify(raw.map((s) => s.doc)) + "\n");
