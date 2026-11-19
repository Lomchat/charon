// What a session is doing RIGHT NOW, for the thinking bar (CLAUDE.md §14.124).
// The hub folds the frames a stream publishes into ONE `LiveActivity`
// (`foldLiveFrame`, lib/server/agent/sessionOps.ts § _noteLive) and sends it
// FOCUSED as `live_activity`; the window GET's `liveActivity` mirrors it. The
// browser only labels it (`describeLive`), tools shown or hidden.
// Browser-safe and pure.

/** `wait`: a request is out, nothing streamed yet. `think`/`say`: reasoning /
 *  message text being generated. `prep`: a tool call being written (Claude:
 *  a big Write can take minutes). `tool`: a call running. `retry`: the
 *  provider retries a failed request. */
export type LiveBeat = 'wait' | 'think' | 'say' | 'prep' | 'tool' | 'retry';

export type LiveTool = {
  /** The call's id; null while the model is still writing it (`prep`). */
  id: string | null;
  name: string;
  /** One line: the command, the file, the pattern… ('' = not known yet). */
  detail: string;
  /** Epoch ms the call started running (`prep`: started being written). */
  since: number;
  /** A sub-agent call: the last tool its agent used. */
  sub?: string;
  /** The latest output line of a command (providers that stream it). */
  tail?: string;
};

export type LiveActivity = {
  beat: LiveBeat;
  /** Epoch ms this beat began. */
  since: number;
  tool?: LiveTool;
  /** Calls of the turn still running, `tool` included (omitted when 0). */
  running?: number;
  /** think/say/prep: characters of the block so far (Claude). */
  chars?: number;
  /** think: the end of the reasoning being streamed. retry: the provider's words. */
  tail?: string;
};

export const LIVE_DETAIL_MAX = 160;
const TAIL_MAX = 140;
const BUFFER_KEEP = 600;

// ── The fold (hub) ──────────────────────────────────────────────────────────

export type LiveFold = {
  current: LiveActivity | null;
  /** Calls started and not answered yet, in start order. */
  running: Map<string, LiveTool>;
  /** Output kept per running call (its last line is `tail`). */
  outputs: Map<string, string>;
  /** Background task id → the tool call that launched it (sub-agents). */
  taskTools: Map<string, string>;
  /** Index of the generation block `current` describes (null: none). */
  block: number | null;
  /** A delta provider's reasoning, kept for its tail. */
  thought: string;
};

/** `beat`: send now. `progress`: only counters/tails moved (rate-capped). */
export type LiveChange = 'beat' | 'progress' | null;

export type LiveFoldOptions = {
  /** The stream's status is `thinking` (anything else: nothing is happening). */
  thinking: boolean;
  /** The provider streams its text and reasoning as deltas (Codex, Cursor);
   *  Claude's phases come from `generation_progress.block` instead. */
  streamsText: boolean;
};

export function createLiveFold(): LiveFold {
  return { current: null, running: new Map(), outputs: new Map(), taskTools: new Map(), block: null, thought: '' };
}

function resetLive(f: LiveFold): void {
  f.current = null;
  f.running.clear();
  f.outputs.clear();
  f.taskTools.clear();
  f.block = null;
  f.thought = '';
}

/** Internal provider calls, never shown (or counted) as tools. */
const HIDDEN_TOOLS = new Set(['codex_hook', 'auto_review']);

