# Zen Editor — Handoff Document

## What Was Decided

We designed and planned a **zen editor mode** for Amaru Forge — a full-window code editor takeover that replaces the existing side-panel editor. When a user clicks a file:line:col link in terminal output, the editor covers everything below the titlebar. Press Escape to return.

## Key Design Choices

- **Full-window takeover** — not a split, not a float. Editor covers sidebar, terminal, everything.
- **Gemini blue (#4285F4)** — border around editor + "EDITING" badge + styled ESC keycap
- **Ask Amaru panel** — always visible at bottom, resizable via drag handle
- **Unsaved changes** — custom dialog on Escape (Save & Close / Discard / Cancel), not native `confirm()`
- **CSS overlay approach** — `#editor-panel` gets `.zen` class with `position: absolute; inset: 0` inside `#app`
- **Zen is the only mode** — old side-panel layout is gone entirely
- **Spec panel** — auto-detects `SPEC.md` > `DESIGN.md` > `PLAN.md` in project root, renders markdown in side panel (`Cmd+B`)

## Files to Read

| File | Purpose |
|---|---|
| `docs/superpowers/specs/2026-03-22-zen-editor-design.md` | Full design spec (approved, reviewed) |
| `docs/superpowers/plans/2026-03-22-zen-editor.md` | Implementation plan (8 tasks, reviewed) |

## How to Execute

1. Use **superpowers:subagent-driven-development** skill
2. The plan has 8 tasks with checkbox steps — execute task by task
3. Each task has exact file paths, code snippets, and commit messages
4. Task 8 is manual verification with a full checklist

## Current State

- All source files are **untouched** — no implementation has started
- The plan and spec are committed to `main` branch
- `marked` dependency has NOT been installed yet (Task 1)
- No new branches — work can start on a feature branch or directly on main

## Context That Might Be Useful

- This is a **Tauri v2 desktop app** (Rust backend + vanilla JS frontend)
- **No framework** — pure DOM manipulation, no React/Vue/etc.
- **esbuild** bundles `src/js/app.js` → `dist/bundle.js`
- **CodeMirror 6** is the editor — fragile when you move its DOM (that's why we chose CSS overlay)
- The existing editor already works — we're just changing how it's displayed
- `Cmd+B` toggles the side panel, `Cmd+E` toggles the editor, `Escape` focuses terminal
- Session metadata (including `spec_path`) is stored in `~/.terminal-forge/sessions.json`
