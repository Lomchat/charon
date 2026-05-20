import { NextResponse } from 'next/server';
import { db, vps, vpsPaths } from '@/lib/db';
import { eq, and } from 'drizzle-orm';

// POST /api/sync — ingest VPS + paths from an external source ("vps + paths"
// model). Originally used to migrate from a sibling deployment, but works as
// a generic upsert endpoint for anyone wanting to push VPS metadata into
// Charon without going through the UI.
//
// Auth: Authorization: Bearer <SYNC_TOKEN> (env-shared with the caller).
//
// Payload: { vps?: VpsRow[], vpsPaths?: VpsPathRow[] }
//
// - vps: upsert by id (rows that exist only locally are preserved).
// - vpsPaths: insert if (vps_id, path) is new; otherwise update the label
//   only if one is provided. No delete.

type VpsRow = {
  id: string;
  name: string;
  ip: string;
  sshUser: string;
  sshPort?: number;
  defaultPath?: string | null;
  createdAt?: number;
};

type VpsPathRow = {
  vpsId: string;
  path: string;
  label?: string | null;
};

function checkAuth(req: Request): boolean {
  const expected = process.env.SYNC_TOKEN;
  if (!expected) return false;
  const header = req.headers.get('authorization');
  if (!header) return false;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return false;
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: Request) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { vps?: VpsRow[]; vpsPaths?: VpsPathRow[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const inVps = Array.isArray(body.vps) ? body.vps : [];
  const inPaths = Array.isArray(body.vpsPaths) ? body.vpsPaths : [];

  const counts = { vps: 0, paths: 0, pathsUpdated: 0, pathsSkipped: 0 };

  db.transaction((tx) => {
    for (const v of inVps) {
      if (!v?.id || !v?.name || !v?.ip || !v?.sshUser) continue;
      const row = {
        id: String(v.id),
        name: String(v.name),
        ip: String(v.ip),
        sshUser: String(v.sshUser),
        sshPort: Number.isFinite(v.sshPort) && Number(v.sshPort) > 0 ? Math.floor(Number(v.sshPort)) : 22,
        defaultPath: v.defaultPath ? String(v.defaultPath) : null,
        ...(typeof v.createdAt === 'number' ? { createdAt: v.createdAt } : {})
      };
      tx.insert(vps).values(row).onConflictDoUpdate({
        target: vps.id,
        set: {
          name: row.name, ip: row.ip, sshUser: row.sshUser,
          sshPort: row.sshPort, defaultPath: row.defaultPath
        }
      }).run();
      counts.vps += 1;
    }

    // vpsPaths: no useful PK for upsert (id autoincrement), dedup
    // on (vps_id, path). If it exists and we receive a different label,
    // we just update the label.
    for (const r of inPaths) {
      if (!r?.vpsId || !r?.path) continue;
      const vpsId = String(r.vpsId);
      const path = String(r.path);
      const label = r.label != null && String(r.label).trim() !== ''
        ? String(r.label).trim() : null;
      const existing = tx.select().from(vpsPaths)
        .where(and(eq(vpsPaths.vpsId, vpsId), eq(vpsPaths.path, path)))
        .limit(1).all();
      if (existing.length > 0) {
        if (label != null && existing[0].label !== label) {
          tx.update(vpsPaths).set({ label })
            .where(eq(vpsPaths.id, existing[0].id)).run();
          counts.pathsUpdated += 1;
        } else {
          counts.pathsSkipped += 1;
        }
        continue;
      }
      tx.insert(vpsPaths).values({ vpsId, path, label }).run();
      counts.paths += 1;
    }
  });

  return NextResponse.json({ ok: true, counts });
}
