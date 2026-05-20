import { asc, eq } from 'drizzle-orm';
import { db, claudeSessions, claudeSessionMessages } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

// GET /api/claude/sessions/[id]/export
// Returns the transcript in markdown (text/markdown).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [sess] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!sess) return new Response('session not found', { status: 404 });
  const messages = db.select().from(claudeSessionMessages)
    .where(eq(claudeSessionMessages.sessionId, id))
    .orderBy(asc(claudeSessionMessages.id))
    .all();

  const lines: string[] = [];
  lines.push(`# Session ${sess.name ?? sess.id}`);
  lines.push('');
  lines.push(`- **cwd**: \`${sess.cwd}\``);
  lines.push(`- **status**: ${sess.status}`);
  lines.push(`- **claudeSessionId**: ${sess.claudeSessionId ?? '—'}`);
  lines.push(`- **createdAt**: ${new Date((sess.createdAt ?? 0) * 1000).toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const m of messages) {
    const ts = new Date((m.createdAt ?? 0) * 1000).toISOString();
    if (m.role === 'user') {
      lines.push(`## 👤 user — _${ts}_`);
      lines.push('');
      lines.push(m.content);
    } else if (m.role === 'assistant') {
      lines.push(`## 🤖 assistant — _${ts}_`);
      lines.push('');
      lines.push(m.content);
    } else if (m.role === 'tool_use') {
      let p: any = null; try { p = JSON.parse(m.content); } catch {}
      lines.push(`### 🔧 tool_use \`${p?.name ?? '?'}\` — _${ts}_`);
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(p?.input ?? {}, null, 2));
      lines.push('```');
    } else if (m.role === 'tool_result') {
      lines.push(`### 📋 tool_result — _${ts}_`);
      lines.push('');
      lines.push('```');
      lines.push(m.content.slice(0, 6000));
      lines.push('```');
    } else if (m.role === 'edit_snapshot') {
      let p: any = null; try { p = JSON.parse(m.content); } catch {}
      if (p?.phase === 'after') {
        lines.push(`### 📝 edit \`${p.file_path}\` (after)`);
      }
    }
    lines.push('');
  }

  const md = lines.join('\n');
  const filename = `claude-${(sess.name ?? sess.id).replace(/[^a-zA-Z0-9._-]+/g, '_')}.md`;
  return new Response(md, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}
