import * as React from 'react';
import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '@/lib/types/api';

// Classic JSX transform: components read the global React.
(globalThis as { React?: typeof React }).React = React;

import {
  claimHeaderPopover, lastFolderPath, leaveCloses, navRows, navSections, panelClickOutcome, panelHoverOutcome, releaseHeaderPopover, rowOf,
  triggerClickOutcome,
} from '@/app/HeaderSessionNav';
import type { ShellListItem } from '@/app/Sidebar';

// W2 review (C10): every session the badge counts as waiting has a row in the
// panel's top sections — a waiting session that is not working (an async
// question on an idle/paused session) used to be in neither Working nor
// Recently finished. Since C15 the rows ARE the summary store: no side feed.
const item = (id: string, extra: Partial<SessionListItem> & Record<string, unknown>): SessionListItem => ({
  id, vpsId: 'v', name: id, cwd: '/p', kind: 'codex', status: 'active', createdAt: 1,
  ...extra,
} as unknown as SessionListItem);

describe('HeaderSessionNav sections', () => {
  it('waiting-but-not-working rows get the Waiting section; working ones stay under Working', () => {
    const rows = [
      item('asyncIdle', { pendingBlocking: 0, pendingAsync: 1 }),
      item('asyncPaused', { status: 'sleeping', pendingBlocking: 0, pendingAsync: 1 }),
      item('blocked', { status: 'thinking', pendingBlocking: 1, pendingAsync: 0 }),
      item('busy', { status: 'thinking' }),
      item('done', {}),
    ].map((s) => rowOf(s, null));
    const { waitingOnly, running, finished } = navSections(rows);
    expect(waitingOnly.map((r) => r.s.id).sort()).toEqual(['asyncIdle', 'asyncPaused']);
    expect(running.map((r) => r.s.id).sort()).toEqual(['blocked', 'busy']);
    expect(finished.map((r) => r.s.id)).toEqual(['done']);
    // Every row the badge counts is listed in a top section.
    const top = new Set([...waitingOnly, ...running].map((r) => r.s.id));
    for (const r of rows.filter((x) => x.waiting)) expect(top.has(r.s.id)).toBe(true);
  });
});

describe('HeaderSessionNav errors', () => {
  it('a failed or crashed session nobody opened is `errored`, red over green, under orange', () => {
    const failedUnread = rowOf(item('f', { status: 'failed', unreadStop: 1 }), null);
    const crashedUnread = rowOf(item('c', { status: 'error', unreadStop: 1 }), null);
    const failedSeen = rowOf(item('s', { status: 'failed', unreadStop: 0 }), null);
    const done = rowOf(item('d', { unreadStop: 1 }), null);
    const waiting = rowOf(item('w', { pendingBlocking: 0, pendingAsync: 1 }), null);
    expect([failedUnread.errored, crashedUnread.errored, failedSeen.errored, done.errored]).toEqual([true, true, false, false]);
    expect(failedUnread.unread).toBe(false);
    expect(failedUnread.state).toBe('error');
    expect(navSections([failedUnread, failedSeen]).finished.map((r) => r.id)).toEqual(['f', 's']);
    expect(navAttentionClass([done, failedUnread])).toBe('has-error');
    expect(navAttentionClass([done, failedUnread, waiting])).toBe('has-waiting');
    expect(navAttentionClass([done, failedSeen])).toBe('has-unread');
    // The session this tab shows is the acknowledgement.
    expect(rowOf(item('f', { status: 'failed', unreadStop: 1 }), 'f').errored).toBe(false);
  });
});

