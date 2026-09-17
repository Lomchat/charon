'use client';
import { useMemo, useState } from 'react';
import type { PermissionRequest, PendingQuestion, PendingExitPlan } from './sessionTypes';
import ApprovalDeadline from './ApprovalDeadline';
import {
  buildInteractionPopupQueue, visibleAfterDismissal, forgetStaleDismissals,
  type PopupKind,
} from './interactionPopup';

// The corner card for interactions on sessions you are NOT looking at.
// Formerly <PermissionPopup>, which read only the permission queue and
// deliberately prioritised the focused session — so a session with its own
// inline card got a second, poorer copy on top, while a question on a
// background session got no popup at all. Which rows belong here, and which
// can be answered from a corner, is decided in app/interactionPopup.ts.

const TITLE: Record<PopupKind, string> = {
  permission: 'permission requested',
  question: 'question awaiting your reply',
  exit_plan: 'plan ready for approval',
};

type Props = {
  perms: PermissionRequest[];
  questions: PendingQuestion[];
  exitPlans: PendingExitPlan[];
  /** The session rendering its own cards inline; excluded from the popup. */
  currentSessionId: string | null;
  /** Human names for the session a prompt came from — never a bare id. */
  describeSession: (sessionId: string) => { name: string; vps: string };
  onRespond: (sessionId: string, permId: string, allow: boolean, always: boolean) => void;
  onSwitchSession: (sessionId: string) => void;
};

export default function InteractionPopup({
  perms, questions, exitPlans, currentSessionId, describeSession, onRespond, onSwitchSession,
}: Props) {
  // Waved away in THIS tab. The interaction stays pending and the sidebar lock
  // stays lit; only the card is hidden, so "not now" does not mean "answered".
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const queue = useMemo(
    () => buildInteractionPopupQueue({ perms, questions, exitPlans, currentSessionId }),
    [perms, questions, exitPlans, currentSessionId],
  );
  const visible = visibleAfterDismissal(queue, dismissed);
  if (visible.length === 0) return null;
  const top = visible[0];
  const who = describeSession(top.sessionId);
  // The policy module carries no payload, so the input preview is looked up
  // here — and only for the kind whose payload is small enough to show.
  const topPerm = top.kind === 'permission'
    ? perms.find((p) => p.id === top.id) ?? null
    : null;

  const dismiss = (id: string) => setDismissed((prev) => {
    const next = new Set(prev);
    next.add(id);
    // Trim ids whose interaction is gone, so this cannot grow all session.
    return forgetStaleDismissals(next, queue);
  });

  return (
    <div className="perm-popup">
      <div className="perm-card">
        <header>
          <span className="badge">{visible.length}</span>
          <span className="title">{TITLE[top.kind]}</span>
          {/* "Not now": hides the card, leaves the interaction pending. */}
          <button
            className="dismiss"
            onClick={() => dismiss(top.id)}
            title="hide this (it stays waiting for you)"
            aria-label="hide this notification"
          >×</button>
        </header>
        {/* Which machine, and which session, in words — a truncated id told
            you nothing about where the prompt came from. */}
        <div className="perm-origin">
          <span className="o-vps">{who.vps}</span>
          <span className="o-sep"> · </span>
          <span className="o-session">{who.name}</span>
        </div>
        <div className="tool-name">{top.label}</div>
        <ApprovalDeadline expiresAt={top.expiresAt} />
        {topPerm && (
          <pre className="input-preview">{JSON.stringify(topPerm.input, null, 2).slice(0, 600)}</pre>
        )}
        <div className="actions">
          {top.answerable && topPerm ? (
            <>
              <button className="allow" onClick={() => onRespond(top.sessionId, top.id, true, false)}>allow once</button>
              <button className="always" onClick={() => onRespond(top.sessionId, top.id, true, true)}>allow always (session)</button>
              <button className="deny" onClick={() => onRespond(top.sessionId, top.id, false, false)}>deny</button>
            </>
          ) : (
            // A question's options and a plan's body do not survive being cut
            // to fit a corner card, and answering something you can only half
            // read is worse than walking to it. Offer the session instead.
            <button className="allow" onClick={() => onSwitchSession(top.sessionId)}>
              open session to answer
            </button>
          )}
          <button className="switch" onClick={() => onSwitchSession(top.sessionId)} title="open this session">
            ↗ open
          </button>
        </div>
        {visible.length > 1 && (
          <ul className="queue">
            {visible.slice(1, 6).map((item) => {
              const other = describeSession(item.sessionId);
              return (
                <li key={item.id}>
                  <span className="t">{item.label}</span>
                  <button onClick={() => onSwitchSession(item.sessionId)}>
                    {other.vps} · {other.name}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
