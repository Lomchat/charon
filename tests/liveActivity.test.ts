import { describe, expect, it } from 'vitest';
import { createLiveFold, describeLive, foldLiveFrame } from '@/lib/liveActivity';

// §14.124: the hub folds a stream's live frames into what the thinking bar
// says. A wrong fold shows a stale step ("Running npm test" long after it
// ended) — the exact lie the bar exists to remove.
const claude = { thinking: true, streamsText: false };

describe('live activity fold', () => {
  it('follows a Claude turn: think → prepare → run → wait → over', () => {
    const f = createLiveFold();
    expect(foldLiveFrame(f, { type: 'status', status: 'thinking' }, 1_000, claude)).toBe('beat');
    expect(f.current).toEqual({ beat: 'wait', since: 1_000 });

    foldLiveFrame(f, { type: 'generation_progress', block: 'thinking', index: 0, blockChars: 10, tail: 'first' }, 2_000, claude);
    expect(foldLiveFrame(f, { type: 'generation_progress', block: 'thinking', index: 0, blockChars: 90, tail: 'later words' }, 2_500, claude))
      .toBe('progress');
    expect(f.current).toMatchObject({ beat: 'think', since: 2_000, chars: 90, tail: 'later words' });

    foldLiveFrame(f, { type: 'generation_progress', block: 'tool_use', index: 1, tool: 'Write', blockChars: 5 }, 3_000, claude);
    // The detail arrives mid-stream; later progress without it keeps it.
    foldLiveFrame(f, { type: 'generation_progress', block: 'tool_use', index: 1, tool: 'Write', detail: 'app/x.ts', blockChars: 900 }, 3_300, claude);
    foldLiveFrame(f, { type: 'generation_progress', block: 'tool_use', index: 1, tool: 'Write', blockChars: 9_000 }, 3_600, claude);
    expect(describeLive(f.current!, 'Claude')).toMatchObject({ label: 'Preparing', detail: 'Write app/x.ts', since: 3_000, extra: ['9.0k chars'] });

    foldLiveFrame(f, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm   test' } }, 4_000, claude);
    expect(describeLive(f.current!, 'Claude')).toMatchObject({ label: 'Running', detail: 'npm test', since: 4_000 });

    foldLiveFrame(f, { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }, 9_000, claude);
    expect(f.current).toEqual({ beat: 'wait', since: 9_000 });
    // The next request starting keeps the wait's clock.
    expect(foldLiveFrame(f, { type: 'generation_progress', block: null }, 9_500, claude)).toBeNull();

    expect(foldLiveFrame(f, { type: 'stop', subtype: 'success' }, 10_000, claude)).toBe('beat');
    expect(f.current).toBeNull();
  });

  it('keeps parallel calls apart and forgets everything once the turn is over', () => {
    const f = createLiveFold();
    foldLiveFrame(f, { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/a.ts' } }, 1_000, claude);
    foldLiveFrame(f, { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'foo', path: 'lib' } }, 1_100, claude);
    expect(describeLive(f.current!, 'Claude')).toMatchObject({ label: 'Searching', detail: '"foo" in lib', extra: ['+1 running'] });
    // The shown call ends: the other one, still running, takes over with its own clock.
    foldLiveFrame(f, { type: 'tool_result', tool_use_id: 'b' }, 2_000, claude);
    expect(f.current).toMatchObject({ beat: 'tool', since: 1_000, tool: { id: 'a' }, running: 1 });

    // Status left `thinking` without a stop: nothing is happening any more.
    expect(foldLiveFrame(f, { type: 'usage' }, 3_000, { ...claude, thinking: false })).toBe('beat');
    expect(f.current).toBeNull();
    foldLiveFrame(f, { type: 'status', status: 'thinking' }, 4_000, claude);
    expect(f.current).toEqual({ beat: 'wait', since: 4_000 });
  });
});
