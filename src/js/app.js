/**
 * Amaru Forge — Main app coordinator.
 *
 * Wires together terminal, sidebar, modals, panels, keyboard shortcuts,
 * and resize handles. Entry point for the frontend.
 */

import { initTerminal, connectToSession, focusTerminal, fitTerminal, getCurrentSessionId } from './terminal.js';
import { initSidebar, refreshSessions, setActiveSession, getSessions } from './sidebar.js';

// ── Constants ───────────────────────────────────────────

const SIDEBAR_WIDTH_KEY = 'amaru-forge:sidebar-width';
const PROJECTS_BASE = '/Users/owner/Desktop/Tech Tools';
const GIT_POLL_INTERVAL = 5000;

// ── State ───────────────────────────────────────────────

let contextMenuSessionId = null;
let gitPollTimer = null;

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
  // Initialize terminal
  initTerminal();

  // Initialize sidebar with callbacks
  initSidebar({
    onSelect: (id) => selectSession(id),
    onContextMenu: (id, x, y) => showContextMenu(id, x, y),
  });

  // Load sessions and connect to first alive one
  const sessions = await refreshSessions();
  const alive = sessions.find((s) => s.status === 'alive' || s.status === 'connected');
  if (alive) {
    await selectSession(alive.id);
  }

  // Wire up modal
  wireModal();

  // Wire up side panel
  wirePanel();

  // Wire keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);

  // Setup resize handles
  setupResize('sidebar-resize', 'sidebar', 'width', 180, 400);
  setupResize('panel-resize', 'side-panel', 'width', 220, 500);

  // Restore sidebar width
  const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (savedWidth) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.style.width = savedWidth + 'px';
  }

  // Dismiss context menu on click elsewhere
  document.addEventListener('click', () => hideContextMenu());

  // Start git status polling
  gitPollTimer = setInterval(pollGitStatus, GIT_POLL_INTERVAL);
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
}

// ── Modal ───────────────────────────────────────────────

function wireModal() {
  const newBtn = document.getElementById('new-session-btn');
  const overlay = document.getElementById('modal-overlay');
  const cancelBtn = document.getElementById('modal-cancel');
  const createBtn = document.getElementById('modal-create');

  if (newBtn) newBtn.addEventListener('click', openNewSessionModal);

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (overlay) overlay.style.display = 'none';
    });
  }

  if (createBtn) {
    createBtn.addEventListener('click', handleCreateSession);
  }

  // Close modal on overlay click (but not on modal body click)
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  }
}

async function openNewSessionModal() {
  const overlay = document.getElementById('modal-overlay');
  const projectInput = document.getElementById('modal-project');
  const taskInput = document.getElementById('modal-task');
  const datalist = document.getElementById('project-list');

  // Populate project list as clickable buttons
  if (datalist) {
    try {
      const { invoke } = window.__TAURI__.core;
      const dirs = await invoke('list_project_dirs');
      // Replace datalist with a visual grid of project buttons
      datalist.innerHTML = dirs.map((d) =>
        `<button type="button" class="project-option" data-project="${escapeAttr(d)}">${escapeAttr(d)}</button>`
      ).join('');
      // Click to select
      datalist.querySelectorAll('.project-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          // Deselect all
          datalist.querySelectorAll('.project-option').forEach((b) => b.classList.remove('selected'));
          // Select this one
          btn.classList.add('selected');
          if (projectInput) projectInput.value = btn.dataset.project;
          // Auto-focus the task input
          if (taskInput) taskInput.focus();
        });
      });
    } catch (err) {
      console.error('[app] list_project_dirs error:', err);
      datalist.innerHTML = '';
    }
  }

  // Reset inputs
  if (projectInput) projectInput.value = '';
  if (taskInput) taskInput.value = '';

  // Show modal
  if (overlay) overlay.style.display = 'flex';

  // Focus project input
  if (projectInput) {
    requestAnimationFrame(() => projectInput.focus());
  }
}

