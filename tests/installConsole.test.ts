import { describe, it, expect, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { installKeepsVpsVisible } from '../app/Sidebar';
import { splitLogLines } from '../lib/server/install/installSession';
import type { InstallInfo } from '../lib/types/api';

/**
 * The install console, from both ends.
 *
 * 1. A machine being bootstrapped has, by definition, no session and no shell
 *    — the install row is the ONLY thing giving its VPS a place in the
 *    sidebar. Keying that on `status === 'running'` made the whole box vanish
 *    the instant the install ended: the log disappeared at the exact moment
 *    the user was reading the result, which reads as "Charon folded the VPS
 *    by itself".
 * 2. The live phase output is split into lines HERE, not in the browser,
 *    and `\r` (how pip and curl draw progress in place) has to count as a
 *    line break or the console shows one endless line.
 */

const install = (over: Partial<InstallInfo> = {}): InstallInfo => ({
  id: 'i1', vpsId: 'v1', vpsName: 'box', status: 'success',
  startedAt: Date.now() - 120_000, endedAt: Date.now() - 60_000,
  currentPhase: 'done', eventCount: 12, ...over,
});

describe('installKeepsVpsVisible', () => {
  it('keeps a running install visible', () => {
    expect(installKeepsVpsVisible(install({ status: 'running', endedAt: null }), null)).toBe(true);
  });

  it('keeps a just-finished install visible (success AND failure)', () => {
    expect(installKeepsVpsVisible(install({ status: 'success' }), null)).toBe(true);
    expect(installKeepsVpsVisible(install({ status: 'error' }), null)).toBe(true);
  });

  it('drops a stale finished install so an empty VPS leaves the list', () => {
    const old = install({ endedAt: Date.now() - 6 * 60 * 60_000 });
    expect(installKeepsVpsVisible(old, null)).toBe(false);
  });

  it('never drops the install currently open in the main pane', () => {
    const old = install({ endedAt: Date.now() - 6 * 60 * 60_000 });
    expect(installKeepsVpsVisible(old, old.id)).toBe(true);
  });

  it('no install at all keeps the old rule (VPS shown only with content)', () => {
    expect(installKeepsVpsVisible(null, null)).toBe(false);
  });
});

describe('splitLogLines', () => {
  it('treats \\r as a line break (pip/curl progress)', () => {
    expect(splitLogLines('a\rb\rc')).toEqual(['a', 'b', 'c']);
    expect(splitLogLines('a\r\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('drops blank lines, so a newline-only chunk emits nothing', () => {
    expect(splitLogLines('\n\n  \n')).toEqual([]);
    expect(splitLogLines('')).toEqual([]);
  });

  it('trims trailing whitespace but keeps indentation', () => {
    expect(splitLogLines('  Collecting anyio   \n')).toEqual(['  Collecting anyio']);
  });

  it('caps a burst to the tail', () => {
    const lines = splitLogLines(Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'));
    expect(lines.length).toBe(40);
    expect(lines[lines.length - 1]).toBe('line 199');
  });
});
