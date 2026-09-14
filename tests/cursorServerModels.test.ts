import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  call: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  vps: { id: 'id' },
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ all: () => [{ id: 'test-vps', agentStatus: 'ok' }] }),
      }),
    }),
  },
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ call: mocks.call }),
}));
vi.mock('@/lib/server/claude/settings', () => ({
  getSetting: (key: string) => mocks.store.get(key) || '',
  setSetting: (key: string, value: string) => mocks.store.set(key, value),
}));
vi.mock('@/lib/server/claude/cursorPricing', () => ({ getCursorPricing: async () => ({}) }));
vi.mock('@/lib/modelPricing', () => ({ priceFor: () => ({}) }));

import {
  getCursorModelsForVps,
  invalidateCursorModels,
  refreshCursorModelsForVps,
} from '@/lib/server/claude/cursorModels';

describe('server Cursor model cache', () => {
  beforeEach(() => {
    invalidateCursorModels();
    mocks.store.clear();
    mocks.call.mockReset();
  });

  it('removes the prior account from memory and persistent storage', async () => {
    mocks.call.mockResolvedValueOnce({
      ok: true, models: [{ id: 'old-account-model', label: 'old' }],
    });
    await refreshCursorModelsForVps('test-vps');
    expect(JSON.parse(mocks.store.get('cursor.models_cache') || '{}')['test-vps'])
      .toBeDefined();

    invalidateCursorModels('test-vps');
    expect(JSON.parse(mocks.store.get('cursor.models_cache') || '{}')['test-vps'])
      .toBeUndefined();

    mocks.call.mockResolvedValue({
      ok: true, models: [{ id: 'new-account-model', label: 'new' }],
    });
    const result = await getCursorModelsForVps('test-vps');
    expect(result.models[0]?.id).toBe('new-account-model');
  });

  it('does not let a request from the prior account overwrite a fresh one', async () => {
    let finishOld!: (value: unknown) => void;
    const old = new Promise((resolve) => { finishOld = resolve; });
    mocks.call
      .mockReturnValueOnce(old)
      .mockResolvedValue({
        ok: true, models: [{ id: 'new-account-model', label: 'new' }],
      });

    const stale = refreshCursorModelsForVps('race-vps');
    invalidateCursorModels('race-vps');
    const fresh = refreshCursorModelsForVps('race-vps');
    finishOld({ ok: true, models: [{ id: 'old-account-model', label: 'old' }] });
    await Promise.all([stale, fresh]);

    expect((await getCursorModelsForVps('race-vps')).models[0]?.id)
      .toBe('new-account-model');
    const persisted = JSON.parse(mocks.store.get('cursor.models_cache') || '{}');
    expect(persisted['race-vps']?.models[0]?.id).toBe('new-account-model');
  });
});
