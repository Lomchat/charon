import { requireApiSession } from '@/lib/server/session';
import { loopLagSnapshot } from '@/lib/server/perf/loopLag';
import { syncStats } from '@/lib/server/sync/syncBus';

// GET /api/perf — the hub's event-loop health in numbers (lib/server/perf/
// loopLag.ts): lag percentiles, stalls in the last hour and the ring of slow
// sections, whose labels may carry session ids; plus the sync bus (ring,
// rates, connections, resumes/resyncs — lib/server/sync/syncBus.ts).
// Authenticated like every /api/* route (the HTTP gate + the check below);
// /api/health, the public probe, stays as it is.
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  return Response.json(
    { loop: loopLagSnapshot(), sync: syncStats() },
    { headers: { 'cache-control': 'no-store' } },
  );
}

// POST /api/perf {frames} — a browser's long frames (app/perfReport.ts), one
// `[client-perf]` journal line each: the user's machine, not a probe's.
// Bounded: ≤ MAX_FRAMES per POST, ≤ LINES_PER_MIN lines a minute in all.
const MAX_FRAMES = 20;
const LINES_PER_MIN = 60;
const budget = { minute: 0, lines: 0 };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);
// Printable ASCII only, capped: these strings reach the journal verbatim.
const str = (v: unknown, max = 80) => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '?').slice(0, max) : '');

function browser(ua: string | null): string {
  const u = ua ?? '';
  const os = /Windows/.test(u) ? 'win' : /Android/.test(u) ? 'android' : /Mac OS/.test(u) ? 'mac' : /Linux/.test(u) ? 'linux' : '?';
  const v = /Chrome\/(\d+)/.exec(u)?.[1];
  return v ? `${os}/chrome${v}` : os;
}

export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  let frames: unknown;
  try { frames = (await req.json())?.frames; } catch { frames = null; }
  if (!Array.isArray(frames)) return Response.json({ error: 'frames: array' }, { status: 400 });
  const who = browser(req.headers.get('user-agent'));
  const minute = Math.floor(Date.now() / 60_000);
  if (budget.minute !== minute) { budget.minute = minute; budget.lines = 0; }
  for (const f of frames.slice(0, MAX_FRAMES) as Array<Record<string, unknown>>) {
    if (!f || typeof f !== 'object' || budget.lines >= LINES_PER_MIN) break;
    budget.lines += 1;
    const at = new Date(num(f.at)).toTimeString().slice(0, 8);   // the journal's clock
    const scripts = (Array.isArray(f.scripts) ? f.scripts.slice(0, 3) : [])
      .map((x: Record<string, unknown>) => `${str(x?.inv, 60)} ${str(x?.src)}${x?.fn ? ` ${str(x.fn, 40)}` : ''} ${num(x?.ms)}ms${num(x?.layout) ? ` layout=${num(x?.layout)}` : ''}`)
      .join(' ; ');
    console.warn(`[client-perf] ${who} ${at} ${num(f.ms)}ms block=${num(f.block)} style=${num(f.style)} nodes=${num(f.nodes)} ${str(f.ctx, 40) || '-'} | ${scripts || 'no script'}`);
  }
  return Response.json({ ok: true });
}
