import { describe, expect, it } from 'vitest';
import { backgroundOutputPath, backgroundOutputText, subagentOutputText, prettyOutputJson, visibleSubagentBlocks } from '@/app/backgroundOutput';
import { bgAgentStatus } from '@/app/BgTaskConstellation';
import type { BgAgent } from '@/app/bgTasks';

describe('background output presentation', () => {
  it('keeps stdout text and structured application logs, removes ANSI', () => {
    expect(backgroundOutputText('start\n\u001b[32mpassed\u001b[0m\n{"count":4}')).toBe('start\npassed\n{\n  "count": 4\n}');
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

 describe('native sub-agent transcript', () => {
  it('renders SDK content blocks without reasoning, raw tool arguments or null placeholders', () => {
    expect(subagentOutputText([
      {role: 'assistant', content: 'null'},
      {role: 'user', content: 'private prompt'},
      {role: 'assistant', content: JSON.stringify([{type: 'thinking', thinking: 'hidden'}, {type: 'future_sdk_block', private: 'hidden'}, {type: 'tool_use', name: 'Read', input: {key: 'hidden'}}, {type: 'text', text: 'Visible output'}])},
    ])).toBe('› Read\n\nVisible output');
    expect(subagentOutputText([{role:'assistant',content:'{"status":"ok"}'}])).toBe('{\n  "status": "ok"\n}');
  });
});

describe('readable structured output', () => {
  it('indents nested JSON without sorting arrays or rounding large integers', () => {
    const raw = '{"z":9007199254740993,"items":[{"text":"é \\"x\\""},2],"empty":{}}';
    const result = prettyOutputJson(raw);
    expect(result).toContain('9007199254740993');
    expect(JSON.parse(result)).toEqual(JSON.parse(raw));
    expect(result).toContain('\n  "items": [\n    {');
    expect(result).toContain('"empty": {}');
  });
  it('keeps incomplete JSON and ordinary text intact', () => {
    expect(prettyOutputJson('{"items":[')).toBe('{"items":[');
    expect(prettyOutputJson('working…')).toBe('working…');
    expect(prettyOutputJson('```json\n{"ok":true}\n```')).toBe('{\n  "ok": true\n}');
  });
  it('shows the full structured result but never ordinary tool arguments or thinking', () => {
    const long = 'value'.repeat(3000);
    const blocks = visibleSubagentBlocks([
      { type:'thinking', thinking:'private' },
      { type:'tool_use', name:'Bash', input:{command:'private'} },
      { type:'tool_use', name:'StructuredOutput', input:{items:[long]} },
    ]);
    expect(blocks).toEqual(['› Bash', JSON.stringify({items:[long]})]);
  });
  it('does not discard a public JSON array as if it were SDK blocks', () => {
    expect(subagentOutputText([{role:'assistant',content:'[{"name":"first"},{"name":"last"}]'}]))
      .toBe(prettyOutputJson('[{"name":"first"},{"name":"last"}]'));
  });
});
