'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  PermissionRequest, PendingQuestion, PendingExitPlan,
} from './sessionTypes';
import type { SessionSummary } from '@/lib/sessionSummary';
import { isSessionProvider, type SessionProvider } from '@/lib/sessionCapabilities';
import { useSessionList } from './sync/summaryStore';

// useCrossSessionInteractionFeed
// ─────────────────────────────────────────────────────────────────────────────
// The cross-session interaction queues (the top-right permission popup), now
// DERIVED from the summary store's gates (CLAUDE.md §14.108): every gate of
// every session, with its title and bounded preview, kept current by the
// `session_summary` frames (a removal is a frame too, G7) and reconciled by
// every resync and list GET. No event subscription of its own: a resolution
// missed while disconnected cannot leave a ghost here — the next snapshot of
// the store does not list it.
//
// Same exported shape as before. Permission entries carry no `input` (the
// summary ships a ≤600-char `preview`, computed once by the hub, instead);
// questions carry their first question as `title` only.

/** `kind` picks the answer buttons (lib/permissionSuggestions.ts). */
export type FeedPermission = PermissionRequest & { preview?: string; kind?: SessionProvider };
export type FeedQuestion = PendingQuestion & { title?: string };

export type CrossSessionInteractions = {
  perms: FeedPermission[];
  questions: FeedQuestion[];
  exitPlans: PendingExitPlan[];
};

/** Slack past a gate's `expiresAt` before the feed drops it on its own: the
 *  hub's expiry frame normally arrives first (C07 sweeper); this only reaps a
 *  gate whose removal this tab has not received yet. */
export const FEED_EXPIRY_SLACK_S = 5;
const FEED_PRUNE_TICK_MS = 5_000;

type Gate = { id: string; expiresAt?: number };

/** Drop the gates past `expiresAt` (unix s) + slack. Same array back when none. */
export function pruneExpired<T extends Gate>(queue: T[], nowSec: number): T[] {
  const next = queue.filter((g) => g.expiresAt == null || nowSec <= g.expiresAt + FEED_EXPIRY_SLACK_S);
  return next.length === queue.length ? queue : next;
}

/** The three queues of a summary list (pure, tested), oldest first; expired
 *  gates pruned when `nowSec` is given. */
export function feedFromSummaries(sessions: readonly SessionSummary[], nowSec?: number): CrossSessionInteractions {
  const perms: FeedPermission[] = [];
  const questions: FeedQuestion[] = [];
  const exitPlans: PendingExitPlan[] = [];
  for (const s of sessions) {
    for (const g of s.gates ?? []) {
      const expiresAt = g.expiresAt ?? undefined;
      if (g.kind === 'permission') {
        perms.push({
          id: g.id, sessionId: s.id, tool: g.title, input: undefined, createdAt: g.createdAt, expiresAt,
          ...(g.preview != null ? { preview: g.preview } : {}),
          ...(g.reason ? { reason: g.reason } : {}),
          ...(g.suggestions?.length ? { suggestions: g.suggestions } : {}),
          ...(g.prompt ? { prompt: g.prompt } : {}),
          ...(isSessionProvider(s.kind) ? { kind: s.kind } : {}),
        });
      } else if (g.kind === 'question') {
        questions.push({
          id: g.id, sessionId: s.id, questions: [], createdAt: g.createdAt, expiresAt, title: g.title,
          ...(g.blocking ? {} : { delivery: 'async' as const }),
          ...(g.delivering ? { delivering: true } : {}),
        });
      } else if (g.kind === 'exit_plan') {
        exitPlans.push({ id: g.id, sessionId: s.id, plan: '', createdAt: g.createdAt, expiresAt });
      }
    }
  }
  const byAge = (a: { createdAt: number }, b: { createdAt: number }) => a.createdAt - b.createdAt;
  perms.sort(byAge); questions.sort(byAge); exitPlans.sort(byAge);
  if (nowSec == null) return { perms, questions, exitPlans };
  return {
    perms: pruneExpired(perms, nowSec),
    questions: pruneExpired(questions, nowSec),
    exitPlans: pruneExpired(exitPlans, nowSec),
  };
}

const total = (q: CrossSessionInteractions) => q.perms.length + q.questions.length + q.exitPlans.length;

export function useCrossSessionInteractionFeed(): CrossSessionInteractions {
  const sessions = useSessionList();
  // Bumped only when a gate actually expired meanwhile (no idle re-render).
  const [tick, setTick] = useState(0);
  const feed = useMemo(
    () => feedFromSummaries(sessions, Math.floor(Date.now() / 1000)),
    // `tick` re-runs the prune.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, tick],
  );
  const feedRef = useRef(feed); feedRef.current = feed;
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions;
  useEffect(() => {
    const t = setInterval(() => {
      if (total(feedRef.current) === 0) return;
      const now = Math.floor(Date.now() / 1000);
      if (total(feedFromSummaries(sessionsRef.current, now)) !== total(feedRef.current)) setTick((n) => n + 1);
    }, FEED_PRUNE_TICK_MS);
    return () => clearInterval(t);
  }, []);
  return feed;
}
