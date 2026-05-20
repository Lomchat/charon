import 'server-only';
import type { Vps } from '@/lib/db/schema';
import { sshExec } from './sshExec';

// Python parser passed via stdin to `python3 -`. Extracts messages from a
// ~/.claude/projects/<slug>/<uuid>.jsonl file and emits a JSON array
// of { role, content, ts } ready to be inserted as-is into
// claude_session_messages.
//
// Mapping:
//   - user (content string)                → role='user'   content=text
//   - user (content list of tool_result)   → role='tool_result' (1 row per block)
//   - assistant (content list of blocks)   → same rows as the SDK events:
//       text   → role='assistant'  content=concat of the turn's texts
//       tool_use → role='tool_use' (1 row per block)
//       thinking → skip (not critical for replayed history)
//
// We preserve order via the ISO timestamp from the jsonl (converted to unix).
const PARSE_PY = `
import json, sys, os
from pathlib import Path

session_id = os.environ.get('CLAUDE_SESSION_ID', '')
if not session_id:
    print('NO_SESSION_ID', file=sys.stderr)
    sys.exit(1)

# Find the .jsonl: it's in some sub-dir of ~/.claude/projects
home = Path.home()
base = home / '.claude' / 'projects'
candidates = []
if base.exists():
    for d in base.iterdir():
        if d.is_dir():
            f = d / f'{session_id}.jsonl'
            if f.exists():
                candidates.append(f)
if not candidates:
    print(f'JSONL_NOT_FOUND', file=sys.stderr)
    sys.exit(2)
target = candidates[0]

def iso_to_unix(iso):
    if not iso:
        return None
    # 2026-05-18T09:32:27.285Z → 2026-05-18T09:32:27.285+00:00
    try:
        from datetime import datetime
        iso2 = iso.replace('Z', '+00:00')
        return int(datetime.fromisoformat(iso2).timestamp())
    except Exception:
        return None

def extract_text(content):
    """Extract the text from a content (string or list of 'text' blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get('type') == 'text':
                t = b.get('text')
                if t: parts.append(t)
        return ''.join(parts)
    return ''

# Filter: 'system' injection blocks (<command-name>, etc.) are visible
# in the user chat — we SKIP them for a clean history.
def is_system_injection(text):
    if not text: return True
    s = text.lstrip()
    return s.startswith('<command-name>') or s.startswith('<local-command-stdout>') or s.startswith('<system-reminder>')

out = []
with open(target, 'r', errors='replace') as f:
    for line in f:
        try:
            d = json.loads(line)
        except Exception:
            continue
        if not isinstance(d, dict):
            continue
        t = d.get('type')
        ts = iso_to_unix(d.get('timestamp'))
        if t == 'user':
            msg = d.get('message') or {}
            content = msg.get('content', '')
            if isinstance(content, str):
                if is_system_injection(content):
                    continue
                out.append({'role': 'user', 'content': content, 'ts': ts})
            elif isinstance(content, list):
                # List of blocks — typically tool_results
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    if b.get('type') == 'tool_result':
                        bc = b.get('content', '')
                        if isinstance(bc, list):
                            # list of text blocks → concat
                            parts = []
                            for x in bc:
                                if isinstance(x, dict):
                                    parts.append(x.get('text', ''))
                                else:
                                    parts.append(str(x))
                            bc = ''.join(parts)
                        elif not isinstance(bc, str):
                            bc = json.dumps(bc)
                        out.append({
                            'role': 'tool_result',
                            'content': json.dumps({
                                'type': 'tool_result',
                                'tool_use_id': b.get('tool_use_id', ''),
                                'content': bc,
                                'is_error': bool(b.get('is_error', False)),
                            }),
                            'ts': ts,
                        })
                    elif b.get('type') == 'text':
                        # Rare: a user message in "structured" mode with text
                        txt = b.get('text', '')
                        if txt and not is_system_injection(txt):
                            out.append({'role': 'user', 'content': txt, 'ts': ts})
        elif t == 'assistant':
            msg = d.get('message') or {}
            content = msg.get('content', []) or []
            if not isinstance(content, list):
                # Fallback (rare): scalar content
                txt = str(content)
                if txt:
                    out.append({'role': 'assistant', 'content': txt, 'ts': ts})
                continue
            # Concat all 'text' blocks into a single assistant message,
            # emit tool_use separately (as at runtime).
            text_parts = []
            tools = []
            for b in content:
                if not isinstance(b, dict):
                    continue
                bt = b.get('type')
                if bt == 'text':
                    text_parts.append(b.get('text', ''))
                elif bt == 'tool_use':
                    tools.append({
                        'type': 'tool_use',
                        'id': b.get('id', ''),
                        'name': b.get('name', ''),
                        'input': b.get('input') or {},
                    })
                # thinking: skip for replayed history
            assistant_text = ''.join(text_parts)
            if assistant_text:
                out.append({'role': 'assistant', 'content': assistant_text, 'ts': ts})
            for tu in tools:
                out.append({'role': 'tool_use', 'content': json.dumps(tu), 'ts': ts})

print(json.dumps(out))
`;

export type ImportedMessage = {
  role: string;
  content: string;
  ts: number | null;
};

/** SSH-fetch a session JSONL and return the parsed messages. */
export async function importJsonlMessages(
  vps: Vps,
  claudeSessionId: string,
): Promise<{ ok: boolean; messages: ImportedMessage[]; error?: string }> {
  // Explicitly pick python3.10+ (consistent with the rest of Charon)
  const PY = '$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3)';
  const cmd = `CLAUDE_SESSION_ID='${claudeSessionId.replace(/'/g, "'\\''")}' ${PY} -`;
  const r = await sshExec(vps, cmd, { stdin: PARSE_PY, timeoutMs: 60_000 });
  if (!r.ok) {
    if (r.stderr.includes('JSONL_NOT_FOUND')) {
      return { ok: false, messages: [], error: 'JSONL file not found on the VPS' };
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
