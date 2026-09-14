'use client';
import PickerControl, { PickerOption } from './PickerControl';
import { useEffect, useState } from 'react';
import type { CursorModel } from '@/lib/types/api';
import { getCursorModels, peekCursorModels } from './cursorModelsCache';
import { modelAxes, splitModelSpec } from '@/lib/modelParams';
import { fastMultiplier, formatPrice, priceTier } from '@/lib/modelPricing';
import { providerText } from '@/lib/providerText';

type Props = {
  presentation?: 'select' | 'list';
  disabled?: boolean;
  /** VPS whose Cursor account drives the catalog. */
  vpsId: string;
  value: string;
  onChange: (id: string) => void;
  inheritPlaceholder?: string;
  noInherit?: boolean;
  className?: string;
  id?: string;
  catalogVersion?: string;
};

/** Per-VPS Cursor catalog. Models occupy one row; their variants are parameter
 * sets edited by CursorEffortPicker. Missing price data remains undisclosed. */
export default function CursorModelPicker({
  vpsId, value, onChange, inheritPlaceholder, noInherit, className, id,
  catalogVersion, presentation, disabled,
}: Props) {
  const [models, setModels] = useState<CursorModel[]>(
    () => peekCursorModels(vpsId)?.models ?? [],
  );
  const [loaded, setLoaded] = useState(() => peekCursorModels(vpsId) != null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(peekCursorModels(vpsId) != null);
    setModels(peekCursorModels(vpsId)?.models ?? []);
    getCursorModels(vpsId)
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
  }, [vpsId, catalogVersion]);

  const entries = models.map((m) => {
    const tier = priceTier(m.price);
    const rate = formatPrice(m.price);
    const fast = fastMultiplier(m.price, m.fastPrice);
    return {
      id: m.id,
      label: m.label || m.id,
      // How expensive, beside the NAME — one grey glyph you can run your eye
      // down the column of. The exact rate stays a line below: the tier is for
      // comparing models, the numbers are for checking one.
      tier,
      // One line per fact. Price leads: it is the axis the catalog could never
      // answer before, and the one that decides between two models that both
      // do the job. Then what the knobs will offer once this model is picked.
      lines: [
        rate,
        ...modelAxes(m).facts.map((f) => (
          // The fast lane has its own published rate; a multiplier says what
          // switching it on actually costs, which "Fast" alone does not.
          fast && f.toLowerCase() === 'fast' ? `Fast — ${fast} the price` : f
        )),
        m.description || null,
      ],
      // Findable by ID as well as name: `claude-opus-5` is what a person
      // remembers from a config file, and it is not on screen.
      search: `${m.label} ${m.id}`,
    };
  });
  // Faithfully surface a current value the catalog does not (yet) list. A stored
  // value may still carry the legacy parameter suffix, so compare on the id.
  const selected = splitModelSpec(value).id;
  if (selected && !entries.some((e) => e.id === selected)) {
    entries.push({ id: selected, label: selected, tier: null, lines: ['not in the catalog'], search: selected });
  }

  // `selected` drives the control, not `value`: a legacy stored value may carry
  // a parameter suffix, and the ✓ must still land on the running model.
  return (
    <PickerControl
      presentation={presentation}
      disabled={disabled}
      id={id}
      className={className}
      value={selected}
      onValueChange={onChange}
    >
      {!noInherit && (
        <option value="">
          {inheritPlaceholder ? `inherit (${inheritPlaceholder})` : providerText.inheritDefault('cursor')}
        </option>
      )}
      {!loaded && entries.length === 0 && <option value="" disabled>loading catalog…</option>}
      {loaded && error && entries.length === 0 && (
        <option value="" disabled>— catalog unavailable ({error.slice(0, 40)}) —</option>
      )}
      {entries.map((e) => (
        <option key={e.id} value={e.id} data-search={e.search}>
          <PickerOption
            title={<>{e.label}{e.tier && <span className="picker-tier">{e.tier}</span>}</>}
            sub={e.lines}
          />
        </option>
      ))}
    </PickerControl>
  );
}
