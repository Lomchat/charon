import { stripAnsi } from './byteText';

/** Task files may be plain stdout or native message JSONL. Never render the
 * native envelope (tool inputs, thinking, metadata) as assistant output. */
export function backgroundOutputText(raw: string): string {
  return stripAnsi(raw.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return prettyOutputJson(line);
    let value: any;
    try { value = JSON.parse(trimmed); } catch {
      // An unfinished native record is not yet displayable.
      return /"(?:type|message)"\s*:/.test(trimmed) ? '' : line;
    }
    if (!value || typeof value !== 'object') return line;
    if (value.type === 'assistant' && value.message) {
      const content = value.message.content;
      if (typeof content === 'string') return prettyOutputJson(content);
      return visibleSubagentBlocks(content).map(prettyOutputJson).join('\n\n');
    }
    if (value.type === 'result' && typeof value.result === 'string') return prettyOutputJson(value.result);
    if (['user', 'system', 'progress', 'queue-operation', 'summary', 'file-history-snapshot'].includes(value.type)
      || value.message || value.type === 'assistant') return '';
    return prettyOutputJson(line);
  }).filter(Boolean).join('\n'));
}

/** A shell command's output is the program's own bytes, never a transcript:
 * parsing it as one dropped every JSON log line with a `message` or `type`
 * key. Only ANSI goes, and a carriage return rewrites its line (progress bars)
 * the way a terminal does. */
export function commandOutputText(raw: string): string {
  return stripAnsi(raw).split('\n').map((line) => {
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    return body.slice(body.lastIndexOf('\r') + 1);
  }).join('\n');
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
    try { blocks = JSON.parse(m.content); } catch { return [prettyOutputJson(m.content)]; }
    if (blocks == null) return [];
    if (!Array.isArray(blocks) || !blocks.some(b => b && typeof b.type === 'string' && ['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(b.type))) return [prettyOutputJson(m.content)];
    return visibleSubagentBlocks(blocks).map(prettyOutputJson);
  }).join('\n\n');
}

/** StructuredOutput is the provider's public result, unlike arbitrary tool
 * arguments. Preserve complete text and JSON arrays (not just content blocks). */
export function visibleSubagentBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block?.type === 'text' && typeof block.text === 'string') return [block.text];
    if (block?.type === 'tool_use' && block.name === 'StructuredOutput' && block.input != null)
      return [JSON.stringify(block.input)];
    if (block?.type === 'tool_use' && typeof block.name === 'string') return [`› ${block.name}`];
    return [];
  });
}

/** Indent without parsing/re-serializing numbers: large integer IDs and numeric
 * spellings must survive presentation unchanged. Preserve field/array order. */
export function prettyOutputJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const input = fenced ? fenced[1].trim() : trimmed;
  if (!input.startsWith('{') && !input.startsWith('[')) return raw;
  try { JSON.parse(input); } catch { return raw; }
  let output = '', depth = 0, quoted = false, escaped = false;
  const indent = () => '\n' + '  '.repeat(depth);
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      output += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; output += c; }
    else if (/\s/.test(c)) continue;
    else if (c === '{' || c === '[') {
      output += c; depth++;
      if (!/^[\s]*[}\]]/.test(input.slice(i + 1))) output += indent();
    } else if (c === '}' || c === ']') {
      depth--;
      if (!/[{\[]$/.test(output)) output += indent();
      output += c;
    } else if (c === ',') output += ',' + indent();
    else if (c === ':') output += ': ';
    else output += c;
  }
  return output;
}
