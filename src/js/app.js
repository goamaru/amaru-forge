/**
 * Amaru Forge — Main app coordinator.
 *
 * Wires together terminal, sidebar, modals, panels, keyboard shortcuts,
 * and resize handles. Entry point for the frontend.
 */

import {
  initTerminal,
  connectToSession,
  focusTerminal,
  fitTerminal,
  getCurrentSessionId,
  sendTextToTerminal,
  setFileLinkHandler,
} from './terminal.js';
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
import { initSidebar, refreshSessions, setActiveSession, getSessions } from './sidebar.js';

// ── Constants ───────────────────────────────────────────

const SIDEBAR_WIDTH_KEY = 'amaru-forge:sidebar-width';
const EDITOR_WIDTH_KEY = 'amaru-forge:editor-width';
const SIDECAR_WIDTH_KEY = 'amaru-forge:sidecar-width';
const PROJECTS_BASE = '/Users/owner/Desktop/Tech Tools';
const CONTEXT_POLL_INTERVAL = 3000;
const DEFAULT_SIDECAR_MODEL = 'Claude';

// ── State ───────────────────────────────────────────────

let contextMenuSessionId = null;
let contextPollTimer = null;
const sidecarSessions = new Map();

// ── Bootstrap ───────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Debug: check if Tauri API is available
  if (!window.__TAURI__) {
    console.error('[app] window.__TAURI__ is undefined — Tauri IPC not injected');
    document.body.innerHTML = '<pre style="color:#f38ba8;padding:20px;">ERROR: Tauri API not available.\nwindow.__TAURI__ is undefined.\nMake sure the app is running inside Tauri, not a plain browser.</pre>';
    return;
  }

  try {
    const { invoke } = window.__TAURI__.core;
    console.log('[app] Tauri API available, checking tmux...');
    const hasTmux = await invoke('check_tmux');
    console.log('[app] check_tmux result:', hasTmux);
    if (!hasTmux) {
      showSetupScreen();
      return;
    }
  } catch (err) {
    // Show the ACTUAL error, not the tmux setup screen
    console.error('[app] check_tmux invoke error:', err);
    document.body.innerHTML = `<pre style="color:#f38ba8;padding:20px;">ERROR invoking check_tmux:\n${err}\n\nThis is a Tauri IPC error, not a tmux issue.</pre>`;
    return;
  }

  startApp();
});

// ── Setup Screen ────────────────────────────────────────

function showSetupScreen() {
  const screen = document.getElementById('setup-screen');
  if (screen) screen.style.display = 'flex';

  const copyBtn = document.getElementById('setup-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText('brew install tmux').then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy Command'; }, 2000);
      });
    });
  }

  const retryBtn = document.getElementById('setup-retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      try {
        const { invoke } = window.__TAURI__.core;
        const hasTmux = await invoke('check_tmux');
        if (hasTmux) {
          screen.style.display = 'none';
          startApp();
        }
      } catch (err) {
        console.error('[app] retry check_tmux error:', err);
      }
    });
  }
}

// ── App Start ───────────────────────────────────────────

async function startApp() {
  // Wire window controls (decorations: false — we handle close/min/max)
  wireWindowControls();

  // Initialize terminal
  initTerminal();
  setFileLinkHandler((link) => openLinkedFile(link));

  initEditor({
    onSave: handleEditorSave,
    onAskAssistant: handleEditorAssistant,
    onVisibilityChange: () => {
      requestAnimationFrame(() => fitTerminal());
    },
  });

  // Initialize sidebar with callbacks
  initSidebar({
    onSelect: (id) => selectSession(id),
    onContextMenu: (id, x, y) => showContextMenu(id, x, y),
  });

  // Load sessions and connect to first alive one, or auto-create
  const sessions = await refreshSessions();
  const alive = sessions.find((s) => s.alive === true);
  if (alive) {
    await selectSession(alive.id);
  } else if (sessions.length === 0) {
    // First launch or empty state — create a session automatically
    console.log('[app] no sessions found, auto-creating...');
    await createSessionInstant();
  }

  // Wire up new session button (no modal)
  wireNewSession();

  // Wire up side panel
  wirePanel();

  // Wire keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);

  // Setup resize handles
  setupResize('sidebar-resize', 'sidebar', 'width', 180, 400, SIDEBAR_WIDTH_KEY);
  setupResize('editor-resize', 'editor-panel', 'width', 320, 900, EDITOR_WIDTH_KEY);
  setupResize('panel-resize', 'side-panel', 'width', 300, 520, SIDECAR_WIDTH_KEY);

  restoreSize('sidebar', SIDEBAR_WIDTH_KEY);
  restoreSize('editor-panel', EDITOR_WIDTH_KEY);
  restoreSize('side-panel', SIDECAR_WIDTH_KEY);

  // Dismiss context menu on click elsewhere
  document.addEventListener('click', () => hideContextMenu());

  // Start context auto-detection polling
  contextPollTimer = setInterval(pollContext, CONTEXT_POLL_INTERVAL);
}

