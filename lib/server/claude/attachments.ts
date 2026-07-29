import 'server-only';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { db, claudeSessionAttachments, type ClaudeSession, type ClaudeSessionAttachment, type Vps } from '@/lib/db';
import { sshExec, shQuote } from './sshExec';
// Naming rules live in a PLAIN module so they stay unit-testable (this file
// imports lib/db → server-only → unloadable under vitest). cf. verifyParse.ts.
import { sanitizeAttachmentName, uniqueRemoteName } from './attachmentNames';
export { sanitizeAttachmentName } from './attachmentNames';

// Session attachments — "give the agent a file, not a content block".
// ─────────────────────────────────────────────────────────────────────────────
// The whole feature rests on one observation: BOTH backends already know how to
// pick a file up off their own filesystem, so we never have to teach the
// protocol about images.
//   - Claude Code's `Read` handles images, PDF, notebooks and text natively
//     (it builds the API `image` / `document` blocks itself, with its own
//     resize + byte-budget pipeline — so we don't own that problem either).
//   - Codex's built-in `view_image` loads a local image into the conversation;
//     `shell` covers everything else.
// Consequence: `send_input` stays a plain string and the agent pyz is
// untouched. We upload, we write the PATH into the prompt, the agent does the
// rest. Deliberately NO mime filtering — "is this file usable" is the agent's
// verdict to give, in its own words, not a 415 from us.
//
// Why the file lands INSIDE the session cwd: `view_image` resolves relative to
// the session environment and the Codex sandbox levels (read-only /
// workspace-write) are scoped to the workspace, so a path outside the cwd is a
// bet on both backends at once. `.charon-uploads/` keeps it in one obvious,
// greppable place the user can delete wholesale.

// Directory created inside the session cwd on the VPS.
export const REMOTE_UPLOAD_DIRNAME = '.charon-uploads';

// Hard cap per file. The blob crosses SSH base64-encoded (+33%), so 25 MB of
// file is ~34 MB on the wire — comfortably inside a single `base64 -d` pipe,
// and far below anything that would make the hub's memory footprint interesting.
// This is NOT a type/kind restriction: any 25 MB file goes through, whatever it
// contains.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Hub-side blob root, derived from DATABASE_URL so it follows a relocated data
// directory (Docker bind-mount, custom DATABASE_URL) instead of hard-coding
// ./data. Mirrors what lib/db/index.ts does with the same env var.
function uploadsRoot(): string {
  const dbPath = process.env.DATABASE_URL || './data/charon.db';
  return path.resolve(path.dirname(dbPath), 'uploads');
}

export function listAttachments(sessionId: string): ClaudeSessionAttachment[] {
  return db
    .select()
    .from(claudeSessionAttachments)
    .where(eq(claudeSessionAttachments.sessionId, sessionId))
    .orderBy(asc(claudeSessionAttachments.createdAt))
    .all();
}

export function getAttachment(sessionId: string, id: string): ClaudeSessionAttachment | null {
  return (
    db
      .select()
      .from(claudeSessionAttachments)
      .where(and(eq(claudeSessionAttachments.sessionId, sessionId), eq(claudeSessionAttachments.id, id)))
      .get() ?? null
  );
}

