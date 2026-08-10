import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

let deriveMessageStorage: typeof import('@/lib/server/claude/messageWire').deriveMessageStorage;
let compactToolInputForWire: typeof import('@/lib/server/claude/messageWire').compactToolInputForWire;

beforeAll(async () => {
  ({ deriveMessageStorage, compactToolInputForWire } = await import('@/lib/server/claude/messageWire'));
});

describe('message wire projection', () => {
  it('keeps the lossless edit body out of the chat projection and normalizes its keys', () => {
    const full = JSON.stringify({
      type: 'edit_snapshot', phase: 'after', file_path: '/repo/huge.ts',
      tool_use_id: 'tool-1', content: 'x'.repeat(200_000), truncated: true,
    });
    const stored = deriveMessageStorage('edit_snapshot', full);
    expect(stored.snapshotFilePath).toBe('/repo/huge.ts');
    expect(stored.snapshotPhase).toBe('after');
    expect(stored.snapshotToolUseId).toBe('tool-1');
    expect(stored.snapshotTruncated).toBe(1);
    expect(stored.wireContent!.length).toBeLessThan(400);
    expect(JSON.parse(stored.wireContent!).content).toBeNull();
  });

  it('bounds large tool results while preserving their useful head and tail', () => {
    const body = `HEAD-${'a'.repeat(40_000)}-TAIL`;
    const full = JSON.stringify({ type: 'tool_result', tool_use_id: 'tool-2', content: body, is_error: false });
    const stored = deriveMessageStorage('tool_result', full);
    const wire = JSON.parse(stored.wireContent!);
    expect(wire.content.length).toBeLessThan(18_000);
    expect(wire.content).toMatch(/^HEAD-/);
    expect(wire.content).toMatch(/-TAIL$/);
    expect(wire.content_truncated).toBe(true);
    expect(wire.content_bytes).toBe(body.length);
  });

  it('bounds Write payloads without mutating the original tool input', () => {
    const input = { file_path: '/repo/a.ts', content: `start-${'z'.repeat(30_000)}-end` };
    const compact = compactToolInputForWire(input) as Record<string, unknown>;
    expect(compact).not.toBe(input);
    expect((compact.content as string).length).toBeLessThan(18_000);
    expect(compact.content_truncated).toBe(true);
    expect(input.content.length).toBeGreaterThan(30_000);
  });

  it('does not duplicate already-small messages', () => {
    expect(deriveMessageStorage('assistant', 'hello').wireContent).toBeNull();
    expect(deriveMessageStorage('tool_result', JSON.stringify({ content: 'small' })).wireContent).toBeNull();
  });
});
