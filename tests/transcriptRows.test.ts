import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_EVENT_TYPES, FRAME_SNAPSHOT_CLASS, RENDERED_EVENT_TYPES, RENDER_NULL_ROLES, STATE_EVENT_TYPES,
  TECHNICAL_ROLES, isConversationSlotRole, isRenderedRow, isTechnicalFrame,
} from '@/lib/transcriptRows';
import { FRAME_CLASS } from '@/lib/server/sync/frameRouting';

// The shared row/frame classification (sync refonte C12, I6/I14/I15): every
// branch of the client rebuild is classified, every bus frame type has a
// snapshot class.

const rebuildSrc = readFileSync(path.resolve(__dirname, '../app/sessionRebuild.ts'), 'utf8');
const literals = (re: RegExp) => [...new Set([...rebuildSrc.matchAll(re)].map((m) => m[1]))].sort();

describe('every sessionRebuild.ts branch is classified', () => {
  const eventTypes = literals(/ev\.type === '([a-z_]+)'/g);
  const roles = literals(/m\.role === '([a-z_]+)'/g);

  it('event row types: rendered or state, and every rendered type has a branch', () => {
    expect(eventTypes.length).toBeGreaterThan(5);
    const known = new Set<string>([...RENDERED_EVENT_TYPES, ...STATE_EVENT_TYPES]);
    expect(eventTypes.filter((t) => !known.has(t))).toEqual([]);
    for (const t of RENDERED_EVENT_TYPES) expect(eventTypes, t).toContain(t);
    for (const t of eventTypes) {
      expect(isRenderedRow('event', t, 'full'), t).toBe((RENDERED_EVENT_TYPES as readonly string[]).includes(t));
    }
  });

  it('roles with a branch: classified for both views', () => {
    expect(roles).toEqual(expect.arrayContaining(['async_question', 'edit_snapshot', 'event', 'thinking', 'tool_use', 'tool_result']));
    for (const role of roles) {
      if (role === 'event') continue;
      const technical = (TECHNICAL_ROLES as readonly string[]).includes(role);
      expect(isRenderedRow(role, null, 'full'), role).toBe(role !== 'edit_snapshot');
      expect(isRenderedRow(role, null, 'conversation'), role).toBe(role !== 'edit_snapshot' && !technical);
    }
  });
});

describe('isRenderedRow / slots', () => {
  it('render-null and side channels never render; plain roles always do', () => {
    for (const r of RENDER_NULL_ROLES) {
      expect(isRenderedRow(r, null, 'full')).toBe(false);
      expect(isRenderedRow(r, null, 'conversation')).toBe(false);
      expect(isConversationSlotRole(r)).toBe(false);
    }
    for (const r of ['user', 'assistant', 'system', 'error', 'scheduled_resume', 'async_question']) {
      expect(isRenderedRow(r, null, 'full')).toBe(true);
      expect(isRenderedRow(r, null, 'conversation')).toBe(true);
      expect(isConversationSlotRole(r)).toBe(true);
    }
    expect(isRenderedRow('event', null, 'full')).toBe(false);
    expect(isRenderedRow('event', 'turn_usage', 'full')).toBe(false);
    expect(isRenderedRow('event', 'bg_task', 'conversation')).toBe(false);
  });

  it('the conversation view renders only conversation event types (a subset of the rendered ones)', () => {
    for (const t of RENDERED_EVENT_TYPES) {
      expect(isRenderedRow('event', t, 'conversation'), t)
        .toBe((CONVERSATION_EVENT_TYPES as readonly string[]).includes(t));
    }
    expect(isRenderedRow('event', 'thinking', 'conversation')).toBe(false);
    expect(isRenderedRow('event', 'plan_update', 'conversation')).toBe(false);
    for (const r of TECHNICAL_ROLES) {
      expect(isRenderedRow(r, null, 'conversation')).toBe(false);
      expect(isConversationSlotRole(r)).toBe(false);
    }
  });
});

describe('FRAME_SNAPSHOT_CLASS', () => {
  it('covers exactly the routed frame types (runtime list check of the tsc-exhaustive Record)', () => {
    expect(Object.keys(FRAME_SNAPSHOT_CLASS).sort()).toEqual(Object.keys(FRAME_CLASS).sort());
  });

  it('covered = what the window GET mirrors (I6)', () => {
    const covered = Object.entries(FRAME_SNAPSHOT_CLASS).filter(([, c]) => c === 'covered').map(([t]) => t).sort();
    expect(covered).toEqual(['assistant_reopened', 'assistant_text', 'live_activity', 'thinking', 'thinking_reopened', 'tool_progress']);
  });

  it('frames persisting a rendered row (I15 rowId carriers) are durable; latest-value frames are live', () => {
    for (const t of ['user_echo', 'assistant_flushed', 'tool_use', 'tool_result', 'thinking_flushed', 'compaction',
      'structured_output', 'external_message', 'peer_message_status', 'plan_update', 'bg_task', 'edit_snapshot',
      'user_question', 'exit_plan_request', 'blocking_error', 'scheduled_resume'] as const) {
      expect(FRAME_SNAPSHOT_CLASS[t], t).toBe('durable');
    }
    for (const t of ['plan_progress', 'edit_progress', 'bg_task_progress', 'usage', 'generation_progress',
      'rate_limit', 'tool_activity', 'session_token_usage'] as const) {
      expect(FRAME_SNAPSHOT_CLASS[t], t).toBe('live');
    }
    expect(FRAME_SNAPSHOT_CLASS.session_summary).toBe('summary');
  });

  it('isTechnicalFrame', () => {
    for (const t of ['tool_use', 'tool_result', 'thinking', 'plan_progress', 'plan_update', 'tool_progress', 'thinking_flushed']) {
      expect(isTechnicalFrame(t), t).toBe(true);
    }
    for (const t of ['assistant_text', 'user_echo', 'compaction', 'bg_task', 'status']) {
      expect(isTechnicalFrame(t), t).toBe(false);
    }
  });
});
