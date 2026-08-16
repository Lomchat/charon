import { describe, expect, it } from 'vitest';
import { publishFsChanged, subscribeFsChanged } from '@/app/fsChangeBus';

describe('fsChangeBus', () => {
  it('normalizes absolute paths and keeps the originating VPS', () => {
    const seen: Array<{ vpsId: string; paths: string[] }> = [];
    const unsubscribe = subscribeFsChanged((vpsId, paths) => seen.push({ vpsId, paths }));
    try {
      publishFsChanged('vps-a', ['/srv/app/a.ts', 12, 'relative']);
      publishFsChanged('', ['/srv/app/ignored.ts']);
    } finally {
      unsubscribe();
    }
    expect(seen).toEqual([{ vpsId: 'vps-a', paths: ['/srv/app/a.ts'] }]);
  });
});
