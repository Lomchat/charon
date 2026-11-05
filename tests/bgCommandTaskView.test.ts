import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BgTaskConstellation from '@/app/BgTaskConstellation';
import type { BgTask } from '@/app/bgTasks';

(globalThis as { React?: typeof React }).React = React;

// A background shell command has no sub-agents: the view shows its command
// line and output, never "sub-agents · details not received" (§14.91).
const task = (over: Partial<BgTask> = {}): BgTask => ({
  taskId: 'b3pzwg55z', description: 'Wait, then deploy', command: './wait_deploy.sh', toolUseId: 't1',
  taskType: 'local_bash', status: 'running', startedAt: 100, endedAt: null, outputFile: null, summary: null,
  workflowName: null, usage: null, lastToolName: null, agents: null, ...over,
});
const render = (t: BgTask) => renderToStaticMarkup(createElement(BgTaskConstellation, {
  sessionId: 's', task: t, status: t.status, vpsId: 'v', cwd: '/srv', provider: 'claude', nowS: 160, onStop: () => {},
}));

describe('background command view', () => {
  it('shows the command line and no sub-agent framing', () => {
    const html = render(task());
    expect(html).toContain('./wait_deploy.sh');
    expect(html).toContain('Background command');
    expect(html).not.toContain('Details not received');
    expect(html).not.toContain('Session sub-agents');
    expect(html).not.toContain('Select a saved sub-agent');
  });

  it('names its output file once reported', () => {
    expect(render(task({ outputFile: '/tmp/x/tasks/b3pzwg55z.output' }))).toContain('/tmp/x/tasks/b3pzwg55z.output');
  });

  it('keeps the sub-agent map for a workflow run', () => {
    const html = render(task({ taskType: 'local_workflow', command: null, workflowName: 'review' }));
    expect(html).toContain('Details not received');
    expect(html).not.toContain('Background command');
  });

  // A `local_agent` task id IS its native transcript: show its activity, not
  // "select a saved sub-agent" while it runs.
  it('reads a background agent from its own transcript', () => {
    const html = render(task({ taskId: 'ada49859aaa5aa693', taskType: 'local_agent', command: null }));
    expect(html).toContain('Background agent');
    expect(html).toContain('aria-label="Agent details"');
    expect(html).not.toContain('Select a saved sub-agent');
    expect(html).not.toContain('Details not received');
  });
});
