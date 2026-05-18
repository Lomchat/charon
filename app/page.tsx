import './claude.css';
import { db, vps as vpsTable, vpsPaths as vpsPathsTable, claudeSessions } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { desc } from 'drizzle-orm';
import ClaudePanel from './ClaudePanel';

export const dynamic = 'force-dynamic';

export default async function CharonPage() {
  await requireSession();
  seedInitialData();

  const vpsRows = db.select().from(vpsTable).all();
  const pathRows = db.select().from(vpsPathsTable).all();
  const sessionRows = db.select().from(claudeSessions)
    .orderBy(desc(claudeSessions.createdAt), desc(claudeSessions.id))
    .all();

  return (
    <ClaudePanel
      vpsList={vpsRows}
      vpsPaths={pathRows}
      initialSessions={sessionRows}
    />
  );
}
