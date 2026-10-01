import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { invalidateGitStatus } from '@/lib/server/claude/git';
import { cancelUpload, writeUploadChunk } from '@/lib/server/claude/fsUpload';
import { FS_UPLOAD_CHUNK_BYTES } from '@/lib/fsUpload';
import type { FsUploadResponse } from '@/lib/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string; uploadId: string }> };

// PUT /api/vps/[id]/fs/upload/[uploadId]?offset=<n>   raw bytes, one chunk
// DELETE /api/vps/[id]/fs/upload/[uploadId]           cancel
//
// The chunk that completes the announced size answers only once the VPS has
// committed the file (`done`), so "uploaded" in the browser means on disk.
export async function PUT(req: Request, { params }: RouteContext) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id, uploadId } = await params;
  const offset = Number(new URL(req.url).searchParams.get('offset'));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return NextResponse.json<FsUploadResponse>({ ok: false, error: 'invalid offset' }, { status: 400 });
  }
  // Refuse on the declared length BEFORE buffering the body.
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > FS_UPLOAD_CHUNK_BYTES) {
    return NextResponse.json<FsUploadResponse>({ ok: false, error: 'chunk too large' }, { status: 413 });
  }
  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length > FS_UPLOAD_CHUNK_BYTES) {
    return NextResponse.json<FsUploadResponse>({ ok: false, error: 'chunk too large' }, { status: 413 });
  }
  const r = await writeUploadChunk(id, uploadId, offset, bytes);
  if (!r.ok) {
    return NextResponse.json<FsUploadResponse>({ ok: false, reason: r.reason, error: r.error, received: r.received });
  }
  if (r.done && r.root) invalidateGitStatus(id, r.root);
  return NextResponse.json<FsUploadResponse>({ ok: true, received: r.received, done: r.done });
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id, uploadId } = await params;
  return NextResponse.json({ ok: cancelUpload(id, uploadId) });
}
