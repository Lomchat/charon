// Reconstruction of a session state from messages persisted in the DB
// (used at mount, session switch, tab return).
//
// Used by the chat view (ClaudeSessionView via useClaudeSessionStream). It was
// once duplicated identically on the old separate mobile view (since folded
// into the responsive `/`, CLAUDE.md §11) with a "copied from
// ClaudePanel.rebuildStateFromMessages" comment; extracting it here killed
// that fork.

import type {
  Msg, ToolCallEntry, Todo, EditSnapshot,
} from './sessionTypes';
import type { WorkerStatus } from '@/lib/server/claude/types';
import {
  applyBgTaskEvent, bgTasksToArray, isBgLaunchToolUse, markRunningBgTasksStale,
  type BgTask, type BgLaunchCandidate,
} from './bgTasks';

// Shape of a message as it comes from the `GET /api/claude/sessions/[id]` API.
// Deliberately permissive (the `role` values in the DB are free-form strings).
export type PersistedMessage = {
  id: number;
  role: string;
  content: string;
  createdAt: number;
  // Assistant rows: API-confirmed model that produced the message (nullable).
  model?: string | null;
};

export type RebuiltSessionState = {
  messages: Msg[];
  status: WorkerStatus;
  toolCalls: ToolCallEntry[];
  todos: Todo[];
  edits: Map<string, EditSnapshot>;
  files: Set<string>;
  // Background tasks (Bash run_in_background / bg subagents) rebuilt from the
  // persisted bg_task 'event' rows — drives the BgTasks bar. cf. app/bgTasks.ts.
  bgTasks: BgTask[];
};

export function rebuildStateFromMessages(
  messages: PersistedMessage[],
  status: WorkerStatus,
): RebuiltSessionState {
  const out: RebuiltSessionState = {
    messages: [],
    status,
    toolCalls: [],
    todos: [],
    edits: new Map(),
    files: new Set(),
    bgTasks: [],
  };
  // Background-task registry, rebuilt from bg_task 'event' rows; the Bash
  // launch tool_use (run_in_background) contributes the command string.
  const bgMap = new Map<string, BgTask>();
  const bgLaunches = new Map<string, BgLaunchCandidate>();
  // SDK tool-use id (toolu_…) → index in out.toolCalls. Lets us re-pair the
  // persisted `tool_result` rows back onto their tool call so `result` is
  // restored — exactly what the live SSE path does. Without it every rebuilt
  // tool call stays "unresolved": the ThinkingBar then shows a stale tool from
  // a past turn whenever a new turn starts (it merely thinks, but the bar shows
  // the previous turn's last Read), and the ToolPanel loses all its results
  // after any refetch. See CLAUDE.md §14 gotcha 39.
  const toolIdxBySdkId = new Map<string, number>();
  for (const m of messages) {
    if (m.role === 'edit_snapshot') {
      try {
        const ev = JSON.parse(m.content);
        const key: string = ev.file_path;
        const cur = out.edits.get(key) ?? {
          toolUseId: ev.tool_use_id, filePath: key,
          before: null, after: null, truncated: !!ev.truncated,
        };
        if (ev.phase === 'before') {
          out.edits.set(key, { ...cur, before: ev.content, truncated: cur.truncated || !!ev.truncated });
        } else {
          out.edits.set(key, { ...cur, after: ev.content, truncated: cur.truncated || !!ev.truncated });
        }
        out.files.add(key);
      } catch {}
      continue;
    }
    if (m.role === 'event') {
      try {
        const ev = JSON.parse(m.content);
        if (ev.type === 'todo_update') out.todos = (ev.todos ?? []);
        if (ev.type === 'bg_task') applyBgTaskEvent(bgMap, ev, m.createdAt, bgLaunches);
        if (ev.type === 'thinking') {
          out.messages.push({
            id: 'm' + m.id, role: 'thinking',
            content: String(ev.text ?? ''), createdAt: m.createdAt,
          });
        }
      } catch {}
      continue;
    }
    if (m.role === 'thinking') {
      out.messages.push({
        id: 'm' + m.id, role: 'thinking',
        content: m.content, createdAt: m.createdAt,
      });
      continue;
    }
    if (m.role === 'tool_use') {
      let parsed: { id?: string; name?: string; input?: { file_path?: unknown } } | null = null;
      try { parsed = JSON.parse(m.content); } catch {}
      if (parsed) {
        const idx = out.toolCalls.push({
          id: 'h' + m.id,
          name: parsed.name ?? '',
          input: parsed.input,
          startedAt: m.createdAt,
        }) - 1;
        // Key the pairing map by the SDK tool id carried in the content (the
        // toolCall's own `id` is 'h'+rowid for React-key uniqueness, not the
        // SDK id, so it can't be used to match tool_result rows).
        if (typeof parsed.id === 'string') toolIdxBySdkId.set(parsed.id, idx);
        const fp = parsed.input?.file_path;
        if (fp) out.files.add(String(fp));
        // Background launch → keep the command for the bg_task 'started'
        // correlation (tool_use_id). cf. app/bgTasks.ts.
        if (typeof parsed.id === 'string' && isBgLaunchToolUse(parsed.name, parsed.input)) {
          const inp: any = parsed.input;
          bgLaunches.set(parsed.id, {
            command: typeof inp?.command === 'string' ? inp.command : null,
            description: typeof inp?.description === 'string' ? inp.description : null,
          });
        }
      }
      out.messages.push({
        id: 'm' + m.id, role: m.role,
        content: m.content, createdAt: m.createdAt,
      });
      continue;
    }
    if (m.role === 'tool_result') {
      // Re-pair the result onto its tool call (mirror of the live tool_result
      // handler in useClaudeSessionStream). Keeps `result` populated across a
      // full refetch so currentTool / ThinkingBar and the ToolPanel stay right.
      try {
        const parsed = JSON.parse(m.content);
        const idx = toolIdxBySdkId.get(parsed.tool_use_id);
        if (idx !== undefined && out.toolCalls[idx]) {
          out.toolCalls[idx] = {
            ...out.toolCalls[idx],
            result: { content: String(parsed.content ?? ''), isError: !!parsed.is_error },
          };
        }
      } catch {}
      out.messages.push({
        id: 'm' + m.id, role: m.role,
        content: m.content, createdAt: m.createdAt,
      });
      continue;
    }
    // user / assistant / system / others
    out.messages.push({
      id: 'm' + m.id, role: m.role,
      content: m.content, createdAt: m.createdAt,
      // Carry the per-message model stamp through (assistant rows; null
      // elsewhere) so the bubble header chip survives every refetch.
      model: m.model ?? null,
    });
  }
  // A non-running session cannot notify anymore: its CLI process (and the
  // background children) are gone — running tasks are stale, not running.
  if (status === 'sleeping' || status === 'error' || status === 'killed') {
    markRunningBgTasksStale(bgMap);
  }
  out.bgTasks = bgTasksToArray(bgMap);
  return out;
}
