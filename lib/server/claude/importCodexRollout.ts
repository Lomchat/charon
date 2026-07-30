import 'server-only';
import type { Vps } from '@/lib/db/schema';
import { sshExec } from './sshExec';
import type { ImportedMessage } from './importJsonl';

// Codex sibling of importJsonl.ts: reads a Codex rollout JSONL off the VPS and
// returns rows ready for claude_session_messages, so an imported Codex thread
// shows its history immediately instead of an empty chat.
//
// The emitted rows mirror EXACTLY what CodexSession emits live (§14.59), so a
// resumed thread's imported past and its new turns render identically:
//   user / assistant           → plain text content
//   tool_use                   → {type,id,name,input}     (id = call_id)
//   tool_result                → {type,tool_use_id,content,is_error}
// Reasoning items are skipped (as in the Claude importer), and edit_snapshot
// rows are NOT produced: the rollout stores the apply_patch RESULT, not a
// before/after pair, and Codex has no revert anyway (§14.59).
const PARSE_PY = `
import json, sys, os
from pathlib import Path

thread_id = os.environ.get('CODEX_THREAD_ID', '')
if not thread_id:
    print('NO_THREAD_ID', file=sys.stderr)
    sys.exit(1)

MAX_LINES = 40000
MAX_CONTENT = 64 * 1024   # per tool output — keeps one import bounded

base = Path.home() / '.codex' / 'sessions'
target = None
if base.exists():
    # Filename is rollout-<ISO>-<thread-uuid>.jsonl, but never trust that
    # alone: fall back to reading the header of same-named candidates.
    for f in base.rglob('*' + thread_id + '.jsonl'):
        target = f
        break
    if target is None:
        for f in base.rglob('*.jsonl'):
            try:
                with open(f, 'r', errors='replace') as fh:
                    first = fh.readline()
                d = json.loads(first)
            except Exception:
                continue
            p = d.get('payload') if isinstance(d.get('payload'), dict) else d
            if p.get('session_id') == thread_id or p.get('id') == thread_id:
                target = f
                break
if target is None:
    print('ROLLOUT_NOT_FOUND', file=sys.stderr)
    sys.exit(2)

def iso_to_unix(iso):
    if not iso:
        return None
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(str(iso).replace('Z', '+00:00')).timestamp())
    except Exception:
        return None

def as_text(v):
    if isinstance(v, str):
        return v
    if isinstance(v, dict) and 'root' in v:
        return as_text(v['root'])
    return ''

def extract_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict):
                t = b.get('text')
                if t:
                    parts.append(t)
        return ''.join(parts)
    return ''

def is_injection(text):
    if not text:
        return True
    s = text.lstrip()
    return s.startswith('<') or s.startswith('[Request interrupted')

def normalize(d):
    """(kind, payload) for both on-disk rollout formats (see codex/scan)."""
    if not isinstance(d, dict):
        return (None, {})
    t = d.get('type')
    p = d.get('payload')
    if t and isinstance(p, dict):
        return (t, p)
    if t:
        return ('response_item', d)
    if d.get('id') and d.get('timestamp'):
        return ('session_meta', d)
    return (None, {})

def patch_paths(patch):
    """apply_patch input is a raw patch; live Codex emits {'paths': [...]} so
    the tool card reads the same after an import."""
    out = []
    for line in (patch or '').splitlines():
        s = line.strip()
        for marker in ('*** Add File:', '*** Update File:', '*** Delete File:'):
            if s.startswith(marker):
                p = s[len(marker):].strip()
                if p:
                    out.append(p)
    return out

def clip(s):
    if not isinstance(s, str):
        s = json.dumps(s) if s is not None else ''
    return s[:MAX_CONTENT]

out = []
ev_rows = []   # text from event_msg lines (modern format)
ri_rows = []   # ...from response_item lines (legacy fallback)
saw_event_msg = False

with open(target, 'r', errors='replace') as fh:
    for i, line in enumerate(fh):
        if i >= MAX_LINES:
            break
        try:
            d = json.loads(line)
        except Exception:
            continue
        kind, p = normalize(d)
        ts = iso_to_unix(d.get('timestamp'))
        n = len(out)

        if kind == 'event_msg':
            pt = p.get('type')
            if pt == 'user_message':
                text = p.get('message') or ''
                if not is_injection(text):
                    saw_event_msg = True
                    ev_rows.append((n, {'role': 'user', 'content': text, 'ts': ts}))
            elif pt == 'agent_message':
                text = p.get('message') or ''
                if text:
                    saw_event_msg = True
                    ev_rows.append((n, {'role': 'assistant', 'content': text, 'ts': ts}))

        elif kind == 'response_item':
            pt = p.get('type')
            if pt == 'message':
                role = p.get('role')
                if role not in ('user', 'assistant'):
                    continue          # 'developer' = injected instructions
                text = extract_text(p.get('content'))
                if not text or (role == 'user' and is_injection(text)):
                    continue
                ri_rows.append((n, {'role': role, 'content': text, 'ts': ts}))
            elif pt == 'function_call':
                args = p.get('arguments')
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {'arguments': args}
                if not isinstance(args, dict):
                    args = {'arguments': args}
                name = p.get('name') or ''
                if name == 'shell' and 'workdir' in args and 'cwd' not in args:
                    args['cwd'] = args.pop('workdir')   # match the live shape
                out.append({'role': 'tool_use', 'content': json.dumps({
                    'type': 'tool_use', 'id': p.get('call_id') or p.get('id') or '',
                    'name': name, 'input': args,
                }), 'ts': ts})
            elif pt == 'custom_tool_call':
                name = p.get('name') or ''
                raw = p.get('input')
                if name == 'apply_patch' and isinstance(raw, str):
                    inp = {'paths': patch_paths(raw)}
                elif isinstance(raw, dict):
                    inp = raw
                else:
                    inp = {'input': clip(as_text(raw) or (raw if isinstance(raw, str) else ''))}
                out.append({'role': 'tool_use', 'content': json.dumps({
                    'type': 'tool_use', 'id': p.get('call_id') or p.get('id') or '',
                    'name': name, 'input': inp,
                }), 'ts': ts})
            elif pt in ('function_call_output', 'custom_tool_call_output'):
                o = p.get('output')
                if isinstance(o, dict):
                    o = o.get('content', o)
                content = clip(o)
                is_err = content.startswith('Exit code:') and not content.startswith('Exit code: 0')
                out.append({'role': 'tool_result', 'content': json.dumps({
                    'type': 'tool_result', 'tool_use_id': p.get('call_id') or '',
                    'content': content, 'is_error': bool(is_err),
                }), 'ts': ts})
            # reasoning / web_search_call / other: skipped, as in the Claude importer

# Modern rollouts carry BOTH event_msg and response_item copies of every
# message — keep one. Splice the chosen text rows back at their recorded
# position so they stay interleaved with the tool rows.
chosen = ev_rows if saw_event_msg else ri_rows
for offset, (pos, row) in enumerate(chosen):
    out.insert(pos + offset, row)

print(json.dumps(out))
`;

/** SSH-fetch a Codex rollout JSONL and return the parsed messages. */
export async function importCodexRolloutMessages(
  vps: Vps,
  threadId: string,
): Promise<{ ok: boolean; messages: ImportedMessage[]; error?: string }> {
  const PY = '$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3)';
  const cmd = `CODEX_THREAD_ID='${threadId.replace(/'/g, "'\\''")}' ${PY} -`;
  const r = await sshExec(vps, cmd, { stdin: PARSE_PY, timeoutMs: 60_000 });
  if (!r.ok) {
    if (r.stderr.includes('ROLLOUT_NOT_FOUND')) {
      return { ok: false, messages: [], error: 'Codex rollout file not found on the VPS' };
    }
    return { ok: false, messages: [], error: r.stderr.slice(-300) || `exit ${r.code}` };
  }
  let parsed: ImportedMessage[];
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch (e: any) {
    return { ok: false, messages: [], error: 'bad json from parser: ' + (e?.message ?? e) };
  }
  return { ok: true, messages: parsed };
}
