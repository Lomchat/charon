import { describe, it, expect } from 'vitest';
import {
  isTerminalBgStatus,
  effectiveBgStatus,
  applyBgTaskEvent,
  BG_TASK_MAX_AGE_S,
  type BgTask,
} from '@/app/bgTasks';

/**
 * The background-task terminal rule (§14.91).
 *
 * Two reducers read the SAME persisted `bg_task` rows — `app/bgTasks.ts` for
 * the bar and `lib/server/claude/bgTaskState.ts` for the session's
 * `background` status and the auto-update quiet gate. They used to keep
 * SEPARATE word lists and disagreed in both directions, which is exactly how a
 * task ends up "running" forever on one side and finished on the other. These
 * tests pin the shared vocabulary; `isBgTaskDone` is a thin wrapper over
 * `isTerminalBgStatus`, so pinning the oracle pins both.
 */

// The SDK's two lifecycle vocabularies (claude_agent_sdk.types):
//   TaskNotificationStatus = completed | failed | stopped
//   TaskUpdatedStatus      = pending | running | paused | completed | failed | killed
// TERMINAL_TASK_STATUSES spans both: {completed, failed, stopped, killed}.
const SDK_TERMINAL = ['completed', 'failed', 'stopped', 'killed'];
const SDK_LIVE = ['pending', 'running', 'paused'];

describe('isTerminalBgStatus — the SDK vocabulary', () => {
  for (const s of SDK_TERMINAL) {
    it(`treats "${s}" as terminal`, () => expect(isTerminalBgStatus(s)).toBe(true));
  }
  for (const s of SDK_LIVE) {
    it(`keeps "${s}" running`, () => expect(isTerminalBgStatus(s)).toBe(false));
  }

  // `stop_task` (the kill button) reports `killed` on task_updated and the
  // matching notification is sometimes SUPPRESSED — so if `stop`/`killed` were
  // not terminal words here, pressing stop would look like a no-op forever.
  it('covers the words a stop_task kill reports', () => {
    expect(isTerminalBgStatus('killed')).toBe(true);
    expect(isTerminalBgStatus('stopped')).toBe(true);
  });

  // Defensive extras beyond the SDK enum: the status is a free-form string on
  // the wire, and these are the words the server regex and the client matcher
  // used to disagree about. Single-token only — "timed out" is deliberately
  // NOT matched, and nothing in either vocabulary emits it.
  it('is terminal for error/cancel wording (the old server/client split)', () => {
    for (const s of ['error', 'timeout', 'cancelled', 'aborted']) {
      expect(isTerminalBgStatus(s)).toBe(true);
    }
  });

  it('does not invent a verdict from a missing or non-string status', () => {
    expect(isTerminalBgStatus(undefined)).toBe(false);
    expect(isTerminalBgStatus(null)).toBe(false);
    expect(isTerminalBgStatus(42)).toBe(false);
    expect(isTerminalBgStatus('')).toBe(false);
  });
});

describe('applyBgTaskEvent — a killed task actually ends', () => {
  const mk = () => new Map<string, BgTask>();

  it('ends on an `updated` carrying only a terminal status (no notification)', () => {
    const m = mk();
    applyBgTaskEvent(m, { kind: 'started', taskId: 't1', description: 'wait' }, 1000);
    expect(m.get('t1')!.status).toBe('running');
    applyBgTaskEvent(m, { kind: 'updated', taskId: 't1', status: 'killed' }, 1100);
    expect(m.get('t1')!.status).toBe('killed');
    expect(m.get('t1')!.endedAt).toBe(1100);
  });

  it('leaves a status-less `updated` alone (it is not a verdict)', () => {
    const m = mk();
    applyBgTaskEvent(m, { kind: 'started', taskId: 't1' }, 1000);
    applyBgTaskEvent(m, { kind: 'updated', taskId: 't1' }, 1100);
    expect(m.get('t1')!.status).toBe('running');
  });
});

describe('effectiveBgStatus — the age cap is honest on BOTH sides', () => {
  const task = (startedAt: number): BgTask => ({
    taskId: 't', description: null, command: null, toolUseId: null, taskType: null,
    status: 'running', startedAt, endedAt: null, outputFile: null, summary: null,
    workflowName: null, usage: null, lastToolName: null, agents: null,
  });

  it('still reads as running just under the cap', () => {
    const now = 1_000_000;
    expect(effectiveBgStatus(task(now - BG_TASK_MAX_AGE_S + 60), now)).toBe('running');
  });

  // The cap used to exist ONLY server-side: past 24h the hub had quietly
  // buried the task while the bar counted up "running for 30h12m" on nothing.
  it('reads as stale past the cap, never as live work', () => {
    const now = 1_000_000;
    expect(effectiveBgStatus(task(now - BG_TASK_MAX_AGE_S), now)).toBe('stale');
    expect(effectiveBgStatus(task(now - BG_TASK_MAX_AGE_S * 2), now)).toBe('stale');
  });

  it('never rewrites a status that already ended', () => {
    const t = { ...task(0), status: 'completed' as const, endedAt: 10 };
    expect(effectiveBgStatus(t, 1_000_000)).toBe('completed');
  });
});
