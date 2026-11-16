import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { fileToolCall, rootAndPath } from '@/lib/server/hub/fileToolsRpc';

export const dynamic = 'force-dynamic';

// GET /api/vps/[id]/fs/range?root=&path=&offset=&length=
//
// A byte range of one file (§14.112) — the log view's tail, its earlier
// chunks and what it follows. A negative offset counts from the end. Rides
// the persistent agent channel: following a log is a request every few
// seconds, and an SSH stream per poll would be a channel per poll.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const url = new URL(req.url);
  const at = rootAndPath({ root: url.searchParams.get('root'), path: url.searchParams.get('path') });
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const length = Number(url.searchParams.get('length') ?? 0);
  if (!at || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 0) {
    return NextResponse.json({ ok: false, error: 'root, path, offset and length are required' }, { status: 400 });
  }
  return fileToolCall(id, 'fs_read_range', { ...at, offset, length });
}
