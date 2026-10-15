# Using Config Monitor

This guide covers what the [README](README.md) only touches on. Set the dashboard up from the README first.

Contents: [Settings](#settings) · [History and diff](#history-and-diff) · [Library](#library) · [Plugins](#plugins) · [Transfer and sync](#transfer-and-sync) · [Asking Claude](#asking-claude) · [Troubleshooting](#troubleshooting)

## Settings

Every kind of setting is a section of cards. Sections are grouped by purpose — instructions, extensions, connections, execution, memory and environment. Click a group title to fold it.

Inside a section, global items come first. Each project gets its own group, folded by default.

### Choosing which sections show

Open Display settings (the gear in the header):

- **Sections** — `All`, `Commonly used`, or `Choose` to pick them one by one.
- **Hide empty sections** — on by default. Turn it off to see every kind of setting Claude supports.
- **Show projects without .claude** — off by default. Turn it on to list every project Claude Code knows.

While anything is hidden, a "Hidden sections" chip above the list opens the same menu.

### What the badges mean

Each section shows how it loads into Claude's context:

- `EAGER` — loaded at the start of every session. Skills and agents count by name and description only.
- `LAZY` — loaded only when needed. A rule with `paths:` is lazy; only the active output style is eager.
- `NEVER` — used at runtime but never put in context, such as hooks and permissions.

When two items share a name, the one that is not applied is marked "overridden". For agents the project copy wins. For skills the global copy wins.

The Plugins and Built-in switches hide items added by plugins or shipped with Claude.

### Editing

Permissions, hooks, MCP servers, skills and agents have add and remove controls on their cards.

- A project card always edits that project's own `.claude` folder.
- Hover a remove button to see the exact path first.
- Removed items move to a `.trash` folder next to them.

New skills and agents are created from the "＋ New" card in the global section. To add one to a project, install it from the Library.

## History and diff

Click a tracked file to open its history on the right.

Each revision is one operation — an edit, install, restore or import — named after what it did.

- Click a revision to see what it changed.
- Use "Compare with" to diff against the working copy or any other revision.
- A revision named "external change" holds edits made outside the dashboard.
- "Restore" puts the file back. The current state is snapshotted first, so a restore can be undone too.

### Hiding noise in diffs

Claude Code rewrites `~/.claude.json` on every session with counters, timestamps and caches. Those keys are ignored, so they do not create revisions. Tick "raw diff" to see everything anyway.

To ignore more keys, add `ignore_keys` to `config.json` in your snapshot store. Use the file name, or its full path, as the key:

```json
"ignore_keys": {
  ".claude.json": ["myCache*", "projects.*.lastCost", "!lastSessionId"]
}
```

Rules are dot paths. `*` matches within one level. A rule starting with `!` keeps a key another rule would ignore.

### Cleaning up snapshots

"Snapshot cleanup" in Display settings works in two clicks. The first only lists what would go: snapshots older than 90 days and data nothing refers to. The second deletes it. The newest snapshot is always kept.

## Library

A library is a folder laid out like `.claude`, with `agents/`, `commands/` and `skills/`. Add one with "Add library" or the `CLAUDE_CONFIG_LIBRARIES` setting.

Choose a target in "Install to" — the global config or a project — then install items one at a time or several at once.

Each item shows its state, compared by content:

- `Not installed`
- `Installed`
- `Modified` — the library copy changed and can be synced
- `Conflict` — the same name was installed from another source

### Hooks and MCP servers from a folder

A subfolder, up to two levels deep, that contains `hooks/hooks.json` or `.mcp.json` becomes its own hook or MCP tool. These are the same files a Claude Code plugin ships, and `${CLAUDE_PLUGIN_ROOT}` points at that subfolder.

You see the exact command before a hook is installed. MCP servers can go to Claude Code or Claude Desktop.

### Git repos and marketplaces

A git repo can be a library too. It is cloned into the snapshot store, pinned to a commit, and updated only when you press refresh.

A repo with `.claude-plugin/marketplace.json` is added as a marketplace instead. "Add marketplace" accepts `owner/repo`, a git URL, a link to `marketplace.json`, or a local folder.

Each plugin in a marketplace has two install buttons:

- **Install items** copies the parts you pick into your config. Works for Claude Desktop too, with history and restore.
- **Install plugin** hands the whole plugin to Claude Code. Claude Code manages it, and it turns on or off with one switch.

## Plugins

Plugins installed through Claude Code each get a card in the Plugins section. What an enabled plugin adds also appears in the normal sections with a `plugin` badge.

- The switch turns a plugin on or off. It applies from the next Claude Code session.
- Update and Uninstall use the `claude` CLI.
- `stale` means enabled but not installed. `missing` means installed but its files are gone.

Click a plugin in a marketplace to see what it contains and roughly what it costs in tokens. This works for the official marketplace.

## Transfer and sync

Open Transfer / Sync from the header.

### Export

1. Enter a path. Ending it in `.cmbundle` makes a single file; anything else makes a folder.
2. Pick the optional parts: secret values, `settings.local.json`, project memory, agent memory.
3. Press "Write bundle", or "List only" to preview.

The bundle carries skills, agents, commands, rules, output styles, `CLAUDE.md`, `settings.json`, MCP servers and your library list. Secret values become placeholders unless you include them — then they are stored as plain text, so keep the file somewhere safe.

### Import

1. Enter the bundle path and press "Compare". Nothing is written yet.
2. Check each item: `New`, `Changed`, `Same` or `Blocked`. Changed items have a diff.
3. For values that differ in `settings.json`, keep this PC's value (the default) or take the bundle's.
4. Check **Path matching** (see below).
5. Press "Apply selected".

Replaced files go to `.trash`, edited JSON files keep a `.bak`, and snapshots are taken before and after. The import history lists every run with an "Undo" button. Undo skips anything you changed afterwards unless you choose "Undo anyway".

**Path matching.** A bundle from another PC points at that PC's drives and folders. The table lists those folders with a match on this PC, found through your library folder or the same folder on another drive.

- To fix a match, type a folder and press "Compare again". Leave it empty to skip.
- Hooks and servers that still point at a missing path are left out (`Blocked`).
- A hook this PC already has is shown as `Same` and not added twice.
- A server that already works here is merged with the bundle, so settings only this PC has stay.
- "Ask Claude to find them" puts a request in the chat box for the paths still missing. After Claude saves its matches, press "Compare again".

By default the list hides same, skipped and blocked rows; the two checkboxes above it show them. The expand button next to the summary opens the list in a large window, with the same ticks.

### Sync

Sync keeps several PCs aligned through a folder they all see — OneDrive, Syncthing or a git checkout.

1. Set the folder and a name for this PC.
2. Press "Push this PC".
3. Pick another PC to compare, then "Compare for import" to open it in the Import tab.

The comparison shows each item as `in sync`, `this PC ahead`, `other PC ahead`, `both changed` or `no baseline` (never matched). Config Monitor does not run git; commit the folder yourself.

## Asking Claude

Every dashboard action is an MCP tool, so you can ask in plain language.

- `summarize_config` — an overview: counts and load class per section, global versus project, name clashes.
- `get_config` — one part in detail, filtered by section, scope or text.

Edit tools accept a project name, for example "remove the foo skill from project acme-web". Changes made in chat appear in the open dashboard within a few seconds.

## Troubleshooting

**The dashboard looks the same after an update.**
Restart Claude Desktop. It caches the widget page.

**A marketplace plugin is fetched but shows no items.**
Windows limits most paths to 260 characters. Keep `CLAUDE_SNAPSHOT_STORE` short.

**A hook command is flagged before install.**
On Windows, `python3` is often a Microsoft Store placeholder that cannot run. Use `python` or a full path.

**The widget seems to reload by itself.**
`widget.log` in the snapshot store has one line per load, so you can tell a reload from several open widgets.
