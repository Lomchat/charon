/**
 * Inputs the provider has not read yet (§14.125).
 *
 * A message sent while a turn runs reaches the agent at once, but the
 * provider reads it at its next step (Claude: its next request; Codex: the
 * `userMessage` item it records; Cursor: the run appending it) — or opens
 * the next turn with it. Until then it waits beside the composer, not in the
 * conversation; once read, its row is RE-STAMPED to that moment (`ts_ms`),
 * so it sits where the provider took it, live and after a reload alike.
 * Durable (`agent_sessions.waiting_inputs`): a hub restart keeps the list,
 * and the replayed `inputs_taken` settles it.
 */

/** One waiting input, hub-side. */
export type WaitingEntry = {
  clientMessageId: string;
  rowId: number;
  /** When it started waiting (hub clock, unix ms). */
  since: number;
  /** The agent said an `inputs_taken` will name it; absent while its
   *  `send_input` answer is still out. An untracked one is read at once. */
  tracked?: boolean;
  /** It can be read now (Claude, a CLI with `interrupt_send_now_v1`). */
  sendNow?: boolean;
};

/** What a browser sees of one (frame `waiting_inputs`, window GET `waitingInputs`). */
export type WaitingInput = { rowId: number; clientMessageId: string; since?: number; sendNow?: boolean };

/** A row the provider read, and its new chat position (`ts_ms`). */
export type TakenInput = { rowId: number; tsMs: number };

export function parseWaitingInputs(raw: unknown): WaitingEntry[] {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  const out: WaitingEntry[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    if (typeof w.clientMessageId !== 'string' || typeof w.rowId !== 'number') continue;
    out.push({
      clientMessageId: w.clientMessageId,
      rowId: w.rowId,
      since: typeof w.since === 'number' ? w.since : 0,
      ...(w.tracked === true ? { tracked: true } : {}),
      ...(w.sendNow === true ? { sendNow: true } : {}),
    });
  }
  return out;
}

export function publicWaitingInputs(list: readonly WaitingEntry[]): WaitingInput[] {
  return list.map((w) => ({
    rowId: w.rowId, clientMessageId: w.clientMessageId,
    ...(w.since ? { since: w.since } : {}),
    ...(w.sendNow ? { sendNow: true } : {}),
  }));
}
