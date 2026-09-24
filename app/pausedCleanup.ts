import type { Vps, VpsFolder } from '@/lib/db/schema';
import type { SessionListItem } from '@/lib/types/api';
import { sidebarPathKey, sidebarPathOrder } from './sidebarPathGroups';

/**
 * The paused-sessions cleanup (the trash beside "show paused"): which sessions
 * it lists, in which tree, and what a group checkbox means.
 *
 * Pure on purpose — the modal only renders what this returns, so the order and
 * the selection rules are testable without a DOM.
 *
 * - "Paused" is the SIDEBAR's word for it, `(liveStatus ?? status) ===
 *   'sleeping'`, never the DB column alone: a row the hub knows is running
 *   again must not be offered for deletion because SQLite lags.
 * - The tree is the sidebar's tree (folder → VPS → path), in the sidebar's
 *   order, so a session is found where the eye already looks for it. Inside a
 *   path the order switches to the one a cleanup is about: last message,
 *   newest first, silent sessions last.
 * - Every group carries the ids UNDER it, so "select this VPS / this path /
 *   everything" is one set operation on the rows actually shown.
 */

export type PausedSessionLike = Pick<SessionListItem, 'status' | 'liveStatus'>;

export function isPausedSession(s: PausedSessionLike): boolean {
  return (s.liveStatus ?? s.status) === 'sleeping';
}

export type PausedPathGroup = { key: string; path: string; ids: string[]; sessions: SessionListItem[] };
export type PausedVpsGroup = {
  key: string; vpsId: string; name: string; host: string | null;
  ids: string[]; paths: PausedPathGroup[];
};
export type PausedFolderGroup = { key: string; name: string; ids: string[]; vps: PausedVpsGroup[] };
export type PausedTree = {
  folders: PausedFolderGroup[];
  /** Every listed id, in display order (range selection walks this). */
  ids: string[];
};

export type PausedFilter = {
  /** Whitespace-separated terms, ANDed, case-insensitive substring (§11 VPS
   *  filters: never fuzzy). */
  query?: string;
  /** Only sessions silent for at least this long. 0 / undefined = any. */
  minIdleMs?: number;
  now?: number;
};

/** When the session last said anything; a session that never spoke is as old
 *  as its launch. Milliseconds. */
export function lastActivityOf(s: Pick<SessionListItem, 'lastActivityMs' | 'createdAt'>): number {
  return s.lastActivityMs ?? (s.createdAt ? s.createdAt * 1000 : 0);
}

export function sessionHeadline(s: Pick<SessionListItem, 'name' | 'firstUserMessage' | 'cwd'>): string {
  const preview = (s.firstUserMessage ?? '').replace(/\s+/g, ' ').trim();
  return s.name || (preview ? preview.slice(0, 80) : s.cwd.split('/').slice(-2).join('/'));
}

function hostOf(v: Vps): string {
  return `${v.sshUser}@${v.ip}${v.sshPort !== 22 ? `:${v.sshPort}` : ''}`;
}

