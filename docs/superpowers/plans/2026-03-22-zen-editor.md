# Zen Editor Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the inline editor side panel into a full-window zen mode overlay with Gemini blue mode indicator, unsaved changes dialog, and side panel markdown spec rendering.

**Architecture:** CSS overlay approach — the existing `#editor-panel` gains a `.zen` class that repositions it as `position: absolute; inset: 0` inside `#app`, covering everything below the titlebar. Terminal stays mounted underneath. A new `check_file_exists` Tauri command and `marked` dependency enable spec file auto-detection and markdown rendering in the side panel.

**Tech Stack:** Vanilla JS, CSS, CodeMirror 6, Tauri v2 (Rust), marked (markdown parser), esbuild

**Spec:** `docs/superpowers/specs/2026-03-22-zen-editor-design.md`

**Note:** Spec mentions `openZen()` as a separate function. This plan simplifies: `.zen` class is always applied by `syncVisibility()` whenever the editor is visible, since zen is the only mode. No separate `openZen()` needed.

---

## File Structure

| File | Role |
|---|---|
| `src/index.html` | Add 3 new DOM elements inside `#editor-panel` |
| `src/css/styles.css` | All zen mode visual styles (~100 lines) |
| `src/js/editor.js` | Zen open/close, unsaved dialog, status bar, header rewrite |
| `src/js/app.js` | Escape/Cmd+E delegation, vertical resize, spec detection, markdown rendering |
| `src-tauri/src/lib.rs` | `check_file_exists` command + `spec_path` in `update_session_metadata` |
| `package.json` | Add `marked` dependency |

---

### Task 1: Add `marked` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install marked**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge" && npm install marked
```

- [ ] **Step 2: Verify it's in package.json**

```bash
grep marked package.json
```

Expected: `"marked": "^..."` in dependencies

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add marked dependency for spec markdown rendering"
```

---

### Task 2: Add `check_file_exists` Tauri command and `spec_path` to `update_session_metadata`

**Files:**
- Modify: `src-tauri/src/lib.rs:154-184` (update_session_metadata) and after line 261 (new command)

- [ ] **Step 1: Add `spec_path` parameter to `update_session_metadata`**

In `src-tauri/src/lib.rs`, modify the `update_session_metadata` function signature to add `spec_path: Option<String>` and handle it in the body:

```rust
#[tauri::command]
fn update_session_metadata(
    session_id: String,
    pinned: Option<bool>,
    notes: Option<String>,
    task: Option<String>,
    project: Option<String>,
    directory: Option<String>,
    spec_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut store = state.store.lock().map_err(|e| format!("lock error: {e}"))?;

    sessions::update_session(&mut store, &session_id, |session| {
        if let Some(p) = pinned {
            session.pinned = p;
        }
        if let Some(n) = notes {
            session.notes = Some(n);
        }
        if let Some(t) = task {
            session.task = t;
        }
        if let Some(p) = project {
            session.project = p;
        }
        if let Some(d) = directory {
            session.directory = d;
        }
        if let Some(sp) = spec_path {
            session.spec_path = Some(sp);
        }
        session.last_accessed_at = Utc::now();
    })
}
```

- [ ] **Step 2: Add `check_file_exists` command**

Add after the `tmux_cancel_copy_mode` command (after line 261):

```rust
#[tauri::command]
fn check_file_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}
```

- [ ] **Step 3: Register in invoke handler**

Add `check_file_exists` to the `tauri::generate_handler![]` list at line 377:

```rust
.invoke_handler(tauri::generate_handler![
    check_tmux,
    create_session,
    list_sessions,
    connect_session,
    write_to_pty,
    disconnect_session,
    kill_session,
    update_session_metadata,
    resize_pty,
    get_git_branch,
    restore_session,
    get_pane_info,
    read_file,
    write_file,
    list_project_dirs,
    tmux_scroll,
    tmux_cancel_copy_mode,
    check_file_exists,
])
```

