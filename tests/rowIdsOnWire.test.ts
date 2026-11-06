import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AgentEvent } from '@/lib/server/agent/types';
import { isRenderedRow, RENDER_NULL_ROLES } from '@/lib/transcriptRows';

// DB row ids on the wire (sync refonte C08, I15): every frame whose handler
// persisted a RENDERED row carries that row's id as `rowId`, and so do the
// non-rendered carriers (`bg_task`, `edit_snapshot`, the gate frames). Never a
// numeric `messageId` — that name means a PEER message id on
// `external_message`/`peer_message_status` (strings); only `blocking_error`
// and `scheduled_resume` keep their historical numeric `messageId` (row ids).
// Exhaustive: EVERY agent event type is driven through a stream (the fixture
// map is typed on `AgentEvent['event']`, so a new event type fails tsc until
// it gets a scenario here), and every new row it wrote is checked against the
// frames it published.

const pool = vi.hoisted(() => ({
  client: {
    setAfterSeq: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    resubscribe: () => {},
    backpressuresReplay: () => true,
    call: async (..._args: any[]): Promise<any> => ({ ok: true }),
  },
}));
const codexObservations = vi.hoisted(() => ({ list: [] as any[] }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: async () => ({ userId: 'u' }) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => pool.client,
  getAgentClient: () => pool.client,
  dropAgentClient: async () => {},
}));
vi.mock('@/lib/server/hub/codexBgState', () => ({ readCodexBgState: async () => codexObservations.list }));
vi.mock('@/lib/server/hub/webPush', () => ({ sendPushToAll: async () => {} }));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: async () => {},
  sendQuestionToTelegram: async () => {},
  markInteractionResolvedInTelegram: async () => {},
  sendPlainToTelegram: async () => {},
}));

const VPS_ID = 'rowidvps';
const SID = '5'.repeat(32);
const T0 = Date.now() - 3_600_000;

// The I15 rule reads the shared classification (lib/transcriptRows.ts).
const isRenderedRowFull = (role: string, eventType: string | null) => isRenderedRow(role, eventType, 'full');
/** Non-rendered rows whose frames carry `rowId` too (in-place renames). */
function isCarrierRow(role: string, eventType: string | null): boolean {
  return role === 'edit_snapshot' || (RENDER_NULL_ROLES as readonly string[]).includes(role) || (role === 'event' && eventType === 'bg_task');
}
/** Frames whose numeric `messageId` predates `rowId` (both are row ids). */
const ROW_MESSAGE_ID_FRAMES = ['blocking_error', 'scheduled_resume'];

/** The role (and event type) the row named by each frame type must have. */
const FRAME_ROW: Record<string, (role: string, type: string | null) => boolean> = {
  user_echo: (r) => r === 'user',
  tool_use: (r) => r === 'tool_use',
  tool_result: (r) => r === 'tool_result',
  thinking: (r, t) => r === 'event' && t === 'thinking',
  thinking_flushed: (r, t) => r === 'event' && t === 'thinking',
  assistant_flushed: (r) => r === 'assistant',
  assistant_reopened: (r) => r === 'assistant',
  user_question: (r) => r === 'user_question' || r === 'async_question',
  exit_plan_request: (r) => r === 'exit_plan_request',
  edit_snapshot: (r) => r === 'edit_snapshot',
  bg_task: (r, t) => r === 'event' && t === 'bg_task',
  structured_output: (r, t) => r === 'event' && t === 'structured_output',
  compaction: (r, t) => r === 'event' && t === 'compaction',
  scheduled_fire: (r, t) => r === 'event' && t === 'scheduled_fire',
  external_message: (r, t) => r === 'event' && t === 'external_message',
  peer_message_status: (r, t) => r === 'event' && t === 'peer_message_status',
  plan_update: (r, t) => r === 'event' && t === 'plan_update',
  blocking_error: (r) => r === 'error',
};

type Scenario = {
  kind?: 'claude' | 'codex';
  /** Agent events WITHOUT session_id/seq/ts (`seq: null` = a seq-less event). */
  events: Array<Record<string, unknown>>;
  setup?: (s: any) => void;
};
const nowS = () => Math.floor(Date.now() / 1000);
const QUESTIONS = [{ question: 'Which?', options: [{ label: 'A' }] }];

