import { requireApiSession } from '@/lib/server/session';
import { getAccountProfileUsage } from '@/lib/server/agent/usagePoll';
import { requireAccountProfile } from '@/lib/server/agent/accountProfiles';
import { isSessionProvider } from '@/lib/sessionCapabilities';
import type { CachedUsageBatchResponse } from '@/lib/types/api';

// POST /api/usage {targets: [{vpsId, provider, profile}]}
//
// The hub's CACHED usage snapshot of many logins in one request: what the
// header account buttons hydrate at page load and after a resync (one GET
// /api/vps/[id]/usage?cached=1 per VPS × provider × profile was ~80 requests
// per load). Never polls, never awaits an agent: `account_usage` frames carry
// the next readings (§14.72). An unknown target answers null.
export const MAX_USAGE_TARGETS = 500;

export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  let targets: unknown;
  try { targets = (await req.json())?.targets; } catch { targets = null; }
  if (!Array.isArray(targets) || targets.length > MAX_USAGE_TARGETS) {
    return Response.json({ error: `targets: an array of ≤ ${MAX_USAGE_TARGETS}` }, { status: 400 });
  }
  const readings: CachedUsageBatchResponse['readings'] = [];
  for (const t of targets as Array<Record<string, unknown>>) {
    const vpsId = typeof t?.vpsId === 'string' ? t.vpsId : null;
    const provider = t?.provider;
    const profile = typeof t?.profile === 'string' && t.profile ? t.profile : 'default';
    if (!vpsId || !isSessionProvider(provider)) continue;
    let usage = null;
    try {
      requireAccountProfile(vpsId, provider, profile);
      usage = getAccountProfileUsage(vpsId, provider, profile);
    } catch { /* unknown VPS/login: null */ }
    readings.push({ vpsId, provider, profile, usage });
  }
  return Response.json({ readings } satisfies CachedUsageBatchResponse);
}
