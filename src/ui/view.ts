// src/ui/view.ts - 보던 자리(선택 파일·패널·필터)를 스토어에 남기고 부트 때 되살린다.
// 호스트가 위젯 iframe 을 다시 올리면 모듈 상태가 전부 사라진다. localStorage 는 위젯 iframe 에서
// 막힐 수 있어 서버 prefs(set_prefs.view)에 둔다. 저장은 fire-and-forget 이고 실패해도 화면에 영향 없다.
import { callTool } from "./bridge";
import { selectedPath, detailOpen, scopeFilter, libTarget } from "./state";

// 인스턴스 id: 같은 대화에 위젯이 몇 개 살아 있는지, 다시 올라온 것인지 서버 로그에서 구분하는 용도.
export const INSTANCE_ID = Math.random().toString(16).slice(2, 8);

export function persistView(): void {
  void callTool("set_prefs", {
    view: { selectedPath, detailOpen, scope: scopeFilter, libTarget },
  }).catch(() => { /* 화면 옵션 저장 실패는 무시 */ });
}
