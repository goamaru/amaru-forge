# Amaru Forge — Focused Workflow Replacement Roadmap

## Product Decision

As of **March 22, 2026**, Amaru Forge should be built as a **focused replacement for Arturo's workflow**, not as a general-purpose attempt to replace Visual Studio Code for the market.

That means:

- **Primary platform:** macOS
- **Primary interaction model:** terminal-first, keyboard-first
- **Primary editing model:** single-surface zen editor
- **Primary value:** fast loop between terminal output, code edits, git context, and AI assistance
- **Primary user:** one power user working across local repos all day

## Product Thesis

Amaru Forge wins if it becomes the fastest way to:

1. open a project
2. run commands
3. jump from output to code
4. edit and save cleanly
5. inspect git state
6. ask for an AI-assisted change
7. get back to the terminal

It does **not** need to win by recreating the entire VS Code workbench, extension marketplace, or cross-platform ecosystem.

## Non-Goals

The following are explicitly out of scope for v1:

- VS Code extension API compatibility
- Marketplace or third-party plugin platform
- Windows and Linux support
- Notebook UI
- Browser/devtools-style debugging parity
- Webviews and extension-contributed custom panels
- Settings sync, cloud account features, or collaboration features
- General IDE parity across every language

These may be reconsidered later, but they should not shape the first product.

## What “Replacement” Means

Amaru Forge counts as a replacement for this workflow when it can handle a full workday without opening VS Code for routine tasks.

### Replacement Bar

- Open and switch projects quickly
- Run build, test, lint, and app commands in persistent sessions
- Jump from terminal errors to the correct file and location
- Edit files comfortably in the zen editor
- Search across files and open files without browsing deep trees
- Inspect git status, diffs, and commit routine work
- Show diagnostics and basic code intelligence for the top working languages
- Persist session state and recover from restart without losing work
- Keep specs, plans, and current task context visible inside the app
- Make AI assistance useful from file, selection, and terminal context

## Current State

Amaru Forge already has the right base for this direction:

- Tauri desktop shell
- Rust backend with PTY and file IPC
- tmux-backed persistent terminal sessions
- xterm.js terminal surface
- CodeMirror editor
- clickable `file:line:col` navigation from terminal output
- session metadata and basic git branch support
- a defined zen editor plan already in progress

This is enough to pursue a focused workflow replacement without changing the core stack.

## Architecture Direction

Keep the current stack and extend it deliberately:

- **Desktop shell:** Tauri v2
- **Backend orchestration:** Rust
- **Terminal/session model:** tmux + PTY manager
- **Editor:** CodeMirror 6
- **UI style:** minimal, native-feeling, terminal-first

### Architecture Rules

- Do not fork Code - OSS.
- Do not switch to Electron unless the current stack proves structurally incapable.
- Do not introduce a plugin system in v1.
- Prefer narrow backend commands over a giant frontend rewrite.
- Add capability through dedicated services: search, git, diagnostics, file watching, and session persistence.
- Preserve the “single surface” product idea. New capability should not turn the UI into a copy of VS Code chrome.

## Roadmap

Estimates below assume **one primary maintainer** and focus on shipping usable increments.

### Phase 0 — Foundation and Daily-Driver Editing
**Target dates:** March 22, 2026 to March 29, 2026

**Goal:** finish the existing zen editor transition and remove the biggest friction in basic editing.

**Scope:**

- Ship zen editor mode as the only editor mode
- Add safe unsaved-changes flow
- Add resizable Ask Amaru panel
- Render project spec markdown in the side panel
- Tighten keyboard behavior around Escape, save, focus, and editor re-entry
- Verify that file open, edit, save, and return-to-terminal flow is reliable

**Exit criteria:**

- You can click from terminal output into code, edit, save, and return without UI confusion
- The editor no longer feels like a sidecar feature
- Specs and plans are visible inside Forge for the active project

### Phase 1 — Navigation and Search
**Target dates:** March 30, 2026 to April 12, 2026

**Goal:** make repository navigation faster than the current VS Code workflow for common tasks.

**Scope:**

- Quick Open overlay for files
- Recent files / recent edit stack
- Global text search powered by `rg`
- Go to line
- Go to symbol for the current file
- Open-project / switch-project command
- File reveal from current editor path
- Better dirty-file indicators and reopen behavior

**Recommended implementation notes:**

- Search should be backend-driven and streamed where possible
- Prefer fuzzy-open and search overlays over a permanently expanded file tree
- Preserve keyboard-first flows over mouse-heavy browsing

**Exit criteria:**

- You can move around a repo without missing tabs or sidebar-heavy navigation
- Search and open are fast enough to be muscle-memory actions

### Phase 2 — Git and Workspace Awareness
**Target dates:** April 13, 2026 to April 26, 2026

**Goal:** remove the need to leave Forge for routine source control work.

**Scope:**