// ── Session Selection ───────────────────────────────────

async function selectSession(id) {
  const sessions = getSessions();
  const session = sessions.find((s) => (s.id || s.tmuxName) === id);

  if (!session) return;

  // Get the tmux session name — this is what Rust expects
  const tmuxName = session.tmuxName || session.tmux_name || id;

  // If not alive, offer restore
  if (session.alive === false) {
    try {
      const { invoke } = window.__TAURI__.core;
      await invoke('restore_session', { sessionId: id });
      await refreshSessions();
    } catch (err) {
      console.error('[app] restore_session error:', err);
      return;
    }
  }

  await connectToSession(tmuxName);
  setActiveSession(id);
  refreshShellChrome(session);
  renderSidecar();
}

// ── Window Controls ─────────────────────────────────────

function wireWindowControls() {
  const { getCurrentWindow } = window.__TAURI__.window;
  const win = getCurrentWindow();

  const closeBtn = document.getElementById('win-close');
  const minBtn = document.getElementById('win-minimize');
  const maxBtn = document.getElementById('win-maximize');
  const titlebar = document.getElementById('titlebar');

  if (closeBtn) closeBtn.addEventListener('click', () => win.close());
  if (minBtn) minBtn.addEventListener('click', () => win.minimize());
  if (maxBtn) {
    maxBtn.addEventListener('click', async () => {
      if (await win.isMaximized()) {
        await win.unmaximize();
      } else {
        await win.maximize();
      }
    });
  }

  // Programmatic drag — mousedown on title bar starts window drag
  if (titlebar) {
    titlebar.addEventListener('mousedown', (e) => {
      // Don't drag if clicking on buttons or interactive elements
      if (e.target.closest('#window-controls') || e.target.closest('button')) return;
      win.startDragging();
    });
  }
}

// ── New Session ─────────────────────────────────────────

function wireNewSession() {
  const newBtn = document.getElementById('new-session-btn');
  if (newBtn) newBtn.addEventListener('click', createSessionInstant);
}

/**
 * Instantly create a tmux session and connect — no modal.
 * Starts in PROJECTS_BASE. Auto-detection (priority #3) will
 * update the sidebar label as the user navigates.
 */
async function createSessionInstant() {
  try {
    const { invoke } = window.__TAURI__.core;
    const session = await invoke('create_session', {
      project: '',
      task: '',
      directory: PROJECTS_BASE,
    });

    await refreshSessions();
    await selectSession(session.id);
  } catch (err) {
    console.error('[app] create_session error:', err);
  }
}

// ── Context Menu ────────────────────────────────────────

function showContextMenu(id, x, y) {
  contextMenuSessionId = id;
  const menu = document.getElementById('context-menu');
  if (!menu) return;

  // Position menu within viewport bounds
  menu.style.display = 'block';
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menu.style.left = Math.min(x, maxX) + 'px';
  menu.style.top = Math.min(y, maxY) + 'px';

  // Wire action buttons
  menu.querySelectorAll('button[data-action]').forEach((btn) => {
    // Remove old listeners by cloning
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);

    clone.addEventListener('click', (e) => {
      e.stopPropagation();
      handleContextAction(clone.dataset.action, contextMenuSessionId);
      hideContextMenu();
    });
  });
}

function hideContextMenu() {
  const menu = document.getElementById('context-menu');
  if (menu) menu.style.display = 'none';
  contextMenuSessionId = null;
}

