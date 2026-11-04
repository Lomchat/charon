import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import {
  isLiveHtmlName, livePreviewScope, livePreviewUrl, parseLivePreviewPath,
} from '@/lib/livePreview';
import { LIVE_PREVIEW_TTL_SECS, signLivePreviewToken } from '@/lib/server/hub/livePreviewToken';
import { livePreviewKey } from '@/lib/server/hub/livePreviewAuth';
import type { FsLivePreviewBody, FsLivePreviewResponse } from '@/lib/types/api';

// POST /api/vps/[id]/fs/preview  { root, path }  →  { ok, url, expiresAt }
//
// Mints the live-view URL of one HTML file (§14.110). Cookie-authenticated like
// every route; what it hands back is a capability for the sandboxed page,
// which never sees that cookie: read-only, this VPS, this root, the preview's
// extension allow-list, and only while this login lives. Nothing is read
// from the VPS here — the preview route does that, request by request.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select({ id: vps.id }).from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json<FsLivePreviewResponse>({ ok: false, error: 'vps not found' }, { status: 404 });

  let body: FsLivePreviewBody;
  try { body = await req.json(); } catch {
    return NextResponse.json<FsLivePreviewResponse>({ ok: false, error: 'invalid body' }, { status: 400 });
  }
  const root = String(body?.root ?? '');
  const path = String(body?.path ?? '');
  if (!root.startsWith('/') || root.length > 4096 || !path || path.length > 4096) {
    return NextResponse.json<FsLivePreviewResponse>({ ok: false, error: 'root and path are required' }, { status: 400 });
  }
  if (!isLiveHtmlName(path)) {
    return NextResponse.json<FsLivePreviewResponse>({ ok: false, error: 'only HTML files have a live view' }, { status: 400 });
  }
  const scope = livePreviewScope(root, path);
  // The route will apply exactly this parse to the URL: refuse here what it
  // would refuse there, with a sentence instead of a blank frame.
  if (parseLivePreviewPath(scope.path.split('/').map(encodeURIComponent)) !== scope.path) {
    return NextResponse.json<FsLivePreviewResponse>({
      ok: false, error: 'this file name cannot be served in a live view',
    }, { status: 400 });
  }

  const exp = Math.floor(Date.now() / 1000) + LIVE_PREVIEW_TTL_SECS;
  const token = signLivePreviewToken({ vpsId: id, root: scope.root, sid: s.sessionId, exp }, livePreviewKey());
  return NextResponse.json<FsLivePreviewResponse>({
    ok: true, url: livePreviewUrl(token, scope.path), expiresAt: exp * 1000,
  });
}
