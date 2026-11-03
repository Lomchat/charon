import { describe, expect, it } from 'vitest';
import { backgroundOutputPath, backgroundOutputText } from '@/app/backgroundOutput';
import { bgAgentStatus } from '@/app/BgTaskConstellation';
import type { BgAgent } from '@/app/bgTasks';

describe('background output presentation', () => {
  it('keeps stdout text and structured application logs, removes ANSI', () => {
    expect(backgroundOutputText('start\n\u001b[32mpassed\u001b[0m\n{"count":4}')).toBe('start\npassed\n{"count":4}');
  });
  it('renders native assistant text without tool inputs, thinking or user envelopes', () => {
    const raw = [
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'tool_use', input: { secret: 'hidden' } }, { type: 'text', text: 'Working…' }] } },
      { type: 'user', message: { content: 'hidden' } },
      { type: 'result', result: 'Done.' },
    ].map((value) => JSON.stringify(value)).join('\n');
    expect(backgroundOutputText(raw)).toBe('Working…\nDone.');
  });
  it('does not leak an incomplete native record while the file is being written', () => {
    expect(backgroundOutputText('{"type":"assistant","message":{"content":')).toBe('');
  });
  it('resolves absolute task files independently of the workspace', () => {
    expect(backgroundOutputPath('/tmp/tasks/a.output', '/srv/app')).toEqual({ root: '/', path: 'tmp/tasks/a.output' });
    expect(backgroundOutputPath('tasks/a.output', '/srv/app')).toEqual({ root: '/srv/app', path: 'tasks/a.output' });
    expect(backgroundOutputPath('tasks/a.output', null)).toBeNull();
  });
  it('never turns an unknown child status into running or done', () => {
    const agent = (state: string | null) => ({ state } as BgAgent);
    expect(bgAgentStatus(agent(null))).toBe('unknown');
    expect(bgAgentStatus(agent('new-sdk-word'))).toBe('unknown');
    expect(bgAgentStatus(agent('done'))).toBe('completed');
    expect(bgAgentStatus(agent('error'))).toBe('failed');
  });
});
