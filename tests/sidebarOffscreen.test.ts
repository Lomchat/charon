import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '@/lib/types/api';
import {
  anchorSelector, buildOffscreenTargets, collapsedAttentionCounts, countOffscreen, nearestOffscreen,
  offscreenKind, sideOf, type PlacedTarget,
} from '@/app/sidebarOffscreen';

// The sidebar's off-screen attention pills: which rows count, what they are
// anchored to when a group is folded, and which side of the visible band
// they sit on.
const session = (id: string, extra: Partial<SessionListItem> & Record<string, unknown> = {}): SessionListItem => ({
  id, vpsId: 'v1', name: id, cwd: '/p', kind: 'claude', status: 'active', createdAt: 1, ...extra,
} as unknown as SessionListItem);

const pathKey = (vpsId: string, cwd: string | null | undefined) => `${vpsId}|${cwd ?? '~'}`;

function build(o: {
  sessions?: SessionListItem[];
  shells?: { id: string; cwd?: string; unreadFinish?: boolean; liveStatus?: string; exited?: boolean }[];
  folderCollapsed?: boolean; collapsedVps?: string[]; collapsedPaths?: string[];
  selectedId?: string | null; selectedShellId?: string | null;
}) {
  return buildOffscreenTargets({
    folders: [{ id: 'f1', collapsed: !!o.folderCollapsed, vpsIds: ['v1'] }],
    sessionsOf: () => o.sessions ?? [],
    shellsOf: () => o.shells ?? [],
    collapsedVps: new Set(o.collapsedVps ?? []),
    collapsedPaths: new Set(o.collapsedPaths ?? []),
    pathKey,
    selectedId: o.selectedId ?? null,
    selectedShellId: o.selectedShellId ?? null,
  });
}

describe('offscreenKind', () => {
  it('orange for a gate or a question, red for an unseen error, green for an unseen finish', () => {
    expect(offscreenKind('blocked')).toBe('waiting');
    expect(offscreenKind('question')).toBe('waiting');
    expect(offscreenKind('error')).toBe('error');
    expect(offscreenKind('unread')).toBe('unread');
    expect(offscreenKind(null)).toBe(null);
  });
});

describe('buildOffscreenTargets', () => {
  const lit = [
    session('blocked', { status: 'thinking', pendingBlocking: 1, pendingAsync: 0 }),
    session('failed', { status: 'failed', unreadStop: 1 }),
    session('done', { unreadStop: 1 }),
    session('quiet', {}),
  ];

  it('lists the lit rows the list holds, in its order, with their colour', () => {
    expect(build({ sessions: lit }).map((t) => [t.id, t.kind])).toEqual([
      ['blocked', 'waiting'], ['failed', 'error'], ['done', 'unread'],
    ]);
  });

  it('the open session is not news (unread/error), but a gate on it still waits', () => {
    expect(build({ sessions: lit, selectedId: 'done' }).map((t) => t.id)).toEqual(['blocked', 'failed']);
    expect(build({ sessions: lit, selectedId: 'blocked' }).map((t) => t.id)).toEqual(['blocked', 'failed', 'done']);
  });

  it('an unread shell counts green; a busy or exited one does not', () => {
    const t = build({ shells: [
      { id: 'sh1', unreadFinish: true, liveStatus: 'active' },
      { id: 'sh2', unreadFinish: true, liveStatus: 'busy' },
      { id: 'sh3', unreadFinish: true, exited: true },
    ] });
    expect(t.map((x) => [x.id, x.kind])).toEqual([['sh1', 'unread']]);
  });

  it('anchors to the card, else to the OUTERMOST folded group, and reveals every folded one', () => {
    const one = [session('failed', { status: 'failed', unreadStop: 1, cwd: '/a' })];
    expect(build({ sessions: one })[0]).toMatchObject({
      anchor: { kind: 'row', key: 'failed' }, reveal: { folderId: null, vpsId: null, pathKey: null },
    });
    expect(build({ sessions: one, collapsedPaths: ['v1|/a'] })[0]).toMatchObject({
      anchor: { kind: 'path', key: 'v1|/a' }, reveal: { pathKey: 'v1|/a', vpsId: null },
    });
    expect(build({ sessions: one, collapsedPaths: ['v1|/a'], collapsedVps: ['v1'] })[0]).toMatchObject({
      anchor: { kind: 'vps', key: 'v1' }, reveal: { vpsId: 'v1', pathKey: 'v1|/a' },
    });
    expect(build({ sessions: one, collapsedVps: ['v1'], folderCollapsed: true })[0]).toMatchObject({
      anchor: { kind: 'folder', key: 'f1' }, reveal: { folderId: 'f1', vpsId: 'v1', pathKey: null },
    });
  });

  it('anchor selectors name the element each anchor kind carries', () => {
    expect(anchorSelector({ kind: 'row', key: 'abc' })).toBe('[data-tab-id="abc"]');
    expect(anchorSelector({ kind: 'vps', key: 'v1' })).toBe('[data-vps-id="v1"]');
    expect(anchorSelector({ kind: 'folder', key: 'f1' })).toBe('[data-folder-id="f1"]');
    // A JSON path key keeps its quotes escaped.
    expect(anchorSelector({ kind: 'path', key: '["v","/a"]' })).toBe('[data-path-key="[\\"v\\",\\"/a\\"]"]');
  });
});

describe('sides of the visible band', () => {
  const view = { top: 100, bottom: 500 };
  const at = (id: string, kind: PlacedTarget['kind'], top: number): PlacedTarget => ({ id, kind, top, bottom: top + 30 });

  it('by the middle: half under the pinned head or the bottom edge is unseen', () => {
    expect(sideOf({ top: 80, bottom: 110 }, view).side).toBe('up');
    expect(sideOf({ top: 90, bottom: 120 }, view).side).toBe(null);
    expect(sideOf({ top: 480, bottom: 510 }, view).side).toBe(null);
    expect(sideOf({ top: 490, bottom: 520 }, view).side).toBe('down');
  });

  it('counts per colour on each side, orange then red then green, empty kinds omitted', () => {
    const placed = [
      at('u1', 'unread', 0), at('e1', 'error', 20), at('w1', 'waiting', 40),
      at('in', 'error', 300),
      at('u2', 'unread', 600), at('u3', 'unread', 700),
    ];
    expect(countOffscreen(placed, view)).toEqual({
      up: [{ kind: 'waiting', count: 1 }, { kind: 'error', count: 1 }, { kind: 'unread', count: 1 }],
      down: [{ kind: 'unread', count: 2 }],
    });
  });

  it('a click goes to the nearest of its colour past that edge', () => {
    const placed = [at('far', 'error', 900), at('near', 'error', 560), at('green', 'unread', 520), at('up', 'error', 0)];
    expect(nearestOffscreen(placed, view, 'down', 'error')).toBe('near');
    expect(nearestOffscreen(placed, view, 'up', 'error')).toBe('up');
    expect(nearestOffscreen(placed, view, 'up', 'waiting')).toBe(null);
  });
});

describe('collapsedAttentionCounts', () => {
  it('a folded server counts its lit rows by colour, in priority order', () => {
    expect(collapsedAttentionCounts(
      [session('a', { unreadStop: 1 }), session('b', { status: 'error', unreadStop: 1 }), session('c', { unreadStop: 1 }),
        session('d', { pendingBlocking: 0, pendingAsync: 1 })],
      [{ id: 's', unreadFinish: true, liveStatus: 'active' }],
      null, null,
    )).toEqual([{ kind: 'waiting', count: 1 }, { kind: 'error', count: 1 }, { kind: 'unread', count: 3 }]);
  });
});
