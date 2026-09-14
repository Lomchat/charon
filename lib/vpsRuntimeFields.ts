import type { Vps } from './db/schema';
import { PROVIDERS, SESSION_PROVIDERS } from './sessionCapabilities';

/**
 * The VPS columns that change at RUNTIME — the ones every convergence path has
 * to carry (§14.52).
 *
 * Four consumers used to hand-list them and they drifted apart the moment a
 * third backend landed: the SSE `vps_status` payload dropped the cursor keys on
 * the floor, the browser merge ignored them, the poll snapshot carried them but
 * the equality check did not, and the post-update patch forgot them. Net effect:
 * a sign-in in one tab never reached another, and `cursorAvailable=1` kept
 * reading "not installed" until F5.
 *
 * So the list is DERIVED: agent-level fields, plus every column the provider
 * registry declares for a backend (availability flag, login flag, one per
 * release line). A provider #4 is enrolled in all four paths by its registry
 * entry alone — which is the §14.102 rule applied to the one place it was
 * still being broken.
 *
 * NOT included: `agentLastSeenAt` (a timestamp the UI reads from its own
 * polling) and the `*CheckedAt` columns (server-side TTL bookkeeping, never
 * rendered). Both would make every snapshot compare unequal and re-render the
 * fleet on each poll.
 */
const AGENT_RUNTIME_KEYS = [
  'agentStatus',
  'agentVersion',
  'agentPyzSha',
  'agentLastError',
] as const;

/** Every release line's installed-version column, in registry order.
 *
 *  `UpdateAgentResult` reports each post-update version under the SAME name
 *  (§14.102), so this doubles as the list of version fields an update response
 *  carries — which is how the update route and the browser patch stay in step
 *  with the registry instead of naming three of four backends. */
export const PROVIDER_VERSION_COLUMNS: readonly string[] = [
  ...new Set(SESSION_PROVIDERS.flatMap(
    (p) => PROVIDERS[p].backend.versions.map((v) => v.column),
  )),
];

/** Per-provider health columns, in registry order. Deduped: Claude's
 *  availability signal IS its version column, so it appears once. */
export const PROVIDER_RUNTIME_KEYS: readonly string[] = [
  ...new Set(SESSION_PROVIDERS.flatMap((p) => {
    const b = PROVIDERS[p].backend;
    return [
      b.availability.column,
      b.loggedInColumn,
      ...b.versions.map((v) => v.column),
    ];
  })),
];

export type VpsRuntimeKey = Exclude<keyof Vps, 'id'>;

export const VPS_RUNTIME_KEYS = [
  ...AGENT_RUNTIME_KEYS,
  ...PROVIDER_RUNTIME_KEYS,
] as VpsRuntimeKey[];

/** Keep only the runtime columns of a partial VPS patch, dropping `undefined`
 *  so the "key present ⇔ known" no-clobber contract survives (§14.53). */
export function pickVpsRuntimeFields(
  source: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!source) return out;
  for (const key of VPS_RUNTIME_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}
