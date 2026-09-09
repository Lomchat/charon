import type { AgentKind } from '@/lib/types/api';

// ── Which backends this hub OFFERS (`claude.enabled` / `codex.enabled`) ──────
// A DISPLAY switch, not a capability (that is lib/sessionCapabilities.ts) and
// not a per-VPS availability (that is app/vpsHealth.tsx § backendAvailability):
// turning Claude or Codex off only hides its launchers — the per-VPS ＋ button,
// the tab-bar ＋ button and the backend's row in the new-session wizard. Running
// sessions of that kind keep running, keep streaming and stay in the sidebar; a
// hub that only ever uses one backend simply stops showing the other one's
// buttons everywhere.
//
// The default is ON everywhere it is read, and "on" is anything that isn't the
// literal string 'false': a settings fetch that failed, a key never written or
// a stale browser must never subtract a backend from the UI.

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex'];

export type EnabledBackends = Record<AgentKind, boolean>;

export const ALL_BACKENDS_ENABLED: EnabledBackends = { claude: true, codex: true };

export function enabledBackendsFromSettings(s: Record<string, string> | null | undefined): EnabledBackends {
  return {
    claude: s?.['claude.enabled'] !== 'false',
    codex: s?.['codex.enabled'] !== 'false',
  };
}

/** The enabled kinds, in the canonical claude→codex order (may be empty). */
export function enabledKinds(e: EnabledBackends | null | undefined): AgentKind[] {
  const enabled = e ?? ALL_BACKENDS_ENABLED;
  return AGENT_KINDS.filter((k) => enabled[k]);
}
