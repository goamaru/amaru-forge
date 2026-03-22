# Amaru Forge — Handoff Document

**Date:** 2026-03-21
**Status:** v1 skeleton working, integration fixes needed
**Location:** `/Users/owner/Desktop/Tech Tools/amaru-forge`

---

## What's Built

### Working
- Tauri v2 app compiles and launches (9.8MB binary)
- tmux 3.6a installed and accessible via `/opt/homebrew/bin/tmux`
- Rust backend: 5 modules (`tmux.rs`, `sessions.rs`, `git.rs`, `pty.rs`, `lib.rs`) — all compile, 5 unit tests pass
- Frontend: full Catppuccin Mocha CSS theme, three-panel HTML layout, sidebar, terminal (xterm.js), modal, context menu
- `withGlobalTauri: true` — Tauri JS API (`window.__TAURI__`) is available
- `fix_path()` — `/opt/homebrew/bin` is prepended to PATH on launch so GUI app finds tmux/git
- `.app` bundle on Desktop: `~/Desktop/Amaru Forge.app`
- tmux config: `~/.terminal-forge/tmux.conf` (50K scrollback, true color, mouse)

### Not Yet Working
- **Terminal rendering** — the connect_session flow has parameter mismatches between JS and Rust (see below)
- **Auto-detection** — user wants Claude Code-style behavior: open a terminal, start working, and the app infers project + task automatically
- **Side panel** — the JS calls commands that don't exist yet (`get_panel_content`, `get_git_status`, `toggle_pin`, `delete_session`)

---

## Critical Issue: JS ↔ Rust Parameter Mismatches

The two agents (Rust backend, JS frontend) were built in parallel and used different naming conventions. Here's the full mismatch map:

### Rust Command Signatures (what the backend expects)

| Command | Rust Parameters | JS Should Send |
|---------|----------------|----------------|
| `check_tmux` | (none) | `{}` |
| `create_session` | `project: String, task: String, directory: String` | `{ project, task, directory }` |
| `list_sessions` | (none) | `{}` |
| `connect_session` | `session_name: String, channel: Channel<Vec<u8>>` | `{ sessionName, channel }` |
| `write_to_pty` | `session_name: String, data: Vec<u8>` | `{ sessionName, data: [bytes] }` |
| `disconnect_session` | `session_name: String` | `{ sessionName }` |
| `kill_session` | `session_id: String` | `{ sessionId }` |
| `update_session_metadata` | `session_id: String, task: Option<String>, pinned: Option<bool>, notes: Option<String>, spec_path: Option<String>` | `{ sessionId, task?, pinned?, notes?, specPath? }` |
| `resize_pty` | `session_name: String, rows: u16, cols: u16` | `{ sessionName, rows, cols }` |
| `get_git_branch` | `directory: String` | `{ directory }` |
| `restore_session` | `session_id: String` | `{ sessionId }` |
| `list_project_dirs` | (none) | `{}` |

**Key confusion:** Some commands use `session_name` (the tmux name like `forge-1711051200-a3f7`) and others use `session_id` (same value in practice, but semantically different). The JS currently sends `sessionId` for everything.

### What `list_sessions` Returns (Rust → JS)

The `SessionWithStatus` struct has these fields (camelCase in JSON):
```json
{
  "id": "forge-1711051200-a3f7",
  "tmuxName": "forge-1711051200-a3f7",
  "project": "Job Toolkit",
  "task": "Fix Company Research",
  "directory": "/Users/owner/Desktop/Tech Tools/job-toolkit",
  "pinned": false,
  "createdAt": "2026-03-21T16:00:00Z",
  "lastAccessedAt": "2026-03-21T20:30:00Z",
  "specPath": null,
  "notes": null,
  "alive": true,
  "branch": "main"
}
```

The sidebar.js expects `.id`, `.status`, `.name` — these need to be mapped from the above.

### Commands the JS Calls That Don't Exist in Rust

These need to either be created in `lib.rs` or the JS needs to use existing commands:

