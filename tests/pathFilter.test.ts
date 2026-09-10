import { describe, expect, it } from 'vitest';
import {
  buildFilterQuery, describeFilter, isFilterActive, isPathVisible,
  isVpsVisible, nextPathState, normalizePath, parsePathFilter, parseVpsFilter,
  pathState, withPathState,
} from '../app/pathFilter';

describe('normalizePath', () => {
  it('keeps the root as-is', () => {
    expect(normalizePath('/')).toBe('/');
  });

  it('drops trailing slashes and surrounding blanks', () => {
    expect(normalizePath('/srv/app/')).toBe('/srv/app');
    expect(normalizePath('  /srv/app  ')).toBe('/srv/app');
    expect(normalizePath('/srv/app///')).toBe('/srv/app');
  });

  it('treats empty and missing values as absent', () => {
    expect(normalizePath('')).toBeNull();
    expect(normalizePath('   ')).toBeNull();
    expect(normalizePath(null)).toBeNull();
    expect(normalizePath(undefined)).toBeNull();
  });
});

describe('parsePathFilter', () => {
  it('splits includes from `!` exclusions', () => {
    expect(parsePathFilter(['/srv/app', '!/srv/scratch'])).toEqual({
      include: ['/srv/app'],
      exclude: ['/srv/scratch'],
    });
  });

  it('normalizes and de-duplicates', () => {
    expect(parsePathFilter(['/srv/app/', '/srv/app', ' /srv/app '])).toEqual({
      include: ['/srv/app'],
      exclude: [],
    });
  });

  it('ignores blank values instead of matching everything', () => {
    expect(parsePathFilter(['', '   ', '!'])).toEqual({ include: [], exclude: [] });
  });

  it('finds the `!` after trimming, whichever side the space is on', () => {
    // Regression: testing the raw string turned a pasted " !/x" into an
    // include of a literal "!/x", which matches nothing — "hide one folder"
    // silently became "hide everything".
    expect(parsePathFilter([' !/srv/scratch'])).toEqual({
      include: [], exclude: ['/srv/scratch'],
    });
    expect(parsePathFilter(['! /srv/scratch'])).toEqual({
      include: [], exclude: ['/srv/scratch'],
    });
    expect(parsePathFilter(['  /srv/app  '])).toEqual({
      include: ['/srv/app'], exclude: [],
    });
  });

  it('does not lose an exclusion pasted with a leading space', () => {
    const filter = parsePathFilter(['/srv', ' !/srv/scratch']);
    expect(isPathVisible('/srv/app', filter)).toBe(true);
    expect(isPathVisible('/srv/scratch', filter)).toBe(false);
  });

  it('yields an inactive filter for no values', () => {
    expect(isFilterActive(parsePathFilter([]))).toBe(false);
  });
});