- [ ] **Step 4: Verify Rust compiles**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge/src-tauri" && cargo check
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge"
git add src-tauri/src/lib.rs
git commit -m "feat: add check_file_exists command and spec_path to update_session_metadata"
```

---

### Task 3: Add new DOM elements to `index.html`

**Files:**
- Modify: `src/index.html:50-63`

- [ ] **Step 1: Add `#editor-assistant-resize`, `#editor-status-bar`, and `#editor-unsaved-dialog`**

Replace the section between `#editor-view` and the closing `</section>` (lines 50-64) with:

```html
          <div id="editor-view" data-tauri-drag-region="false"></div>
          <div id="editor-assistant-resize" class="resize-handle-h"></div>
          <form id="editor-assistant" data-tauri-drag-region="false">
            <label for="editor-assistant-input" id="editor-assistant-label" data-tauri-drag-region="false">Ask Amaru</label>
            <textarea
              id="editor-assistant-input"
              data-tauri-drag-region="false"
              placeholder="Describe the change for the current file or selection..."
              rows="3"
            ></textarea>
            <div id="editor-assistant-footer" data-tauri-drag-region="false">
              <div id="editor-assistant-context" data-tauri-drag-region="false">Open a file to ask for an edit.</div>
              <button type="submit" id="editor-assistant-send">Insert in Terminal</button>
            </div>
          </form>
          <div id="editor-status-bar">
            <span id="editor-status-lang"></span>
            <span id="editor-status-pos"></span>
            <span id="editor-status-hint">Cmd+S to save</span>
          </div>
          <div id="editor-unsaved-dialog" style="display:none;">
            <div id="editor-unsaved-backdrop"></div>
            <div id="editor-unsaved-card">
              <p>You have unsaved changes</p>
              <div id="editor-unsaved-actions">
                <button id="editor-unsaved-save" class="editor-dialog-btn primary">Save & Close</button>
                <button id="editor-unsaved-discard" class="editor-dialog-btn danger">Discard</button>
                <button id="editor-unsaved-cancel" class="editor-dialog-btn neutral">Cancel</button>
              </div>
            </div>
          </div>
        </section>
```

- [ ] **Step 2: Verify HTML is valid by building frontend**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge" && npm run build:frontend
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/index.html
git commit -m "feat: add zen editor DOM elements (resize handle, status bar, unsaved dialog)"
```

---

### Task 4: Add zen mode CSS styles

**Files:**
- Modify: `src/css/styles.css` (append after the `::selection` rule at line 856)

- [ ] **Step 1: Add all zen mode styles**

Append to the end of `src/css/styles.css`:

```css
/* ── Zen Editor Mode ──────────────────────────────────── */

#app {
  position: relative;
}

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

#editor-panel.zen ~ #editor-resize {
  display: none !important;
}

/* Zen header overrides */
#editor-panel.zen #editor-save,
#editor-panel.zen #editor-close,
#editor-panel.zen #editor-location {
  display: none;
}

#editor-panel.zen #editor-header {
  padding: 10px 20px;
  background: var(--mantle);
  border-bottom: 1px solid var(--surface0);
}

#editor-panel.zen #editor-path {
  color: var(--text);
  font-size: 12px;
}

.zen-badge {
  display: none;
  background: #4285F4;
  color: #ffffff;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  font-family: var(--font-ui);
  user-select: none;
  -webkit-user-select: none;
}

#editor-panel.zen .zen-badge {
  display: inline-block;
}

.zen-modified {
  display: none;
  color: var(--yellow);
  font-size: 10px;
  opacity: 0.8;
}

#editor-panel.zen .zen-modified {
  display: inline;
}

.zen-esc {
  display: none;
  align-items: center;
  gap: 8px;
  color: var(--subtext0);
  font-size: 11px;
  font-family: var(--font-ui);
  user-select: none;
  -webkit-user-select: none;
}

