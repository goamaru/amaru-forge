# Terminal-First Sidecar Shell — Handoff Document

## Goal

Rework Amaru Forge so it feels like a **terminal application first**, not a website shell that happens to contain a terminal.

The approved direction is:

- persistent session sidebar on the left
- primary terminal surface in the center
- sidecar model as a dedicated panel on the right
- simple, calm chrome with power accessed through the command lane and the right-side sidecar

This is not a request to add more dashboard UI. The user explicitly wants a simpler interface with the same power.

## Approved Design References

Use these as the source of truth:

- `docs/mockups/terminal-first-zen-v4-balanced.html`
- `docs/mockups/terminal-first-zen-v5-screenshot-skin.html`

Interpretation:

- `v4` is the approved **layout**
- `v5` is the approved **visual skin adjustment** for the sidebar/buttons
- the screenshot at `/Users/owner/Desktop/Screenshots/Screenshot 2026-03-26 at 10.32.54 AM.png` is the visual reference for the sidebar/button treatment

## Non-Negotiables

- Keep the **previous balanced layout** as the build target.
- The **sidecar must remain a panel on the right**.
- The sidebar must show **all sessions**.
- The terminal must remain the dominant center surface.
- Keep the **current tool’s color/button scheme**. Do not invent a new palette.
- Match the screenshot’s sidebar language:
  - soft blue primary `+ New Session` button
  - dark compact search field
  - flat/tight session cards
  - active row with left blue accent
- Every future mockup revision should be a **new HTML file**, not an overwrite.
- Do not drift into a “web app dashboard” layout.

## Product Constraints

The user wants the app to stay lean even with many session records in the sidebar.

Important distinction:

- A **session** is saved context the user can return to.
- A **runtime** is an actually live tmux/agent process.

Approved operating model:

- at most `1-2` live primary sessions
- one active sidecar for the currently active session only
- all other sessions can exist in the sidebar as saved or hibernated context

Do not implement:

- one live xterm per session
- one live sidecar/model process per session
- hidden mounted terminals for inactive sessions
- extra persistent panels just because the app can render them

## Memory / Runtime Notes

This was discussed explicitly with the user.

Observed process snapshot:

- `tmux` itself was tiny, roughly `2.7 MB` and `4.3 MB` RSS
- the expensive pieces were the live model/tooling processes
- `claude` processes were roughly `167-351 MB` each
- MCP-related `npm` / `node` children were often `40-90 MB` each

Conclusion:

- `tmux` is not the main hog
- `tmux` keeps the expensive process trees alive
- the UI must not multiply live runtimes just because there are many sessions in the sidebar

If this implementation becomes heavy, it will likely be because it accidentally creates:

- multiple mounted terminals
- a live advisor runtime for each session
- duplicated MCP/tool child processes per session

## Current Starting Point In The Codebase

Relevant files:

- `src/index.html`
- `src/css/styles.css`
- `src/js/app.js`
- `src/js/sidebar.js`
- `src/js/editor.js`

Useful behavior already present in the app:

- the app already uses a reconnectable terminal model rather than a literal terminal DOM per session
- session metadata rendering already exists in the sidebar code
- there is already editor/zen work in progress that this layout must coexist with

## Current Working Tree Status

The tree is **not clean**. Some work has been partially applied already.

Current modified / untracked paths observed during handoff prep:

- `src/index.html`
- `src/css/styles.css`
- `src/js/app.js`
- `src/js/sidebar.js`
- `src/js/editor.js`
- `docs/mockups/terminal-first-zen-v4-balanced.html`
- `docs/mockups/terminal-first-zen-v5-screenshot-skin.html`

Important warning:

- `src/js/editor.js` already had in-progress changes and should be treated carefully
- do not blindly revert or overwrite `editor.js`

## Partial WIP Already Landed

These changes exist in the working tree, but they are **not complete** and should not be treated as finished implementation.

### `src/index.html`

The shell has been partially reshaped toward the approved layout:

- new titlebar actions:
  - `#titlebar-command`
  - `#titlebar-ask`
- old `#tab-bar` replaced with `#command-lane`
- terminal wrapped in:
  - `#terminal-frame`
  - `#terminal-toolbar`
- right panel replaced with sidecar markup:
  - `#sidecar-header`
  - `#sidecar-top`
  - `#sidecar-log`
  - `#sidecar-composer`
  - `#sidecar-input`
  - `#sidecar-send`

This is directionally correct, but it still needs the JS to be completed.