- Repository detection and root awareness
- Rich git status for changed files
- Diff view for current file and selected files
- Stage / unstage actions
- Commit flow for routine commits
- Branch display and branch-change refresh
- Session metadata improvements: repo, task, notes, spec, last edited files
- Better multi-project switching and session restoration

**Recommended implementation notes:**

- Keep git operations explicit and safe
- Do not add destructive shortcuts without confirmation
- Treat git as a narrow integrated workflow, not a full GUI client

**Exit criteria:**

- Routine edit-review-commit loops can happen entirely inside Forge
- Switching among multiple active repos feels stable and intentional

### Phase 3 — Language Intelligence for Core Languages
**Target dates:** April 27, 2026 to May 17, 2026

**Goal:** add enough intelligence to cover the languages used most often without building an extension host.

**Target languages for v1:**

- TypeScript / JavaScript
- Python
- Rust

**Scope:**

- LSP process manager
- Diagnostics in editor
- Problems list sourced from diagnostics and terminal parsing
- Hover
- Completion
- Go to definition
- Find references
- Rename symbol if implementation cost is acceptable

**Recommended implementation notes:**

- Use direct language server integration, not an extension platform
- Keep language support opt-in and explicit
- Start with diagnostics + hover + definition before chasing every LSP feature

**Exit criteria:**

- Basic coding tasks in the three target languages no longer require switching to VS Code
- Compiler/linter output and editor diagnostics feel like one coherent system

### Phase 4 — Reliability, Recovery, and Polish
**Target dates:** May 18, 2026 to June 7, 2026

**Goal:** make Forge trustworthy enough to use as the default environment every day.

**Scope:**

- Crash recovery for open files and unsaved buffers
- Local history / backup snapshots
- File watching and external-change detection
- Startup performance tuning
- Focus and keyboard polish
- Better empty states and error states
- Packaging and release checklist
- Real-world dogfooding fixes

**Exit criteria:**

- You can use Forge for one full week without needing VS Code for routine work
- Restart and recovery flows do not feel risky
- Core keyboard and focus behavior are boring and dependable

### Phase 5 — Selective Power Features
**Target dates:** June 8, 2026 onward

**Goal:** add only the next features that are justified by real usage pain.

**Candidates:**

- Saved command/task presets
- Test runner shortcuts
- Inline diff review improvements
- Workspace-wide symbol search
- One-language debugger integration, if still necessary
- Worktree awareness
- Better AI patch application and review flow

**Not automatic:**

- Split editors
- extension marketplace
- notebook support
- generic plugin API
- remote dev platform

Ship only the features that repeatedly block real work.

## Capability Matrix

| Capability | v1 | Notes |
|---|---|---|
| Zen editor | Yes | Core interaction model |
| Terminal sessions | Yes | Already core to product |
| Click error to open file | Yes | Already core to product |
| Quick file open | Yes | Required to replace tabs/sidebar dependence |
| Search across files | Yes | Required |
| Git status + diff + commit | Yes | Required |
| LSP diagnostics | Yes | Required for target languages |
| Completion / hover / definition | Yes | Required for target languages |
| Debugger | No | Only if real workflow pain remains after v1 |
| Extension marketplace | No | Explicit non-goal |
| Cross-platform support | No | macOS-first |
| Notebook UI | No | Non-goal |
| Webview/plugin panels | No | Non-goal |

## Success Metrics

Track success against behavior, not feature count.

### Product Metrics

- Days worked fully inside Forge without opening VS Code
- Number of repos actively used in Forge each week
- Median time from terminal error to saved fix
- Median time to open a file from keyboard
- Number of editor/terminal focus bugs encountered during dogfooding
- Number of times missing diagnostics or missing git features force a tool switch

### Release Gates

- **Alpha:** one repo, one full day inside Forge
- **Beta:** three active repos, one full week inside Forge
- **v1 replacement bar:** one full month where VS Code is only used for exceptional cases

## Major Risks

### Scope Creep

The main failure mode is trying to imitate VS Code instead of sharpening the workflow. Every new feature should answer: does this reduce context switching for the target user?

### LSP Integration Cost

Language tooling can expand uncontrollably. Keep the first pass narrow and language-specific.

### Focus and Input Complexity

Terminal + webview editor + native shell interactions can create subtle focus bugs. These are product-critical, not polish.

### UI Drift

If search, git, diagnostics, tasks, and AI are all added as permanent panes, Forge will lose the product advantage. Prefer overlays, modes, and compact context surfaces.

## Immediate Next Build Order

1. Finish the zen editor implementation already specified in the March 22, 2026 plan.
2. Add Quick Open and global text search.
3. Add git status, diff, and commit flow.
4. Add diagnostics for TypeScript/JavaScript first.
5. Dogfood in one repo before expanding language support.

## Decision Summary

Amaru Forge should become a **terminal-native coding environment with a great editor**, not a clone of the VS Code workbench.

If the product stays narrow, disciplined, and fast, it can credibly replace VS Code for this workflow. If it tries to inherit the entire IDE market problem, it will lose the advantage that makes it worth building.