async function handleContextAction(action, id) {
  if (!id) return;
  const { invoke } = window.__TAURI__.core;

  try {
    switch (action) {
      case 'rename': {
        // Find the session element and trigger inline rename
        const el = document.querySelector(`.session-item[data-id="${id}"]`);
        if (el) {
          // Dispatch dblclick to trigger sidebar's inline rename
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        }
        break;
      }
      case 'pin': {
        const sessions = getSessions();
        const target = sessions.find((s) => s.id === id);
        await invoke('update_session_metadata', {
          sessionId: id,
          pinned: target ? !target.pinned : true,
        });
        await refreshSessions();
        break;
      }
      case 'delete':
        await invoke('kill_session', { sessionId: id });
        await refreshSessions();
        // If we deleted the active session, select another
        if (getCurrentSessionId() === id) {
          const remaining = getSessions();
          const next = remaining.find((s) => s.alive === true);
          if (next) await selectSession(next.id);
        }
        break;
    }
  } catch (err) {
    console.error(`[app] context action '${action}' error:`, err);
  }
}

// ── Sidecar ─────────────────────────────────────────────

function wirePanel() {
  document.getElementById('titlebar-command')?.addEventListener('click', focusSidebarSearch);
  document.getElementById('titlebar-ask')?.addEventListener('click', focusSidecarInput);
  document.getElementById('command-bar')?.addEventListener('click', focusSidebarSearch);

  document.getElementById('sidecar-model-select')?.addEventListener('change', (event) => {
    const session = getCurrentSessionEntry();
    if (!session) return;
    const state = ensureSidecarState(session);
    state.model = event.target.value;
    renderSidecar();
  });

  document.querySelectorAll('[data-action]').forEach((element) => {
    if (!element.closest('#sidecar-composer') && !element.closest('.sidecar-actions')) return;
    element.addEventListener('click', (event) => {
      event.preventDefault();
      handleSidecarAction(element.dataset.action);
    });
  });

  const input = document.getElementById('sidecar-input');
  input?.addEventListener('input', (event) => {
    const session = getCurrentSessionEntry();
    if (!session) return;
    const state = ensureSidecarState(session);
    state.draft = event.target.value;
  });

  document.getElementById('sidecar-composer')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitSidecarPrompt();
  });

  renderSidecar();
}

function togglePanel(forceState) {
  const panel = document.getElementById('side-panel');
  const handle = document.getElementById('panel-resize');
  if (!panel) return;

  const isHidden = panel.style.display === 'none';
  const visible = forceState !== undefined ? forceState : isHidden;

  panel.style.display = visible ? 'grid' : 'none';
  if (handle) handle.style.display = visible ? 'block' : 'none';
  requestAnimationFrame(() => fitTerminal());
}

async function loadPanelContent(tabName) {
  const session = getCurrentSessionEntry();
  if (!session) return;

  if (tabName === 'notes') {
    const body = session.notes
      ? session.notes
      : 'No notes yet for this session.';
    appendSidecarMessage(session, {
      role: 'assistant',
      label: 'Notes',
      meta: session.task || session.project || 'Session',
      body,
    });
    return;
  }

  if (!session.specPath) {
    appendSidecarMessage(session, {
      role: 'assistant',
      label: 'Spec',
      meta: 'No spec attached',
      body: 'This session does not have a spec file attached yet.',
    });
    return;
  }

  try {
    const { invoke } = window.__TAURI__.core;
    const file = await invoke('read_file', { path: session.specPath });
    const preview = truncateSidecarText(file.content || '', 1800);
    appendSidecarMessage(session, {
      role: 'assistant',
      label: 'Spec',
      meta: file.path || session.specPath,
      body: preview || 'Spec file is empty.',
    });
  } catch (err) {
    appendSidecarMessage(session, {
      role: 'assistant',
      label: 'Spec',
      meta: 'Read failed',
      body: formatError(err),
    });
  }

  renderSidecar();
}

// ── Keyboard Shortcuts ──────────────────────────────────