#editor-panel.zen .zen-esc {
  display: flex;
}

.zen-esc-key {
  background: #4285F4;
  color: #ffffff;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
}

/* Zen active line override */
#editor-panel.zen .cm-activeLine {
  background: rgba(66, 133, 244, 0.06);
  border-left: 2px solid #4285F4;
}

#editor-panel.zen .cm-activeLineGutter {
  background: rgba(66, 133, 244, 0.10);
}

/* ── Editor Status Bar ────────────────────────────────── */

#editor-status-bar {
  display: none;
  justify-content: space-between;
  padding: 5px 20px;
  background: var(--crust);
  border-top: 1px solid var(--surface0);
  color: var(--overlay0);
  font-size: 10px;
  font-family: var(--font-ui);
  user-select: none;
  -webkit-user-select: none;
}

#editor-panel.zen #editor-status-bar {
  display: flex;
}

#editor-status-hint {
  color: var(--blue);
}

/* ── Vertical Resize Handle (code ↔ Ask Amaru) ───────── */

.resize-handle-h {
  height: 4px;
  cursor: row-resize;
  background: transparent;
  transition: background 0.15s;
  flex-shrink: 0;
}

.resize-handle-h:hover,
.resize-handle-h.active {
  background: var(--surface1);
}

/* ── Unsaved Changes Dialog ───────────────────────────── */

#editor-unsaved-dialog {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: none;
}

#editor-unsaved-dialog[style*="display: flex"],
#editor-unsaved-dialog.visible {
  display: flex;
  align-items: center;
  justify-content: center;
}

#editor-unsaved-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
}

#editor-unsaved-card {
  position: relative;
  background: var(--mantle);
  border: 1px solid var(--surface0);
  border-radius: var(--radius);
  padding: 24px 28px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  text-align: center;
  max-width: 320px;
}

#editor-unsaved-card p {
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 20px;
}

#editor-unsaved-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.editor-dialog-btn {
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  transition: opacity 0.12s;
}

.editor-dialog-btn:hover {
  opacity: 0.88;
}

.editor-dialog-btn.primary {
  background: #4285F4;
  color: #ffffff;
}

.editor-dialog-btn.danger {
  background: var(--red);
  color: var(--base);
}

