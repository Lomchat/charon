'use client';
// ── Which Claude settings files a session loads (§14.100) ────────────────────
// ONE control for the four layers that can express the choice: hub Settings,
// the per-VPS modal, the per-VPS edit and the new-session wizard. They differ
// only in whether "inherit" is offered — the hub default is the bottom of the
// chain and must always name a scope, everything below it may defer upwards.
//
// Each row states the FILE it stands for. "user / project / local" means
// nothing on its own, and the whole point of the feature is that people know
// exactly which file they just switched on.
import {
  CLAUDE_SETTING_SOURCES, SETTING_SOURCE_INFO, describeSettingSources,
  settingSourcesWarning, type ClaudeSettingSource,
} from '@/lib/settingSources';

export default function SettingSourcesPicker({
  value, onChange, inherited, disabled = false,
}: {
  /** null = inherit the layer above (only reachable when `inherited` is given). */
  value: ClaudeSettingSource[] | null;
  onChange: (next: ClaudeSettingSource[] | null) => void;
  /** The effective value of the layer above. Omit to hide the inherit option. */
  inherited?: readonly ClaudeSettingSource[];
  disabled?: boolean;
}) {
  const inheriting = value == null;
  const boxesDisabled = disabled || inheriting;

  function toggle(source: ClaudeSettingSource, on: boolean) {
    const current = value ?? [...(inherited ?? [])];
    const next = on
      ? CLAUDE_SETTING_SOURCES.filter((s) => s === source || current.includes(s))
      : current.filter((s) => s !== source);
    onChange(next);
  }

  const warning = settingSourcesWarning(value ?? inherited ?? null);

  return (
    <div className="ss-picker">
      {inherited && (
        <label className="ss-inherit">
          <input
            type="checkbox"
            checked={inheriting}
            disabled={disabled}
            // Leaving "inherit" seeds the custom value with what was actually
            // in effect, so the first click never silently drops a scope the
            // machine was already loading.
            onChange={(e) => onChange(e.target.checked ? null : [...inherited])}
          />
          <span>use the default (<b>{describeSettingSources(inherited)}</b>)</span>
        </label>
      )}
      <ul className="ss-list">
        {CLAUDE_SETTING_SOURCES.map((source) => {
          const info = SETTING_SOURCE_INFO[source];
          const checked = (value ?? inherited ?? []).includes(source);
          return (
            <li key={source} className={checked ? 'is-on' : undefined}>
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={boxesDisabled}
                  onChange={(e) => toggle(source, e.target.checked)}
                />
                <span className="ss-name">{source}</span>
                <code className="ss-file">{info.file}</code>
              </label>
              <small className="ss-hint">{info.hint}</small>
            </li>
          );
        })}
      </ul>
      {warning && <p className="ss-warn">⚠ {warning}</p>}
      <p className="ss-note">
        Read when a session starts: changing this affects new sessions, and
        existing ones after a pause + resume.
      </p>
    </div>
  );
}
