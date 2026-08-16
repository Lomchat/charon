import './claude.css';
import { db, vps as vpsTable, vpsFolders as vpsFoldersTable, vpsPaths as vpsPathsTable, claudeSessions } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { asc, desc, eq } from 'drizzle-orm';
import ClaudePanel from './ClaudePanel';
import { listTabs } from '@/lib/server/claude/tabs';
import { cliNamesForVps } from '@/lib/server/claude/cliNames';
import { getBuiltPyzSha, getBuiltAgentVersion } from '@/lib/server/agent/builtPyzSha';
import { getSdkLatestVersion, refreshSdkLatestIfStale, getCodexLatestVersion, refreshCodexLatestIfStale } from '@/lib/server/claude/sdkSync';

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
  // The ADDRESSABLE name each session really has, on the FIRST paint.
  //
  // Without this the SSR snapshot has no `cliName` at all, so every @handle
  // renders as an unconfirmed prediction until a later list poll replaces the
  // whole array — and "the name is wrong for the first N seconds, then right"
  // is indistinguishable from "the name is wrong", which is exactly the bug
  // this feature exists to kill. Cached per VPS (60s), so this costs one RPC
  // per machine at most. §14.93
  const cliNamesByVps = new Map(await Promise.all(
    [...new Set(sessionRowsRaw.map((r) => r.vpsId))]
      .map(async (v) => [v, await cliNamesForVps(v)] as const)));
  const sessionRows = sessionRowsRaw.map((r) => ({
    ...r,
    cliName: cliNamesByVps.get(r.vpsId)?.get(r.id) ?? null,
  }));
  const builtPyzSha = getBuiltPyzSha();
  // Version-ordered staleness baseline (§14.6) — the sha is display-only now.
  const builtAgentVersion = getBuiltAgentVersion();
  // Latest claude-agent-sdk on PyPI (settings cache) → sidebar SDK-outdated
  // badges. Kick a background refresh when stale (12h TTL, fire-and-forget).
  const sdkLatestVersion = getSdkLatestVersion();
  refreshSdkLatestIfStale();
  const codexLatestVersion = getCodexLatestVersion();
  refreshCodexLatestIfStale();
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
      initialTabs={initialTabs}
    />
  );
}
