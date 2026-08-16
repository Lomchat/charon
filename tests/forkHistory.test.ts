import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
import {
  batchCodexHistoryItems,
  codexItemsFromForkHistory,
  splitUtf8,
} from '@/lib/server/claude/forkHistory';

describe('Claude -> Codex fork history', () => {
  it('keeps prose roles and labels provider-specific tool traffic', () => {
    const items = codexItemsFromForkHistory([
      { id: 1, role: 'user', content: 'Inspect it', tsMs: 10 },
      { id: 2, role: 'tool_use', content: JSON.stringify({ name: 'Read', input: { file_path: '/tmp/a' } }), tsMs: 20 },
      { id: 3, role: 'tool_result', content: JSON.stringify({ content: 'contents' }), tsMs: 30 },
      { id: 4, role: 'assistant', content: 'Done', tsMs: 40 },
      { id: 5, role: 'event', content: '{"type":"stop"}', tsMs: 50 },
    ]);
    expect(items.map((x) => x.role)).toEqual(['user', 'assistant', 'assistant', 'assistant']);
    expect(items[0].content[0]).toEqual({ type: 'input_text', text: 'Inspect it' });
    expect(items[1].content[0].text).toContain('Historical Claude tool call: Read');
    expect(items[2].content[0].text).toContain('contents');
    expect(items[3].content[0]).toEqual({ type: 'output_text', text: 'Done' });
  });

  it('uses transcript timestamps rather than replay sequence/insertion order', () => {
    const items = codexItemsFromForkHistory([
      { id: 10, role: 'assistant', content: 'later', tsMs: 200 },
      { id: 11, role: 'user', content: 'earlier', tsMs: 100 },
    ]);
    expect(items.map((x) => x.content[0].text)).toEqual(['earlier', 'later']);
  });

  it('splits unicode safely and packs every item below the RPC line budget', () => {
    const text = '🧪'.repeat(10_000);
    const parts = splitUtf8(text, 12 * 1024);
    expect(parts.join('')).toBe(text);
    expect(parts.every((x) => Buffer.byteLength(x, 'utf8') <= 12 * 1024)).toBe(true);

    const items = codexItemsFromForkHistory([{ id: 1, role: 'user', content: text, tsMs: 1 }]);
    const batches = batchCodexHistoryItems('1234567890abcdef', items);
    expect(batches.flat()).toEqual(items);
    expect(batches.every((batch) => Buffer.byteLength(JSON.stringify({
      session_id: '1234567890abcdef', items: batch,
    }), 'utf8') <= 48 * 1024)).toBe(true);
  });

  it('also respects the agent item-count bound for many tiny messages', () => {
    const rows = Array.from({ length: 130 }, (_, i) => ({
      id: i + 1, role: 'user', content: `m${i}`, tsMs: i + 1,
    }));
    const items = codexItemsFromForkHistory(rows);
    const batches = batchCodexHistoryItems('1234567890abcdef', items);
    expect(batches.map((x) => x.length)).toEqual([64, 64, 2]);
  });
});
