import { db, vps as vpsTable, vpsFolders as vpsFoldersTable, vpsPaths as vpsPathsTable, claudeSessions } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { asc, desc } from 'drizzle-orm';
import MobileSelect from './MobileSelect';

export const dynamic = 'force-dynamic';

export default async function MobileSelectPage() {
  await requireSession();
  seedInitialData();

  // Mobile partage la même organisation en dossiers que desktop. L'état
  // `collapsed` des dossiers est stocké en DB (`vps_folders.collapsed`) donc
  // un dossier fermé sur desktop est aussi fermé sur mobile, et vice-versa.
  // Le collapse par-VPS reste local (localStorage), comme sur desktop.
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
