import 'server-only';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Vps } from '@/lib/db';
import { buildAgentFileReceiveSshArgs } from '@/lib/server/agent/sshShared.js';
import { receiveExitReason, type FsUploadReason } from '@/lib/fsUpload';
import { sshKeyArgs } from './sshExec';

// Explorer drops: one live `charon-agent --receive-file` ssh channel per file,
// held here between the browser's chunk PUTs (lib/fsUpload.ts says why the
// bytes arrive in chunks). The channel is the transaction: killing it —
// cancel, idle timeout, hub restart — hands the remote receiver a short
// stdin, and it deletes its temp file without committing anything.

/** The receiver prints `ready` once every refusal has been decided. */
const READY_TIMEOUT_MS = 20_000;
/** A browser that stopped sending (tab closed, laptop asleep). */
const IDLE_TIMEOUT_MS = 90_000;
/** fsync + rename of the last chunk, on a slow disk. */
const COMMIT_TIMEOUT_MS = 120_000;
/** Each upload is one more channel on the VPS's ssh multiplex, which sshd caps
 *  (MaxSessions, 10 by default) alongside the agent pipe and open shells. */
const MAX_UPLOADS_PER_VPS = 4;

type Upload = {
  id: string;
  vpsId: string;
  root: string;
  size: number;
  received: number;
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
  closed: Promise<number | null>;
  idle: ReturnType<typeof setTimeout> | null;
  busy: boolean;
};

export type FsUploadResult =
  | { ok: true; uploadId?: string; received?: number; done?: boolean; root?: string }
  | { ok: false; reason: FsUploadReason; error: string; received?: number };

// On globalThis: route modules can be separate copies (§14.62), and a chunk
// must find the channel its `begin` opened.
const g = globalThis as unknown as { __charonFsUploads?: Map<string, Upload> };
const uploads = (g.__charonFsUploads ??= new Map<string, Upload>());

function failure(code: number | null, stderr: string, fallback: string): FsUploadResult {
  const lines = stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    ok: false,
    reason: receiveExitReason(code),
    error: (lines.slice(-2).join(' ') || fallback).slice(0, 300),
  };
}

function drop(u: Upload): void {
  uploads.delete(u.id);
  if (u.idle) clearTimeout(u.idle);
  u.idle = null;
}

function armIdle(u: Upload): void {
  if (u.idle) clearTimeout(u.idle);
  u.idle = setTimeout(() => {
    drop(u);
    u.child.kill('SIGTERM');
  }, IDLE_TIMEOUT_MS);
  u.idle.unref?.();
}

/** End stdin and wait for the receiver's verdict on the commit. */
async function finish(u: Upload): Promise<FsUploadResult> {
  drop(u);
  u.child.stdin.end();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const code = await Promise.race([
    u.closed,
    new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), COMMIT_TIMEOUT_MS); }),
  ]);
  if (timer) clearTimeout(timer);
  if (code === 'timeout') {
    u.child.kill('SIGTERM');
    return { ok: false, reason: 'error', error: 'the VPS did not confirm the file in time' };
  }
  if (code === 0) return { ok: true, done: true, received: u.size, root: u.root };
  return failure(code, u.stderr(), `upload failed (exit ${code})`);
}

/**
 * Open the channel and wait for `ready`. Every refusal the agent can make up
 * front (exists, folder, missing parent, outside the root) comes back HERE,
 * before the browser has sent a byte. A zero-byte file commits immediately.
 */
