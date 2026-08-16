import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshExec } from '@/lib/server/claude/sshExec';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';

// GET /api/vps/[id]/codex/scan
// Lists existing Codex threads on the VPS — the Codex sibling of
// .../claude/scan. Same contract, same response shape, so ResumeModal can
// render both behind one component.
//
// The supported SDK thread_list() is authoritative on current agents: it
// supplies persistent names, source kinds, parent ids and runtime status. The
// rollout scanner below remains the compatibility/offline fallback because it
// needs neither a new agent nor a bootable/logged-in app-server.
//
// Layout: ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<thread-uuid>.jsonl
//
// TWO on-disk formats exist and both are parsed (verified on the fleet):
//   - modern: every line is {timestamp, type: session_meta|event_msg|
//     response_item|turn_context, payload: {...}}
//   - legacy (≈2025-09): a bare header line {id, timestamp, git} then
//     top-level {type: message|function_call|...} records, no payload wrapper.
const SCAN_PY = `
import os, json, sys
from pathlib import Path

MAX_LINES = 20000   # per-file safeguard (rollouts of a long thread are big)
MAX_FILES = 400     # newest-first cap, bounds the ssh round-trip

def as_text(v):
    """Codex pydantic RootModels serialize as {'root': ...} in some builds and
    plain strings in others — never trust the shape (cf. CLAUDE.md 14.59)."""
    if isinstance(v, str):
        return v
    if isinstance(v, dict) and 'root' in v:
        return as_text(v['root'])
    return ''

def is_subagent_source(src):
    """Sub-agent threads get their OWN rollout file (a 'guardian' spawned by a
    parent turn). Resuming one is meaningless, so they're excluded. The marker
    is 'source': a plain string ('vscode','cli','exec') for real threads, a
    dict like {'subagent': {'other': 'guardian'}} for sub-agents. Be positive
    about the detection: only skip on a POSITIVE subagent marker, never on an
    unknown shape (a format change must not blank the whole list)."""
    if isinstance(src, str):
        return src.lower().replace('_', '').startswith('subagent')
    if isinstance(src, dict):
        for k in src.keys():
            if str(k).lower().replace('_', '').startswith('subagent'):
                return True
    return False

def extract_text(content):
    """A content is a str, or a list of blocks ({type: input_text|text|
    output_text, text: ...})."""
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
    """Codex injects <environment_context>/<permissions instructions> blocks as
    'user' messages — they are not something the human typed."""
    if not text:
        return True
    s = text.lstrip()
    return s.startswith('<') or s.startswith('[Request interrupted')

def cwd_from_env_block(text):
    """Legacy rollouts carry NO cwd field: the only copy is inside the injected
    <environment_context> block. Without this a legacy thread resumes in $HOME
    instead of its project."""
    if not text or '<cwd>' not in text:
        return ''
    try:
        seg = text.split('<cwd>', 1)[1].split('</cwd>', 1)[0].strip()
        return seg if seg.startswith('/') else ''
    except Exception:
        return ''

def normalize(d):
    """(kind, payload) for both on-disk formats."""
    if not isinstance(d, dict):
        return (None, {})
    t = d.get('type')
    p = d.get('payload')
    if t and isinstance(p, dict):
        return (t, p)              # modern
    if t:
        return ('response_item', d)  # legacy top-level record
    if d.get('id') and d.get('timestamp'):
        return ('session_meta', d)   # legacy header line
    return (None, {})

def parse_one(path):
    info = {
        'sessionId': path.stem.split('-', 1)[-1],  # rollout-<ISO>-<uuid>
        'cwd': '',
        'summary': '',
        'aiTitle': '',
        'lastPrompt': '',
        'firstUserText': '',
        'messageCount': 0,
        'model': '',
        'effort': '',
        'gitBranch': '',
    }
    try:
        st = path.stat()
        info['mtime'] = int(st.st_mtime)
        info['size'] = st.st_size
    except Exception:
        return None

    saw_event_msg = False   # modern files: prefer event_msg over response_item
    ev_count = 0            # message count from event_msg lines
    ri_count = 0            # ...from response_item lines (legacy fallback)
    ev_first = ''
    ri_first = ''
    ev_last = ''
    ri_last = ''
    try:
        with open(path, 'r', errors='replace') as fh:
            for i, line in enumerate(fh):
                if i >= MAX_LINES:
                    break
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                kind, p = normalize(d)
                if kind == 'session_meta':
                    if is_subagent_source(p.get('source')):
                        return None
                    sid = p.get('session_id') or p.get('id')
                    if sid:
                        info['sessionId'] = sid
                    cwd = as_text(p.get('cwd')) or p.get('cwd')
                    if isinstance(cwd, str) and cwd:
                        info['cwd'] = cwd
                    g = p.get('git')
                    if isinstance(g, dict) and g.get('branch'):
                        info['gitBranch'] = g.get('branch')
                    if p.get('name'):
                        info['aiTitle'] = p.get('name')
                elif kind == 'turn_context':
                    # Carries the model/effort actually in force for the turn.
                    if p.get('model'):
                        info['model'] = as_text(p.get('model')) or p.get('model')
                    if p.get('effort'):
                        info['effort'] = as_text(p.get('effort')) or p.get('effort')
                    cwd = as_text(p.get('cwd')) or p.get('cwd')
                    if isinstance(cwd, str) and cwd and not info['cwd']:
                        info['cwd'] = cwd
                elif kind == 'event_msg':
                    pt = p.get('type')
                    if pt == 'user_message':
                        saw_event_msg = True
                        text = p.get('message') or ''
                        if not is_injection(text):
                            ev_count += 1
                            if not ev_first:
                                ev_first = text[:300]
                            ev_last = text[:400]
                    elif pt == 'agent_message':
                        saw_event_msg = True
                        ev_count += 1
                elif kind == 'response_item':
                    pt = p.get('type')
                    if pt != 'message':
                        continue
                    role = p.get('role')
                    if role == 'user':
                        text = extract_text(p.get('content'))
                        if not info['cwd']:
                            c = cwd_from_env_block(text)
                            if c:
                                info['cwd'] = c
                        if not is_injection(text):
                            ri_count += 1
                            if not ri_first:
                                ri_first = text[:300]
                            ri_last = text[:400]
                    elif role == 'assistant':
                        ri_count += 1
    except Exception:
        pass

    if saw_event_msg:
        info['messageCount'] = ev_count
        info['firstUserText'] = ev_first
        info['lastPrompt'] = ev_last
    else:
        info['messageCount'] = ri_count
        info['firstUserText'] = ri_first
        info['lastPrompt'] = ri_last
    # A thread with no cwd can't be resumed meaningfully — fall back to $HOME
    # rather than dropping it, the user can still see it exists.
    if not info['cwd']:
        info['cwd'] = str(Path.home())
    return info

base = Path.home() / '.codex' / 'sessions'
files = []
if base.exists():
    for f in base.rglob('*.jsonl'):
        try:
            files.append((f.stat().st_mtime, f))
        except Exception:
            continue
files.sort(key=lambda x: -x[0])

out = []
for _, f in files[:MAX_FILES]:
    r = parse_one(f)
    if r is not None:
        out.append(r)
out.sort(key=lambda x: -x.get('mtime', 0))
print(json.dumps(out))
`;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  try {
    const result = await getAgentClientForVpsId(id).call('list_codex_threads', {}) as {
      ok?: boolean;
      sessions?: unknown[];
    };
    if (result?.ok && Array.isArray(result.sessions)) {
      return NextResponse.json({ sessions: result.sessions });
    }
  } catch {
    // Old/offline agent or SDK unable to start: fall through to disk scan.
  }

  const cmd =
    `PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3); ` +
    `"$PY" -`;
  const r = await sshExec(v, cmd, { stdin: SCAN_PY, timeoutMs: 45_000 });
  if (!r.ok) {
    return NextResponse.json({ error: 'ssh failed', stderr: r.stderr.slice(-400), stdout: r.stdout.slice(-400) }, { status: 500 });
  }
  let parsed: any[] = [];
  try { parsed = JSON.parse(r.stdout.trim()); } catch {
    return NextResponse.json({ error: 'bad json from VPS', stdout: r.stdout.slice(-400) }, { status: 500 });
  }
  return NextResponse.json({ sessions: parsed });
}