function matches(s: SessionListItem, vpsName: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = [
    s.name, s.firstUserMessage, s.cwd, s.handle ? `@${s.handle}` : null, s.kind, vpsName,
  ].filter(Boolean).join('\n').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function buildPausedTree(
  sessions: SessionListItem[],
  vpsList: Vps[],
  vpsFolders: VpsFolder[],
  filter: PausedFilter = {},
): PausedTree {
  const now = filter.now ?? Date.now();
  const terms = (filter.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const vpsById = new Map(vpsList.map((v) => [v.id, v] as const));
  const idleBefore = filter.minIdleMs ? now - filter.minIdleMs : null;

  const byVps = new Map<string, SessionListItem[]>();
  const allByVps = new Map<string, SessionListItem[]>();
  for (const s of sessions) {
    const all = allByVps.get(s.vpsId) ?? [];
    all.push(s);
    allByVps.set(s.vpsId, all);
    if (!isPausedSession(s)) continue;
    if (idleBefore != null && lastActivityOf(s) > idleBefore) continue;
    if (!matches(s, vpsById.get(s.vpsId)?.name ?? s.vpsId, terms)) continue;
    const list = byVps.get(s.vpsId) ?? [];
    list.push(s);
    byVps.set(s.vpsId, list);
  }

  // Folder order = the sidebar's: by position, the default folder LAST (§4),
  // then a synthetic one for a VPS pointing at a folder that no longer exists.
  const knownFolders = new Set(vpsFolders.map((f) => f.id));
  const folders = [...vpsFolders].sort((a, b) => {
    if (a.id === 'default') return 1;
    if (b.id === 'default') return -1;
    return a.position - b.position;
  }).map((f) => ({ id: f.id, name: f.name }));
  folders.push({ id: '__orphans__', name: '(other)' });
  const folderOf = (vpsId: string) => {
    const v = vpsById.get(vpsId);
    return v && knownFolders.has(v.folderId) ? v.folderId : '__orphans__';
  };

  const out: PausedFolderGroup[] = [];
  for (const folder of folders) {
    const vpsIds = [...byVps.keys()].filter((id) => folderOf(id) === folder.id).sort((a, b) => {
      const va = vpsById.get(a);
      const vb = vpsById.get(b);
      return (va?.position ?? Infinity) - (vb?.position ?? Infinity)
        || (va?.name ?? a).localeCompare(vb?.name ?? b);
    });
    const vpsGroups: PausedVpsGroup[] = vpsIds.map((vpsId) => {
      const v = vpsById.get(vpsId);
      // The sidebar's own session order decides the PATH order (§14.80: it is
      // read off the sessions, nothing stores it) — over EVERY session of the
      // machine, running ones included, as the sidebar draws it with "show
      // paused" on; a path holding no paused session is then dropped.
      const paused = byVps.get(vpsId)!;
      const ordered = [...allByVps.get(vpsId)!].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)
        || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      const withPaused = new Set(paused.map((s) => sidebarPathKey(s.cwd)));
      const paths = sidebarPathOrder(ordered).filter((path) => withPaused.has(path)).map((path) => {
        const rows = paused
          .filter((s) => sidebarPathKey(s.cwd) === path)
          .sort((a, b) => (b.lastActivityMs ?? -1) - (a.lastActivityMs ?? -1)
            || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
        return { key: JSON.stringify([vpsId, path]), path, ids: rows.map((s) => s.id), sessions: rows };
      });
      return {
        key: vpsId,
        vpsId,
        name: v?.name ?? vpsId,
        host: v ? hostOf(v) : null,
        ids: paths.flatMap((p) => p.ids),
        paths,
      };
    });
    if (vpsGroups.length === 0) continue;
    out.push({ key: folder.id, name: folder.name, ids: vpsGroups.flatMap((g) => g.ids), vps: vpsGroups });
  }
  return { folders: out, ids: out.flatMap((f) => f.ids) };
}

export type CheckState = 'none' | 'some' | 'all';

export function groupCheckState(ids: readonly string[], selected: ReadonlySet<string>): CheckState {
  let n = 0;
  for (const id of ids) if (selected.has(id)) n++;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}

/** A group checkbox: fully checked ⇒ clears the group, otherwise (empty OR
 *  partial) ⇒ selects all of it — the same answer a file manager gives. */
export function toggleGroup(ids: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (ids.length > 0 && groupCheckState(ids, selected) === 'all') for (const id of ids) next.delete(id);
  else for (const id of ids) next.add(id);
  return next;
}

/**
 * Shift-click: every row between the anchor and the target (inclusive, in
 * display order) takes the state the TARGET is being given. Without a usable
 * anchor it is a plain toggle of the target.
 */
export function toggleRow(
  order: readonly string[],
  selected: ReadonlySet<string>,
  target: string,
  anchor: string | null,
  range: boolean,
): Set<string> {
  const next = new Set(selected);
  const on = !selected.has(target);
  const a = range && anchor != null ? order.indexOf(anchor) : -1;
  const b = order.indexOf(target);
  if (a < 0 || b < 0) {
    if (on) next.add(target); else next.delete(target);
    return next;
  }
  for (const id of order.slice(Math.min(a, b), Math.max(a, b) + 1)) {
    if (on) next.add(id); else next.delete(id);
  }
  return next;
}

const DAY_MS = 86_400_000;

/** "3 min ago" / "5 h ago" / "12 d ago" / "4 mo ago" — the scale a cleanup
 *  decides on; the exact day and time sit next to it. */
export function formatAgo(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 60 * DAY_MS) return `${Math.floor(diff / DAY_MS)} d ago`;
  if (diff < 365 * DAY_MS) return `${Math.floor(diff / (30 * DAY_MS))} mo ago`;
  return `${Math.floor(diff / (365 * DAY_MS))} y ago`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 23 Sep · 14:32", with the year only when it is not this one. Local
 *  time: the question is "when did I last use it", asked from here. Spelled
 *  by hand: `toLocale*` output moves with the ICU version ("Sep" / "Sept"). */
export function formatStamp(ms: number, now: number): string {
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year} · ${hh}:${mm}`;
}