describe('HeaderSessionNav shells', () => {
  const shell = (id: string, extra: Partial<ShellListItem>): ShellListItem => ({
    id, vpsId: 'v', vpsName: 'V', cwd: '/p', name: null, color: null, startedAt: 1_000,
    exited: false, exitCode: null, ...extra,
  });
  it('live shells join the sessions: busy = working, idle = finished, by last activity', () => {
    const rows = navRows(
      [item('old', { lastActivityMs: 2_000 }), item('new', { lastActivityMs: 9_000 })],
      null,
      [
        shell('busy', { liveStatus: 'busy', lastActivityMs: 3_000 }),
        shell('idle', { liveStatus: 'active', lastActivityMs: 5_000 }),
        shell('fresh', {}),
        shell('ended', { exited: true, lastActivityMs: 99_000 }),
      ],
    );
    expect(rows.map((r) => r.id)).toEqual(['new', 'idle', 'busy', 'old', 'fresh']);
    const { running, finished, waitingOnly } = navSections(rows);
    expect(running.map((r) => r.id)).toEqual(['busy']);
    expect(finished.map((r) => r.id)).toEqual(['new', 'idle', 'old', 'fresh']);
    expect(waitingOnly).toEqual([]);
    expect(rows.some((r) => r.shell && (r.unread || r.waiting))).toBe(false);
  });

  it('a shell that finished unattended is unread — except busy, or shown on this tab', () => {
    const unread = (sh: ShellListItem, viewed: string | null = null) =>
      navRows([], viewed, [sh]).find((r) => r.id === sh.id)?.unread;
    expect(unread(shell('a', { unreadFinish: true }))).toBe(true);
    expect(unread(shell('a', { unreadFinish: true }), 'a')).toBe(false);
    expect(unread(shell('a', { unreadFinish: true, liveStatus: 'busy' }))).toBe(false);
    expect(navRows([], null, [shell('a', { unreadFinish: true, exited: true })])).toEqual([]);
  });
});

describe('triggerClickOutcome', () => {
  it('a click on a hover-opened panel pins it instead of closing it', () => {
    expect(triggerClickOutcome(true, 'hover')).toBe('pin');
  });
  it('a closed panel opens; a click-opened panel closes', () => {
    expect(triggerClickOutcome(false, 'hover')).toBe('open');
    expect(triggerClickOutcome(false, 'click')).toBe('open');
    expect(triggerClickOutcome(true, 'click')).toBe('close');
  });
});

describe('panelClickOutcome — exclusive panels on one account button', () => {
  it('a click on a hover-opened panel pins it; on a click-opened one closes it', () => {
    expect(panelClickOutcome<'usage' | 'sessions'>('usage', 'usage', 'hover')).toBe('pin');
    expect(panelClickOutcome<'usage' | 'sessions'>('usage', 'usage', 'click')).toBe('close');
  });
  it('nothing open, or the OTHER panel open ⇒ this one opens (whatever opened the other)', () => {
    expect(panelClickOutcome<'usage' | 'sessions'>(null, 'usage', 'hover')).toBe('open');
    expect(panelClickOutcome<'usage' | 'sessions'>('sessions', 'usage', 'hover')).toBe('open');
    expect(panelClickOutcome<'usage' | 'sessions'>('usage', 'sessions', 'click')).toBe('open');
  });
});

describe('panelHoverOutcome — hover between the two triggers of one account button', () => {
  type P = 'usage' | 'sessions';
  it('nothing open ⇒ opens at once; the same panel ⇒ keeps', () => {
    expect(panelHoverOutcome<P>(null, 'usage', 'click')).toBe('open');
    expect(panelHoverOutcome<P>('usage', 'usage', 'hover')).toBe('keep');
  });
  it('another hover-opened panel ⇒ switches only after a rest', () => {
    expect(panelHoverOutcome<P>('sessions', 'usage', 'hover')).toBe('switch-later');
  });
  it('a click-pinned panel is never replaced by a hover', () => {
    expect(panelHoverOutcome<P>('sessions', 'usage', 'click')).toBe('ignore');
    expect(panelHoverOutcome<P>('usage', 'sessions', 'click')).toBe('ignore');
  });
});

describe('leaveCloses — pointer leaving the button', () => {
  it('a hover-opened panel closes; a pinned one survives only where pins are kept', () => {
    expect(leaveCloses('hover', true)).toBe(true);
    expect(leaveCloses('hover', false)).toBe(true);
    expect(leaveCloses('click', true)).toBe(false);
    expect(leaveCloses('click', false)).toBe(true);
  });
});

