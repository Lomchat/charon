// Colour palette to mark a session (sidebar row, desk chest). Pure: no React.
// "transparent" = no marker (default option, neutralizes an existing marker).
export const ROW_COLORS = [
  { token: null,        css: 'transparent', label: 'none' },
  { token: 'gold',      css: '#d8a85a',     label: 'gold' },
  { token: 'green',     css: '#6cbf6c',     label: 'green' },
  { token: 'cyan',      css: '#7ac4c4',     label: 'cyan' },
  { token: 'blue',      css: '#6a9bd8',     label: 'blue' },
  { token: 'purple',    css: '#c8a2c8',     label: 'purple' },
  { token: 'red',       css: '#d97a6b',     label: 'red' },
  { token: 'pink',      css: '#e6a4c8',     label: 'pink' },
] as const;

export type RowColor = (typeof ROW_COLORS)[number]['token'];

export function colorToCss(token: string | null | undefined): string {
  if (!token) return 'transparent';
  const entry = ROW_COLORS.find((c) => c.token === token);
  return entry?.css ?? token; // tolerates a hex passed directly
}

/** A `#rrggbb` for a canvas, or null (no colour, or not a plain hex). */
export function colorToHex(token: string | null | undefined): string | null {
  const css = colorToCss(token);
  return /^#[0-9a-f]{6}$/i.test(css) ? css : null;
}
