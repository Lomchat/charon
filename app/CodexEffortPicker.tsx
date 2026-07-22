'use client';
import { useEffect, useState } from 'react';
import type { CodexModelPick } from '@/lib/types/api';
import { CODEX_CANONICAL_EFFORTS } from '@/lib/types/api';
import { getCodexModels, peekCodexModels } from './codexModelsCache';

type Props = {
  vpsId: string;
  /** Current effort. Empty string = inherit. */
  value: string;
  onChange: (v: string) => void;
  /** When set, options are filtered to THIS model's supported efforts (catalog).
   *  Empty/unknown id → fall back to the union across models (∪ canonical). */
  modelId?: string;
  inheritPlaceholder?: string;
  noInherit?: boolean;
  className?: string;
  style?: React.CSSProperties;
  id?: string;
};

/**
 * <CodexEffortPicker> — drop-in <select> for the Codex reasoning-effort level,
 * derived from the per-VPS Codex catalog (list_codex_models → per-model
 * `efforts`), mirroring <EffortPicker> for Claude. Falls back to
 * CODEX_CANONICAL_EFFORTS (low/medium/high/xhigh) when no live data. 'ultra' is
 * Codex's Workflow-delegation tier (analog of Claude's 'ultracode') and surfaces
 * on its own if the catalog reports it.
 */
export default function CodexEffortPicker({
  vpsId, value, onChange, modelId, inheritPlaceholder, noInherit, className, style, id,
}: Props) {
  const [models, setModels] = useState<CodexModelPick[]>(() => peekCodexModels(vpsId)?.models ?? []);
  const [globalEfforts, setGlobalEfforts] = useState<string[]>(
    () => peekCodexModels(vpsId)?.efforts ?? [...CODEX_CANONICAL_EFFORTS],
  );

  useEffect(() => {
    let cancelled = false;
    getCodexModels(vpsId).then((r) => {
      if (cancelled) return;
      setModels(r.models ?? []);
      setGlobalEfforts(r.efforts?.length ? r.efforts : [...CODEX_CANONICAL_EFFORTS]);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [vpsId]);

  const model = modelId ? models.find((m) => m.id === modelId) : undefined;
  const perModel = model && Array.isArray(model.efforts) ? model.efforts : null;
  const baseOptions = perModel && perModel.length
    ? perModel
    : (globalEfforts.length ? globalEfforts : [...CODEX_CANONICAL_EFFORTS]);

  // Faithfully show a current value the computed list doesn't include.
  const options = value && !baseOptions.includes(value)
    ? [...baseOptions, value]
    : baseOptions;

  return (
    <select
      id={id}
      className={className}
      style={style}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {!noInherit && (
        <option value="">
          {inheritPlaceholder ? `inherit (${inheritPlaceholder})` : 'inherit (Codex default)'}
        </option>
      )}
      {options.map((lvl) => (
        <option key={lvl} value={lvl}>{lvl}</option>
      ))}
    </select>
  );
}
