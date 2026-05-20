import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshExec } from '@/lib/server/claude/sshExec';

// GET /api/vps/[id]/claude/scan
// Lists existing Claude sessions on the VPS (.jsonl files in
// ~/.claude/projects/<slug>/<uuid>.jsonl).

// Python script — passed as-is on stdin of `python3 -` (NOT -c, because
// indented blocks don't survive a `; ` join).
//
// We extract what claude /resume shows: AI title, last prompt, first
// user message, message count, model, git branch, size, mtime.
// Compatible with python 3.9 (no 3.10+ syntax used).
const SCAN_PY = `
import os, json, sys
from pathlib import Path

MAX_LINES = 10000  # safeguard for huge sessions

def extract_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get('type') == 'text':
                return b.get('text') or ''
    return ''

def is_system_injection(text):
    # claude code injects blocks <ide_opened_file>, <command-name>, etc.
    # that we want to filter out to show a REAL user message
    if not text:
        return True
    s = text.lstrip()
    return s.startswith('<') or s.startswith('[Request interrupted')

def parse_one(path):
    cwd_fallback = path.parent.name.replace('-', '/')
    info = {
        'sessionId': path.stem,
        'cwd': cwd_fallback,         # INITIAL cwd (at session start)
                                     # — this is the one that matches the
                                     # .jsonl file slug, so usable for
                                     # resume without relocate
        'cwdLatest': cwd_fallback,   # cwd AFTER any cd's
        'summary': '',
        'aiTitle': '',
        'lastPrompt': '',
        'firstUserText': '',
        'messageCount': 0,
        'model': '',
        'gitBranch': '',
    }
    cwd_locked = False  # once we have a real cwd, we no longer touch 'cwd'
    try:
        stat = path.stat()
        info['mtime'] = int(stat.st_mtime)
        info['size'] = stat.st_size
    except Exception:
        return None
    try:
        with open(path, 'r', errors='replace') as fh:
            for i, line in enumerate(fh):
                if i >= MAX_LINES:
                    break
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if not isinstance(d, dict):
                    continue
                t = d.get('type')
                if d.get('cwd'):
                    if not cwd_locked:
                        info['cwd'] = d.get('cwd')
                        cwd_locked = True
                    info['cwdLatest'] = d.get('cwd')
                if d.get('gitBranch'):
                    info['gitBranch'] = d.get('gitBranch')
                if d.get('summary'):
                    info['summary'] = d.get('summary')
                if t == 'ai-title':
                    at = d.get('aiTitle')
                    if at:
                        info['aiTitle'] = at
                elif t == 'last-prompt':
                    lp = d.get('lastPrompt')
                    if lp:
                        info['lastPrompt'] = lp[:400]
                elif t == 'user':
                    info['messageCount'] += 1
                    if not info['firstUserText']:
                        msg = d.get('message') or {}
                        text = extract_text(msg.get('content'))
                        if not is_system_injection(text):
                            info['firstUserText'] = text[:300]
                elif t == 'assistant':
                    info['messageCount'] += 1
                    msg = d.get('message') or {}
                    m = msg.get('model')
                    if m:
                        info['model'] = m
    except Exception:
        pass
    return info

home = Path.home()
base = home / '.claude' / 'projects'
out = []
if base.exists():
    for d in sorted(base.iterdir()):
        if not d.is_dir():
            continue
        for f in d.glob('*.jsonl'):
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

  // The scan also works on python3.9 (no 3.10+ syntax used).
  const cmd =
    `PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3); ` +
    `"$PY" -`;
  const r = await sshExec(v, cmd, { stdin: SCAN_PY, timeoutMs: 30_000 });
  if (!r.ok) {
    return NextResponse.json({ error: 'ssh failed', stderr: r.stderr.slice(-400), stdout: r.stdout.slice(-400) }, { status: 500 });
  }
  let parsed: any[] = [];
  try { parsed = JSON.parse(r.stdout.trim()); } catch (e) {
    return NextResponse.json({ error: 'bad json from VPS', stdout: r.stdout.slice(-400) }, { status: 500 });
  }
  return NextResponse.json({ sessions: parsed });
}
