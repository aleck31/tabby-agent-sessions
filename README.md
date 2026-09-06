# tabby-agent-sessions

Feasibility skeleton: a Tabby side pane listing AI agent sessions for the focused terminal's working directory, backed by [`asbutler`](https://github.com/aleck31/agent-session-butler).

## How it works

Tabby has no sidebar extension point (verified against `builtin-plugins/*/typings` — zero `sidebar`/`sidePanel` hits). The supported equivalent is a split pane holding our own tab:

- `ToolbarButtonProvider` adds a toolbar button that toggles the pane
- the button splits the active `SplitTabComponent` and inserts `SessionListTabComponent` on the right (`addTab(panel, relative, 'r')`) — terminals leave more slack on that side
- the pane follows the focused sibling via `SplitTabComponent.focusChanged$`, reading `session.getWorkingDirectory()`
- session data comes from `asbutler list --path <cwd>` (JSON) — parsing is *not* reimplemented here, so adding an agent in Go surfaces it in Tabby for free
- a click selects a row; **double-click** (or the hover `▶`) types that agent's resume command into the adjacent terminal (`claude --resume <id>`, `kiro-cli chat --resume-id <id>`). Refused for a `locked` session, for an agent with no known resume command, and while that terminal is running something
- the hover `✕` deletes via `asbutler rm`, behind a native confirm dialog that defaults to Cancel. **Permanent** — asbutler unlinks the file and the JSON exposes no path for the plugin to trash it instead

## Requirements

`asbutler` **>= 0.6.1**. Querying one directory matters: `--path` narrows before asbutler enriches, so one directory costs ~0.8s where machine-wide costs ~36s.

The binary is resolved by searching `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, then `$PATH` — a GUI-launched Electron app only inherits `/usr/bin:/bin:/usr/sbin:/sbin` from launchd, so `$PATH` alone doesn't find `~/.local/bin`. Override if it lives elsewhere:


## Develop

```bash
npm install
npm run check          # tsc --noEmit + Angular template parse
npm run build          # or: npm run watch
ln -sfn "$PWD" ~/Library/Application\ Support/tabby/plugins/node_modules/tabby-agent-sessions
```

Restart Tabby to load a rebuilt bundle — it reads plugins once at startup.

`npm run check` is worth running before you trust a template change: the template is an inline string that Angular compiles at runtime, so webpack will bundle a broken binding without complaint and the pane just renders blank.

## Known gaps

- delete is permanent, and can't be made recoverable here — asbutler unlinks the file and the JSON row exposes no path, which also rules out reveal-in-Finder entirely
- no bulk select yet, though `asbutler rm` already takes several ids
- no `TabRecoveryProvider`, so the pane doesn't survive a restart (and `recoverTabs` is off in this config anyway)
- switching directory costs a fresh ~1s subprocess, with no affordance beyond the header glyph — the rows blank out rather than staying visible while the new query runs

Note the 2s cwd poll is **not** a gap: `focusChanged$` alone misses a plain `cd`, which Tabby emits no event for. Removing it leaves the directory silently stale.
