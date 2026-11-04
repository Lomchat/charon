import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ row: { kind: 'claude', nativeSessionId: '11111111-2222-3333-4444-555555555555', cwd: '/srv/project', providerConfig: JSON.stringify({accountProfile:'0123456789abcdef'}), vpsId:'vps' }, call: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ all: () => [mocks.row] }) }) }) }, agentSessions: { id: 'id' } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({ getAgentClientForVpsId: () => ({ call: mocks.call }) }));
import { recoverSubagentTranscript } from '@/lib/server/hub/subagentTranscriptCompat';

const broken = { ok: true, messages: [{ role:'assistant', uuid:'known', content:'null' }] };
function range(uuid: string) { return {ok:true, offset:0, data:Buffer.from(JSON.stringify({type:'assistant', uuid, message:{content:[{type:'thinking',thinking:'hidden'}, {type:'text',text:'Real output'}]}})+'\n').toString('base64')}; }
beforeEach(() => mocks.call.mockReset());
describe('rolling-fleet null transcript compatibility', () => {
  it('leaves working readers unchanged without reading files', async () => {
    const good={ok:true,messages:[{content:'real output'}]};
    expect(await recoverSubagentTranscript('s','agent1',good)).toBe(good);
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it('recovers a bounded profile-scoped transcript with a matching native identity', async () => {
    mocks.call.mockResolvedValueOnce({ok:true,files:[{path:'workflows/run/agent-agent1.jsonl'}]}).mockResolvedValueOnce(range('known'));
    const result=await recoverSubagentTranscript('s','agent1',broken);
    expect(result.messages[0].content).toBe('Real output');
    expect(result.source).toBe('saved_tail');
    expect(mocks.call.mock.calls[0][1].root).toContain('/accounts/claude/0123456789abcdef/projects/-srv-project/');
    expect(mocks.call.mock.calls[1][1].length).toBe(262144);
  });
  it('refuses a file from a different identity or an ambiguous search', async () => {
    mocks.call.mockResolvedValueOnce({ok:true,files:[{path:'agent-agent1.jsonl'}]}).mockResolvedValueOnce(range('different'));
    expect((await recoverSubagentTranscript('s','agent1',broken)).ok).toBe(false);
    mocks.call.mockResolvedValueOnce({ok:true,files:[{path:'a/agent-agent1.jsonl'},{path:'b/agent-agent1.jsonl'}]});
    expect((await recoverSubagentTranscript('s','agent1',broken)).ok).toBe(false);
  });
  it('does not interpret an agent id as a path', async () => {
    await recoverSubagentTranscript('s','../agent1',broken);
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