type Frame = { type: string; [key: string]: unknown };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Fold ONE live (never replayed) frame of a session into `f`. */
export function foldLiveFrame(f: LiveFold, ev: Frame, now: number, opts: LiveFoldOptions): LiveChange {
  const prev = f.current;
  if (!opts.thinking || ev.type === 'stop') {
    resetLive(f);
    return prev ? 'beat' : null;
  }
  // A turn is on: something is happening from its first frame.
  f.current ??= { beat: 'wait', since: now };
  switch (ev.type) {
    case 'generation_progress': {
      // Agents < 0.136.0 send no `block`: nothing to say about the phase.
      if (!('block' in ev)) break;
      const index = typeof ev.index === 'number' ? ev.index : null;
      const chars = num(ev.blockChars);
      if (ev.block === 'thinking') setBeat(f, 'think', index, now, { chars, tail: tailLine(str(ev.tail)) || undefined });
      else if (ev.block === 'text') setBeat(f, 'say', index, now, { chars });
      else if (ev.block === 'tool_use') {
        setBeat(f, 'prep', index, now, {
          chars, tool: { id: null, name: str(ev.tool), detail: oneLine(str(ev.detail)), since: now },
        });
      } else {
        // A new model request: waiting for its first token.
        f.block = null;
        settle(f, now);
      }
      break;
    }
    case 'tool_use': {
      const id = str(ev.id);
      const name = str(ev.name);
      if (!id || HIDDEN_TOOLS.has(name)) break;
      const tool: LiveTool = { id, name, detail: toolDetail(name, ev.input), since: now };
      f.running.set(id, tool);
      f.block = null;
      f.thought = '';
      f.current = { beat: 'tool', since: now, tool, running: f.running.size };
      break;
    }
    case 'tool_result': {
      const id = str(ev.tool_use_id);
      if (!f.running.delete(id)) break;
      f.outputs.delete(id);
      if (f.current.beat === 'tool' && f.current.tool?.id === id) settle(f, now, true);
      else f.current = withRunning(f, f.current);
      break;
    }
    case 'tool_progress': {
      const id = str(ev.tool_use_id);
      const t = f.running.get(id);
      if (!t) break;
      const out = `${f.outputs.get(id) ?? ''}${str(ev.delta)}`.slice(-BUFFER_KEEP);
      f.outputs.set(id, out);
      const tail = lastLine(out);
      if (!tail || tail === t.tail) break;
      updateTool(f, { ...t, tail });
      break;
    }
    case 'bg_task': {
      const taskId = str(ev.taskId);
      if (ev.kind === 'started' && taskId && str(ev.toolUseId)) f.taskTools.set(taskId, str(ev.toolUseId));
      else if (ev.kind === 'finished') f.taskTools.delete(taskId);
      break;
    }
    case 'bg_task_progress': {
      const toolId = f.taskTools.get(str(ev.taskId));
      const t = toolId ? f.running.get(toolId) : undefined;
      const sub = oneLine(str(ev.lastToolName), 60);
      if (t && sub && sub !== t.sub) updateTool(f, { ...t, sub });
      break;
    }
    case 'assistant_text':
      if (opts.streamsText && str(ev.delta)) setBeat(f, 'say', null, now, {});
      break;
    case 'thinking': {
      const text = str(ev.text);
      if (!opts.streamsText || !text) break;
      if (f.current.beat !== 'think') f.thought = '';
      f.thought = `${f.thought}${text}`.slice(-BUFFER_KEEP);
      setBeat(f, 'think', null, now, { tail: tailLine(f.thought) || undefined });
      break;
    }
    case 'error':
      if (ev.retrying === true) {
        const tail = oneLine(str(ev.msg), TAIL_MAX);
        f.current = withRunning(f, {
          beat: 'retry', since: f.current.beat === 'retry' ? f.current.since : now, ...(tail ? { tail } : {}),
        });
      }
      break;
    case 'compaction':
      f.block = null;
      settle(f, now);
      break;
    default:
      break;
  }
  return changeOf(prev, f.current);
}

function withRunning(f: LiveFold, a: LiveActivity): LiveActivity {
  const { running: _old, ...rest } = a;
  return f.running.size ? { ...rest, running: f.running.size } : rest;
}

/** Enter `beat` (block `index`); `since` holds while it is the same block. */
function setBeat(f: LiveFold, beat: LiveBeat, index: number | null, now: number,
  extra: { chars?: number; tail?: string; tool?: LiveTool }): void {
  const cur = f.current!;
  const same = cur.beat === beat && f.block === index && (beat !== 'prep' || cur.tool?.name === extra.tool?.name);
  f.block = index;
  const next: LiveActivity = { beat, since: same ? cur.since : now };
  if (extra.tool) {
    next.tool = { ...extra.tool, since: same && cur.tool ? cur.tool.since : now };
    // The detail is found once, mid-stream: later progress keeps it.
    if (!next.tool.detail && same && cur.tool?.detail) next.tool.detail = cur.tool.detail;
  }
  if (extra.chars !== undefined) next.chars = extra.chars;
  if (extra.tail) next.tail = extra.tail;
  f.current = withRunning(f, next);
}

