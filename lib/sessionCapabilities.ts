/** Provider REGISTRY + behaviour contract, shared by client routes, UI and
 *  server code.
 *
 *  ── Adding a provider ──────────────────────────────────────────────────────
 *  Append its id to SESSION_PROVIDERS, then follow the compile errors: every
 *  table below is a `Record<SessionProvider, …>`, so the checker names each
 *  decision that still needs an answer instead of letting the newcomer inherit
 *  someone else's.
 *
 *  ⚠ The rule this file exists to enforce: **never re-express a per-provider
 *  value as `p === 'codex' ? a : b` at a call site.** That shape keeps
 *  compiling when the union grows and silently routes every new provider into
 *  the Claude branch — a whole backend running under another one's timeouts,
 *  labels, settings keys and permission semantics, with a green typecheck.
 *  Put the value in a descriptor here and read it by key.
 *
 *  Levels and values describe Charon's DELIVERED semantics, not the version
 *  installed on one VPS. Runtime support must still degrade on JSON-RPC
 *  -32601/capability discovery; never use this matrix as an agent-version gate.
 */

import { isModelParamSet } from './modelParams';

/** THE declaration point. Everything else in Charon derives from this array. */
export const SESSION_PROVIDERS = ['claude', 'codex', 'cursor'] as const;
export type SessionProvider = typeof SESSION_PROVIDERS[number];

/** The provider an unlabelled/legacy row belongs to. Charon shipped Claude-only,
 *  so every `kind`-less historical row is Claude — this is a data fact, not a
 *  preference, and must not be repointed at a newer backend. */
export const DEFAULT_SESSION_PROVIDER: SessionProvider = 'claude';

export type CapabilityLevel = 'native' | 'adapted' | 'none';

export type ClaudeMode = 'normal' | 'acceptEdits' | 'auto' | 'plan';
/** Historical name kept for API compatibility. `accept-all` is a combined
 * Codex mode: danger-full-access sandbox plus approvalPolicy=never. */
export type CodexSandboxMode =
  | 'read-only' | 'workspace-write' | 'full-access' | 'accept-all';
/** Cursor's freedom ladder. The SDK's own `mode` is only `agent`|`plan`; the
 *  other two rungs combine it with `sandbox_options.enabled` and the per-send
 *  `force` flag, which is what a user actually thinks of as "how much rope". */
export type CursorMode = 'plan' | 'sandbox' | 'agent' | 'force';
export type SessionMode = ClaudeMode | CodexSandboxMode | CursorMode;

export const CURSOR_MODES: readonly CursorMode[] = ['plan', 'sandbox', 'agent', 'force'];

export const CLAUDE_PERMISSION_MODES: readonly ClaudeMode[] = [
  'normal', 'acceptEdits', 'auto', 'plan',
];
export const CODEX_SANDBOX_MODES: readonly CodexSandboxMode[] = [
  'read-only', 'workspace-write', 'full-access', 'accept-all',
];

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;
export const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ClaudeEffort = typeof CLAUDE_EFFORTS[number];
export type CodexEffort = typeof CODEX_EFFORTS[number];
export type SessionEffort = ClaudeEffort | CodexEffort;

export type SessionCapability =
  | 'fork' | 'crossProviderFork' | 'compact' | 'rewind' | 'review' | 'archive'
  | 'stableHandle' | 'peerMessaging' | 'permissions' | 'contextUsage'
  | 'turnUsage' | 'structuredOutput' | 'skills' | 'mcp' | 'subagents'
  | 'backgroundWork' | 'fallbackModel' | 'exitPlan' | 'safeFileRevert'
  | 'autoReviewer' | 'permissionProfiles' | 'apps' | 'slashCommands'
  | 'mcpToggle' | 'mcpOauth'
  // Provider-side allow-list of tool NAMES a human approval can be remembered
  // against. Broad provider-authored labels ("Codex command") must never be
  // remembered — the grant would cover unrelated later work (§14.8).
  | 'toolNameAllowList';

export type SessionCapabilityMap = Readonly<Record<SessionCapability, CapabilityLevel>>;

/** A fix button that signs this provider in. Grows with the union by
 *  construction, so `VpsFixAction` can never fall behind the registry. */
