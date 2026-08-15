import { describe, it, expect } from 'vitest';
import { assignHandles, resolveHandle, slugifyHandle } from '@/lib/sessionHandle';

describe('slugifyHandle', () => {
  it('makes a free-form name typeable after an @', () => {
    expect(slugifyHandle('Nouvelles fonctionnalités')).toBe('nouvelles-fonctionnalites');
    expect(slugifyHandle('  API  Server  ')).toBe('api-server');
    expect(slugifyHandle('C2-adversaire')).toBe('c2-adversaire');
  });

  it('keeps accented letters as letters instead of dropping them', () => {
    // "Réglages" losing its é would become "rglages" — unrecognisable.
    expect(slugifyHandle('Réglages')).toBe('reglages');
  });

  it('returns empty when nothing usable survives, so callers can fall back', () => {
    expect(slugifyHandle('🚀🚀')).toBe('');
    expect(slugifyHandle('---')).toBe('');
    expect(slugifyHandle(null)).toBe('');
  });

  it('never ends on a dash after truncation', () => {
    const h = slugifyHandle('a'.repeat(31) + ' ' + 'b'.repeat(10));
    expect(h.endsWith('-')).toBe(false);
    expect(h.length).toBeLessThanOrEqual(32);
  });
});

describe('assignHandles — seniority wins collisions', () => {
  const older = { id: 'aaa', name: 'api', createdAt: 100 };
  const newer = { id: 'bbb', name: 'API', createdAt: 200 };

  it('gives the bare handle to the older session', () => {
    const h = assignHandles([newer, older]);
    expect(h.get('aaa')).toBe('api');
    expect(h.get('bbb')).toBe('api-2');
  });

  it('is independent of input order', () => {
    const a = assignHandles([older, newer]);
    const b = assignHandles([newer, older]);
    expect([...a]).toEqual([...b]);
  });

  it('keeps the incumbent stable when a newcomer appears', () => {
    // The whole point: @api meant `aaa` yesterday and must still mean it.
    const before = assignHandles([older]);
    const after = assignHandles([older, newer]);
    expect(after.get('aaa')).toBe(before.get('aaa'));
  });

  it('chains suffixes past the first collision', () => {
    const h = assignHandles([
      { id: 'a', name: 'api', createdAt: 1 },
      { id: 'b', name: 'api', createdAt: 2 },
      { id: 'c', name: 'api', createdAt: 3 },
    ]);
    expect([h.get('a'), h.get('b'), h.get('c')]).toEqual(['api', 'api-2', 'api-3']);
  });
});

describe('assignHandles — fallbacks', () => {
  it('falls back to the cwd tail when the session is unnamed', () => {
    const h = assignHandles([{ id: 'x', name: null, cwd: '/srv/charon' }]);
    expect(h.get('x')).toBe('charon');
  });

  it('falls back to the id when there is nothing else', () => {
    const h = assignHandles([{ id: 'abcdef123456', name: null, cwd: null }]);
    expect(h.get('abcdef123456')).toBe('session-abcdef');
  });

  it('a name that slugs to nothing still gets a usable handle', () => {
    const h = assignHandles([{ id: 'z9', name: '🚀', cwd: '/var/www/html' }]);
    expect(h.get('z9')).toBe('html');
  });

  it('never emits a duplicate, whatever the inputs', () => {
    const h = assignHandles([
      { id: 'a', name: 'api', createdAt: 1 },
      { id: 'b', name: null, cwd: '/srv/api', createdAt: 2 },
      { id: 'c', name: '🚀', cwd: '/srv/api', createdAt: 3 },
    ]);
    const vals = [...h.values()];
    expect(new Set(vals).size).toBe(vals.length);
  });
});

describe('resolveHandle', () => {
  const h = assignHandles([
    { id: 'aaa', name: 'Frontend', createdAt: 1 },
    { id: 'bbb', name: 'frontend', createdAt: 2 },
  ]);

  it('resolves with or without the @, case-insensitively', () => {
    expect(resolveHandle(h, '@frontend')).toBe('aaa');
    expect(resolveHandle(h, 'FRONTEND')).toBe('aaa');
    expect(resolveHandle(h, 'frontend-2')).toBe('bbb');
  });

  it('returns null rather than guessing', () => {
    // Addressing the wrong agent is worse than addressing none.
    expect(resolveHandle(h, 'front')).toBeNull();
    expect(resolveHandle(h, '')).toBeNull();
    expect(resolveHandle(h, '@')).toBeNull();
  });
});
