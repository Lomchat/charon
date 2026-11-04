import { describe, it, expect } from 'vitest';
import { projectAgentRecord, summarizeAgentActivity } from '@/lib/subagentActivity';
import { getActivityEntry, mergeActivityPage, newActivityEntry, saveActivityEntry } from '@/app/workflowActivityCache';
import type { WorkflowOutputResponse } from '@/lib/types/api';
const at = '2026-11-04T10:00:00Z';
const project = (content: any, type = 'assistant', offset = 0) => projectAgentRecord({ type, timestamp: at, message: { model:'model1', content } }, offset);

describe('public agent activity', () => {
  it('shows command, file and search targets, not private reasoning or arbitrary inputs', () => {
    const entries = project([
      {type:'thinking',thinking:'private'},
      {type:'tool_use',id:'a',name:'Bash',input:{command:'npm test',description:'Run tests',password:'private'}},
      {type:'tool_use',id:'b',name:'Read',input:{file_path:'/srv/app/main.ts',offset:20,limit:40}},
      {type:'tool_use',id:'c',name:'Grep',input:{pattern:'useEffect',path:'/srv/app'}},
      {type:'tool_use',id:'d',name:'Unknown',input:{secret:'private'}},
    ]);
    expect(JSON.stringify(entries)).not.toContain('private');
    expect(entries[0]).toMatchObject({target:'Run tests',detail:'npm test',toolId:'a'});
    expect(entries[1]).toMatchObject({file:'/srv/app/main.ts',operation:'read'});
    expect(entries[2].target).toBe('useEffect');
    expect(entries[3].detail).toBeUndefined();
  });
  it('pairs delayed returns across pages and counts only confirmed file operations', () => {
    const calls = project([
      {type:'tool_use',id:'write',name:'Write',input:{file_path:'/a',content:'new'}},
      {type:'tool_use',id:'read',name:'Read',input:{file_path:'/b'}},
    ]);
    const results = project([{type:'tool_result',tool_use_id:'write',content:'denied',is_error:true},
      {type:'tool_result',tool_use_id:'read',content:[{type:'text',text:'file contents'}]}],'user',200);
    const summary = summarizeAgentActivity([...calls,...results]);
    expect(summary.calls[0].result?.error).toBe(true);
    expect(summary.files.find(f=>f.path==='/a')?.written).toBe(false);
    expect(summary.files.find(f=>f.path==='/b')?.read).toBe(true);
    expect(summary.errors).toBe(1);
    expect(summary.orphanResults).toHaveLength(0);
    expect(summarizeAgentActivity(results).orphanResults).toHaveLength(2);
  });
  it('keeps structured results and prose separate from tool activity', () => {
    const entries = project([{type:'text',text:'Finished.'},{type:'tool_use',name:'StructuredOutput',input:{items:[1,2]}}]);
    expect(summarizeAgentActivity(entries).output.map(e=>e.content)).toEqual(['Finished.','{"items":[1,2]}']);
    expect(summarizeAgentActivity(entries).calls).toEqual([]);
  });
});

describe('node activity cache', () => {
  const page = (entries: any[], nextBefore: number|null, nextAfter: number): Extract<WorkflowOutputResponse,{ok:true}> =>
    ({ok:true,agentId:'a',entries,blocks:[],nextBefore,nextAfter,cursor:'cursor',fileId:'file',moreAfter:false,source:'workflow_transcript'});
  it('merges history and deltas by identity without losing loaded pages', () => {
    const item=newActivityEntry();
    mergeActivityPage(item,page(project([{type:'text',text:'middle'}],'assistant',100),100,200),false);
    mergeActivityPage(item,page(project([{type:'text',text:'earlier'}],'assistant',0),null,100),true);
    mergeActivityPage(item,page(project([{type:'text',text:'last'}],'assistant',200),200,300),false);
    mergeActivityPage(item,page(project([{type:'text',text:'last'}],'assistant',200),200,300),false);
    expect(item.entries.map(e=>e.content)).toEqual(['earlier','middle','last']);
    expect(item.before).toBeNull(); expect(item.after).toBe(300);
    item.view.activityTop=153; item.view.followActivity=false; item.view.expanded=['100:0'];
    saveActivityEntry('session-a:node-a',item);
    expect(getActivityEntry('session-a:node-a')).toBe(item);
    expect(getActivityEntry('session-a:node-b').entries).toEqual([]);
    expect(getActivityEntry('session-b:node-a').entries).toEqual([]);
    expect(getActivityEntry('session-a:node-a').view.activityTop).toBe(153);
  });
  it('evicts the oldest cached node rather than the just-opened one', () => {
    for (let i=0;i<21;i++) {
      const item=newActivityEntry(); item.entries=project([{type:'text',text:String(i)}]);
      saveActivityEntry(`lru-node-${i}`,item);
    }
    expect(getActivityEntry('lru-node-0').entries).toEqual([]);
    expect(getActivityEntry('lru-node-20').entries[0].content).toBe('20');
  });
  it('retains entry references when an incremental check has no new activity', () => {
    const item=newActivityEntry();
    const refs=item.entries;
    mergeActivityPage(item,page([],null,0),false);
    expect(item.entries).toBe(refs);
  });
});