export type ProviderLoginAction = `${SessionProvider}-login`;

/** How a VPS row records "is this backend usable on this box".
 *
 *  Column NAMES rather than accessors: the same descriptor is read by the
 *  browser (from the serialized `Vps`) and by Drizzle server-side, and a
 *  string key is the only shape both can use. `providerBackendState()` below
 *  is the one reader — call sites must not touch the columns directly, or
 *  provider #3 needs another 40 edits. When these columns eventually become a
 *  `vpsBackends` table, only that function changes. */
export type ProviderBackend = {
  /** How the row proves the runtime is installed on this box:
   *  - `flag`: a dedicated 1/0/NULL column (Codex: `codexAvailable`), where
   *    NULL genuinely means "this agent never reported it".
   *  - `version`: the presence of a version string (Claude: `sdkVersion` — the
   *    SDK is the agent's own dependency, so a reported version IS the proof).
   *
   *  `blocksLaunch` says whether "absent" may forbid starting a session.
   *  FALSE for a `version` signal: agents <0.12.0 simply omit `sdk_version`
   *  (§14.53's no-null-clobber rule), so absence there is a reporting gap, not
   *  evidence the runtime is missing — the health chip warns, the ＋ button
   *  stays live. */
  availability: {
    via: 'flag' | 'version';
    column: string;
    blocksLaunch: boolean;
  };
  loggedInColumn: string;
  loggedInCheckedAtColumn: string;
  /** How to read a NULL login flag. Claude re-verifies on a 24h TTL, so NULL
   *  means "never verified" and is worth surfacing before a session fails with
   *  an auth error; Codex's probe is newer, so NULL is routinely just an agent
   *  that predates it and must not hide the launcher. Explicit per provider
   *  because the two answers used to differ by accident, chip and launcher
   *  disagreeing on the same row. */
  loginUnknownIsUsable: boolean;
  /** Every package this backend is judged STALE on — one entry per release
   *  line (Codex has two: the Python SDK and the standalone CLI, §14.59).
   *
   *  Carries what BOTH consumers need, so neither re-lists them: the health
   *  chip (§14.60) and the fleet auto-update axes (`sdkWatch`, §14.53). A
   *  release line declared here is enrolled in both; one that is missing is
   *  a package that silently never updates. */
  versions: readonly {
    /** `vps` column holding the installed version. `UpdateAgentResult` uses
     *  the SAME field name to report the post-update version — not a
     *  coincidence, both name one package's version, and `tests/
     *  providerRegistry` pins it so the axis can read its own result back. */
    column: string;
    /** Compact label on the health chip ('sdk', 'cli'). */
    chipLabel: string;
    /** Package name as a human knows it ('claude-agent-sdk'). */
    packageLabel: string;
    /** Compact form inside a per-VPS update transition ('claude', 'cli'). */
    short: string;
    /** Key naming this line's `latest` version (`sdkSync § latestVersionsByKey`,
     *  and the same key in `diagnoseVps`'s opts). */
    latestKey: string;
    /** SETTINGS key the freshness sync writes that latest into. Declared rather
     *  than derived from `notifiedKey` by string surgery: the two prefixes
     *  already disagree (Claude's is `sdk.`, not `claude.`), so guessing one
     *  from the other is how a release line reads back as blank. */
    latestSettingKey: string;
    /** Settings key remembering we already announced this version, so the
     *  Telegram heads-up fires once per release, not once per VPS (§14.53). */
    notifiedKey: string;
    /** True when the package is installed INDEPENDENTLY of the pyz (the npm
     *  CLI), so an agent update can succeed while this line stays behind.
     *  That is a PARTIAL failure the tick must retry, never bank as done. */
    independentInstall: boolean;
  }[];
  /** Venv package, named in the "… not in the venv" health detail. */
  packageName: string;
  /** One clause completing "installed but not signed in — …". */
  signInHint: string;
  login: { action: ProviderLoginAction; label: string; title: string };
  /** Repair offered when the runtime is absent or unreported. Always an agent
   *  update: every backend is installed by the same bootstrap/update flow. */
  install: { label: string; title: string };
};

