import { stripAnsi } from './byteText';

/** Task files may be plain stdout or native message JSONL. Never render the
 * native envelope (tool inputs, thinking, metadata) as assistant output. */
export function backgroundOutputText(raw: string): string {
  return stripAnsi(raw.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return line;
    let value: any;
    try { value = JSON.parse(trimmed); } catch {
      // An unfinished native record is not yet displayable.
      return /"(?:type|message)"\s*:/.test(trimmed) ? '' : line;
    }
    if (!value || typeof value !== 'object') return line;
    if (value.type === 'assistant' && value.message) {
      const content = value.message.content;
      if (typeof content === 'string') return content;
      return Array.isArray(content) ? content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n') : '';
    }
    if (value.type === 'result' && typeof value.result === 'string') return value.result;
    if (['user', 'system', 'progress', 'queue-operation', 'summary', 'file-history-snapshot'].includes(value.type)
      || value.message || value.type === 'assistant') return '';
    return line;
  }).filter(Boolean).join('\n'));
}

export function backgroundOutputPath(path: string, cwd: string | null): { root: string; path: string } | null {
  if (path.startsWith('/')) return { root: '/', path: path.slice(1) };
  return cwd?.startsWith('/') ? { root: cwd, path } : null;
}

/** Native readers return content blocks encoded as strings. Show assistant
 * prose and tool names, never the serialized envelope or hidden reasoning. */
export function subagentOutputText(messages: Array<{ role?: string; content?: string }>): string {
  return messages.filter((m) => m.role === 'assistant').flatMap((m) => {
    if (!m.content) return [];
    let blocks: unknown;
    try { blocks = JSON.parse(m.content); } catch { return [m.content]; }
    if (blocks == null) return [];
    if (!Array.isArray(blocks)) return [m.content];
    return blocks.flatMap((b) => {
      if (b?.type === 'text' && typeof b.text === 'string') return [b.text];
      if (b?.type === 'tool_use' && typeof b.name === 'string') return [`› ${b.name}`];
      return [];
    });
  }).join('\n\n');
}
