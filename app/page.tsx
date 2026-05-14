import './claude.css';
import { db, vps as vpsTable, projects as projectsTable, vpsProjectPaths, claudeSessions } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { desc } from 'drizzle-orm';
import ClaudePanel from './ClaudePanel';

export const dynamic = 'force-dynamic';

export type VpsProjectLink = { projectId: string; path: string | null };

export default async function CharonPage() {
  await requireSession();
  seedInitialData();

  const vpsRows = db.select().from(vpsTable).all();
  const projectRows = db.select().from(projectsTable).all();
  const sessionRows = db.select().from(claudeSessions)
    .orderBy(desc(claudeSessions.createdAt), desc(claudeSessions.id))
    .all();

  // vps → liste {projectId, path} depuis la table dédiée (remplace les
  // block_items 'vps' qui vivaient dans le hub avant la sortie).
  const pathsRows = db.select().from(vpsProjectPaths).all();
  const vpsLinks: Record<string, VpsProjectLink[]> = {};
  for (const row of pathsRows) {
    const arr = vpsLinks[row.vpsId] ?? [];
    arr.push({ projectId: row.projectId, path: row.path });
    vpsLinks[row.vpsId] = arr;
  }

  return (
    <ClaudePanel
      vpsList={vpsRows}
      projects={projectRows}
      initialSessions={sessionRows}
      vpsLinks={vpsLinks}
    />
  );
}
