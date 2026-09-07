import { beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ settings: new Map<string, string>(), call: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/claude/settings', () => ({
  getSetting: (key: string) => fake.settings.get(key) ?? '',
  setSetting: (key: string, value: string) => { fake.settings.set(key, value); },
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ call: fake.call }),
}));

import { getCodexModelsForVps } from '@/lib/server/claude/codexModels';
import { getModelNotices } from '@/lib/server/claude/modelNotices';

beforeEach(() => { fake.settings.clear(); fake.call.mockReset(); });

it('discovers visible Codex models across VPSes and preserves unread state on unavailable catalogs', async () => {
  fake.call.mockResolvedValueOnce({ ok: true, models: [{ id: 'old' }] });
  await getCodexModelsForVps('baseline');
  expect(getModelNotices().codex).toEqual([]);
  fake.call.mockResolvedValueOnce({ ok: true, models: [
    { id: 'old' }, { id: 'new', display_name: 'New Codex' }, { id: 'private', hidden: true },
  ] });
  await getCodexModelsForVps('second-vps');
  expect(getModelNotices().codex).toEqual([{ id: 'new', label: 'New Codex' }]);
  fake.call.mockRejectedValueOnce(new Error('offline'));
  expect((await getCodexModelsForVps('offline')).ok).toBe(false);
  expect(getModelNotices().codex).toEqual([{ id: 'new', label: 'New Codex' }]);
});

it('shares the watcher/picker RPC when both request the same VPS concurrently', async () => {
  let resolve!: (value: unknown) => void;
  fake.call.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const first = getCodexModelsForVps('concurrent');
  const second = getCodexModelsForVps('concurrent');
  expect(fake.call).toHaveBeenCalledTimes(1);
  resolve({ ok: true, models: [{ id: 'old' }] });
  expect(await second).toEqual(await first);
});
