import 'server-only';
import type { Vps } from '@/lib/db/schema';
import { sshExec } from './sshExec';

// Parser Python passé via stdin à `python3 -`. Extrait les messages d'un
// fichier ~/.claude/projects/<slug>/<uuid>.jsonl et émet un JSON array
// de { role, content, ts } prêt à être inséré tel quel dans
// claude_session_messages.
//
// Mappping :
//   - user (content string)                → role='user'   content=text
//   - user (content list de tool_result)   → role='tool_result' (1 row par bloc)
//   - assistant (content list de blocks)   → mêmes rows que les events SDK :
//       text   → role='assistant'  content=concat des textes du turn
//       tool_use → role='tool_use' (1 row par bloc)
//       thinking → skip (pas critique pour l'historique relu)
//
// On préserve l'ordre via le timestamp ISO du jsonl (converti en unix).
const PARSE_PY = `
import json, sys, os
from pathlib import Path

session_id = os.environ.get('CLAUDE_SESSION_ID', '')
if not session_id:
    print('NO_SESSION_ID', file=sys.stderr)
    sys.exit(1)

# Trouve le .jsonl : il est dans n'importe quel sous-dir de ~/.claude/projects
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
    """Extrait le texte d'un content (string ou list de blocks 'text')."""
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

# Filtre : les blocs d'injection 'system' (<command-name>, etc.) sont visibles
# dans le chat user — on les SKIP pour avoir un historique propre.
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
                # Liste de blocks — typiquement des tool_result
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
                        # Rare : un user message en mode "structuré" avec texte
                        txt = b.get('text', '')
                        if txt and not is_system_injection(txt):
                            out.append({'role': 'user', 'content': txt, 'ts': ts})
        elif t == 'assistant':
            msg = d.get('message') or {}
            content = msg.get('content', []) or []
            if not isinstance(content, list):
                # Fallback (rare) : content scalar
                txt = str(content)
                if txt:
                    out.append({'role': 'assistant', 'content': txt, 'ts': ts})
                continue
            # Concat tous les blocs 'text' en un seul assistant message,
            # émets les tool_use séparément (comme à runtime).
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
                # thinking : skip pour l'historique relu
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

/** SSH-fetch un JSONL session et renvoie les messages parsés. */
export async function importJsonlMessages(
  vps: Vps,
  claudeSessionId: string,
): Promise<{ ok: boolean; messages: ImportedMessage[]; error?: string }> {
  // Sélectionne python3.10+ explicitement (cohérent avec le reste de Charon)
  const PY = '$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3)';
  const cmd = `CLAUDE_SESSION_ID='${claudeSessionId.replace(/'/g, "'\\''")}' ${PY} -`;
  const r = await sshExec(vps, cmd, { stdin: PARSE_PY, timeoutMs: 60_000 });
  if (!r.ok) {
    if (r.stderr.includes('JSONL_NOT_FOUND')) {
      return { ok: false, messages: [], error: 'fichier JSONL introuvable sur le VPS' };
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
