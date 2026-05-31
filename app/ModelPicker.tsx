'use client';
import { useEffect, useState } from 'react';
import type { KnownClaudeModel, ClaudeModelGroup } from '@/lib/types/api';
import { getModels, peekModels } from './modelsCache';

// Fallback list shown on first render before /api/claude/models has resolved.
// Kept in sync with lib/server/claude/knownModels.ts (which is the source of
// truth — this is just a no-flash baseline so the dropdown isn't empty on
// the first mount of a session). If the server list drifts after the fetch
// resolves, the picker re-renders with the fresh data.
const FALLBACK_MODELS: KnownClaudeModel[] = [
  { id: 'opus',   label: 'opus (latest)',   group: 'aliases' },
  { id: 'sonnet', label: 'sonnet (latest)', group: 'aliases' },
  { id: 'haiku',  label: 'haiku (latest)',  group: 'aliases' },
  { id: 'claude-opus-4-8',   label: 'Opus 4.8',   group: 'current' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', group: 'current' },
  { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',  group: 'current' },
];

const GROUP_LABELS: Record<ClaudeModelGroup, string> = {
  aliases: 'Aliases (always latest)',
  current: 'Current versioned',
  previous: 'Previous versions',
};

type Props = {
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
};

/**
 * <ModelPicker> — drop-in <select> for Claude model IDs. Single shared
 * component used by:
 *   - NewSessionDialog (desktop "model" + "fallback model")
 *   - NewSessionSheet (mobile)
 *   - SettingsModal (global defaults)
 *   - ModelEffortBadges popover (per-session change in-flight)
 *
 * The list is fetched once per tab from /api/claude/models via modelsCache.
 * Until the fetch resolves, we render a 6-item baseline so the dropdown is
 * never empty (= no flash, no layout shift).
 *
 * Free-text was the original UX. It led to a class of bugs where users
 * typed model IDs that didn't exist (e.g. `claude-opus-4-7` after 4.8
 * shipped); the SDK silently fell back to a default and the user
 * concluded "the feature doesn't work" (cf. the report that led to this
 * component). A closed list trades the (rare) "I want a model not in the
 * list" case for "the picker always actually does what it says". For the
 * power-user escape hatch, edit knownModels.ts and redeploy.
 */
export default function ModelPicker({
  value, onChange, inheritPlaceholder, noInherit, className, id,
}: Props) {
  const [models, setModels] = useState<KnownClaudeModel[]>(
    () => peekModels() ?? FALLBACK_MODELS,
  );
  const [loaded, setLoaded] = useState(() => peekModels() != null);

  useEffect(() => {
    let cancelled = false;
    getModels()
      .then((m) => {
        if (cancelled) return;
        setModels(m);
        setLoaded(true);
      })
      .catch(() => {
        // Stay on FALLBACK_MODELS. The 5s polling in useClaudeSessionStream
        // won't help here, but the user can still pick from the baseline.
        // Marking loaded=true keeps the picker functional instead of stuck
        // looking like it's still fetching.
        if (!cancelled) setLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  // If the current value isn't in the loaded list (e.g. a session was
  // created with a model that's since been removed from the curated list,
  // or someone hand-edited the DB), inject it as a "Custom" entry so the
  // dropdown faithfully shows the actual current value instead of silently
  // resetting it to the first option.
  const knownIds = new Set(models.map((m) => m.id));
  const customEntry = value && !knownIds.has(value)
    ? { id: value, label: `${value} (custom)`, group: 'previous' as const, hint: 'not in the curated list' }
    : null;
  const all = customEntry ? [...models, customEntry] : models;

  // Group for <optgroup>. Order: aliases > current > previous.
  const grouped: Record<ClaudeModelGroup, KnownClaudeModel[]> = {
    aliases: all.filter((m) => m.group === 'aliases'),
    current: all.filter((m) => m.group === 'current'),
    previous: all.filter((m) => m.group === 'previous'),
  };

  return (
    <select
      id={id}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={!loaded && models === FALLBACK_MODELS && false /* keep enabled — fallback is plenty */}
    >
      {!noInherit && (
        <option value="">
          {inheritPlaceholder
            ? `inherit (${inheritPlaceholder})`
            : 'inherit (SDK default)'}
        </option>
      )}
      {(Object.keys(grouped) as ClaudeModelGroup[]).map((g) => {
        const items = grouped[g];
        if (items.length === 0) return null;
        return (
          <optgroup key={g} label={GROUP_LABELS[g]}>
            {items.map((m) => (
              <option key={m.id} value={m.id} title={m.hint ?? ''}>
                {m.label}{m.hint ? ` — ${m.hint}` : ''}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}
