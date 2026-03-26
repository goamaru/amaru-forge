/**
 * Sidebar — session list rendering, search, inline rename.
 *
 * Groups sessions into Pinned / Today / Older buckets.
 * Wires click, right-click, and double-click interactions.
 */

let sessions = [];
let activeSessionId = null;
let searchQuery = '';
let callbacks = { onSelect: null, onContextMenu: null };

/**
 * Initialize sidebar event wiring.
 * @param {{ onSelect: (id: string) => void, onContextMenu: (id: string, x: number, y: number) => void }} cbs
 */
export function initSidebar(cbs) {
  callbacks = cbs;

  const searchInput = document.getElementById('search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      render();
    });
  }
}

/**
 * Fetch sessions from Rust and re-render the list.
 */
export async function refreshSessions() {
  try {
    const { invoke } = window.__TAURI__.core;
    sessions = await invoke('list_sessions');
  } catch (err) {
    console.error('[sidebar] list_sessions error:', err);
    sessions = [];
  }
  render();
  return sessions;
}

/**
 * Mark a session as active and update the sidebar + tab bar.
 */
export function setActiveSession(id) {
  activeSessionId = id;
  render();
  updateTabBar(id);
}

/**
 * Get the current sessions array.
 */
export function getSessions() {
  return sessions;
}

// ── Rendering ───────────────────────────────────────────

function render() {
  const list = document.getElementById('session-list');
  if (!list) return;

  const filtered = sessions.filter(matchesSearch);

  // Group: pinned, today, older
  const pinned = filtered.filter((s) => s.pinned);
  const today = filtered.filter((s) => !s.pinned && isToday(s.createdAt));
  const older = filtered.filter((s) => !s.pinned && !isToday(s.createdAt));

  let html = '';

  if (pinned.length) {
    html += '<div class="session-group-label">Pinned</div>';
    html += pinned.map(renderItem).join('');
  }
  if (today.length) {
    html += '<div class="session-group-label">Today</div>';
    html += today.map(renderItem).join('');
  }
  if (older.length) {
    html += '<div class="session-group-label">Older</div>';
    html += older.map(renderItem).join('');
  }

  if (!filtered.length) {
    html = `<div style="padding:16px;text-align:center;color:var(--overlay0);font-size:12px;">
      ${searchQuery ? 'No matching sessions' : 'No sessions yet'}
    </div>`;
  }

  list.innerHTML = html;

  // Attach event listeners
  list.querySelectorAll('.session-item').forEach((el) => {
    const id = el.dataset.id;

    el.addEventListener('click', () => {
      if (callbacks.onSelect) callbacks.onSelect(id);
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (callbacks.onContextMenu) callbacks.onContextMenu(id, e.clientX, e.clientY);
    });

    el.addEventListener('dblclick', () => {
      startInlineRename(el, id);
    });
  });
}

function renderItem(s) {
  const isActive = s.id === activeSessionId;
  const isDisconnected = !s.alive;
  const classes = [
    'session-item',
    isActive ? 'active' : '',
    isDisconnected ? 'disconnected' : '',
  ].filter(Boolean).join(' ');

  const name = titleCase(s.task || s.project || 'Untitled');
  const branch = s.branch || '—';
  const meta = s.directory || s.project || '';
  const state = isDisconnected
    ? 'sleeping · reconnect available'
    : isActive
      ? 'live · single sidecar attached'
      : 'live';
  const restoreIcon = isDisconnected ? '<span class="restore-icon" title="Reconnect">&#x21bb;</span>' : '';

  return `<div class="${classes}" data-id="${s.id}">
    <div class="session-top">
      <div class="session-name">${escapeHtml(name)}</div>
      <div class="session-branch">${escapeHtml(branch)}</div>
    </div>
    <div class="session-meta">${escapeHtml(meta)}</div>
    <div class="session-state">${escapeHtml(state)}</div>
    ${restoreIcon}
  </div>`;
}

// ── Inline Rename ───────────────────────────────────────

function startInlineRename(el, id) {
  const nameEl = el.querySelector('.session-name');
  if (!nameEl) return;

  const session = sessions.find((s) => s.id === id);
  if (!session) return;

  const currentName = titleCase(session.task || session.project || 'Untitled');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-rename';
  input.value = currentName;

  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    if (newName && newName !== currentName) {
      try {
        const { invoke } = window.__TAURI__.core;
        await invoke('update_session_metadata', { sessionId: id, task: newName });
      } catch (err) {
        console.error('[sidebar] rename_session error:', err);
      }
    }
    await refreshSessions();
  };

  const cancel = () => {
    refreshSessions();
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur(); // triggers save via blur handler
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.removeEventListener('blur', save);
      cancel();
    }
  });
}

// ── Tab Bar ─────────────────────────────────────────────

function updateTabBar(id) {
  const tabEl = document.getElementById('active-tab');
  if (!tabEl) return;

  const session = sessions.find((s) => s.id === id);
  if (session) {
    const name = titleCase(session.task || session.project || 'Untitled');
    tabEl.textContent = `Ask Claude, switch session, open spec, review diff, zen edit current file · ${name}`;
  } else {
    tabEl.textContent = 'Ask Claude, switch session, open spec, review diff, zen edit current file';
  }
}

// ── Helpers ─────────────────────────────────────────────

function titleCase(str) {
  return str
    .split(/[\s_-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function isToday(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function matchesSearch(s) {
  if (!searchQuery) return true;
  const haystack = [s.name, s.task, s.project, s.directory]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(searchQuery);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