.editor-dialog-btn.neutral {
  background: var(--surface0);
  color: var(--text);
}
```

- [ ] **Step 2: Build frontend to verify CSS is valid**

```bash
npm run build:frontend
```

- [ ] **Step 3: Commit**

```bash
git add src/css/styles.css
git commit -m "feat: add zen editor mode CSS styles"
```

---

### Task 5: Update `editor.js` — zen mode open/close, header, status bar, unsaved dialog

**Files:**
- Modify: `src/js/editor.js`

- [ ] **Step 1: Add new exports and zen state to the top of the file**

After `let editorView = null;` (line 98), add:

```js
let unsavedResolve = null;
```

- [ ] **Step 2: Add zen header HTML elements in `initEditor()`**

After `wireUi();` in `initEditor()` (line 103), add a call to `injectZenHeaderElements()`. Then add the function after `wireUi()`:

```js
function injectZenHeaderElements() {
  const headerText = document.getElementById('editor-header-text');
  if (!headerText || headerText.querySelector('.zen-badge')) return;

  const badge = document.createElement('span');
  badge.className = 'zen-badge';
  badge.textContent = 'EDITING';
  headerText.insertBefore(badge, headerText.firstChild);

  const modified = document.createElement('span');
  modified.className = 'zen-modified';
  modified.id = 'editor-zen-modified';
  modified.textContent = '● Modified';
  headerText.querySelector('#editor-meta')?.prepend(modified);

  const actions = document.getElementById('editor-actions');
  if (actions) {
    const esc = document.createElement('div');
    esc.className = 'zen-esc';
    esc.innerHTML = '<span class="zen-esc-key">ESC</span><span>Back to terminal</span>';
    actions.appendChild(esc);
  }
}
```

- [ ] **Step 3: Update `syncVisibility()` to apply `.zen` class**

Replace the existing `syncVisibility()` function (lines 388-400) with:

```js
function syncVisibility() {
  const panel = document.getElementById('editor-panel');
  const handle = document.getElementById('editor-resize');
  if (!panel || !handle) return;

  const visible = Boolean(editorState.visible && editorState.path);
  panel.style.display = visible ? 'flex' : 'none';
  handle.style.display = 'none'; // Always hidden — zen mode replaces side panel

  if (visible) {
    panel.classList.add('zen');
  } else {
    panel.classList.remove('zen');
  }

  if (callbacks.onVisibilityChange) {
    callbacks.onVisibilityChange(visible);
  }
}
```

- [ ] **Step 4: Update `updateHeader()` for zen-modified indicator and status bar**

Replace the existing `updateHeader()` function (lines 402-430) with:

```js
function updateHeader() {
  const pathEl = document.getElementById('editor-path');
  const locationEl = document.getElementById('editor-location');
  const statusEl = document.getElementById('editor-status');
  const saveBtn = document.getElementById('editor-save');
  const modifiedEl = document.getElementById('editor-zen-modified');

  const displayPath = editorState.displayPath || editorState.path || 'Inline Editor';
  if (pathEl) {
    pathEl.textContent = displayPath;
    pathEl.title = displayPath;
  }

  const cursor = getCursorLocation();
  if (locationEl) {
    const dirtyLabel = editorState.dirty ? 'Unsaved' : 'Saved';
    locationEl.textContent = editorState.path
      ? `${dirtyLabel} · Ln ${cursor.line}, Col ${cursor.col}`
      : 'Ln 1, Col 1';
  }

  if (modifiedEl) {
    modifiedEl.style.display = editorState.dirty ? 'inline' : 'none';
  }

  if (statusEl) {
    statusEl.textContent = editorState.statusText;
    statusEl.dataset.tone = editorState.statusTone;
  }

  if (saveBtn) {
    saveBtn.disabled = !editorState.path;
  }

  // Update status bar
  const langEl = document.getElementById('editor-status-lang');
  const posEl = document.getElementById('editor-status-pos');
  if (langEl) langEl.textContent = getLanguageName(editorState.path);
  if (posEl) posEl.textContent = `Ln ${cursor.line}, Col ${cursor.col}`;
}
```

- [ ] **Step 5: Add `getLanguageName()` helper**

Add after the `fenceLanguageForPath()` function (after line 557):

```js
function getLanguageName(path) {
  if (!path) return '';
  const lower = path.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'TypeScript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'JavaScript';
  if (lower.endsWith('.rs')) return 'Rust';
  if (lower.endsWith('.py')) return 'Python';
  if (lower.endsWith('.json')) return 'JSON';
  if (lower.endsWith('.toml')) return 'TOML';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'Markdown';
  if (lower.endsWith('.css')) return 'CSS';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'HTML';
  return '';
}
```

- [ ] **Step 6: Add `isZenMode()` and `closeZen()` exports**

Add these functions and export them:

```js
export function isZenMode() {
  const panel = document.getElementById('editor-panel');
  return panel ? panel.classList.contains('zen') : false;
}

export function closeZen() {
  if (!editorState.path) return;

  if (editorState.dirty) {
    showUnsavedDialog('close');
    return;
  }

  doCloseZen();
}

function doCloseZen() {
  editorState.visible = false;
  editorState.path = null;
  editorState.displayPath = '';
  editorState.dirty = false;
  syncVisibility();
  if (callbacks.onClose) callbacks.onClose();
}
```

- [ ] **Step 7: Add unsaved dialog logic**

```js
function showUnsavedDialog(action) {
  const dialog = document.getElementById('editor-unsaved-dialog');
  if (dialog) dialog.style.display = 'flex';
}

