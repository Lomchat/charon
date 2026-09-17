'use client';
import type { PermissionRequest, PendingQuestion, PendingExitPlan } from './sessionTypes';
import ApprovalDeadline from './ApprovalDeadline';
import { buildInteractionPopupQueue, type PopupKind } from './interactionPopup';

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
  onRespond: (sessionId: string, permId: string, allow: boolean, always: boolean) => void;
  onSwitchSession: (sessionId: string) => void;
};

export default function InteractionPopup({
  perms, questions, exitPlans, currentSessionId, onRespond, onSwitchSession,
}: Props) {
  const queue = buildInteractionPopupQueue({ perms, questions, exitPlans, currentSessionId });
  if (queue.length === 0) return null;
  const top = queue[0];
  // The policy module carries no payload, so the input preview is looked up
  // here — and only for the kind whose payload is small enough to show.
  const topPerm = top.kind === 'permission'
    ? perms.find((p) => p.id === top.id) ?? null
    : null;

  return (
    <div className="perm-popup">
      <div className="perm-card">
        <header>
          <span className="badge">{queue.length}</span>
          <span className="title">{TITLE[top.kind]}</span>
          {/* Always present now: the focused session never reaches this list. */}
          <button className="switch" onClick={() => onSwitchSession(top.sessionId)} title="open this session">
            ↗ session {top.sessionId.slice(0, 6)}
          </button>
        </header>
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
        </div>
        {queue.length > 1 && (
          <ul className="queue">
            {queue.slice(1, 6).map((item) => (
              <li key={item.id}>
                <span className="t">{item.label}</span>
                <button onClick={() => onSwitchSession(item.sessionId)}>session {item.sessionId.slice(0, 6)}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
