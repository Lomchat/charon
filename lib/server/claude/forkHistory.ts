import { orderChronologically } from './messageOrder';

/** Rows that carry conversation state worth handing to another model.
 * Event markers and edit snapshots remain UI/audit side channels. */
export const FORK_MODEL_ROLES = [
  'user', 'assistant', 'tool_use', 'tool_result', 'user_question',
] as const;

export type ForkHistoryRow = {
  id: number;
  role: string;
  content: string;
  tsMs?: number | null;
};

export type CodexHistoryItem = {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<{
    type: 'input_text' | 'output_text';
    text: string;
  }>;
};

const ITEM_TEXT_BYTES = 12 * 1024;
export const FORK_RPC_BATCH_BYTES = 48 * 1024;
export const FORK_RPC_BATCH_ITEMS = 64;

function jsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ''); }
}

/** Turn Charon's provider-neutral rows into raw Responses message items.
 *
 * User/assistant prose keeps its original role. Claude tool traffic has no
 * portable tool-call schema (Read/Bash/Edit are not Codex function calls), so
 * it becomes explicitly-labelled assistant history. This preserves the facts
 * without fabricating live Codex calls or unmatched call ids.
 */
export function codexItemsFromForkHistory(rows: ForkHistoryRow[]): CodexHistoryItem[] {
  const items: CodexHistoryItem[] = [];
  for (const row of orderChronologically(rows)) {
    let role: 'user' | 'assistant';
    let text = row.content;
    if (row.role === 'user') {
      role = 'user';
    } else if (row.role === 'assistant') {
      role = 'assistant';
    } else if (row.role === 'tool_use') {
      role = 'assistant';
      const parsed = jsonObject(row.content);
      const name = typeof parsed?.name === 'string' ? parsed.name : 'tool';
      text = `[Historical Claude tool call: ${name}]\n${printable(parsed?.input ?? row.content)}`;
    } else if (row.role === 'tool_result') {
      role = 'assistant';
      const parsed = jsonObject(row.content);
      const failed = parsed?.is_error === true ? ' (failed)' : '';
      text = `[Historical Claude tool result${failed}]\n${printable(parsed?.content ?? row.content)}`;
    } else if (row.role === 'user_question') {
      role = 'assistant';
      const parsed = jsonObject(row.content);
      text = `[Historical Claude question to the user]\n${printable(parsed?.questions ?? row.content)}`;
    } else {
      continue;
    }
    if (!text) continue;
    for (const part of splitUtf8(text, ITEM_TEXT_BYTES)) {
      items.push({
        type: 'message',
        role,
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: part }],
      });
    }
  }
  return items;
}

/** Split without cutting a UTF-8 code point. Unlike String.slice-by-length,
 * this also keeps a worst-case emoji-only item below the RPC byte ceiling. */
export function splitUtf8(text: string, maxBytes: number): string[] {
  if (!text) return [];
  if (!Number.isFinite(maxBytes) || maxBytes < 4) throw new Error('maxBytes must be at least 4');
  const out: string[] = [];
  let chars: string[] = [];
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (chars.length && bytes + n > maxBytes) {
      out.push(chars.join(''));
      chars = [];
      bytes = 0;
    }
    chars.push(ch);
    bytes += n;
  }
  if (chars.length) out.push(chars.join(''));
  return out;
}

/** Pack params below the daemon's 64 KiB line limit, leaving ample room for
 * the outer JSON-RPC envelope added by AgentClient. */
export function batchCodexHistoryItems(
  sessionId: string,
  items: CodexHistoryItem[],
  maxBytes = FORK_RPC_BATCH_BYTES,
): CodexHistoryItem[][] {
  const batches: CodexHistoryItem[][] = [];
  let batch: CodexHistoryItem[] = [];
  const size = (xs: CodexHistoryItem[]) => Buffer.byteLength(
    JSON.stringify({ session_id: sessionId, items: xs }), 'utf8',
  );
  for (const item of items) {
    const candidate = [...batch, item];
    if (candidate.length <= FORK_RPC_BATCH_ITEMS && size(candidate) <= maxBytes) {
      batch = candidate;
      continue;
    }
    if (!batch.length) throw new Error('one history item exceeds the RPC batch limit');
    batches.push(batch);
    batch = [item];
    if (size(batch) > maxBytes) throw new Error('one history item exceeds the RPC batch limit');
  }
  if (batch.length) batches.push(batch);
  return batches;
}
