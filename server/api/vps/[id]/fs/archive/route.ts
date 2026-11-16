import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { fileToolCall, rootAndPath } from '@/lib/server/hub/fileToolsRpc';
import { invalidateGitStatus } from '@/lib/server/hub/git';

export const dynamic = 'force-dynamic';

// POST /api/vps/[id]/fs/archive  { root, path, op: 'list' | 'read' | 'extract', member? }
//
// Inside a zip/tar/gzip without unpacking it (§14.112). `extract` is the one
// write: a NEW sibling folder named after the archive — never over an
// existing one, never a member outside it (zip-slip), links skipped, bounded
// in size and count, all-or-nothing.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
  }
  const at = rootAndPath(body);
  if (!at) return NextResponse.json({ ok: false, error: 'root and path are required' }, { status: 400 });
  if (body.op === 'list') return fileToolCall(id, 'archive_list', at);
  if (body.op === 'read') {
    if (typeof body.member !== 'string') {
      return NextResponse.json({ ok: false, error: 'member is required' }, { status: 400 });
    }
    return fileToolCall(id, 'archive_read', { ...at, member: body.member });
  }
  if (body.op === 'extract') {
    const res = await fileToolCall(id, 'archive_extract', at, { timeoutMs: 600_000 });
    // New files under the root: the repo's status chip must not wait a poll.
    invalidateGitStatus(id, at.root);
    return res;
  }
  return NextResponse.json({ ok: false, error: 'op must be list, read or extract' }, { status: 400 });
}
