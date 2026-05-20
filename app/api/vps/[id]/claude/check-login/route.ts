import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshExec } from '@/lib/server/claude/sshExec';

export const runtime = 'nodejs';

// POST /api/vps/[id]/claude/check-login
// Re-vérifie via SSH si l'utilisateur a un `claude login` valide sur ce VPS.
// Persiste le résultat dans `vps.claude_logged_in` (1=oui, 0=non). Utilisé
// par la sidebar (masque le bouton "claude login" quand inutile) et déclenché
// automatiquement quand l'utilisateur ferme LoginConsole.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  // PATH étendu (cf. bootstrap.ts § check_login pour le contexte).
  const r = await sshExec(
    v,
    'PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"; ' +
    'claude config get oauth.refresh_token 2>/dev/null > /dev/null && echo OK || echo MISSING',
    { timeoutMs: 8_000 },
  );
  // Si SSH plante on ne touche pas la valeur — on ne sait pas. L'UI gardera
  // la valeur précédente (potentiellement stale, c'est OK).
  if (!r.ok && !r.stdout) {
    return NextResponse.json({
      ok: false,
      error: r.stderr.slice(-200) || `exit ${r.code}`,
      loggedIn: v.claudeLoggedIn === 1,
      checkedAt: v.claudeLoggedInCheckedAt,
    });
  }
  const loggedIn = r.stdout.includes('OK');
  const checkedAt = Math.floor(Date.now() / 1000);
  try {
    db.update(vpsTable).set({
      claudeLoggedIn: loggedIn ? 1 : 0,
      claudeLoggedInCheckedAt: checkedAt,
    }).where(eq(vpsTable.id, id)).run();
  } catch {}
  return NextResponse.json({ ok: true, loggedIn, checkedAt });
}