export type ProviderDescriptor = {
  id: SessionProvider;
  /** Display name. THE single source for user-visible provider text. */
  label: string;
  /** 128×128 chip under public/agents/. */
  logo: string;
  modes: readonly SessionMode[];
  /** Safe source default. Instance settings may override it for new sessions;
   *  a corrupted persisted value always falls back here. */
  defaultMode: SessionMode;
  /** Reasoning levels this provider exposes as a SEPARATE axis, as a fixed
   *  vocabulary. EMPTY is a real answer, and it does NOT mean "no control" —
   *  read `effortAxis` for that. */
  efforts: readonly SessionEffort[];
  /** Where a HUMAN can read account usage, when the provider exposes no API
   *  that Charon could poll.
   *
   *  `null` means the gauges ARE the answer (Claude and Codex both have an
   *  endpoint, §14.58/59). A url means the opposite is true and permanent: no
   *  supported endpoint exists for a personal account, so the honest UI is a
   *  link to the page that does show it, not an empty meter labelled
   *  "Unavailable" — which reads as a bug in Charon rather than as a limit of
   *  the provider. */
  usageDashboardUrl: string | null;
  /** What a turn's reported `cost_usd` MEANS — the question that decides
   *  whether showing it is information or noise.
   *
   *  `'billed'`     money actually charged for that turn. Worth a number: it
   *                is the only thing that tells the user what a session spent.
   *  `'equivalent'` a list-price VALUATION of the tokens, computed by the SDK.
   *                The account is metered in quota, not dollars, so the figure
   *                bills nobody — it reads as a charge and is not one. Charon
   *                keeps recording it (the `turn_usage` rows stay complete) and
   *                simply does not price a turn the user does not pay for.
   *  `'none'`       the backend reports no cost at all.
   *
   *  Declared here rather than tested as `kind === 'cursor'` because it is a
   *  question every backend owes an answer to, and a new one whose cost IS
   *  billed must not inherit silence (§14.102). */
  turnCost: 'billed' | 'equivalent' | 'none';
  /** What an `edit_snapshot` row from this backend CONTAINS.
   *
   *  `'contents'` a before/after pair Charon diffs itself — the only shape a
   *              side-by-side split and a safe revert can work from.
   *  `'patch'`    a ready-made unified diff in `after`; there is no clean
   *              "before" to restore, so the tab renders it raw.
   *  `'none'`     the backend reports no per-file snapshots at all.
   *
   *  Declared because the diffs tab used to read it as `kind === 'codex'`, so a
   *  backend with NO snapshots was handed Claude's before/after renderer and
   *  offered a revert button for edits it has no pre-image of. */
  editSnapshot: 'contents' | 'patch' | 'none';
  /** Shape of the agent's thinking events; independent of the chosen model. */
  thinkingDelivery: 'block' | 'delta';
  /** WHERE the effort vocabulary comes from — the question every consumer of
   *  `efforts` actually has, and one only the provider can answer.
   *
   *  `'static'` the `efforts` list IS the vocabulary. A picker may still narrow
   *            it per model from a live catalog (Codex does) and the route may
   *            still accept extra levels the catalog reports (Claude does), but
   *            there is a hub-side superset to validate against.
   *  `'model'`  each MODEL declares its own knobs, so there is no superset: the
   *            picker fills from the selected model and the stored value is a
   *            parameter set (`lib/modelParams.ts`). `efforts` is empty.
   *  `'none'`   the provider has no reasoning axis at all; hide the control
   *            rather than showing furniture that claims a setting exists.
   *
   *  Gating the UI on `efforts.length > 0` conflates the last two, which is how
   *  Cursor's real per-model ladder stayed invisible behind an empty list. */
  effortAxis: 'static' | 'model' | 'none';
  /** Provider-side deadline on an unanswered human gate, in seconds — the
   *  value the card counts down to when the agent is too old to send its own
   *  `expires_at` (§14.98). */
  interactionTimeoutS: { permission: number; question: number };
  capabilities: SessionCapabilityMap;
  backend: ProviderBackend;
  /** Provider-OWNED JSON-RPC methods whose MEANING is neutral.
   *
   *  The protocol still carries provider-prefixed names (`codex_*`, §6) because
   *  renaming them is an agent change and a version bump for every VPS. Naming
   *  them HERE lets the routes stay generic: the archive route asks the registry
   *  for "this provider's archive method" instead of testing for Codex. `null`
   *  means Charon adapts the feature hub-side (Claude's archive lives in SQLite
   *  alone) — the same distinction the `archive`/`fork` capability levels draw,
   *  and it stays consistent because both come from this one table. */
  nativeRpc: {
    /** Mirror the archive/unarchive state in the provider's own store. */
    archive: string | null;
    unarchive: string | null;
    /** List the exact turn anchors a native fork may branch at (§14.94). */
    forkPoints: string | null;
  };
  /** How this backend REACHES a VPS and how its history is imported.
   *
   *  The implementations stay bespoke — each runtime installs differently (pip
   *  package, npm binary, curl script) and stores its transcripts its own way,
   *  and pretending otherwise would produce a generic installer that fits
   *  nobody. These are the ENROLMENT: `tests/providerRegistry` checks each name
   *  is really wired, so a new backend cannot be silently left out of the
   *  bootstrap (installed on no VPS) or of the import tab (history
   *  unreachable) — the two omissions that look like "the feature is broken"
   *  rather than "the provider was forgotten". */
  deployment: {
    /** `bootstrap.ts § BootstrapPhase` that installs this runtime on a VPS. */
    installPhase: string;
    /** Directory answering the import scan: `/api/vps/[id]/<dir>/scan`. */
    scanRouteDir: string;
  };
  /** Settings keys that are NOT derivable from the id.
   *
   *  `<id>.default_model` / `_effort` / `_permission_mode` follow the
   *  convention and are built by `providerSettingKey`. These two do not:
   *  `enabledKey` is read by the browser from a plain settings map, and
   *  Claude's auto-update gate is the historical `sdk.auto_update`, NOT
   *  `claude.auto_update` — an asymmetry worth declaring rather than
   *  rediscovering when a backend silently never auto-updates. */
  settings: {
    enabledKey: string;
    autoUpdateKey: string;
    /** Is this backend offered on a hub nobody has configured yet?
     *
     *  FALSE for a newcomer: it needs a runtime installed and an account signed
     *  in before it can do anything, so showing its launchers on every VPS the
     *  day it ships is noise the operator did not ask for. The two originals
     *  stay TRUE — turning them off on upgrade would look like data loss. */
    defaultEnabled: boolean;
  };
};