describe('claimHeaderPopover — one header popover at a time across items', () => {
  it('a new owner closes the previous one; re-claiming or releasing does not', () => {
    const a = {}, b = {};
    let closedA = 0, closedB = 0;
    claimHeaderPopover(a, () => { closedA++; });
    claimHeaderPopover(a, () => { closedA++; });
    expect(closedA).toBe(0);
    claimHeaderPopover(b, () => { closedB++; });
    expect(closedA).toBe(1);
    releaseHeaderPopover(a); // a stale release leaves b the owner
    claimHeaderPopover(a, () => { closedA++; });
    expect(closedB).toBe(1);
    releaseHeaderPopover(a);
    claimHeaderPopover(b, () => { closedB++; });
    expect(closedA).toBe(1);
    releaseHeaderPopover(b);
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { lockPulsePhase, navAttentionClass } from '@/app/HeaderSessionNav';

describe('navAttentionClass — the trigger class shared with the account buttons', () => {
  const cls = (xs: SessionListItem[], viewed: string | null = null) => navAttentionClass(xs.map((x) => rowOf(x, viewed)));
  it('blocked or async question ⇒ waiting; unread only ⇒ unread; waiting outranks unread', () => {
    expect(cls([item('b', { status: 'thinking', pendingBlocking: 1, pendingAsync: 0 })])).toBe('has-waiting');
    expect(cls([item('q', { status: 'sleeping', pendingBlocking: 0, pendingAsync: 1 })])).toBe('has-waiting');
    expect(cls([item('u', { unreadStop: 1 })])).toBe('has-unread');
    expect(cls([item('u', { unreadStop: 1 }), item('q', { pendingBlocking: 0, pendingAsync: 1 })])).toBe('has-waiting');
    expect(cls([item('u', { unreadStop: 1 })], 'u')).toBe('');
    expect(cls([item('busy', { status: 'thinking' })])).toBe('');
  });
});

describe('pulse phase lock', () => {
  it('re-anchors only the attention pulses at timeline 0', () => {
    const pulse = { animationName: 'row-pulse-green', startTime: 4321 as number | null };
    const waiting = { animationName: 'row-pulse', startTime: null as number | null };
    const other = { animationName: 'hnav-pulse', startTime: 77 };
    lockPulsePhase({ getAnimations: () => [pulse, waiting, other] } as unknown as Element);
    expect([pulse.startTime, waiting.startTime, other.startTime]).toEqual([0, 0, 77]);
    expect(() => lockPulsePhase(null)).not.toThrow();
    expect(() => lockPulsePhase({} as Element)).not.toThrow();
  });

  it('the account button shares the trigger\'s pulse rules', () => {
    const css = readFileSync(path.resolve(__dirname, '../app/app.css'), 'utf8');
    const rule = (sel: string) => {
      const at = css.indexOf(sel);
      expect(at, sel).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf('}', at));
    };
    expect(rule('.app-head .hnav-trigger.has-unread, .app-head .acct-nav-item.has-unread {'))
      .toContain('animation: row-pulse-green ');
    expect(rule('.app-head .hnav-trigger.has-waiting, .app-head .acct-nav-item.has-waiting {'))
      .toContain('animation: row-pulse ');
    expect(rule('.app-head .hnav-trigger.has-error, .app-head .acct-nav-item.has-error {'))
      .toContain('animation: row-pulse-red ');
    // Orange is declared after red: a blocked session outranks a failed one.
    expect(css.indexOf('.app-head .hnav-trigger.has-waiting,'))
      .toBeGreaterThan(css.indexOf('.app-head .hnav-trigger.has-error,'));
  });
});

describe('HeaderSessionNav row path', () => {
  // The name keeps its width; a path that does not fit collapses to its last
  // folder rather than being cut mid-segment.
  it('collapses a path to …/<last folder>', () => {
    expect(lastFolderPath('/var/www/html/gpus/sources/redtech')).toBe('…/redtech');
    expect(lastFolderPath('/srv/charon/')).toBe('…/charon');
    expect(lastFolderPath('~/projects/app')).toBe('…/app');
  });
  it('leaves a one-segment path alone', () => {
    for (const p of ['/srv', '~', '/', 'relative']) expect(lastFolderPath(p)).toBe(p);
  });
});
