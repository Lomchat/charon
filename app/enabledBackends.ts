import type { AgentKind } from '@/lib/types/api';
import { PROVIDERS, SESSION_PROVIDERS } from '@/lib/sessionCapabilities';

// ── Which backends this hub OFFERS (`<provider>.enabled`) ───────────────────
// A DISPLAY switch, not a capability (that is lib/sessionCapabilities.ts) and
// not a per-VPS availability (that is app/vpsHealth.tsx § backendAvailability):
// turning a backend off only hides its launchers — the per-VPS ＋ button,
// the tab-bar ＋ button and the backend's row in the new-session wizard. Running
// sessions of that kind keep running, keep streaming and stay in the sidebar; a
// hub that only ever uses one backend simply stops showing the other one's
// buttons everywhere.
//
// The default is ON everywhere it is read, and "on" is anything that isn't the
// literal string 'false': a settings fetch that failed, a key never written or
// a stale browser must never subtract a backend from the UI.
//
// Every list here is DERIVED from the provider registry — this file used to
// carry its own copy of the provider list plus a hard-coded object literal per
// helper, which is three more places a new backend had to be remembered in.

export const AGENT_KINDS: readonly AgentKind[] = SESSION_PROVIDERS;

export type EnabledBackends = Record<AgentKind, boolean>;

/** What a hub offers before anyone has chosen — each provider's declared
 *  `defaultEnabled`. Used as the pre-load state and as the fallback when the
 *  settings fetch fails, so a backend that ships OFF never flashes on. */
export const DEFAULT_BACKENDS: EnabledBackends = Object.fromEntries(
  AGENT_KINDS.map((k) => [k, PROVIDERS[k].settings.defaultEnabled]),
) as EnabledBackends;

/** @deprecated Use {@link DEFAULT_BACKENDS} — kept so a stale import cannot
 *  silently mean "every backend on" for a provider that ships off. */
export const ALL_BACKENDS_ENABLED = DEFAULT_BACKENDS;

export function enabledBackendsFromSettings(s: Record<string, string> | null | undefined): EnabledBackends {
  return Object.fromEntries(AGENT_KINDS.map((k) => {
    const stored = s?.[PROVIDERS[k].settings.enabledKey];
    // A key the settings map does not carry (failed fetch, stale browser) falls
    // back to the DECLARED default rather than to "on": that rule exists so a
    // fetch failure cannot subtract a backend, and adding one nobody enabled
    // breaks it just as badly. Anything else than the literal 'false' is on, so
    // a typo still cannot hide a configured backend.
    if (stored === undefined) return [k, PROVIDERS[k].settings.defaultEnabled];
    return [k, stored !== 'false'];
  })) as EnabledBackends;
}

/**
 * Do two switch sets agree on EVERY provider?
 *
 * Exists because the caller that needed it wrote the comparison by hand —
 * `prev.claude === next.claude && prev.codex === next.codex` — and a third
 * provider silently fell outside it: the settings fetch returned
 * `cursor.enabled: true`, the two named backends matched, so the whole object
 * was discarded and Cursor stayed at its `defaultEnabled: false` forever. Every
 * Cursor launcher was missing from the sidebar and the wizard, and nothing
 * anywhere said why. Derived from `AGENT_KINDS`, so provider n+1 is covered by
 * construction (§14.102).
 */
export function sameBackends(
  a: EnabledBackends | null | undefined, b: EnabledBackends | null | undefined,
): boolean {
  if (!a || !b) return a === b;
  return AGENT_KINDS.every((k) => a[k] === b[k]);
}

/** The enabled kinds, in the canonical registry order (may be empty). */
export function enabledKinds(e: EnabledBackends | null | undefined): AgentKind[] {
  const enabled = e ?? DEFAULT_BACKENDS;
  return AGENT_KINDS.filter((k) => enabled[k]);
}
