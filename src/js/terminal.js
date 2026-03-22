/**
 * Terminal manager — creates, connects, and manages xterm.js instances.
 *
 * Uses Tauri v2 invoke pattern via window.__TAURI__.core.
 * PTY data flows: xterm onData → invoke('write_to_pty') → Rust PTY
 * PTY output flows: Rust → Channel callback → xterm.write()
 */

import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { terminalOptions } from './theme.js';

let terminal = null;
let fitAddon = null;
let currentSessionId = null;
let resizeObserver = null;
let channelCleanup = null;

/**
 * Initialize the xterm.js terminal instance.
 * Creates the terminal, loads addons, opens into #terminal-container,
 * fits to container, and attaches input + resize handlers.
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

  // Fit after a frame to ensure container has dimensions
  requestAnimationFrame(() => {
    fitAddon.fit();
  });

  // Forward user input to the Rust PTY
  terminal.onData((data) => {
    if (!currentSessionId) return;
    const { invoke } = window.__TAURI__.core;
    invoke('write_to_pty', { sessionId: currentSessionId, data }).catch((err) => {
      console.error('[terminal] write_to_pty error:', err);
    });
  });

  // Re-fit on container resize
  resizeObserver = new ResizeObserver(() => {
    if (fitAddon) {
      fitAddon.fit();
      sendResize();
    }
  });
  resizeObserver.observe(container);
}

/**
 * Connect the terminal to a tmux session by ID.
 * Disconnects current session, clears the terminal, and establishes
 * a new data channel from Rust → xterm.
 */
export async function connectToSession(sessionId) {
  const { invoke } = window.__TAURI__.core;

  // Clean up previous channel
  if (channelCleanup) {
    channelCleanup();
    channelCleanup = null;
  }

  currentSessionId = sessionId;
  terminal.clear();
  terminal.reset();

  try {
    // Tauri v2 Channel pattern: create a callback ID that Rust pushes data through.
    // The invoke call passes an `onData` callback; Rust calls it with PTY output.
    await invoke('connect_session', {
      sessionId,
      onData: (output) => {
        if (terminal && typeof output === 'string') {
          terminal.write(output);
        } else if (terminal && output && output.data) {
          terminal.write(output.data);
        }
      },
    });
  } catch (err) {
    console.error('[terminal] connect_session error:', err);
    terminal.writeln(`\r\n\x1b[31mFailed to connect to session: ${err}\x1b[0m`);
    return;
  }

  // Fit and focus after connection
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
  if (!currentSessionId || !terminal) return;
  const { invoke } = window.__TAURI__.core;
  invoke('resize_pty', {
    sessionId: currentSessionId,
    cols: terminal.cols,
    rows: terminal.rows,
  }).catch((err) => {
    // Resize errors are non-critical; log but don't surface
    console.warn('[terminal] resize_pty:', err);
  });
}

/**
 * Focus the terminal element.
 */
export function focusTerminal() {
  if (terminal) terminal.focus();
}

/**
 * Get the underlying Terminal instance (for advanced callers).
 */
export function getTerminal() {
  return terminal;
}

/**
 * Fit the terminal to its container. Useful after layout changes.
 */
export function fitTerminal() {
  if (fitAddon) fitAddon.fit();
}

/**
 * Get the currently connected session ID.
 */
export function getCurrentSessionId() {
  return currentSessionId;
}
