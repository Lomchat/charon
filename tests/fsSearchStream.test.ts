import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

// ── Streamed search (§14.84): the hits of `fs_search` arrive as the agent finds
// them, relayed by the route as NDJSON, read by `api.searchFsStream`.
//
// Pinned here: the route relays the agent's progress events under ITS search
// id and closes with one `done` line; the reader going away cancels the walk
// agent-side; an agent older than streaming (no events, everything in the
// answer) still reads as hits + done; and the reader copes with lines cut
// across network chunks and with a JSON refusal.

const call = vi.fn();
const listeners = new Map<string, (ev: unknown) => void>();
const client = {
  status: 'connected',
  call,
  onSearchProgress: (id: string, cb: (ev: unknown) => void) => {
    listeners.set(id, cb);
    return () => { listeners.delete(id); };
  },
};
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const tables = await import('@/lib/db/schema');
  const db = drizzle(new Database(':memory:'), { schema: tables });
  migrate(db, { migrationsFolder: './drizzle' });
  return { ...tables, db };
});
vi.mock('@/lib/server/agent/AgentClientPool', () => ({ getAgentClientForVpsId: () => client }));
vi.mock('@/lib/server/session', () => ({ requireApiSession: async () => ({ userId: 'u' }) }));

const { db, vps } = await import('@/lib/db');
const { POST } = await import('@/app/api/vps/[id]/fs/search/route');
const { api } = await import('@/lib/api');

db.insert(vps).values({ id: 'v1', name: 'V', ip: '192.0.2.1', sshUser: 'u' }).run();

const hit = (path: string) => ({ path, size: 1, mtime: 0, count: 1, matches: [] });

function post(body: unknown, signal?: AbortSignal) {
  return POST(new Request('http://hub/api/vps/v1/fs/search', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal,
  }), { params: Promise.resolve({ id: 'v1' }) });
}

async function lines(res: Response) {
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => { call.mockReset(); listeners.clear(); });

describe('the search route, streamed', () => {
  it('relays the progress events of ITS search, then one done line', async () => {
    call.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe('fs_search');
      const id = params.stream_id as string;
      expect(id).toMatch(/^[0-9a-f]{24}$/);
      listeners.get(id)!({ event: 'fs_search_progress', search_id: id, files: [hit('a.ts')], scanned: 10 });
      listeners.get(id)!({ event: 'fs_search_progress', search_id: id, files: [hit('b.ts')], scanned: 20 });
      return { ok: true, streamed: true, files: [], total_files: 2, total_matches: 2, scanned: 20, source: 'git' };
    });
    const res = await post({ root: '/srv/app', query: 'needle', mode: 'text', stream: true });
    expect(res.headers.get('content-type')).toContain('ndjson');
    const out = await lines(res);
    expect(out.map((l) => l.type)).toEqual(['files', 'files', 'done']);
    expect(out[0].files[0].path).toBe('a.ts');
    expect(out[1].scanned).toBe(20);
    expect(out[2]).toMatchObject({ ok: true, totalFiles: 2, source: 'git', files: [] });
    expect(listeners.size).toBe(0);
  });

  it('an agent older than streaming: its whole answer becomes one files line', async () => {
    call.mockResolvedValue({ ok: true, files: [hit('a.ts'), hit('b.ts')], total_files: 2 });
    const out = await lines(await post({ root: '/srv/app', query: 'x', mode: 'text', stream: true }));
    expect(out.map((l) => l.type)).toEqual(['files', 'done']);
    expect(out[0].files).toHaveLength(2);
  });

  it('the reader leaving cancels the walk on the VPS', async () => {
    let finish: (v: unknown) => void = () => {};
    call.mockImplementation((method: string) => (method === 'fs_search'
      ? new Promise((r) => { finish = r; })
      : Promise.resolve({ ok: true, found: true })));
    const ac = new AbortController();
    const res = await post({ root: '/srv/app', query: 'x', mode: 'text', stream: true }, ac.signal);
    ac.abort();
    await res.body?.cancel().catch(() => {});
    const cancel = call.mock.calls.find(([m]) => m === 'fs_search_cancel');
    const search = call.mock.calls.find(([m]) => m === 'fs_search');
    expect(cancel?.[1]).toEqual({ search_id: search?.[1].stream_id });
    finish({ ok: true, streamed: true, files: [], cancelled: true });
  });

  it('without `stream` the answer is the classic JSON', async () => {
    call.mockResolvedValue({ ok: true, files: [hit('a.ts')], total_files: 1 });
    const res = await post({ root: '/srv/app', query: 'x', mode: 'text' });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).files).toHaveLength(1);
    expect(call.mock.calls[0][1].stream_id).toBeUndefined();
  });
});

describe('api.searchFsStream', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function ndjsonResponse(chunks: string[]) {
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
    }), { headers: { 'content-type': 'application/x-ndjson' } });
  }

  it('reads lines cut anywhere across chunks', async () => {
    const files = JSON.stringify({ type: 'files', files: [hit('a.ts')], scanned: 5 });
    const done = JSON.stringify({ type: 'done', ok: true, files: [], totalFiles: 1 });
    const all = `${files}\n${done}\n`;
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse([all.slice(0, 7), all.slice(7, files.length + 3), all.slice(files.length + 3)])));
    const got: string[] = [];
    const r = await api.searchFsStream('v1', { root: '/r', query: 'q', mode: 'text' }, {
      signal: new AbortController().signal,
      onFiles: (f, n) => { got.push(...f.map((x) => x.path)); expect(n).toBe(5); },
    });
    expect(got).toEqual(['a.ts']);
    expect(r).toMatchObject({ ok: true, totalFiles: 1 });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
  });

  it('a JSON refusal (offline agent) is the answer as is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, reason: 'offline', files: [] })));
    const r = await api.searchFsStream('v1', { root: '/r', query: 'q', mode: 'text' }, {
      signal: new AbortController().signal, onFiles: () => { throw new Error('no hits expected'); },
    });
    expect(r).toMatchObject({ ok: false, reason: 'offline' });
  });

  it('a stream that ends without its done line says it was cut short', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse([JSON.stringify({ type: 'files', files: [] }) + '\n'])));
    const r = await api.searchFsStream('v1', { root: '/r', query: 'q', mode: 'text' }, {
      signal: new AbortController().signal, onFiles: () => {},
    });
    expect(r.ok).toBe(false);
  });
});
