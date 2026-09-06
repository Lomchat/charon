import { sshExec, shQuote, openSshSession, type SshSession } from './sshExec';
import type { Vps } from '@/lib/db/schema';
import type { SessionPathResponse } from '@/lib/types/api';

const g = globalThis as unknown as { __charonSessionPathSsh?: Map<string, SshSession> };
const sessions = (g.__charonSessionPathSsh ??= new Map<string, SshSession>());

// The same check powers the preview and launch. Never mkdir -p: only the
// final component may be missing. cd into the parent before creating it.
export function sessionPathScript(raw: string, create: boolean): string {
  const p = raw.trim().replace(/\/+$/, '') || '/';
  if (!raw.trim() || p.length > 4096 || p.includes('\0')) throw new Error('invalid path');
  const expr = p === '~' ? '"$HOME"' : p.startsWith('~/') ? '"$HOME"/' + shQuote(p.slice(2)) : shQuote(p);
  return [
    `charon_dir=${expr}`,
    'if [ -d "$charon_dir" ]; then cd -- "$charon_dir" || exit 6; pwd -P; exit 0; fi',
    '[ ! -e "$charon_dir" ] && [ ! -L "$charon_dir" ] || exit 4',
    'charon_parent=$(dirname -- "$charon_dir")',
    'charon_leaf=$(basename -- "$charon_dir")',
    'cd -P -- "$charon_parent" 2>/dev/null || exit 3',
    '[ "$charon_leaf" != . ] && [ "$charon_leaf" != .. ] || exit 3',
    create
      ? 'mkdir -- "$charon_leaf" 2>/dev/null || { [ -d "$charon_leaf" ] || exit 5; }; cd -- "$charon_leaf" || exit 6; pwd -P'
      : 'exit 2',
  ].join('\n');
}

export async function checkSessionPath(v: Vps, path: string, create = false): Promise<SessionPathResponse> {
  let session = sessions.get(v.id);
  if (!session || session.vps.ip !== v.ip || session.vps.sshUser !== v.sshUser || session.vps.sshPort !== v.sshPort) {
    session = openSshSession(v);
    sessions.set(v.id, session);
  }
  const r = await sshExec(v, sessionPathScript(path, create), { timeoutMs: 10_000, session });
  if (r.ok) return { ok: true, exists: true, resolved: r.stdout.trim() };
  if (r.code === 2) return { ok: true, exists: false };
  const error = r.code === 3 ? 'The parent directory does not exist or is inaccessible.'
    : r.code === 4 ? 'This path exists but is not a directory.'
    : r.code === 5 ? 'The directory could not be created. Check the parent directory permissions.'
    : 'The directory could not be verified or accessed on the VPS.';
  return { ok: false, error };
}
