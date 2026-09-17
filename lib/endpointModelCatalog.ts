import type { EndpointModel } from './customEndpoints';
import { providerName } from './providerText';

const DAY = 86_400_000;
/** Catalog release dates, never the provider's catalog-entry creation timestamp. */
export function modelReleaseDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}
export function isNewEndpointModel(model: EndpointModel, now = Date.now()): boolean {
  const date = modelReleaseDate(model.info?.releaseDate);
  if (!date) return false;
  const age = Math.floor(now / DAY) - Date.parse(date) / DAY;
  return age >= 0 && age < 15;
}
const FAMILIES: Record<string, string> = {
  deepseek: 'DeepSeek', qwen: 'Qwen', minimax: 'MiniMax', kimi: 'Kimi', gpt: 'GPT',
  claude: providerName('claude'), gemini: 'Gemini', glm: 'GLM', grok: 'Grok', mimo: 'MiMo',
  longcat: 'LongCat', hy: 'Hunyuan', muse: 'Muse', llama: 'Llama', mistral: 'Mistral',
};
/** Display grouping only: a name must never grant API compatibility or controls. */
export function endpointModelFamily(model: EndpointModel): string {
  const family = model.info?.family;
  const key = (family || model.id.split('/').at(-1) || '').toLowerCase().match(/^[a-z]+/)?.[0];
  return (key && FAMILIES[key]) || family || 'Other models';
}
export function groupEndpointModels(models: EndpointModel[], now = Date.now()): { label: string; models: EndpointModel[] }[] {
  const byRelease = (a: EndpointModel, b: EndpointModel) =>
    (modelReleaseDate(b.info?.releaseDate) || '').localeCompare(modelReleaseDate(a.info?.releaseDate) || '')
    || (a.info?.name || a.id).localeCompare(b.info?.name || b.id, 'en', { numeric: true }) || a.id.localeCompare(b.id);
  const recent: EndpointModel[] = [], families = new Map<string, EndpointModel[]>();
  for (const model of models) {
    if (isNewEndpointModel(model, now)) { recent.push(model); continue; }
    const family = endpointModelFamily(model);
    if (!families.has(family)) families.set(family, []);
    families.get(family)!.push(model);
  }
  return [
    ...(recent.length ? [{ label: 'New releases', models: recent.sort(byRelease) }] : []),
    ...[...families].sort(([a], [b]) => a === b ? 0 : a === 'Other models' ? 1 : b === 'Other models' ? -1 : a.localeCompare(b, 'en'))
      .map(([label, group]) => ({ label, models: group.sort(byRelease) })),
  ];
}