export const PROVIDERS: Readonly<Record<SessionProvider, ProviderDescriptor>> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    logo: '/agents/claude.png',
    modes: CLAUDE_PERMISSION_MODES,
    defaultMode: 'normal',
    usageDashboardUrl: null,
    // `ResultMessage.total_cost_usd` is the tokens priced at the public API
    // rate. A Charon session signs in with OAuth, so it draws on the plan's
    // quota — the gauges (§14.58) are what that costs, not this.
    turnCost: 'equivalent',
    efforts: CLAUDE_EFFORTS,
    effortAxis: 'static',
    editSnapshot: 'contents',
    thinkingDelivery: 'block',
    interactionTimeoutS: { permission: 601, question: 1801 },
    capabilities: {
      fork: 'native', crossProviderFork: 'adapted', compact: 'native', rewind: 'native',
      review: 'adapted', archive: 'adapted', stableHandle: 'adapted', peerMessaging: 'adapted',
      permissions: 'native', contextUsage: 'native', turnUsage: 'native',
      structuredOutput: 'native', skills: 'native', mcp: 'native', subagents: 'native',
      backgroundWork: 'native', fallbackModel: 'native', exitPlan: 'native',
      safeFileRevert: 'adapted', autoReviewer: 'none', permissionProfiles: 'none',
      apps: 'none', slashCommands: 'native', mcpToggle: 'native', mcpOauth: 'none',
      toolNameAllowList: 'native',
    },
    // Claude's archive is Charon-side only (capability `adapted`) and its fork
    // anchors are the `cliUuid`s already in our rows — no RPC to name.
    nativeRpc: { archive: null, unarchive: null, forkPoints: null },
    deployment: { installPhase: 'install_sdk', scanRouteDir: 'claude' },
    settings: {
      enabledKey: 'claude.enabled', autoUpdateKey: 'sdk.auto_update',
      defaultEnabled: true,
    },
    backend: {
      availability: { via: 'version', column: 'sdkVersion', blocksLaunch: false },
      loggedInColumn: 'claudeLoggedIn',
      loggedInCheckedAtColumn: 'claudeLoggedInCheckedAt',
      loginUnknownIsUsable: false,
      versions: [{
        column: 'sdkVersion', chipLabel: 'sdk',
        packageLabel: 'claude-agent-sdk', short: 'claude',
        latestKey: 'sdkLatestVersion', latestSettingKey: 'sdk.latest_version',
        notifiedKey: 'sdk.last_notified_version',
        independentInstall: false,
      }],
      packageName: 'claude-agent-sdk',
      signInHint: 'run the claude login flow',
      login: {
        action: 'claude-login',
        label: 'claude login',
        title: 'sign in to Claude (hosted OAuth code — no VPS shell needed)',
      },
      install: {
        label: '⇪ update',
        title: 'install/upgrade claude-agent-sdk in the venv',
      },
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    logo: '/agents/codex.png',
    modes: CODEX_SANDBOX_MODES,
    defaultMode: 'workspace-write',
    usageDashboardUrl: null,
    // The app-server sends token counts and no money at all.
    turnCost: 'none',
    efforts: CODEX_EFFORTS,
    effortAxis: 'static',
    // Unified diffs with no pre-image, so no split view and no revert (§14.59).
    editSnapshot: 'patch',
    thinkingDelivery: 'delta',
    interactionTimeoutS: { permission: 1801, question: 1801 },
    capabilities: {
      fork: 'native', crossProviderFork: 'adapted', compact: 'native', rewind: 'native',
      review: 'native', archive: 'native', stableHandle: 'adapted', peerMessaging: 'adapted',
      permissions: 'native', contextUsage: 'native', turnUsage: 'native',
      structuredOutput: 'native', skills: 'native', mcp: 'native', subagents: 'native',
      backgroundWork: 'native', fallbackModel: 'none', exitPlan: 'none',
      safeFileRevert: 'none', autoReviewer: 'native', permissionProfiles: 'native',
      apps: 'native', slashCommands: 'none', mcpToggle: 'none', mcpOauth: 'native',
      // Codex grants are native and scoped to the exact request
      // (acceptForSession / scope:session) — never a hub-side tool-name set.
      toolNameAllowList: 'none',
    },
    nativeRpc: {
      archive: 'codex_archive_thread',
      unarchive: 'codex_unarchive_thread',
      forkPoints: 'codex_fork_points',
    },
    deployment: { installPhase: 'install_codex', scanRouteDir: 'codex' },
    settings: {
      enabledKey: 'codex.enabled', autoUpdateKey: 'codex.auto_update',
      defaultEnabled: true,
    },
    backend: {
      availability: { via: 'flag', column: 'codexAvailable', blocksLaunch: true },
      loggedInColumn: 'codexLoggedIn',
      loggedInCheckedAtColumn: 'codexLoggedInCheckedAt',
      loginUnknownIsUsable: true,
      versions: [
        {
          column: 'codexSdkVersion', chipLabel: 'sdk',
          packageLabel: 'openai-codex', short: 'codex',
          latestKey: 'codexLatestVersion', latestSettingKey: 'codex.latest_version',
          notifiedKey: 'codex.last_notified_version',
          independentInstall: false,
        },
        {
          // The npm release line runs AHEAD of the SDK on purpose (§14.59) and
          // is fetched separately, so the pyz can update while it does not.
          column: 'codexCliVersion', chipLabel: 'cli',
          packageLabel: 'codex-cli', short: 'cli',
          latestKey: 'codexCliLatestVersion', latestSettingKey: 'codex.cli_latest_version',
          notifiedKey: 'codex.last_notified_cli_version',
          independentInstall: true,
        },
      ],
      packageName: 'openai-codex',
      signInHint: 'sign in with the device code',
      login: {
        action: 'codex-login',
        label: 'codex login',
        title: 'sign in to Codex (ChatGPT device code)',
      },
      install: {
        label: '⇩ install codex',
        title: 'install openai-codex in the venv (runs the agent update)',
      },
    },
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    logo: '/agents/cursor.png',
    modes: CURSOR_MODES,
    defaultMode: 'agent',
    // Per-MODEL reasoning: every model ships its own ladder (`effort` /
    // `reasoning` / `reasoning_effort`, with different rungs) plus its own
    // switches, so there is no hub-side vocabulary to list. The effort control
    // fills from the selected model instead (`lib/modelParams.ts`).
    // Measured, not assumed: `/v1/usage`, `/v1/quota` and every sibling are 404
    // (the route does not exist), the `/teams/*` usage routes answer 401
    // "Invalid Team API Key" and need a plan a personal account cannot have,
    // and the dashboard's own endpoint wants a browser session cookie. So the
    // gauges are not coming, and this is where the numbers actually live.
    usageDashboardUrl: 'https://cursor.com/dashboard/spending',
    // Real spend: `raw_cost_cents` off the SDK's own run record (§14.103), and
    // the only per-turn figure in the fleet a user is actually charged for.
    turnCost: 'billed',
    efforts: [],
    effortAxis: 'model',
    // The SDK reports no per-file snapshots, so the diffs tab has nothing of
    // its own to show — the git tab is where a Cursor session's changes are read.
    editSnapshot: 'none',
    thinkingDelivery: 'delta',
    // No human gate today (see `permissions` below), so these only bound a
    // card the provider cannot currently raise.
    interactionTimeoutS: { permission: 601, question: 1801 },
    capabilities: {
      // Archive is the provider's OWN state (`AsyncAgent.archive`), unlike
      // Claude's which lives in SQLite alone.
      archive: 'native',
      // Per-turn tokens arrive as SDK `usage` stream events.
      turnUsage: 'native',
      // Charon passes MCP servers inline; the SDK exposes no inventory/status.
      mcp: 'adapted',
      // Cursor's own safety classifier, enabled per session (`auto_review`).
      autoReviewer: 'native',
      fork: 'none', crossProviderFork: 'adapted', compact: 'none', rewind: 'none',
      review: 'adapted', stableHandle: 'adapted', peerMessaging: 'adapted',
      // ⚠ The SDK has NO approval callback and its hooks are file-based with a
      // fail-OPEN parse bug, so Charon cannot raise a per-request card for
      // Cursor. Freedom is chosen up front through the mode ladder instead.
      // Declaring 'none' keeps the UI honest rather than showing a gate that
      // would never fire.
      permissions: 'none',
      // Token counts exist, the WINDOW size does not — so "how full is the
      // context" has no answer to give.
      contextUsage: 'none',
      structuredOutput: 'none', skills: 'none', subagents: 'none',
      backgroundWork: 'none', fallbackModel: 'none', exitPlan: 'none',
      safeFileRevert: 'none', permissionProfiles: 'none', apps: 'none',
      slashCommands: 'none', mcpToggle: 'none', mcpOauth: 'none',
      toolNameAllowList: 'none',
    },
    nativeRpc: {
      archive: 'cursor_archive_agent',
      unarchive: 'cursor_unarchive_agent',
      forkPoints: null,
    },
    deployment: { installPhase: 'install_cursor', scanRouteDir: 'cursor' },
    settings: {
      enabledKey: 'cursor.enabled', autoUpdateKey: 'cursor.auto_update',
      // Opt-in: it needs `cursor-sdk` installed and an account signed in.
      defaultEnabled: false,
    },
    backend: {
      availability: { via: 'flag', column: 'cursorAvailable', blocksLaunch: true },
      loggedInColumn: 'cursorLoggedIn',
      loggedInCheckedAtColumn: 'cursorLoggedInCheckedAt',
      // The probe ships with this release, so NULL is an agent that predates
      // it — same reading as Codex, and it must not hide the launcher.
      loginUnknownIsUsable: true,
      versions: [{
        // The venv package, which carries its OWN hermetic Node runtime for
        // the SDK bridge. The standalone `cursor-agent` CLI self-updates and
        // Charon deliberately does not drive it — this is the only line Charon
        // owns, so it is the only one on the staleness axis.
        column: 'cursorSdkVersion', chipLabel: 'sdk',
        packageLabel: 'cursor-sdk', short: 'cursor',
        latestKey: 'cursorLatestVersion', latestSettingKey: 'cursor.latest_version',
        notifiedKey: 'cursor.last_notified_version',
        independentInstall: false,
      }],
      packageName: 'cursor-sdk',
      signInHint: 'open the sign-in link',
      login: {
        action: 'cursor-login',
        label: 'cursor login',
        title: 'sign in to Cursor (browser link — no VPS shell needed)',
      },
      install: {
        label: '⇩ install cursor',
        title: 'install cursor-sdk in the venv (runs the agent update)',
      },
    },
  },
};

