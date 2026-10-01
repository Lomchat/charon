'use client';
import { useMemo, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { FS_UPLOAD_CHUNK_BYTES, joinRel } from '@/lib/fsUpload';
import { publishFsChanged } from './fsChangeBus';
import type { UploadPlan } from './fileDropZones';

/**
 * Uploads dropped onto the explorer (app/fileDropZones.ts), one queue per VPS.
 *
 * Module state, not component state: the tree REMOUNTS when a file opens
 * (the panel beside the editor is another instance), and a progress bar that
 * vanishes with it would look like a cancelled upload that is in fact still
 * running. Keyed by workspace so each tree shows only its own.
 *
 * Serial per VPS on purpose: every file is one ssh channel on a multiplex
 * that sshd caps, and one file at a time is also what makes the progress line
 * readable. Each landed file is announced on the fs-change bus, so every open
 * tree of that machine re-lists the folder without polling.
 */
export type UploadJob = {
  id: string;
  vpsId: string;
  root: string;
  /** Destination folder, relative to `root` ('' = the root itself). */
  targetDir: string;
  /** "photo.png" / "3 items" — what the user dropped. */
  label: string;
  status: 'queued' | 'running' | 'done' | 'cancelled';
  totalBytes: number;
  sentBytes: number;
  fileCount: number;
  filesDone: number;
  /** Dropped files the user chose to keep as they were ("skip existing"). */
  skipped: number;
  /** Root-relative path of the file in flight. */
  current: string | null;
  /** Root-relative paths that could not be written, with the reason. */
  errors: { path: string; error: string }[];
  /** Root-relative paths of the dropped items that now exist. */
  landed: string[];
};

type Internal = UploadJob & {
  plan: UploadPlan;
  mkdirs: string[];
  overwrite: Set<string>;
  skip: Set<string>;
  abort: AbortController;
  uploadId: string | null;
};

const g = globalThis as unknown as { __charonFsUploadJobs?: Map<string, Internal> };
const jobs = (g.__charonFsUploadJobs ??= new Map<string, Internal>());
const subs = new Set<() => void>();
const chains = new Map<string, Promise<void>>();
let snapshot: UploadJob[] = [];
const DONE_LINGER_MS = 5000;

function publish() {
  snapshot = [...jobs.values()].map((j) => {
    const { plan: _p, mkdirs: _m, overwrite: _o, skip: _s, abort: _a, uploadId: _u, ...pub } = j;
    return { ...pub, errors: [...pub.errors], landed: [...pub.landed] };
  });
  for (const cb of subs) cb();
}

function subscribe(cb: () => void) {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

export function useUploadJobs(vpsId: string | null, root: string | null): UploadJob[] {
  const all = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return useMemo(() => all.filter((j) => j.vpsId === vpsId && j.root === root), [all, vpsId, root]);
}

const abs = (root: string, rel: string) => `${root.replace(/\/+$/, '')}/${rel}`;

async function run(j: Internal): Promise<void> {
  if (j.status === 'cancelled') return;
  // A function, not an inline test: cancelUploadJob flips the status from
  // outside while this awaits, which TypeScript's narrowing cannot see.
  const cancelled = () => j.status === 'cancelled';
  j.status = 'running';
  publish();
  const target = (rel: string) => joinRel(j.targetDir, rel);
  const failedDirs: string[] = [];
  const blocked = (rel: string) => failedDirs.some((d) => rel === d || rel.startsWith(`${d}/`));

  for (const dir of j.mkdirs) {
    if (cancelled()) break;
    if (blocked(dir)) continue;
    try {
      const r = await api.fsOp(j.vpsId, { root: j.root, op: 'mkdir', path: target(dir) });
      if (!r.ok && r.reason !== 'exists') throw new Error(r.error ?? 'could not create the folder');
      publishFsChanged(j.vpsId, [abs(j.root, target(dir))]);
    } catch (e: unknown) {
      failedDirs.push(dir);
      j.errors.push({ path: target(dir), error: e instanceof Error ? e.message : String(e) });
      publish();
    }
  }

  for (const { rel, file } of j.plan.files) {
    if (cancelled()) break;
    if (j.skip.has(rel)) continue;
    const path = target(rel);
    if (blocked(rel)) {
      j.errors.push({ path, error: 'its folder could not be created' });
      continue;
    }
    j.current = path;
    publish();
    const before = j.sentBytes;
    try {
      const begun = await api.fsUpload(j.vpsId, {
        op: 'begin', root: j.root, path, size: file.size, overwrite: j.overwrite.has(rel),
      });
      if (!begun.ok) throw new Error(begun.error ?? 'the VPS refused the upload');
      let done = !!begun.done;
      if (!done) {
        j.uploadId = begun.uploadId ?? null;
        for (let offset = 0; offset < file.size;) {
          if (cancelled() || !j.uploadId) throw new Error('cancelled');
          const chunk = file.slice(offset, offset + FS_UPLOAD_CHUNK_BYTES);
          const r = await api.fsUploadChunk(j.vpsId, j.uploadId, offset, chunk, { signal: j.abort.signal });
          if (!r.ok) throw new Error(r.error ?? 'upload failed');
          offset = r.received ?? offset + chunk.size;
          j.sentBytes = before + offset;
          done = !!r.done;
          publish();
        }
        j.uploadId = null;
      }
      if (!done) throw new Error('the VPS did not confirm the file');
      j.filesDone++;
      publishFsChanged(j.vpsId, [abs(j.root, path)]);
    } catch (e: unknown) {
      j.sentBytes = before + file.size;  // the bar measures the job, not luck
      if (j.uploadId) void api.fsUploadCancel(j.vpsId, j.uploadId).catch(() => {});
      j.uploadId = null;
      if (cancelled()) break;
      j.errors.push({ path, error: e instanceof Error ? e.message : String(e) });
    }
    publish();
  }

  j.current = null;
  const failed = new Set(j.errors.map((x) => x.path));
  j.landed = j.plan.top.filter((t) => !j.skip.has(t) && !failed.has(target(t))).map(target);
  if (!cancelled()) j.status = 'done';
  // Once more for the folders themselves: the per-file announcements can be
  // absorbed by a listing that was already in flight.
  publishFsChanged(j.vpsId, j.plan.top.map((t) => abs(j.root, target(t))));
  publish();
  if (!cancelled() && !j.errors.length) {
    setTimeout(() => { if (jobs.delete(j.id)) publish(); }, DONE_LINGER_MS);
  }
}

/**
 * Queue a drop. `overwrite` / `skip` hold TARGET-relative file paths the user
 * already decided about; `mkdirs` the folders that do not exist yet.
 */
export function enqueueUpload(spec: {
  vpsId: string; root: string; targetDir: string; plan: UploadPlan;
  mkdirs: string[]; overwrite?: Set<string>; skip?: Set<string>;
  /** Refusals already known from the check (a file where a folder must go). */
  errors?: { path: string; error: string }[];
}): string {
  const skip = spec.skip ?? new Set<string>();
  const files = spec.plan.files.filter((f) => !skip.has(f.rel));
  // Refused files are reported as errors already; only a CHOICE counts here.
  const refused = new Set((spec.errors ?? []).map((e) => e.path));
  const skipped = spec.plan.files.filter((f) =>
    skip.has(f.rel) && !refused.has(joinRel(spec.targetDir, f.rel))).length;
  const id = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const j: Internal = {
    id, vpsId: spec.vpsId, root: spec.root, targetDir: spec.targetDir,
    label: spec.plan.top.length === 1 ? spec.plan.top[0] : `${spec.plan.top.length} items`,
    status: 'queued',
    totalBytes: files.reduce((n, f) => n + f.file.size, 0),
    sentBytes: 0, fileCount: files.length, filesDone: 0, skipped, current: null,
    errors: [...(spec.errors ?? [])], landed: [],
    plan: spec.plan, mkdirs: spec.mkdirs, overwrite: spec.overwrite ?? new Set(), skip,
    abort: new AbortController(), uploadId: null,
  };
  jobs.set(id, j);
  publish();
  const prev = chains.get(spec.vpsId) ?? Promise.resolve();
  const next = prev.then(() => run(j)).catch(() => {});
  chains.set(spec.vpsId, next);
  return id;
}

export function cancelUploadJob(id: string): void {
  const j = jobs.get(id);
  if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
  j.status = 'cancelled';
  j.abort.abort();
  if (j.uploadId) void api.fsUploadCancel(j.vpsId, j.uploadId).catch(() => {});
  publish();
}

export function dismissUploadJob(id: string): void {
  const j = jobs.get(id);
  if (!j || j.status === 'running' || j.status === 'queued') return;
  jobs.delete(id);
  publish();
}
