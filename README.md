# Config-Monitor MCPAPPS

> See, edit, and roll back your Claude configuration — global and per-project — from a single screen.

<img src="/assets/img/fullscreen.png" width="640" alt="config-monitor dashboard">

## About This Project

**config-monitor** is a Model Context Protocol (MCP) App — an interactive HTML dashboard that renders directly inside Claude Desktop — for inspecting and managing every Claude setting on your machine. It brings Claude Code (`.claude.json`, `settings.json`), Claude Desktop (`claude_desktop_config.json`), and per-project `.claude/` folders into one place.

As you accumulate skills, MCP servers, hooks, and agents — plus a separate `.claude` folder for each project — those settings scatter across files that live in different locations and follow different rules. It becomes hard to answer simple questions like *what is actually applied right now, and where does it come from?*

Every change is reversible by design. Edits take an automatic snapshot before they run, and overwrites or deletes are backed up first (`.bak` for files, `.trash` for folders), so you can always get the previous state back.

Sources can be local folders, remote git repos, or plugin marketplaces. Remote ones are cached locally and pinned to a commit, so the same snapshot, diff, and rollback machinery applies to them unchanged — and nothing is fetched or updated unless you ask for it.

## Table of Contents

- [About This Project](#about-this-project)
- [Simple Usage](#simple-usage)
- [Features](#features)
- [Requirements](#requirements)
- [Setup](#setup)
- [Usage](#usage)
  - [Header](#header)
  - [Tracked Files](#tracked-files)
  - [Config](#config)
  - [Library](#library)
    - [Remote libraries](#remote-libraries)
    - [Marketplaces](#marketplaces)
    - [Hooks and MCP servers](#hooks-and-mcp-servers)
  - [Plugins](#plugins)
  - [History / Diff](#history--diff)
  - [Safety](#safety)
- [What It Reads](#what-it-reads)
- [Notes](#notes)

## Simple Usage
<img src="/assets/img/simple-usage.png" width="440" alt="config-monitor dashboard">

Just send a simple message like `Show config-monitor` in Claude Desktop and the dashboard opens right up.
Cowork supports both inline and fullscreen; Code supports inline only (following the Desktop spec).

## Features

- **One view across sources** — Claude Code, Claude Desktop, and each tracked project side by side, with scope badges (`global` / `project`).
- **Snapshots & diffs** — track any config file, browse its snapshot timeline, compare two versions, and restore an earlier one.
- **Direct editing, global or per-project** — add or remove `allow` / `deny` / `ask` permissions, hooks, and MCP servers; scaffold or remove skills and agents. A project-scoped card always edits that project's own `.claude/`, never the global one.
- **Library install** — install/remove a library (agents / commands / skills) into the global config or a specific project. Additive, not an overwrite, so existing settings stay intact.
- **Remote libraries & marketplaces** — register any git repo as a library, or a repo carrying `.claude-plugin/marketplace.json` as a browsable catalog. Plugins are fetched one at a time, pinned to a commit, and only then join the Library.
- **Hooks & MCP servers from plugins** — install a plugin's hooks into `settings.json` and its MCP servers into Claude Code or Claude Desktop, with the exact commands shown for approval first.
- **Claude Code plugins, made visible** — the skills, agents, commands, hooks, and MCP servers that installed plugins contribute, merged into the same cards as your local ones with a `plugin` badge.
- **The `/plugins` surface as a GUI** — browse and search a marketplace, see what a plugin will install and what it costs in tokens *before* installing, install at user / project / local scope, then enable, disable, update, or uninstall it from the same panel.
- **Provenance tracking** — the dashboard records which source owns each installed item, so a second plugin shipping the same name shows as `conflict` instead of silently overwriting the first.
- **Override badges** — when two items share a name, the one that is *not* actually applied is flagged, following the real precedence rules (project wins for agents, global wins for skills).
- **Reversible by default** — auto-snapshot before every edit; `.bak` / `.trash` backups before every overwrite or delete.

## Requirements

- **Node.js** (LTS) — verify with `node -v`
- **Python 3.10+** on `PATH` — verify with `python --version`
- **Windows** with **Claude Desktop** — the widget probes Windows desktop config paths and the file watcher runs on PowerShell.
- **git** on `PATH` — only for remote libraries and marketplaces. Everything else works without it, and the Library panel keeps working offline either way.
- **`claude` on `PATH`** — only for the actions that install, update, or remove a *whole plugin* or a Claude Code marketplace, which are delegated to the CLI. Viewing plugins, toggling them on and off, and the entire Library side work without it; the delegated buttons report that `claude` was not found instead of failing silently.

## Setup

Configure Claude Desktop to launch the server from its `claude_desktop_config.json`. Install and build first, then register the MCP entry and restart Claude Desktop.

**1. Install and build** — from the project folder:

```bash
npm install
npm run build
```

**2. Register the MCP server** — open your `claude_desktop_config.json` and add an entry under `mcpServers`:

```json
"config-monitor": {
  "command": "npx",
  "args": ["tsx", "C:/tools/config-monitor/src/server-stdio.ts"],
  "env": {
    "CLAUDE_SNAPSHOT_STORE": "C:/Users/<you>/.claude-snapshot",
    "CONFIG_MONITOR_LANG": "en"
  }
}
```

- `args` path → your unzipped folder's `src/server-stdio.ts`.
- `CLAUDE_SNAPSHOT_STORE` → where snapshots are stored (must be an existing drive; defaults to `D:\.claude-snapshot` if unset).
- *(optional)* to use a library, add `"CLAUDE_CONFIG_LIBRARIES": "C:/.../my-library/.claude"` to `env`.
- *(optional)* to start the dashboard in English, add `"CONFIG_MONITOR_LANG": "en"` to `env`. Accepted values are case-insensitive and ignore the region suffix — `en` / `EN` / `en-US` start in English, `ko` / `KO` / `ko-KR` in Korean. **Unset, empty, or an unrecognized value starts in Korean.**

> **Config file location varies by install type.** Standard installs use `%APPDATA%\Claude\claude_desktop_config.json`; Microsoft Store / MSIX installs use `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`. The most recently modified one is the config your running Claude reads.

**3. Restart Claude Desktop**, then call up the config-monitor widget.

## Usage

### Header

<img src="/assets/img/header.png" width="640" alt="Header controls">

The toolbar runs the global actions: **watcher** (a resident file watcher that auto-snapshots on change), **snapshot** (capture the current state once), and **refresh** (re-read tracking, config, and library).

**Report** builds a static, data-baked HTML page and opens it in the browser for read-only/offline viewing; **Open in browser** opens the live dashboard in a tab. **Display settings** control the accent color, source-path visibility, and card description line count, alongside **KO / EN** language and **fullscreen** toggles.

### Tracked Files

<img src="/assets/img/tracked-files.png" width="560" alt="Tracked files panel">

The list of config files under snapshot watch, each showing a status badge (`new` / `modified` / `deleted` / `same`), a scope badge, and its path. Three global files (`~/.claude.json`, `~/.claude/settings.json`, and the desktop config) are tracked automatically when present.

**Add tracking** by entering a project folder, a `.claude` folder, or a file path — a folder is resolved to its `settings.json` / `settings.local.json`. **+ From project** one-click-tracks any Claude Code project that has a `.claude` folder. Clicking a row opens the history / diff panel on the right; project rows can be untracked with **✕** (this only removes them from the watch list — the file itself stays).

### Config

<img src="/assets/img/settings-section.png" width="560" alt="Config panel">

Cards for each category — MCP Servers, Claude Code (`.claude.json`), Permissions, Hooks, Skills, Agents, Scheduled Tasks, and Desktop Skills. Items are grouped by source (global expanded, per-project collapsed), with a `global N · project M` summary where projects contribute.

**Override badges** mark items that share a name but are *not* actually applied, with a dashed border and an amber tag. Precedence runs opposite ways: for **Agents** the project wins, so the **global** card is badged; for **Skills** the global (personal) config wins, so the **project** card is badged.

You can filter instantly with the scope chips, then **edit in place** — the same actions on global and project cards alike: add/remove permission rules and hooks, add/remove MCP servers, and scaffold or remove skills and agents.

A project card carries its own target path, so removing a project skill or agent moves it to that project's own `.claude/skills/.trash` or `.claude/agents/.trash` — the global copy of the same name is untouched. Hover **✕ Remove** to see the exact target directory before confirming; this matters most on a card badged *shadowed by personal*, where a global item of the same name is the one actually in use. Adding a new skill or agent to a project is done from the [Library](#library) panel; a few card types stay read-only (see [Known limits](#what-it-reads)).

### Library

<img src="/assets/img/library-section.png" width="600" alt="Library panel">

A library is any directory shaped like `.claude` (with `agents/`, `commands/`, and/or `skills/`). This panel installs its items into a real config, with a status badge per item: `not installed`, `installed`, `changed` (the library was updated and can be synced), or `conflict` — compared by **content hash**, not by name.

Pick an **install target** (`global (~/.claude)` or a tracked project), then install items individually, in bulk, or by skills-tree group. Each item offers **install** / **sync** (backup before overwrite) / **remove** (move to `.trash`). Library paths marked `ENV` come from `CLAUDE_CONFIG_LIBRARIES` and can't be removed from the dashboard.

**`conflict`** appears when an item's name is already installed but came from a *different* source. Without this the second source would read as `changed`, and syncing it would quietly overwrite the first — a real risk once a marketplace is in play, where name collisions already exist among bundled plugins. A conflicting item offers **overwrite** (with the current owner shown) instead of **sync**, and removing an item you don't own is refused.

#### Remote libraries

Register a git repo directly and it behaves exactly like a local one. The repo is cloned into a cache under `CLAUDE_SNAPSHOT_STORE` and that cache becomes the library root, so install, sync, diff, and rollback all work unchanged. Layout is auto-detected and matched case-insensitively, so a repo using `Agents/` and `Skills/` is picked up as-is.

Registration is persistent, but **nothing is ever fetched automatically**. The chip shows the pinned short commit and how long ago it was fetched; updates happen only when you press refresh. For hooks, that matters — an automatic pull would silently change code that runs every session.

#### Marketplaces

A repo containing `.claude-plugin/marketplace.json` registers as a catalog instead. Only the manifest is checked out up front (~340 KB for the official marketplace's 278 plugins, versus ~9.7 MB for the whole repo), and the catalog is browsable offline with search and category filters.

Four source forms are accepted, matching what Claude Code's own Add Marketplace takes: `owner/repo`, a git URL (`https://`, `ssh://`, `git://`, `file://`, or `user@host:path`), a direct `https://…/marketplace.json`, and a local directory. A local marketplace is **not copied** — the directory you point at becomes the cache, so editing its manifest *is* how you update it, and pressing refresh re-reads it from disk and re-hashes the content. Unregistering a local marketplace removes only the registration; your directory is left untouched.

Fetching is per-plugin and explicit. Only fetched plugins join the Library panel; the rest stay in the catalog. There is deliberately no "installable items" count in the catalog — barely any manifest entries declare their components, so the number simply isn't knowable before fetching, and showing a guess would be worse than showing nothing.

A marketplace is an *index*, not a store: of the official marketplace's 278 entries only 53 actually live in that repo, and the rest point at other repositories. "Official" describes where a plugin is listed, not who wrote it — 38 of the 280 entries are authored by Anthropic, the rest by Google, SAP, AWS, and individual developers.

**Two install models share that one source.** Each catalog row therefore offers two actions, and they are not variants of each other:

| | **Install items** (this dashboard) | **Install plugin** (Claude Code) |
|---|---|---|
| Unit | one item at a time | the whole plugin |
| Lands in | copied into `~/.claude/skills/…` | left in the plugin cache and referenced |
| Named | flat — `brainstorming` | namespaced — `superpowers:brainstorming` |
| Turning it off | remove the item (to `.trash`) | one toggle |
| Updating | explicit fetch, with a pre-install diff | `claude plugin update` |
| Rollback | snapshot / diff / restore | none |
| Claude Desktop | **works** | not possible — Desktop has no plugin system |

"Install plugin" delegates to `claude plugin install`, so the result is a real Claude Code plugin and shows up in the Plugins section. It is disabled when the marketplace is not registered in Claude Code, since the install would not resolve. Note that the reverse never happens: picking 3 items out of a 12-item plugin cannot be recorded in Claude Code's registry, so item-level installs stay this dashboard's own.

Each marketplace header also carries the Claude Code side of the same registration: **Add to CC** when it is only registered here, or **Update in CC** / **Remove from CC** when it exists on both. The two keep separate caches on purpose, so these are distinct actions rather than a sync.

#### Hooks and MCP servers

Plugins can also carry hooks and MCP servers. These aren't copied into `~/.claude` like skills are: some plugins reference files that sit *beside* their `hooks/` folder, so the whole plugin root stays in the cache and the config points at it. That makes the cache load-bearing, which is why unregistering a source is refused while installed hooks still reference it — the dashboard tells you what's holding it rather than breaking your config.

Because installing a hook means arbitrary code runs every session, the confirmation step shows the **exact commands** that will be written, with the cache path already substituted in. Interpreters that won't actually run are flagged — on Windows, `python3` commonly resolves to a Microsoft Store alias stub that is found on `PATH` but fails on execution. That's shown as a warning, never a block.

MCP servers can target Claude Code or **Claude Desktop**. Desktop has no plugin marketplace of its own, so this is currently the only way to get a plugin's MCP server into it.

### Plugins

Plugins installed through Claude Code's own `/plugins` command were previously invisible here: their skills, agents, commands, hooks, and MCP servers live under `~/.claude/plugins/cache/`, not `~/.claude/skills/`, so none of the sections above picked them up.

They now appear twice. A **Plugins** section lists them one card per plugin — marketplace, version, what it contributes, and the settings file that decided its state — and their components are also merged into the ordinary Skills / Agents / Commands / Hooks / MCP cards, each carrying a `plugin` badge and the `plugin@marketplace` it came from. Names never collide with your local items, because Claude Code namespaces plugin components as `<plugin>:<item>`.

Only plugins that are actually **enabled** are merged. Installed-but-disabled ones stay in the Plugins section alone — installed is not the same as applied. Two more states are surfaced rather than hidden: `stale` (a leftover key in `enabledPlugins` with no install record) and `missing` (an install record whose cache directory is gone).

The per-plugin toggle writes `enabledPlugins` in the settings file that currently decides that plugin's state — global or project — through the same snapshot / `.bak` / atomic-write path as every other edit. Because Claude Code reads `enabledPlugins` at session start, the change applies from the **next session**, which the button says out loud. **Update** and **Uninstall** sit beside it and delegate to `claude plugin update` / `uninstall`; uninstall asks for confirmation, since unlike the toggle it is not undone by pressing the same button again.

Clicking a catalog row opens the same inventory the CLI's plugin details screen shows — what the plugin will install (commands, agents, skills, hooks, MCP and LSP servers, by name), its projected token cost split into always-on and on-invoke, cumulative installs, author, and homepage — followed by the three install scopes (you / everyone on a repo / this repo, you only). None of that requires fetching the plugin first: Claude Code ships a precomputed inventory in `plugin-catalog-cache.json` and the dashboard reads it. That cache covers the official marketplace only, so rows from other marketplaces say the inventory is unknown rather than reporting zero.

What the dashboard deliberately does **not** replicate from the `/plugins` TUI is marketplace auto-update, favorites, and mark-for-update. Those have no CLI subcommand and leave no trace on disk, so supporting them would mean guessing a settings key and writing it into your config.

Registering a marketplace also reads the ones Claude Code already knows about and offers them as one-click fills in the URL box. Nothing is fetched from that read, and a picked URL still goes through the same confirmation step. Marketplaces registered on both sides are shown with both pinned commits side by side rather than being quietly reconciled — the two tools keep separate caches on purpose.

### History / Diff

<img src="/assets/img/right-pannel.png" width="440" alt="History and diff panel">

Opens when you click a tracked-file row. It shows the snapshot timeline (time, message, hash), the diff between two selected versions, and the current file contents (read-only).

**Restore** rolls the file back to a chosen version. Because the current state is auto-snapshotted (plus a `.bak`) before restoring, you can undo the undo.

### Safety

- An automatic snapshot is taken before every edit, install, and restore.
- Before an overwrite, files are kept as `.bak` and directories are moved to `.trash`.
- Removal is a move to `.trash`, not a real delete — it can be recovered.
- Untracking only removes an entry from the watch list; the file is left in place.

<img src="/assets/img/fullscreen.png" width="720" alt="Fullscreen dashboard">

## What It Reads

The dashboard does not dump whole files — it extracts only the fields it needs and turns them into cards. `~/.claude.json` is read selectively (never conversation history), `settings.json` is parsed only for `permissions` and `hooks`, and frontmatter is read shallowly (top-level one-line `key: value` pairs).

<details>
<summary>Parsing scope per section</summary>

| Section | File read | Extracted into cards |
|---|---|---|
| MCP Servers (desktop) | `<Desktop>/claude_desktop_config.json` | per-server `command`, `args`, `env` **key names only** |
| Claude Code | `~/.claude.json` | global summary + global `mcpServers` (`command`/`args`) + project cards (path, allowedTools count, mcpServers names, trust) |
| Permissions | `~/.claude/settings.json` | `permissions.allow` / `deny` / `ask` rules |
| Hooks | `~/.claude/settings.json` | matcher count + command list per `hooks.<event>` |
| Skills (code) | `~/.claude/skills/` | immediate subfolders; `SKILL.md` `description` |
| Agents | `~/.claude/agents/` | frontmatter `name`, `description`, `tools` |
| Commands | `~/.claude/commands/` | frontmatter `description` (subfolders are namespaces) |
| Plugins | `~/.claude/plugins/{installed_plugins,known_marketplaces}.json` + each plugin's `.claude-plugin/plugin.json` | per-plugin market, version, install path, enabled state, and the components it contributes |
| Plugin inventory | `~/.claude/plugins/plugin-catalog-cache.json` | pre-install component list, projected token cost, install count, homepage (official marketplace only) |
| Scheduled Tasks | `~/Claude/Scheduled/*/SKILL.md` | `description`, `cron`/`schedule`/`fireAt` |
| Desktop Skills | `<Desktop>/.../skills-plugin/**/manifest.json` | `description`, `creatorType`, `enabled`, `updatedAt` |

When a project is tracked, the Permissions / Hooks / Skills / Agents / Commands sections also read that project's `.claude/{settings.json,settings.local.json}`, `.claude/skills/`, `.claude/agents/`, and `.claude/commands/` and append them as project items. A project's `.mcp.json` gets its own **MCP Servers (project)** section, since it is committed and affects the whole team.

</details>

<details>
<summary>Known limits</summary>

- `settings.json` and `settings.local.json` are **both** read, but shown as separate cards (not merged), each labeled with its source.
- `skills` is read one level deep; `agents` and `commands` recurse into subfolders (nested items are view-only, global and project alike, because the remove operation takes a single-segment name).
- **Commands** and a project's **`.mcp.json`** are shown but read-only at every scope — no remove operation exists for them yet.
- The `＋ new skill` / `＋ new agent` scaffold cards are global-only; to add one to a project, install it from the Library panel.
- Remote sources are never fetched automatically — registration persists, but updates are always an explicit refresh.
- Keep `CLAUDE_SNAPSHOT_STORE` short. Marketplace plugins nest a few levels deep inside it, and Windows still caps most paths at 260 characters; a deep store can leave a plugin fetched but unreadable. That case is reported rather than silently counted as zero items.
- Project cards are capped at 20.
- Long values are truncated — descriptions at 600 chars, everything else at 160.
- Only what appears as a card is editable; keys that aren't parsed can't be changed from the dashboard.

</details>

## Notes

Precedence and path-coverage details are summarized from the official Claude Code docs (skills, sub-agents, settings, memory, hooks, MCP) and may shift between versions — if behavior differs, defer to the docs.

Per-project editing now covers permissions, hooks, skills, and agents: every project card carries its own target path, so an edit cannot land on the global config by mistake, and the dashboard only accepts a path shaped like `<project>/.claude/{skills,agents}`. What is still read-only (commands, a project's `.mcp.json`) is constrained deliberately — no safe remove operation exists for those yet.