/** Nothing being generated: a running call if any (the latest), else a wait
 *  (since now, unless already waiting — or `fresh`: the call just ended). */
function settle(f: LiveFold, now: number, fresh = false): void {
  const latest = [...f.running.values()].pop();
  if (latest) {
    f.current = { beat: 'tool', since: latest.since, tool: latest, running: f.running.size };
    return;
  }
  const since = !fresh && f.current?.beat === 'wait' ? f.current.since : now;
  f.current = { beat: 'wait', since };
}

function updateTool(f: LiveFold, t: LiveTool): void {
  f.running.set(t.id!, t);
  if (f.current?.tool?.id === t.id) f.current = { ...f.current, tool: t };
}

function changeOf(a: LiveActivity | null, b: LiveActivity | null): LiveChange {
  if (a === b) return null;
  if (!a || !b) return 'beat';
  if (a.beat !== b.beat || a.since !== b.since || a.running !== b.running
    || a.tool?.id !== b.tool?.id || a.tool?.name !== b.tool?.name || a.tool?.detail !== b.tool?.detail) return 'beat';
  if (a.chars !== b.chars || a.tail !== b.tail || a.tool?.tail !== b.tool?.tail || a.tool?.sub !== b.tool?.sub) return 'progress';
  return null;
}

// ── Tool vocabulary ─────────────────────────────────────────────────────────

/** The one line worth showing of a tool call's input. */
export function toolDetail(name: string, input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return oneLine(input);
  if (typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  if (name === 'apply_patch') {
    const patch = str(o.input) || str(o.patch);
    const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete|Move) File:\s*(.+?)\s*$/gm)].map((m) => m[1]);
    return oneLine(files.slice(0, 3).join(', '));
  }
  if (/send_message$/.test(name) && str(o.to)) return oneLine(`@${str(o.to).replace(/^@/, '')}`);
  if (/^grep$/i.test(name) && str(o.pattern)) return oneLine(`"${str(o.pattern)}"${str(o.path) ? ` in ${str(o.path)}` : ''}`);
  for (const key of ['command', 'cmd', 'file_path', 'notebook_path', 'target_file', 'path', 'pattern', 'query',
    'search_term', 'url', 'relative_workspace_path', 'description', 'skill', 'prompt']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return oneLine(v);
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return oneLine(shellArgv(v as string[]));
  }
  return '';
}

/** `["bash","-lc","npm test"]` → `npm test`. */
function shellArgv(argv: string[]): string {
  if (argv.length === 3 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1])) return argv[2];
  return argv.join(' ');
}

export type ToolFamily = 'shell' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'plan' | 'peer' | 'mcp' | 'other';

