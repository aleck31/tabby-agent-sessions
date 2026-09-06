# tabby-agent-sessions

Feasibility skeleton: a Tabby side pane listing AI agent sessions for the focused terminal's working directory, backed by [`asbutler`](https://github.com/aleck31/agent-session-butler).

## How it works

Tabby has no sidebar extension point (verified against `builtin-plugins/*/typings` — zero `sidebar`/`sidePanel` hits). The supported equivalent is a split pane holding our own tab:

- `ToolbarButtonProvider` adds a toolbar button that toggles the pane
- the button splits the active `SplitTabComponent` and inserts `SessionListTabComponent` on the left (`addTab(panel, relative, 'l')`)
- the pane follows the focused sibling via `SplitTabComponent.focusChanged$`, reading `session.getWorkingDirectory()`
- session data comes from `asbutler list` (JSON) — parsing is *not* reimplemented here, so adding an agent in Go surfaces it in Tabby for free

## Requirements

`asbutler` **>= 0.6.0** (0.6.0 made JSON the default output).

The binary is resolved by searching `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, then `$PATH` — a GUI-launched Electron app only inherits `/usr/bin:/bin:/usr/sbin:/sbin` from launchd, so `$PATH` alone doesn't find `~/.local/bin`. Override if it lives elsewhere:

```yaml
agentSessions:
  binary: asbutler   # bare name = searched; or an absolute path / ~/... path
  width: 0.3         # initial sidebar share of the split, still draggable
```

## Develop

```bash
npm install
npm run build          # or: npm run watch
ln -sfn "$PWD" ~/Library/Application\ Support/tabby/plugins/node_modules/tabby-agent-sessions
```

Restart Tabby to load a rebuilt bundle — it reads plugins once at startup.

## Known gaps (it's a skeleton)

- cwd is polled every 2s in addition to `focusChanged$`, since a plain `cd` emits no event Tabby surfaces
- `asbutler list` scans everything then filters client-side; a `--cwd` flag would avoid re-scanning on every refresh
- no `TabRecoveryProvider`, so the pane doesn't survive a restart (and `recoverTabs` is off in this config anyway)
- rows are read-only — no open/delete/reveal actions yet
- SSH/serial tabs correctly show empty (no local cwd), but there's no explanatory empty state
