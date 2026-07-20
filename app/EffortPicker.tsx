'use client';
import { useEffect, useState } from 'react';
import type { KnownClaudeModel } from '@/lib/types/api';
import { CANONICAL_EFFORTS } from '@/lib/types/api';
import { getModels, getEfforts, peekModels, peekEfforts } from './modelsCache';

type Props = {
  /** Current effort. Empty string = inherit. */
  value: string;
  onChange: (v: string) => void;
  /** When set, the options are filtered to THIS model's supported levels (from
   *  the live catalog). Empty/unknown id → fall back to the global union. */
  modelId?: string;
  /** Text inside the "inherit (…)" option. Falsy → "inherit (global default)". */
  inheritPlaceholder?: string;
  /** Omit the inherit option entirely. */
  noInherit?: boolean;
  className?: string;
  style?: React.CSSProperties;
  id?: string;
};

/**
 * <EffortPicker> — drop-in <select> for the Claude effort level, with options
 * DERIVED FROM THE LIVE CATALOG instead of a hardcoded list. Replaces the
 * `EFFORT_OPTIONS` arrays previously duplicated in NewSessionDialog /
 * NewSessionSheet / SettingsModal / ModelEffortBadges (cf. §14 gotcha 35).
 *
 * - With a `modelId`, shows exactly the levels that model supports
 *   (`capabilities.effort` from GET /v1/models): e.g. Sonnet 4.6 has no
 *   `xhigh`, Haiku 4.5 has none at all.
 * - Without `modelId` (the global-default select), shows the union across all
 *   models.
 * - With no API key / no live data, falls back to CANONICAL_EFFORTS so it's
 *   never empty.
 * A new level the catalog introduces shows up on its own — no code change.
 */
export default function EffortPicker({
  value, onChange, modelId, inheritPlaceholder, noInherit, className, style, id,
}: Props) {
  const [models, setModels] = useState<KnownClaudeModel[]>(() => peekModels() ?? []);
  const [globalEfforts, setGlobalEfforts] = useState<string[]>(
    () => peekEfforts() ?? [...CANONICAL_EFFORTS],
  );

  useEffect(() => {
    let cancelled = false;
    getModels().then((m) => { if (!cancelled) setModels(m); }).catch(() => {});
    getEfforts().then((e) => { if (!cancelled) setGlobalEfforts(e); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Per-model list if we have live data for this id, else the global union.
  const model = modelId ? models.find((m) => m.id === modelId) : undefined;
  const perModel = model && Array.isArray(model.efforts) ? model.efforts : null;
  const baseOptions = perModel !== null
    ? perModel
    : (globalEfforts.length ? globalEfforts : [...CANONICAL_EFFORTS]);

  // The model is known and explicitly supports NO effort level.
  const unsupported = perModel !== null && perModel.length === 0;

  // ultracode (xhigh + dynamic-workflow orchestration, §14.56) is a Charon
  // pseudo-level, not a catalog capability — offer it wherever the model can do
  // xhigh (or when we have no per-model data). Needs the Workflows feature on
  // the account; if unavailable the CLI just runs without it.
  const supportsXhigh = perModel === null || baseOptions.includes('xhigh');
  const withUltra = supportsXhigh && !baseOptions.includes('ultracode')
    ? [...baseOptions, 'ultracode']
    : baseOptions;

  // Faithfully show a current value that isn't in the computed list (e.g. an
  // effort set earlier, then the model switched to one that doesn't offer it).
  const options = value && !withUltra.includes(value)
    ? [...withUltra, value]
    : withUltra;

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
          {inheritPlaceholder ? `inherit (${inheritPlaceholder})` : 'inherit (global default)'}
        </option>
      )}
      {unsupported && options.length === 0 && (
        <option value="" disabled>— this model has no effort control —</option>
      )}
      {options.map((lvl) => (
        <option key={lvl} value={lvl}>
          {lvl === 'ultracode' ? 'ultracode — xhigh + workflows' : lvl}
          {value === lvl && perModel !== null && !perModel.includes(lvl) && lvl !== 'ultracode' ? ' (unsupported)' : ''}
        </option>
      ))}
    </select>
  );
}
