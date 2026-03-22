import { EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { rust } from '@codemirror/lang-rust';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { toml as tomlMode } from '@codemirror/legacy-modes/mode/toml';

const toml = StreamLanguage.define(tomlMode);
const MAX_SELECTION_CHARS = 4000;

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'var(--base)',
      color: 'var(--text)',
      fontFamily: 'var(--font-mono)',
      fontSize: '13px',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.55',
    },
    '.cm-content': {
      caretColor: 'var(--blue)',
      padding: '16px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--blue)',
    },
    '.cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(137, 180, 250, 0.22)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--mantle)',
      color: 'var(--overlay0)',
      borderRight: '1px solid var(--surface0)',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(49, 50, 68, 0.6)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(49, 50, 68, 0.85)',
      color: 'var(--subtext0)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--mantle)',
      border: '1px solid var(--surface0)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--mantle)',
      color: 'var(--text)',
    },
  },
  { dark: true },
);

const callbacks = {
  onSave: null,
  onAskAssistant: null,
  onVisibilityChange: null,
};

const editorState = {
  path: null,
  displayPath: '',
  visible: false,
  dirty: false,
  lastSavedText: '',
  statusText: '',
  statusTone: 'info',
};

let editorView = null;

export function initEditor(nextCallbacks = {}) {
  Object.assign(callbacks, nextCallbacks);
  ensureEditorView();
  wireUi();
  syncVisibility();
  updateHeader();
  updateAssistantState();
}

export function canOpenEditorPath(path) {
  if (!editorState.dirty || !editorState.path || editorState.path === path) {
    return true;
  }

  return window.confirm(
    `Discard unsaved changes in ${editorState.displayPath || editorState.path} and open ${path}?`,
  );
}

export function openEditorFile({ path, displayPath, content, line = 1, col = 1 }) {
  ensureEditorView();

  editorState.path = path;
  editorState.displayPath = displayPath || path;
  editorState.visible = true;
  editorState.dirty = false;
  editorState.lastSavedText = content;
  editorState.statusText = '';
  editorState.statusTone = 'info';

  editorView.setState(buildEditorState(content, path));
  revealEditorLocation(line, col);
  syncVisibility();
  updateHeader();
  updateAssistantState();

  requestAnimationFrame(() => editorView.focus());
}

export function revealEditorLocation(line = 1, col = 1) {
  if (!editorView || !editorState.path) return;

  const position = resolvePosition(editorView.state, line, col);
  editorView.dispatch({
    selection: { anchor: position },
    scrollIntoView: true,
  });
  updateHeader();
  updateAssistantState();
}

export function getOpenEditorPath() {
  return editorState.path;
}

export function toggleEditor() {
  if (!editorState.path) {
    return false;
  }

  editorState.visible = !editorState.visible;
  syncVisibility();
  if (editorState.visible && editorView) {
    requestAnimationFrame(() => editorView.focus());
  }
  return editorState.visible;
}

export function closeEditor() {
  if (!editorState.path) return;
  editorState.visible = false;
  syncVisibility();
}

async function saveEditor() {
  if (!editorView || !editorState.path || !callbacks.onSave) {
    return false;
  }

  const content = editorView.state.doc.toString();
  setStatus('Saving...', 'info');
  updateHeader();

  try {
    await callbacks.onSave({ path: editorState.path, content });
    editorState.lastSavedText = content;
    editorState.dirty = false;
    setStatus('Saved', 'success');
    updateHeader();
    updateAssistantState();
    return true;
  } catch (err) {
    setStatus(formatError(err), 'error');
    updateHeader();
    return false;
  }
}

function ensureEditorView() {
  if (editorView) return;

  const mount = document.getElementById('editor-view');
  if (!mount) return;

  editorView = new EditorView({
    state: buildEditorState('', null),
    parent: mount,
  });
}

function buildEditorState(content, path) {
  return EditorState.create({
    doc: content,
    extensions: [
      lineNumbers(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            void saveEditor();
            return true;
          },
        },
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      editorTheme,
      getLanguageExtension(path),
      EditorView.updateListener.of(handleEditorUpdate),
    ],
  });
}

function handleEditorUpdate(update) {
  if (update.docChanged) {
    editorState.dirty = update.state.doc.toString() !== editorState.lastSavedText;
    if (editorState.dirty && editorState.statusTone === 'success') {
      editorState.statusText = '';
      editorState.statusTone = 'info';
    }
  }

  if (update.docChanged || update.selectionSet) {
    updateHeader();
    updateAssistantState();
  }
}

