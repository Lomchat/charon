import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { appendScanPage, continuationQuery } from '@/app/resumeScan';
import type { ScannedCodexSession } from '@/lib/types/api';

function row(sessionId: string, cwd: string): ScannedCodexSession {
  return {
    sessionId, cwd, aiTitle: '', lastPrompt: '', firstUserText: '',
    messageCount: 0, model: '', gitBranch: '', mtime: 0, size: 0,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('resume scan pagination', () => {
  it('sends both continuation and explicit-workspace queries to the scan route', async () => {
    const fetchMock = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify({ sessions: [] }))),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.scanVpsSessions('vps-1', 'cursor', {
      archived: true, after: '/srv/ninth project',
    });
    await api.scanVpsSessions('vps-1', 'cursor', { cwd: '/opt/chosen project' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/vps/vps-1/cursor/scan?archived=1&after=%2Fsrv%2Fninth+project',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/vps/vps-1/cursor/scan?cwd=%2Fopt%2Fchosen+project',
    );
  });

  it('feeds nextCwd back as after and accumulates pages without duplicates', () => {
    const first = {
      sessions: [row('a', '/p1'), row('shared', '/p2')],
      folders: ['/p1', '/p2', '/p9'],
      nextCwd: '/p9',
      truncated: true,
    };
    expect(continuationQuery(first)).toEqual({ after: '/p9' });

    const merged = appendScanPage(first, {
      sessions: [row('shared', '/p2'), row('b', '/p9')],
      folders: first.folders,
      truncated: false,
    });
    expect(merged.sessions.map((session) => session.sessionId)).toEqual(['a', 'shared', 'b']);
    expect(continuationQuery(merged)).toBeNull();
  });
});
