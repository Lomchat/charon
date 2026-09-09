'use client';
// ── Which Claude settings files a session loads (§14.100) ────────────────────
// ONE control for the four layers that can express the choice: hub Settings,
// the per-VPS dialog and the wizard's advanced block. They differ only in
// whether "inherit" is offered — the hub default is the bottom of the chain
// and must always name a scope, everything below it may defer upwards.
//
// A SELECT over named combinations, not three checkboxes: the useful answers
// are a short list, they have names, and a row of boxes made the reader
// assemble the meaning themselves. `PickerControl` is the shared trigger every
// other form here uses (§11), so this reads like the rest of the app.
// The line underneath still names the actual FILES — "user / project / local"
// means nothing on its own, and knowing exactly what was just switched on is
// the whole point of the feature.
import PickerControl from './PickerControl';
import {
  SETTING_SOURCE_INFO, describeSettingSources, formatSettingSources,
  resolveSettingSources, safeParseSettingSources, settingSourcesWarning,
  type ClaudeSettingSource,
} from '@/lib/settingSources';

// The 6 combinations worth naming, out of the 8 a 3-way toggle can produce.
// The two left out (`local` alone, `user,local`) drop the repository's own
// settings while keeping a file inside it — no one wants that on purpose, and
// an out-of-list value arriving from the API or the env var is still rendered
// verbatim below rather than silently snapped to something else.
const PRESETS: Array<{ value: string; label: string; title: string }> = [
  { value: 'project', label: 'Project — the repository’s settings and its CLAUDE.md',
    title: 'Charon’s historical behaviour' },
  { value: 'user,project', label: 'User + project — plus this machine’s own rules',
    title: 'Your ~/.claude/settings.json applies to every session on the box' },
  { value: 'user,project,local', label: 'User + project + local — everything',
    title: 'What the claude CLI loads by default outside Charon' },
  { value: 'project,local', label: 'Project + local — the repository, plus per-machine overrides',
    title: 'For a repo checked out on both a production and a development box' },
  { value: 'user', label: 'User only — this machine’s rules, no CLAUDE.md',
    title: 'The repository gets no say at all, including its CLAUDE.md' },
  { value: 'none', label: 'None — no settings file, no CLAUDE.md',
    title: 'The SDK’s isolation mode' },
];

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
  const current = formatSettingSources(value);
  const custom = !!current && !PRESETS.some((preset) => preset.value === current);
  const effective = resolveSettingSources(value, inherited);
  const warning = settingSourcesWarning(effective);

  return (
    <div className="ss-picker">
      <PickerControl
        value={current}
        disabled={disabled}
        onValueChange={(next) => onChange(safeParseSettingSources(next))}
        title="which settings files this reads"
      >
        {inherited && (
          <option value="">Default — {describeSettingSources(inherited)}</option>
        )}
        {PRESETS.map((preset) => (
          <option key={preset.value} value={preset.value} title={preset.title}>{preset.label}</option>
        ))}
        {/* A value set through the API or CHARON_CLAUDE_SETTING_SOURCES that
            isn't one of the presets must still be selectable, or opening this
            control would quietly rewrite it. */}
        {custom && <option value={current}>{current}</option>}
      </PickerControl>
      <p className="ss-files">
        {effective.length
          ? effective.map((source) => SETTING_SOURCE_INFO[source].file).join('  ·  ')
          : 'no settings file is read'}
      </p>
      {warning && <p className="ss-warn">⚠ {warning}</p>}
      <p className="ss-note">
        Read when a session starts: this affects new sessions, and existing ones
        after a pause + resume.
      </p>
    </div>
  );
}
