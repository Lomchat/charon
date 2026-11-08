import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
import { summarizeWorkflowResult, workflowAgentTimes, workflowAgentsFromJournal } from '@/lib/server/hub/workflowTranscript';
import { workflowRole, workflowTimeline } from '@/app/bgWorkflowTimeline';

// §14.91: the workflow frise reads the run's journal (no timestamps) and the
// run folder's file times. Results are reduced to a bounded summary: the
// journal can hold megabytes of structured output.
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 8, 7, 14, 0);

describe('workflow journal → timed nodes', () => {
  it('summarizes any result shape within bounds', () => {
    const judge = summarizeWorkflowResult({
      deliverable: false, verdict: 'Not yet. '.repeat(100),
      findings: [{ severity: 'broken', where: 'a' }, { severity: 'detail', where: 'b' }, { severity: 'broken', where: 'c' }],
    })!;
    expect(judge.flags).toEqual([{ key: 'deliverable', value: false }]);
    expect(judge.counts).toEqual([{ key: 'findings', n: 3, by: [{ value: 'broken', n: 2 }, { value: 'detail', n: 1 }] }]);
    expect(judge.text!.length).toBeLessThanOrEqual(300);
    expect(summarizeWorkflowResult('24c49f2d73e28af900efaf301810eba1c3d23d65')).toEqual({ text: '24c49f2d73e28af900efaf301810eba1c3d23d65' });
    const wide = summarizeWorkflowResult(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, [i]])))!;
    expect(wide.counts!.length).toBeLessThanOrEqual(8);
    expect(summarizeWorkflowResult(null)).toBeNull();
  });

  it('times each node from its files and keeps result/failed apart from unknown', () => {
    const times = workflowAgentTimes([
      { name: 'agent-a1.meta.json', mtime: T0 / 1000 }, { name: 'agent-a1.jsonl', mtime: T0 / 1000 + 600 },
      { name: 'agent-a2.meta.json', mtime: T0 / 1000 + 5 }, { name: 'journal.jsonl', mtime: 1 }, { name: 'agent-../x.jsonl', mtime: 1 },
    ]);
    expect([...times.keys()]).toEqual(['a1', 'a2']);
    const journal = [
      { type: 'started', agentId: 'a1', label: 'r1:judge', phase: 'Loop' },
      { type: 'started', agentId: 'a2', label: 'fix-1', phase: 'Loop' },
      { type: 'started', agentId: 'a3', label: 'r1:other', phase: 'Loop' },
      { type: 'result', agentId: 'a1', outcome: { flags: [{ key: 'ok', value: false }] } },
      { type: 'failed', agentId: 'a2' },
    ].map((r) => JSON.stringify(r)).join('\n');
    const agents = workflowAgentsFromJournal(journal, times);
    expect(agents.map((a) => [a.agentId, a.state, a.startedAt, a.lastActivityAt])).toEqual([
      ['a1', 'done', T0, T0 + 600_000], ['a2', 'failed', T0 + 5000, null], ['a3', null, null, null],
    ]);
    expect(agents[0].outcome).toEqual({ flags: [{ key: 'ok', value: false }] });
  });
});

describe('the frise layout', () => {
  const node = (agentId: string, label: string, start: number, last: number, state: string | null, outcome: any = null) => ({
    index: 0, label, state, model: null, phaseTitle: 'Loop', tokens: null, toolCalls: null, durationMs: null, resultPreview: null,
    agentId, startedAt: T0 + start * MIN, lastActivityAt: T0 + last * MIN, outcome,
  });
  const no = { flags: [{ key: 'deliverable', value: false }] };
  const agents = [
    node('j1', 'r1:art', 0, 20, 'done', no), node('j2', 'r1:player', 0, 15, 'done', no),
    node('f1', 'fix-1', 47, 83, 'done'), node('j3', 'r2:art', 90, 120, 'done', no), node('j4', 'r2:player', 90, 105, 'done', no),
    node('f2', 'fix-2', 125, 300, null),
  ];

  it('lines rounds up by role, marks parallel starts, flags a step far slower than before', () => {
    expect(workflowRole('r2:directeur-artistique')).toBe('directeur-artistique');
    expect(workflowRole('correction-2')).toBe('correction');
    expect(workflowRole('commit')).toBe('commit');
    const tl = workflowTimeline(agents, { startedAt: T0 / 1000, endedAt: null }, 'running', T0 + 340 * MIN)!;
    expect(tl.lanes.map((l) => [l.role, l.agents.length])).toEqual([['art', 2], ['player', 2], ['fix', 2]]);
    expect(tl.waves.map((w) => w.label)).toEqual(['R1', 'R2']);
    expect(tl.agents.find((a) => a.id === 'j1')!.status).toBe('negative');
    expect(tl.running.map((a) => a.id)).toEqual(['f2']);
    expect(tl.done).toBe(5);
    expect(tl.slow?.agent.id).toBe('f2');
    expect(tl.slow?.usual).toBe(36 * MIN);
  });

  it('an ended run has no running bar, and no times means no frise', () => {
    const tl = workflowTimeline(agents, { startedAt: T0 / 1000, endedAt: (T0 + 310 * MIN) / 1000 }, 'killed', T0 + 400 * MIN)!;
    expect(tl.running).toEqual([]);
    expect(tl.agents.find((a) => a.id === 'f2')!.status).toBe('unknown');
    expect(workflowTimeline(agents.map((a) => ({ ...a, startedAt: null })), { startedAt: 0, endedAt: null }, 'running', 0)).toBeNull();
  });
});
