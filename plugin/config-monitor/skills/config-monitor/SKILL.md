---
name: config-monitor
description: Opens the Config Monitor dashboard (the Claude settings on this PC as cards, with per-file history and diffs) in the current conversation. Use when the user asks to see or open the config monitor, the settings dashboard or their Claude settings screen. Do not use it to answer questions about the settings; call the config-monitor summarize_config and get_config tools for those.
---

## When to use

The user wants to see the settings screen itself. The goal is to show the widget, not to read or change the settings.

## What to do

1. Call the `show_config_monitor` tool of the `config-monitor` MCP server right away, with no arguments. Do not ask a confirmation question.
2. When the tool result renders the dashboard, stop there. Do not add an explanation; the widget is the answer.
3. If the tool is missing or the call fails, say so in one line: `The config-monitor MCP server is not connected. Check that the config-monitor plugin is enabled.`

## What not to do

- Do not read or summarize the settings files directly. A question such as "which hooks do I have?" goes to `summarize_config` and then `get_config(sections=[...], compact=true)`, not to this skill.
- Do not call `open_in_browser`. That tool is for the button inside the widget.
