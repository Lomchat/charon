import { PROVIDERS, asSessionProvider, type SessionProvider } from './sessionCapabilities';

/**
 * THE one place a user-visible sentence is allowed to name a backend.
 *
 * Charon shows a provider's name in a dozen places — a thinking bar, an
 * availability warning, a sign-in prompt, a notification, a picker's "inherit"
 * option. Every one of them used to build its own sentence, so a hard-coded
 * "Claude" could slip into any of them and only a human running the app would
 * ever notice. It did, repeatedly: the wizard said "⚠ Claude: not installed"
 * about Cursor, the chat said "Claude is thinking" on a Cursor turn, the
 * sidebar offered to "scan existing Claude sessions" for every backend.
 *
 * The rule that replaces all that:
 *
 *   1. Identity is narrowed ONCE, by `asSessionProvider()` — never by a
 *      `k === 'codex' ? … : …` ternary, which silently routes a new provider
 *      into an old one's branch (§14.102).
 *   2. Words come from HERE. A component asks for a sentence; it never writes
 *      a provider's name itself.
 *
 * `tests/providerLabels.test.ts` enforces both, and lists the few modules that
 * ARE one provider's own mechanism and may therefore say its name.
 *
 * Adding a backend changes nothing in this file: every sentence is built from
 * the registry's `label`. Rewording one changes exactly one line.
 */

type Kind = SessionProvider | string | null | undefined;

/** Display name — the atom every sentence below is built from. */
export function providerName(kind: Kind): string {
  return PROVIDERS[asSessionProvider(kind)].label;
}

export const providerText = {
  /** Transient bar while a turn runs. */
  thinking: (kind: Kind) => `${providerName(kind)} is thinking`,

  /** Composer placeholder, long and short forms. */
  composerHint: (kind: Kind, touch: boolean) => (touch
    ? `message to ${providerName(kind)} — use 📎 to attach (Enter for newline, tap send to send)`
    : `message to ${providerName(kind)} — drop a file anywhere or use 📎 (Enter sends, Shift/Ctrl+Enter for newline)`),

  /** "<Provider>: not signed in" — a blocker line that must name its OWN
   *  backend, since several can be broken independently on one VPS. */
  blocker: (kind: Kind, reason: string) => `${providerName(kind)}: ${reason}`,

  /** Auth-expiry bubble and its call to action. */
  signInExpired: (kind: Kind) =>
    `${providerName(kind)} is not signed in on this VPS — this session cannot continue until it is renewed.`,
  signInAction: (kind: Kind) => `Sign in to ${providerName(kind)}`,
  signOutOnVps: (kind: Kind) => `Sign out ${providerName(kind)} on this VPS`,

  /** Import/scan entry point — provider-agnostic, so it must say WHICH. */
  scanSessions: (kind: Kind) => `scan existing ${providerName(kind)} sessions (import)`,

  /** Picker "inherit" option when no per-session value is set. */
  inheritDefault: (kind: Kind) => `inherit (${providerName(kind)} default)`,

  /** Push/Telegram bodies. */
  finishedPlanning: (kind: Kind) => `${providerName(kind)} finished planning — tap to approve`,
  finishedTurn: (kind: Kind) => `${providerName(kind)} finished its response`,

  /** Account usage a provider exposes no API for (`usageDashboardUrl`). The
   *  cell says WHY it is empty and what to click — "Unavailable" alone reads as
   *  a bug in Charon rather than a limit of the backend. */
  usageOnWebOnly: (kind: Kind) => `${providerName(kind)} publishes no usage API`,
  usageOpenDashboard: (kind: Kind) => `Open the ${providerName(kind)} usage page`,

  /** A launcher whose backend is not signed in yet. It IS the sign-in button
   *  too, so the tooltip's second line has to say that clicking does something
   *  other than what the first line promises. */
  launchBlockedSignIn: (kind: Kind) =>
    `${providerName(kind)} — not signed in, click to sign in`,
  /** Same, when the click cannot repair it: a missing runtime is installed by
   *  the agent bar, not by a launcher. */
  launchBlocked: (kind: Kind, reason: string) => `${providerName(kind)} — ${reason}`,

  /** Settings switch row. */
  backendAvailable: (kind: Kind) => `${providerName(kind)} available in this hub`,

  /** Session/agent nouns used in launchers and tabs. */
  agentNoun: (kind: Kind) => `${providerName(kind)} agent`,
  /** Bare display name, for a sentence that composes it itself. */
  agentLabel: (kind: Kind) => providerName(kind),
  newAgent: (kind: Kind) => `new ${providerName(kind)} agent`,
  review: (kind: Kind) => `Run ${providerName(kind)} code review`,

  // ── Copy that is genuinely about ONE backend ─────────────────────────────
  // It lives here too, deliberately. "Only shared surfaces use this file"
  // would send provider-specific sentences back into components, which is
  // exactly where they get missed. One file to reword anything.

  /** Fork target description, per (source → target) pair. */
  forkChoice: (source: Kind, target: Kind) => (
    asSessionProvider(source) === asSessionProvider(target)
      ? `Native ${providerName(target)} branch`
      : `Imports the conversation into a new ${providerName(target)} session`),

  /** Claude keeps a conversation pinned to the model it started on (§14.35);
   *  the others apply a change on the next turn, so they get no warning. */
  modelChangeNote: (kind: Kind): string | null => (
    asSessionProvider(kind) === 'claude'
      ? `An existing ${providerName(kind)} conversation may keep its original model.`
        + ' Use Fork to switch models while preserving history.'
      : null),

  /** §14.100 — which on-disk settings files a session loads. Claude-only. */
  settingScopeTitle: (scope: string | null | undefined) =>
    `${providerName('claude')} settings files loaded on this VPS — ${scope || 'inheriting the hub default'}`,
  settingScopeAria: () => `${providerName('claude')} settings scope`,
  settingScopeHeading: () => `${providerName('claude')} settings on`,
  settingScopeLead: () =>
    `${providerName('claude')} sessions running on this machine read the files you tick below.`
    + ' Anything not ticked is ignored, including the rules it contains.',

  /** A backend that reports no per-file edit snapshots (`editSnapshot:'none'`)
   *  — the diffs tab must say why it is empty rather than read as broken. */
  noEditSnapshots: (kind: Kind) =>
    `${providerName(kind)} reports no per-file snapshots — use the git tab to see this session’s changes`,

  /** A provider with no per-item stop API (§14.91). */
  cannotStopItem: (kind: Kind) =>
    `${providerName(kind)} cannot stop this item on its own — interrupt the turn to stop its work`,
  /** Same fact, phrased for the bar's inline hint rather than a thrown error. */
  noPerItemStop: (kind: Kind) =>
    `${providerName(kind)} has no per-item stop for this kind of work — interrupt the turn to end it`,

  /** The exit-plan card's subtitle (§10). */
  planReady: (kind: Kind) => `${providerName(kind)} is done planning — review and choose`,

  /** The permission-mode radio group beside the composer. */
  modeSwitchAria: (kind: Kind) => `${providerName(kind)} permission mode`,

  /** Settings, per-backend section. */
  newSessionDefaults: (kind: Kind) => `defaults for new ${providerName(kind)} sessions`,
  /** A per-session override of the runtime executable's path. */
  binaryPath: (kind: Kind) => `${providerName(kind)} binary`,
  /** The fleet default for a provider that owns its own approval reviewer. */
  autoReviewDefault: (kind: Kind) =>
    `let the ${providerName(kind)} reviewer decide approvals for new sessions`,
  /** Its permission profiles, readable only from a live session (§14.96). */
  profilesUnavailable: (kind: Kind) =>
    `profiles unavailable until the ${providerName(kind)} session is running on a compatible agent`,
} as const;

