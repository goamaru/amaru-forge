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
let fileLinkHandler = null;

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

  // Register clickable file:line:col links for compiler errors
  terminal.registerLinkProvider(new FileLinkProvider(terminal));

  requestAnimationFrame(() => {
    fitAddon.fit();
  });

  // Forward user input to the Rust PTY
  terminal.onData((data) => {
    sendTextToTerminal(data).catch((err) => {
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
          sendTextToTerminal(text).catch(() => {});
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

export function setFileLinkHandler(handler) {
  fileLinkHandler = handler;
}

export async function sendTextToTerminal(text) {
  if (!currentSessionName) {
    throw new Error('No active terminal session');
  }

  const { invoke } = window.__TAURI__.core;
  const encoder = new TextEncoder();
  const bytes = Array.from(encoder.encode(text));
  await invoke('write_to_pty', { sessionName: currentSessionName, data: bytes });
}

// ── File Link Provider (click errors to open in editor) ──

/**
 * Detects file:line:col patterns in terminal output and makes them clickable.
 * Matches common formats from TypeScript, Rust, Python, Go, Node.js, etc.
 */
class FileLinkProvider {
  constructor(terminal) {
    this._terminal = terminal;
  }

  provideLinks(y, callback) {
    const line = this._terminal.buffer.active.getLine(y - 1);
    if (!line) return callback(undefined);

    const text = line.translateToString(true);
    const links = [];

    // Patterns to match (ordered by specificity):
    // 1. /absolute/path/file.ext:line:col
    // 2. ./relative/file.ext:line:col
    // 3. file.ext:line:col (bare filename with extension)
    // 4. --> src/file.rs:10:5 (Rust compiler)
    // 5. at /path/file.js:10:5 (Node.js stack trace)
    // 6. File "file.py", line 10 (Python traceback)
    const patterns = [
      // file.ext:line:col or file.ext:line — absolute, relative, or bare
      /(?:^|[\s'"(])((\/[\w./-]+|\.\/[\w./-]+|[\w./-]+\.\w+):(\d+)(?::(\d+))?)/g,
      // Rust: --> src/file.rs:10:5
      /-->\s+([\w./-]+\.\w+):(\d+):(\d+)/g,
      // Node/JS: at /path/file.js:10:5 or at Object.<anonymous> (/path/file.js:10:5)
      /\(?(\/[\w./-]+\.\w+):(\d+):(\d+)\)?/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        // Extract file, line, col depending on pattern
        let file, lineNum, colNum, matchStart, matchEnd;

        if (pattern.source.startsWith('-->')) {
          file = match[1];
          lineNum = parseInt(match[2], 10);
          colNum = parseInt(match[3], 10);
          matchStart = match.index + match[0].indexOf(match[1]);
          matchEnd = matchStart + `${file}:${lineNum}:${colNum}`.length;
        } else if (match[3] && !match[4]) {
          // Pattern with 3 groups: file, line, col
          file = match[1];
          lineNum = parseInt(match[2], 10);
          colNum = parseInt(match[3], 10);
          matchStart = match.index + match[0].indexOf(match[1]);
          matchEnd = matchStart + `${file}:${lineNum}:${colNum}`.length;
        } else {
          // General pattern: full match, file, line, col?
          file = match[2] || match[1];
          lineNum = parseInt(match[3] || match[2], 10);
          colNum = match[4] ? parseInt(match[4], 10) : undefined;
          // Find the file:line:col portion in the match
          const fileLineCol = colNum ? `${file}:${lineNum}:${colNum}` : `${file}:${lineNum}`;
          matchStart = text.indexOf(fileLineCol, match.index);
          if (matchStart === -1) matchStart = match.index;
          matchEnd = matchStart + fileLineCol.length;
        }

        // Skip if file doesn't look like a real file (no extension or too short)
        if (!file || !file.includes('.') || file.length < 3) continue;
        // Skip URLs
        if (file.startsWith('http')) continue;

        links.push({
          range: {
            start: { x: matchStart + 1, y },
            end: { x: matchEnd + 1, y },
          },
          text: `${file}:${lineNum}${colNum ? ':' + colNum : ''}`,
          activate: () => {
            if (!fileLinkHandler) return;

            Promise.resolve(
              fileLinkHandler({
                file,
                line: lineNum,
                col: colNum || null,
              }),
            ).catch((err) => {
              console.error('[terminal] file link handler error:', err);
            });
          },
        });
      }
    }

    callback(links.length > 0 ? links : undefined);
  }
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
    sendTextToTerminal(text).catch((err) => {
      console.error('[terminal] drag-drop write error:', err);
    });
  });
}
