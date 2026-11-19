import type { AccountResetGrant, AccountResetOutcome, AccountResets } from '@/lib/server/hub/types';

/**
 * Banked limit resets (CLAUDE.md §14.126), as the providers describe them →
 * one neutral shape (`AccountResets`) riding the account's usage reading.
 * Pure: the engine fetches, these read.
 */

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Soonest expiry first (use it or lose it); never-expiring last. */
function byExpiry(a: AccountResetGrant, b: AccountResetGrant): number {
  const ta = a.expiresAt ? Date.parse(a.expiresAt) : Infinity;
  const tb = b.expiresAt ? Date.parse(b.expiresAt) : Infinity;
  return ta - tb || a.id.localeCompare(b.id);
}

function total(grants: AccountResetGrant[]): number {
  return grants.reduce((n, g) => n + g.left, 0);
}

/** Claude's `cedar_ember` block (`/api/oauth/usage?cedar_ember=1`). Spent
 *  grants are dropped: nothing left to offer. null = no block. */
export function claudeResets(block: unknown): AccountResets | null {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const b = block as Record<string, any>;
  const grants: AccountResetGrant[] = [];
  for (const g of Array.isArray(b.grants) ? b.grants : []) {
    if (!g || typeof g !== 'object' || !str(g.id)) continue;
    const left = Number.isInteger(g.resets_left) && g.resets_left > 0 ? g.resets_left as number : 0;
    if (!left) continue;
    const used: Record<string, number> = {};
    if (g.percent_used && typeof g.percent_used === 'object') {
      for (const [k, v] of Object.entries(g.percent_used)) if (typeof v === 'number' && Number.isFinite(v)) used[k] = v;
    }
    const blockedBy = g.paused === true ? 'paused'
      : str(g.unavailable_reason)
        ?? (g.use_requires_limit === true && g.usable_now !== true ? 'needs_limit' : null);
    grants.push({
      id: g.id,
      title: str(g.label) ?? 'Limit reset',
      clears: Array.isArray(g.clears) ? g.clears.filter((c: unknown): c is string => typeof c === 'string') : [],
      used: Object.keys(used).length ? used : null,
      left,
      expiresAt: iso(g.ends_at),
      usable: g.usable_now === true && g.paused !== true,
      blockedBy: g.usable_now === true ? null : blockedBy,
    });
  }
  grants.sort(byExpiry);
  return {
    available: total(grants),
    grants,
    ineligible: b.eligible === false ? str(b.ineligible_reason) ?? 'unknown' : null,
    cooldownUntil: iso(b.cooldown_until),
  };
}

/** Codex: `wham/usage`'s `rate_limit_reset_credits` (the count) and, when
 *  read, `wham/rate-limit-reset-credits` (the credits). Without details the
 *  count stands as ONE anonymous grant (`*`): a claim then lets the backend
 *  pick the next credit. null = no count. */
export function codexResets(summary: unknown, details?: unknown): AccountResets | null {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const s = summary as Record<string, unknown>;
  const count = typeof s.available_count === 'number' && s.available_count > 0 ? Math.floor(s.available_count) : 0;
  // Absent = an older backend: let the provider judge on claim.
  const applicable = typeof s.applicable_available_count === 'number' ? s.applicable_available_count : null;
  const nothingNow = applicable === 0;
  const grants: AccountResetGrant[] = [];
  const credits = details && typeof details === 'object' && Array.isArray((details as { credits?: unknown }).credits)
    ? (details as { credits: unknown[] }).credits : null;
  for (const c of credits ?? []) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    if (!str(r.id) || (r.status !== undefined && r.status !== 'available')) continue;
    const plan = r.is_supported_by_plan !== false;
    grants.push({
      id: r.id as string,
      title: str(r.title) ?? 'Full reset',
      description: str(r.description),
      clears: ['all'],
      used: null,
      left: 1,
      expiresAt: iso(r.expires_at),
      usable: plan && !nothingNow,
      blockedBy: !plan ? 'plan' : nothingNow ? 'nothing_to_reset' : null,
    });
  }
  if (!credits && count) {
    grants.push({ id: '*', title: 'Full reset', clears: ['all'], used: null, left: count, expiresAt: null,
      usable: !nothingNow, blockedBy: nothingNow ? 'nothing_to_reset' : null });
  }
  grants.sort(byExpiry);
  return { available: credits ? total(grants) : count, grants, ineligible: null, cooldownUntil: null };
}

/** A claim's verdict, in the neutral words (`AccountResetOutcome`). */
export function claudeClaimOutcome(body: unknown): { outcome: AccountResetOutcome; reason: string | null; left: number | null } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const map: Record<string, AccountResetOutcome> = {
    reset: 'reset', already_used: 'already_used', not_limited: 'nothing_to_reset',
    cooldown: 'cooldown', ineligible: 'ineligible', unavailable: 'unavailable',
  };
  return {
    outcome: map[String(b.result)] ?? 'unavailable',
    reason: str(b.reason),
    left: typeof b.resets_left === 'number' ? b.resets_left : null,
  };
}

export function codexClaimOutcome(body: unknown): { outcome: AccountResetOutcome; reason: string | null } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const map: Record<string, AccountResetOutcome> = {
    reset: 'reset', nothing_to_reset: 'nothing_to_reset', no_credit: 'no_credit', already_redeemed: 'already_used',
  };
  return { outcome: map[String(b.code)] ?? 'unavailable', reason: null };
}

/** After a spent reset: one less in its grant (gone at zero). */
export function spendGrant(resets: AccountResets, grantId: string, left?: number | null): AccountResets {
  const grants = resets.grants
    .map((g) => (g.id === grantId ? { ...g, left: left ?? g.left - 1 } : g))
    .filter((g) => g.left > 0);
  return { ...resets, grants, available: Math.max(0, resets.available - 1) };
}
