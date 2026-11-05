// The cross-session fact (CLAUDE.md §14.108) — TYPES and change detection only.
// Browser-safe. The builders live server-side (lib/server/sync/sessionSummaries.ts);
// the bus publishes them as `{type:'session_summary', sessionId, summary}`.
import type { SessionListItem, WorkerStatus } from '@/lib/types/api';
import type { PermissionSuggestion } from '@/lib/permissionSuggestions';
import type { Attention } from './sessionAttention';

export type { Attention };

export type SummaryGate = {
  id: string;
  kind: 'permission' | 'question' | 'exit_plan';
  /** false ⇔ kind==='question' && delivery==='async' */
  blocking: boolean;
  createdAt: number;
  expiresAt: number | null;
  /** tool name | first question (≤120 chars) | 'plan' */
  title: string;
  /** permission: ≤ 600 chars, computed ONCE per gate id from a ≤ 8 KiB prefix */
  preview?: string;
  /** permission: the provider's own words for why it asks (≤ 600 chars) */
  reason?: string;
  /** permission (Claude): the CLI's "don't ask again" options, by index */
  suggestions?: PermissionSuggestion[];
  /** async answers reserved, send in flight */
  delivering?: boolean;
};

/** A superset of today's list row ⇒ zero consumer churn. */
export type SessionSummary = SessionListItem & {
  liveStatus: WorkerStatus;
  runningBgTasks: number;
  lastActivityMs: number | null;
  addressable: boolean;
  /** pendingPermissions = pendingBlocking + pendingAsync (compat) */
  pendingBlocking: number;
  pendingAsync: number;
  gates: SummaryGate[];
  attention: Attention;
};

/** Fields that change without changing what any surface shows: they never
 *  publish a summary on their own (a frame carrying other changes still
 *  carries their current value). */
export const SUMMARY_VOLATILE_KEYS = ['lastSeenSeq', 'lastStopNotifiedSeq', 'pendingAssistantMessageId',
  'alwaysAllowTools', 'sleepRequested', 'resumePending', 'lastActivityMs', 'lastUsedAt'] as const;

const VOLATILE: ReadonlySet<string> = new Set(SUMMARY_VOLATILE_KEYS);

/** JSON with object keys sorted at every depth (arrays keep their order);
 *  `undefined` members are dropped, as JSON.stringify does. */
function stableJson(v: unknown, skipTopLevel: ReadonlySet<string> | null): string {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x, null)).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    if (skipTopLevel?.has(k)) continue;
    const x = obj[k];
    if (x === undefined || typeof x === 'function') continue;
    parts.push(`${JSON.stringify(k)}:${stableJson(x, null)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Stable JSON of a summary minus its volatile keys: equal keys ⇔ nothing a
 *  surface renders changed (the publisher's change detection). */
export function summaryKey(s: SessionSummary): string {
  return stableJson(s, VOLATILE);
}

export { deriveAttention } from './sessionAttention';