// tsc-exhaustive: one scenario per agent event type.
const FIXTURES: { [K in AgentEvent['event']]: Scenario } = {
  replay_begin: { events: [{ event: 'replay_begin', count: 0, seq: null }, { event: 'replay_end', seq: null }] },
  replay_end: { events: [{ event: 'replay_end', seq: null }] },
  replay_gap: { events: [{ event: 'replay_gap', after_seq: 5, earliest_seq: 9, seq: null }] },
  seq_epoch_reset: { events: [{ event: 'seq_epoch_reset', after_seq: 50, current_seq: 3, seq: null }] },
  status: {
    events: [{ event: 'status', status: 'sleeping' }],
    setup: (s) => { s.bgRunning = new Map([['task-status', nowS()]]); },
  },
  ready: { events: [{ event: 'bg_task', kind: 'started', task_id: 'task-ready', tool_use_id: 'tu' }, { event: 'ready' }] },
  session_id: { events: [{ event: 'session_id', claude_session_id: 'native-1' }] },
  assistant_text: { events: [{ event: 'assistant_text', delta: ' more' }, { event: 'stop', subtype: 'success' }] },
  structured_output: { events: [{ event: 'structured_output', value: { ok: 1 } }] },
  thinking: { events: [{ event: 'thinking', text: 'A complete block.' }] },
  generation_progress: { events: [{ event: 'generation_progress', characters: 10 }] },
  tool_use: { events: [{ event: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/x' } }] },
  tool_result: { events: [{ event: 'tool_result', tool_use_id: 'tu-1', content: 'out', is_error: false }] },
  tool_progress: { events: [{ event: 'tool_progress', tool_use_id: 'tu-1', delta: 'partial' }] },
  edit_progress: { events: [{ event: 'edit_progress', tool_use_id: 'tu-1', file_path: '/x', diff: '@@', size: 2, truncated: false }] },
  plan_progress: { events: [{ event: 'plan_progress', id: 'p1', text: '1. a' }] },
  plan_update: { events: [{ event: 'plan_update', id: 'p1', steps: [{ step: 'a', status: 'pending' }] }] },
  tool_activity: { events: [{ event: 'tool_activity', kind: 'mcp', id: 'a1', status: 'active' }] },
  codex_signal: { kind: 'codex', events: [{ event: 'codex_signal', kind: 'filesystem', id: 'fs1', status: 'changed', detail: { paths: [] } }] },
  permission_request: { events: [{ event: 'permission_request', id: 'perm-1', tool: 'Bash', input: { command: 'ls' }, expires_at: nowS() + 600 }] },
  user_question: { events: [
    { event: 'user_question', id: 'q-block', questions: QUESTIONS, expires_at: nowS() + 600 },
    { event: 'user_question', id: 'q-async', questions: QUESTIONS, delivery: 'async' },
  ] },
  exit_plan_request: { events: [{ event: 'exit_plan_request', id: 'plan-req', plan: 'the plan' }] },
  interaction_resolved: { events: [{ event: 'interaction_resolved', id: 'perm-x', kind: 'permission', outcome: 'expired' }] },
  edit_snapshot: { events: [
    { event: 'edit_snapshot', phase: 'before', tool_use_id: 'tu-1', file_path: '/x', content: 'a', size: 1, truncated: false },
    { event: 'edit_snapshot', phase: 'diff', tool_use_id: 'tu-2', file_path: '/y', content: null, diff: '@@', size: 2, truncated: false },
  ] },
  mode_changed: { events: [{ event: 'mode_changed', mode: 'plan' }] },
  model_changed: { events: [{ event: 'model_changed', model: 'opus', fallback_model: null }] },
  effort_changed: { events: [{ event: 'effort_changed', effort: 'high' }] },
  effective_model: { events: [{ event: 'effective_model', model: 'claude-x' }] },
  bg_task: { events: [
    { event: 'bg_task', kind: 'started', task_id: 'task-bg', tool_use_id: 'tu', description: 'build' },
    { event: 'bg_task', kind: 'finished', task_id: 'task-bg', status: 'completed', terminal: true },
  ] },
  bg_task_progress: { events: [{ event: 'bg_task_progress', task_id: 'task-bg', usage: { tokens: 1 }, seq: null }] },
  usage: { events: [{ event: 'usage', output_tokens: 5, input_tokens: 3, final: true, seq: null }] },
  endpoint_usage: { events: [{ event: 'endpoint_usage', request_id: 'r1', input_tokens: 1, output_tokens: 2, total_tokens: 3 }] },
  interrupted: { events: [{ event: 'interrupted' }] },
  stop: { events: [{ event: 'stop', subtype: 'error', is_error: true, api_error_status: 500 }] },
  compaction: { events: [{ event: 'compaction', trigger: 'auto', pre_tokens: 10, post_tokens: 1 }] },
  unprompted_turn: {
    events: [{ event: 'unprompted_turn' }],
    setup: (s) => {
      db.update(schema.agentSessions).set({ scheduledTasksJson: JSON.stringify({ asOf: T0, tasks: [
        { id: 'aaaaaaaa', schedule: '* * * * *', recurring: true, prompt: '[Recheck] look again', nextFireAt: T0, createdAt: T0 },
      ] }) }).where(eq(schema.agentSessions.id, s.id)).run();
    },
  },
  session_info: { events: [{ event: 'session_info', capabilities: ['x'] }] },
  turn_end: { events: [
    { event: 'bg_task', kind: 'started', task_id: 'task-hook', tool_use_id: 'tu' },
    { event: 'turn_end', background_tasks: [] },
  ] },
  rate_limit: { events: [{ event: 'rate_limit', status: 'allowed' }] },
  external_message: { events: [{ event: 'external_message', origin: 'charon_peer', text: 'hi', message_id: 'peer-msg-1', from: '@a', conversation_id: 'c1' }] },
  peer_message_status: { events: [{ event: 'peer_message_status', message_id: 'peer-msg-2', conversation_id: 'c1', status: 'replied', text: 'done' }] },
  turn_error: { events: [{ event: 'turn_error', kind: 'billing_error' }] },
  error: { events: [{ event: 'error', msg: 'the SDK died', fatal: true }] },
  shell_status: { events: [{ event: 'shell_status', shell_id: 's1', status: 'busy', cols: 80, rows: 24, pid: 1, seq: null }] },
  shell_output: { events: [{ event: 'shell_output', shell_id: 's1', data: 'x', seq: null }] },
  shell_exit: { events: [{ event: 'shell_exit', shell_id: 's1', code: 0, seq: null }] },
  shell_idle: { events: [{ event: 'shell_idle', shell_id: 's1', idle_seconds: 1, burst_seconds: 1, burst_bytes: 1, seq: null }] },
};

/** The rows each scenario writes (oldest first); absent = none. */
const WRITES: Partial<Record<string, string[]>> = {
  replay_gap: ['event:replay_gap'],
  seq_epoch_reset: ['assistant'],
  status: ['event:bg_task'],
  ready: ['event:bg_task', 'event:bg_task'],
  assistant_text: ['assistant'],
  structured_output: ['assistant', 'event:structured_output'],
  thinking: ['assistant', 'event:thinking'],
  tool_use: ['assistant', 'tool_use'],
  tool_result: ['tool_result'],
  plan_progress: ['assistant'],
  plan_update: ['assistant', 'event:plan_update'],
  permission_request: ['assistant'],
  user_question: ['assistant', 'user_question', 'async_question'],
  exit_plan_request: ['assistant', 'exit_plan_request'],
  edit_snapshot: ['edit_snapshot', 'edit_snapshot'],
  effective_model: ['assistant'],
  bg_task: ['event:bg_task', 'event:bg_task'],
  usage: ['event:turn_usage'],
  endpoint_usage: ['event:endpoint_usage'],
  stop: ['assistant', 'error'],
  compaction: ['assistant', 'event:compaction'],
  unprompted_turn: ['assistant', 'event:scheduled_fire'],
  turn_end: ['event:bg_task', 'event:bg_task'],
  external_message: ['assistant', 'event:external_message'],
  peer_message_status: ['assistant', 'event:peer_message_status'],
  error: ['error'],
};

let db: any;
let schema: any;
let SessionStream: any;
let nextSeq = 1;

function mkStream(kind: 'claude' | 'codex' = 'claude') {
  return new SessionStream({
    id: SID, vpsId: VPS_ID, name: null,
    status: 'active', permissionMode: 'normal', nativeSessionId: null, kind,
  }) as any;
}

function stamp(e: Record<string, unknown>) {
  const { seq: given, ...rest } = e;
  if (given === null) return { session_id: SID, ...rest };
  const seq = nextSeq++;
  return { session_id: SID, seq, ts: (T0 + seq) / 1000, ...rest };
}

function allRows() {
  return db.select().from(schema.sessionMessages).all().filter((r: any) => r.sessionId === SID);
}
function eventType(r: any): string | null {
  if (r.role !== 'event') return null;
  try { return JSON.parse(r.content).type ?? null; } catch { return null; }
}
function frameRowId(f: any): number | undefined {
  if (typeof f.rowId === 'number') return f.rowId;
  return ROW_MESSAGE_ID_FRAMES.includes(f.type) && typeof f.messageId === 'number' ? f.messageId : undefined;
}

/** The I15 contract for the frames published while `newRows` were written. */
function checkWire(frames: any[], newRows: any[], label: string) {
  const byId = new Map<number, any>(allRows().map((r: any) => [r.id, r]));
  for (const row of newRows) {
    const type = eventType(row);
    if (!isRenderedRowFull(row.role, type) && !isCarrierRow(row.role, type)) continue;
    expect(frames.some((f) => frameRowId(f) === row.id), `${label}: a frame names row ${row.id} (${row.role}/${type})`).toBe(true);
  }
  for (const f of frames) {
    if (typeof f.messageId === 'number') {
      expect(ROW_MESSAGE_ID_FRAMES, `${label}: numeric messageId on ${f.type}`).toContain(f.type);
    }
    if (f.type === 'external_message' || f.type === 'peer_message_status') {
      if (f.messageId !== undefined) expect(typeof f.messageId, `${label}: peer id stays a string`).toBe('string');
    }
    const id = frameRowId(f);
    if (id == null) continue;
    const row = byId.get(id);
    expect(row, `${label}: ${f.type} names an existing row`).toBeDefined();
    const fits = FRAME_ROW[f.type];
    expect(fits, `${label}: ${f.type} is a known rowId carrier`).toBeDefined();
    expect(fits(row.role, eventType(row)), `${label}: ${f.type} names a ${row.role}/${eventType(row)} row`).toBe(true);
  }
  // Frames of non-rendered rows carry no rowId (I15).
  for (const f of frames.filter((x) => ['usage', 'error', 'interaction_resolved', 'session_token_usage'].includes(x.type))) {
    expect(f, `${label}: ${f.type} carries no rowId`).not.toHaveProperty('rowId');
  }
}

async function drive(s: any, events: any[]) {
  const frames: any[] = [];
  vi.spyOn(s, '_emitBroadcast').mockImplementation(((f: any) => { frames.push(f); }) as any);
  const before = Math.max(0, ...allRows().map((r: any) => r.id));
  for (const e of events) s._onAgentEvent(e);
  s._flushAssistantBroadcast();
  await new Promise((r) => setTimeout(r, 0));
  return { frames, newRows: allRows().filter((r: any) => r.id > before) };
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  db.insert(schema.agentSessions).values({ id: SID, vpsId: VPS_ID, cwd: '/tmp', status: 'active' }).onConflictDoNothing().run();
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
  ({ SessionStream } = await import('@/lib/server/agent/sessionOps'));
  // Preloaded: a first import racing the stop handlers' deferred import hits its TDZ.
  await import('@/lib/server/agent/endpointOps');
});

afterEach(() => {
  db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, SID)).run();
  db.delete(schema.sessionPendingQuestions).run();
  db.delete(schema.sessionPendingPermissions).run();
  db.update(schema.agentSessions).set({ lastSeenSeq: null, pendingAssistantMessageId: null, lastStopNotifiedSeq: null }).run();
  codexObservations.list = [];
});

