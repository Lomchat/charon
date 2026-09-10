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
    id: 'etonc',
    label: 'Etonc',
    // Contributed by Etoncoco (PR #39). The one theme that drops the message
    // frames: warm-grey ground, coral primary, and a capped reading column,
    // since nothing else holds the line length down once the boxes go.
    hint: 'warm greys and coral — the transcript reads as a document',
    dark: true,
    themeColor: '#191817',
    // One reservation: a terminal renders someone else's ANSI, so
    // blue/cyan/magenta stay recognisably themselves — muted into the warm
    // register, never recoloured. `ls` has to keep meaning what it means.
    xterm: {
      background: '#141312', foreground: '#e6e0d4', cursor: '#e8977a',
      selectionBackground: '#46352c',
      black: '#1a1917', red: '#d4534b', green: '#93b071', yellow: '#d7a54e',
      blue: '#8fa2bf', magenta: '#b491c9', cyan: '#9db5a8', white: '#e6e0d4',
      brightBlack: '#6b665c', brightRed: '#e56a5c', brightGreen: '#b9d19a',
      brightYellow: '#f0c168', brightBlue: '#a9bad4', brightMagenta: '#cdaede',
      brightCyan: '#bacfc2', brightWhite: '#fbf9f2',
    },
  },
  {
    id: 'cupertino',
    label: 'Cupertino',
    hint: 'light — a Mac app: grey window, white content, hairlines',
    dark: false,
    themeColor: '#f2f2f7',
    // Terminal.app's own Basic profile is white-on-black-text, and its ANSI
    // brights (#00d900, #e5e500) are invisible there — so the palette is the
    // system one darkened to carry on white, keeping each hue recognisable.
    xterm: {
      background: '#ffffff', foreground: '#1d1d1f', cursor: '#007aff',
      selectionBackground: '#b3d7ff',
      black: '#1d1d1f', red: '#c02318', green: '#1a7f37', yellow: '#9a6700',
      blue: '#0057c2', magenta: '#8944ab', cyan: '#0a7c8c', white: '#6e6e73',
      brightBlack: '#8e8e93', brightRed: '#d70015', brightGreen: '#248a3d',
      brightYellow: '#b25000', brightBlue: '#007aff', brightMagenta: '#a259c4',
      brightCyan: '#0e8fa3', brightWhite: '#000000',
    },
  },
  {
    id: 'cupertino-night',
    label: 'Cupertino Night',
    hint: 'dark — the same Mac app after sunset',
    dark: true,
    themeColor: '#1c1c1e',
    // Apple's Dark variants land almost exactly where a terminal wants them:
    // bright enough on near-black, and each hue still itself.
    xterm: {
      background: '#121214', foreground: '#f5f5f7', cursor: '#0a84ff',
      selectionBackground: '#3f638b',
      black: '#1c1c1e', red: '#ff453a', green: '#30d158', yellow: '#ffd60a',
      blue: '#0a84ff', magenta: '#bf5af2', cyan: '#40cbe0', white: '#d1d1d6',
      brightBlack: '#8e8e93', brightRed: '#ff6961', brightGreen: '#30db5b',
      brightYellow: '#ffd426', brightBlue: '#409cff', brightMagenta: '#da8fff',
      brightCyan: '#5de6ff', brightWhite: '#ffffff',
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
