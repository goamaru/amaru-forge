# Amaru Forge

A native macOS terminal multiplexer built with [Tauri v2](https://v2.tauri.app), powered by tmux under the hood.

Amaru Forge wraps tmux in a modern desktop interface with session management, an inline code editor, error detection, and a Catppuccin Mocha theme — all without requiring you to memorize tmux keybindings.

## Features

- **Session management** — create, rename, pin, search, and delete tmux sessions from a sidebar
- **Inline code editor** — click `file:line:col` patterns in terminal output to open files in a built-in CodeMirror editor with syntax highlighting
- **Error detection** — automatically detects compiler/linter errors and makes them clickable
- **Custom title bar** — frameless window with native macOS traffic lights and drag-to-move
- **Clipboard support** — native Edit menu with Cmd+C/V in both terminal and editor
- **Drag & drop** — drop files onto the terminal to insert their paths
- **Tmux scrollback** — mouse wheel scrolls through tmux history via copy-mode
- **Catppuccin Mocha theme** — consistent dark theme across terminal, editor, and UI chrome

## Prerequisites

- **macOS** (Apple Silicon or Intel)
- **tmux** — install with `brew install tmux`
- **Rust** — install from [rustup.rs](https://rustup.rs)
- **Node.js** — v18+ recommended

## Getting Started

```bash
# Clone the repository
git clone https://github.com/goamaru/amaru-forge.git
cd amaru-forge

# Install frontend dependencies
npm install

# Run in development mode
cargo tauri dev

# Build for production
cargo tauri build
```

## Architecture

```
amaru-forge/
├── src-tauri/           # Rust backend (Tauri v2)
│   └── src/
│       ├── lib.rs       # Tauri commands and app setup
│       ├── tmux.rs      # tmux session lifecycle and control
│       ├── pty.rs       # PTY management (portable-pty)
│       ├── sessions.rs  # Session persistence (JSON on disk)
│       └── git.rs       # Git status helpers
├── src/                 # Frontend
│   ├── index.html       # Main window layout
│   ├── css/styles.css   # Catppuccin Mocha theme
│   └── js/
│       ├── app.js       # App coordinator and initialization
│       ├── terminal.js  # xterm.js terminal management
│       ├── editor.js    # CodeMirror inline editor
│       ├── sidebar.js   # Session list and context menu
│       └── theme.js     # Terminal theme and font config
└── package.json
```

**Backend** — Rust manages tmux sessions, PTY I/O, file operations, and git status via Tauri IPC commands. Sessions are persisted as JSON in `~/Library/Application Support/com.amaru.forge/`.

**Frontend** — Vanilla JavaScript with xterm.js for terminal rendering and CodeMirror 6 for the inline editor. No framework — direct DOM manipulation for minimal overhead.

## Key Dependencies

| Component | Library |
|-----------|---------|
| Desktop framework | [Tauri v2](https://v2.tauri.app) |
| Terminal emulator | [xterm.js](https://xtermjs.org) |
| Code editor | [CodeMirror 6](https://codemirror.net) |
| PTY management | [portable-pty](https://docs.rs/portable-pty) |
| Session multiplexer | [tmux](https://github.com/tmux/tmux) |

## License

MIT
