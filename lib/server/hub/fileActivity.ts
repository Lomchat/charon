import 'server-only';

/**
 * Who is reading or writing which file, right now (§14.88).
 *
 * The explorer already shows what git thinks changed. What it could not show
 * is what is happening THIS SECOND: with several agents on one machine, two
 * sessions editing the same file is a real hazard and, until now, a silent
 * one.
 *
 * The source is the tool calls we already stream. Deliberately in memory and
 * deliberately short-lived: this is a liveness light, not a record. Anything
 * worth keeping is already in the transcript and in git.
 *
 * Keyed on `(vpsId, absolute path)` rather than on a session, because the
 * question the tree asks is "who is touching THIS file" — a file can be read
 * by one session while another writes it, and the writer is the one that
 * matters.
 */
export type ActivityKind = 'read' | 'write';

export type FileActivity = {
  vpsId: string;
  /** Absolute path on the VPS. */
  path: string;
  kind: ActivityKind;
  sessionId: string;
  sessionName: string | null;
  /** Epoch ms of the tool call. */
  at: number;
};

// A write stays lit longer than a read: "an agent just rewrote this" is worth
// knowing a few minutes later, "an agent glanced at this" is not.
const TTL_MS: Record<ActivityKind, number> = { read: 90_000, write: 300_000 };
const MAX_PER_VPS = 400;

type Store = Map<string, Map<string, FileActivity>>;   // vpsId → path → entry
const g = globalThis as unknown as { __charonFileActivity?: Store };
const store: Store = (g.__charonFileActivity ??= new Map());

/**
 * The file a tool call is about, if any — normalised to an absolute path.
 *
 * Names come from both backends and are matched case-insensitively: Claude
 * ships `Read`/`Edit`/`Write`/`NotebookEdit`, Codex ships `view_image`,
 * `apply_patch` and shell-ish wrappers. An unknown tool is simply not file
 * activity; guessing from a random `path` key would light up the tree on every
 * `Glob`.
 */
export function fileFromToolUse(
  name: string, input: unknown, cwd: string,
): { path: string; kind: ActivityKind } | null {
  const n = (name || '').toLowerCase();
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };

  const WRITE = new Set([
    'edit', 'write', 'notebookedit', 'multiedit', 'str_replace_editor',
    'apply_patch', 'create_file', 'update_file',
  ]);
  const READ = new Set(['read', 'view', 'view_image', 'read_file', 'notebookread']);
  if (!WRITE.has(n) && !READ.has(n)) return null;

  const raw = pick('file_path', 'path', 'filePath', 'notebook_path', 'target_file');
  if (!raw) return null;
  // A relative path is relative to the session's cwd, which is the only base
  // the agent ever uses.
  const abs = raw.startsWith('/') ? raw : `${cwd.replace(/\/+$/, '')}/${raw.replace(/^\.\//, '')}`;
  return { path: abs, kind: WRITE.has(n) ? 'write' : 'read' };
}

/** Record a touch. Returns the entry when it is worth broadcasting. */
export function noteActivity(a: FileActivity): FileActivity | null {
  if (!a.vpsId || !a.path) return null;
  let per = store.get(a.vpsId);
  if (!per) { per = new Map(); store.set(a.vpsId, per); }
  const prev = per.get(a.path);
  // A burst of reads on one file is one event, not forty: only re-broadcast
  // when the session, the kind, or a quiet second has passed.
  const sameish = prev && prev.sessionId === a.sessionId && prev.kind === a.kind
    && a.at - prev.at < 1500;
  per.delete(a.path);            // re-insert to keep the Map in LRU order
  per.set(a.path, a);
  if (per.size > MAX_PER_VPS) {
    const oldest = per.keys().next().value;
    if (oldest !== undefined) per.delete(oldest);
  }
  return sameish ? null : a;
}

/** Everything still live for a VPS, pruned as a side effect. */
export function activityFor(vpsId: string, now = Date.now()): FileActivity[] {
  const per = store.get(vpsId);
  if (!per) return [];
  const out: FileActivity[] = [];
  for (const [path, a] of per) {
    if (now - a.at > TTL_MS[a.kind]) per.delete(path);
    else out.push(a);
  }
  return out;
}

/** Drop everything a session had lit — it is gone, so nothing is happening. */
export function clearSessionActivity(sessionId: string): void {
  for (const per of store.values()) {
    for (const [path, a] of per) if (a.sessionId === sessionId) per.delete(path);
  }
}

export const activityTtlMs = TTL_MS;
