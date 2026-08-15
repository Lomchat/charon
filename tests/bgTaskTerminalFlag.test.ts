import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { eventIsTerminal, isTerminalBgStatus } from '@/app/bgTasks';
import { isBgTaskDone } from '@/lib/server/claude/bgTaskState';

// §14.91: the hub kept TWO hand-written terminal-word lists (client + server)
// and they drifted in opposite directions — one ended the task on `error`, the
// other didn't; neither handled `stop`, the word a stop_task kill reports. The
// real oracle is the SDK's exported TERMINAL_TASK_STATUSES, which agent
// >= 0.36.0 now reads once and stamps on the wire as `terminal`.
//
// What matters is that the stamped verdict WINS over the local word list —
// including when they disagree, since "a status word we never anticipated" is
// exactly the case that wedged the bar (session stuck violet forever, and with
// it the auto-update quiet gate).
describe('bg task terminal-ness prefers the SDK verdict', () => {
  it('trusts terminal:true even for a word the local list calls running', () => {
    expect(isTerminalBgStatus('pending')).toBe(false);
    expect(eventIsTerminal({ terminal: true }, 'running')).toBe(true);
    expect(isBgTaskDone({ kind: 'updated', status: 'pending', terminal: true })).toBe(true);
  });

  it('trusts terminal:false even for a word the local list calls terminal', () => {
    expect(isTerminalBgStatus('failed')).toBe(true);
    expect(eventIsTerminal({ terminal: false }, 'failed')).toBe(false);
    expect(isBgTaskDone({ kind: 'updated', status: 'failed', terminal: false })).toBe(false);
  });

  it('falls back to the word list when an older agent omits the flag', () => {
    expect(eventIsTerminal({}, 'failed')).toBe(true);
    expect(eventIsTerminal({}, 'running')).toBe(false);
    expect(isBgTaskDone({ kind: 'updated', status: 'killed' })).toBe(true);
    expect(isBgTaskDone({ kind: 'updated', status: 'running' })).toBe(false);
  });

  it('still treats a `finished` message as terminal regardless of the flag', () => {
    // A kill emits BOTH vocabularies (updated:killed AND finished:stopped) and
    // either can be suppressed — so `finished` must remain sufficient on its own.
    expect(isBgTaskDone({ kind: 'finished' })).toBe(true);
    expect(isBgTaskDone({ kind: 'finished', terminal: false })).toBe(true);
  });
});