function hideUnsavedDialog() {
  const dialog = document.getElementById('editor-unsaved-dialog');
  if (dialog) dialog.style.display = 'none';
}

function wireUnsavedDialog() {
  const saveBtn = document.getElementById('editor-unsaved-save');
  const discardBtn = document.getElementById('editor-unsaved-discard');
  const cancelBtn = document.getElementById('editor-unsaved-cancel');

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      await saveEditor();
      hideUnsavedDialog();
      if (unsavedResolve) { unsavedResolve(true); unsavedResolve = null; }
      doCloseZen();
    });
  }

  if (discardBtn) {
    discardBtn.addEventListener('click', () => {
      hideUnsavedDialog();
      editorState.dirty = false;
      if (unsavedResolve) { unsavedResolve(true); unsavedResolve = null; }
      doCloseZen();
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      hideUnsavedDialog();
      if (unsavedResolve) { unsavedResolve(false); unsavedResolve = null; }
    });
  }
}
```

- [ ] **Step 8: Call `wireUnsavedDialog()` from `initEditor()`**

In `initEditor()`, after `wireUi();` add:

```js
wireUnsavedDialog();
```

- [ ] **Step 9: Update imports in `initEditor` export list**

Make sure `isZenMode` and `closeZen` are exported at the top of the file (they use `export function` syntax so they are auto-exported).

- [ ] **Step 10: Commit**

```bash
git add src/js/editor.js
git commit -m "feat: implement zen editor mode in editor.js"
```

---

### Task 6: Update `app.js` — Escape/Cmd+E delegation, vertical resize, async canOpenEditorPath, focus terminal on close

**Files:**
- Modify: `src/js/app.js`

- [ ] **Step 1: Add `isZenMode` and `closeZen` imports**

Update the import from `editor.js` (lines 8-26) to include the new exports:

```js
import {
  canOpenEditorPath,
  closeZen,
  getOpenEditorPath,
  handleEditorShortcut,
  initEditor,
  isEditorTarget,
  isZenMode,
  openEditorFile,
  revealEditorLocation,
  toggleEditor,
} from './editor.js';
```

- [ ] **Step 2: Add `onClose` callback to `initEditor()`**

In `startApp()`, update the `initEditor()` call (lines 113-119) to include `onClose`:

```js
  initEditor({
    onSave: handleEditorSave,
    onAskAssistant: handleEditorAssistant,
    onClose: () => {
      focusTerminal();
      requestAnimationFrame(() => fitTerminal());
    },
    onVisibilityChange: () => {
      requestAnimationFrame(() => fitTerminal());
    },
  });
```

- [ ] **Step 3: Make `canOpenEditorPath()` async in editor.js**

Replace the existing `canOpenEditorPath()` (lines 109-117 of `editor.js`) with:

```js
export async function canOpenEditorPath(path) {
  if (!editorState.dirty || !editorState.path || editorState.path === path) {
    return true;
  }

  return new Promise((resolve) => {
    unsavedResolve = resolve;
    showUnsavedDialog('switch');
  });
}
```

- [ ] **Step 4: Update Escape handler in `handleKeyboard()`**

Replace the Escape block (lines 470-475) with:

```js
  // Escape — Close zen editor (with unsaved check) or focus terminal
  if (e.key === 'Escape') {
    hideContextMenu();
    if (isZenMode()) {
      closeZen();
      return;
    }
    focusTerminal();
    return;
  }
```

- [ ] **Step 5: Update Cmd+E handler**

Replace the Cmd+E block (lines 438-443) with:

```js
  // Cmd+E — Toggle inline editor (close zen if active)
  if (meta && key === 'e') {
    e.preventDefault();
    if (isZenMode()) {
      closeZen();
    } else {
      toggleEditor();
    }
    return;
  }
