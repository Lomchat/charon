'use client';
import Switch from './Switch';
import type { FastModeVerdict } from '@/lib/types/api';
import type { CodexSpeedTier } from './codexModelsCache';

// The settings that sit beside effort (§14.56, §14.59): one row each, in the
// session header's effort popover (`pop-tile runtime-switch`) and in the
// new-session form (`wiz-adv-switch`). Speed is cyan (`tone-info`) whatever
// the provider; ultracode is violet.

/** An on/off setting: its glyph, its words, a toned switch; the whole row
 *  flips it. `plain` = the Settings form's own row (`.switch-row`). */
export function SwitchRow({ label, glyph, hint, title, on, tone = 'violet', disabled, onFlip, className, plain }: {
  label: string;
  glyph: string;
  hint?: string;
  /** Tooltip: its published speed/cost, when there is one. */
  title?: string;
  on: boolean;
  tone?: 'violet' | 'info';
  disabled?: boolean;
  onFlip: (on: boolean) => void;
  className: string;
  plain?: boolean;
}) {
  if (plain) {
    return (
      <div className="switch-row" title={title}>
        <span>{label}</span>
        <Switch checked={on} onChange={onFlip} disabled={disabled} tone={tone} label={label} />
      </div>
    );
  }
  return (
    <div className={`${className}${tone === 'info' ? ' tone-info' : ''}${on ? ' on' : ''}`} title={title}
      onClick={() => { if (!disabled) onFlip(!on); }}>
      <span className="ru-ico" aria-hidden>{glyph}</span>
      <span className="ru-text">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </span>
      <Switch checked={on} onChange={onFlip} disabled={disabled} tone={tone} size="sm" label={label} />
    </div>
  );
}

/** Codex's speed (§14.59): one segment per tier the model offers, Standard
 *  first. A current tier the model does not offer keeps its own segment, so
 *  it can be seen and left. */
export function SpeedRow({ tiers, value, disabled, onChange, className, hint }: {
  tiers: CodexSpeedTier[];
  value: string;
  disabled?: boolean;
  onChange: (tier: string) => void;
  className: string;
  hint?: string;
}) {
  const shown = tiers.some((t) => t.id === value) ? tiers : [...tiers, { id: value, name: value }];
  return (
    <div className={`${className} speed-row tone-info${value !== 'default' ? ' on' : ''}`}>
      <span className="ru-ico" aria-hidden>»</span>
      <span className="ru-text">
        <b>Speed</b>
        {hint && <small>{hint}</small>}
      </span>
      <div className="speed-seg" role="radiogroup" aria-label="Speed">
        {shown.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={t.id === value}
            className={t.id === value ? 'on' : ''} title={t.hint} disabled={disabled}
            onClick={(e) => { e.stopPropagation(); if (t.id !== value) onChange(t.id); }}>
            {t.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Claude's fast mode ──────────────────────────────────────────────────────

/** Reasons that do not close the door: not asked for yet, or transient. */
const FAST_MODE_OPEN = new Set(['sdk_opt_in_required', 'pending', 'network_error']);

/** May the switch be offered? Unknown (no init yet) = yes: the CLI answers at
 *  the next start, and a refusal then shows on the row. */
export function fastModeOffered(v: FastModeVerdict | null): boolean {
  if (!v || v.state === 'on' || v.state === 'cooldown') return true;
  return v.reason == null || FAST_MODE_OPEN.has(v.reason);
}

/** What stands in the way, in a few words; null = nothing. */
export function fastModeBlocker(v: FastModeVerdict | null): string | null {
  if (!v) return null;
  if (v.state === 'cooldown') return 'Cooling down after a rate limit';
  if (v.state === 'on' || !v.reason || FAST_MODE_OPEN.has(v.reason)) return null;
  switch (v.reason) {
    case 'extra_usage_disabled': return 'Needs usage credits';
    case 'free': return 'Needs a paid plan';
    case 'model_not_allowed': return 'Not for this model';
    case 'preference': return 'Off for your organization';
    default: return 'Unavailable';
  }
}
