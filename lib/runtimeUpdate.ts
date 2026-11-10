// A session still on the code of before a hot agent update (§14.117): what
// the header says about it. The agent records which agent and SDKs each
// runtime generation runs (`versions.json`, agent >= 0.131.0) — the "from";
// the "to" is the VPS row (what the current daemon runs). Release lines come
// from the provider registry (`backend.versions[].runtimeKey`, §14.102).
import { PROVIDERS } from '@/lib/sessionCapabilities';

/** Agent runtime key ('agent', 'claude', 'codex_cli'…) → version. */
export type RuntimeVersions = Record<string, string>;

type Line = { key: string; label: string; column: string };

function lines(): Line[] {
  return [
    { key: 'agent', label: 'Agent', column: 'agentVersion' },
    ...Object.values(PROVIDERS).flatMap((p) => p.backend.versions.map((v) => ({
      key: v.runtimeKey, label: v.packageLabel, column: v.column,
    }))),
  ];
}

/** Keep only known keys with short version strings: this crosses from the
 *  agent to the page. */
export function sanitizeRuntimeVersions(raw: unknown): RuntimeVersions | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: RuntimeVersions = {};
  for (const { key } of lines()) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0 && v.length <= 64) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** One row per release line that changed, e.g. `Agent update pending: 0.129.0
 *  → 0.130.0`. `from` null = a runtime older than the record: only the agent's
 *  target can be named. `vps` = the session's VPS row (its version columns). */
export function pendingUpdateRows(from: RuntimeVersions | null | undefined, vps: object | null | undefined): string[] {
  const row = (vps ?? {}) as Record<string, unknown>;
  const to = (column: string) => (typeof row[column] === 'string' && row[column] ? row[column] as string : null);
  const agentTo = to('agentVersion');
  if (!from) return [agentTo ? `Agent update pending → ${agentTo}` : 'Agent update pending'];
  const rows: string[] = [];
  for (const { key, label, column } of lines()) {
    const a = from[key];
    const b = to(column);
    if (a && b && a !== b) rows.push(`${label} update pending: ${a} → ${b}`);
  }
  // Same numbers, new code: a rebuilt agent of the same version.
  return rows.length ? rows : [agentTo ? `Agent update pending: new build of ${agentTo}` : 'Agent update pending'];
}
