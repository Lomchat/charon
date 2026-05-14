import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

const newId = () => crypto.randomBytes(8).toString('hex');

export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();

  const name = String(body.name ?? '').trim();
  const ip = String(body.ip ?? '').trim();
  const sshUser = String(body.sshUser ?? '').trim();
  if (!name || !ip || !sshUser) {
    return NextResponse.json({ error: 'name, ip, sshUser required' }, { status: 400 });
  }
  const sshPortRaw = Number(body.sshPort ?? 22);
  const sshPort = Number.isFinite(sshPortRaw) && sshPortRaw > 0 ? Math.floor(sshPortRaw) : 22;
  const defaultPath = body.defaultPath != null && String(body.defaultPath).trim() !== ''
    ? String(body.defaultPath).trim()
    : null;

  const row = { id: newId(), name, ip, sshUser, sshPort, defaultPath };
  db.insert(vps).values(row).run();
  return NextResponse.json({ ...row, createdAt: Math.floor(Date.now() / 1000) });
}