describe('isPathVisible', () => {
  it('shows everything when the filter is empty', () => {
    const filter = parsePathFilter([]);
    expect(isPathVisible('/anywhere', filter)).toBe(true);
    expect(isPathVisible(null, filter)).toBe(true);
  });

  it('matches by segment, not by string prefix', () => {
    const filter = parsePathFilter(['/srv/app']);
    expect(isPathVisible('/srv/app', filter)).toBe(true);
    expect(isPathVisible('/srv/app/src', filter)).toBe(true);
    // The regression this test exists for: a plain startsWith would pass.
    expect(isPathVisible('/srv/application', filter)).toBe(false);
  });

  it('treats a root include as "everything"', () => {
    expect(isPathVisible('/srv/app', parsePathFilter(['/']))).toBe(true);
  });

  it('hides an excluded subtree and keeps the rest', () => {
    const filter = parsePathFilter(['!/srv/scratch']);
    expect(isPathVisible('/srv/app', filter)).toBe(true);
    expect(isPathVisible('/srv/scratch', filter)).toBe(false);
    expect(isPathVisible('/srv/scratch/tmp', filter)).toBe(false);
  });

  it('lets an exclusion carve a branch out of an inclusion', () => {
    const filter = parsePathFilter(['/srv', '!/srv/scratch']);
    expect(isPathVisible('/srv/app', filter)).toBe(true);
    expect(isPathVisible('/srv/scratch/tmp', filter)).toBe(false);
  });

  it('lets a deeper inclusion beat a broader exclusion', () => {
    // The case that made this rule necessary: excluding "/" then including one
    // folder has to mean "only that folder", not "nothing at all".
    const filter = parsePathFilter(['!/', '/var/www/wesh']);
    expect(isPathVisible('/var/www/wesh', filter)).toBe(true);
    expect(isPathVisible('/var/www/wesh/src', filter)).toBe(true);
    expect(isPathVisible('/var/www/other', filter)).toBe(false);
    expect(isPathVisible('/', filter)).toBe(false);
  });

  it('still lets a deeper exclusion carve out of a broader inclusion', () => {
    const filter = parsePathFilter(['/srv', '!/srv/scratch']);
    expect(isPathVisible('/srv/app', filter)).toBe(true);
    expect(isPathVisible('/srv/scratch/tmp', filter)).toBe(false);
  });

  it('lets exclusion win over an equally specific inclusion', () => {
    const filter = parsePathFilter(['/srv/app', '!/srv/app']);
    expect(isPathVisible('/srv/app', filter)).toBe(false);
  });

  it('normalizes the candidate path too', () => {
    const filter = parsePathFilter(['/srv/app']);
    expect(isPathVisible('/srv/app/', filter)).toBe(true);
  });

  it('keeps entities whose path is unknown rather than hiding them', () => {
    const filter = parsePathFilter(['/srv/app']);
    expect(isPathVisible(null, filter)).toBe(true);
    expect(isPathVisible('', filter)).toBe(true);
  });

  it("hides an unknown path when the caller asks for it (shells: cwd=null)", () => {
    const filter = parsePathFilter(['/srv/app']);
    expect(isPathVisible(null, filter, 'hidden')).toBe(false);
    // With no filter at all, nothing is ever hidden — not even an unknown.
    expect(isPathVisible(null, parsePathFilter([]), 'hidden')).toBe(true);
  });

  it('excludes everything under `!/`, the mirror of a `/` include', () => {
    const filter = parsePathFilter(['!/']);
    expect(isPathVisible('/srv/app', filter)).toBe(false);
    expect(isPathVisible('/', filter)).toBe(false);
  });
});

describe('buildFilterQuery', () => {
  it('returns an empty string for an empty filter', () => {
    expect(buildFilterQuery({ include: [], exclude: [] })).toBe('');
  });

  it('round-trips through parsePathFilter', () => {
    const filter = parsePathFilter(['/srv/app', '/srv/api', '!/srv/scratch']);
    const query = buildFilterQuery(filter);
    const reparsed = parsePathFilter(new URLSearchParams(query).getAll('path'));
    expect(reparsed).toEqual(filter);
  });

  it('percent-encodes so a path with a space survives the round trip', () => {
    const filter = parsePathFilter(['/srv/my app']);
    const reparsed = parsePathFilter(
      new URLSearchParams(buildFilterQuery(filter)).getAll('path'),
    );
    expect(reparsed.include).toEqual(['/srv/my app']);
  });
});

describe('three-state path toggling', () => {
  it('cycles off → include → exclude → off', () => {
    expect(nextPathState('off')).toBe('include');
    expect(nextPathState('include')).toBe('exclude');
    expect(nextPathState('exclude')).toBe('off');
  });

  it('reports the state a path currently has', () => {
    const filter = parsePathFilter(['/a', '!/b']);
    expect(pathState('/a', filter)).toBe('include');
    expect(pathState('/b', filter)).toBe('exclude');
    expect(pathState('/c', filter)).toBe('off');
  });

  it('never leaves a path in both lists', () => {
    let filter = parsePathFilter([]);
    filter = withPathState(filter, '/a', 'include');
    filter = withPathState(filter, '/a', 'exclude');
    expect(filter).toEqual({ include: [], exclude: ['/a'] });
    filter = withPathState(filter, '/a', 'off');
    expect(filter).toEqual({ include: [], exclude: [] });
  });
});

