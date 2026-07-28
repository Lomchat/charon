import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Chat order is keyed on `ts_ms` — WHEN the event happened — and never on the
 * agent's `seq` (§14.71).
 *
 * Why it can't be seq: seq is per-session and RESTARTS AT 1 whenever the
 * agent's durable event log is recreated (daemon boots with an empty
 * state.json → `cleanup_orphans` wipes `events/` → the hub re-creates the
 * session via `start_session(claude_session_id=…)`). Rows kept being stamped
 * with the raw seq, so a transcript grew a SECOND epoch numbered from 1 while
 * the DB already held seqs in the thousands — and every reply of that epoch
 * sorted into the MIDDLE of the history, outside the newest page. Reported
 * as: "I only see my own messages; replies flash for a second then vanish"
 * (flash = live SSE append, vanish = the 5s poll refetching the window).
 * 8 of 16 live sessions were in that state.
 *
 * These cases pin that a seq reset is now a NON-EVENT: the key ignores seq
 * entirely, so there is nothing to detect and nothing to compensate.
 */
describe('chat order is immune to agent seq resets', () => {
  let chronologicalKeys: any;
  let orderChronologically: any;
  const T = 1_700_000_000_000;

  const load = async () => {
    ({ chronologicalKeys, orderChronologically } = await import('@/lib/server/claude/messageOrder'));
  };

  it('a seq reset changes nothing — ts keeps the real order', async () => {
    await load();
    const rows = [
      // epoch 1
      { id: 1, seq: 100, tsMs: T + 1_000 },
      { id: 2, seq: 101, tsMs: T + 2_000 },
      { id: 3, seq: 102, tsMs: T + 3_000 },
      // epoch 2 — the log was wiped, the agent restarted at 1. Under the old
      // seq key these three sank to the front of the transcript.
      { id: 4, seq: 1, tsMs: T + 4_000 },
      { id: 5, seq: 2, tsMs: T + 5_000 },
      { id: 6, seq: 3, tsMs: T + 6_000 },
    ];
    expect(orderChronologically(rows as any).map((r: any) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('survives SEVERAL resets, however short the epochs', async () => {
    await load();
    // Epoch length was load-bearing for the old seq-based heuristic (adjacent
    // short epochs were ambiguous). With a wall-clock key it is irrelevant —
    // one-row epochs order just as well.
    const rows = [
      { id: 1, seq: 50, tsMs: T + 1_000 },
      { id: 2, seq: 1, tsMs: T + 2_000 },
      { id: 3, seq: 2, tsMs: T + 3_000 },
      { id: 4, seq: 1, tsMs: T + 4_000 },
      { id: 5, seq: 1, tsMs: T + 5_000 },
    ];
    expect(orderChronologically(rows as any).map((r: any) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('user messages stay interleaved, not pinned to the end', async () => {
    await load();
    // The exact shape that produced "I only see my own messages": user rows
    // carry no seq, so under the old key they inherited the high watermark
    // and were the only thing left in the newest page while every reply sank.
    const rows = [
      { id: 1, seq: 200, tsMs: T + 1_000 },
      { id: 2, seq: null, tsMs: T + 2_000 },   // user message
      { id: 3, seq: 5, tsMs: T + 3_000 },      // reply, new epoch
      { id: 4, seq: 6, tsMs: T + 4_000 },
      { id: 5, seq: null, tsMs: T + 5_000 },   // user message
      { id: 6, seq: 7, tsMs: T + 6_000 },      // reply must come AFTER it
    ];
    expect(orderChronologically(rows as any).map((r: any) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a repaired row sorts back into place on its own ts', async () => {
    await load();
    // Late insert (highest id) carrying an earlier ts — the §14.31
    // failed-at-N / succeeded-at-N+1 case. This is what seq used to be abused
    // for, and ts handles it for free.
    const rows = [
      { id: 1, tsMs: T + 1_000 },
      { id: 2, tsMs: T + 3_000 },
      { id: 3, tsMs: T + 4_000 },
      { id: 4, tsMs: T + 2_000 },   // repaired
    ];
    expect(orderChronologically(rows as any).map((r: any) => r.id)).toEqual([1, 4, 2, 3]);
  });

  it('ties inside one millisecond fall back to insertion order', async () => {
    await load();
    // ms granularity still collides inside a fast turn; within one ms the
    // insertion order IS the truth.
    const rows = [
      { id: 7, tsMs: T }, { id: 5, tsMs: T }, { id: 9, tsMs: T },
    ];
    expect(orderChronologically(rows as any).map((r: any) => r.id)).toEqual([5, 7, 9]);
  });

  it('rows with no ts anchor to the watermark instead of jumping to the front', async () => {
    await load();
    const rows = [
      { id: 1, tsMs: T + 1_000 },
      { id: 2, tsMs: null },
      { id: 3, tsMs: T + 2_000 },
    ];
    const key = chronologicalKeys(rows as any);
    expect(key.get(2)).toBe(T + 1_000);
    expect(orderChronologically(rows as any).map((r: any) => r.id)).toEqual([1, 2, 3]);
  });
});
