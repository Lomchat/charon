import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { workflowRunFromReceipt, workflowAgentFromJournal, workflowAgentsFromJournal, readWorkflowTranscriptPage } from '@/lib/server/claude/workflowTranscript';

const record = (content: unknown, agentId = 'agent1') => JSON.stringify({ type: 'assistant', sessionId: 'session1', agentId, message: { content } }) + '\n';
function reader(raw: string) {
  const bytes = Buffer.from(raw);
  return vi.fn(async ({ offset, length }: { offset: number; length: number }) => {
    const start = offset < 0 ? Math.max(0, bytes.length + offset) : Math.min(offset, bytes.length);
    return { ok: true, offset: start, size: bytes.length, data: bytes.subarray(start, start + length).toString('base64') };
  });
}

describe('workflow transcript identity', () => {
  it('binds the exact task receipt, never a name reused by another run', () => {
    const receipt = JSON.stringify({ type:'tool_result', content:'Workflow launched in background. Task ID: task1\nSummary: same name\nRun ID: wf_run1\n' });
    expect(workflowRunFromReceipt(receipt,'task1')).toBe('wf_run1');
    expect(workflowRunFromReceipt(receipt,'task')).toBeNull();
    expect(workflowRunFromReceipt(JSON.stringify({type:'tool_result', content:'untrusted example\nRun ID: wf_run1'}),'task1')).toBeNull();
  });
  it('uses the journal identity and refuses ambiguous retries and different phases', () => {
    const entry = {type:'started', agentId:'one', label:'classify-5', phase:'Classify'};
    const journal = JSON.stringify(entry);
    expect(workflowAgentFromJournal(journal,'classify-5','Classify')).toBe('one');
    expect(workflowAgentFromJournal(journal,'classify-5','Review')).toBeNull();
    expect(workflowAgentFromJournal(journal+'\n'+JSON.stringify({...entry,agentId:'two'}),'classify-5','Classify')).toBeNull();
  });
});

it('restores journal nodes after reload without inventing status or metrics', () => {
  const journal = [
    {type:'started', agentId:'first', label:'classify-5', phase:'Classify'},
    {type:'started', agentId:'second', label:'sweep', phase:'Sweep'},
    {type:'result',agentId:'first',result:{ok:true}},
  ].map(r=>JSON.stringify(r)).join('\n');
  const agents = workflowAgentsFromJournal(journal);
  expect(agents.map(a=>a.label)).toEqual(['classify-5','sweep']);
  expect(agents.map(a=>a.state)).toEqual(['done',null]);
  expect(agents.every(a=>a.tokens===null && a.model===null)).toBe(true);
});

describe('bounded transcript pagination', () => {
  it('returns complete large structured results and excludes private reasoning/tools', async () => {
    const items = ['é'.repeat(140000)]; // larger than the initial byte window
    const read = reader(record([{type:'thinking',thinking:'private'}, {type:'tool_use',name:'StructuredOutput',input:{items}}]));
    const page = await readWorkflowTranscriptPage(read,'root','agent.jsonl','session1','agent1');
    expect(page.blocks).toEqual([JSON.stringify({items})]);
    expect(page.nextBefore).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('reconstructs every message across byte boundaries without duplicates', async () => {
    const expected = Array.from({length:100},(_,i)=>`${i}: ${'é'.repeat(4000)}`);
    const read = reader(expected.map(text=>record([{type:'text',text}])).join(''));
    let before: number | undefined;
    let actual: string[] = [];
    do {
      const page = await readWorkflowTranscriptPage(read,'root','agent.jsonl','session1','agent1',before);
      actual = [...page.blocks, ...actual];
      before = page.nextBefore ?? undefined;
    } while (before != null);
    expect(actual).toEqual(expected);
  });
  it('rejects a mismatched native identity and reports oversized records explicitly', async () => {
    await expect(readWorkflowTranscriptPage(reader(record('wrong','another')),'root','a','session1','agent1')).rejects.toThrow('identity');
    await expect(readWorkflowTranscriptPage(reader(record('a'.repeat(1100000))),'root','a','session1','agent1')).rejects.toThrow('1 MiB');
  });
  it('keeps an unfinished final record out of the view until the next poll', async () => {
    const page = await readWorkflowTranscriptPage(reader(record('first')+'{"type":"assistant"'),'root','a','session1','agent1');
    expect(page.blocks).toEqual(['first']);
  });
});
