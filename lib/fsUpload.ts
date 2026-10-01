// Dropping OS files onto the explorer: rules shared by the browser queue
// (app/fsUploadStore.ts) and its routes (app/api/vps/[id]/fs/upload). Plain
// module — no server-only import — so vitest loads it.
//
// The bytes never ride the JSON-RPC pipe: each file crosses its own ssh
// channel into `charon-agent --receive-file` (the upload twin of the
// `--stream-file` download), fed by the browser in CHUNKS. Chunked because
// Next clones every request body that goes through middleware and silently
// TRUNCATES it past 10MB (`middlewareClientMaxBodySize`, §14.73); a chunk
// well under that also bounds what the hub ever holds in memory.

/** First agent that understands `--receive-file`. */
export const FS_UPLOAD_AGENT_VERSION = '0.99.0';

/** One PUT. Must stay under Next's 10MB middleware body clone. */
export const FS_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/** Files + folders in one drop. Past this, an archive is the better tool. */
export const FS_UPLOAD_MAX_ITEMS = 1000;

export type FsUploadReason =
  /** a FILE already has this name — the user may choose to replace it */
  | 'exists'
  /** a FOLDER has this name — never replaced by a file */
  | 'is_dir'
  | 'missing'
  | 'bad_path'
  | 'offline'
  | 'unsupported'
  /** the hub no longer holds this upload (expired, cancelled, hub restart) */
  | 'gone'
  | 'error';

/** The agent's `--receive-file` exit codes (fsnav STREAM_*). */
export function receiveExitReason(code: number | null): FsUploadReason {
  switch (code) {
    case 20: return 'bad_path';
    case 21: case 26: return 'missing';
    case 22: return 'is_dir';
    case 27: return 'exists';
    // argparse: an agent that does not know the flag.
    case 2: return 'unsupported';
    default: return 'error';
  }
}

/** A NAME, never a path: the dropped file keeps it verbatim, so it is only
 *  refused where the filesystem would refuse or misread it. */
export function uploadNameError(name: string): string | null {
  if (!name) return 'empty name';
  if (name === '.' || name === '..') return 'reserved name';
  if (name.includes('/') || name.includes('\0')) return 'invalid name';
  if (new TextEncoder().encode(name).length > 255) return 'name too long';
  return null;
}

/** Every segment of a root-relative upload path must itself be a valid name. */
export function uploadPathError(path: string): string | null {
  if (!path || path.length > 4096) return 'invalid path';
  for (const part of path.split('/')) {
    const err = uploadNameError(part);
    if (err) return `${err}: ${path}`;
  }
  return null;
}

export function joinRel(dir: string, rel: string): string {
  return dir ? `${dir}/${rel}` : rel;
}

export function parentRel(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

type Listing = { ok: boolean; entries?: { name: string; dir: boolean }[]; truncated?: boolean };
type Stat = { ok: boolean; exists?: boolean; error?: string };

/**
 * Which of `paths` (root-relative) already exist, and as what.
 *
 * One listing per PARENT folder rather than a stat per path: a drop of forty
 * photos into one folder is one round trip. Parents are visited shallowest
 * first so that a folder found missing prunes everything below it — a new
 * folder cannot hold a conflict. A truncated listing falls back to a stat for
 * the names it did not show.
 */
export async function findExistingUploadTargets(
  paths: string[],
  list: (dir: string) => Promise<Listing>,
  stat: (path: string) => Promise<Stat>,
): Promise<{ path: string; dir: boolean }[]> {
  const byParent = new Map<string, string[]>();
  for (const p of new Set(paths)) {
    const parent = parentRel(p);
    const group = byParent.get(parent);
    if (group) group.push(p); else byParent.set(parent, [p]);
  }
  const depth = (p: string) => (p ? p.split('/').length : 0);
  const parents = [...byParent.keys()].sort((a, b) => depth(a) - depth(b));
  const missing = new Set<string>();
  const underMissing = (dir: string) => {
    for (let d = dir; ; d = parentRel(d)) {
      if (missing.has(d)) return true;
      if (!d) return false;
    }
  };

  const existing: { path: string; dir: boolean }[] = [];
  for (const parent of parents) {
    const group = byParent.get(parent)!;
    if (underMissing(parent)) { for (const p of group) missing.add(p); continue; }
    const listing = await list(parent);
    if (!listing.ok) {
      missing.add(parent);
      for (const p of group) missing.add(p);
      continue;
    }
    const names = new Map((listing.entries ?? []).map((e) => [e.name, e.dir]));
    for (const p of group) {
      const name = p.slice(parent ? parent.length + 1 : 0);
      if (names.has(name)) { existing.push({ path: p, dir: names.get(name)! }); continue; }
      if (listing.truncated) {
        const s = await stat(p);
        // fs_stat answers `not a file` for a folder.
        if (s.ok && s.exists) { existing.push({ path: p, dir: false }); continue; }
        if (!s.ok && /not a file/i.test(s.error ?? '')) { existing.push({ path: p, dir: true }); continue; }
      }
      missing.add(p);
    }
  }
  return existing;
}