/** Absolute path of the hub-side blob, or null if the row has none. */
export function attachmentBlobPath(att: ClaudeSessionAttachment): string | null {
  if (!att.localPath) return null;
  // localPath is stored relative to the uploads root and was written by us —
  // resolve + containment check anyway, so a hand-edited DB row can't turn a
  // download route into an arbitrary-file read.
  const root = uploadsRoot();
  const abs = path.resolve(root, att.localPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/**
 * Store a file for a session: hub copy + VPS copy + DB row.
 *
 * Order matters. The hub copy is written first (cheap, local, easy to roll
 * back), then the VPS push — because the VPS is the one that can fail for
 * interesting reasons (ssh down, disk full, cwd gone). The DB row is inserted
 * LAST, so a row always means "this file really is on the VPS at this path".
 * A half-uploaded attachment showing up in the Files tab, pointing at a path
 * the agent would fail to read, is worse than a clean error.
 */
export async function createAttachment(
  session: ClaudeSession,
  vps: Vps,
  file: { name: string; mime: string; bytes: Buffer },
): Promise<ClaudeSessionAttachment> {
  if (file.bytes.length === 0) throw new Error('empty file');
  if (file.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`file too large (${fmtBytes(file.bytes.length)} > ${fmtBytes(MAX_ATTACHMENT_BYTES)})`);
  }
  const cwd = String(session.cwd || '').replace(/\/+$/, '');
  if (!cwd) throw new Error('session has no cwd');

  const id = randomUUID();
  const safeName = sanitizeAttachmentName(file.name);
  const existing = listAttachments(session.id);
  const taken = new Set(existing.map((a) => path.posix.basename(a.remotePath)));
  const remoteName = uniqueRemoteName(taken, safeName);
  const remoteDir = `${cwd}/${REMOTE_UPLOAD_DIRNAME}`;
  const remotePath = `${remoteDir}/${remoteName}`;

  // 1. Hub copy.
  const relDir = path.join(session.id);
  const absDir = path.join(uploadsRoot(), relDir);
  await fs.mkdir(absDir, { recursive: true });
  const relPath = path.join(relDir, `${id}__${remoteName}`);
  await fs.writeFile(path.join(uploadsRoot(), relPath), file.bytes);

  // 2. VPS copy, through the same base64-over-ssh-stdin pipe the agent deploy
  //    uses (bootstrap.ts). Written to a temp name then moved, so a truncated
  //    transfer can never leave a partial file at a path we then advertise to
  //    the agent as readable. Every interpolated value is shQuote'd (§14.11).
  const tmpPath = `${remotePath}.charon-part`;
  const cmd = [
    `mkdir -p ${shQuote(remoteDir)}`,
    // Self-ignoring directory. The session cwd is almost always a git repo, and
    // without this every attachment shows up in the user's `git status` as
    // untracked noise — with a real risk of being swept into a commit by an
    // agent running `git add -A`. A `.gitignore` containing `*` hides the
    // directory AND itself, in ANY repo, without touching the user's own
    // .gitignore. Written every upload (cheap, idempotent) so it also
    // self-heals a directory created before this existed.
    `printf '*\\n' > ${shQuote(`${remoteDir}/.gitignore`)}`,
    `base64 -d > ${shQuote(tmpPath)}`,
    `mv -f ${shQuote(tmpPath)} ${shQuote(remotePath)}`,
  ].join(' && ');
  // Budget: a slow link still has to finish. 60s floor + 4s per MB, so a 25 MB
  // file gets ~160s rather than dying at the default 30s.
  const timeoutMs = 60_000 + Math.ceil(file.bytes.length / (1024 * 1024)) * 4_000;
  const res = await sshExec(vps, cmd, { stdin: file.bytes.toString('base64'), timeoutMs });
  if (!res.ok) {
    // Roll the hub blob back — no row will exist, so it would be unreferenced.
    await fs.rm(path.join(uploadsRoot(), relPath), { force: true }).catch(() => {});
    const detail = (res.stderr || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
    throw new Error(`upload to ${vps.name} failed${detail ? ': ' + detail : ''}`);
  }

  // 3. Row.
  const row: ClaudeSessionAttachment = {
    id,
    sessionId: session.id,
    name: remoteName,
    remotePath,
    localPath: relPath,
    size: file.bytes.length,
    mime: file.mime || '',
    createdAt: Math.floor(Date.now() / 1000),
  };
  db.insert(claudeSessionAttachments).values(row).run();
  return row;
}

/**
 * Forget an attachment: DB row + hub blob + best-effort remote unlink.
 *
 * The remote unlink is best-effort ON PURPOSE. The VPS may be unreachable, and
 * refusing to clean up the hub side because of that would leave the user stuck
 * with an entry they can't remove. The remote file is inside the user's own
 * `.charon-uploads/` directory, visible and deletable by hand.
 */
export async function removeAttachment(sessionId: string, id: string): Promise<boolean> {
  const att = getAttachment(sessionId, id);
  if (!att) return false;
  db.delete(claudeSessionAttachments)
    .where(and(eq(claudeSessionAttachments.sessionId, sessionId), eq(claudeSessionAttachments.id, id)))
    .run();
  const blob = attachmentBlobPath(att);
  if (blob) await fs.rm(blob, { force: true }).catch(() => {});
  return true;
}

/** Best-effort remote unlink, fired after the row is gone. */
export async function unlinkRemoteAttachment(vps: Vps, remotePath: string): Promise<void> {
  await sshExec(vps, `rm -f ${shQuote(remotePath)}`, { timeoutMs: 15_000 }).catch(() => {});
}

/**
 * Drop every hub blob of a session. Called from deleteSession — the rows go
 * away by FK cascade, but the files on disk would otherwise leak forever.
 */
export async function purgeSessionBlobs(sessionId: string): Promise<void> {
  // sessionId is a UUID we generated, but resolve+contain anyway rather than
  // trusting it to be safe to join.
  const root = uploadsRoot();
  const dir = path.resolve(root, sessionId);
  if (dir !== root && !dir.startsWith(root + path.sep)) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
