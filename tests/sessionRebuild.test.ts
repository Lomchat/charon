import { describe, it, expect } from 'vitest';
import { rebuildStateFromMessages } from '@/app/sessionRebuild';
import type { PersistedMessage } from '@/app/sessionRebuild';

// Helper to build rows with monotonic ids/timestamps unless overridden.
let nextId = 1;
function row(role: string, content: string, overrides: Partial<PersistedMessage> = {}): PersistedMessage {
  const id = overrides.id ?? nextId++;
  return {
    id,
    role,
    content,
    createdAt: overrides.createdAt ?? 1_000_000 + id,
    ...overrides,
  };
}

function toolUse(id: string, name: string, input: unknown): PersistedMessage {
  return row('tool_use', JSON.stringify({ type: 'tool_use', id, name, input }));
}
function toolResult(toolUseId: string, content: string, isError = false): PersistedMessage {
  return row('tool_result', JSON.stringify({ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }));
}

describe('rebuildStateFromMessages', () => {
  it('passes through the provided status untouched', () => {
    expect(rebuildStateFromMessages([], 'sleeping').status).toBe('sleeping');
    expect(rebuildStateFromMessages([], 'active').status).toBe('active');
  });

  it('returns empty collections for no messages', () => {
    const s = rebuildStateFromMessages([], 'active');
    expect(s.messages).toEqual([]);
    expect(s.toolCalls).toEqual([]);
    expect(s.todos).toEqual([]);
    expect(s.edits.size).toBe(0);
    expect(s.files.size).toBe(0);
  });

  it('builds user/assistant messages with m+id ids and preserves order + content', () => {
    const rows: PersistedMessage[] = [
      row('user', 'hello', { id: 10, createdAt: 500 }),
      row('assistant', 'hi there', { id: 11, createdAt: 600 }),
      row('system', 'sys note', { id: 12, createdAt: 700 }),
    ];
    const s = rebuildStateFromMessages(rows, 'active');
    expect(s.messages.map((m) => [m.id, m.role, m.content, m.createdAt])).toEqual([
      ['m10', 'user', 'hello', 500],
      ['m11', 'assistant', 'hi there', 600],
      ['m12', 'system', 'sys note', 700],
    ]);
  });

  it('rebuilds a thinking row directly from its content', () => {
    const s = rebuildStateFromMessages([row('thinking', 'pondering', { id: 5 })], 'thinking');
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ id: 'm5', role: 'thinking', content: 'pondering' });
  });

  it('rebuilds a thinking from an event row of type thinking using ev.text', () => {
    const rows = [row('event', JSON.stringify({ type: 'thinking', text: 'inner thought' }), { id: 7 })];
    const s = rebuildStateFromMessages(rows, 'active');
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ id: 'm7', role: 'thinking', content: 'inner thought' });
  });

  // --- The §39 invariant: re-pair tool_result onto its tool call ---

  it('re-pairs a tool_result onto the matching tool_use by SDK tool id', () => {
    const rows = [
      toolUse('toolu_aaa', 'Read', { file_path: '/etc/hosts' }),
      toolResult('toolu_aaa', 'file contents here', false),
    ];
    const s = rebuildStateFromMessages(rows, 'active');
    expect(s.toolCalls).toHaveLength(1);
    const tc = s.toolCalls[0];
    expect(tc.name).toBe('Read');
    expect(tc.input).toEqual({ file_path: '/etc/hosts' });
    // result MUST be populated after refetch (the whole point of §39)
    expect(tc.result).toEqual({ content: 'file contents here', isError: false });
  });

  it('toolCall.id is h+rowid (NOT the SDK id) so it is React-key unique', () => {
    const rows = [toolUse('toolu_xyz', 'Bash', { command: 'ls' }, )];
    // ensure deterministic row id
    rows[0].id = 42;
    const s = rebuildStateFromMessages(rows, 'active');
    expect(s.toolCalls[0].id).toBe('h42');
  });

  it('marks isError true when the tool_result reports an error', () => {
    const rows = [
      toolUse('toolu_err', 'Bash', { command: 'false' }),
      toolResult('toolu_err', 'command failed', true),
    ];
    const s = rebuildStateFromMessages(rows, 'active');
    expect(s.toolCalls[0].result).toEqual({ content: 'command failed', isError: true });
  });

  it('pairs results to the CORRECT tool when several are interleaved out of order', () => {
    // Two tool_uses, then results arrive in reversed order. Each must land on its own call.
    const rows = [
      toolUse('toolu_1', 'Read', { file_path: '/a' }),
      toolUse('toolu_2', 'Read', { file_path: '/b' }),
      toolResult('toolu_2', 'B-content', false),
      toolResult('toolu_1', 'A-content', false),
    ];
    const s = rebuildStateFromMessages(rows, 'active');
    expect(s.toolCalls).toHaveLength(2);
    const byInput = Object.fromEntries(
      s.toolCalls.map((tc) => [tc.input.file_path, tc.result?.content]),
    );
    expect(byInput).toEqual({ '/a': 'A-content', '/b': 'B-content' });
  });

  it('leaves result undefined for a tool_use that has no matching tool_result', () => {
    const rows = [toolUse('toolu_open', 'Read', { file_path: '/x' })];
    const s = rebuildStateFromMessages(rows, 'active');
    expect(s.toolCalls[0].result).toBeUndefined();
  });

  it('ignores a tool_result whose tool_use_id matches no known tool (no crash, no orphan toolCall)', () => {
    const rows = [toolResult('toolu_ghost', 'orphan', false)];
    const s = rebuildStateFromMessages(rows, 'active');
    // no toolCall created from a bare result
    expect(s.toolCalls).toHaveLength(0);
    // but the message row itself is still appended
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe('tool_result');
  });

  // --- files accumulation ---

  it('accumulates files from tool_use input.file_path', () => {
    const rows = [
      toolUse('toolu_1', 'Read', { file_path: '/srv/a.ts' }),
      toolUse('toolu_2', 'Edit', { file_path: '/srv/b.ts' }),
      toolUse('toolu_3', 'Bash', { command: 'ls' }), // no file_path
    ];
    const s = rebuildStateFromMessages(rows, 'active');
    expect([...s.files].sort()).toEqual(['/srv/a.ts', '/srv/b.ts']);
  });

  // --- todos: latest todo_update wins ---

  it('takes the latest todo_update event (latest wins, replaces not merges)', () => {
    const rows = [
      row('event', JSON.stringify({ type: 'todo_update', todos: [{ content: 'old', status: 'pending' }] })),
      row('event', JSON.stringify({
        type: 'todo_update',
        todos: [
          { content: 'task A', status: 'completed' },
          { content: 'task B', status: 'in_progress' },
        ],
      })),
    ];
    const s = rebuildStateFromMessages(rows, 'active');
    expect(s.todos).toEqual([
      { content: 'task A', status: 'completed' },
      { content: 'task B', status: 'in_progress' },
    ]);
  });

  it('todo_update with no todos field yields an empty array (nullish fallback)', () => {
    const rows = [row('event', JSON.stringify({ type: 'todo_update' }))];
    const s = rebuildStateFromMessages(rows, 'active');
    expect(s.todos).toEqual([]);
  });

  // --- edit snapshots ---

  it('accumulates before/after edit snapshots per file_path and tracks the file', () => {
    const rows = [
      row('edit_snapshot', JSON.stringify({
        phase: 'before', tool_use_id: 'toolu_e', file_path: '/srv/x.ts', content: 'OLD', truncated: false,
      })),
      row('edit_snapshot', JSON.stringify({
        phase: 'after', tool_use_id: 'toolu_e', file_path: '/srv/x.ts', content: 'NEW', truncated: false,
      })),
    ];
    const s = rebuildStateFromMessages(rows, 'active');
    const snap = s.edits.get('/srv/x.ts');
    expect(snap).toBeDefined();
    expect(snap).toMatchObject({
      toolUseId: 'toolu_e',
      filePath: '/srv/x.ts',
      before: 'OLD',
      after: 'NEW',
      truncated: false,
    });
    expect(s.files.has('/srv/x.ts')).toBe(true);
  });

  it('truncated flag is sticky once any phase reports it truncated', () => {
    const rows = [
      row('edit_snapshot', JSON.stringify({
        phase: 'before', tool_use_id: 't', file_path: '/f', content: 'a', truncated: true,
      })),
      row('edit_snapshot', JSON.stringify({
        phase: 'after', tool_use_id: 't', file_path: '/f', content: 'b', truncated: false,
      })),
    ];
    const s = rebuildStateFromMessages(rows, 'active');
    expect(s.edits.get('/f')!.truncated).toBe(true);
  });

  // --- robustness: malformed JSON ---

  it('silently skips malformed tool_use / tool_result / event / edit_snapshot JSON without throwing', () => {
    const rows = [
      row('tool_use', '{not valid json'),
      row('tool_result', 'also bad'),
      row('event', '<<<'),
      row('edit_snapshot', 'nope'),
      row('assistant', 'still here', { id: 99 }),
    ];
    let s!: ReturnType<typeof rebuildStateFromMessages>;
    expect(() => { s = rebuildStateFromMessages(rows, 'active'); }).not.toThrow();
    // malformed tool_use creates no toolCall but the bad rows are still appended as messages
    expect(s.toolCalls).toHaveLength(0);
    expect(s.messages.find((m) => m.id === 'm99')?.content).toBe('still here');
    // the bad tool_use/tool_result rows still appear as messages (only the parse side-effects are skipped)
    expect(s.messages.some((m) => m.role === 'tool_use')).toBe(true);
  });

  // --- integration: a realistic full turn ---

  it('rebuilds a realistic multi-turn transcript correctly', () => {
    nextId = 1;
    const rows: PersistedMessage[] = [
      row('user', 'read the file'),
      row('event', JSON.stringify({ type: 'thinking', text: 'I should read it' })),
      toolUse('toolu_read', 'Read', { file_path: '/srv/charon/CLAUDE.md' }),
      toolResult('toolu_read', '# CLAUDE.md', false),
      row('assistant', 'Here is the content'),
      row('event', JSON.stringify({
        type: 'todo_update',
        todos: [{ content: 'summarize', status: 'in_progress' }],
      })),
    ];
    const s = rebuildStateFromMessages(rows, 'active');

    // tool resolved
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0].result?.content).toBe('# CLAUDE.md');
    // file tracked
    expect(s.files.has('/srv/charon/CLAUDE.md')).toBe(true);
    // todos
    expect(s.todos).toEqual([{ content: 'summarize', status: 'in_progress' }]);
    // messages: user, thinking, tool_use, tool_result, assistant (5 chat rows)
    expect(s.messages.map((m) => m.role)).toEqual([
      'user', 'thinking', 'tool_use', 'tool_result', 'assistant',
    ]);
  });
});
