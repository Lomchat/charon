'use client';
import { useEffect, useState } from 'react';
import type { CodexModelPick } from '@/lib/types/api';
import { getCodexModels, peekCodexModels } from './codexModelsCache';

type Props = {
  /** VPS whose Codex account drives the catalog. */
  vpsId: string;
  /** Currently selected id. Empty string = inherit the global default. */
  value: string;
  onChange: (id: string) => void;
  /** Displayed in the "(inherit …)" option. Falsy → "inherit (Codex default)". */
  inheritPlaceholder?: string;
  noInherit?: boolean;
  className?: string;
  id?: string;
};

/**
 * <CodexModelPicker> — drop-in <select> for OpenAI Codex model IDs. Mirror of
 * <ModelPicker> but sourced PER-VPS from the agent's list_codex_models RPC
 * (openai-codex .models()) instead of the hub-wide Claude catalog. Keeps the
 * "✎ enter a model id…" escape hatch so a model the catalog doesn't yet report
 * is still reachable. cf. migration-codex.md / §14.58.
 */
export default function CodexModelPicker({
  vpsId, value, onChange, inheritPlaceholder, noInherit, className, id,
}: Props) {
  const [models, setModels] = useState<CodexModelPick[]>(
    () => peekCodexModels(vpsId)?.models ?? [],
  );
  const [loaded, setLoaded] = useState(() => peekCodexModels(vpsId) != null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(peekCodexModels(vpsId) != null);
    setModels(peekCodexModels(vpsId)?.models ?? []);
    getCodexModels(vpsId)
      .then((r) => {
        if (cancelled) return;
        setModels(r.models ?? []);
        setError(r.ok ? null : (r.error ?? 'catalog unavailable'));
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message ?? e));
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [vpsId]);

  // Faithfully surface a current value the catalog doesn't (yet) list.
  const knownIds = new Set(models.map((m) => m.id));
  const customEntry = value && !knownIds.has(value)
    ? { id: value, label: `${value} (custom)`, hint: 'not in the catalog' } as CodexModelPick
    : null;
  const all = customEntry ? [...models, customEntry] : models;

  return (
    <select
      id={id}
      className={className}
      value={value}
      onChange={(e) => {
        if (e.target.value === '__custom__') {
          const v = (window.prompt('Enter a Codex model id (e.g. gpt-5-codex):', value) || '').trim();
          if (v) onChange(v);
          return;
        }
        onChange(e.target.value);
      }}
    >
      {!noInherit && (
        <option value="">
          {inheritPlaceholder ? `inherit (${inheritPlaceholder})` : 'inherit (Codex default)'}
        </option>
      )}
      {!loaded && all.length === 0 && <option value="" disabled>loading catalog…</option>}
      {loaded && error && all.length === 0 && (
        <option value="" disabled>— catalog unavailable ({error.slice(0, 40)}) —</option>
      )}
      {all.map((m) => (
        <option key={m.id} value={m.id} title={m.hint ?? ''}>
          {m.label}{m.isDefault ? ' (default)' : ''}{m.hint ? ` — ${m.hint}` : ''}
        </option>
      ))}
      <option value="__custom__">✎ enter a model id…</option>
    </select>
  );
}
