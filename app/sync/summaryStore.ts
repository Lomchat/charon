'use client';
// THE client store of session summaries (CLAUDE.md §14.108, §9) + the VPS
// runtime slice. One module store per page, read through
// `useSyncExternalStore` with referentially stable snapshots.
//
// Fed by the transport at MODULE EVALUATION in the browser (every page that
// imports this module is fed — HubPanel and /desk alike); pages only seed
// it from their SSR props and the DEFAULT list GET:
//   - `session_summary` frame  → applySummaryFrame (null = deleted/archived)
//   - `sync_summaries` (resync) → seedSummaries(…, R, complete)
//   - `vps_status` frame        → applyVpsFrame (only the keys it carries)
//   - `sync_vps` (resync)       → seedVpsRuntime(…, R)
// Apply rule I5: per id, an input applies iff its revision is newer than the
// one held (a snapshot stamped R also when equal: it reflects every frame ≤ R);
// a COMPLETE snapshot also removes the ids it does not list whose held rev ≤
// R. Arrival order never matters (G4). A rev-less input (older hub) applies
// unconditionally.
//
// Optimistic writes (§14.32) are overlays: `addOverlay(id, patch)` shows the
// patch until the action's POST settled AND this tab's `lastRev ≥` the
// revision the route answered (`sync`, read after the summary frame carrying
// the action was published) — then the store holds the truth. A failure
// reverts; 30 s cap.
import { useSyncExternalStore } from 'react';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { AgentSessionListQuery, AgentSessionsListResponse, VpsRuntimeSnapshot } from '@/lib/types/api';
import { pickVpsRuntimeFields } from '@/lib/vpsRuntimeFields';
import { cmpRev, type SyncRev } from '@/lib/sync/rev';
import { getSyncPosition, noteHttpSync, subscribeSyncFrames, type SyncFrame, type SyncFrameInfo } from '../globalEventStream';

type Held = { s: SessionSummary | null; rev: SyncRev | null };
type OverlayPatch = Partial<SessionSummary> | { removed: true };
type Overlay = {
  token: number;
  id: string;
  patch: OverlayPatch;
  /** undefined = POST pending; null = acked without a revision (older hub). */
  ack: SyncRev | null | undefined;
  /** For a rev-less ack: the complete seed count at ack time. */
  seedsAtAck: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export const OVERLAY_CAP_MS = 30_000;

const held = new Map<string, Held>();
const overlays: Overlay[] = [];
let overlayToken = 0;
let completeSeeds = 0;
let version = 0;
const subs = new Set<() => void>();

// VPS runtime: per key, the revision of the value held.
type VpsHeld = { values: Record<string, unknown>; revs: Record<string, SyncRev | null>; snap: Partial<VpsRuntimeSnapshot> & { id: string } };
const vpsHeld = new Map<string, VpsHeld>();
let vpsVersion = 0;
let vpsSnap: ReadonlyMap<string, Partial<VpsRuntimeSnapshot> & { id: string }> = new Map();
const vpsSubs = new Set<() => void>();

function notify(): void {
  version++;
  listCache = null;
  for (const cb of subs) { try { cb(); } catch {} }
}

function notifyVps(): void {
  vpsVersion++;
  const m = new Map<string, Partial<VpsRuntimeSnapshot> & { id: string }>();
  for (const [id, h] of vpsHeld) m.set(id, h.snap);
  vpsSnap = m;
  for (const cb of vpsSubs) { try { cb(); } catch {} }
}

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Set `id` to `s` at `rev`; keeps the held object when the content is equal
 *  (unchanged cards keep their identity). Returns true when visible. */
function put(id: string, s: SessionSummary | null, rev: SyncRev | null): boolean {
  const cur = held.get(id);
  if (cur && sameJson(cur.s, s)) {
    if (rev) cur.rev = rev;
    return false;
  }
  held.set(id, { s, rev });
  return true;
}

// ── Sessions ────────────────────────────────────────────────────────────────

/** SSR, the default list GET, `sync_summaries`. `complete`: the list is EVERY
 *  non-archived session at `stamp` (absent ids leave). */
export function seedSummaries(list: SessionSummary[], stamp: SyncRev | null, complete: boolean): void {
  let changed = false;
  const listed = new Set<string>();
  for (const s of list) {
    if (!s || typeof s.id !== 'string') continue;
    listed.add(s.id);
    const cur = held.get(s.id);
    if (stamp && cur?.rev && cmpRev(stamp, cur.rev) < 0) continue;   // held is newer
    if (put(s.id, s, stamp)) changed = true;
  }
  if (complete) {
    for (const [id, h] of held) {
      if (listed.has(id) || h.s == null) continue;
      if (stamp && h.rev && cmpRev(h.rev, stamp) > 0) continue;      // newer than the snapshot
      held.set(id, { s: null, rev: stamp ?? h.rev });
      changed = true;
    }
    completeSeeds++;
    if (checkOverlays()) changed = true;
  }
  if (changed) notify();
}

/** One `session_summary` frame (null = deleted or archived). */
export function applySummaryFrame(id: string, summary: SessionSummary | null, rev: SyncRev | null): void {
  const cur = held.get(id);
  if (rev && cur?.rev && cmpRev(rev, cur.rev) <= 0) return;
  if (put(id, summary, rev)) notify();
}

/**
 * Seed from a list GET answer — ONLY the default call (no `vpsId`, no
 * `status`, no `includeArchived`) is complete; a filtered or archived answer
 * never touches the store (ResumeModal's call stays store-neutral). An answer
 * from an older hub process is ignored.
 */
export function seedFromListResponse(r: AgentSessionsListResponse, q?: AgentSessionListQuery): boolean {
  if (q && (q.vpsId || q.status || q.includeArchived)) return false;
  if (noteHttpSync(r.sync) === 'older') return false;
  const rows = (r.sessions ?? []).filter((s) => !(s as { archived?: unknown }).archived) as SessionSummary[];
  seedSummaries(rows, r.sync ?? null, true);
  if (r.vpsRuntime) seedVpsRuntime(r.vpsRuntime, r.sync ?? null);
  return true;
}

let listCache: SessionSummary[] | null = null;
const overlaidCache = new Map<string, { base: SessionSummary; key: string; out: SessionSummary }>();

function overlaid(id: string, base: SessionSummary | null): SessionSummary | null {
  const mine = overlays.filter((o) => o.id === id);
  if (!mine.length || !base) {
    if (mine.some((o) => 'removed' in o.patch)) return null;
    return base;
  }
  if (mine.some((o) => 'removed' in o.patch)) return null;
  const key = mine.map((o) => o.token).join(',');
  const c = overlaidCache.get(id);
  if (c && c.base === base && c.key === key) return c.out;
  let out: SessionSummary = base;
  for (const o of mine) out = { ...out, ...(o.patch as Partial<SessionSummary>) };
  overlaidCache.set(id, { base, key, out });
  return out;
}

function computeList(): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const [id, h] of held) {
    const s = overlaid(id, h.s);
    if (s && !(s as { archived?: unknown }).archived) out.push(s);
  }
  for (const id of [...overlaidCache.keys()]) if (!held.has(id)) overlaidCache.delete(id);
  return sortSummaries(out);
}

