import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshExec } from '@/lib/server/claude/sshExec';

// GET /api/vps/[id]/claude/scan
// Liste les sessions Claude existantes sur le VPS (fichiers .jsonl dans
// ~/.claude/projects/<slug>/<uuid>.jsonl).

// Script Python — passé tel quel sur stdin de `python3 -` (PAS de -c, parce
// que les blocs indentés ne survivent pas au join par `; `).
//
// On extrait ce que claude /resume affiche : titre IA, dernier prompt, premier
// message user, nombre de messages, modèle, branche git, taille, mtime.
// Compatible python 3.9 (pas de syntaxe 3.10+).
const SCAN_PY = `
import os, json, sys
from pathlib import Path

MAX_LINES = 10000  # garde-fou pour les sessions énormes

def extract_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get('type') == 'text':
                return b.get('text') or ''
    return ''

def is_system_injection(text):
    # claude code injecte des blocs <ide_opened_file>, <command-name>, etc.
    # qu'on veut filtrer pour montrer un VRAI message user
    if not text:
        return True
    s = text.lstrip()
    return s.startswith('<') or s.startswith('[Request interrupted')

def parse_one(path):
    cwd_fallback = path.parent.name.replace('-', '/')
    info = {
        'sessionId': path.stem,
        'cwd': cwd_fallback,
        'summary': '',
        'aiTitle': '',
        'lastPrompt': '',
        'firstUserText': '',
        'messageCount': 0,
        'model': '',
        'gitBranch': '',
    }
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
                    info['cwd'] = d.get('cwd')
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

  // Le scan marche en python3.9 aussi (pas d'usage de syntaxe 3.10+).
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
