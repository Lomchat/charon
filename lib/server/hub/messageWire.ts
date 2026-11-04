import 'server-only';

const TOOL_RESULT_HEAD = 12 * 1024;
const TOOL_RESULT_TAIL = 4 * 1024;

type SnapshotMeta = {
  wireContent: string | null;
  snapshotFilePath: string | null;
  snapshotPhase: string | null;
  snapshotToolUseId: string | null;
  snapshotTruncated: number | null;
};

function previewString(value: string): { value: string; truncated: boolean; bytes: number } {
  if (value.length <= TOOL_RESULT_HEAD + TOOL_RESULT_TAIL) {
    return { value, truncated: false, bytes: value.length };
  }
  const omitted = value.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  return {
    value: `${value.slice(0, TOOL_RESULT_HEAD)}\n\n… ${omitted.toLocaleString('en-US')} characters omitted from live history …\n\n${value.slice(-TOOL_RESULT_TAIL)}`,
    truncated: true,
    bytes: value.length,
  };
}

/** Compact one tool result for SSE/history while preserving its full DB row. */
export function compactToolResultForWire(content: string): {
  content: string;
  contentTruncated?: true;
  contentBytes?: number;
} {
  const preview = previewString(content);
  return preview.truncated
    ? { content: preview.value, contentTruncated: true, contentBytes: preview.bytes }
    : { content };
}

export function compactToolInputForWire(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  let changed = false;
  const next: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value !== 'string') continue;
    const compact = previewString(value);
    if (!compact.truncated) continue;
    next[key] = compact.value;
    next[`${key}_truncated`] = true;
    next[`${key}_bytes`] = compact.bytes;
    changed = true;
  }
  return changed ? next : input;
}

/** Derive write-time compact/normalized fields from the lossless payload. */
export function deriveMessageStorage(role: string, rawContent: string): SnapshotMeta {
  const empty: SnapshotMeta = {
    wireContent: null,
    snapshotFilePath: null,
    snapshotPhase: null,
    snapshotToolUseId: null,
    snapshotTruncated: null,
  };
  if (role !== 'edit_snapshot' && role !== 'tool_result' && role !== 'tool_use') return empty;

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(rawContent) as Record<string, unknown>; }
  catch { return empty; }

  if (role === 'tool_use') {
    const compactInput = compactToolInputForWire(parsed.input);
    if (compactInput === parsed.input) return empty;
    return { ...empty, wireContent: JSON.stringify({ ...parsed, input: compactInput }) };
  }

  if (role === 'tool_result') {
    if (typeof parsed.content !== 'string') return empty;
    const compact = compactToolResultForWire(parsed.content);
    if (!compact.contentTruncated) return empty;
    return {
      ...empty,
      wireContent: JSON.stringify({
        ...parsed,
        content: compact.content,
        content_truncated: true,
        content_bytes: compact.contentBytes,
      }),
    };
  }

  return {
    wireContent: JSON.stringify({
      ...parsed,
      content: null,
      diff: null,
      contentStripped: true,
    }),
    snapshotFilePath: typeof parsed.file_path === 'string' ? parsed.file_path : null,
    snapshotPhase: typeof parsed.phase === 'string' ? parsed.phase : null,
    snapshotToolUseId: typeof parsed.tool_use_id === 'string' ? parsed.tool_use_id : null,
    snapshotTruncated: parsed.truncated ? 1 : 0,
  };
}
