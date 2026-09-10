import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { THEMES, DEFAULT_THEME_ID, resolveTheme, isThemeId } from '../app/themes';

/**
 * The theme contract (§11).
 *
 * A theme is one block in app/themes.css plus one entry in app/themes.ts, and
 * the whole point is that adding one cannot half-work. Two failure modes are
 * invisible on the default theme and obvious to everyone else:
 *
 *   · a theme block that MISSES a token — the page silently falls back to the
 *     :root value, so a light theme keeps a handful of dark surfaces;
 *   · a stylesheet using a token no theme defines — `var(--muted)` with no
 *     fallback is not an error, the declaration is just dropped (that is
 *     exactly what three rules in claude.css were doing before the tokens).
 *
 * Both are caught here rather than by looking at the app.
 */

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
// Comments stripped before any block lookup: the header names the selectors
// it tells you to copy, and indexOf would find those first.
const THEME_CSS = read('app/themes.css').replace(/\/\*[\s\S]*?\*\//g, '');
const SHEETS = ['app/claude.css', 'app/globals.css', 'app/agent-ui.css'];

/** The declarations of one `<selector> { … }` block, by first selector match. */
function blockOf(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `no block for ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('\n}', open));
}

function definedIn(block: string): Set<string> {
  return new Set([...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
}

const base = definedIn(blockOf(THEME_CSS, ":root,\n[data-theme='nordic']"));

describe('theme registry', () => {
  it('every theme in the CSS is declared in the registry and vice versa', () => {
    const inCss = [...THEME_CSS.matchAll(/\[data-theme='([^']+)'\]/g)].map((m) => m[1]);
    expect([...new Set(inCss)].sort()).toEqual(THEMES.map((t) => t.id).sort());
  });

  it('the default theme exists', () => {
    expect(THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true);
  });

  it('an unknown id degrades to the default instead of throwing', () => {
    expect(resolveTheme('no-such-theme').id).toBe(DEFAULT_THEME_ID);
    expect(resolveTheme(null).id).toBe(DEFAULT_THEME_ID);
    expect(isThemeId('no-such-theme')).toBe(false);
    expect(isThemeId(DEFAULT_THEME_ID)).toBe(true);
  });

  it("each theme's --bg matches the themeColor it advertises to the browser", () => {
    for (const theme of THEMES) {
      const block = theme.id === DEFAULT_THEME_ID
        ? blockOf(THEME_CSS, ":root,\n[data-theme='nordic']")
        : blockOf(THEME_CSS, `[data-theme='${theme.id}']`);
      const bg = /^\s*--bg\s*:\s*(\S+?);/m.exec(block)?.[1];
      expect(bg, `${theme.id} has no --bg`).toBeTruthy();
      expect(theme.themeColor.toLowerCase()).toBe(bg!.toLowerCase());
    }
  });
});

describe('theme tokens', () => {
  it('every theme defines exactly the base set of tokens', () => {
    for (const theme of THEMES) {
      if (theme.id === DEFAULT_THEME_ID) continue;
      const defined = definedIn(blockOf(THEME_CSS, `[data-theme='${theme.id}']`));
      expect([...base].filter((t) => !defined.has(t)), `${theme.id} is missing tokens`).toEqual([]);
      expect([...defined].filter((t) => !base.has(t)), `${theme.id} defines unknown tokens`).toEqual([]);
    }
  });

  it('every token the stylesheets use is defined somewhere', () => {
    // Tokens set from JS or from another rule (a component writes them inline)
    // are legitimately absent from the theme blocks.
    const local = new Set<string>();
    for (const sheet of [...SHEETS, 'app/themes.css']) {
      for (const m of read(sheet).matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) local.add(m[1]);
    }
    const runtime = new Set(['--c']); // set inline by the sidebar card stripe
    const missing = new Set<string>();
    for (const sheet of SHEETS) {
      for (const m of read(sheet).matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!local.has(m[1]) && !runtime.has(m[1])) missing.add(m[1]);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('no stylesheet outside themes.css carries a literal colour', () => {
    // The tokens are only a theming layer if nothing bypasses them. Comments
    // are prose and may name a colour.
    for (const sheet of SHEETS) {
      const css = read(sheet).replace(/\/\*[\s\S]*?\*\//g, '');
      const literals = [
        ...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
        ...css.matchAll(/\brgba?\(/g),
      ].map((m) => m[0]);
      expect(literals, `${sheet} hardcodes a colour`).toEqual([]);
    }
  });

  it('no stylesheet outside themes.css carries a literal corner radius', () => {
    // Same rule as colour, one exception: a circle and a pill are SHAPES. An
    // avatar is round because it is an avatar, not because a theme said so,
    // and `0` means "explicitly none". Everything else is a --radius step.
    const shapes = /^(50%|999px|0)$/;
    for (const sheet of SHEETS) {
      const css = read(sheet).replace(/\/\*[\s\S]*?\*\//g, '');
      const literals = [...css.matchAll(/border-radius:\s*([^;}]+)/g)]
        .map((m) => m[1].trim())
        .filter((value) => !/var\(--[a-z-]*radius[a-z-]*\)/.test(value) && !shapes.test(value));
      expect(literals, `${sheet} hardcodes a corner radius`).toEqual([]);
    }
  });
});