/**
 * Permission-mode labels, per provider.
 *
 * Each backend's ladder means something different — Claude asks per tool,
 * Codex sandboxes, Cursor has no card at all and the mode IS the gate — so the
 * wording has to be per provider, and it belongs with the other words.
 */
export const MODE_LABELS: Record<string, string> = {
  // Claude
  normal: 'normal — ask before tools',
  acceptEdits: 'accept edits — edits without asking',
  auto: 'accept all — never ask',
  plan: 'plan mode — read and plan',
  // Codex
  'read-only': 'read only — no writes',
  'workspace-write': 'workspace — write inside the project',
  'full-access': 'full access — unrestricted sandbox, approvals remain',
  'accept-all': 'accept all — unrestricted and never ask',
  // Cursor: no per-request card, so each rung must say what it costs.
  sandbox: 'sandbox — writes confined to a sandbox',
  agent: 'agent — its own reviewer vets risky calls',
  force: 'force — every tool call runs unreviewed',
};

/**
 * The composer's mode switch, per mode: a glyph, a SHORT label (the row is
 * 4 buttons wide in a 280px column) and the tooltip that explains the cost.
 *
 * Keyed by MODE, not by provider: `plan` means the same thing to the two
 * backends that have it, and the radio group renders `sessionModes(kind)`
 * straight from the registry. Before this, the group was an `isCodex ? … : …`
 * over a three-member union, so a Cursor session was offered Claude's four
 * modes — and clicking one sent `'normal'`, which the agent silently coerced
 * to `agent`: from `plan` that is a silent grant of write access (§14.102).
 */
export const MODE_SWITCH_META: Record<string, { glyph: string; label: string; title: string }> = {
  // Claude
  normal: { glyph: '▷', label: 'normal', title: 'normal — asks permission for every tool' },
  acceptEdits: { glyph: '▶▶', label: 'accept edits', title: 'accept edits — auto-accepts file edits, asks for the rest' },
  auto: { glyph: '▶▶', label: 'accept all', title: 'accept all — accepts everything without asking (DANGER)' },
  plan: { glyph: '⏸', label: 'plan mode', title: 'plan mode — proposes a plan without running tools' },
  // Codex
  'read-only': { glyph: '⊘', label: 'read only', title: 'read-only — can read files & run read-only commands; no writes' },
  'workspace-write': { glyph: '✎', label: 'workspace', title: 'workspace write — can edit files in the workspace; network off by default' },
  'full-access': { glyph: '⚡', label: 'full access', title: 'full access — no sandbox, but sensitive actions can still request approval (DANGER)' },
  'accept-all': { glyph: '▶▶', label: 'accept all', title: 'accept all — no sandbox and no approval prompts (DANGER)' },
  // Cursor — the mode IS the gate here, so each tooltip says what it costs.
  sandbox: { glyph: '⊡', label: 'sandbox', title: 'sandbox — writes are confined to the SDK sandbox; its own reviewer stays on' },
  agent: { glyph: '✎', label: 'agent', title: 'agent — normal access, with the provider’s own reviewer vetting risky calls' },
  force: { glyph: '⚡', label: 'force', title: 'force — every tool call runs unreviewed, with no sandbox (DANGER)' },
};