| JS Calls | Should Use Instead |
|----------|-------------------|
| `toggle_pin` | `update_session_metadata` with `pinned: !current` |
| `delete_session` | `kill_session` |
| `get_panel_content` | Read file from `specPath` — needs new Rust command or remove |
| `get_git_status` | `get_git_branch` |

---

## User's Desired UX Change

The user does NOT want a project selection modal. They want:

1. **Click "+ New Session"** → terminal opens immediately in `/Users/owner/Desktop/Tech Tools`. No modal.
2. **User starts working** — runs `claude`, `codex`, `cd job-toolkit`, etc.
3. **App auto-detects context:**
   - Watches for `cd` commands → updates project name from directory
   - Reads tmux pane title (set by user's `prompt.zsh` via OSC escape codes) → could extract dir + branch
   - Sidebar label auto-updates as context becomes clear
4. **Label format:** `{Project} — {inferred task}` or just `{directory}` until more context is available

### Implementation Approach

Option A — **Parse tmux pane title**: The user's `prompt.zsh` already sets window title via OSC escape codes (`\033]1;dirname · branch\033\\`). Poll `tmux display-message -p '#{pane_title}'` every few seconds to get the current title, parse out directory and branch.

Option B — **Watch cwd**: Poll `tmux display-message -p -t <session> '#{pane_current_path}'` to get the shell's current working directory. Derive project name from the path.

Option C — **Both** — use cwd for project name, pane title for branch, and let user manually set the task description if they want (double-click to rename in sidebar).

**Recommended: Option C** — most reliable, no guessing.

---

## Build & Run

```bash
# Development
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
node build.mjs                          # Build frontend → dist/
source "$HOME/.cargo/env"
npx tauri dev                            # Dev mode with hot reload

# Production
npx tauri build                          # Compile release binary
# Binary at: src-tauri/target/release/app
# .app at: ~/Desktop/Amaru Forge.app

# Update the .app shortcut after rebuilding
cp src-tauri/target/release/app "$HOME/Desktop/Amaru Forge.app/Contents/MacOS/Amaru Forge"

# Run tests
cd src-tauri && cargo test -- --nocapture
```

---

## File Map

```
amaru-forge/
├── src-tauri/src/
│   ├── main.rs          # Entry point → calls lib::run()
│   ├── lib.rs           # 12 Tauri commands, AppState, fix_path()
│   ├── tmux.rs          # tmux CLI wrapper, tmux_bin() path resolution
│   ├── pty.rs           # PTY spawn + Channel bridge (uses tmux::tmux_bin())
│   ├── sessions.rs      # JSON state CRUD (~/.terminal-forge/sessions.json)
│   └── git.rs           # Branch detection
├── src/
│   ├── index.html       # Three-panel layout
│   ├── css/styles.css   # Catppuccin Mocha theme (~400 lines)
│   ├── js/app.js        # Main coordinator (keyboard shortcuts, modal, context menu)
│   ├── js/terminal.js   # xterm.js + Tauri Channel bridge
│   ├── js/sidebar.js    # Session list rendering, groups, search, rename
│   └── js/theme.js      # Catppuccin Mocha xterm.js colors
├── build.mjs            # esbuild bundler
├── package.json
└── docs/
    ├── handoff.md                       # ← THIS FILE
    └── superpowers/
        ├── specs/2026-03-21-terminal-forge-design.md   # Design spec
        └── plans/2026-03-21-terminal-forge-v1.md       # Implementation plan
```

---

## Priority Order for Next Session

1. **Fix JS ↔ Rust parameter mismatches** (see table above) — align sidebar.js data mapping, fix command names
2. **Remove the modal** — make "+ New Session" instantly create a tmux session and connect
3. **Add auto-detection** — poll `tmux display-message` for cwd and pane title, update sidebar labels
4. **Fix context menu** — map `toggle_pin` → `update_session_metadata`, `delete_session` → `kill_session`
5. **Test the full flow** — create, switch, rename, pin, close, reopen
6. **Custom title bar** — `decorations: false` + HTML title bar with Amaru logo
7. **Side panel** — markdown rendering for specs/notes
