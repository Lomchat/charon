import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db, claudeSessions, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import {
  attachmentBlobPath, getAttachment, removeAttachment, unlinkRemoteAttachment,
} from '@/lib/server/claude/attachments';
import { previewMimeFor } from '@/lib/server/claude/attachmentNames';

// GET    /api/claude/sessions/[id]/attachments/[attId]  → download the hub copy
// DELETE /api/claude/sessions/[id]/attachments/[attId]  → forget the attachment
//
// The download serves the HUB copy, never a re-fetch over SSH: the point of
// keeping a local blob is that "download what I sent" must work even when the
// VPS is unreachable, and must not cost an ssh round-trip per click.

export async function GET(req: Request, { params }: { params: Promise<{ id: string; attId: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id, attId } = await params;

  const att = getAttachment(id, attId);
  if (!att) return NextResponse.json({ error: 'attachment not found' }, { status: 404 });
  const blob = attachmentBlobPath(att);
  if (!blob) return NextResponse.json({ error: 'no local copy of this file' }, { status: 410 });

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(blob);
  } catch {
    return NextResponse.json({ error: 'local copy is missing on disk' }, { status: 410 });
  }

  // `?inline=1` → render in a browser tab (images, PDF, audio, video, text).
  // Anything the preview table doesn't know falls back to a download rather
  // than erroring: the user asked to see the file, and a download is a strictly
  // better answer than a 400.
  const wantsInline = new URL(req.url).searchParams.get('inline') === '1';
  const previewMime = wantsInline ? previewMimeFor(att.name) : null;

  // The name already went through sanitizeAttachmentName at upload (single
  // segment, no control characters); dropping `"` closes the header-injection
  // hole, and filename* carries the unicode form.
  const safe = att.name.replace(/"/g, '');
  const disposition = previewMime ? 'inline' : 'attachment';

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      // NEVER the browser-declared mime — that value is attacker-controlled.
      // Either a type from the extension-keyed preview allow-list, or an
      // opaque download. cf. attachmentNames.ts § PREVIEW_MIME.
      'content-type': previewMime ?? 'application/octet-stream',
      'content-disposition': `${disposition}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(att.name)}`,
      'content-length': String(bytes.length),
      // Stops a text/plain preview from being sniffed into HTML.
      'x-content-type-options': 'nosniff',
      // THE control that makes inline rendering of user bytes safe: `sandbox`
      // with no `allow-scripts` puts the response in a unique opaque origin
      // with scripting disabled, so an SVG carrying <script> is inert and
      // nothing served here can touch Charon's origin or its session cookie.
      'content-security-policy': 'sandbox; default-src \'none\'; img-src data: blob: \'self\'; media-src \'self\'; style-src \'unsafe-inline\'',
      'cache-control': 'private, max-age=300',
    },
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; attId: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id, attId } = await params;

  const att = getAttachment(id, attId);
  if (!att) return NextResponse.json({ error: 'attachment not found' }, { status: 404 });

  try {
    await removeAttachment(id, attId);
    // Remote unlink is best-effort and deliberately NOT awaited into the
    // verdict: an unreachable VPS must not block the user from clearing an
    // entry from their own list. The file stays in the user's visible
    // `.charon-uploads/` directory if it fails.
    const [sess] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
    if (sess) {
      const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, sess.vpsId)).all();
      if (v) void unlinkRemoteAttachment(v, att.remotePath);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error(`[api/claude/sessions/${id}/attachments/${attId} DELETE] failed:`, e?.stack ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