function handleKeyboard(e) {
  if (handleSelectionShortcut(e)) {
    return;
  }

  if (isEditableTarget(e.target)) {
    return;
  }

  const meta = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  // Cmd+T — New session
  if (meta && key === 't') {
    e.preventDefault();
    createSessionInstant();
    return;
  }

  // Cmd+Shift+W — Close/delete current session
  if (meta && e.shiftKey && e.key === 'W') {
    e.preventDefault();
    const id = getCurrentSessionId();
    if (id) handleContextAction('delete', id);
    return;
  }

  // Cmd+K — Focus search
  if (meta && key === 'k') {
    e.preventDefault();
    const search = document.getElementById('search');
    if (search) search.focus();
    return;
  }

  // Cmd+P — Pin/unpin current session
  if (meta && key === 'p') {
    e.preventDefault();
    const id = getCurrentSessionId();
    if (id) handleContextAction('pin', id);
    return;
  }

  // Cmd+B — Toggle side panel
  if (meta && key === 'b') {
    e.preventDefault();
    togglePanel();
    return;
  }

  // Cmd+E — Toggle inline editor
  if (meta && key === 'e') {
    e.preventDefault();
    toggleEditor();
    return;
  }

  // Cmd+1 through Cmd+9 — Switch to session by index
  if (meta && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const sessions = getSessions();
    const idx = parseInt(e.key, 10) - 1;
    if (idx < sessions.length) {
      selectSession(sessions[idx].id);
    }
    return;
  }

  // Cmd+[ — Previous session
  if (meta && e.key === '[') {
    e.preventDefault();
    navigateSession(-1);
    return;
  }

  // Cmd+] — Next session
  if (meta && e.key === ']') {
    e.preventDefault();
    navigateSession(1);
    return;
  }

  // Escape — Close zen editor, then context menu, then focus terminal
  if (e.key === 'Escape') {
    if (isZenMode()) {
      e.preventDefault();
      closeZen();
      return;
    }
    hideContextMenu();
    focusTerminal();
    return;
  }
}

function navigateSession(delta) {
  const sessions = getSessions();
  if (!sessions.length) return;

  const currentId = getCurrentSessionId();
  const idx = sessions.findIndex((s) => s.id === currentId);
  const newIdx = Math.max(0, Math.min(sessions.length - 1, idx + delta));

  if (newIdx !== idx) {
    selectSession(sessions[newIdx].id);
  }
}

// ── Resize Handles ──────────────────────────────────────

function setupResize(handleId, targetId, prop, min, max, storageKey = null) {
  const handle = document.getElementById(handleId);
  const target = document.getElementById(targetId);
  if (!handle || !target) return;

  let startX = 0;
  let startSize = 0;
  let dragging = false;

  const isRightPanel = handle.dataset.edge === 'right';

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startSize = target.getBoundingClientRect().width;
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;

    let delta = e.clientX - startX;
    if (isRightPanel) delta = -delta; // Right panel grows leftward

    const newSize = Math.max(min, Math.min(max, startSize + delta));
    target.style[prop] = newSize + 'px';

    if (storageKey) {
      localStorage.setItem(storageKey, newSize);
    }

    // Re-fit terminal
    fitTerminal();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    fitTerminal();
  });
}

function restoreSize(targetId, storageKey) {
  const savedWidth = localStorage.getItem(storageKey);
  if (!savedWidth) return;

  const target = document.getElementById(targetId);
  if (target) {
    target.style.width = savedWidth + 'px';
  }
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  if (isEditorTarget(target)) {
    return true;
  }

  return Boolean(
    target.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], .cm-editor'),
  );
}

function handleSelectionShortcut(event) {
  try {
    const target = event.target;

    if (isEditorTarget(target)) {
      return handleEditorShortcut(event);
    }

    // xterm.js uses an internal <textarea> for input capture.
    // Let the terminal's own clipboard handler manage copy/paste.
    if (target.closest('#terminal-container')) {
      return false;
    }

    if (target instanceof HTMLTextAreaElement || isTextInput(target)) {
      return handleTextInputShortcut(event, target);
    }

    const meta = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    const selectionText = window.getSelection()?.toString() || '';

    if (meta && key === 'c' && selectionText) {
      event.preventDefault();
      void navigator.clipboard.writeText(selectionText);
      return true;
    }
  } catch (err) {
    console.warn('[app] selection shortcut error:', err);
  }

  return false;
}

function isTextInput(target) {
  return target instanceof HTMLInputElement && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(target.type);
}

function handleTextInputShortcut(event, target) {
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  const selected = target.value.slice(start, end);

  if (meta && key === 'a') {
    event.preventDefault();
    target.select();
    return true;
  }

  if (meta && key === 'c' && selected) {
    event.preventDefault();
    void navigator.clipboard.writeText(selected);
    return true;
  }

  if (meta && key === 'x' && selected) {
    event.preventDefault();
    void navigator.clipboard.writeText(selected);
    replaceInputSelection(target, '');
    return true;
  }

  if (meta && key === 'v') {
    event.preventDefault();
    void navigator.clipboard.readText().then((text) => {
      if (text) replaceInputSelection(target, text);
    });
    return true;
  }

  if ((key === 'backspace' || key === 'delete') && start !== end) {
    event.preventDefault();
    replaceInputSelection(target, '');
    return true;
  }

  return false;
}

