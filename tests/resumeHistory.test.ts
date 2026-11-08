import { describe, expect, it } from 'vitest';
import {
  groupProjects, isNoise, matchesQuery, mergeHistory, shortModel, type ResumeItem,
} from '../app/resumeHistory';
import type { HistorySession, SessionListItem } from '../lib/types/api';

// The resume modal lists what Charon does NOT show: sessions never imported,
// and archived ones. A session in the sidebar must never appear (it is not a
// search), and a transcript Charon already holds must never be offered for a
// second import — these pin the de-duplication and the hiding rules.

const row = (over: Partial<HistorySession> = {}): HistorySession => ({
  kind: 'claude', sessionId: 'n1', cwd: '/srv/app', title: 'Fix login', firstPrompt: 'fix the login',
  lastPrompt: 'deploy', prompts: 4, approx: false, model: 'claude-opus-5-5', branch: 'main',
  mtime: 1_000, size: 2048, ...over,
});

const charon = (over: Partial<SessionListItem> = {}): SessionListItem => ({
  id: 's1', vpsId: 'v1', kind: 'claude', nativeSessionId: 'n1', cwd: '/srv/app', name: 'Login (Charon)',
  status: 'sleeping', liveStatus: 'sleeping', archived: 0, createdAt: 500, lastActivityMs: 900_000,
  firstUserMessage: 'fix the login', model: null,
  ...over,
} as unknown as SessionListItem);

describe('resume list: merge', () => {
  it('a transcript a sidebar session resumes is not listed at all', () => {
    for (const status of ['sleeping', 'active', 'error']) {
      expect(mergeHistory([row()], [charon({ status, liveStatus: status } as Partial<SessionListItem>)])).toEqual([]);
    }
  });

  it('nor are the sidebar sessions the index lacks', () => {
    expect(mergeHistory([], [charon({ kind: 'cursor', nativeSessionId: 'x' } as Partial<SessionListItem>),
      charon({ id: 'b', nativeSessionId: null } as Partial<SessionListItem>)])).toEqual([]);
  });

  it('matches on kind AND native id', () => {
    const items = mergeHistory([row({ kind: 'codex' })], [charon()]);
    expect(items.map((i) => [i.key, i.state])).toEqual([['codex:n1', 'new']]);
  });

  it('an archived session is listed once, as that session', () => {
    const [it, ...rest] = mergeHistory([row()], [charon({ archived: 1 } as Partial<SessionListItem>)]);
    expect(rest).toEqual([]);
    expect([it.key, it.state, it.session?.id, it.title]).toEqual(['claude:n1', 'archived', 's1', 'Login (Charon)']);
    expect(it.mtimeMs).toBe(1_000_000);                 // the newer of the two clocks
  });

  it('keeps archived sessions the index does not list', () => {
    const items = mergeHistory([], [
      charon({ id: 'a', kind: 'cursor', nativeSessionId: 'x', archived: 1 } as Partial<SessionListItem>),
      charon({ id: 'b', nativeSessionId: null, archived: 1 } as Partial<SessionListItem>),
    ]);
    expect(items.map((i) => [i.key, i.state, i.prompts]).sort()).toEqual([
      ['cursor:x', 'archived', null], ['db:b', 'archived', null],
    ]);
  });

  it('a visible copy hides its archived twin on the same native id', () => {
    expect(mergeHistory([row()], [
      charon({ id: 'old', archived: 1 } as Partial<SessionListItem>),
      charon({ id: 'live' }),
    ])).toEqual([]);
  });

  it('an archived Codex thread is flagged for the unarchive after import', () => {
    const [it] = mergeHistory([row({ kind: 'codex', archived: true })], []);
    expect(it.state).toBe('new');
    expect(it.archivedNative).toBe(true);
  });
});

describe('resume list: noise, search, projects', () => {
  const item = (over: Partial<ResumeItem>): ResumeItem => ({ ...mergeHistory([row()], [])[0], ...over });

  it('hides empty and /tmp transcripts, never an archived session or a sampled one', () => {
    expect(isNoise(item({ prompts: 0 }))).toBe(true);
    expect(isNoise(item({ cwd: '/tmp/scratch' }))).toBe(true);
    expect(isNoise(item({ cwd: '/tmpfoo' }))).toBe(false);
    expect(isNoise(item({ prompts: 0, approx: true }))).toBe(false);
    expect(isNoise(item({ prompts: 0, state: 'archived' }))).toBe(false);
    expect(isNoise(item({ prompts: 1 }))).toBe(false);
  });

  it('every word must match, accents and case aside', () => {
    const it = item({ title: 'Réparer le déploiement', branch: 'fix/queue', cwd: '/srv/elevenduel' });
    expect(matchesQuery(it, 'deploiement eleven')).toBe(true);
    expect(matchesQuery(it, 'QUEUE')).toBe(true);
    expect(matchesQuery(it, 'deploiement charon')).toBe(false);
    expect(matchesQuery(it, '   ')).toBe(true);
  });

  it('groups folders, most recent first, counting what is not imported', () => {
    const items = mergeHistory([
      row({ sessionId: 'a', cwd: '/srv/a', mtime: 10 }),
      row({ sessionId: 'b', cwd: '/srv/b', mtime: 30 }),
      row({ sessionId: 'c', cwd: '/srv/a', mtime: 20 }),
    ], [charon({ nativeSessionId: 'c', cwd: '/srv/a', lastActivityMs: 0, archived: 1 } as Partial<SessionListItem>)]);
    expect(groupProjects(items)).toEqual([
      { cwd: '/srv/b', count: 1, fresh: 1, latestMs: 30_000 },
      { cwd: '/srv/a', count: 2, fresh: 1, latestMs: 20_000 },
    ]);
  });

  it('shortens Claude model ids only', () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus-5.5');
    expect(shortModel('claude-sonnet-5-5[1m]')).toBe('sonnet-5.5[1m]');
    expect(shortModel('gpt-6.1-sol')).toBe('gpt-6.1-sol');
  });
});
