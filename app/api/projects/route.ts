import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { desc } from 'drizzle-orm';
import { db, projects } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

const newId = () => crypto.randomBytes(8).toString('hex');

export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const rows = db.select().from(projects).orderBy(desc(projects.createdAt)).all();
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();
  const name = String(body.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  const row = {
    id: body.id ? String(body.id).trim() : newId(),
    name,
    glyph: body.glyph ? String(body.glyph).slice(0, 4) : '◆',
    colorToken: body.colorToken ? String(body.colorToken) : 'gold',
    url: body.url ? String(body.url).trim() || null : null
  };
  db.insert(projects).values(row).run();
  return NextResponse.json({ ...row, createdAt: Math.floor(Date.now() / 1000) });
}