function replaceInputSelection(target, text) {
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  const before = target.value.slice(0, start);
  const after = target.value.slice(end);
  const nextValue = `${before}${text}${after}`;
  const nextCursor = start + text.length;

  target.value = nextValue;
  target.setSelectionRange(nextCursor, nextCursor);
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── Context Auto-Detection ──────────────────────────────

/**
 * Poll the active tmux session for cwd and pane title.
 * Derive project name from cwd, get git branch, and update
 * the sidebar label + tab bar automatically.
 */
async function pollContext() {
  const sessionName = getCurrentSessionId();
  if (!sessionName) return;

  const { invoke } = window.__TAURI__.core;

  try {
    const pane = await invoke('get_pane_info', { sessionName });
    if (!pane || !pane.currentPath) return;

    // Derive project name from the cwd
    const cwd = pane.currentPath;
    const project = deriveProjectName(cwd);

    // Get git branch for the current directory
    let branch = null;
    try {
      branch = await invoke('get_git_branch', { directory: cwd });
    } catch (_) {}

    // Find the session and check if anything changed
    const sessions = getSessions();
    const session = sessions.find((s) => s.tmuxName === sessionName || s.id === sessionName);
    if (!session) return;

    const projectChanged = project && project !== session.project;
    const dirChanged = cwd !== session.directory;

    // Update session metadata if context changed
    if (projectChanged || dirChanged) {
      const updates = { sessionId: session.id };
      if (projectChanged) {
        updates.project = project;
        // Only auto-set task if it's empty (user hasn't manually named it)
        if (!session.task) updates.task = project;
      }
      if (dirChanged) updates.directory = cwd;
      await invoke('update_session_metadata', updates);
      await refreshSessions();
    }

    // Update tab bar with live info
    const tabEl = document.getElementById('active-tab');
    if (tabEl) {
      const label = project || session.task || 'Untitled';
      tabEl.textContent = branch ? `${label} · ${branch}` : label;
    }
  } catch (_) {
    // Non-critical — context detection is best-effort
  }
}

/**
 * Derive a project name from an absolute path.
 * If inside PROJECTS_BASE, use the first subdirectory name.
 * Otherwise, use the last directory component.
 */
function deriveProjectName(cwd) {
  if (!cwd) return null;

  // If inside Tech Tools, extract the project folder name
  if (cwd.startsWith(PROJECTS_BASE + '/')) {
    const relative = cwd.slice(PROJECTS_BASE.length + 1);
    const projectDir = relative.split('/')[0];
    if (projectDir) return projectDir;
  }

  // If we're exactly at PROJECTS_BASE, no project yet
  if (cwd === PROJECTS_BASE) return null;

  // Outside Tech Tools — use the last path component
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

// ── Helpers ─────────────────────────────────────────────

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

async function handleEditorSave({ path, content }) {
  const { invoke } = window.__TAURI__.core;
  await invoke('write_file', { path, content });
}

async function handleEditorAssistant(request) {
  if (!getCurrentSessionId()) {
    throw new Error('No active terminal session');
  }

  const message = buildAssistantMessage(request);
  await sendTextToTerminal(message);
  focusTerminal();
}

function buildAssistantMessage({ path, prompt, selection }) {
  const parts = [
    `Please edit ${path}.`,
    '',
    `Request: ${prompt}`,
  ];

  if (selection?.hasSelection) {
    parts.push(
      '',
      `Focus on lines ${selection.fromLine}-${selection.toLine}.`,
      'Selected code:',
      wrapCodeBlock(selection.text, selection.language),
    );

    if (selection.truncated) {
      parts.push('', 'The selected excerpt was truncated to fit the terminal prompt.');
    }
  } else if (selection?.cursor) {
    parts.push('', `Focus near line ${selection.cursor.line}, column ${selection.cursor.col}.`);
  }

  parts.push('', 'Make the code change, then explain the result briefly.');
  return parts.join('\n');
}

function wrapCodeBlock(text, language = '') {
  const fence = text.includes('```') ? '````' : '```';
  const languageLabel = language || '';
  return `${fence}${languageLabel}\n${text}\n${fence}`;
}

async function resolveLinkedFilePath(file) {
  if (!file) return null;
  if (file.startsWith('/')) {
    return normalizePath(file);
  }

  const sessionName = getCurrentSessionId();
  let cwd = null;
  const { invoke } = window.__TAURI__.core;

  if (sessionName) {
    try {
      const pane = await invoke('get_pane_info', { sessionName });
      cwd = pane?.currentPath || null;
    } catch (_) {
      // Fall back to stored session metadata below.
    }
  }

  if (!cwd) {
    const sessions = getSessions();
    const session = sessions.find((entry) => entry.tmuxName === sessionName || entry.id === sessionName);
    cwd = session?.directory || PROJECTS_BASE;
  }

  return normalizePath(`${cwd}/${file}`);
}

function normalizePath(path) {
  const absolute = path.startsWith('/');
  const parts = [];

  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(segment);
  }

  const normalized = parts.join('/');
  return absolute ? `/${normalized}` : normalized;
}

function toggleEditorIfHidden() {
  const editor = document.getElementById('editor-panel');
  if (editor && editor.style.display === 'none') {
    toggleEditor();
  }
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Shell Chrome ────────────────────────────────────────

function refreshShellChrome(session) {
  const sessionChip = document.getElementById('terminal-session-chip');
  const modelChip = document.getElementById('terminal-model-chip');
  const countChip = document.getElementById('terminal-session-count');
  const sleepChip = document.getElementById('terminal-sleep-count');

  if (sessionChip) {
    const name = session.task || session.project || 'Untitled';
    const branch = session.branch || '';
    sessionChip.textContent = branch ? `${name} / ${branch}` : name;
  }

  if (modelChip) {
    const state = ensureSidecarState(session);
    modelChip.textContent = `${state.model} active`;
  }

  const sessions = getSessions();
  const sleeping = sessions.filter((s) => !s.alive).length;

  if (countChip) countChip.textContent = `${sessions.length} sessions total`;
  if (sleepChip) sleepChip.textContent = `${sleeping} sleeping`;
}

// ── Sidecar State ───────────────────────────────────────

function getCurrentSessionEntry() {
  const id = getCurrentSessionId();
  if (!id) return null;
  return getSessions().find((s) => s.id === id || s.tmuxName === id) || null;
}

function ensureSidecarState(session) {
  if (!session) return { model: DEFAULT_SIDECAR_MODEL, messages: [], draft: '' };

  let state = sidecarSessions.get(session.id);
  if (!state) {
    state = {
      model: DEFAULT_SIDECAR_MODEL,
      messages: [],
      draft: '',
      contextAction: null,
      pending: false,
    };
    sidecarSessions.set(session.id, state);
  }
  return state;
}

function renderSidecar() {
  const session = getCurrentSessionEntry();
  const state = session ? ensureSidecarState(session) : null;

  const modelSelect = document.getElementById('sidecar-model-select');
  if (modelSelect) {
    modelSelect.value = state ? state.model : DEFAULT_SIDECAR_MODEL;
    modelSelect.disabled = Boolean(state?.pending);
  }

  const input = document.getElementById('sidecar-input');
  if (input) {
    input.value = state ? state.draft : '';
    input.disabled = Boolean(state?.pending);
  }

  const sendButton = document.getElementById('sidecar-send');
  if (sendButton) {
    sendButton.disabled = Boolean(state?.pending);
    sendButton.textContent = state?.pending ? 'Thinking…' : 'Ask Sidecar';
  }

  const log = document.getElementById('sidecar-log');
  if (!log) return;

  if (!state || !state.messages.length) {
    log.innerHTML = `<div style="padding:24px;text-align:center;color:var(--overlay0);font-size:12px;">
      ${session ? 'No sidecar messages yet for this session.' : 'Select a session to begin.'}
    </div>`;
    return;
  }

  log.innerHTML = state.messages.map((msg) => {
    const isUser = msg.role === 'user';
    return `<div class="sidecar-message${isUser ? ' user' : ''}">
      <div class="sidecar-message-head">
        <span>${escapeHtml(msg.label || (isUser ? 'You' : 'Sidecar'))}</span>
        <span>${escapeHtml(msg.meta || '')}</span>
      </div>
      <div class="sidecar-message-body">${escapeHtml(msg.body)}</div>
    </div>`;
  }).join('');

  log.scrollTop = log.scrollHeight;
}

function appendSidecarMessage(session, msg) {
  if (!session) return;
  const state = ensureSidecarState(session);
  state.messages.push(msg);
}

function setSidecarDraft(session, draft, contextAction = null) {
  const input = document.getElementById('sidecar-input');
  const state = ensureSidecarState(session);
  state.draft = draft;
  state.contextAction = contextAction;

  if (input) {
    input.value = draft;
    input.focus();
  }
}

// ── Sidecar Actions ─────────────────────────────────────

function handleSidecarAction(action) {
  const session = getCurrentSessionEntry();
  if (!session) return;

  switch (action) {
    case 'ask-run':
      setSidecarDraft(
        session,
        'Summarize the current terminal run and flag any issues or next steps.',
        'ask-run',
      );
      break;
    case 'review-diff':
      setSidecarDraft(
        session,
        'Review the current git diff and call out bugs, risks, or missing follow-through.',
        'review-diff',
      );
      break;
    case 'open-spec':
      loadPanelContent('spec');
      break;
    case 'zen-edit': {
      const editorPanel = document.getElementById('editor-panel');
      if (getOpenEditorPath() && editorPanel?.style.display === 'none') {
        toggleEditor();
      } else if (!getOpenEditorPath()) {
        appendSidecarMessage(session, {
          role: 'assistant',
          label: 'Sidecar',
          meta: 'zen edit unavailable',
          body: 'Open a file in the editor first, then use Zen Edit File.',
        });
        renderSidecar();
      }
      break;
    }
    case 'focus-file': {
      const openPath = getOpenEditorPath();
      if (openPath) {
        setSidecarDraft(
          session,
          `Give me a second opinion on the current file: ${openPath}`,
          'focus-file',
        );
      } else {
        appendSidecarMessage(session, {
          role: 'assistant',
          label: 'Sidecar',
          meta: 'file context unavailable',
          body: 'There is no active editor file to inspect right now.',
        });
        renderSidecar();
      }
      break;
    }
  }
}

async function submitSidecarPrompt() {
  const session = getCurrentSessionEntry();
  if (!session) return;

  const input = document.getElementById('sidecar-input');
  if (!input) return;

  const prompt = input.value.trim();
  if (!prompt) return;

  const { invoke } = window.__TAURI__.core;
  const state = ensureSidecarState(session);
  const sessionName = session.task || session.project || 'Session';
  const contextAction = state.contextAction || null;
  const currentFile = getOpenEditorPath();

  appendSidecarMessage(session, {
    role: 'user',
    label: 'You',
    meta: `attached to ${sessionName}`,
    body: prompt,
  });

  state.draft = '';
  state.contextAction = null;
  state.pending = true;
  input.value = '';
  renderSidecar();

  try {
    const reply = await invoke('run_sidecar_prompt', {
      model: state.model,
      prompt,
      directory: session.directory || PROJECTS_BASE,
      sessionName: session.tmuxName || session.id,
      contextAction,
      currentFile,
    });

    appendSidecarMessage(session, {
      role: 'assistant',
      label: state.model,
      meta: getSidecarResponseMeta(contextAction),
      body: truncateSidecarText(reply, 12000),
    });
  } catch (err) {
    appendSidecarMessage(session, {
      role: 'assistant',
      label: 'Error',
      meta: 'sidecar failed',
      body: formatError(err),
    });
  } finally {
    state.pending = false;
  }

  renderSidecar();
}

function getSidecarResponseMeta(contextAction) {
  switch (contextAction) {
    case 'ask-run':
      return 'current run';
    case 'review-diff':
      return 'diff review';
    case 'focus-file':
      return 'current file';
    default:
      return 'second opinion';
  }
}

// ── Focus Helpers ───────────────────────────────────────

function focusSidebarSearch() {
  const search = document.getElementById('search');
  if (search) search.focus();
}

function focusSidecarInput() {
  const panel = document.getElementById('side-panel');
  if (panel && panel.style.display === 'none') {
    togglePanel(true);
  }
  const input = document.getElementById('sidecar-input');
  if (input) input.focus();
}

// ── Text Utilities ──────────────────────────────────────

function truncateSidecarText(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n…(truncated)';
}

function formatError(err) {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : String(err);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
