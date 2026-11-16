import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { requireApiSession } from '@/lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/pdfjs/<kind>/<name> — the data files pdf.js loads at runtime
// (§14.110): CMaps for CJK text, the 14 standard fonts a PDF may reference
// without embedding, the wasm image decoders and the ICC profile. Served from
// the installed pdfjs-dist, so they always match the bundled worker; copying
// them into public/ would be one more thing to keep in sync by hand.

const DIRS: Record<string, RegExp> = {
  cmaps: /^[A-Za-z0-9][A-Za-z0-9._-]*\.bcmap$/,
  standard_fonts: /^[A-Za-z0-9][A-Za-z0-9._-]*\.(pfb|ttf)$/,
  // The scripting sandbox (quickjs) is deliberately absent: Charon never
  // enables PDF JavaScript.
  wasm: /^(jbig2|openjpeg|qcms)[A-Za-z0-9._-]*\.(wasm|js)$/,
  iccs: /^[A-Za-z0-9][A-Za-z0-9._-]*\.icc$/,
};

const MIME: Record<string, string> = {
  wasm: 'application/wasm', js: 'text/javascript; charset=utf-8', ttf: 'font/ttf',
};

export async function GET(_req: Request, { params }: { params: Promise<{ kind: string; name: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { kind, name } = await params;
  const allowed = DIRS[kind];
  if (!allowed || !allowed.test(name) || name.includes('..')) {
    return new Response('not found', { status: 404 });
  }
  const file = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', kind, name);
  let bytes: Buffer;
  try { bytes = await readFile(file); } catch {
    return new Response('not found', { status: 404 });
  }
  const ext = name.slice(name.lastIndexOf('.') + 1);
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': String(bytes.length),
      // Versioned by the deploy, not the URL: a day is plenty.
      'cache-control': 'private, max-age=86400',
    },
  });
}