// ── Identity ────────────────────────────────────────────────────────────────

export function isSessionProvider(value: unknown): value is SessionProvider {
  return typeof value === 'string'
    && (SESSION_PROVIDERS as readonly string[]).includes(value);
}

/** Narrow an untrusted `kind` (request body, DB column, SSE payload).
 *
 *  Replaces the `x === 'codex' ? 'codex' : 'claude'` coercion that used to sit
 *  at ~15 call sites: that one maps EVERY unknown string — including a
 *  provider this build does not know yet — onto Claude, so a newer peer's
 *  session would silently open on the wrong backend. This validates instead,
 *  and the caller picks the fallback (default: the historical provider). */
export function asSessionProvider(
  value: unknown,
  fallback: SessionProvider = DEFAULT_SESSION_PROVIDER,
): SessionProvider {
  return isSessionProvider(value) ? value : fallback;
}

/** Exhaustiveness guard for a `switch (provider)` carrying behaviour that
 *  cannot be expressed as data (a construction path, a transport). Adding a
 *  provider turns every such switch into a compile error — which is the point.
 *
 *  Use it only for POLICY, i.e. a decision each provider owes an answer to.
 *  A branch that is one provider's IMPLEMENTATION DETAIL (Codex's rollout
 *  scan, Claude's error-prose regex) stays a plain `kind === 'codex'` test:
 *  a new provider correctly wants none of it, and forcing an answer there
 *  would be noise. */
