/**
 * Terminal manager — creates, connects, and manages xterm.js instances.
 *
 * Uses Tauri v2 invoke + Channel pattern via window.__TAURI__.core.
 * PTY data flows: xterm onData → invoke('write_to_pty') → Rust PTY
 * PTY output flows: Rust → Channel → xterm.write()
 */

import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { terminalOptions } from './theme.js';

let terminal = null;
let fitAddon = null;
let currentSessionName = null;
let resizeObserver = null;
let activeChannelId = 0; // increments on each connect to invalidate old channels

/**
 * Initialize the xterm.js terminal instance.
 */
export function initTerminal() {
  const container = document.getElementById('terminal-container');
  if (!container) {
    console.error('[terminal] #terminal-container not found');
    return;
  }

  terminal = new Terminal(terminalOptions);
  fitAddon = new FitAddon();

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  terminal.open(container);

  requestAnimationFrame(() => {
    fitAddon.fit();
  });

  // Forward user input to the Rust PTY
  terminal.onData((data) => {
    if (!currentSessionName) return;
    const { invoke } = window.__TAURI__.core;
    const encoder = new TextEncoder();
    const bytes = Array.from(encoder.encode(data));
    invoke('write_to_pty', { sessionName: currentSessionName, data: bytes }).catch((err) => {
      console.error('[terminal] write_to_pty error:', err);
    });
  });

  // Clipboard: Cmd+C copies selection (or sends SIGINT if nothing selected)
  // Cmd+V pastes from clipboard into PTY
  terminal.attachCustomKeyEventHandler((e) => {
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key === 'c' && e.type === 'keydown') {
      const selection = terminal.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {
          // Fallback: use execCommand
          const ta = document.createElement('textarea');
          ta.value = selection;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        });
        terminal.clearSelection();
        return false; // prevent sending to PTY
      }
      // No selection — let Ctrl+C go through as SIGINT
      return true;
    }

    if (meta && e.key === 'v' && e.type === 'keydown') {
      navigator.clipboard.readText().then((text) => {
        if (text && currentSessionName) {
          const { invoke } = window.__TAURI__.core;
          const encoder = new TextEncoder();
          const bytes = Array.from(encoder.encode(text));
          invoke('write_to_pty', { sessionName: currentSessionName, data: bytes }).catch(() => {});
        }
      }).catch(() => {
        // Fallback: use paste event
        document.execCommand('paste');
      });
      return false; // prevent default
    }

    return true; // all other keys pass through
  });

  // Re-fit on container resize
  resizeObserver = new ResizeObserver(() => {
    if (fitAddon) {
      fitAddon.fit();
      sendResize();
    }
  });
  resizeObserver.observe(container);

  // Drag-and-drop — files/folders/images dropped on terminal paste their paths
  setupDragDrop(container);
}

/**
 * Connect the terminal to a tmux session.
 * @param {string} sessionName — the tmux session name (e.g., "forge-1711051200-a3f7")
 */
export async function connectToSession(sessionName) {
  const { invoke, Channel } = window.__TAURI__.core;

  // Disconnect previous
  if (currentSessionName) {
    await invoke('disconnect_session', { sessionName: currentSessionName }).catch(() => {});
  }

  currentSessionName = sessionName;
  terminal.clear();
  terminal.reset();

  try {
    // Tauri v2 Channel: create a Channel that receives data from Rust
    // Increment channel ID to invalidate any previous channel's callback
    const myChannelId = ++activeChannelId;
    const channel = new Channel();
    channel.onmessage = (data) => {
      // Only write if this is still the active channel
      if (!terminal || myChannelId !== activeChannelId) return;
      if (data instanceof Array || data instanceof Uint8Array) {
        terminal.write(new Uint8Array(data));
      } else if (typeof data === 'string') {
        terminal.write(data);
      }
    };

    await invoke('connect_session', {
      sessionName,
      channel,
    });
  } catch (err) {
    console.error('[terminal] connect_session error:', err);
    terminal.writeln(`\r\n\x1b[31mFailed to connect: ${err}\x1b[0m`);
    return;
  }

  requestAnimationFrame(() => {
    if (fitAddon) fitAddon.fit();
    terminal.focus();
    sendResize();
  });
}

/**
 * Send current terminal dimensions to the Rust PTY.
 */
function sendResize() {
  if (!currentSessionName || !terminal) return;
  const { invoke } = window.__TAURI__.core;
  invoke('resize_pty', {
    sessionName: currentSessionName,
    cols: terminal.cols,
    rows: terminal.rows,
  }).catch((err) => {
    console.warn('[terminal] resize_pty:', err);
  });
}

export function focusTerminal() {
  if (terminal) terminal.focus();
}

export function getTerminal() {
  return terminal;
}

export function fitTerminal() {
  if (fitAddon) fitAddon.fit();
}

export function getCurrentSessionId() {
  return currentSessionName;
}

// ── Drag & Drop ──────────────────────────────────────────

function setupDragDrop(container) {
  const { listen } = window.__TAURI__.event;

  // Rust emits these custom events from on_window_event
  listen('forge://drag-enter', () => {
    container.classList.add('drag-over');
  });

  listen('forge://drag-leave', () => {
    container.classList.remove('drag-over');
  });

  listen('forge://drag-drop', (event) => {
    container.classList.remove('drag-over');
    const paths = event.payload;
    if (!paths || !paths.length || !currentSessionName) return;

    // Quote paths that contain spaces, join with spaces
    const quoted = paths.map((p) => (p.includes(' ') ? `"${p}"` : p));
    const text = quoted.join(' ');

    // Write to the PTY as if the user typed it
    const { invoke } = window.__TAURI__.core;
    const encoder = new TextEncoder();
    const bytes = Array.from(encoder.encode(text));
    invoke('write_to_pty', { sessionName: currentSessionName, data: bytes }).catch((err) => {
      console.error('[terminal] drag-drop write error:', err);
    });
  });
}