/** createdAt desc, id desc. */
export function sortSummaries<T extends { id: string; createdAt?: number | null }>(rows: T[]): T[] {
  return rows.sort((a, b) => ((b.createdAt ?? 0) - (a.createdAt ?? 0)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export function getSessionList(): SessionSummary[] {
  return (listCache ??= computeList());
}

export function getSummary(id: string): SessionSummary | undefined {
  const h = held.get(id);
  return overlaid(id, h?.s ?? null) ?? undefined;
}

export function subscribeSummaries(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

/** Non-archived summaries, overlays applied, createdAt desc, id desc. Stable
 *  until something changes. `serverList`: what SSR rendered (hydration). */
export function useSessionList(serverList?: SessionSummary[]): SessionSummary[] {
  return useSyncExternalStore(subscribeSummaries, getSessionList, () => serverSnapshot(serverList));
}

const serverSnapCache = new WeakMap<SessionSummary[], SessionSummary[]>();
const EMPTY: SessionSummary[] = [];
function serverSnapshot(list?: SessionSummary[]): SessionSummary[] {
  if (!list) return EMPTY;
  let s = serverSnapCache.get(list);
  if (!s) { s = sortSummaries(list.filter((x) => !(x as { archived?: unknown }).archived)); serverSnapCache.set(list, s); }
  return s;
}

let hydrated = false;
/** Seed once from SSR props, browser only (call during the first render). */
export function hydrateSummaries(list: SessionSummary[] | undefined, stamp: SyncRev | null | undefined): void {
  if (hydrated || typeof window === 'undefined' || !list) return;
  hydrated = true;
  seedSummaries(list, stamp ?? null, true);
}

// ── Overlays ────────────────────────────────────────────────────────────────

function settled(o: Overlay): boolean {
  if (o.ack === undefined) return false;
  if (o.ack === null) return completeSeeds > o.seedsAtAck;
  const pos = getSyncPosition();
  if (pos.epoch == null) return false;
  if (pos.epoch > o.ack.epoch) return true;
  if (pos.epoch === o.ack.epoch && pos.lastRev != null && pos.lastRev >= o.ack.rev) return true;
  // The store already holds a summary at least as new as the action.
  const h = held.get(o.id);
  return !!h?.rev && cmpRev(h.rev, o.ack) >= 0;
}

function dropOverlay(o: Overlay): void {
  const i = overlays.indexOf(o);
  if (i === -1) return;
  overlays.splice(i, 1);
  if (o.timer) clearTimeout(o.timer);
}

/** Clear every settled overlay. Returns true when one went. */
function checkOverlays(): boolean {
  let changed = false;
  for (const o of [...overlays]) {
    if (settled(o)) { dropOverlay(o); changed = true; }
  }
  return changed;
}

export function addOverlay(id: string, patch: OverlayPatch): { ack(rev: SyncRev | null | undefined): void; fail(): void } {
  const o: Overlay = { token: ++overlayToken, id, patch, ack: undefined, seedsAtAck: 0, timer: null };
  overlays.push(o);
  o.timer = setTimeout(() => { o.timer = null; dropOverlay(o); notify(); }, OVERLAY_CAP_MS);
  notify();
  return {
    ack(rev) {
      if (!overlays.includes(o)) return;
      o.ack = rev ?? null;
      o.seedsAtAck = completeSeeds;
      if (settled(o)) { dropOverlay(o); notify(); }
    },
    fail() {
      if (!overlays.includes(o)) return;
      dropOverlay(o);
      notify();
    },
  };
}

/** Overlays held (tests / debugging). */
export function overlayCount(): number { return overlays.length; }

// ── VPS runtime slice ───────────────────────────────────────────────────────

function putVps(id: string, fields: Record<string, unknown>, rev: SyncRev | null, snapshot: boolean): boolean {
  let h = vpsHeld.get(id);
  if (!h) { h = { values: {}, revs: {}, snap: { id } }; vpsHeld.set(id, h); }
  let changed = false;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const r = h.revs[k] ?? null;
    if (rev && r && (snapshot ? cmpRev(rev, r) < 0 : cmpRev(rev, r) <= 0)) continue;
    h.revs[k] = rev;
    if (h.values[k] === v) continue;
    h.values[k] = v;
    changed = true;
  }
  if (changed) h.snap = { id, ...h.values } as Partial<VpsRuntimeSnapshot> & { id: string };
  return changed;
}

/** A full runtime snapshot (resync `sync_vps`, list GET `vpsRuntime`). */
export function seedVpsRuntime(list: VpsRuntimeSnapshot[], stamp: SyncRev | null): void {
  let changed = false;
  for (const v of list ?? []) {
    if (!v || typeof v.id !== 'string') continue;
    if (putVps(v.id, pickVpsRuntimeFields(v as unknown as Record<string, unknown>), stamp, true)) changed = true;
  }
  if (changed) notifyVps();
}

/** A `vps_status` frame: only the keys it carries (no-clobber, §14.53). */
export function applyVpsFrame(id: string, fields: Partial<VpsRuntimeSnapshot>, rev: SyncRev | null): void {
  if (putVps(id, pickVpsRuntimeFields(fields as Record<string, unknown>), rev, false)) notifyVps();
}

export function getVpsRuntime(): ReadonlyMap<string, Partial<VpsRuntimeSnapshot> & { id: string }> {
  return vpsSnap;
}

export function subscribeVpsRuntime(cb: () => void): () => void {
  vpsSubs.add(cb);
  return () => { vpsSubs.delete(cb); };
}

const EMPTY_VPS: ReadonlyMap<string, Partial<VpsRuntimeSnapshot> & { id: string }> = new Map();
/** id → the runtime fields this store holds (rev-ordered). */
export function useVpsRuntime(): ReadonlyMap<string, Partial<VpsRuntimeSnapshot> & { id: string }> {
  return useSyncExternalStore(subscribeVpsRuntime, getVpsRuntime, () => EMPTY_VPS);
}

// ── The feed ────────────────────────────────────────────────────────────────

/** Exported for tests; installed once at module evaluation in the browser. */
export function onSyncFrame(frame: SyncFrame, info: SyncFrameInfo): void {
  switch (frame.type) {
    case 'session_summary':
      if (typeof frame.sessionId === 'string') {
        applySummaryFrame(frame.sessionId, (frame.summary as SessionSummary | null) ?? null, info.rev);
      }
      break;
    case 'sync_summaries':
      seedSummaries((frame.sessions as SessionSummary[]) ?? [], info.snapshotRev, true);
      break;
    case 'vps_status':
      if (typeof frame.sessionId === 'string') {
        applyVpsFrame(frame.sessionId, frame as unknown as Partial<VpsRuntimeSnapshot>, info.rev);
      }
      break;
    case 'sync_vps':
      seedVpsRuntime((frame.vps as VpsRuntimeSnapshot[]) ?? [], info.snapshotRev);
      break;
    default:
      break;
  }
  // `lastRev` may have moved: an acked overlay may be settled now.
  if (overlays.length && checkOverlays()) notify();
}

const gFeed = globalThis as unknown as { __charonSummaryFeed?: () => void };
if (typeof window !== 'undefined') {
  // A re-evaluated module (HMR) replaces the previous copy's feed.
  gFeed.__charonSummaryFeed?.();
  gFeed.__charonSummaryFeed = subscribeSyncFrames(onSyncFrame);
}

/** Tests only: forget everything. */
export function resetSummaryStoreForTests(): void {
  held.clear(); overlaidCache.clear(); vpsHeld.clear();
  for (const o of [...overlays]) dropOverlay(o);
  completeSeeds = 0; hydrated = false; listCache = null;
  vpsSnap = new Map(); version++; vpsVersion++;
}
