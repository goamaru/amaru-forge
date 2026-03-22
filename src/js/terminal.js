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
    // Rust expects Vec<u8>, so convert string to byte array
    const encoder = new TextEncoder();
    const bytes = Array.from(encoder.encode(data));
    invoke('write_to_pty', { sessionName: currentSessionName, data: bytes }).catch((err) => {
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
