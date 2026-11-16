import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { fileToolCall, rootAndPath } from '@/lib/server/hub/fileToolsRpc';

export const dynamic = 'force-dynamic';

// POST /api/vps/[id]/fs/convert  { root, path, to: 'png' | 'pdf' }
//
// What a browser cannot decode, converted on the VPS (§14.112): images
// (TIFF, HEIC…) to PNG through Pillow — the PNG comes back inline — and
// Office documents to PDF through LibreOffice, cached by the agent, which
// answers the (root, path) of that PDF for the ordinary byte route.
// `reason: 'unavailable'` names the missing tool.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
  }
  const at = rootAndPath(body);
  if (!at || (body.to !== 'png' && body.to !== 'pdf')) {
    return NextResponse.json({ ok: false, error: 'root, path and to (png|pdf) are required' }, { status: 400 });
  }
  return fileToolCall(id, 'fs_convert', { ...at, to: body.to }, {
    // LibreOffice on a large deck is the slow case; its own limit is 120 s.
    timeoutMs: body.to === 'pdf' ? 150_000 : 60_000,
    map: (r) => {
      const { orig_width: origWidth, orig_height: origHeight, ...rest } = r;
      return { ...rest, origWidth, origHeight };
    },
  });
}