async function handleCreateSession() {
  const projectInput = document.getElementById('modal-project');
  const taskInput = document.getElementById('modal-task');
  const overlay = document.getElementById('modal-overlay');

  const project = projectInput ? projectInput.value.trim() : '';
  const task = taskInput ? taskInput.value.trim() : '';

  if (!task && !project) {
    if (taskInput) taskInput.focus();
    return;
  }

  // Build directory path — if project selected, use its subdir; otherwise Tech Tools root
  const directory = project ? `${PROJECTS_BASE}/${project}` : PROJECTS_BASE;

  try {
    const { invoke } = window.__TAURI__.core;
    const session = await invoke('create_session', {
      project,
      task: task || null,
      directory,
    });

    // Hide modal
    if (overlay) overlay.style.display = 'none';

    // Refresh and connect
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
      case 'pin':
        await invoke('toggle_pin', { sessionId: id });
        await refreshSessions();
        break;
      case 'delete':
        await invoke('delete_session', { sessionId: id });
        await refreshSessions();
        // If we deleted the active session, select another
        if (getCurrentSessionId() === id) {
          const sessions = getSessions();
          const next = sessions.find((s) => s.status === 'alive');
          if (next) await selectSession(next.id);
        }
        break;
    }
  } catch (err) {
    console.error(`[app] context action '${action}' error:`, err);
  }
}

// ── Side Panel ──────────────────────────────────────────

function wirePanel() {
  const closeBtn = document.getElementById('panel-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => togglePanel(false));
  }

  // Panel tab switching
  document.querySelectorAll('.panel-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.panel-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      loadPanelContent(tab.dataset.tab);
    });
  });
}

function togglePanel(forceState) {
  const panel = document.getElementById('side-panel');
  const handle = document.getElementById('panel-resize');
  if (!panel) return;

  const visible = forceState !== undefined ? forceState : panel.style.display === 'none';

  panel.style.display = visible ? 'flex' : 'none';
  if (handle) handle.style.display = visible ? 'block' : 'none';

  // Re-fit terminal after layout change
  requestAnimationFrame(() => fitTerminal());
}

async function loadPanelContent(tabName) {
  const body = document.getElementById('panel-body');
  const title = document.getElementById('panel-title');
  if (!body) return;

  if (title) title.textContent = tabName === 'spec' ? 'Spec' : 'Notes';

  try {
    const { invoke } = window.__TAURI__.core;
    const sessionId = getCurrentSessionId();
    if (!sessionId) {
      body.innerHTML = '<p>No active session</p>';
      return;
    }
    const content = await invoke('get_panel_content', { sessionId, tab: tabName });
    body.innerHTML = content || '<p>No content</p>';
  } catch (err) {
    body.innerHTML = '<p style="color:var(--overlay0)">Panel content unavailable</p>';
  }
}

// ── Keyboard Shortcuts ──────────────────────────────────

function handleKeyboard(e) {
  const meta = e.metaKey || e.ctrlKey;

  // Cmd+T — New session
  if (meta && e.key === 't') {
    e.preventDefault();
    openNewSessionModal();
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
  if (meta && e.key === 'k') {
    e.preventDefault();
    const search = document.getElementById('search');
    if (search) search.focus();
    return;
  }

  // Cmd+P — Pin/unpin current session
  if (meta && e.key === 'p') {
    e.preventDefault();
    const id = getCurrentSessionId();
    if (id) handleContextAction('pin', id);
    return;
  }

  // Cmd+B — Toggle side panel
  if (meta && e.key === 'b') {
    e.preventDefault();
    togglePanel();
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

  // Escape — Close modal or context menu, then focus terminal
  if (e.key === 'Escape') {
    const overlay = document.getElementById('modal-overlay');
    if (overlay && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
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

function setupResize(handleId, targetId, prop, min, max) {
  const handle = document.getElementById(handleId);
  const target = document.getElementById(targetId);
  if (!handle || !target) return;

  let startX = 0;
  let startSize = 0;
  let dragging = false;

  // Determine if this is a left-side or right-side resize
  const isRightPanel = targetId === 'side-panel';

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

    // Save sidebar width
    if (targetId === 'sidebar') {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, newSize);
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

// ── Git Polling ─────────────────────────────────────────

async function pollGitStatus() {
  const sessionId = getCurrentSessionId();
  if (!sessionId) return;

  try {
    const { invoke } = window.__TAURI__.core;
    const status = await invoke('get_git_status', { sessionId });
    // Git status can be used to update panel or tab bar in future
    // For now, just keep it polling so Rust-side state stays fresh
  } catch (_) {
    // Non-critical — swallow silently but log in debug
  }
}

// ── Helpers ─────────────────────────────────────────────

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
