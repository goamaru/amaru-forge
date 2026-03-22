# Changelog

All notable changes to Amaru Forge are documented here.

## [0.1.0] - 2025-03-22

### Added

- **Tmux scrollback** — mouse wheel scrolls through tmux history via copy-mode; typing automatically exits copy-mode and returns to the prompt
- **Editor clipboard shortcuts** — Cmd+A (select all), Cmd+C (copy), Cmd+X (cut), Cmd+V (paste), and Backspace/Delete in the inline CodeMirror editor
- **Clipboard support** — native Edit menu with Cmd+C/V for both terminal and editor
- **Inline CodeMirror editor** — click `file:line:col` patterns in terminal output to open files with syntax highlighting, line numbers, and an "Ask Amaru" assistant input
- **Inline error detection** — automatically detects compiler and linter error patterns in terminal output and makes them clickable to open in the editor
- **Drag & drop file paths** — drop files onto the terminal to insert their absolute paths
- **Custom title bar** — frameless transparent window with native macOS traffic light controls, app icon, and drag-to-move
- **Rounded window corners** — macOS private API for a polished frameless look
- **Session management** — create, rename, pin, search, and delete tmux sessions from a sidebar with context menus and keyboard shortcuts
- **Session persistence** — sessions saved as JSON in `~/Library/Application Support/com.amaru.forge/`
- **Catppuccin Mocha theme** — consistent dark theme across terminal (xterm.js), editor (CodeMirror), sidebar, and UI chrome
- **Tauri v2 backend** — Rust backend with tmux lifecycle management, PTY I/O via portable-pty, git status helpers, and file read/write commands
- **tmux auto-detection** — setup screen shown if tmux is not installed, with copy-to-clipboard install command

### Fixed

- **Drag-region conflicts** — added `data-tauri-drag-region="false"` to all interactive elements so the custom titlebar doesn't intercept mouse events in the terminal, editor, sidebar, and forms
- **Text selection** — fixed user-select CSS so text is selectable in the terminal and editor while remaining non-selectable in UI chrome (sidebar items, tab bar, editor header)
- **Tmux mouse mode** — disabled tmux mouse mode on session create and attach so xterm.js owns mouse events for selection and scrolling
- **JS/Rust IPC integration** — fixed Tauri `withGlobalTauri` configuration and tmux PATH resolution for macOS GUI apps where Homebrew is not in PATH
