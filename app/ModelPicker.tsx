'use client';
import PickerControl, { PickerOption } from './PickerControl';
import { useEffect, useState } from 'react';
import type { KnownClaudeModel, ClaudeModelGroup } from '@/lib/types/api';
import { getModels, peekModels } from './modelsCache';

const GROUP_LABELS: Record<ClaudeModelGroup, string> = {
  aliases: 'Aliases (always latest)',
  current: 'Versioned models',
  previous: 'Custom model',
};

type Props = {
  presentation?: 'select' | 'list';
  disabled?: boolean;
  /** Currently selected id. Empty string = inherit global default. */
  value: string;
  onChange: (id: string) => void;
  /** Displayed in the "(inherit …)" option. Falsy → "inherit (SDK default)". */
  inheritPlaceholder?: string;
  /** When true, omit the inherit option entirely (e.g. fallback model — we
   *  don't have a "global default fallback global default" recursion). */
  noInherit?: boolean;
  /** Extra className for layout. */
  className?: string;
  /** id attribute. */
  id?: string;
  catalogVersion?: string;
};

/** Shared Claude picker: short aliases plus API-discovered models, with no
 * static model baseline. Preserve custom session values and manual ids. */
export default function ModelPicker({
  value, onChange, inheritPlaceholder, noInherit, className, id, catalogVersion,
  presentation, disabled,
}: Props) {
  const [models, setModels] = useState<KnownClaudeModel[]>(
    () => peekModels() ?? [],
  );

  const [loaded, setLoaded] = useState(() => peekModels() !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getModels()
      .then((m) => {
        if (cancelled) return;
        setModels(m);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setError('Catalog unavailable');
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [catalogVersion]);

  // If the current value isn't in the loaded list (e.g. a session was
  // created with a model that's since been removed from the API catalog,
  // or someone hand-edited the DB), inject it as a "Custom" entry so the
  // dropdown faithfully shows the actual current value instead of silently
  // resetting it to the first option.
  const knownIds = new Set(models.map((m) => m.id));
  const customEntry = value && !knownIds.has(value)
    ? { id: value, label: `${value} (custom)`, group: 'previous' as const, hint: 'not in the API catalog' }
    : null;
  const all = customEntry ? [...models, customEntry] : models;

  // Group for <optgroup>. Order: aliases > current > previous.
  const grouped: Record<ClaudeModelGroup, KnownClaudeModel[]> = {
    aliases: all.filter((m) => m.group === 'aliases'),
    current: all.filter((m) => m.group === 'current'),
    previous: all.filter((m) => m.group === 'previous'),
  };

  return (
    <PickerControl
      presentation={presentation}
      disabled={disabled}
      id={id}
      className={className}
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue === '__custom__') {
          // Explicit escape hatch. prompt() keeps the shared component a pure
          // <select> (no per-call-site layout change). Trim + ignore empty so
          // a cancelled prompt leaves the current value untouched.
          const v = (window.prompt('Enter a model id (e.g. claude-opus-4-9):', value) || '').trim();
          if (v) onChange(v);
          return;
        }
        onChange(nextValue);
      }}
    >
      {!noInherit && (
        <option value="" data-inherit>
          {inheritPlaceholder
            ? `inherit (${inheritPlaceholder})`
            : 'inherit (SDK default)'}
        </option>
      )}
      {!loaded && models.length === 0 && <option value="" disabled>loading catalog…</option>}
      {loaded && error && <option value="" disabled>{error}</option>}
      {loaded && !error && grouped.current.length === 0 && (
        <option value="" disabled>No versioned models — sync the API catalog in Settings</option>
      )}
      {(Object.keys(grouped) as ClaudeModelGroup[]).map((g) => {
        const items = grouped[g];
        if (items.length === 0) return null;
        return (
          <optgroup key={g} label={GROUP_LABELS[g]}>
            {items.map((m) => (
              <option key={m.id} value={m.id} title={m.hint ?? ''}>
                <PickerOption title={m.label} sub={m.hint} />
              </option>
            ))}
          </optgroup>
        );
      })}
      <option value="__custom__">✎ enter a model id…</option>
    </PickerControl>
  );
}
