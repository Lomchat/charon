// Frame classification (C11): every bus frame type has a route and a summary
// flag — tsc-exhaustive over `KnownFrameType`, and checked here at runtime
// against the type unions and the publishers' literal frame types.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FRAME_CLASS, SUMMARY_TRIGGERS, frameReaches, routeOf, type KnownFrameType,
} from '@/lib/server/sync/frameRouting';

// Compile-time: the list below names EVERY KnownFrameType (a missing one makes
// `_Missing` non-never and the assignment fails tsc); the runtime check then
// pins FRAME_CLASS to exactly this list (no stray key).
const ALL_TYPES = [
  'ready', 'session_id', 'assistant_text', 'structured_output', 'thinking', 'generation_progress',
  'tool_use', 'tool_result', 'tool_progress', 'edit_progress', 'plan_progress', 'plan_update',
  'tool_activity', 'permission_request', 'user_question', 'exit_plan_request', 'interaction_resolved',
  'prefill_input', 'reconnecting', 'edit_snapshot', 'mode_changed', 'model_changed', 'effort_changed',
  'effective_model', 'bg_task', 'bg_task_progress', 'usage', 'session_token_usage', 'stop',
  'compaction', 'scheduled_fire', 'session_info', 'rate_limit', 'external_message', 'peer_message_status',
  'turn_error', 'error',
  'status', 'user_echo', 'blocking_error', 'scheduled_resume', 'thinking_flushed',
  'thinking_reopened', 'history_begin', 'history_end', 'shell_status', 'vps_status',
  'session_unread', 'session_bg_tasks', 'bg_tasks_snapshot', 'session_list_changed',
  'tabs_changed', 'settings_changed', 'account_profiles_changed', 'account_usage',
  'file_activity', 'model_notices', 'install_started', 'install_finished', 'session_summary',
  'pending_snapshot', 'transcript_reset', 'session_resync', 'assistant_flushed', 'assistant_reopened',
  'question_delivery', 'shell_unread',
] as const satisfies readonly KnownFrameType[];
type _Missing = Exclude<KnownFrameType, (typeof ALL_TYPES)[number]>;
const _exhaustive: [_Missing] extends [never] ? true : _Missing = true;
void _exhaustive;

// The pre-refonte `eventConnections.ts § LOW_VOLUME_EVENTS`, moved verbatim.
const LEGACY_LOW = [
  'status', 'mode_changed', 'ready', 'session_id', 'permission_request', 'user_question',
  'exit_plan_request', 'interaction_resolved', 'error', 'model_changed', 'effort_changed',
  'effective_model', 'shell_status', 'vps_status', 'session_unread', 'session_bg_tasks',
  'bg_tasks_snapshot', 'session_list_changed', 'tabs_changed', 'settings_changed', 'account_usage',
  'account_profiles_changed', 'file_activity', 'session_info', 'turn_error', 'rate_limit',
];
const NEW_LOW = ['session_summary', 'pending_snapshot', 'model_notices', 'install_started', 'install_finished', 'shell_unread'];
// C17: legacy LOW frames no browser consumes — bus subscribers only.
const INTERNAL = ['ready', 'session_info', 'rate_limit'];

const ROOT = path.resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('FRAME_CLASS', () => {
  it('classifies exactly the known frame types', () => {
    expect(Object.keys(FRAME_CLASS).sort()).toEqual([...ALL_TYPES].sort());
  });

  it('covers every member of the BridgeEvent/SyntheticEvent unions (source scan)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/server/hub/types.ts'), 'utf8');
    const unions = [
      src.slice(src.indexOf('export type BridgeEvent ='), src.indexOf('export type EffortLevel')),
      src.slice(src.indexOf('export type SyntheticEvent ='), src.indexOf('export type WorkerEvent')),
    ];
    const found = new Set<string>();
    for (const u of unions) for (const m of u.matchAll(/\btype: '([a-z_]+)'/g)) found.add(m[1]);
    expect(found.size).toBeGreaterThan(40);
    const missing = [...found].filter((t) => !(t in FRAME_CLASS));
    expect(missing).toEqual([]);
  });

  it('covers every literal frame type a hub publisher emits (source scan)', () => {
    const files = [...walk(path.join(ROOT, 'lib/server')), ...walk(path.join(ROOT, 'app/api'))];
    const re = /(?:emitGlobalSession|_broadcast|_emitBroadcast|publish|emitInstallBusEvent)\(\{\s*type: '([a-z_]+)'/g;
    const found = new Set<string>();
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) found.add(m[1]);
    }
    for (const t of ['status', 'install_started', 'install_finished', 'model_notices', 'file_activity']) {
      expect(found.has(t)).toBe(true);
    }
    expect([...found].filter((t) => !(t in FRAME_CLASS))).toEqual([]);
  });

  it('LOW = the legacy low-volume set + the refonte additions − the unconsumed frames (internal)', () => {
    const low = Object.entries(FRAME_CLASS).filter(([, c]) => c.route === 'low').map(([t]) => t);
    expect(low.sort()).toEqual([...LEGACY_LOW, ...NEW_LOW].filter((t) => !INTERNAL.includes(t)).sort());
    const internal = Object.entries(FRAME_CLASS).filter(([, c]) => c.route === 'internal').map(([t]) => t);
    expect(internal.sort()).toEqual([...INTERNAL].sort());
    for (const t of INTERNAL) expect(SUMMARY_TRIGGERS.has(t)).toBe(false);
    expect(routeOf('transcript_reset')).toBe('focused');
    expect(routeOf('assistant_flushed')).toBe('focused');
  });

  it('summary triggers are exactly the cross-session facts', () => {
    expect([...SUMMARY_TRIGGERS].sort()).toEqual([
      'status', 'session_unread', 'session_bg_tasks', 'permission_request', 'user_question',
      'exit_plan_request', 'interaction_resolved', 'stop', 'session_list_changed', 'session_id',
      'mode_changed', 'model_changed', 'effort_changed', 'vps_status',
    ].sort());
    // A summary frame never re-triggers itself.
    expect(SUMMARY_TRIGGERS.has('session_summary')).toBe(false);
  });

  it('an unknown type is focus-filtered (today\'s default)', () => {
    expect(routeOf('something_new')).toBe('focused');
    expect(routeOf('heartbeat')).toBe('focused');
  });

  it('frameReaches: low → every conn, focused → its session only, internal → none', () => {
    expect(frameReaches({ route: 'low', sessionId: 'A' }, null)).toBe(true);
    expect(frameReaches({ route: 'low', sessionId: null }, 'B')).toBe(true);
    expect(frameReaches({ route: 'focused', sessionId: 'A' }, 'A')).toBe(true);
    expect(frameReaches({ route: 'focused', sessionId: 'A' }, 'B')).toBe(false);
    expect(frameReaches({ route: 'focused', sessionId: 'A' }, null)).toBe(false);
    expect(frameReaches({ route: 'focused', sessionId: null }, null)).toBe(false);
    expect(frameReaches({ route: 'internal', sessionId: 'A' }, 'A')).toBe(false);
  });
});
