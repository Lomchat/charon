import 'server-only';
import type { Vps } from '@/lib/db/schema';
import { shQuote, sshExec } from './sshExec';

// SubAgentActivity is an activity item, not a child-turn completion feed.
// Old SDKs drop child turn/completed and the bounded inspector catalog can
// omit recent children. Read only the exact known children's native lifecycle
// receipts, just as importCodexRollout reads native history (§14.91).
// Missing, truncated, corrupt or concurrently changing evidence is UNKNOWN.
export const CODEX_BG_STATE_PY = String.raw`
import datetime, json, os, sqlite3, sys
from pathlib import Path

request = json.loads(os.environ['CHARON_BG_REQUEST'])
home = Path(request.get('codexHome') or os.environ.get('CODEX_HOME') or str(Path.home() / '.codex'))
databases = sorted(home.glob('state_*.sqlite'), key=lambda p: p.stat().st_mtime, reverse=True)
result = []
if not databases:
    print(json.dumps({'tasks': result})); sys.exit(0)
db = sqlite3.connect(databases[0].resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
def owned(tid):
    seen = set()
    while tid and tid not in seen and len(seen) < 32:
        seen.add(tid)
        row = db.execute('SELECT source FROM threads WHERE id=?', (tid,)).fetchone()
        if not row: return False
        try:
            source = json.loads(row[0])
            tid = source['subagent']['thread_spawn']['parent_thread_id']
        except (ValueError, TypeError, KeyError): return False
        if tid == request['parentId']: return True
    return False

for tid in request['taskIds'][:64]:
    try:
        if not owned(tid): continue
        row = db.execute('SELECT rollout_path FROM threads WHERE id=?', (tid,)).fetchone()
        if not row or not row[0]: continue
        with open(row[0], 'rb') as f:
            before = os.fstat(f.fileno())
            offset = max(0, before.st_size - 1024 * 1024)
            f.seek(offset)
            data = f.read(1024 * 1024)
            after = os.fstat(f.fileno())
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns): continue
        if not data.endswith(b'\n'): continue
        lines = data.splitlines()[1 if offset else 0:]
        latest = None
        for line in lines:
            item = json.loads(line)
            if item.get('type') != 'event_msg': continue
            payload = item.get('payload') or {}
            kind = payload.get('type')
            status = {'task_started': 'running', 'task_complete': 'completed',
                      'turn_aborted': 'killed'}.get(kind)
            if status:
                stamp = datetime.datetime.fromisoformat(item['timestamp'].replace('Z', '+00:00')).timestamp()
                latest = {'taskId': tid, 'status': status, 'at': stamp}
        if latest: result.append(latest)
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
        continue
print(json.dumps({'tasks': result}))
`;

export type CodexBgObservation = {
  taskId: string;
  status: 'running' | 'completed' | 'killed';
  at: number;
};

export async function readCodexBgState(
  vps: Vps, parentId: string, taskIds: string[], codexHome?: string,
): Promise<CodexBgObservation[]> {
  const request = JSON.stringify({ parentId, taskIds: taskIds.slice(0, 64), codexHome });
  const result = await sshExec(vps,
    `CHARON_BG_REQUEST=${shQuote(request)} python3 -`,
    { stdin: CODEX_BG_STATE_PY, timeoutMs: 15_000 },
  );
  if (!result.ok) return [];
  try {
    const tasks: unknown = JSON.parse(result.stdout).tasks;
    if (!Array.isArray(tasks)) return [];
    return tasks.filter((task): task is CodexBgObservation =>
      taskIds.includes(task?.taskId)
      && ['running', 'completed', 'killed'].includes(task?.status)
      && typeof task?.at === 'number' && Number.isFinite(task.at));
  } catch { return []; }
}