export function unhandledProvider(p: never): never {
  throw new Error(`unhandled session provider: ${String(p)}`);
}

/** User-visible provider name ("Claude", "Codex"). */
export function providerLabel(p: SessionProvider): string {
  return PROVIDERS[p].label;
}

// ── Modes & efforts ─────────────────────────────────────────────────────────

export function sessionModes(p: SessionProvider): readonly SessionMode[] {
  return PROVIDERS[p].modes;
}

export function isSessionMode(p: SessionProvider, value: unknown): value is SessionMode {
  return typeof value === 'string' && sessionModes(p).includes(value as SessionMode);
}

export function defaultSessionMode(
  p: SessionProvider,
  _context: 'create' | 'runtime' = 'runtime',
): SessionMode {
  return PROVIDERS[p].defaultMode;
}

export function sessionEfforts(p: SessionProvider): readonly SessionEffort[] {
  return PROVIDERS[p].efforts;
}

export function isSessionEffort(p: SessionProvider, value: unknown): value is SessionEffort {
  if (typeof value !== 'string') return false;
  return (sessionEfforts(p) as readonly string[]).includes(value);
}

/** Does this provider get an effort control at all?
 *
 *  THE gate for rendering one. Never `sessionEfforts(p).length > 0`: an empty
 *  list means "no fixed vocabulary", which is also true of a provider whose
 *  ladder is per model — and hiding the control there loses a real setting. */
