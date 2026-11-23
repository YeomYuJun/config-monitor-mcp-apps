// MCP initialize 응답의 instructions. 호스트가 시스템 프롬프트에 넣어, 도구 스키마가 아직 로드되지 않은 세션도
// 어떤 상황에 이 서버를 쓰는지 알게 한다. 도구별 상세는 각 도구의 description 에 둔다.
export const INSTRUCTIONS = [
  "config-monitor reads, changes and rolls back (through snapshots) the Claude config on this PC: settings, hooks, permissions, skills, agents, MCP servers, plugins and memory in the global ~/.claude and in project .claude folders.",
  "- For questions about what the config is (which hooks, skills, plugins, MCP servers or permissions exist, where they are defined, whether the global or the project one applies), call summarize_config for the overview before reading config files directly, then narrow down with get_config(sections, scope, query, compact=true).",
  "- To see when and how a config file changed, use get_file_history and get_diff.",
  "- Before changing the config, create a rollback point with snapshot_now. If a change was wrong, revert it with config_restore.",
  "- Turn plugins on and off, and add or remove permissions, hooks, MCP servers, skills and agents, with the config_* tools. They change only the given item. Changes take effect from the next session.",
  "- Open the dashboard with show_config_monitor only when the user asks to see it.",
].join("\n");
