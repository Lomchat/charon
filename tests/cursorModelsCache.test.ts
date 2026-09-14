import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getCursorModels: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { getCursorModels: mocks.getCursorModels },
}));

import { getCursorModels, invalidateCursorModels } from '@/app/cursorModelsCache';

describe('Cursor model cache', () => {
  beforeEach(() => {
    mocks.getCursorModels.mockReset();
    invalidateCursorModels();
  });

  it('retries business errors returned with HTTP 200', async () => {
    mocks.getCursorModels.mockResolvedValue({
      ok: false,
      models: [],
      reason: 'auth',
      error: 'sign in required',
    });

    await getCursorModels('vps-1');
    await getCursorModels('vps-1');

    expect(mocks.getCursorModels).toHaveBeenCalledTimes(2);
  });

  it('reuses successful responses until invalidated', async () => {
    mocks.getCursorModels.mockResolvedValue({ ok: true, models: [] });

    await getCursorModels('vps-1');
    await getCursorModels('vps-1');
    expect(mocks.getCursorModels).toHaveBeenCalledTimes(1);

    invalidateCursorModels('vps-1');
    await getCursorModels('vps-1');
    expect(mocks.getCursorModels).toHaveBeenCalledTimes(2);
  });

  it('does not let an invalidated request repopulate the cache', async () => {
    let finishOld!: (value: unknown) => void;
    const old = new Promise((resolve) => { finishOld = resolve; });
    mocks.getCursorModels
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce({ ok: true, models: [{ id: 'new', label: 'new' }] });

    const staleRequest = getCursorModels('vps-1');
    invalidateCursorModels('vps-1');
    await getCursorModels('vps-1');
    finishOld({ ok: true, models: [{ id: 'old', label: 'old' }] });
    await staleRequest;

    expect((await getCursorModels('vps-1')).models[0]?.id).toBe('new');
    expect(mocks.getCursorModels).toHaveBeenCalledTimes(2);
  });
});
