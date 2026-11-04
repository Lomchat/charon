import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { workflowRunFromReceipt, workflowAgentFromJournal, workflowAgentsFromJournal, readWorkflowTranscriptPage } from '@/lib/server/hub/workflowTranscript';

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

describe('incremental activity cursor', () => {
  it('reads only new bytes, keeps partial UTF-8 records behind the cursor, and joins results', async () => {
    let raw = record([{type:'tool_use',id:'read1',name:'Read',input:{file_path:'/a'}}]);
    const read = vi.fn(async (q: {offset:number;length:number}) => ({...await reader(raw)(q),version:'dev:inode:size:mtime'}));
    const first = await readWorkflowTranscriptPage(read,'root','a','session1','agent1');
    expect(first.entries[0]).toMatchObject({kind:'tool',file:'/a'});
    const result = JSON.stringify({type:'user',sessionId:'session1',agentId:'agent1',timestamp:'2026-01-01T00:00:00Z',message:{content:[{type:'tool_result',tool_use_id:'read1',content:'été'}]}})+'\n';
    raw += result.slice(0,-8);
    const options={after:first.nextAfter,cursor:first.cursor,fileId:first.fileId};
    const partial=await readWorkflowTranscriptPage(read,'root','a','session1','agent1',undefined,options);
    expect(partial.nextAfter).toBe(first.nextAfter); expect(partial.entries).toEqual([]);
    raw=raw.slice(0,-(result.length-8))+result;
    const delta=await readWorkflowTranscriptPage(read,'root','a','session1','agent1',undefined,options);
    expect(delta.entries).toHaveLength(1);
    expect(delta.entries[0]).toMatchObject({kind:'tool_result',toolId:'read1',content:'été'});
    expect(read.mock.calls.at(-1)?.[0].offset).toBe(first.nextAfter-64);
    const unchanged=await readWorkflowTranscriptPage(read,'root','a','session1','agent1',undefined,{after:delta.nextAfter,cursor:delta.cursor,fileId:delta.fileId});
    expect(unchanged.entries).toEqual([]); expect(unchanged.nextAfter).toBe(delta.nextAfter);
  });
  it('detects replacement, truncation and same-inode rewrites rather than merging epochs', async () => {
    let raw=record('initial'); let version='dev:inode:1:1';
    const read=async(q:any)=>({...await reader(raw)(q),version});
    const first=await readWorkflowTranscriptPage(read,'root','a','session1','agent1');
    const options={after:first.nextAfter,cursor:first.cursor,fileId:first.fileId};
    version='dev:new-inode:1:1';
    await expect(readWorkflowTranscriptPage(read,'root','a','session1','agent1',undefined,options)).rejects.toThrow('changed');
    version='dev:inode:1:1';raw='';
    await expect(readWorkflowTranscriptPage(read,'root','a','session1','agent1',undefined,options)).rejects.toThrow('changed');
    raw=record('changed');
    await expect(readWorkflowTranscriptPage(read,'root','a','session1','agent1',undefined,options)).rejects.toThrow('changed');
  });
});
