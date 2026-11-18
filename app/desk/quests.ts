// The quest log: everything that waits on the user, in the order to take it.
// Derived from the summaries — the same gates and markers the sidebar badges
// read (lib/sessionAttention.ts) — so a quest exists exactly as long as
// Charon says the session wants you.
import { attentionForRow, isLiveRow } from '@/lib/sessionAttention';
import { oneLine, toolDetail } from '@/lib/sessionActivity';
import type { SessionSummary, SummaryGate } from '@/lib/sessionSummary';

export type QuestKind = 'permission' | 'plan' | 'question' | 'ask' | 'error' | 'done';

export type Quest = {
  key: string;
  sessionId: string;
  kind: QuestKind;
  gate: SummaryGate | null;
  /** Epoch ms it started waiting; null = unknown. */
  since: number | null;
};

const ORDER: QuestKind[] = ['permission', 'plan', 'question', 'ask', 'error', 'done'];

export function questsOf(sessions: SessionSummary[]): Quest[] {
  const out: Quest[] = [];
  for (const s of sessions) {
    const live = isLiveRow(s);
    for (const gate of s.gates ?? []) {
      // A blocking gate on a session that is no longer live is dead.
      if (gate.blocking && !live) continue;
      const kind: QuestKind = gate.kind === 'permission' ? 'permission'
        : gate.kind === 'exit_plan' ? 'plan'
        : gate.blocking ? 'question' : 'ask';
      // A gate's clock is in epoch SECONDS (like ApprovalDeadline reads it).
      out.push({ key: `${s.id}:${gate.id}`, sessionId: s.id, kind, gate, since: gate.createdAt ? gate.createdAt * 1000 : null });
    }
    const attention = attentionForRow(s);
    if (attention === 'unread') out.push({ key: `${s.id}:done`, sessionId: s.id, kind: 'done', gate: null, since: s.lastActivityMs ?? null });
    else if (attention === 'error') out.push({ key: `${s.id}:error`, sessionId: s.id, kind: 'error', gate: null, since: s.lastActivityMs ?? null });
  }
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.since ?? 0) - (b.since ?? 0));
}

/**
 * The one line worth reading of a permission request. A gate's `preview` is
 * the tool input as JSON, possibly cut: read it when it parses, fish the
 * main field out when it does not.
 */
export function gateLine(gate: SummaryGate): string {
  const raw = gate.preview ?? '';
  if (!raw) return '';
  try {
    const line = toolDetail(JSON.parse(raw));
    if (line) return line;
  } catch { /* cut mid-string: fall through */ }
  const m = /"(?:command|file_path|path|pattern|query|url|description|prompt)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
  if (m) return oneLine(m[1].replace(/\\n/g, ' ').replace(/\\(.)/g, '$1'), 400);
  return raw;
}
