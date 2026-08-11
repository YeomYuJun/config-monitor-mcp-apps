// src/ui/bridge.ts - 호스트로 나가는 유일한 통로. 두 전송(MCP App / standalone REST)을 한 표면으로 덮는다.
//   callTool  실패를 항상 jparse().ok===false 로 잡히는 문자열로 정규화해서 돌려준다.
//             그래서 호출부는 전송 종류를 몰라도 되고 가드가 한 모양으로 유지된다.
//   pushCtx   MCP 전용이라 standalone 에서는 no-op.
//   app       디스플레이 모드·호스트 컨텍스트가 필요한 쪽이 직접 잡아 쓴다.
import { App } from "@modelcontextprotocol/ext-apps";
import { t } from "./i18n";

export const app = new App({ name: "Config Monitor", version: "0.1.0" });

// 브라우저(standalone) 모드: server.ts 가 주입한 플래그. true 면 MCP 브리지 대신 HTTP REST 사용.
export const STANDALONE = !!(window as any).__CONFIG_MONITOR_HTTP__;

// 도구 실패를 항상 jparse().ok===false 로 잡히는 문자열로 정규화한다(성공 텍스트는 그대로 통과).
// 두 전송(MCP isError / REST !res.ok) 모두 여기로 모아 기존 ~40개 호출부의 가드를 그대로 재사용한다.
function normalizeToolError(txt: string, fallback: string): string {
  try {
    const p = JSON.parse(txt);
    // ok:false 를 실제로 담은 페이로드만 그대로 통과시킨다(예: runPy 가 건져올린 out(False,...)).
    // 임의의 JSON 객체(예: {code,message} 형태의 프로토콜 에러)를 통과시키면 r.ok 가 undefined 가 되어
    // 가드를 그냥 지나쳐 다시 "성공" 취급될 수 있다 - 이번 라운드가 고치려는 결함과 같은 모양이 된다.
    if (p && typeof p === "object" && p.ok === false) return txt;
  } catch { /* 순수 에러 메시지 문자열 - 아래에서 감싼다 */ }
  return JSON.stringify({ ok: false, message: txt || fallback });
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  if (STANDALONE) {
    const res = await fetch(`/api/tool/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* 응답 본문이 JSON 아님(프록시/네트워크 오류 등) */ }
    if (!res.ok) {
      // /api/tool/:name 은 핸들러가 실제로 throw 했을 때만 비2xx({error})를 준다 - MCP 의 isError 와 동급.
      return normalizeToolError((body && body.error) || "", `REST ${name}: ${res.status}`);
    }
    return body?.text ?? "";
  }
  const r = await app.callServerTool({ name, arguments: args });
  const txt = (r.content?.find((c: any) => c.type === "text") as any)?.text ?? "";
  if (r.isError) return normalizeToolError(txt, t("failed"));
  return txt;
}

// MCP 브리지 전용 기능들은 standalone 에서 no-op.
export function pushCtx(t: string): void {
  if (STANDALONE) return;
  app.updateModelContext({ content: [{ type: "text", text: t }] });
}
export function jparse(t: string): any { try { return JSON.parse(t); } catch { return null; } }
export function jparseLast(t: string): any {
  const lines = t.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) { const v = jparse(lines[i]); if (v) return v; }
  return null;
}
