'use client';
import PickerControl from './PickerControl';
import { useEffect, useState } from 'react';
import type { CursorModel } from '@/lib/types/api';
import { getCursorModels, peekCursorModels } from './cursorModelsCache';
import {
  decodeModelParams, encodeModelParams, modelAxes, paramLabel, paramValueLabel,
  splitModelSpec,
} from '@/lib/modelParams';

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

  // Parameters in a model-id suffix remain part of the effective selection.
  const spec = splitModelSpec(modelId);
  const model = models.find((m) => m.id === spec.id) ?? null;
  const current = value ? decodeModelParams(value) : spec.params;
  const axes = modelAxes(model);

  type Row = { key: string; label: string; value: string; title?: string };
  const groups: { key: string; label: string; rows: Row[] }[] = axes.all.map((param) => ({
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

  // Faithfully surface a stored selection this model does not offer — a model
  // switch can leave a parameter behind, and silently dropping it would show a
  // control that disagrees with the session.
  const known = new Set(groups.flatMap((g) => g.rows.map((r) => r.value)));
  if (value && !known.has(value)) {
    groups.push({
      key: 'current',
      label: 'current',
      rows: [{ key: 'current', label: value, value, title: 'not offered by this model' }],
    });
  }

  return (
    <PickerControl
      presentation={presentation}
      disabled={disabled}
      id={id}
      className={className}
      style={style}
      value={value}
      onValueChange={onChange}
    >
      {!noInherit && (
        <option value="">
          {inheritPlaceholder ? `inherit (${inheritPlaceholder})` : 'default for this model'}
        </option>
      )}
      {!groups.length && (
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
