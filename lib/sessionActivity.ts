// What a session is doing RIGHT NOW, for the desk (app/desk) — types and the
// tool vocabulary only. Browser-safe. The hub builds it from the frames it
// already publishes (lib/server/hub/sessionActivity.ts) and sends it LOW, as
// `{type:'session_activity', sessionId, activity}`: the transcript frames it
// summarises are focus-routed, so a page watching EVERY session would
// otherwise see none of them work.

/** The beat that produced a frame. `tool`/`think`/`say`/`compact` are also a
 *  state ("it is doing this now"); the others are one-shots. */
export type ActivityBeat =
  | 'tool' | 'think' | 'say' | 'compact'
  | 'prompt' | 'peer_in' | 'peer_reply' | 'bg' | 'stop';

export type SessionActivity = {
  beat: ActivityBeat;
  /** Epoch ms of the beat. */
  at: number;
  /** `tool`: the provider's tool name. */
  tool?: string;
  /** One line, ≤ ACTIVITY_DETAIL_MAX chars: the command, the file, the words. */
  detail?: string;
  /** `peer_in`/`peer_reply`: the other end. */
  peerSessionId?: string;
  peerHandle?: string;
  /** `stop`: the turn failed. */
  failed?: boolean;
  /** When the running turn started (hub clock); null = unknown or no turn. */
  turnStartedAt: number | null;
  /** Tool calls of the running turn so far. */
  turnTools: number;
};

export const ACTIVITY_DETAIL_MAX = 120;

/** Beats that describe a state the session stays in until the next beat. */
export function isStateBeat(beat: ActivityBeat): boolean {
  return beat === 'tool' || beat === 'think' || beat === 'say' || beat === 'compact';
}

/** What a tool call IS, whatever its provider calls it. */
export type ToolFamily = 'shell' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'plan' | 'peer' | 'other';

const FAMILY: Array<[ToolFamily, RegExp]> = [
  ['peer', /^mcp__charon_peer__|^send_message$|^(start|interrupt|kill)_sub_session$/i],
  ['agent', /^(agent|task|workflow|spawn_agent|taskcreate|taskoutput|taskstop)$/i],
  ['shell', /^(bash|shell|exec|exec_command|local_shell|run_terminal_cmd|bashoutput|killshell|monitor|command_execution)$/i],
  ['edit', /^(edit|write|multiedit|notebookedit|apply_patch|str_replace_editor|create_file|update_file|edit_file|file_change|delete_file)$/i],
  ['read', /^(read|view|view_image|read_file|notebookread)$/i],
  ['search', /^(grep|glob|ls|list_dir|codebase_search|file_search|grep_search|toolsearch|find)$/i],
  ['web', /^(websearch|webfetch|web_search|web_fetch|fetch|browser)/i],
  ['plan', /^(todowrite|update_plan|exitplanmode|enterplanmode|askuserquestion|skill)$/i],
];

export function toolFamily(name: string | null | undefined): ToolFamily {
  const n = String(name ?? '');
  for (const [family, re] of FAMILY) if (re.test(n)) return family;
  return n.startsWith('mcp__') ? 'web' : 'other';
}

/** The one line worth showing of a tool input (command, file, pattern…). */
export function toolDetail(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return oneLine(input);
  if (typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'notebook_path', 'skill', 'cmd']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return oneLine(v);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return oneLine(v.join(' '));
  }
  return '';
}

export function oneLine(text: string, max = ACTIVITY_DETAIL_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The END of a stream (what is being said now), cut at a word. */
export function tailLine(text: string, max = ACTIVITY_DETAIL_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(flat.length - max);
  const space = cut.indexOf(' ');
  return `…${space > 0 && space < 24 ? cut.slice(space + 1) : cut}`;
}
