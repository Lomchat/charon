import { db, vps as vpsTable, vpsFolders as vpsFoldersTable, vpsPaths as vpsPathsTable, claudeSessions } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { asc, desc } from 'drizzle-orm';
import MobileSelect from './MobileSelect';

export const dynamic = 'force-dynamic';

export default async function MobileSelectPage() {
  await requireSession();
  seedInitialData();

  // Mobile shares the same folder organization as desktop. The folders'
  // `collapsed` state is stored in DB (`vps_folders.collapsed`) so a folder
  // closed on desktop is also closed on mobile, and vice-versa.
  // Per-VPS collapse stays local (localStorage), as on desktop.
  const vpsRows = db.select().from(vpsTable).orderBy(asc(vpsTable.position)).all();
  const folderRows = db.select().from(vpsFoldersTable)
    .orderBy(asc(vpsFoldersTable.position), asc(vpsFoldersTable.createdAt))
    .all();
  const pathRows = db.select().from(vpsPathsTable).all();
  const sessionRows = db.select().from(claudeSessions)
    .orderBy(desc(claudeSessions.createdAt), desc(claudeSessions.id))
    .all();

  return (
    <MobileSelect
      vpsList={vpsRows}
      vpsFolders={folderRows}
      vpsPaths={pathRows}
      initialSessions={sessionRows}
    />
  );
}
