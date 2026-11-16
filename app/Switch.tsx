'use client';

/** THE on/off control (`.toggle` in app.css): a sliding knob, never a native
 *  checkbox. `tone` recolours the on state (violet = ultracode, §14.56);
 *  `size="sm"` fits a popover row. */
export default function Switch({ checked, onChange, label, disabled = false, tone, size }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name — the visible text beside it usually says the same. */
  label?: string;
  disabled?: boolean;
  tone?: 'violet';
  size?: 'sm';
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle${checked ? ' on' : ''}${tone ? ` tone-${tone}` : ''}${size ? ` ${size}` : ''}`}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
    >
      <span className="knob" />
    </button>
  );
}