function wireUi() {
  const closeBtn = document.getElementById('editor-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => closeEditor());
  }

  const saveBtn = document.getElementById('editor-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      void saveEditor();
    });
  }

  const form = document.getElementById('editor-assistant');
  const input = document.getElementById('editor-assistant-input');
  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      if (!callbacks.onAskAssistant || !editorState.path || !input) {
        return;
      }

      const prompt = input.value.trim();
      if (!prompt) return;

      try {
        await callbacks.onAskAssistant({
          path: editorState.path,
          displayPath: editorState.displayPath || editorState.path,
          prompt,
          selection: getSelectionContext(),
        });
        input.value = '';
        setStatus('Inserted into terminal', 'success');
        updateHeader();
      } catch (err) {
        setStatus(formatError(err), 'error');
        updateHeader();
      }
    });
  }

  if (input) {
    input.addEventListener('keydown', (event) => {
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (meta && key === 'enter') {
        event.preventDefault();
        form?.requestSubmit();
        return;
      }

      if (meta && key === 's') {
        event.preventDefault();
        void saveEditor();
      }
    });
  }
}

function syncVisibility() {
  const panel = document.getElementById('editor-panel');
  const handle = document.getElementById('editor-resize');
  if (!panel || !handle) return;

  const visible = Boolean(editorState.visible && editorState.path);
  panel.style.display = visible ? 'flex' : 'none';
  handle.style.display = visible ? 'block' : 'none';

  if (callbacks.onVisibilityChange) {
    callbacks.onVisibilityChange(visible);
  }
}

function updateHeader() {
  const pathEl = document.getElementById('editor-path');
  const locationEl = document.getElementById('editor-location');
  const statusEl = document.getElementById('editor-status');
  const saveBtn = document.getElementById('editor-save');

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

  if (statusEl) {
    statusEl.textContent = editorState.statusText;
    statusEl.dataset.tone = editorState.statusTone;
  }

  if (saveBtn) {
    saveBtn.disabled = !editorState.path;
  }
}

function updateAssistantState() {
  const input = document.getElementById('editor-assistant-input');
  const button = document.getElementById('editor-assistant-send');
  const context = document.getElementById('editor-assistant-context');
  const enabled = Boolean(editorState.path);

  if (input) input.disabled = !enabled;
  if (button) button.disabled = !enabled;

  if (!context) return;
  if (!enabled) {
    context.textContent = 'Open a file to ask for an edit.';
    return;
  }

  const selection = getSelectionContext();
  context.textContent = selection.hasSelection
    ? `Selection: lines ${selection.fromLine}-${selection.toLine}`
    : `Cursor: Ln ${selection.cursor.line}, Col ${selection.cursor.col}`;
}

function getCursorLocation() {
  if (!editorView || !editorState.path) {
    return { line: 1, col: 1 };
  }

  const head = editorView.state.selection.main.head;
  const line = editorView.state.doc.lineAt(head);
  return {
    line: line.number,
    col: head - line.from + 1,
  };
}

function getSelectionContext() {
  if (!editorView || !editorState.path) {
    return {
      hasSelection: false,
      text: '',
      fromLine: 1,
      toLine: 1,
      truncated: false,
      cursor: { line: 1, col: 1 },
      language: fenceLanguageForPath(editorState.path),
    };
  }

  const { from, to } = editorView.state.selection.main;
  const fromLine = editorView.state.doc.lineAt(from).number;
  const toLine = editorView.state.doc.lineAt(to).number;
  let text = editorView.state.sliceDoc(from, to);
  let truncated = false;

  if (text.length > MAX_SELECTION_CHARS) {
    text = text.slice(0, MAX_SELECTION_CHARS);
    truncated = true;
  }

  return {
    hasSelection: from !== to,
    text,
    fromLine,
    toLine,
    truncated,
    cursor: getCursorLocation(),
    language: fenceLanguageForPath(editorState.path),
  };
}

function resolvePosition(cmState, line = 1, col = 1) {
  const lineNumber = Math.max(1, Math.min(Number(line) || 1, cmState.doc.lines));
  const lineInfo = cmState.doc.line(lineNumber);
  const columnOffset = Math.max(0, (Number(col) || 1) - 1);
  return Math.min(lineInfo.from + columnOffset, lineInfo.to);
}

function getLanguageExtension(path) {
  if (!path) return [];

  const lower = path.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
    return javascript({ typescript: true, jsx: lower.endsWith('.tsx') });
  }
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return javascript({ jsx: lower.endsWith('.jsx') });
  }
  if (lower.endsWith('.rs')) {
    return rust();
  }
  if (lower.endsWith('.py')) {
    return python();
  }
  if (lower.endsWith('.json')) {
    return json();
  }
  if (lower.endsWith('.toml')) {
    return toml;
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return markdown();
  }
  if (lower.endsWith('.css')) {
    return css();
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return html();
  }

  return [];
}

function fenceLanguageForPath(path) {
  if (!path) return '';

  const lower = path.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'ts';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'js';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return '';
}

function setStatus(text, tone = 'info') {
  editorState.statusText = text;
  editorState.statusTone = tone;
}

function formatError(err) {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : String(err);
}
