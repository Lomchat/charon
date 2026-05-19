import './claude.css';
import { db, vps as vpsTable, vpsFolders as vpsFoldersTable, vpsPaths as vpsPathsTable, claudeSessions } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { asc, desc } from 'drizzle-orm';
import ClaudePanel from './ClaudePanel';
import { getBuiltPyzSha } from '@/lib/server/agent/builtPyzSha';

export const dynamic = 'force-dynamic';

export default async function CharonPage() {
  await requireSession();
  seedInitialData();

  // Folders triés par position (drag-and-drop persistant).
  const folderRows = db.select().from(vpsFoldersTable)
    .orderBy(asc(vpsFoldersTable.position), asc(vpsFoldersTable.createdAt))
    .all();
  // VPS triés par position dans leur folder ; le rendu sidebar groupe par folderId
  // et l'ordre intra-folder est conservé.
  const vpsRows = db.select().from(vpsTable).orderBy(asc(vpsTable.position)).all();
  const pathRows = db.select().from(vpsPathsTable).all();
  const sessionRows = db.select().from(claudeSessions)
    .orderBy(desc(claudeSessions.createdAt), desc(claudeSessions.id))
    .all();
  const builtPyzSha = getBuiltPyzSha();

  return (
    <ClaudePanel
      vpsList={vpsRows}
      vpsFolders={folderRows}
      vpsPaths={pathRows}
      initialSessions={sessionRows}
      builtPyzSha={builtPyzSha}
    />
  );
}
