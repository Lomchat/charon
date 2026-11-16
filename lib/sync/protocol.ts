// Per-connection control frames of the proto-2 SSE (CLAUDE.md §9, §14.14).
// Browser-safe TYPES (+ one constant set).
//
// Bus frames carry `id: <epoch>.<rev>` (lib/sync/rev.ts). Control frames are
// built per connection, carry NO `id:` (except `sync_snapshot_end`, whose
// `id: E.R` is the resync's baseline, and `heartbeat`, whose `id: E.<current>`
// only proves registration) and are recognised by `type`, never by id.
//
// Resync wire order (one synchronous tick): sync_hello → sync_summaries →
// sync_vps → sync_installs → model_notices → `id: E.R` + sync_snapshot_end.
// Resume: sync_hello{resume} → replayed bus lines (each with its own id) →
// sync_replay_end.
import type { SyncRev } from './rev';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { VpsRuntimeSnapshot } from '@/lib/types/api';

/** The `sync` field of HTTP responses: the bus revision the response reflects. */
export type SyncStamp = SyncRev;
/** `dist/client/BUILD_ID`, `'development'` in dev. */
export type BuildId = string;

export type SyncControlFrame =
  | { type: 'sync_hello'; proto: 2; mode: 'resume'; epoch: number; rev: number; from: number; buildId: BuildId }
  | { type: 'sync_hello'; proto: 2; mode: 'resync'; reason: 'first' | 'epoch' | 'gap' | 'cap' | 'future';
      epoch: number; rev: number; buildId: BuildId }
  | { type: 'sync_replay_end'; rev: number }
  /** complete (non-archived) list at R */
  | { type: 'sync_summaries'; sessions: SessionSummary[] }
  /** pickVpsRuntimeFields shape */
  | { type: 'sync_vps'; vps: VpsRuntimeSnapshot[] }
  | { type: 'sync_installs'; running: Array<{ installId: string; vpsId: string; vpsName: string; status: 'running' }> }
  /** the ONLY resync frame carrying `id: E.R` */
  | { type: 'sync_snapshot_end'; rev: number }
  /** carries `id: E.<currentRev>` */
  | { type: 'heartbeat'; ts: number };

/** The control types above, plus `model_notices`, which a resync snapshot
 *  sends WITHOUT an id (it is also a live bus frame, revision-guarded by its
 *  own consumer). A client exempts these from the bus dup guard. */
export const SYNC_CONTROL_TYPES: ReadonlySet<string> = new Set([
  'sync_hello', 'sync_replay_end', 'sync_summaries', 'sync_vps', 'sync_installs',
  'sync_snapshot_end', 'heartbeat', 'model_notices',
]);

/** `GET /api/perf` → `sync` (lib/server/sync/syncBus.ts § syncStats). */
export type SyncStats = {
  epoch: number; rev: number;
  /** `ringBytes`: the CHARGED footprint (payload + RING_FRAME_OVERHEAD per frame). */
  ringFrames: number; ringBytes: number; oldestRev: number; oldestAgeMs: number;
  framesPerMin: number; bytesPerMin: number;
  /** oversized frames stored in the ring as a `session_resync` stub, since boot */
  stubs: number;
  conns: number; outboxBytes: number;
  resumes: number; resyncs: Record<string, number>; closes: Record<string, number>;
};
