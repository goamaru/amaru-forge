# Zen Editor Mode — Design Spec

## Overview

Transform the existing inline editor side panel into a full-window "zen mode" takeover. When a user clicks a file:line:col link in terminal output, the editor covers the entire workspace — no split view, no distractions. The terminal stays mounted underneath (PTY alive) and is revealed when the user presses Escape.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Layout mode | Full-window takeover | Zen-like editing — terminal disappears, just code |
| Mode indicator | Gemini blue (#4285F4) border + badge + ESC keycap | Must be crystal clear the user is in editor mode |
| Entry trigger | Click file:line:col links in terminal output | Existing behavior, no new entry points |
| Exit trigger | Escape key | Warns if unsaved changes |
| Ask Amaru panel | Always visible, resizable | Draggable divider between code and prompt |
| Unsaved changes | Warn on Escape (Save / Discard / Cancel) | Safe UX, explicit user choice |
| Implementation approach | CSS Overlay | Smallest change, CodeMirror stays mounted, lowest risk |

## Architecture: CSS Overlay Approach

The existing `#editor-panel` (currently a 520px side panel in a horizontal flex row) gains a `.zen` CSS class when the editor opens. This class repositions the panel as an absolute overlay covering `#terminal-workspace`.

### Why CSS Overlay

- **Smallest diff** — ~200 lines across 4 files
- **CodeMirror stays mounted** — no DOM moves, no state loss, no scroll/undo breakage
- **Terminal stays alive** — PTY connection uninterrupted underneath
- **Easy to revert** — remove `.zen` class and everything goes back to normal

### Rejected Alternatives

- **Z-Index Layer** (new `#editor-zen` container outside `#app`): Moving CodeMirror DOM between parents breaks state. Higher complexity, higher risk.
- **Flex Visibility Toggle** (hide terminal, expand editor): Layout direction change from horizontal to vertical causes cascading flex rework. Side effects on tab bar and side panel.

## Layout Specification

### Container Setup

`#terminal-workspace` gets `position: relative` (anchor for absolute child).

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
- Existing Save button and close (X) button removed from header

### Code Area

- `#editor-view` — takes `flex: 1`, fills remaining space
- Active line highlight overridden in zen mode:
  - Background: `rgba(66, 133, 244, 0.06)`
  - Left border: `2px solid #4285F4`

### Vertical Resize Handle

New `<div id="editor-assistant-resize">` between `#editor-view` and `#editor-assistant`:
- `cursor: row-resize`
- Same visual style as existing resize handles
- JS wiring in `app.js` using existing mousedown/mousemove/mouseup pattern
- Min Ask Amaru height: 80px
- Max Ask Amaru height: 50% of editor panel

### Ask Amaru Panel

Existing `#editor-assistant` — no structural changes. Resizable via new vertical handle above it.

### Status Bar

New `<div id="editor-status-bar">` at bottom of `#editor-panel`:
- Left: language name
- Center: Ln/Col position
- Right: "Cmd+S to save" hint
- Styled: `background: var(--crust)`, small text, subtle border-top

## Escape Key & Unsaved Changes

### Flow

1. User presses **Escape** while editor is in zen mode
2. Check `editorState.dirty`
3. **If clean:** Close immediately — remove `.zen`, hide editor, focus terminal
4. **If dirty:** Show custom unsaved dialog

### Unsaved Dialog

A small custom modal (`#editor-unsaved-dialog`) inside `#editor-panel`:
- Centered card with Catppuccin styling
- Message: "You have unsaved changes"
- Three buttons:
  - **Save & Close** (blue, primary) — saves then closes
  - **Discard** (red/danger) — closes without saving
  - **Cancel** (neutral) — dismisses dialog, stays in editor
- Not a native `confirm()` — native dialogs look jarring in Tauri

### Focus Management

- **On open:** `requestAnimationFrame(() => editorView.focus())` (already exists)
- **On close:** Focus returns to terminal via existing terminal focus logic

## Files Changed

| File | Changes |
|---|---|
| `src/index.html` | Add `#editor-assistant-resize` div between `#editor-view` and `#editor-assistant`. Add `#editor-status-bar` div after `#editor-assistant`. Add `#editor-unsaved-dialog` div inside `#editor-panel`. |
| `src/css/styles.css` | Add `#editor-panel.zen` overlay styles. Add zen header styles (badge, ESC keycap). Add `#editor-status-bar` styles. Add zen active line override. Add `#editor-unsaved-dialog` styles. Add `#editor-assistant-resize` handle styles. Add `position: relative` to `#terminal-workspace`. |
| `src/js/editor.js` | Add `openZen()` — applies `.zen` class, updates header to zen layout. Add `closeZen()` — removes `.zen` class, hides editor, focuses terminal. Add Escape keydown handler with unsaved changes check. Add unsaved dialog show/hide/button logic. Update `syncVisibility()` to apply `.zen` class. Update `updateHeader()` to render zen-specific header content. Add `getLanguageName()` helper for status bar. |
| `src/js/app.js` | Wire `#editor-assistant-resize` handle (mousedown/mousemove/mouseup for vertical resize). Same pattern as existing sidebar and editor resize handles. |

### Unchanged Files

- `src-tauri/` — No new Tauri commands
- `src/js/terminal.js` — File link detection unchanged
- `src/js/sidebar.js` — Unaffected
- `build.mjs` — No new dependencies
- `package.json` — No new packages
