import { describe, expect, it } from 'vitest';
import {
  filterRankFiles, fileTier, isBroadRoot, normalizeRoot, queryTerms as serverTerms, selectSearchRoots,
} from '../lib/server/hub/fileSearchRoots';
import {
  emptyPicks, highlightRanges, lastPickedFor, parsePicks, pickBonus, queryTerms, recordPick, scoreFields,
} from '../app/searchRank';

// The palette's Files section runs agent walks from roots the HUB chooses:
// these pin which roots qualify (never a whole account) and the ranking.
describe('file search roots', () => {
  const c = (vpsId: string, path: string, usedAt = 1) => ({ vpsId, path, usedAt });

  it('skips /, home directories and relative or odd paths', () => {
    expect(isBroadRoot('/')).toBe(true);
    expect(isBroadRoot('/root')).toBe(true);
    expect(isBroadRoot('/home/manu')).toBe(true);
    expect(isBroadRoot('/home/manu/proj')).toBe(false);
    expect(isBroadRoot('/root/proj')).toBe(false);
    expect(normalizeRoot('rel/path')).toBeNull();
    expect(normalizeRoot('/srv/x/')).toBe('/srv/x');
    const out = selectSearchRoots([c('a', '/'), c('a', '/root/'), c('a', '/home/u'), c('a', 'rel'), c('a', '/srv/p')]);
    expect(out.map((r) => r.path)).toEqual(['/srv/p']);
  });

  it('dedupes, drops nested roots per VPS only, orders by recency, caps', () => {
    const out = selectSearchRoots([
      c('a', '/srv/p/', 5), c('a', '/srv/p', 9), c('a', '/srv/p/sub', 20),
      c('b', '/srv/p/sub', 3), c('a', '/srv/pp', 1),
    ]);
    expect(out).toEqual([
      { vpsId: 'a', path: '/srv/p', usedAt: 20 },
      { vpsId: 'b', path: '/srv/p/sub', usedAt: 3 },
      { vpsId: 'a', path: '/srv/pp', usedAt: 1 },
    ]);
    const many = Array.from({ length: 40 }, (_, i) => c('a', `/srv/r${i}`, i));
    const capped = selectSearchRoots(many);
    expect(capped).toHaveLength(24);
    expect(capped[0].path).toBe('/srv/r39');
  });
});

describe('file hit filter and rank', () => {
  const h = (path: string) => ({ path, size: 1, mtime: 1 });
  it('ANDs all terms on the relative path, case-insensitively', () => {
    const t = serverTerms('Search modal');
    const out = filterRankFiles([h('app/SearchModal.tsx'), h('app/Search.tsx'), h('modal/x.ts')], t);
    expect(out.map((x) => x.path)).toEqual(['app/SearchModal.tsx']);
  });
  it('ranks basename equals > starts-with > contains > path contains, shorter first', () => {
    const t = serverTerms('route');
    const out = filterRankFiles([
      h('route/index.ts'), h('a/b/myroute.ts'), h('a/route.ts'), h('a/routes.ts'), h('route.ts'),
    ], t);
    expect(out.map((x) => x.path)).toEqual(['route.ts', 'a/route.ts', 'a/routes.ts', 'a/b/myroute.ts', 'route/index.ts']);
    expect(fileTier('x/route.ts', ['route'])).toBe(1);
    expect(fileTier('x/y.ts', ['route'])).toBeNull();
  });
  it('limits the output', () => {
    const hits = Array.from({ length: 100 }, (_, i) => h(`d/f${i}.ts`));
    expect(filterRankFiles(hits, ['f'], 40)).toHaveLength(40);
  });
});

describe('palette matching', () => {
  it('requires every term; prefix beats word prefix beats substring beats other fields', () => {
    const t = queryTerms('  Foo  bar ');
    expect(t).toEqual(['foo', 'bar']);
    expect(scoreFields(['foo bar', ''], t, 2)).not.toBeNull();
    expect(scoreFields(['foo', ''], t, 2)).toBeNull();
    const prefix = scoreFields(['api server'], ['api'], 1)!;
    const word = scoreFields(['my api server'], ['api'], 1)!;
    const sub = scoreFields(['rapid'], ['api'], 1)!;
    const other = scoreFields(['zzz', 'api'], ['api'], 1)!;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(other);
  });
  it('highlights merged ranges', () => {
    expect(highlightRanges('Foo foobar', ['foo', 'oob'])).toEqual([[0, 3], [4, 8]]);
    expect(highlightRanges('abc', [])).toEqual([]);
  });
});

describe('picks', () => {
  it('counts picks, remembers the last pick per query, stays bounded', () => {
    let p = emptyPicks();
    p = recordPick(p, 'session:a', 'Foo', 1000);
    p = recordPick(p, 'session:a', 'foo', 2000);
    expect(p.k['session:a'].n).toBe(2);
    expect(lastPickedFor(p, ' FOO ')).toBe('session:a');
    expect(pickBonus(p, 'session:a', 2000)).toBeGreaterThan(pickBonus(p, 'session:zzz', 2000));
    for (let i = 0; i < 400; i++) p = recordPick(p, `k${i}`, `q${i}`, 3000 + i);
    expect(Object.keys(p.k).length).toBeLessThanOrEqual(200);
    expect(Object.keys(p.q).length).toBeLessThanOrEqual(50);
    expect(p.k['k399']).toBeTruthy();
  });
  it('survives corrupt storage', () => {
    expect(parsePicks('{nope')).toEqual(emptyPicks());
    expect(parsePicks('{"k":{"a":{"n":"x"}},"q":5}')).toEqual(emptyPicks());
  });
});
