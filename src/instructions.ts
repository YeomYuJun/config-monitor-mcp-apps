// MCP initialize 응답의 instructions. 호스트가 시스템 프롬프트에 넣어, 도구 스키마가 아직 로드되지 않은 세션도
// 어떤 상황에 이 서버를 쓰는지 알게 한다. 도구별 상세는 각 도구의 description 에 둔다.
export const INSTRUCTIONS = [
  "config-monitor 는 이 PC 의 Claude 설정(전역 ~/.claude 와 프로젝트 .claude 의 settings, hooks, 권한, skills, agents, MCP 서버, 플러그인, 메모리)을 읽고, 바꾸고, 스냅샷으로 되돌리는 서버다.",
  "- 설정이 무엇인지 묻는 질문(어떤 훅·스킬·플러그인·MCP 서버·권한이 있는지, 어디에 정의됐는지, 전역과 프로젝트 중 어느 쪽이 적용되는지)은 설정 파일을 직접 읽기 전에 summarize_config 로 개요를 보고 get_config(sections, scope, query, compact=true) 로 좁힌다.",
  "- 설정 파일이 언제 어떻게 바뀌었는지는 get_file_history 와 get_diff 로 본다.",
  "- 설정을 고치기 전에 snapshot_now 로 되돌림 지점을 만든다. 잘못 고쳤으면 config_restore 로 되돌린다.",
  "- 플러그인 켜고 끄기와 권한·훅·MCP 서버·스킬·에이전트의 추가·제거는 config_* 도구로 한다. 해당 항목만 바꾼다. 적용은 다음 세션부터다.",
  "- 대시보드는 사용자가 화면을 보고 싶다고 할 때만 show_config_monitor 로 띄운다.",
].join("\n");
