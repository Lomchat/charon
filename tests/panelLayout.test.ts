import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import {
  DEFAULT_PANEL_LAYOUT, PANEL_BOUNDS, isPanelClosed, panelDoubleClick, panelDragWidth,
  parsePanelLayout, serializePanelLayout, sideTier, toolsTier, withPanelWidths,
} from '@/app/panelLayout';

describe('panel layout cookie', () => {
  it('round-trips widths and remembered widths', () => {
    const layout = { sideW: 133, toolsW: PANEL_BOUNDS.tools.min, sideLast: 133, toolsLast: 512 };
    expect(serializePanelLayout(layout)).toBe(`v3.133.${PANEL_BOUNDS.tools.min}.133.512`);
    expect(parsePanelLayout(serializePanelLayout(layout))).toEqual(layout);
  });

  it('reads the older shapes', () => {
    // v1: a width + a folded flag (folded = the minimum, the width remembered).
    expect(parsePanelLayout('v1.333.1.400.0')).toEqual({
      sideW: PANEL_BOUNDS.side.min, toolsW: 400, sideLast: 333, toolsLast: 400,
    });
    // v2: two widths; a closed one remembers the default.
    expect(parsePanelLayout(`v2.300.${PANEL_BOUNDS.tools.min}`)).toEqual({
      sideW: 300, toolsW: PANEL_BOUNDS.tools.min, sideLast: 300, toolsLast: PANEL_BOUNDS.tools.def,
    });
  });

  it('falls back to the defaults on anything malformed', () => {
    for (const raw of [undefined, null, '', 'v2.280', 'v4.280.340.1.1', 'v1.280.2.340.0', 'v3.abc.340.1.1']) {
      expect(parsePanelLayout(raw)).toEqual(DEFAULT_PANEL_LAYOUT);
    }
  });

  it('clamps stored widths, and never remembers a closed one', () => {
    expect(parsePanelLayout('v3.10.9999.10.20')).toEqual({
      sideW: PANEL_BOUNDS.side.min, toolsW: PANEL_BOUNDS.tools.max,
      sideLast: PANEL_BOUNDS.side.def, toolsLast: PANEL_BOUNDS.tools.def,
    });
  });
});

describe('remembered width', () => {
  it('follows every open width and survives closing', () => {
    const open = withPanelWidths(DEFAULT_PANEL_LAYOUT, { toolsW: 500 });
    expect(open.toolsLast).toBe(500);
    const closed = withPanelWidths(open, { toolsW: PANEL_BOUNDS.tools.min });
    expect(closed).toMatchObject({ toolsW: PANEL_BOUNDS.tools.min, toolsLast: 500 });
    expect(closed.sideLast).toBe(DEFAULT_PANEL_LAYOUT.sideLast);
  });
});

describe('double-click on an edge', () => {
  it('returns any width to the default, and the default to closed', () => {
    const { min, def } = PANEL_BOUNDS.side;
    expect(panelDoubleClick(420, 'side')).toBe(def);
    expect(panelDoubleClick(120, 'side')).toBe(def);
    expect(panelDoubleClick(def, 'side')).toBe(min);
    expect(panelDoubleClick(min, 'side')).toBe(def);
  });
});

describe('drag width', () => {
  const { min, max } = PANEL_BOUNDS.side;

  it('lands anywhere between the closed width and the maximum', () => {
    expect(panelDragWidth('side', 97.4, 2000)).toBe(97);
    expect(panelDragWidth('side', 3, 2000)).toBe(min);
    expect(isPanelClosed('side', panelDragWidth('side', -40, 2000))).toBe(true);
    expect(panelDragWidth('side', 9999, 2000)).toBe(max);
  });

  it('never takes more than the viewport leaves', () => {
    expect(panelDragWidth('side', 9999, 300)).toBe(300);
    expect(panelDragWidth('side', 9999, 10)).toBe(min);
  });
});

describe('tiers', () => {
  it('lays the sidebar out as icons, then names, then everything', () => {
    expect(sideTier(PANEL_BOUNDS.side.min)).toBe('icons');
    expect(sideTier(159)).toBe('icons');
    expect(sideTier(160)).toBe('narrow');
    expect(sideTier(239)).toBe('narrow');
    expect(sideTier(PANEL_BOUNDS.side.def)).toBe('full');
  });

  it('closes the tools at their minimum only', () => {
    expect(toolsTier(PANEL_BOUNDS.tools.min)).toBe('closed');
    expect(toolsTier(PANEL_BOUNDS.tools.min + 1)).toBe('open');
    expect(toolsTier(PANEL_BOUNDS.tools.def)).toBe('open');
  });
});

describe('stylesheets', () => {
  it('never freeze the grid columns the user drags', () => {
    // A density or theme rule with literal tracks beats the width variables
    // and pins both side columns, whatever the drag says.
    const offenders: string[] = [];
    for (const file of readdirSync('app').filter((f) => f.endsWith('.css'))) {
      const css = readFileSync(`app/${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const targetsRoot = selector.split(',').some((part) => /\.app-root(?:[.:[][^\s]*)?\s*$/.test(part.trim()));
        const tracks = /grid-template-columns:\s*([^;]+)/.exec(body)?.[1].trim();
        if (targetsRoot && tracks && !tracks.includes('var(--side-col)') && tracks !== '1fr') {
          offenders.push(`${file}: ${selector.trim()} { grid-template-columns: ${tracks} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