describe('rowId on every frame of a persisted row (exhaustive over AgentEvent)', () => {
  it.each(Object.entries(FIXTURES))('%s', async (name, scenario) => {
    const s = mkStream(scenario.kind);
    scenario.setup?.(s);
    // An open answer first: boundary events flush it (assistant_flushed).
    const events = [stamp({ event: 'assistant_text', delta: `Text before ${name}.` }), ...scenario.events.map(stamp)];
    const { frames, newRows } = await drive(s, events);
    // The scenario really writes what it is meant to exercise.
    expect(newRows.map((r: any) => r.role + (eventType(r) ? ':' + eventType(r) : ''))).toEqual(WRITES[name] ?? []);
    checkWire(frames, newRows, name);
  });

  it('a delta provider\'s coalesced reasoning row is named by thinking_flushed', async () => {
    const s = mkStream('codex');
    const { frames, newRows } = await drive(s, [
      stamp({ event: 'assistant_text', delta: 'Before.' }),
      stamp({ event: 'thinking', text: 'reason ' }), stamp({ event: 'thinking', text: 'more' }),
      stamp({ event: 'tool_use', id: 'tu-c', name: 'Read', input: {} }),
    ]);
    expect(newRows.map((r: any) => [r.role, eventType(r)])).toEqual([['assistant', null], ['event', 'thinking'], ['tool_use', null]]);
    checkWire(frames, newRows, 'codex thinking');
    expect(frames.find((f) => f.type === 'thinking_flushed').rowId).toBe(newRows[1].id);
  });

  it('a replay-gated plan_update names the row it already has', async () => {
    const live = mkStream();
    const planEvent = stamp({ event: 'plan_update', id: 'p9', steps: [{ step: 'a', status: 'done' }] });
    await drive(live, [planEvent]);
    const [planRow] = allRows();
    const s = mkStream();
    const { frames } = await drive(s, [{ event: 'replay_begin', session_id: SID, count: 1 }, planEvent,
      { event: 'replay_end', session_id: SID }]);
    expect(frames.filter((f) => f.type === 'plan_update')).toEqual([expect.objectContaining({ rowId: planRow.id, replay: true })]);
    expect(allRows()).toHaveLength(1);
  });

  it('the turn_end receipts and the sleep burial name their rows', async () => {
    const s = mkStream();
    const started = await drive(s, [stamp({ event: 'bg_task', kind: 'started', task_id: 'tb', tool_use_id: 'tu' })]);
    expect(started.frames.find((f) => f.type === 'bg_task').rowId).toBe(started.newRows[0].id);
    const receipt = await drive(s, [stamp({ event: 'turn_end', background_tasks: [] })]);
    expect(receipt.newRows.map(eventType)).toEqual(['bg_task']);
    expect(receipt.frames.find((f) => f.type === 'bg_task')).toMatchObject({ kind: 'finished', rowId: receipt.newRows[0].id });
    s.bgRunning = new Map([['tc', nowS()]]);
    const burial = await drive(s, [stamp({ event: 'status', status: 'error' })]);
    expect(burial.frames.find((f) => f.type === 'bg_task')).toMatchObject({ status: 'killed', rowId: burial.newRows[0].id });
  });

  it('the codex background reconcile names the row it wrote', async () => {
    const s = mkStream('codex');
    s.attached = true;
    s.nativeSessionId = 'thread-1';
    s.bgRunning = new Map([['agent-1', nowS()]]);
    s.codexBgChecks.set('agent-1', { revision: 1, since: 0 });
    codexObservations.list = [{ taskId: 'agent-1', status: 'completed', at: nowS() }];
    const frames: any[] = [];
    vi.spyOn(s, '_emitBroadcast').mockImplementation(((f: any) => { frames.push(f); }) as any);
    await s._reconcileCodexBgTasks();
    s.attached = false;
    s._clearCodexBgChecks();
    const [row] = allRows();
    expect(eventType(row)).toBe('bg_task');
    expect(frames.find((f) => f.type === 'bg_task')).toMatchObject({ kind: 'finished', rowId: row.id });
  });

  it('user input and async answers: user_echo names the user row', async () => {
    const s = mkStream();
    const frames: any[] = [];
    vi.spyOn(s, '_emitBroadcast').mockImplementation(((f: any) => { frames.push(f); }) as any);
    const { rowId } = await s.sendUserMessage('hello', undefined, { clientMessageId: 'abc' });
    expect(frames.find((f) => f.type === 'user_echo')).toEqual({
      type: 'user_echo', content: 'hello', createdAt: expect.any(Number), clientMessageId: 'abc', rowId,
    });
    s._onAgentEvent(stamp({ event: 'user_question', id: 'aq', questions: QUESTIONS, delivery: 'async' }));
    frames.length = 0;
    await s.respondQuestion('aq', { 'Which?': 'A' });
    const answerRow = allRows().filter((r: any) => r.role === 'user').at(-1);
    expect(frames.filter((f) => f.type === 'user_echo')).toEqual([expect.objectContaining({
      rowId: answerRow.id, clientMessageId: 'async-question:aq',
    })]);
    // The async resolution writes a non-rendered row: its frame carries none.
    expect(frames.find((f) => f.type === 'interaction_resolved')).not.toHaveProperty('rowId');
  });
});
