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

export const PROVIDER_ACCOUNT_LINKS: Record<SessionProvider, string> = {
  claude: 'https://claude.ai/settings/billing',
  codex: 'https://chatgpt.com/#settings',
  cursor: 'https://cursor.com/dashboard',
};

export function accountAuthLabel(method: string): string | undefined {
  const labels: Record<string, string> = {
    'claude.ai': 'Claude subscription', chatgpt: 'ChatGPT account',
    apiKey: 'API key', api_key: 'API key', api_key_helper: 'API key helper',
    oauth_token: 'OAuth token', third_party: 'External provider',
    amazonBedrock: 'Amazon Bedrock',
  };
  return labels[method];
}

/** Display name — the atom every sentence below is built from. */
export function providerName(kind: Kind): string {
  return PROVIDERS[asSessionProvider(kind)].label;
}

export const providerText = {
  /** Transient bar while a turn runs. */
  thinking: (kind: Kind) => `${providerName(kind)} is thinking`,

  /** Composer placeholder, long and short forms. The touch one stays a single
   *  short line: a phone's box rests at two lines, and a hint that fills them
   *  reads as text already typed. */
  composerHint: (kind: Kind, touch: boolean) => (touch
    ? `Message ${providerName(kind)}…`
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

  /** Header account buttons (app/AccountNav.tsx). `account` is the full
   *  `usageAccountLabel`, which already starts with the provider's name. */
  accountButton: (_kind: Kind, account: string, vpsNames: readonly string[]) =>
    `${account}${vpsNames.length ? ` — on ${vpsNames.join(', ')}` : ''}`,
  accountSessions: (kind: Kind, label: string) => `Recent sessions — ${providerName(kind)} · ${label}`,
  accountNavLabel: 'Accounts',

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
  /** A launcher with several accounts on its VPS: the choice is a menu. */
  chooseAccount: (kind: Kind) => `Choose a ${providerName(kind)} account`,
  accountsLauncher: (kind: Kind, count: number) =>
    `${providerName(kind)} — ${count} accounts on this VPS, point or tap to choose`,
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
  // Claude — the CLI's own modes, plus bypass.
  normal: 'normal — reads pass, the rest asks',
  acceptEdits: 'accept edits — project edits pass too',
  auto: 'auto — Claude’s reviewer decides',
  bypass: 'bypass — accept everything',
  // Claude never offers it any more; Cursor still does.
  plan: 'plan mode — read and plan',
  // Codex — the CLI's /approvals presets, under their CLI names.
  'read-only': 'read only — asks to edit or go online',
  'workspace-write': 'default — edits the project, asks for the rest',
  'accept-all': 'full access — anywhere, never asks',
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
  normal: { glyph: '▷', label: 'normal', title: 'normal — Claude Code’s default: reads and allowed rules pass, everything else asks' },
  acceptEdits: { glyph: '▶▶', label: 'accept edits', title: 'accept edits — file edits and file commands (mkdir, mv, cp…) in the project pass too; the rest asks' },
  auto: { glyph: '◎', label: 'auto', title: 'auto — Claude Code’s own reviewer runs safe actions and refuses risky ones, without asking' },
  bypass: { glyph: '⚡', label: 'bypass', title: 'bypass — every request is accepted, even Claude Code’s own safety checks (DANGER)' },
  plan: { glyph: '⏸', label: 'plan mode', title: 'plan mode — proposes a plan without running tools' },
  // Codex
  'read-only': { glyph: '⊘', label: 'read only', title: 'read only — Codex reads the workspace; approval is required to edit files or access the internet' },
  'workspace-write': { glyph: '✎', label: 'default', title: 'default — Codex edits the workspace and runs commands; approval is required for the internet or edits elsewhere' },
  'accept-all': { glyph: '⚡', label: 'full access', title: 'full access — Codex edits anywhere and uses the internet without asking (DANGER)' },
  // Cursor — the mode IS the gate here, so each tooltip says what it costs.
  sandbox: { glyph: '⊡', label: 'sandbox', title: 'sandbox — writes are confined to the SDK sandbox; its own reviewer stays on' },
  agent: { glyph: '✎', label: 'agent', title: 'agent — normal access, with the provider’s own reviewer vetting risky calls' },
  force: { glyph: '⚡', label: 'force', title: 'force — every tool call runs unreviewed, with no sandbox (DANGER)' },
};

/** Background-work constellation: shared copy for all providers. */
export const backgroundWorkText = {
  activity: 'Activity', agentDetails: 'Agent details', outputResult: 'Output / result', savedActivity: 'Saved activity',
  mission: 'Mission', workflowMission: 'Workflow mission', missionExcerpt: 'Mission excerpt', model: 'Model', phase: 'Phase',
  lastActivity: 'Last activity', action: 'action', file: 'file', error: 'error', actions: 'actions', files: 'files', errors: 'errors', loadedHistory: 'Loaded history', partialHistory: 'Loaded portion of history',
  fileModified: 'Modified', fileRead: 'Read', filePending: 'Result not loaded', noFiles: 'No file operations in the loaded history.',
  earlierActivity: 'Earlier activity ↑', noActivity: 'No tool activity in the loaded history.', retry: 'Retry',
  followingActivity: 'Following latest activity', newActivities: 'new events ↓', newOutputs: 'new messages ↓',
  noWrittenOutput: 'No written result in this part of the transcript. Tool activity is shown above.', jsonFormatted: 'JSON formatted',
  command: 'Command', arguments: 'Details', toolResult: 'Tool result', earlierToolResult: 'Result of an earlier call',
  toolSucceeded: 'Succeeded', toolFailed: 'Failed', resultNotLoaded: 'No result in the loaded history', emptyToolResult: 'Completed without textual output.',
  noToolTarget: 'No readable description is available.', toResult: 'to result',
  toolActions: { Read: 'Read file', Write: 'Write file', Edit: 'Edit file', MultiEdit: 'Edit file', NotebookEdit: 'Edit notebook',
    Bash: 'Run command', Monitor: 'Monitor command', TaskStop: 'Stop task', TaskOutput: 'Read task output', ToolSearch: 'Find tools', TodoWrite: 'Update checklist', Grep: 'Search content', Glob: 'Find files', WebFetch: 'Read webpage', WebSearch: 'Search the web', Agent: 'Delegate task', Task: 'Delegate task' },
  graph: 'Graph', list: 'List', inspect: 'Inspect', output: 'Output', preview: 'Provider preview',
  fileOutput: 'Task output', latest: 'Latest output', reading: 'Reading earlier output',
  latestAction: 'Latest output ↓', waiting: 'No output has been reported yet.',
  previewHint: 'Preview only · the full transcript is not available for this node.',
  earlierOutput: 'Load earlier output ↑',
  outputError: 'Could not read task output', unknown: 'unknown', agents: 'Sub-agents',
  parentStop: 'Select the workflow node to stop the task. Individual workflow agents have no stop handle.',
  tokens: 'Tokens', elapsed: 'Elapsed', workflow: 'Workflow', task: 'Task',
  stop: 'Stop', stopping: 'stopping…', stopHint: 'Stop this task. The session keeps running.',
  finished: 'Finished', showMore: 'Show more', running: 'Running',
  tailHint: 'Recent output · scroll up to read', loading: 'Reading output…',
  unavailablePath: 'The output path cannot be resolved for this session.',
  sessionAgents: 'Session sub-agents', transcript: 'Saved transcript',
  inventoryLoading: 'Reading session sub-agents…', inventoryUnavailable: 'Session sub-agents are unavailable.',
  needsAgentUpdate: 'This VPS agent does not support the sub-agent reader. Update the agent to use it.',
  inventoryHint: 'Saved sub-agents for this session. Their association with the selected task is not reported.',
  missingProgress: 'Live workflow details have not been received. This does not mean there are no sub-agents.',
  detailsUnknown: 'Details not received', noAgents: 'No saved sub-agent transcripts were found.',
  nativeHint: 'Saved assistant output and tool activity · bounded provider transcript.',
  noTaskOutput: 'This task has not reported an output file or a result yet. Select a saved sub-agent to read its transcript.',
  backgroundCommand: 'Background command', backgroundAgent: 'Background agent',
  noCommandOutput: 'This command has not reported its output file yet.',
  noCommandOutputEnded: 'This command reported no output file.',
  agent: 'Agent', started: 'Started', ended: 'Ended', took: 'Took', taskId: 'Task ID',
  // Workflow frise (BgWorkflowView)
  wfStartedAt: 'started', wfRunningFor: 'running for', wfTook: 'took', wfAgentsDone: 'agents done',
  wfLastActivity: 'last activity', wfNow: 'now', wfReading: 'Reading the workflow journal…',
  wfDone: 'done', wfNegative: 'answered no', wfFailed: 'failed', wfRunning: 'running', wfUnknown: 'no result', wfWave: 'started together',
  wfSlow: (label: string, elapsed: string, usual: string, ago: string) =>
    `${label} has been running for ${elapsed} — this step took ${usual} before. Last activity ${ago}.`,
  wfAgo: (d: string) => `${d} ago`,
  wfPickAgent: 'Select a bar to read that agent.',
};