export async function beginUpload(
  v: Vps,
  spec: { root: string; path: string; size: number; overwrite: boolean },
): Promise<FsUploadResult> {
  let live = 0;
  for (const u of uploads.values()) if (u.vpsId === v.id) live++;
  if (live >= MAX_UPLOADS_PER_VPS) {
    return { ok: false, reason: 'error', error: 'too many uploads to this VPS at once — wait for one to finish' };
  }

  let args: string[];
  try {
    args = buildAgentFileReceiveSshArgs(
      v, { root: spec.root, path: spec.path, length: spec.size, overwrite: spec.overwrite },
      { keyPath: sshKeyArgs()[1] },
    );
  } catch (e: unknown) {
    return { ok: false, reason: 'bad_path', error: e instanceof Error ? e.message : String(e) };
  }
  const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
  });
  // EPIPE once the receiver has refused or died; its exit code is the answer.
  child.stdin.on('error', () => {});
  const closed = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', (e) => { stderr += e.message; resolve(null); });
  });

  const outcome = await new Promise<'ready' | 'closed' | 'timeout'>((resolve) => {
    let out = '';
    const settle = (value: 'ready' | 'closed' | 'timeout') => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      // A whole LINE, anywhere: a chatty login shell may print before it.
      out = (out + chunk.toString('utf8')).slice(-4096);
      if (out.split('\n').slice(0, -1).some((line) => line.trim() === 'ready')) settle('ready');
    };
    const timer = setTimeout(() => settle('timeout'), READY_TIMEOUT_MS);
    child.stdout.on('data', onData);
    void closed.then(() => settle('closed'));
  });
  // Keep stdout flowing: a paused pipe would eventually stall the receiver.
  child.stdout.resume();

  if (outcome !== 'ready') {
    if (outcome === 'timeout') child.kill('SIGTERM');
    const code = outcome === 'timeout' ? null : await closed;
    return failure(
      code, stderr,
      outcome === 'timeout' ? 'the VPS did not accept the upload in time' : 'the VPS refused the upload',
    );
  }

  const u: Upload = {
    id: randomUUID(), vpsId: v.id, root: spec.root, size: spec.size, received: 0,
    child, stderr: () => stderr, closed, idle: null, busy: false,
  };
  if (spec.size === 0) return finish(u);
  uploads.set(u.id, u);
  armIdle(u);
  return { ok: true, uploadId: u.id };
}

/**
 * Feed one chunk. Offsets are strict so a retried PUT can never write the
 * same bytes twice: a replay of the chunk that was already accepted is
 * acknowledged, anything else is refused with the offset the hub expects.
 */
export async function writeUploadChunk(
  vpsId: string, uploadId: string, offset: number, bytes: Buffer,
): Promise<FsUploadResult> {
  const u = uploads.get(uploadId);
  if (!u || u.vpsId !== vpsId) {
    return { ok: false, reason: 'gone', error: 'this upload is no longer running — drop the file again' };
  }
  if (u.busy) return { ok: false, reason: 'error', error: 'a chunk is already being written', received: u.received };
  if (offset + bytes.length === u.received && offset < u.received) return { ok: true, received: u.received };
  if (offset !== u.received) {
    return { ok: false, reason: 'error', error: `expected offset ${u.received}, got ${offset}`, received: u.received };
  }
  if (u.received + bytes.length > u.size) {
    return { ok: false, reason: 'error', error: 'more bytes than the announced size', received: u.received };
  }

  u.busy = true;
  if (u.idle) clearTimeout(u.idle);
  try {
    // The write callback fires once the bytes are in the pipe — that is the
    // backpressure the browser waits on before sending the next chunk.
    const written = await Promise.race([
      new Promise<boolean>((resolve) => { u.child.stdin.write(bytes, (err) => resolve(!err)); }),
      u.closed.then(() => false),
    ]);
    if (!written) {
      drop(u);
      const code = await u.closed;
      return failure(code, u.stderr(), 'the upload channel closed');
    }
    u.received += bytes.length;
    if (u.received === u.size) return await finish(u);
    return { ok: true, received: u.received };
  } finally {
    u.busy = false;
    if (uploads.has(u.id)) armIdle(u);
  }
}

/** Cancel: the receiver sees a short stdin and deletes its temp file. */
export function cancelUpload(vpsId: string, uploadId: string): boolean {
  const u = uploads.get(uploadId);
  if (!u || u.vpsId !== vpsId) return false;
  drop(u);
  u.child.kill('SIGTERM');
  return true;
}
