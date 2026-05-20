'use client';
import { useEffect, useState } from 'react';
import type {
  PermissionRequest, PendingQuestion, PendingExitPlan,
} from './sessionTypes';
import { subscribeAll } from './globalEventStream';

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
};

export function useCrossSessionInteractionFeed(): CrossSessionInteractions {
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [exitPlans, setExitPlans] = useState<PendingExitPlan[]>([]);

  useEffect(() => {
    setPerms([]); setQuestions([]); setExitPlans([]);
    const now = () => Math.floor(Date.now() / 1000);

    const unsubscribe = subscribeAll((ev) => {
      // `subscribeAll` also receives install events which have no
      // sessionId — we filter them via the discriminant `'sessionId' in ev`.
      const sid = 'sessionId' in ev ? ev.sessionId : null;
      if (!sid) return;
      if (ev.type === 'permission_request') {
        setPerms((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
          id: ev.id, sessionId: sid, tool: ev.tool, input: ev.input,
          createdAt: now(),
        }]);
      } else if (ev.type === 'user_question') {
        setQuestions((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
          id: ev.id, sessionId: sid, questions: ev.questions,
          createdAt: now(),
        }]);
      } else if (ev.type === 'exit_plan_request') {
        setExitPlans((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
          id: ev.id, sessionId: sid, plan: ev.plan ?? '',
          createdAt: now(),
        }]);
      } else if (ev.type === 'interaction_resolved') {
        if (ev.kind === 'permission') setPerms((q) => q.filter((p) => p.id !== ev.id));
        else if (ev.kind === 'question') setQuestions((q) => q.filter((p) => p.id !== ev.id));
        else if (ev.kind === 'exit_plan') setExitPlans((q) => q.filter((p) => p.id !== ev.id));
      }
    });

    return () => { unsubscribe(); };
  }, []);

  return { perms, questions, exitPlans };
}
