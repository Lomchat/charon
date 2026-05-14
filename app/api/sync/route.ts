import { NextResponse } from 'next/server';
import { db, vps, projects, vpsProjectPaths } from '@/lib/db';
import { eq, and } from 'drizzle-orm';

// POST /api/sync — réception du sync hub → heimdall.
// Auth : Authorization: Bearer <SYNC_TOKEN> (env partagé entre hub et heimdall).
// Payload : { vps?: VpsRow[], projects?: ProjectRow[], vpsProjectPaths?: PathRow[] }.
// Stratégie : upsert par id pour vps/projects (les rows heimdall-only sont
// préservées) ; pour les paths, on insert si (vps_id, project_id, path)
// n'existe pas déjà — pas de delete, donc les paths ajoutés à la main
// côté heimdall sont eux aussi préservés.

type VpsRow = {
  id: string;
  name: string;
  ip: string;
  sshUser: string;
  sshPort?: number;
  defaultPath?: string | null;
  createdAt?: number;
};

type ProjectRow = {
  id: string;
  name: string;
  glyph?: string;
  colorToken?: string;
  url?: string | null;
  createdAt?: number;
};

type PathRow = {
  vpsId: string;
  projectId: string;
  path: string;
};

function checkAuth(req: Request): boolean {
  const expected = process.env.SYNC_TOKEN;
  if (!expected) return false;
  const header = req.headers.get('authorization');
  if (!header) return false;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return false;
  // timing-safe equality
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: Request) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { vps?: VpsRow[]; projects?: ProjectRow[]; vpsProjectPaths?: PathRow[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const inVps = Array.isArray(body.vps) ? body.vps : [];
  const inProjects = Array.isArray(body.projects) ? body.projects : [];
  const inPaths = Array.isArray(body.vpsProjectPaths) ? body.vpsProjectPaths : [];

  const counts = { vps: 0, projects: 0, paths: 0, pathsSkipped: 0 };

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

    for (const p of inProjects) {
      if (!p?.id || !p?.name) continue;
      const row = {
        id: String(p.id),
        name: String(p.name),
        glyph: p.glyph ? String(p.glyph) : '◆',
        colorToken: p.colorToken ? String(p.colorToken) : 'gold',
        url: p.url ? String(p.url) : null,
        ...(typeof p.createdAt === 'number' ? { createdAt: p.createdAt } : {})
      };
      tx.insert(projects).values(row).onConflictDoUpdate({
        target: projects.id,
        set: { name: row.name, glyph: row.glyph, colorToken: row.colorToken, url: row.url }
      }).run();
      counts.projects += 1;
    }

    // Paths : pas de PK utile pour upsert (id autoincrement), on dédoublonne
    // sur le triplet (vps_id, project_id, path) avant insert.
    for (const r of inPaths) {
      if (!r?.vpsId || !r?.projectId || !r?.path) continue;
      const existing = tx.select().from(vpsProjectPaths)
        .where(and(
          eq(vpsProjectPaths.vpsId, String(r.vpsId)),
          eq(vpsProjectPaths.projectId, String(r.projectId)),
          eq(vpsProjectPaths.path, String(r.path))
        )).limit(1).all();
      if (existing.length > 0) {
        counts.pathsSkipped += 1;
        continue;
      }
      tx.insert(vpsProjectPaths).values({
        vpsId: String(r.vpsId),
        projectId: String(r.projectId),
        path: String(r.path)
      }).run();
      counts.paths += 1;
    }
  });

  return NextResponse.json({ ok: true, counts });
}
