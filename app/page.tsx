import './claude.css';
import { db, vps as vpsTable, vpsFolders as vpsFoldersTable, vpsPaths as vpsPathsTable, claudeSessions } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { asc, desc, eq } from 'drizzle-orm';
import ClaudePanel from './ClaudePanel';
import { listTabs } from '@/lib/server/claude/tabs';
import { getBuiltPyzSha, getBuiltAgentVersion } from '@/lib/server/agent/builtPyzSha';
import { getSdkLatestVersion, refreshSdkLatestIfStale, getCodexLatestVersion, refreshCodexLatestIfStale, getCodexCliLatestVersion, refreshCodexCliLatestIfStale } from '@/lib/server/claude/sdkSync';
import { compareVersions } from '@/lib/version';
import { SESSION_PEER_AGENT_VERSION } from '@/lib/sessionHandle';

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
  const sessionRowsRaw = db.select().from(claudeSessions)
    .where(eq(claudeSessions.archived, 0))
    .orderBy(desc(claudeSessions.createdAt), desc(claudeSessions.id))
    .all();
  const vpsById = new Map(vpsRows.map((v) => [v.id, v] as const));
  const sessionRows = sessionRowsRaw.map((r) => {
    const peerAgentReady = compareVersions(
      vpsById.get(r.vpsId)?.agentVersion, SESSION_PEER_AGENT_VERSION,
    ) >= 0;
    return {
      ...r,
      addressable: !!r.handle && peerAgentReady
        && ['starting', 'active', 'thinking', 'background', 'failed'].includes(r.status),
    };
  });
  const builtPyzSha = getBuiltPyzSha();
  // Version-ordered staleness baseline (§14.6) — the sha is display-only now.
  const builtAgentVersion = getBuiltAgentVersion();
  // Latest claude-agent-sdk on PyPI (settings cache) → sidebar SDK-outdated
  // badges. Kick a background refresh when stale (12h TTL, fire-and-forget).
  const sdkLatestVersion = getSdkLatestVersion();
  refreshSdkLatestIfStale();
  const codexLatestVersion = getCodexLatestVersion();
  const codexCliLatestVersion = getCodexCliLatestVersion();
  refreshCodexLatestIfStale();
  refreshCodexCliLatestIfStale();
  const initialTabs = listTabs();

  return (
    <ClaudePanel
      vpsList={vpsRows}
      vpsFolders={folderRows}
      vpsPaths={pathRows}
      initialSessions={sessionRows}
      builtPyzSha={builtPyzSha}
      builtAgentVersion={builtAgentVersion}
      sdkLatestVersion={sdkLatestVersion}
      codexLatestVersion={codexLatestVersion}
      codexCliLatestVersion={codexCliLatestVersion}
      initialTabs={initialTabs}
    />
  );
}
