import { describe, it, expect } from 'vitest';
import { parseOpenCodeModels, mergeOpenCodeModels, isOpenCodeGo } from '@/lib/opencodeModels';
import { changeEndpointParam, endpointParameters, validEndpointEffort, type CustomEndpoint } from '@/lib/customEndpoints';
import { groupEndpointModels, isNewEndpointModel, modelReleaseDate } from '@/lib/endpointModelCatalog';

const table = parseOpenCodeModels({ 'opencode-go': { models: {
  deepseek: { name: 'DeepSeek', reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max', 'bogus'] }], limit: { context: 1_000_000, output: 384_000 }, modalities: { input: ['text', 'image'] }, cost: { input: 0.15, output: 0.6 } },
  qwen: { name: 'Qwen', reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', max: 81920 }], limit: { output: 65536 } },
  fixed: { name: 'MiniMax', reasoning: true, reasoning_options: [] },
} } });
function endpoint(id = 'deepseek'): CustomEndpoint {
  return mergeOpenCodeModels({ name: 'Go', baseUrl: 'https://opencode.ai/zen/go', model: id, auth: 'none', models: Object.keys(table).map((id) => ({ id, checks: {
    claude: { ok: true, engine: 'claude' as const, model: id, streaming: true, tools: true },
    codex: { ok: id === 'deepseek', engine: 'codex' as const, model: id, streaming: true, tools: true },
  } })) }, table);
}
describe('OpenCode model information and parameter axes', () => {
  it('uses actual release dates, rejects impossible dates and ignores catalog update dates', () => {
    const models = parseOpenCodeModels({ 'opencode-go': { models: {
      released: { name: 'New model', family: 'qwen3.8-max', release_date: '2026-09-02', last_updated: '2026-09-16' },
      unknown: { name: 'Unknown', release_date: '2026-02-30', last_updated: '2026-09-16' },
    } } });
    expect(models.released.info).toMatchObject({ family: 'qwen3.8-max', releaseDate: '2026-09-02' });
    expect(models.unknown.info?.releaseDate).toBeUndefined();
    expect(modelReleaseDate('2026-09')).toBeUndefined();
    const now = Date.parse('2026-09-16T23:59:59Z');
    expect(isNewEndpointModel(models.released, now)).toBe(true);
    expect(isNewEndpointModel(models.released, Date.parse('2026-09-17'))).toBe(false);
    expect(isNewEndpointModel(models.released, Date.parse('2026-09-01'))).toBe(false);
    expect(isNewEndpointModel(models.unknown, now)).toBe(false);
  });
  it('puts new releases first, then families with newest first and unknown dates last, without duplicates', () => {
    const models = [
      { id: 'qwen-old', info: { name: 'Qwen old', family: 'qwen3.6', releaseDate: '2026-04-02' } },
      { id: 'custom-model' }, { id: 'deepseek-flash' },
      { id: 'qwen-max', info: { name: 'Qwen Max', family: 'qwen3.8-max', releaseDate: '2026-08-03' } },
      { id: 'deepseek-v4.1-flash', info: { name: 'DeepSeek', family: 'deepseek-flash', releaseDate: '2026-09-10' } },
      { id: 'deepseek-pro', info: { name: 'DeepSeek Pro', family: 'deepseek-thinking', releaseDate: '2026-04-24' } },
      { id: 'minimax', info: { name: 'MiniMax', family: 'minimax-m3', releaseDate: '2026-09-12' } },
    ];
    const groups = groupEndpointModels(models, Date.parse('2026-09-16'));
    expect(groups.map((g) => [g.label, g.models.map((m) => m.id)])).toEqual([
      ['New releases', ['minimax', 'deepseek-v4.1-flash']],
      ['DeepSeek', ['deepseek-pro', 'deepseek-flash']],
      ['Qwen', ['qwen-max', 'qwen-old']], ['Other models', ['custom-model']],
    ]);
    expect(groups.flatMap((g) => g.models)).toHaveLength(models.length);
    expect(models[0].id).toBe('qwen-old');
  });
  it('enriches exact Go models without granting compatibility or adding models', () => {
    const go = endpoint();
    expect(go.models?.[0].info).toMatchObject({ name: 'DeepSeek', input: ['text', 'image'], price: { input: 0.15, output: 0.6 } });
    expect(endpointParameters(go, 'claude', 'deepseek')[0].values.map((v) => v.value)).toEqual(['low', 'high', 'max']);
    expect(endpointParameters(go, 'codex', 'qwen')).toEqual([]);
    expect(mergeOpenCodeModels({ ...go, model: 'unknown', models: [{ id: 'unknown' }] }, table).models).toEqual([{ id: 'unknown' }]);
    expect(mergeOpenCodeModels<CustomEndpoint>({ ...go, models: [] }, table).models?.map((m) => m.id)).toEqual(['deepseek']);
    for (const url of ['http://opencode.ai/zen/go', 'https://evil.test/zen/go', 'https://opencode.ai/zen', 'https://opencode.ai:8443/zen/go']) expect(isOpenCodeGo(url)).toBe(false);
  });
  it('offers only declared controls, with budgets on Messages only', () => {
    expect(endpointParameters(endpoint(), 'claude', 'fixed')).toEqual([]);
    const qwen = endpointParameters(endpoint(), 'claude', 'qwen');
    expect(qwen.map((p) => p.id)).toEqual(['thinking', 'budget_tokens']);
    expect(table.qwen.parameters?.codex).toEqual([]);
    expect(qwen[1].values.at(-1)?.value).toBe('32768');
    expect(JSON.stringify(table)).not.toContain('"fast"');
  });
  it('validates model-specific combinations and clears dependent knobs when thinking is off', () => {
    expect(validEndpointEffort(endpoint(), 'claude', 'deepseek', 'effort=max')).toBe(true);
    expect(validEndpointEffort(endpoint(), 'claude', 'deepseek', 'max')).toBe(true);
    for (const raw of ['effort=medium', 'fast=true', 'effort=max&effort=low', 'effort=max&token=secret']) expect(validEndpointEffort(endpoint(), 'claude', 'deepseek', raw)).toBe(false);
    expect(changeEndpointParam('budget_tokens=16384&thinking=true', 'thinking', 'false')).toBe('thinking=false');
    expect(changeEndpointParam('thinking=false', 'budget_tokens', '4096')).toBe('budget_tokens=4096&thinking=true');
    expect(validEndpointEffort(endpoint(), 'claude', 'qwen', 'budget_tokens=4096&thinking=false')).toBe(false);
    expect(validEndpointEffort(endpoint(), 'claude', 'qwen', null)).toBe(true);
  });
});