export function hasEffortAxis(p: SessionProvider): boolean {
  return PROVIDERS[p].effortAxis !== 'none';
}

/** May Charon put a PRICE on this provider's turns?
 *
 *  THE gate for every dollar figure. Never `cost_usd != null`: a provider that
 *  reports an API-list VALUATION answers that test exactly like one reporting a
 *  charge, and the two mean opposite things to someone on a subscription. */
export function showsTurnCost(p: SessionProvider): boolean {
  return PROVIDERS[p].turnCost === 'billed';
}

/**
 * Is `raw` a value this provider's effort column may hold?
 *
 * Shape for a per-model axis (a parameter set), membership for a static one.
 * Callers that also accept a live catalog vocabulary — Claude's `isKnownEffort`
 * — layer that on top; this is the part every provider owes an answer to.
 */
export function isEffortValue(p: SessionProvider, raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  // Exhaustive by return type: a fourth axis kind fails to compile here rather
  // than falling through to "invalid", which would reject every effort a new
  // provider sends. No `default` on purpose — that is what makes it exhaustive.
  switch (PROVIDERS[p].effortAxis) {
    case 'static': return isSessionEffort(p, raw);
    case 'model': return isModelParamSet(raw);
    case 'none': return false;
  }
}

// ── Settings keys ───────────────────────────────────────────────────────────

