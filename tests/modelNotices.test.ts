import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => new Map<string, string>());
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/claude/settings', () => ({
  getSetting: (key: string) => settings.get(key) ?? '',
  setSetting: (key: string, value: string) => { settings.set(key, value); },
}));

import { getModelNotices, markModelsSeen, observeModels, subscribeModelNotices } from '@/lib/server/claude/modelNotices';
import { getMergedModels, observeClaudeCliModels, refreshModels } from '@/lib/server/claude/modelSync';

const model = (id: string) => ({ id, label: id });

beforeEach(() => { settings.clear(); vi.restoreAllMocks(); });

describe('global model release notices', () => {
  it('establishes a separate silent baseline for each provider, ignoring empty catalogs', () => {
    observeModels('claude', []);
    observeModels('claude', [model('opus')]);
    observeModels('codex', []);
    expect(getModelNotices().revision).toBe(0);
    observeModels('claude', [model('claude-first-1')]);
    observeModels('codex', [model('gpt-first')]);
    expect(getModelNotices()).toMatchObject({ claude: [], codex: [] });
    observeModels('claude', [model('claude-second-2')]);
    expect(getModelNotices().claude).toEqual([model('claude-second-2')]);
    expect(getModelNotices().codex).toEqual([]);
  });

  it('deduplicates across VPSes, label changes, removals, and reappearing models', () => {
    observeModels('codex', [model('gpt-first')]);
    observeModels('codex', [model('gpt-new'), model('gpt-new')]);
    const revision = getModelNotices().revision;
    observeModels('codex', []);
    observeModels('codex', [{ id: 'gpt-new', label: 'renamed' }, model('gpt-first')]);
    expect(getModelNotices().revision).toBe(revision);
    expect(getModelNotices().codex).toEqual([model('gpt-new')]);
    markModelsSeen('codex', ['gpt-new']);
    observeModels('codex', [model('gpt-new')]);
    expect(getModelNotices().codex).toEqual([]);
  });

  it('acknowledges only rendered ids, preserving concurrent discoveries and the other provider', () => {
    observeModels('claude', [model('claude-first-1')]);
    observeModels('codex', [model('gpt-first')]);
    observeModels('codex', [model('gpt-new')]);
    const displayed = getModelNotices().codex.map((m) => m.id);
    observeModels('codex', [model('gpt-newer')]);
    observeModels('claude', [model('claude-second-2')]);
    markModelsSeen('codex', displayed);
    expect(getModelNotices()).toMatchObject({
      claude: [model('claude-second-2')], codex: [model('gpt-newer')],
    });
    const revision = getModelNotices().revision;
    markModelsSeen('codex', [...displayed, 'unknown']);
    expect(getModelNotices().revision).toBe(revision);
  });

  it('retains global acknowledgement after module reload (persisted backend state)', async () => {
    observeModels('codex', [model('gpt-first')]);
    observeModels('codex', [model('gpt-new')]);
    markModelsSeen('codex', ['gpt-new']);
    vi.resetModules();
    const restarted = await import('@/lib/server/claude/modelNotices');
    restarted.observeModels('codex', [model('gpt-new')]);
    expect(restarted.getModelNotices().codex).toEqual([]);
    restarted.observeModels('codex', [model('gpt-next')]);
    expect(restarted.getModelNotices().codex).toEqual([model('gpt-next')]);
  });

  it('broadcasts discovery and acknowledgement to every browser, then unsubscribes', () => {
    observeModels('codex', [model('gpt-first')]);
    const first = vi.fn(); const second = vi.fn();
    const stopFirst = subscribeModelNotices(first);
    const stopSecond = subscribeModelNotices(second);
    observeModels('codex', [model('gpt-new')]);
    markModelsSeen('codex', ['gpt-new']);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second.mock.calls).toEqual(first.mock.calls);
    expect(second.mock.lastCall?.[0].codex).toEqual([]);
    stopFirst(); stopSecond();
    observeModels('codex', [model('gpt-next')]);
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('treats Claude context/date variants as the same release and ignores bare aliases', () => {
    observeModels('claude', [model('claude-first-1')]);
    observeModels('claude', [model('claude-first-1-20260906[1m]'), model('newalias')]);
    expect(getModelNotices().claude).toEqual([]);
    observeModels('claude', [model('claude-second-2[1m]'), model('claude-second-2')]);
    expect(getModelNotices().claude).toEqual([model('claude-second-2')]);
  });
});

describe('catalog integration', () => {
  it('announces a CLI alias resolving to a new Claude release and offers it in Settings without an API key', () => {
    observeClaudeCliModels([{ id: 'opus', resolved: 'claude-test-99[1m]', label: 'Opus (latest)' }]);
    expect(getModelNotices().claude.map((m) => m.id)).toEqual(['claude-test-99']);
    expect(getMergedModels().some((m) => m.id === 'claude-test-99[1m]')).toBe(true);
    markModelsSeen('claude', ['claude-test-99']);
    observeClaudeCliModels([{ id: 'opus', resolved: 'claude-test-99[1m]' }]);
    expect(getModelNotices().claude).toEqual([]);
  });

  it('detects a newly synchronized API model and retains unread notices on a failed refresh', async () => {
    settings.set('claude.api_key', 'test-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: 'claude-test-99', display_name: 'Test 99' }],
    }))).mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    expect((await refreshModels()).ok).toBe(true);
    expect(getModelNotices().claude).toEqual([{ id: 'claude-test-99', label: 'Test 99' }]);
    expect((await refreshModels()).ok).toBe(false);
    expect(getModelNotices().claude).toEqual([{ id: 'claude-test-99', label: 'Test 99' }]);
  });
});
