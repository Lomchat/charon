// Reconstruction of a session state from messages persisted in the DB
// (used at mount, session switch, tab return).
//
// Shared between `app/ClaudePanel.tsx` and `app/m/chat/MobileChat.tsx` — before
// this file, the same function was duplicated identically with a comment
// "copied from ClaudePanel.rebuildStateFromMessages" on the mobile side.

import type {
  Msg, ToolCallEntry, Todo, EditSnapshot,
} from './sessionTypes';
import type { WorkerStatus } from '@/lib/server/claude/types';

// Shape of a message as it comes from the `GET /api/claude/sessions/[id]` API.
// Deliberately permissive (the `role` values in the DB are free-form strings).
export type PersistedMessage = {
  id: number;
  role: string;
  content: string;
  createdAt: number;
};

export type RebuiltSessionState = {
  messages: Msg[];
  status: WorkerStatus;
  toolCalls: ToolCallEntry[];
  todos: Todo[];
  edits: Map<string, EditSnapshot>;
  files: Set<string>;
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
  };
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
      let parsed: { name?: string; input?: { file_path?: unknown } } | null = null;
      try { parsed = JSON.parse(m.content); } catch {}
      if (parsed) {
        out.toolCalls.push({
          id: 'h' + m.id,
          name: parsed.name ?? '',
          input: parsed.input,
          startedAt: m.createdAt,
        });
        const fp = parsed.input?.file_path;
        if (fp) out.files.add(String(fp));
      }
      out.messages.push({
        id: 'm' + m.id, role: m.role,
        content: m.content, createdAt: m.createdAt,
      });
      continue;
    }
    // tool_result / user / assistant / system / others
    out.messages.push({
      id: 'm' + m.id, role: m.role,
      content: m.content, createdAt: m.createdAt,
    });
  }
  return out;
}
