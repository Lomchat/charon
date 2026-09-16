import { describe, it, expect } from 'vitest';
import { parseOpenCodeModels, mergeOpenCodeModels, isOpenCodeGo } from '@/lib/opencodeModels';
import { changeEndpointParam, endpointParameters, validEndpointEffort, type CustomEndpoint } from '@/lib/customEndpoints';

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
  it('enriches exact Go models without granting compatibility or adding models', () => {
    const go = endpoint();
    expect(go.models?.[0].info).toMatchObject({ name: 'DeepSeek', input: ['text', 'image'], price: { input: 0.15, output: 0.6 } });
    expect(endpointParameters(go, 'claude', 'deepseek')[0].values.map((v) => v.value)).toEqual(['low', 'high', 'max']);
    expect(endpointParameters(go, 'codex', 'qwen')).toEqual([]);
    expect(mergeOpenCodeModels({ ...go, model: 'unknown', models: [{ id: 'unknown' }] }, table).models).toEqual([{ id: 'unknown' }]);
    expect(mergeOpenCodeModels({ ...go, models: [] }, table).models?.map((m) => m.id)).toEqual(['deepseek']);
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
