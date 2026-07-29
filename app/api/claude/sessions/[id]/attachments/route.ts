import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import {
  createAttachment, listAttachments, MAX_ATTACHMENT_BYTES, fmtBytes,
} from '@/lib/server/claude/attachments';
import { previewMimeFor } from '@/lib/server/claude/attachmentNames';
import type { SessionAttachment } from '@/lib/types/api';

// GET  /api/claude/sessions/[id]/attachments  → list
// POST /api/claude/sessions/[id]/attachments  → upload (multipart, field `file`)
//
// This is the ONLY multipart route in the app: `lib/api.ts § send()` is
// JSON-only by construction, so the client uses a dedicated helper.
//
// NO mime/extension filtering, by design. The point of the feature is to hand
// a file to the agent and let IT say whether it can do anything with it —
// Claude's `Read` and Codex's `view_image` both give a far better error message
// than a 415 from us ever could. The only limits are size and emptiness.

function toPayload(a: {
  id: string; name: string; remotePath: string; size: number; mime: string | null; createdAt: number;
}): SessionAttachment {
  return {
    id: a.id,
    name: a.name,
    remotePath: a.remotePath,
    size: a.size,
    mime: a.mime ?? '',
    // Resolved here, not client-side: the client must not own the decision of
    // what may be rendered inline (cf. attachmentNames.ts § PREVIEW_MIME).
    previewMime: previewMimeFor(a.name),
    createdAt: a.createdAt,
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  try {
    return NextResponse.json({ attachments: listAttachments(id).map(toPayload) });
  } catch (e: any) {
    // Same posture as the other read paths: a transient DB failure is a
    // retryable 503, never an unhandled 500 (which would serve an HTML error
    // page into a JSON parse on the client).
    // eslint-disable-next-line no-console
    console.error(`[api/claude/sessions/${id}/attachments GET] failed:`, e?.stack ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 503 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;

  const [sess] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!sess) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, sess.vpsId)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 });
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'missing `file` field' }, { status: 400 });
  }

  // Reject on the declared size BEFORE buffering, so a 2 GB drop doesn't get
  // read into hub memory just to be refused afterwards.
  if (typeof file.size === 'number' && file.size > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json(
      { error: `file too large (${fmtBytes(file.size)} > ${fmtBytes(MAX_ATTACHMENT_BYTES)})` },
      { status: 413 },
    );
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const att = await createAttachment(sess, v, {
      name: file.name || 'file',
      mime: file.type || '',
      bytes,
    });
    return NextResponse.json({ attachment: toPayload(att) });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    // "too large" is the client's fault (413); anything else is an upload
    // failure the user needs the real reason for (ssh down, disk full, cwd
    // gone) — surfaced verbatim into the toast.
    const status = /too large/i.test(msg) ? 413 : 500;
    if (status === 500) {
      // eslint-disable-next-line no-console
      console.error(`[api/claude/sessions/${id}/attachments POST] failed:`, e?.stack ?? e);
    }
    return NextResponse.json({ error: msg }, { status });
  }
}