```

- [ ] **Step 6: Make `openLinkedFile()` async-safe with `canOpenEditorPath()`**

Update `openLinkedFile()` (line 743) to `await canOpenEditorPath`:

```js
async function openLinkedFile({ file, line, col }) {
  const resolvedPath = await resolveLinkedFilePath(file);
  if (!resolvedPath) return;

  const canOpen = await canOpenEditorPath(resolvedPath);
  if (!canOpen) {
    return;
  }

  if (getOpenEditorPath() === resolvedPath) {
    revealEditorLocation(line, col || 1);
    toggleEditorIfHidden();
    return;
  }

  const { invoke } = window.__TAURI__.core;

  try {
    const result = await invoke('read_file', { path: resolvedPath });
    const absolutePath = result.path || resolvedPath;
    openEditorFile({
      path: absolutePath,
      displayPath: absolutePath,
      content: result.content || '',
      line,
      col: col || 1,
    });
  } catch (err) {
    console.error('[app] read_file error:', err);
    window.alert(`Failed to open ${resolvedPath}\n\n${err}`);
  }
}
```

- [ ] **Step 7: Wire vertical resize handle for Ask Amaru**

Add after the existing `setupResize()` calls in `startApp()` (after line 150):

```js
  setupVerticalResize(
    'editor-assistant-resize',
    'editor-assistant',
    80,     // min height
    null,   // max = 50% of parent (calculated dynamically)
  );
```

Then add the `setupVerticalResize` function after `restoreSize()` (after line 549):

```js
function setupVerticalResize(handleId, targetId, minHeight, maxHeight) {
  const handle = document.getElementById(handleId);
  const target = document.getElementById(targetId);
  if (!handle || !target) return;

  let startY = 0;
  let startHeight = 0;
  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startHeight = target.getBoundingClientRect().height;
    handle.classList.add('active');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;

    const delta = startY - e.clientY; // Dragging up = bigger
    const parentHeight = target.parentElement?.getBoundingClientRect().height || 600;
    const max = maxHeight || parentHeight * 0.5;
    const newHeight = Math.max(minHeight, Math.min(max, startHeight + delta));
    target.style.height = newHeight + 'px';
    target.style.flex = 'none';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}
```

- [ ] **Step 8: Commit**

```bash
git add src/js/app.js src/js/editor.js
git commit -m "feat: wire zen editor escape/cmd-e delegation, vertical resize, async canOpenEditorPath"
```

---

### Task 7: Add spec auto-detection and markdown rendering to side panel

**Files:**
- Modify: `src/js/app.js` (add to `pollContext()` and replace `loadPanelContent`)

- [ ] **Step 1: Add `marked` import at top of `app.js`**

Add after the existing imports (after line 27):

```js
import { marked } from 'marked';
```

- [ ] **Step 2: Add `detectSpecFile()` helper**

Add after `deriveProjectName()` (after line 739):

```js
const SPEC_FILENAMES = ['SPEC.md', 'DESIGN.md', 'PLAN.md'];

async function detectSpecFile(cwd) {
  if (!cwd) return null;
  const { invoke } = window.__TAURI__.core;

  for (const name of SPEC_FILENAMES) {
    const path = `${cwd}/${name}`;
    try {
      const exists = await invoke('check_file_exists', { path });
      if (exists) return path;
    } catch (_) {}
  }
  return null;
}
```

- [ ] **Step 3: Call `detectSpecFile` from `pollContext()`**

In `pollContext()`, after the "Update session metadata if context changed" block (after line 705), add:

```js
    // Detect spec file if not already set or if directory changed
    if (dirChanged || !session.specPath) {
      const specPath = await detectSpecFile(cwd);
      if (specPath && specPath !== session.specPath) {
        await invoke('update_session_metadata', {
          sessionId: session.id,
          specPath,
        });
        await refreshSessions();
      }
    }
