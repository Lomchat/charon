import 'server-only';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import type { Vps } from '@/lib/db';
import {
  buildAgentFileStreamSshArgs, buildAgentZipStreamSshArgs,
} from '@/lib/server/agent/sshShared.js';
import { sshKeyArgs } from '@/lib/server/hub/sshExec';

// The dedicated SSH byte channel shared by the file route (downloads, inline
// media) and the live-view route (§14.110). One home, so both keep the same
// first-chunk gate and backpressure.

/** First agent that streams file bytes on their own SSH channel. */
export const FILE_STREAM_AGENT_VERSION = '0.77.0';
const STREAM_START_TIMEOUT_MS = 20_000;

/**
 * Start the dedicated SSH byte channel and wait for its first chunk before
 * committing HTTP 200/206. That turns SSH/auth/old-agent failures into a
 * useful 502 instead of Chrome's opaque "file unavailable" after headers.
 * The async-iterator bridge preserves Node stream backpressure end-to-end.
 */
async function openRemoteSshStream(
  req: Request,
  v: Vps,
  args: string[],
): Promise<
  | { ok: true; body: ReadableStream<Uint8Array> }
  | { ok: false; error: string }
> {
  const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
  });
  const abort = () => { if (child.exitCode == null) child.kill('SIGTERM'); };
  req.signal.addEventListener('abort', abort, { once: true });

  const iterator = child.stdout[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const first = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('download stream did not start in time')), STREAM_START_TIMEOUT_MS);
      }),
      new Promise<never>((_, reject) => {
        child.once('error', (e) => reject(e));
      }),
    ]);
    if (first.done) {
      const code = await new Promise<number | null>((resolve) => {
        if (child.exitCode != null) resolve(child.exitCode);
        else child.once('close', resolve);
      });
      req.signal.removeEventListener('abort', abort);
      return { ok: false, error: (stderr.trim() || `ssh stream exited ${code}`).slice(0, 300) };
    }

    let stdoutEnded = false;
    child.stdout.once('end', () => { stdoutEnded = true; });
    const source = Readable.from((async function* () {
      yield first.value as Buffer;
      for await (const chunk of iterator) yield chunk as Buffer;
      const code = child.exitCode ?? await new Promise<number | null>((resolve) => {
        child.once('close', resolve);
      });
      if (code !== 0) {
        throw new Error(stderr.trim() || `ssh stream exited ${code}`);
      }
    })());
    source.once('close', () => {
      // Cancellation destroys the adapter. Stop SSH so the remote process
      // does not continue reading gigabytes nobody will receive.
      if (!stdoutEnded && child.exitCode == null) child.kill('SIGTERM');
    });
    child.once('close', (code) => {
      req.signal.removeEventListener('abort', abort);
      if (code !== 0 && !req.signal.aborted) {
        console.error(`[fs/download ${v.id}] ssh exited ${code}: ${stderr.trim().slice(0, 300)}`);
      }
    });
    return { ok: true, body: Readable.toWeb(source) as ReadableStream<Uint8Array> };
  } catch (e: unknown) {
    abort();
    req.signal.removeEventListener('abort', abort);
    return {
      ok: false,
      error: `${e instanceof Error ? e.message : String(e)}${stderr.trim() ? `: ${stderr.trim()}` : ''}`.slice(0, 300),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function openRemoteFileStream(
  req: Request,
  v: Vps,
  spec: { root: string; path: string; offset: number; length: number; expectedVersion: string | null },
) {
  try {
    return await openRemoteSshStream(
      req, v,
      buildAgentFileStreamSshArgs(v, spec, { keyPath: sshKeyArgs()[1] }),
    );
  } catch (e: unknown) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function openRemoteZipStream(req: Request, v: Vps, root: string, path: string) {
  try {
    return await openRemoteSshStream(
      req, v,
      buildAgentZipStreamSshArgs(v, { root, path }, { keyPath: sshKeyArgs()[1] }),
    );
  } catch (e: unknown) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}