describe('describeFilter', () => {
  it('reads as a sentence for a mixed filter', () => {
    expect(describeFilter(parsePathFilter(['/srv/app', '!/srv/scratch'])))
      .toBe('/srv/app — except /srv/scratch');
  });

  it('is empty when nothing is filtered', () => {
    expect(describeFilter(parsePathFilter([]))).toBe('');
  });
});

describe('parseVpsFilter', () => {
  it('splits on the ! prefix and dedupes', () => {
    expect(parseVpsFilter(['a', 'b', '!c', 'a'])).toEqual({
      include: ['a', 'b'], exclude: ['c'],
    });
  });

  it('finds the ! after trimming, like the path half', () => {
    expect(parseVpsFilter([' !c '])).toEqual({ include: [], exclude: ['c'] });
  });

  it('drops empty values, ! alone included', () => {
    expect(parseVpsFilter(['', '   ', '!', '! '])).toEqual({ include: [], exclude: [] });
  });
});

describe('isVpsVisible', () => {
  const none = parseVpsFilter([]);

  it('shows every machine when no rule is set', () => {
    expect(isVpsVisible('a', none)).toBe(true);
  });

  it('is an allow-list as soon as one machine is included', () => {
    const filter = parseVpsFilter(['a']);
    expect(isVpsVisible('a', filter)).toBe(true);
    expect(isVpsVisible('b', filter)).toBe(false);
  });

  it('hides only the excluded machine when nothing is included', () => {
    const filter = parseVpsFilter(['!a']);
    expect(isVpsVisible('a', filter)).toBe(false);
    expect(isVpsVisible('b', filter)).toBe(true);
  });

  // No hierarchy among machines, so no specificity ladder: a contradiction
  // resolves to hiding, the same safer reading the path half uses on a tie.
  it('lets an exclusion win over an inclusion of the same machine', () => {
    expect(isVpsVisible('a', parseVpsFilter(['a', '!a']))).toBe(false);
  });

  // The regression the whole dimension exists for: /srv/charon lives on two
  // boxes here, so the folder rule alone cannot mean one project.
  it('crosses with the path half by AND', () => {
    const vps = parseVpsFilter(['box-a']);
    const paths = parsePathFilter(['/srv/charon']);
    const shown = (v: string, p: string) => isVpsVisible(v, vps) && isPathVisible(p, paths);
    expect(shown('box-a', '/srv/charon')).toBe(true);
    expect(shown('box-b', '/srv/charon')).toBe(false);
    expect(shown('box-a', '/srv/other')).toBe(false);
  });
});

describe('buildFilterQuery with both halves', () => {
  it('round-trips through both parsers, machines first', () => {
    const paths = parsePathFilter(['/srv/app', '!/srv/scratch']);
    const vps = parseVpsFilter(['box-a', '!box-b']);
    const query = buildFilterQuery(paths, vps);
    expect(query).toBe('?vps=box-a&vps=%21box-b&path=%2Fsrv%2Fapp&path=%21%2Fsrv%2Fscratch');
    const params = new URLSearchParams(query.slice(1));
    expect(parsePathFilter(params.getAll('path'))).toEqual(paths);
    expect(parseVpsFilter(params.getAll('vps'))).toEqual(vps);
  });

  it('omits the vps half entirely when it is not passed', () => {
    expect(buildFilterQuery(parsePathFilter(['/srv/app']))).toBe('?path=%2Fsrv%2Fapp');
  });
});

describe('describeFilter with machines', () => {
  it('names machines rather than printing their ids', () => {
    expect(describeFilter(
      parsePathFilter(['/srv/charon']),
      parseVpsFilter(['e8c8d7b348e12a01']),
      (id) => (id === 'e8c8d7b348e12a01' ? 'WS_MASTER' : id),
    )).toBe('WS_MASTER — /srv/charon');
  });

  it('falls back to the id when the machine is unknown', () => {
    expect(describeFilter(parsePathFilter([]), parseVpsFilter(['gone']))).toBe('gone');
  });
});
