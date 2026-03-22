/**
 * Catppuccin Mocha theme for xterm.js
 *
 * All 16 ANSI colors mapped to the Catppuccin Mocha palette,
 * plus background, foreground, cursor, and selection colors.
 */

export const catppuccinMocha = {
  // Background & foreground
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: 'rgba(137, 180, 250, 0.25)',
  selectionForeground: '#cdd6f4',
  selectionInactiveBackground: 'rgba(137, 180, 250, 0.12)',

  // Normal colors (0-7)
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',

  // Bright colors (8-15)
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};

export const terminalOptions = {
  theme: catppuccinMocha,
  fontFamily: "'SF Mono', Menlo, Monaco, monospace",
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: false,
  cursorStyle: 'block',
  scrollback: 999999999,
  allowProposedApi: true,
  convertEol: true,
  drawBoldTextInBrightColors: false,
};
