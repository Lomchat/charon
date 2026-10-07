import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => new Map<string, string>());
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/claude/settings', () => ({
  getSetting: (key: string) => settings.get(key) ?? '',
  setSetting: (key: string, value: string) => { settings.set(key, value); },
}));

import { fetchLiveModels, getMergedModels, getModelsAndEfforts, refreshModels } from '@/lib/server/claude/modelSync';
import { getModelNotices } from '@/lib/server/claude/modelNotices';

beforeEach(() => { settings.clear(); vi.restoreAllMocks(); });

const concrete = () => getMergedModels().filter((m) => m.group !== 'aliases');

describe('Claude API-only versioned catalog', () => {
  it('offers no predefined models or legacy CLI discoveries before a successful API sync', () => {
    settings.set('claude.cli_models_cache', JSON.stringify([
      { id: 'claude-cli-only-99', label: 'CLI discovery', group: 'current' },
    ]));
    expect(concrete()).toEqual([]);
    expect(getModelsAndEfforts().efforts.length).toBeGreaterThan(0);
    expect(getMergedModels().some((m) => m.id === 'opusplan')).toBe(false);
  });

  it('preserves API release order and provider labels/efforts across pagination', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { id: 'claude-newfamily-9', display_name: 'Newest model', capabilities: {
            effort: { supported: true, high: { supported: true }, extreme: { supported: true } },
          } },
          { id: 'claude-sonnet-4-6', display_name: 'Provider Sonnet label' },
        ], has_more: true, last_id: 'claude-sonnet-4-6',
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'claude-opus-4-6', display_name: 'Older model' }], has_more: false,
      })));
    const models = await fetchLiveModels('test-key');
    settings.set('claude.models_cache', JSON.stringify(models));
    expect(concrete().map((m) => m.id)).toEqual([
      'claude-newfamily-9', 'claude-sonnet-4-6', 'claude-opus-4-6',
    ]);
    expect(concrete()[0].efforts).toEqual(['high', 'extreme']);
    expect(concrete()[1].label).toBe('Provider Sonnet label');
    expect(concrete().every((m) => m.group === 'current')).toBe(true);
    expect(fetch.mock.calls[1][0]).toBe('https://api.anthropic.com/v1/models?limit=100&after_id=claude-sonnet-4-6');
  });

  it('normalizes legacy API groups and rejects malformed or duplicate cache entries', () => {
    settings.set('claude.models_cache', JSON.stringify([
      null, { id: 'claude-opus-4-6', label: 'API model', group: 'previous' },
      { id: 'opusplan', label: 'Unrelated alias' },
      { id: 'claude-opus-4-6', label: 'Duplicate' }, { id: 'claude-invalid-1' },
    ]));
    expect(concrete()).toEqual([{ id: 'claude-opus-4-6', label: 'API model', group: 'current' }]);
    settings.set('claude.models_cache', '{broken');
    expect(concrete()).toEqual([]);
  });

  it('replaces the catalog on successful sync and establishes a silent first baseline', async () => {
    settings.set('claude.api_key', 'test-key');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [
        { id: 'claude-first-1', display_name: 'First model' },
      ] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [
        { id: 'claude-second-2', display_name: 'Second model' },
      ] })));
    expect((await refreshModels()).ok).toBe(true);
    expect(getModelNotices().claude).toEqual([]);
    expect((await refreshModels()).ok).toBe(true);
    expect(concrete().map((m) => m.id)).toEqual(['claude-second-2']);
    expect(getModelNotices().claude).toEqual([{ id: 'claude-second-2', label: 'Second model' }]);
  });

  it('keeps the last successful API catalog when no API key is configured', async () => {
    settings.set('claude.models_cache', JSON.stringify([
      { id: 'claude-api-1', label: 'Cached API model', group: 'current' },
    ]));
    expect(await refreshModels()).toMatchObject({ ok: false, error: 'no api key configured' });
    expect(concrete().map((m) => m.id)).toEqual(['claude-api-1']);
  });
});
