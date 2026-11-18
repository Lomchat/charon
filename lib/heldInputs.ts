/**
 * Inputs sent while the provider compacts (§14.125).
 *
 * The composer stays open during a compaction; what it sends is persisted and
 * echoed at once, but the agent gets it only when the compaction ends — in
 * send order, behind any input still waiting. Durable
 * (`agent_sessions.held_inputs`), so a hub restart releases them after its
 * reconnect instead of losing them.
 */

/** One held input, hub-side (the row it persisted + what `send_input` needs). */
export type HeldInput = {
  rowId: number | null;
  clientMessageId: string;
  content: string;
  codexInputs?: Array<Record<string, unknown>>;
  /** The last delivery failure: the entry stays at the head and is retried. */
  error?: string | null;
  /** Failed deliveries so far (paces the timed retries). */
  attempts?: number;
};

/** What a browser sees of one (frame `held_inputs`, window GET `heldInputs`). */
export type HeldInputState = { rowId: number; error?: string | null };

export function parseHeldInputs(raw: unknown): HeldInput[] {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  const out: HeldInput[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const h = item as Record<string, unknown>;
    if (typeof h.content !== 'string' || typeof h.clientMessageId !== 'string') continue;
    out.push({
      rowId: typeof h.rowId === 'number' ? h.rowId : null,
      clientMessageId: h.clientMessageId,
      content: h.content,
      ...(Array.isArray(h.codexInputs) ? { codexInputs: h.codexInputs as Array<Record<string, unknown>> } : {}),
      ...(typeof h.error === 'string' ? { error: h.error } : {}),
      ...(typeof h.attempts === 'number' ? { attempts: h.attempts } : {}),
    });
  }
  return out;
}

export function publicHeldInputs(list: readonly HeldInput[]): HeldInputState[] {
  const out: HeldInputState[] = [];
  for (const h of list) if (h.rowId != null) out.push({ rowId: h.rowId, ...(h.error ? { error: h.error } : {}) });
  return out;
}
