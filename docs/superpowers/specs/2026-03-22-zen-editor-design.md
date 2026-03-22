# Zen Editor Mode — Design Spec

## Overview

Transform the existing inline editor side panel into a full-window "zen mode" takeover. When a user clicks a file:line:col link in terminal output, the editor covers everything below the titlebar — sidebar, tab bar, terminal, all hidden. Just the editor. The terminal stays mounted underneath (PTY alive) and is revealed when the user presses Escape.

Zen mode is the **only** editor mode going forward. The old side-panel layout is replaced entirely. There is no non-zen visible state for the editor.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Layout mode | Full-window takeover (below titlebar) | Zen-like editing — everything disappears, just code |
| Mode indicator | Gemini blue (#4285F4) border + badge + ESC keycap | Must be crystal clear the user is in editor mode |
| Entry trigger | Click file:line:col links in terminal output | Existing behavior, no new entry points |
| Exit trigger | Escape key | Warns if unsaved changes |
| Ask Amaru panel | Always visible, resizable | Draggable divider between code and prompt |
| Unsaved changes | Warn on Escape (Save / Discard / Cancel) | Safe UX, explicit user choice |
| Implementation approach | CSS Overlay | Smallest change, CodeMirror stays mounted, lowest risk |

## Architecture: CSS Overlay Approach

The existing `#editor-panel` (currently a 520px side panel in a horizontal flex row) gains a `.zen` CSS class when the editor opens. This class repositions the panel as an absolute overlay covering `#app` (everything below the titlebar).

### Why CSS Overlay

- **Smallest diff** — ~250 lines across 4 files
- **CodeMirror stays mounted** — no DOM moves, no state loss, no scroll/undo breakage
- **Terminal stays alive** — PTY connection uninterrupted underneath
- **Easy to revert** — remove `.zen` class and everything goes back to normal

### Rejected Alternatives

- **Z-Index Layer** (new `#editor-zen` container outside `#app`): Moving CodeMirror DOM between parents breaks state. Higher complexity, higher risk.
- **Flex Visibility Toggle** (hide terminal, expand editor): Layout direction change from horizontal to vertical causes cascading flex rework. Side effects on tab bar and side panel.

## Layout Specification

### Container Setup

`#app` gets `position: relative` (anchor for absolute child). This covers the entire area below the titlebar, including sidebar and terminal.

### Zen Mode (`#editor-panel.zen`)

```css
#editor-panel.zen {
  position: absolute;
  inset: 0;
  width: auto;
  max-width: none;
  min-width: 0;
  z-index: 50;
  border: 2px solid #4285F4;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
}
```

Z-index layering:
- Editor zen: 50
- Context menu: 200
- Setup screen: 300

### Header

- **Left:** "EDITING" badge (Gemini blue bg, white text) + file path + modified indicator (yellow dot)
- **Right:** Styled ESC keycap (Gemini blue bg, white text, rounded) + "Back to terminal" label
- Existing Save button (`#editor-save`) and close button (`#editor-close`) are **hidden via CSS** in zen mode (`display: none` when `.zen` is active). They remain in the DOM with handlers intact — just invisible. The Save affordance is replaced by the status bar "Cmd+S to save" hint. The close affordance is replaced by the ESC keycap.
- Existing `#editor-location` in the header is **hidden via CSS** in zen mode — the Ln/Col display moves to the new status bar.

### Code Area

- `#editor-view` — takes `flex: 1`, fills remaining space
- Active line highlight overridden in zen mode:
  - Background: `rgba(66, 133, 244, 0.06)`
  - Left border: `2px solid #4285F4`

### Vertical Resize Handle

New `<div id="editor-assistant-resize">` between `#editor-view` and `#editor-assistant` (note: `#editor-assistant` is a `<form>` element):
- `cursor: row-resize`
- Same visual style as existing resize handles
- JS wiring in `app.js` using existing mousedown/mousemove/mouseup pattern
- Min Ask Amaru height: 80px
- Max Ask Amaru height: 50% of editor panel

### Ask Amaru Panel

Existing `#editor-assistant` (`<form>`) — no structural changes. Resizable via new vertical handle above it.

### Status Bar

New `<div id="editor-status-bar">` at bottom of `#editor-panel`:
- Left: language name
- Center: Ln/Col position (replaces `#editor-location` which is hidden in zen)
- Right: "Cmd+S to save" hint
- Styled: `background: var(--crust)`, small text, subtle border-top

## Escape Key & Unsaved Changes

### Escape Key Conflict Resolution

The existing `handleKeyboard` function in `app.js` (lines 471-475) intercepts Escape globally — it calls `hideContextMenu()` and `focusTerminal()` unconditionally. **This must be modified.** When the editor is in zen mode, the global Escape handler must delegate to the editor's close/unsaved-changes flow instead of focusing the terminal. Add a check: if zen mode is active, call `editor.closeZen()` and return early.

### Flow

1. User presses **Escape** while editor is in zen mode
2. Global handler in `app.js` detects zen mode, delegates to `editor.closeZen()`
3. `closeZen()` checks `editorState.dirty`
4. **If clean:** Close immediately — remove `.zen`, hide editor, focus terminal
5. **If dirty:** Show custom unsaved dialog

### Cmd+E Behavior

Currently `Cmd+E` calls `toggleEditor()` which flips editor visibility. In zen mode, `Cmd+E` triggers the same flow as Escape — checks dirty state, shows dialog if needed, then closes. This is implemented by having `toggleEditor()` delegate to `closeZen()` when zen is active.

### Unsaved Dialog

A small custom modal (`#editor-unsaved-dialog`) inside `#editor-panel`:
- `position: absolute; z-index: 10` within the editor panel stacking context
- Semi-transparent backdrop (`rgba(0,0,0,0.5)`) covering the editor to prevent interaction while dialog is showing
- Centered card with Catppuccin styling
- Message: "You have unsaved changes"
- Three buttons:
  - **Save & Close** (blue, primary) — saves then closes
  - **Discard** (red/danger) — closes without saving
  - **Cancel** (neutral) — dismisses dialog, stays in editor
- Not a native `confirm()` — native dialogs look jarring in Tauri

### Replacing `canOpenEditorPath()` confirm

The existing `canOpenEditorPath()` in `editor.js` uses `window.confirm()` for the case where a user clicks a different file link while the current file has unsaved changes. This is **replaced** with the same custom `#editor-unsaved-dialog`. The function becomes async (returns a Promise) and shows the dialog instead of calling `window.confirm()`. Callers in `app.js` are updated to `await` the result.

### Focus Management

- **On open:** `requestAnimationFrame(() => editorView.focus())` (already exists)
- **On close:** Focus returns to terminal via existing terminal focus logic

## Edge Cases

### Opening a new file while zen is open

The terminal is covered in zen mode, so the user cannot click new file links. However, if zen is closed and a new link is clicked, zen re-opens. If `openEditorFile()` is called programmatically while zen is active, the content updates in place and zen remains active.

### Horizontal resize handle (`#editor-resize`)

The existing `#editor-resize` handle (between terminal and editor in side-panel mode) is **hidden in zen mode** via CSS: `#editor-panel.zen ~ #editor-resize { display: none; }`. On zen removal, its display is restored to match editor visibility.

## Files Changed

| File | Changes |
|---|---|
| `src/index.html` | Add `#editor-assistant-resize` div between `#editor-view` and `#editor-assistant` form. Add `#editor-status-bar` div after `#editor-assistant`. Add `#editor-unsaved-dialog` div (with backdrop) inside `#editor-panel`. |
| `src/css/styles.css` | Add `position: relative` to `#app`. Add `#editor-panel.zen` overlay styles. Hide `#editor-save`, `#editor-close`, `#editor-location` in zen mode. Add zen header styles (badge, ESC keycap). Add `#editor-status-bar` styles. Add zen active line override. Add `#editor-unsaved-dialog` + backdrop styles. Add `#editor-assistant-resize` handle styles. Hide `#editor-resize` when zen is active. |
| `src/js/editor.js` | Add `openZen()` — applies `.zen` class, updates header to zen layout. Add `closeZen()` — checks dirty state, shows dialog or closes. Make `canOpenEditorPath()` async, replace `window.confirm()` with custom dialog. Add Escape handling delegation (called from `app.js`). Add unsaved dialog show/hide/button logic. Export `isZenMode()` check for use by `app.js`. Update `syncVisibility()` to always apply `.zen` class (zen is the only mode). Update `updateHeader()` to render zen header content. Update status bar Ln/Col on cursor changes. Add `getLanguageName()` helper for status bar. |
| `src/js/app.js` | Modify global Escape handler to check `editor.isZenMode()` and delegate to `editor.closeZen()`. Modify `Cmd+E` handler to delegate to `closeZen()` when zen is active. Update `canOpenEditorPath()` calls to `await` (now async). Wire `#editor-assistant-resize` handle (mousedown/mousemove/mouseup for vertical resize). Same pattern as existing sidebar and editor resize handles. |

### Unchanged Files

- `src-tauri/` — No new Tauri commands
- `src/js/terminal.js` — File link detection unchanged
- `src/js/sidebar.js` — Unaffected
- `build.mjs` — No new dependencies
- `package.json` — No new packages
