'use client';
import { useEffect, useState } from 'react';
import type {
  PermissionRequest, PendingQuestion, PendingExitPlan,
} from './sessionTypes';
import { subscribeAll, subscribeReconnect } from './globalEventStream';

// useCrossSessionInteractionFeed
// ─────────────────────────────────────────────────────────────────────────────
// Subscribes to the multiplexed global stream via `globalEventStream` and
// maintains the cross-session interaction queues:
//   - permission_request → permQueue (top-right popup)
//   - user_question → questionQueue
//   - exit_plan_request → exitPlanQueue
//   - interaction_resolved → empties the corresponding queue
//
// The server emits these events to ALL connections (low-volume events,
// cf. eventConnections.ts § isLowVolume) — no focus needed to receive
// them. This is what enables the cross-session permission popup:
// if you're on Session A and a perm fires on Session B, you still see it.

export type CrossSessionInteractions = {
  perms: PermissionRequest[];
  questions: PendingQuestion[];
  exitPlans: PendingExitPlan[];
  /**
   * Whether the queues can be read as the COMPLETE set of pending
   * interactions. False until the connect snapshot has landed — see below.
   * Consumers that must not miss a pending prompt fall back to the session
   * row's polled count while this is false (app/sessionBadge.ts).
   */
  synced: boolean;
};

// The server replays every pending interaction when the stream (re)connects,
// so a settled connection holds the whole picture rather than a delta — which
// is what lets the badge trust it over the 60s list poll. But the replay
// arrives as a BURST of separate messages, each its own task, and the browser
// can paint between them. Reading the queues as complete the instant the first
// one lands would blink the lock off and back on at every reconnect. Wait a
// short grace for the burst to drain instead; the queues are still applied
// live throughout, only their COMPLETENESS is delayed.
const SNAPSHOT_GRACE_MS = 400;

export function useCrossSessionInteractionFeed(): CrossSessionInteractions {
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [exitPlans, setExitPlans] = useState<PendingExitPlan[]>([]);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    setPerms([]); setQuestions([]); setExitPlans([]);
    const now = () => Math.floor(Date.now() / 1000);
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const armGrace = () => {
      if (graceTimer) return;
      graceTimer = setTimeout(() => setSynced(true), SNAPSHOT_GRACE_MS);
    };

    // A drop is the one thing that can leave a resolved interaction sitting in
    // a queue: `interaction_resolved` is live-only, so a prompt answered on
    // another device while this tab was disconnected is never retracted here.
    // The poll used to paper over that; now that live wins, the queues have to
    // correct themselves. Drop them and let the connect replay rebuild — going
    // unsynced for the grace so the polled count covers the gap.
    const unsubReconnect = subscribeReconnect(() => {
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      setSynced(false);
      setPerms([]); setQuestions([]); setExitPlans([]);
    });

    const unsubscribe = subscribeAll((ev) => {
      // Any event at all means the stream is live and the connect snapshot is
      // arriving — the burst opens with a status frame per session, not with
      // the pendings, so this must not be gated on the interaction types.
      armGrace();
      // `subscribeAll` also receives install events which have no
      // sessionId — we filter them via the discriminant `'sessionId' in ev`.
      const sid = 'sessionId' in ev ? ev.sessionId : null;
      if (!sid) return;
      if (ev.type === 'permission_request') {
        setPerms((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
          id: ev.id, sessionId: sid, tool: ev.tool, input: ev.input,
          createdAt: now(),
          expiresAt: ev.expiresAt,
        }]);
      } else if (ev.type === 'user_question') {
        setQuestions((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
          id: ev.id, sessionId: sid, questions: ev.questions,
          createdAt: now(),
          expiresAt: ev.expiresAt,
        }]);
      } else if (ev.type === 'exit_plan_request') {
        setExitPlans((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
          id: ev.id, sessionId: sid, plan: ev.plan ?? '',
          createdAt: now(),
          expiresAt: ev.expiresAt,
        }]);
      } else if (ev.type === 'interaction_resolved') {
        if (ev.kind === 'permission') setPerms((q) => q.filter((p) => p.id !== ev.id));
        else if (ev.kind === 'question') setQuestions((q) => q.filter((p) => p.id !== ev.id));
        else if (ev.kind === 'exit_plan') setExitPlans((q) => q.filter((p) => p.id !== ev.id));
      }
    });

    return () => {
      if (graceTimer) clearTimeout(graceTimer);
      unsubReconnect();
      unsubscribe();
    };
  }, []);

  return { perms, questions, exitPlans, synced };
}
