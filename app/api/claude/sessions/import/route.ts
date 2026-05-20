import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable, claudeSessionMessages, claudeSessionLogs } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { importExistingSession } from '@/lib/server/agent/sessionOps';
import { importJsonlMessages } from '@/lib/server/claude/importJsonl';

// POST /api/claude/sessions/import
// Body: { vpsId, claudeSessionId, cwd, name?, permissionMode? }
//
// 1. Creates a claude_sessions row with status='sleeping' and the claudeSessionId
// 2. Fetches the .jsonl from the VPS and inserts the historical messages in DB
//    -> the chat displays the history immediately after import
// 3. On a later resume, the agent calls start_session(claude_session_id=...)
//    which resumes the conversation on the SDK side so it can continue.
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

    // Fetch + insert messages (best-effort: if it fails, the session is
    // still importable, just without visible history).
    let importedCount = 0;
    let importError: string | undefined;
    try {
      const r = await importJsonlMessages(v, claudeSessionId);
      if (!r.ok) {
        importError = r.error;
      } else if (r.messages.length > 0) {
        // Bulk insert inside a transaction
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
