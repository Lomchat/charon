import type { ScanVpsSessionsQuery, ScanVpsSessionsResponse, ScannedSession } from '@/lib/types/api';

/** Normalize one scan response before it enters ResumeModal's cache. */
export function scanPage(response: ScanVpsSessionsResponse): ScanVpsSessionsResponse {
  return {
    sessions: response.sessions ?? [],
    folders: response.folders,
    nextCwd: response.nextCwd,
    truncated: response.truncated === true,
  };
}

/** Append a workspace page without duplicating agents seen in another cwd. */
export function appendScanPage(
  current: ScanVpsSessionsResponse | undefined,
  response: ScanVpsSessionsResponse,
): ScanVpsSessionsResponse {
  if (!current) return scanPage(response);
  const sessions: ScannedSession[] = [...current.sessions];
  const seen = new Set(sessions.map((row) => row.sessionId));
  for (const row of response.sessions ?? []) {
    if (seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    sessions.push(row);
  }
  return {
    sessions,
    folders: response.folders ?? current.folders,
    nextCwd: response.nextCwd,
    truncated: response.truncated === true,
  };
}

/** The server's cursor is inclusive: send nextCwd back as `after`. */
export function continuationQuery(
  page: ScanVpsSessionsResponse | undefined,
): Pick<ScanVpsSessionsQuery, 'after'> | null {
  return page?.truncated && page.nextCwd ? { after: page.nextCwd } : null;
}
