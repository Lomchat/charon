/** Public transcript projection shared by the reader and activity UI.
 * Never expose thinking, provider envelopes or arbitrary tool arguments. */
export type AgentActivity = {
  id: string; kind: 'tool' | 'tool_result' | 'text' | 'result'; at: string | null;
  toolId?: string; name?: string; target?: string; detail?: string;
  file?: string; operation?: 'read' | 'write' | 'search'; error?: boolean;
  content?: string; model?: string;
};
export type AgentTranscriptInfo = { mission?: string; model?: string; phase?: string; startedAt?: string; missionTruncated?: boolean };

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap(b => b?.type === 'text' && typeof b.text === 'string' ? [b.text] : []).join('\n\n');
}
function field(input: any, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof input?.[key] === 'string') return input[key];
}
export function projectAgentRecord(record: any, offset: number): AgentActivity[] {
  if (!['assistant', 'user'].includes(record?.type)) return [];
  const at = typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : null;
  const model = typeof record.message?.model === 'string' ? record.message.model : undefined;
  const raw = record.message?.content;
  const blocks = typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? raw : [];
  return blocks.flatMap((b: any, i: number): AgentActivity[] => {
    const id = `${offset}:${i}`;
    if (b?.type === 'tool_result' && record.type === 'user' && typeof b.tool_use_id === 'string') {
      return [{ id, kind: 'tool_result', at, toolId: b.tool_use_id, error: b.is_error === true, content: textContent(b.content) }];
    }
    if (record.type !== 'assistant') return [];
    if (b?.type === 'text' && typeof b.text === 'string') return [{ id, kind: 'text', at, content: b.text, model }];
    if (b?.type !== 'tool_use' || typeof b.name !== 'string') return [];
    if (b.name === 'StructuredOutput') return b.input == null ? [] : [{ id, kind: 'result', at, content: JSON.stringify(b.input), model }];
    const input = b.input;
    const file = field(input, 'file_path', 'path', 'notebook_path');
    let target: string | undefined, detail: string | undefined, operation: AgentActivity['operation'];
    if (b.name === 'Bash' || b.name === 'Monitor') {
      target = field(input, 'description') || field(input, 'command'); detail = field(input, 'command');
    } else if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(b.name)) {
      target = file;
      operation = b.name === 'Read' ? 'read' : 'write';
      if (b.name === 'Read') detail = JSON.stringify({ file, offset: input?.offset, limit: input?.limit }, null, 2);
      else if (b.name === 'Edit') detail = JSON.stringify({ file, old_string: input?.old_string, new_string: input?.new_string, replace_all: input?.replace_all }, null, 2);
      else if (b.name === 'Write') detail = field(input, 'content');
    } else if (['Grep', 'Glob'].includes(b.name)) {
      target = field(input, 'pattern'); operation = 'search';
      detail = JSON.stringify({ pattern: target, path: file, glob: input?.glob }, null, 2);
    } else if (['WebFetch', 'WebSearch'].includes(b.name)) {
      target = field(input, 'url', 'query'); detail = target;
    } else if (['TaskStop', 'TaskOutput'].includes(b.name)) {
      target = field(input, 'task_id', 'shell_id'); detail = target;
    } else if (b.name === 'ToolSearch') {
      target = field(input, 'query'); detail = target;
    } else if (b.name === 'TodoWrite' && Array.isArray(input?.todos)) {
      target = input.todos.map((t: any) => typeof t?.content === 'string' ? t.content : '').filter(Boolean).join(' · ');
      detail = JSON.stringify(input.todos.map((t: any) => ({ content: t.content, status: t.status })), null, 2);
    } else if (['Agent', 'Task'].includes(b.name)) {
      target = field(input, 'description');
    } else {
      // A small public argument vocabulary also covers provider/plugin tools.
      // Never serialize opaque inputs (headers, credentials, env, prompts…).
      const safe: Record<string, unknown> = {};
      for (const key of ['description', 'command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'task_id', 'target'])
        if (typeof input?.[key] === 'string') safe[key] = input[key];
      target = field(input, 'description', 'command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'task_id', 'target');
      if (Object.keys(safe).length) detail = JSON.stringify(safe, null, 2);
    }
    return [{ id, kind: 'tool', at, name: b.name, toolId: typeof b.id === 'string' ? b.id : id, target, detail, file, operation, model }];
  });
}

export type AgentToolActivity = AgentActivity & { result?: AgentActivity };
export function summarizeAgentActivity(entries: AgentActivity[]) {
  const results = new Map(entries.filter(e => e.kind === 'tool_result').map(e => [e.toolId, e]));
  const calls: AgentToolActivity[] = entries.filter(e => e.kind === 'tool').map(e => ({ ...e, result: results.get(e.toolId) }));
  const ids = new Set(calls.map(c => c.toolId));
  const orphanResults = entries.filter(e => e.kind === 'tool_result' && !ids.has(e.toolId));
  const files = new Map<string, { path: string; read: boolean; written: boolean; pending: boolean }>();
  for (const call of calls) {
    if (!call.file || !call.operation || call.operation === 'search') continue;
    const f = files.get(call.file) || { path: call.file, read: false, written: false, pending: false };
    if (call.result && !call.result.error) {
      if (call.operation === 'read') f.read = true;
      if (call.operation === 'write') f.written = true;
    } else if (!call.result) f.pending = true;
    files.set(f.path, f);
  }
  const last = entries.reduce<string | null>((value, e) => e.at && (!value || Date.parse(e.at) > Date.parse(value)) ? e.at : value, null);
  return { calls, orphanResults, files: [...files.values()], errors: calls.filter(c => c.result?.error).length + orphanResults.filter(r => r.error).length,
    last, model: [...entries].reverse().find(e => e.model)?.model,
    output: entries.filter(e => e.kind === 'text' || e.kind === 'result') };
}