```

- [ ] **Step 4: Replace `loadPanelContent()` with markdown rendering**

Replace the existing `loadPanelContent()` (lines 358-384) with:

```js
async function loadPanelContent(tabName) {
  const body = document.getElementById('panel-body');
  const title = document.getElementById('panel-title');
  if (!body) return;

  if (title) title.textContent = tabName === 'spec' ? 'Spec' : 'Notes';

  const sessionId = getCurrentSessionId();
  if (!sessionId) {
    body.innerHTML = '<p>No active session</p>';
    return;
  }

  const sessions = getSessions();
  const session = sessions.find((s) => s.id === sessionId || s.tmuxName === sessionId);

  if (tabName === 'notes') {
    body.innerHTML = session?.notes
      ? `<p>${escapeAttr(session.notes)}</p>`
      : '<p style="color:var(--overlay0)">No notes yet</p>';
    return;
  }

  // Spec tab — render markdown from detected spec file
  if (!session?.specPath) {
    body.innerHTML = '<p style="color:var(--overlay0)">No spec found. Add SPEC.md, DESIGN.md, or PLAN.md to your project root.</p>';
    return;
  }

  try {
    const { invoke } = window.__TAURI__.core;
    const result = await invoke('read_file', { path: session.specPath });
    const html = marked.parse(result.content || '', { breaks: true });
    // Sanitize: strip script tags
    body.innerHTML = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  } catch (err) {
    body.innerHTML = `<p style="color:var(--red)">Failed to load spec: ${escapeAttr(String(err))}</p>`;
  }
}
```

- [ ] **Step 5: Add link click handler for markdown links**

After the `loadPanelContent` function, add a delegated click handler that opens links in the default browser via Tauri's shell API. Wire it in `wirePanel()`:

```js
function wirePanelLinks() {
  const body = document.getElementById('panel-body');
  if (!body) return;

  body.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;

    e.preventDefault();
    const href = link.getAttribute('href');
    if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
      window.__TAURI__.shell.open(href);
    }
  });
}
```

Call `wirePanelLinks()` at the end of `wirePanel()`.

- [ ] **Step 6: Build frontend to verify**

```bash
npm run build:frontend
```

Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/js/app.js
git commit -m "feat: add spec auto-detection and markdown rendering in side panel"
```

---

### Task 8: Full build and manual verification

**Files:** None (verification only)

- [ ] **Step 1: Clean build**

```bash
cd "/Users/owner/Desktop/Tech Tools/amaru-forge" && rm -rf dist && npm run build:frontend
```

Expected: `dist/` created with `bundle.js`, `index.html`, `styles.css`, etc.

- [ ] **Step 2: Run Tauri dev**

```bash
npm run dev
```

- [ ] **Step 3: Verify manually**

Verification checklist:
1. Create or connect to a session
2. Run a command that produces a file:line error (e.g., `node -e "require('./nonexistent')"` or similar)
3. Click the file link — **editor should take over the full window** with Gemini blue border
4. Verify "EDITING" badge, filename, and ESC keycap are visible in the header
5. Verify status bar shows language, Ln/Col, and "Cmd+S to save"
6. Edit the file — verify "● Modified" indicator appears
7. Press Escape — verify unsaved dialog appears with Save & Close / Discard / Cancel
8. Click Cancel — verify dialog dismisses
9. Press Escape again — click Discard — verify editor closes and terminal is focused
10. Open editor again, make a change, press Cmd+S to save, then Escape — verify closes without dialog
11. Press Cmd+B — verify side panel opens with Spec tab
12. If project has a SPEC.md/DESIGN.md/PLAN.md, verify it renders as styled markdown
13. Resize the Ask Amaru panel by dragging the handle — verify it works
14. Press Cmd+E — verify it closes zen editor (same as Escape)

- [ ] **Step 4: Commit any fixes if needed**

```bash
git add -A && git commit -m "fix: address manual testing issues"
```