/** Build a per-provider settings key. The return type is the DISTRIBUTED
 *  union over every provider, so passing it to `getSetting()` fails to compile
 *  until the new provider's key exists in `SettingKey` — which is exactly the
 *  reminder a new backend needs (defaults, enabled switch, auto-update gate). */
export function providerSettingKey<S extends string>(
  p: SessionProvider,
  suffix: S,
): `${SessionProvider}.${S}` {
  return `${p}.${suffix}` as `${SessionProvider}.${S}`;
}

// ── Capabilities ────────────────────────────────────────────────────────────

export const SESSION_CAPABILITIES: Readonly<Record<SessionProvider, SessionCapabilityMap>> =
  Object.fromEntries(
    SESSION_PROVIDERS.map((p) => [p, PROVIDERS[p].capabilities]),
  ) as Readonly<Record<SessionProvider, SessionCapabilityMap>>;

export function sessionCapabilities(p: SessionProvider): SessionCapabilityMap {
  return PROVIDERS[p].capabilities;
}

export function supportsSessionCapability(
  p: SessionProvider,
  capability: SessionCapability,
): boolean {
  return PROVIDERS[p].capabilities[capability] !== 'none';
}

/** True when the provider implements the capability ITSELF, as opposed to
 *  Charon emulating it (`adapted`). Use it only where the distinction changes
 *  behaviour — a native archive is mirrored provider-side, an adapted one
 *  lives in SQLite alone. */
export function hasNativeCapability(
  p: SessionProvider,
  capability: SessionCapability,
): boolean {
  return PROVIDERS[p].capabilities[capability] === 'native';
}

// ── Backend state on one VPS ────────────────────────────────────────────────

export type ProviderBackendState = {
  /** 1 installed / 0 absent / null never probed. A `version` signal never
   *  yields null: an absent version reads as 0 for the chip, and
   *  `availability.blocksLaunch` decides whether that may block a launch. */
  available: number | null;
  loggedIn: number | null;
  loggedInCheckedAt: number | null;
  /** Installed versions, in descriptor order: the declared release line plus
   *  the value this row carries for it. */
  versions: readonly (ProviderBackend['versions'][number] & { value: string | null })[];
};

/** Read one provider's state off a VPS row.
 *
 *  THE single reader of the per-provider health columns. Everything that
 *  decides "can I start this backend here" goes through it, so provider #3
 *  costs one migration plus one registry entry — not another sweep through
 *  vpsHealth, sessionOps, sdkWatch and the session-create route. */
export function providerBackendState(
  vpsRow: Record<string, unknown> | null | undefined,
  p: SessionProvider,
): ProviderBackendState {
  const b = PROVIDERS[p].backend;
  const num = (key: string): number | null => {
    if (!vpsRow) return null;
    const v = vpsRow[key];
    return typeof v === 'number' ? v : null;
  };
  const str = (key: string): string | null => {
    if (!vpsRow) return null;
    const v = vpsRow[key];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  return {
    available: b.availability.via === 'flag'
      ? num(b.availability.column)
      : (str(b.availability.column) == null ? 0 : 1),
    loggedIn: num(b.loggedInColumn),
    loggedInCheckedAt: num(b.loggedInCheckedAtColumn),
    versions: b.versions.map((x) => ({ ...x, value: str(x.column) })),
  };
}

/** The column patch that records a sign-in verdict for one provider. Keeps the
 *  two writers (`claudeLoginCheck`, the auth-expiry path) from hard-coding a
 *  column name each. */
export function providerLoginPatch(
  p: SessionProvider,
  loggedIn: 0 | 1,
  checkedAt?: number | null,
): Record<string, number> {
  const b = PROVIDERS[p].backend;
  return {
    [b.loggedInColumn]: loggedIn,
    [b.loggedInCheckedAtColumn]: checkedAt ?? Math.floor(Date.now() / 1000),
  };
}
