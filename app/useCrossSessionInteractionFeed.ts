'use client';
import { useEffect, useState } from 'react';
import type {
  PermissionRequest, PendingQuestion, PendingExitPlan,
} from './sessionTypes';
import { subscribeAll } from './globalEventStream';

// useCrossSessionInteractionFeed
// ─────────────────────────────────────────────────────────────────────────────
// S'abonne au flux global multiplexé via `globalEventStream` et maintient
// les queues d'interactions cross-session :
//   - permission_request → permQueue (popup en haut à droite)
//   - user_question → questionQueue
//   - exit_plan_request → exitPlanQueue
//   - interaction_resolved → vide la queue correspondante
//
// Le serveur émet ces events à TOUTES les connexions (events "low-volume",
// cf. eventConnections.ts § isLowVolume) — pas besoin de focus pour les
// recevoir. C'est ce qui permet la popup permission cross-session :
// si tu es sur Session A et qu'une perm tombe sur Session B, tu la vois
// quand même.

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
      const sid = ev.sessionId;
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
