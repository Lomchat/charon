'use client';
import type { ReactNode } from 'react';

// The Settings modal's building blocks (app.css § Settings kit): a screen
// header, cards, label/control rows, a segmented control and an effort
// ladder. Every screen is made of these, so the three agents read alike.

/** A screen's header: its icon, title and one line; chips say its state at a
 *  glance; `right` holds the screen's master switch. */
export function SetHeader({ icon, title, sub, chips, right }: {
  icon: ReactNode; title: string; sub?: ReactNode; chips?: ReactNode; right?: ReactNode;
}) {
  return (
    <header className="st-head">
      <span className="st-head-ico" aria-hidden="true">{icon}</span>
      <div className="st-head-tx">
        <div className="st-head-title" role="heading" aria-level={2}>{title}</div>
        {sub && <div className="st-head-sub">{sub}</div>}
        {chips && <div className="st-chips">{chips}</div>}
      </div>
      {right && <div className="st-head-right">{right}</div>}
    </header>
  );
}

export function SetChip({ children, tone, title }: { children: ReactNode; tone?: 'ok' | 'off' | 'info'; title?: string }) {
  return <span className={`st-chip${tone ? ` tone-${tone}` : ''}`} title={title}>{children}</span>;
}

/** A group of settings under one short title. */
export function SetCard({ title, aside, children, className }: {
  title?: string; aside?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`st-card${className ? ` ${className}` : ''}`}>
      {(title || aside) && (
        <div className="st-card-h">
          {title && <span className="st-card-title">{title}</span>}
          {aside && <span className="st-card-aside">{aside}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** One setting: its name on the left, its control on the right (stacked on
 *  a phone); `note` is the control's one-line consequence, beside it. */
export function SetRow({ label, hint, note, children }: {
  label: string; hint?: ReactNode; note?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="st-row">
      <div className="st-row-l">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="st-row-c">
        {children}
        {note && <span className="st-row-note">{note}</span>}
      </div>
    </div>
  );
}

export type SegTone = 'safe' | 'medium' | 'danger' | 'info';

/** A small closed choice, every option visible; `tone` tints the selected one
 *  (a mode's risk, a speed). */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { id: T; label: string; title?: string; tone?: SegTone }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="st-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value}
          className={`${o.id === value ? 'on' : ''}${o.tone ? ` tone-${o.tone}` : ''}`} title={o.title}
          onClick={() => { if (o.id !== value) onChange(o.id); }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** An ordered scale (effort): rising steps, the chosen one lit with those
 *  below it. `inheritLabel` adds the "no choice" option in front. */
export function Ladder({ value, options, onChange, label, inheritLabel }: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (v: string) => void;
  label: string;
  inheritLabel?: string;
}) {
  const at = options.findIndex((o) => o.id === value);
  const last = Math.max(1, options.length - 1);
  return (
    <div className="st-ladder" role="radiogroup" aria-label={label}>
      {inheritLabel !== undefined && (
        <button type="button" role="radio" aria-checked={value === ''}
          className={`st-ladder-def${value === '' ? ' on' : ''}`} onClick={() => onChange('')}>
          {inheritLabel}
        </button>
      )}
      {options.map((o, i) => (
        <button key={o.id} type="button" role="radio" aria-checked={i === at} title={o.label}
          className={`st-step${at >= 0 && i <= at ? ' lit' : ''}${i === at ? ' on' : ''}`}
          onClick={() => onChange(o.id)}>
          <b style={{ height: `${5 + Math.round((i * 9) / last)}px` }} />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