### `src/css/styles.css`

A large override block was added starting near the old side-panel section.

It includes styling for:

- titlebar actions
- sidebar/session rows
- command lane
- terminal frame/toolbar
- right-hand sidecar

This is likely usable as a base, but it should be reviewed and cleaned up rather than assumed production-ready.

### `src/js/sidebar.js`

Sidebar rendering was partially updated to support the new sidebar treatment:

- session name
- branch line
- metadata line
- session state line
- active session copy in the command lane

This is aligned with the approved design direction.

### `src/js/app.js`

This file is the most incomplete.

Partial changes already made:

- sidecar width persistence key added
- sidecar state map added
- side panel resize now targets a right-hand sidecar width
- `selectSession()` now tries to refresh shell chrome and sidecar state
- `wirePanel()` was partially rewritten to wire:
  - command button
  - ask button
  - sidecar model select
  - sidecar quick actions
  - sidecar composer submit

Problem:

`app.js` now references helper functions that are not implemented in the file yet, including:

- `refreshShellChrome`
- `renderSidecar`
- `focusSidebarSearch`
- `focusSidecarInput`
- `getCurrentSessionEntry`
- `ensureSidecarState`
- `handleSidecarAction`
- `submitSidecarPrompt`
- `appendSidecarMessage`
- `truncateSidecarText`
- `formatError`

So this file is currently a partial scaffold, not a complete feature.

### `src/js/editor.js`

There is separate zen editor work already in flight:

- `canOpenEditorPath()` was changed to `async`
- `isZenMode()` and `closeZen()` were added
- unsaved dialog hooks were added
- zen badge/header logic was added

This creates follow-up integration work:

- any call sites still treating `canOpenEditorPath()` as synchronous need to be fixed
- `app.js` keyboard / editor handling should be checked against `isZenMode()` / `closeZen()`

## What Still Needs To Be Done

### 1. Make the approved shell real

Finish the `index.html` / `styles.css` / `app.js` integration so the app actually behaves like:

- left session rail
- center terminal
- right sidecar

### 2. Treat the mockups as product truth

Build from:

- `v4` structure
- `v5` visual treatment

If current source edits differ from those mockups, prefer the mockups.

### 3. Finish sidecar behavior

Implement a minimal but real sidecar loop for the active session only:

- per-session draft/history state is fine
- active-session render only
- no per-session live advisor process

Minimum sidecar behavior:

- model selector
- message log
- composer
- quick actions:
  - ask about current run
  - review current diff
  - open project spec
  - zen edit file

### 4. Keep one mounted terminal surface

Preserve the lightweight rule:

- one active xterm mount
- sidebar rows are metadata only
- reconnect terminal when switching sessions

### 5. Decide what “sleeping” means in the sidebar

Use honest language:

- `live` means the runtime is actually active
- `sleeping` or `hibernated` means restored context is available, not necessarily the original in-memory process

Do not promise exact continuity unless the runtime is actually still live.

### 6. Fix editor integration

Before shipping:

- audit all `canOpenEditorPath()` call sites
- make sure escape / zen behavior is coherent
- make sure right-side sidecar and zen editor do not fight each other

### 7. Verify command lane behavior

The command lane should feel like a calm access point, not extra clutter.

It should support the power features without turning the center into a web dashboard.

## Suggested Implementation Order

1. Finish shell layout in `src/index.html` and `src/css/styles.css`.
2. Make sidebar rendering stable in `src/js/sidebar.js`.
3. Implement the missing sidecar helper functions in `src/js/app.js`.
4. Ensure the sidecar only tracks the active session and does not spawn separate live runtimes.
5. Fix editor integration issues caused by `async canOpenEditorPath()` and zen mode changes.
6. Test session switching, reconnect behavior, sidecar draft persistence, and editor open/close flows.

## Acceptance Criteria

The implementation is done when:

- the app visually matches the approved shell direction from `v4` + `v5`
- the center feels like a terminal-first application
- the right sidecar works as an advisory surface for the active session
- the sidebar holds all sessions without making the app feel busy
- switching sessions does not mount multiple hidden terminals
- the UI does not create a live second model per session
- the app remains lightweight with many sidebar entries and only `1-2` live runtimes

## One-Line Build Summary

Build the `v4` terminal-first layout, skin the sidebar/buttons like `v5` and the screenshot, keep the sidecar on the right, and preserve a lean runtime model by allowing only `1-2` live sessions plus one active sidecar.
