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
const SCAN_PY = `
import os, json, sys
from pathlib import Path
home = Path.home()
base = home / '.claude' / 'projects'
out = []
if base.exists():
    for d in sorted(base.iterdir()):
        if not d.is_dir():
            continue
        for f in d.glob('*.jsonl'):
            try:
                stat = f.stat()
                cwd = d.name.replace('-', '/')
                summary = ''
                with open(f, 'r', errors='replace') as fh:
                    line = fh.readline()
                    if line:
                        try:
                            data = json.loads(line)
                            if isinstance(data, dict):
                                cwd = data.get('cwd') or cwd
                                summary = data.get('summary') or ''
                        except Exception:
                            pass
                out.append({
                    'sessionId': f.stem,
                    'cwd': cwd,
                    'mtime': int(stat.st_mtime),
                    'size': stat.st_size,
                    'summary': summary,
                })
            except Exception:
                pass
out.sort(key=lambda x: -x['mtime'])
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
