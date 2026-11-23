# Config Monitor

Config Monitor shows every Claude setting on this PC in one dashboard and lets you change it with a snapshot before and after each change. It covers Claude Code and Claude Desktop, globally and per project: skills, agents, commands, rules, output styles, hooks, permissions, MCP servers, plugins, memory and `CLAUDE.md`. Every action in the dashboard is also an MCP tool that Claude can call when you ask for it.

Windows only. macOS and Linux paths are not probed.

## What it does

- Reads the settings files listed below and shows them as cards, marked with the scope they come from and whether they load at session start.
- Keeps a snapshot store of the files it tracks, so you can see each file's history, compare two revisions and restore one.
- Edits settings when you ask for it: adds or removes permissions, hooks, MCP servers, skills, agents and other items, turns plugins on or off, installs items from a library folder, a git repository or a plugin marketplace, and exports or imports your setup as a bundle.
- Removes nothing for good. An overwritten file keeps a `.bak` copy and a removed item moves to a `.trash` folder.

Changes to your settings, and the removal of another plugin or MCP server, run only when you ask for them, either in the dashboard or by asking Claude in the conversation. Reading the settings never changes them.

## Processes it runs

- The MCP server itself: `node server.js` from this plugin folder.
- A file watcher, only when you start it from the dashboard or with the `watcher_start` tool. It is a second Node process (`server.js --watcher`) that keeps running after the session ends until you stop it with `watcher_stop`.
- A local dashboard server on `127.0.0.1` port 3002, only when you choose to open the dashboard in a browser (`server.js --http`). It accepts requests only from that address.
- `powershell.exe`, to find and stop the watcher process and to open the browser.
- `git`, only for remote libraries and marketplaces that you register.
- The `claude` command line, only when you install, update or remove a whole plugin or marketplace through the dashboard.

## Files it reads

- `~/.claude.json`, `~/.claude/settings.json` and `settings.local.json`.
- `~/.claude/skills`, `agents`, `commands`, `rules`, `output-styles`, `workflows`, `themes`, `CLAUDE.md`, `agent-memory` and `projects/<project>/memory`.
- `~/.claude/plugins` (installed plugins, known marketplaces and the plugin catalog cache).
- For each project you track: `<project>/.claude/...`, `<project>/.mcp.json`, `CLAUDE.md` and `CLAUDE.local.md`.
- Claude Desktop's `claude_desktop_config.json` and its skill manifests, and `~/Claude/Scheduled/*/SKILL.md`.

Conversation history stored in `~/.claude.json` is not read.

## Files it changes, on request

- `settings.json` and `settings.local.json` (global or project): permissions, hooks, `enabledPlugins` and `outputStyle`.
- `~/.claude.json` and Claude Desktop's `claude_desktop_config.json`: `mcpServers` entries.
- Item folders under `~/.claude` or a project's `.claude`: new skills, agents, rules, output styles and workflows, and removals into `.trash`.
- Any tracked file you restore from a snapshot, and the files an import writes.
- Its own snapshot store: `CLAUDE_SNAPSHOT_STORE` if set, otherwise `D:\.claude-snapshot` if that folder already exists, otherwise `~/.claude-snapshot`. The store is not kept in the plugin folder, so uninstalling the plugin keeps your history.

## Network access

- `git` fetches only the repository URLs that you register as a library or marketplace, and the plugin sources those marketplaces list.
- Marketplaces registered by a `marketplace.json` URL are downloaded over HTTPS from that URL. These downloads follow the `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` environment variables; the Windows system proxy setting is not used.
- The `claude` command line makes its own network calls when you ask it to install or update a plugin.

Config Monitor sends no telemetry and talks to no other service.

## Settings

| Option | Values |
| --- | --- |
| Dashboard language | `auto` (default) keeps the language last chosen in the dashboard, Korean at first. `en` starts in English, `ko` in Korean. |

## Use it in the Claude Desktop chat

Claude Desktop chat does not load local MCP servers from plugins. To use Config Monitor there:

1. Download `config-monitor-<version>.mcpb` from the project's GitHub releases and double-click it, or drag it into the Claude Desktop window, or choose **Settings > Extensions > Advanced settings > Install Extension**. Desktop runs it with its built-in Node.js.
2. Or register the server by hand: open `claude_desktop_config.json` (**Settings > Developer > Edit Config**), add the entry below with the full path of this plugin's `server.js`, and restart Claude Desktop. This needs Node.js 20 or later on `PATH`.

```json
"mcpServers": {
  "config-monitor": {
    "command": "node",
    "args": ["C:/path/to/config-monitor/server.js"],
    "env": { "CONFIG_MONITOR_LANG": "en" }
  }
}
```

Then send **Show config-monitor** to open the dashboard.

## License

MIT. See `LICENSE`.
