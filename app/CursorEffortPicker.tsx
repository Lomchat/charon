'use client';
import PickerControl from './PickerControl';
import { useEffect, useState } from 'react';
import type { CursorModel } from '@/lib/types/api';
import { getCursorModels, peekCursorModels } from './cursorModelsCache';
import {
  decodeModelParams, encodeModelParams, isSwitchParam, modelAxes, paramLabel, paramValueLabel,
  splitModelSpec,
} from '@/lib/modelParams';
import { applicableParams } from './cursorEffort';
import { fastMultiplier } from '@/lib/modelPricing';
import { SwitchRow } from './EffortSwitches';
import type { ProviderEffortSwitchesProps } from './modelPickers';

/** The VPS's Cursor catalog, cached per tab. */
function useCursorCatalog(vpsId: string): { models: CursorModel[]; loaded: boolean } {
  const [models, setModels] = useState<CursorModel[]>(
    () => peekCursorModels(vpsId)?.models ?? [],
  );
  const [loaded, setLoaded] = useState(() => peekCursorModels(vpsId) != null);
  useEffect(() => {
    let cancelled = false;
    getCursorModels(vpsId).then((r) => {
      if (cancelled) return;
      setModels(r.models ?? []);
      setLoaded(true);
    }).catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [vpsId]);
  return { models, loaded };
}

/** The selected model's on/off knobs (`fast`, `thinking`…) as switch rows;
 *  each flip merges one axis into the stored parameter set. */
export function CursorParamSwitches({ vpsId, modelId, value, onChange, disabled, className, plain }: ProviderEffortSwitchesProps) {
  const { models } = useCursorCatalog(vpsId);
  const spec = splitModelSpec(modelId);
  const model = models.find((m) => m.id === spec.id) ?? null;
  if (!model) return null;
  const axes = modelAxes(model);
  const current = applicableParams(model, value ? decodeModelParams(value) : spec.params);
  // The fast lane's own published rate, as a multiple of the normal one.
  const fastCost = fastMultiplier(model.price, model.fastPrice);
  return <>
    {axes.all.filter(isSwitchParam).map((param) => {
      const speed = param.id === 'fast';
      return (
        <SwitchRow key={param.id} className={className} plain={plain} label={paramLabel(param)}
          glyph={speed ? '»' : '✦'} tone={speed ? 'info' : 'violet'}
          title={speed && fastCost ? `${fastCost.replace(/x$/, '×')} the price per token` : undefined}
          on={(current[param.id] ?? axes.defaults[param.id]) === 'true'} disabled={disabled}
          onFlip={(on) => onChange(encodeModelParams({ ...current, [param.id]: on ? 'true' : 'false' }))} />
      );
    })}
  </>;
}

type Props = {
  presentation?: 'select' | 'list';
  disabled?: boolean;
  vpsId: string;
  /** The stored parameter set (`effort=high&thinking=true`). Empty = the
   *  model's own default variant. */
  value: string;
  onChange: (v: string) => void;
  /** The model whose knobs this control offers. */
  modelId?: string;
  inheritPlaceholder?: string;
  noInherit?: boolean;
  className?: string;
  style?: React.CSSProperties;
  id?: string;
};

/** Edits the selected Cursor model's own parameter axes. Each option merges one
 * axis into the complete encoded parameter set stored in `effort`. */
export default function CursorEffortPicker({
  vpsId, value, onChange, modelId, inheritPlaceholder, noInherit, className, style, id,
  presentation, disabled,
}: Props) {
  const { models, loaded } = useCursorCatalog(vpsId);

  // Parameters in a model-id suffix remain part of the effective selection.
  const spec = splitModelSpec(modelId);
  const model = models.find((m) => m.id === spec.id) ?? null;
  // Knobs THIS model does not declare are dropped rather than merged forward:
  // they cannot be edited here, and the provider REFUSES the whole run over
  // one (§14.103), so any pick here also cures a leftover (`cursorEffort.ts`). The reduced set is what the control
  // matches its active row against, so a stored selection whose applicable part
  // IS offered stops falling through to the "current" group below.
  const current = applicableParams(model, value ? decodeModelParams(value) : spec.params);
  const applicable = encodeModelParams(current);
  const axes = modelAxes(model);

  type Row = { key: string; label: string; value: string; title?: string };
  // On/off knobs are switches beside this control (`CursorParamSwitches`).
  const switches = axes.all.filter(isSwitchParam);
  const groups: { key: string; label: string; rows: Row[] }[] = axes.all.filter((p) => !isSwitchParam(p)).map((param) => ({
    key: param.id,
    label: paramLabel(param),
    rows: (param.values ?? []).map((entry) => ({
      key: `${param.id}=${entry.value}`,
      // The default is named INLINE, not as a `title`: a tooltip does not exist
      // on touch, and which rung the model picks for you is the one fact a
      // reader needs before overriding it.
      label: paramValueLabel(param, entry.value)
        + (axes.defaults[param.id] === entry.value ? ' (default)' : ''),
      // The whole selection, with this one axis replaced.
      value: encodeModelParams({ ...current, [param.id]: entry.value }),
    })),
  })).filter((g) => g.rows.length > 0);

  // Faithfully surface a stored selection this model does not offer — a rung it
  // has since dropped is still what the session runs, and hiding it would show a
  // control that disagrees with the session.
  const known = new Set(groups.flatMap((g) => g.rows.map((r) => r.value)));
  if (applicable && groups.length && !known.has(applicable)) {
    groups.push({
      key: 'current',
      label: 'current',
      rows: [{
        key: 'current', label: applicable, value: applicable,
        title: 'not offered by this model',
      }],
    });
  }

  return (
    <PickerControl
      presentation={presentation}
      disabled={disabled}
      id={id}
      className={className}
      style={style}
      value={applicable}
      onValueChange={onChange}
    >
      {!noInherit && (
        <option value="">
          {inheritPlaceholder ? `inherit (${inheritPlaceholder})` : 'default for this model'}
        </option>
      )}
      {!groups.length && !switches.length && (
        <option value="" disabled>
          {!loaded ? 'loading catalog…'
            : model ? 'this model has no adjustable parameters'
              : 'pick a model first'}
        </option>
      )}
      {groups.map((g) => (
        <optgroup key={g.key} label={g.label}>
          {g.rows.map((r) => (
            <option key={r.key} value={r.value} title={r.title}>{r.label}</option>
          ))}
        </optgroup>
      ))}
    </PickerControl>
  );
}
