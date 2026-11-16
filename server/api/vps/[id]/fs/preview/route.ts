import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { mintLivePreview } from '@/lib/server/hub/livePreviewMint';
import type { FsLivePreviewBody, FsLivePreviewResponse } from '@/lib/types/api';

// POST /api/vps/[id]/fs/preview  { root, path }  →  { ok, url, expiresAt }
//
// Mints the live-view URL of one HTML file (§14.110) for this login; the
// checks and the capability's scope live in `mintLivePreview`.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;

  let body: FsLivePreviewBody;
  try { body = await req.json(); } catch {
    return NextResponse.json<FsLivePreviewResponse>({ ok: false, error: 'invalid body' }, { status: 400 });
  }
  const m = mintLivePreview(id, String(body?.root ?? ''), String(body?.path ?? ''), s.sessionId);
  if (!m.ok) return NextResponse.json<FsLivePreviewResponse>({ ok: false, error: m.error }, { status: m.status });
  return NextResponse.json<FsLivePreviewResponse>({ ok: true, url: m.url, expiresAt: m.expiresAt });
}