const FAMILY: Array<[ToolFamily, RegExp]> = [
  ['peer', /^mcp__charon_peer__|^(send_message|(start|interrupt|kill)_sub_session)$/i],
  ['agent', /^(agent|task|workflow|spawn_agent)$|^agents\//i],
  ['shell', /^(bash|shell|local_shell|exec|exec_command|run_terminal_cmd|bashoutput|monitor|command_execution|powershell)$/i],
  ['edit', /^(edit|write|multiedit|notebookedit|apply_patch|str_replace_editor|create_file|edit_file|delete_file|search_replace)$/i],
  ['read', /^(read|view|view_image|read_file|notebookread|taskoutput)$/i],
  ['search', /^(grep|glob|ls|list_dir|codebase_search|file_search|grep_search|toolsearch|find)$/i],
  ['web', /^(websearch|webfetch|web_search|web_fetch|fetch|browser)$/i],
  ['plan', /^(todowrite|update_plan|exitplanmode|enterplanmode|skill)$/i],
];

export function toolFamily(name: string): ToolFamily {
  for (const [family, re] of FAMILY) if (re.test(name)) return family;
  return /^mcp__|\//.test(name) ? 'mcp' : 'other';
}

const VERB: Record<ToolFamily, string> = {
  shell: 'Running', edit: 'Editing', read: 'Reading', search: 'Searching', web: 'Browsing',
  agent: 'Sub-agent', plan: 'Planning', peer: 'Messaging', mcp: 'Calling', other: 'Using',
};

/** `mcp__claude_ai_Docs__batch` → `claude_ai_Docs › batch`. */
export function toolShortName(name: string): string {
  return name.replace(/^mcp__/, '').replace(/__/g, ' › ');
}

// ── Labels (browser) ────────────────────────────────────────────────────────

export type LiveLine = {
  /** What it does: `Running`, `Thinking`, `Waiting for Claude`… */
  label: string;
  /** On what (mono): the command, the file… */
  detail: string;
  /** Muted aside: a reasoning tail, a command's last output line, a sub-agent's step. */
  note: string;
  /** Epoch ms the phase began. */
  since: number;
  /** Counters: block size, other calls running. */
  extra: string[];
  /** The turn waits for the user (a blocking gate). */
  gated?: boolean;
};

export function describeLive(a: LiveActivity, providerName: string): LiveLine {
  const line: LiveLine = { label: '', detail: '', note: '', since: a.since, extra: [] };
  const t = a.tool;
  switch (a.beat) {
    case 'wait': line.label = `Waiting for ${providerName}`; break;
    case 'think': line.label = 'Thinking'; line.note = a.tail ?? ''; break;
    case 'say': line.label = 'Writing'; break;
    case 'retry': line.label = 'Retrying'; line.note = a.tail ?? ''; break;
    case 'prep':
      line.label = 'Preparing';
      line.detail = t ? [toolShortName(t.name), t.detail].filter(Boolean).join(' ') : '';
      break;
    case 'tool': {
      const family = t ? toolFamily(t.name) : 'other';
      line.label = t && /^web_?search$/i.test(t.name) ? 'Searching the web' : VERB[family];
      if (t) {
        line.detail = family === 'mcp' || family === 'other' || (family === 'plan' && !t.detail)
          ? [toolShortName(t.name), t.detail].filter(Boolean).join(' ')
          : t.detail || toolShortName(t.name);
        line.note = t.sub ? `→ ${t.sub}` : t.tail ?? '';
        line.since = t.since;
      }
      break;
    }
  }
  if (a.chars && (a.beat === 'prep' || a.beat === 'say' || a.beat === 'think')) line.extra.push(`${fmtChars(a.chars)} chars`);
  const others = (a.running ?? 0) - (a.beat === 'tool' ? 1 : 0);
  if (others > 0) line.extra.push(`+${others} running`);
  return line;
}

/** A blocking gate holds the turn: the bar says who it waits for. */
export type LiveGate =
  | { kind: 'permission'; tool: string; input: unknown; createdAt: number }
  | { kind: 'question'; question?: string; createdAt: number }
  | { kind: 'exit_plan'; createdAt: number };

export function describeGate(g: LiveGate): LiveLine {
  const since = g.createdAt * 1000;
  if (g.kind === 'permission') {
    return {
      label: 'Needs your approval', since, note: '', extra: [], gated: true,
      detail: [toolShortName(g.tool), toolDetail(g.tool, g.input)].filter(Boolean).join(' '),
    };
  }
  if (g.kind === 'question') {
    return { label: 'Waiting for your answer', detail: '', note: oneLine(g.question ?? ''), since, extra: [], gated: true };
  }
  return { label: 'Waiting for plan approval', detail: '', note: '', since, extra: [], gated: true };
}

function fmtChars(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

// ── Text ────────────────────────────────────────────────────────────────────

export function oneLine(text: string, max = LIVE_DETAIL_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The END of a stream, cut at a word. */
export function tailLine(text: string, max = TAIL_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(flat.length - max);
  const space = cut.indexOf(' ');
  return `…${space > 0 && space < 24 ? cut.slice(space + 1) : cut}`;
}

/** The last non-empty line of an output (ANSI and \r redraws stripped). */
function lastLine(out: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const lines = clean.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const segs = lines[i].split('\r');
    const l = segs[segs.length - 1].trim() || segs.map((s) => s.trim()).filter(Boolean).pop() || '';
    if (l) return oneLine(l, TAIL_MAX);
  }
  return '';
}
