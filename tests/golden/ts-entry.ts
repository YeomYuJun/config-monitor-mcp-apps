// tsRunner 의 자식 프로세스 진입점: node --import tsx tests/golden/ts-entry.ts <module> <argv...>
// src/core/<module>.ts 의 main(argv) 결과를 python 판과 같은 한 줄 JSON 으로 쓰고 같은 종료 코드로 끝난다.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./golden.ts";
import { exitCode, makeDoc, pyDumps, type CliDoc } from "../../src/core/cli_result.ts";
import { NotImplementedError } from "../../src/core/not_implemented.ts";

const [mod, ...argv] = process.argv.slice(2);
let doc: CliDoc;
try {
  const m = await import(pathToFileURL(path.join(REPO, "src", "core", `${mod}.ts`)).href);
  doc = await m.main(argv);
} catch (e) {
  const err = e instanceof Error ? e : new Error(String(e));
  const code = err instanceof NotImplementedError ? "not_implemented" : "internal";
  doc = makeDoc(false, code, `${err.name}: ${err.message}`, { detail: err.stack });
}
process.stdout.write(pyDumps(doc, { ensureAscii: false }) + "\n");
process.exitCode = exitCode(doc);
