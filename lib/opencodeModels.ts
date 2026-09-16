import type { EndpointModel, CustomEndpoint } from './customEndpoints';
import type { CursorModelParameter } from './types/api';

export function isOpenCodeGo(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.origin === 'https://opencode.ai' && url.pathname.replace(/\/$/, '') === '/zen/go';
  } catch { return false; }
}
const count = (n: unknown): number | undefined => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 100_000_000 ? n : undefined;
const text = (s: unknown, max: number): string | undefined => typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : undefined;
const money = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 10000 ? n : null;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** Models.dev is also OpenCode's source. Never infer capabilities from model names. */
export function parseOpenCodeModels(raw: unknown): Record<string, EndpointModel> {
  const models = (raw as any)?.['opencode-go']?.models;
  if (!models || typeof models !== 'object') return {};
  const table: Record<string, EndpointModel> = {};
  for (const [id, value] of Object.entries(models).slice(0, 500)) {
    const m = value as any;
    if (!m || typeof m !== 'object' || id.length > 256 || !text(m.name, 120)) continue;
    const options = Array.isArray(m.reasoning_options) ? m.reasoning_options : [];
    const levels = options.find((v: any) => v?.type === 'effort')?.values;
    const effort = Array.isArray(levels) ? [...new Set(levels.filter((v): v is string => EFFORTS.has(v)))].slice(0, 8) : [];
    const claude: CursorModelParameter[] = [];
    const codex: CursorModelParameter[] = [];
    if (effort.length) {
      const axis = { id: 'effort', label: 'Effort', values: effort.map((value) => ({ value })) };
      claude.push(axis); codex.push(axis);
    }
    if (options.some((v: any) => v?.type === 'toggle')) {
      const axis = { id: 'thinking', label: 'Thinking', values: [{ value: 'true' }, { value: 'false' }] };
      claude.push(axis);
      // Responses has no thinking object. Its toggle needs an explicit effort
      // for On; omitting reasoning would merely inherit an unknown default.
      if (effort.some((v) => v !== 'none')) codex.push(axis);
    }
    // The Messages API supports token budgets; Responses exposes effort instead.
    // As in OpenCode, prefer the named ladder when the model declares both.
    const budget = options.find((v: any) => v?.type === 'budget_tokens');
    const outputTokens = count(m.limit?.output);
    if (!effort.length && budget && outputTokens) {
      const max = Math.min(count(budget.max) ?? 32768, outputTokens - 1, 32768);
      const values = [1024, 4096, 16384, 32768].filter((n) => n <= max && n >= (count(budget.min) ?? 1024));
      if (values.length) claude.push({ id: 'budget_tokens', label: 'Thinking budget', values: values.map((n) => ({ value: String(n), label: `${n / 1024}K tokens` })) });
    }
    const input = Array.isArray(m.modalities?.input) ? m.modalities.input.filter((s: unknown) => typeof s === 'string' && ['text', 'image', 'video', 'audio', 'pdf'].includes(s)) : undefined;
    const price = money(m.cost?.input) != null && money(m.cost?.output) != null ? {
      input: money(m.cost.input)!, output: money(m.cost.output)!, cacheRead: money(m.cost.cache_read), cacheWrite: money(m.cost.cache_write), provider: 'OpenCode Go',
    } : undefined;
    table[id] = { id, contextWindow: count(m.limit?.context), info: {
      name: text(m.name, 120)!, description: text(m.description, 400), input, outputTokens,
      reasoning: typeof m.reasoning === 'boolean' ? m.reasoning : undefined,
      tools: typeof m.tool_call === 'boolean' ? m.tool_call : undefined,
      price, tieredPrice: Array.isArray(m.cost?.tiers) && m.cost.tiers.length > 0,
    }, parameters: { claude, codex } };
  }
  return table;
}
/** Enrich existing ids only; metadata never grants compatibility or changes the connection. */
export function mergeOpenCodeModels<T extends CustomEndpoint>(endpoint: T, table: Record<string, EndpointModel>): T {
  if (!isOpenCodeGo(endpoint.baseUrl)) return endpoint;
  const catalog = [...(endpoint.models ?? [])];
  // A manually entered, successfully tested id need not appear in /models.
  if (!catalog.some((m) => m.id === endpoint.model)) catalog.push({ id: endpoint.model });
  const models = catalog.map((m) => {
    const meta = table[m.id];
    return meta ? { ...m, ...meta, checks: m.checks && Object.fromEntries(Object.entries(m.checks).map(([engine, check]) =>
      [engine, { ...check, contextWindow: check?.contextWindow ?? meta.contextWindow }])) } : m;
  });
  return { ...endpoint, models };
}
