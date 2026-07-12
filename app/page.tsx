import './claude.css';
import { db, vps as vpsTable, vpsFolders as vpsFoldersTable, vpsPaths as vpsPathsTable, claudeSessions } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { asc, desc } from 'drizzle-orm';
import ClaudePanel from './ClaudePanel';
import { getBuiltPyzSha } from '@/lib/server/agent/builtPyzSha';
import { getSdkLatestVersion, refreshSdkLatestIfStale } from '@/lib/server/claude/sdkSync';

export const dynamic = 'force-dynamic';

export default async function CharonPage() {
  await requireSession();
  seedInitialData();

  // Folders sorted by position (persistent drag-and-drop).
  const folderRows = db.select().from(vpsFoldersTable)
    .orderBy(asc(vpsFoldersTable.position), asc(vpsFoldersTable.createdAt))
    .all();
  // VPSes sorted by position within their folder; the sidebar render groups
  // by folderId and the intra-folder order is preserved.
  const vpsRows = db.select().from(vpsTable).orderBy(asc(vpsTable.position)).all();
  const pathRows = db.select().from(vpsPathsTable).all();
  const sessionRows = db.select().from(claudeSessions)
    .orderBy(desc(claudeSessions.createdAt), desc(claudeSessions.id))
    .all();
  const builtPyzSha = getBuiltPyzSha();
  // Latest claude-agent-sdk on PyPI (settings cache) → sidebar SDK-outdated
  // badges. Kick a background refresh when stale (12h TTL, fire-and-forget).
  const sdkLatestVersion = getSdkLatestVersion();
  refreshSdkLatestIfStale();

  return (
    <ClaudePanel
      vpsList={vpsRows}
      vpsFolders={folderRows}
      vpsPaths={pathRows}
      initialSessions={sessionRows}
      builtPyzSha={builtPyzSha}
      sdkLatestVersion={sdkLatestVersion}
    />
  );
}
