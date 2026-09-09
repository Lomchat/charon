/** ── Theme registry ────────────────────────────────────────────────────────
 *  THE single source of truth for the look of the hub (§11).
 *
 *  Adding a theme = one `[data-theme='<id>']` block in `app/themes.css` + one
 *  entry here. Nothing else: every colour in claude.css / agent-ui.css /
 *  globals.css goes through the semantic tokens that block defines.
 *
 *  This file exists because three surfaces are NOT styled by CSS and would
 *  otherwise stay frozen on the dark palette:
 *    · xterm.js takes a JS colour object (ShellTerminal.tsx)
 *    · CodeMirror takes an extension, not a class (CodeEditor.tsx)
 *    · <meta name="theme-color"> is document metadata (layout.tsx)
 *  Keep those three reading from `xterm` / `dark` / `themeColor` below.
 *
 *  Kept free of any React/DOM import: it is read by the server (layout.tsx,
 *  the settings route) as well as by the browser.
 */

export type XtermPalette = {
  background: string; foreground: string; cursor: string; selectionBackground: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
};

export type Theme = {
  id: string;
  /** Shown in the settings picker. */
  label: string;
  /** One line under the label — what the theme is for. */
  hint: string;
  /** Drives CodeMirror (one-dark vs the default light highlight style) and
   *  the `dark` flag xterm/CodeMirror use for their own derived colours. */
  dark: boolean;
  /** Mobile browser chrome (`<meta name="theme-color">`) — must match --bg. */
  themeColor: string;
  xterm: XtermPalette;
};

export const THEMES: readonly Theme[] = [
  {
    id: 'nordic',
    label: 'Nordic Tokyo',
    hint: 'the original — deep blue-grey, low glare',
    dark: true,
    themeColor: '#181b24',
    xterm: {
      background: '#0e0e0e', foreground: '#dcdcdc', cursor: '#dcdcdc',
      selectionBackground: '#2f4f6f',
      black: '#000000', red: '#d97a6b', green: '#6cbf6c', yellow: '#d8a85a',
      blue: '#6a9bd8', magenta: '#c8a2c8', cyan: '#7ac4c4', white: '#dcdcdc',
      brightBlack: '#555555', brightRed: '#e69088', brightGreen: '#8acf8a',
      brightYellow: '#e8bf7a', brightBlue: '#8ab0d8', brightMagenta: '#d8b8d8',
      brightCyan: '#9cd0d0', brightWhite: '#ffffff',
    },
  },
  {
    id: 'daylight',
    label: 'Daylight',
    hint: 'light — for a bright room or a sunlit screen',
    dark: false,
    themeColor: '#eef1f6',
    xterm: {
      background: '#fbfaf7', foreground: '#2f3337', cursor: '#2f3337',
      selectionBackground: '#c9dcf2',
      black: '#2f3337', red: '#b32d22', green: '#2f7d33', yellow: '#96690f',
      blue: '#2c6db5', magenta: '#8a3fa0', cyan: '#17606f', white: '#dcdcdc',
      brightBlack: '#7a8088', brightRed: '#c2404b', brightGreen: '#3f9144',
      brightYellow: '#b8860b', brightBlue: '#3f81c8', brightMagenta: '#a05ab8',
      brightCyan: '#217f93', brightWhite: '#ffffff',
    },
  },
  {
    id: 'ember',
    label: 'Ember',
    hint: 'dark orange — and the transcript loses its message frames',
    dark: true,
    themeColor: '#131010',
    // The one place the warm register gives way: a terminal renders someone
    // else's ANSI, so blue/cyan/magenta stay recognisably themselves (muted,
    // not recoloured) — `ls` output has to keep meaning what it means.
    xterm: {
      background: '#100c0b', foreground: '#e0cdc2', cursor: '#ff9464',
      selectionBackground: '#4a2a1e',
      black: '#1a1413', red: '#e05b57', green: '#a3bb63', yellow: '#d9a441',
      blue: '#8f9bc4', magenta: '#c58ab0', cyan: '#79a9a4', white: '#e0cdc2',
      brightBlack: '#6e5348', brightRed: '#f2705f', brightGreen: '#c6d98d',
      brightYellow: '#ffc857', brightBlue: '#a8b3d8', brightMagenta: '#dba8c6',
      brightCyan: '#96c2bd', brightWhite: '#fdf1ea',
    },
  },
];

export const DEFAULT_THEME_ID = 'nordic';

export function isThemeId(value: unknown): value is string {
  return typeof value === 'string' && THEMES.some((t) => t.id === value);
}

/** Never throws and never returns undefined: an unknown id (a theme removed
 *  from the code while a browser or the DB still names it) degrades to the
 *  default rather than rendering an unstyled page. */
export function resolveTheme(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
}
