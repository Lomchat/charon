'use client';
import { useReducer, type ReactNode } from 'react';

export type PendingKind = 'question' | 'exit_plan' | 'permission';

/**
 * The zone that replaces the composer while an interaction waits (question,
 * plan, permission), with the composer's grip look (ComposerGrip.tsx): a click
 * folds the card away to see the chat, a click brings it back. No sizing.
 *
 * Folded, it is a REMINDER strip, never nothing: the agent is blocked until
 * this is answered, so it must stay in sight — and the composer does NOT come
 * back under it, there being nothing to send while the gate is open.
 *
 * Folding is per INTERACTION (a new one always arrives unfolded) and lives in
 * module memory: it survives a session switch (the view remounts), not an F5.
 */
const folded = new Set<string>();
const FOLDED_CAP = 50;

const REMINDER: Record<PendingKind, string> = {
  question: 'question waiting',
  exit_plan: 'plan waiting for approval',
  permission: 'permission waiting',
};

const NOUN: Record<PendingKind, string> = {
  question: 'question',
  exit_plan: 'plan',
  permission: 'permission request',
};

export default function PendingZone({ id, kind, children }: {
  /** The interaction's own id — the fold follows it, not the session. */
  id: string;
  kind: PendingKind;
  children: ReactNode;
}) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const key = `${kind}:${id}`;
  const collapsed = folded.has(key);

  const toggle = () => {
    if (collapsed) folded.delete(key);
    else {
      folded.add(key);
      // Answered interactions never come back; keep the set from growing.
      if (folded.size > FOLDED_CAP) folded.delete(folded.values().next().value!);
    }
    rerender();
  };

  return (
    <div className={`pz-wrap ${kind}${collapsed ? ' is-collapsed' : ''}`}>
      <button
        type="button"
        className="pz-toggle"
        aria-expanded={!collapsed}
        title={collapsed ? `show the ${NOUN[kind]}` : `hide the ${NOUN[kind]} — it keeps waiting`}
        onClick={toggle}
      >
        <span className="ci-grip-pill" aria-hidden="true" />
        {collapsed && (
          <span className="pz-reminder">
            <span className="pz-dot" aria-hidden="true" />
            {REMINDER[kind]}
            <span className="pz-hint">click to show</span>
          </span>
        )}
      </button>
      {/* Hidden, not unmounted: a half-filled answer survives the fold. */}
      <div className="claude-pending-zone" hidden={collapsed}>{children}</div>
    </div>
  );
}
