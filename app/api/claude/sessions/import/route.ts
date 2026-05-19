import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable, claudeSessionMessages, claudeSessionLogs } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { importExistingSession } from '@/lib/server/agent/sessionOps';
import { importJsonlMessages } from '@/lib/server/claude/importJsonl';

// POST /api/claude/sessions/import
// Body : { vpsId, claudeSessionId, cwd, name?, permissionMode? }
//
// 1. Crée un row claude_sessions en status='sleeping' avec le claudeSessionId
// 2. Fetch le .jsonl du VPS et insère les messages historiques en DB
//    → la chat affiche l'historique immédiatement après import
// 3. Au resume ultérieur, l'agent fait start_session(claude_session_id=...)
//    qui reprend la conversation côté SDK pour pouvoir continuer.
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();
  const vpsId = String(body.vpsId ?? '').trim();
  const claudeSessionId = String(body.claudeSessionId ?? '').trim();
  const cwd = String(body.cwd ?? '').trim();
  if (!vpsId || !claudeSessionId || !cwd) {
    return NextResponse.json({ error: 'vpsId, claudeSessionId, cwd required' }, { status: 400 });
  }

  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  try {
    const id = await importExistingSession({
      vpsId, cwd, claudeSessionId,
      name: body.name ? String(body.name) : null,
      permissionMode: (['normal', 'acceptEdits', 'auto', 'plan'] as const).includes(body.permissionMode)
        ? body.permissionMode
        : 'auto',
    });

    // Fetch + insert messages (best-effort : si ça échoue, la session est
    // quand même importable, juste sans historique visible).
    let importedCount = 0;
    let importError: string | undefined;
    try {
      const r = await importJsonlMessages(v, claudeSessionId);
      if (!r.ok) {
        importError = r.error;
      } else if (r.messages.length > 0) {
        // Bulk insert dans une transaction
        db.transaction((tx) => {
          for (const m of r.messages) {
            tx.insert(claudeSessionMessages).values({
              sessionId: id,
              role: m.role,
              content: m.content,
              ...(m.ts ? { createdAt: m.ts } : {}),
            }).run();
          }
        });
        importedCount = r.messages.length;
      }
      db.insert(claudeSessionLogs).values({
        sessionId: id, level: importError ? 'warn' : 'info', event: 'import_history',
        detail: JSON.stringify({ count: importedCount, error: importError }),
      }).run();
    } catch (e: any) {
      importError = e?.message ?? String(e);
      db.insert(claudeSessionLogs).values({
        sessionId: id, level: 'warn', event: 'import_history',
        detail: JSON.stringify({ error: importError }),
      }).run();
    }

    return NextResponse.json({
      id,
      messagesImported: importedCount,
      importError,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
