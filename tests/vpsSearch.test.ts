import { describe, it, expect } from 'vitest';
import { buildVpsSearch } from '../app/vpsSearch';
import type { Vps, VpsPath } from '../lib/db/schema';

// ── VPS filter shared by the « VPS & paths » modal and the new-session
// wizard. The contract that matters to the UI:
//   - empty query ⇒ `active:false`, callers skip filtering entirely (a
//     filtered render also DISABLES drag-and-drop in DataModal);
//   - a match may come from the name, the host, or a PROJECT path, and the
//     matched projects come back so the row can say why it survived;
//   - several words = AND, so typing more always narrows.

function mkVps(over: Partial<Vps> & { id: string; name: string; ip: string }): Vps {
  return {
    sshUser: 'root', sshPort: 22, defaultPath: null,
    folderId: 'default', position: 0,
    agentStatus: 'ok',
    ...over,
  } as unknown as Vps;
}
function mkPath(id: number, vpsId: string, path: string, label: string | null = null): VpsPath {
  return { id, vpsId, path, label, createdAt: 0 } as unknown as VpsPath;
}

const charon = mkVps({ id: 'v1', name: 'chalco', ip: '10.0.0.1' });
const prod = mkVps({ id: 'v2', name: 'prod-eu', ip: '51.75.10.20', defaultPath: '/srv/shop' });
const spare = mkVps({ id: 'v3', name: 'spare', ip: '10.0.0.9' });
const list = [charon, prod, spare];
const paths: VpsPath[] = [
  mkPath(1, 'v1', '/srv/charon', 'hub'),
  mkPath(2, 'v1', '/srv/notes'),
  mkPath(3, 'v3', '/srv/charon-staging'),
];

describe('buildVpsSearch', () => {
  it('is inactive on an empty query and keeps the list untouched', () => {
    for (const q of ['', '   ']) {
      const s = buildVpsSearch(q, paths);
      expect(s.active).toBe(false);
      expect(s.filter(list)).toEqual(list);
    }
  });

  it('matches on name, ip and ssh user, case-insensitively', () => {
    expect(buildVpsSearch('CHAL', paths).filter(list)).toEqual([charon]);
    expect(buildVpsSearch('51.75', paths).filter(list)).toEqual([prod]);
    expect(buildVpsSearch('root@10.0.0.9', paths).filter(list)).toEqual([spare]);
  });

  it('matches on a project path and reports which one matched', () => {
    const s = buildVpsSearch('charon', paths);
    expect(s.filter(list)).toEqual([charon, spare]);
    expect(s.match(charon).paths).toEqual(['/srv/charon']);
    expect(s.match(spare).paths).toEqual(['/srv/charon-staging']);
    // A row matched on its NAME reports no project — the hint stays silent.
    expect(buildVpsSearch('spare', paths).match(spare).paths).toEqual([]);
  });

  it('matches on a project label and on the default path', () => {
    expect(buildVpsSearch('hub', paths).filter(list)).toEqual([charon]);
    expect(buildVpsSearch('shop', paths).filter(list)).toEqual([prod]);
    expect(buildVpsSearch('shop', paths).match(prod).paths).toEqual(['/srv/shop']);
  });

  it('combines several terms with AND (typing more always narrows)', () => {
    expect(buildVpsSearch('charon staging', paths).filter(list)).toEqual([spare]);
    expect(buildVpsSearch('charon nope', paths).filter(list)).toEqual([]);
  });

  it('reports no match rather than falling back to fuzzy', () => {
    // 'cln' fuzzy-matches "chalco" — it must NOT match here.
    expect(buildVpsSearch('cln', paths).filter(list)).toEqual([]);
  });
});
