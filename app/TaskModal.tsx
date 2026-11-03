'use client';
// The shell both task modals share (BgTasksBar, ScheduledTasksBar): a head
// with the bar's icon, a title and one line of what is in it, a scrolling
// body, an optional foot. Portaled to <body> (§14.80) and closed by Escape or
// a click on the backdrop.
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export default function TaskModal({ icon, tone, title, subtitle, onClose, children, foot, wide = false }: {
  icon: ReactNode;
  /** The bar's colour: background work vs scheduled tasks. */
  tone: 'work' | 'scheduled';
  title: string;
  subtitle: ReactNode;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const body = (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`claude-modal task-modal tone-${tone}${wide ? ' task-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="tm-head">
          <span className="tm-ico" aria-hidden>{icon}</span>
          <div className="tm-title">
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button type="button" className="pc-close" onClick={onClose} aria-label="close">✕</button>
        </div>
        <div className="tm-body">{children}</div>
        {foot && <div className="tm-foot">{foot}</div>}
      </div>
    </div>
  );
  if (typeof document === 'undefined') return null;
  return createPortal(body, document.body);
}

/** A labelled run of cards inside a task modal ("Running", "Finished"). */
export function TaskGroup({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="tm-group">
      <h3 className="tm-group-h">{label}<span>{count}</span></h3>
      <div className="tm-cards">{children}</div>
    </section>
  );
}
