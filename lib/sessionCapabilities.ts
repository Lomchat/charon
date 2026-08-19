/** Provider behavior contract shared by client routes, UI and server code.
 *
 * Levels describe Charon's delivered semantics, not the version installed on
 * one VPS. Runtime support must still degrade on JSON-RPC -32601/capability
 * discovery; never use this matrix as an agent-version gate.
 */
export type SessionProvider = 'claude' | 'codex';
export type CapabilityLevel = 'native' | 'adapted' | 'none';

export type ClaudeMode = 'normal' | 'acceptEdits' | 'auto' | 'plan';
/** Historical name kept for API compatibility. `accept-all` is a combined
 * Codex mode: danger-full-access sandbox plus approvalPolicy=never. */
export type CodexSandboxMode =
  | 'read-only' | 'workspace-write' | 'full-access' | 'accept-all';
export type SessionMode = ClaudeMode | CodexSandboxMode;

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

export function sessionModes(provider: SessionProvider): readonly SessionMode[] {
  return provider === 'codex' ? CODEX_SANDBOX_MODES : CLAUDE_PERMISSION_MODES;
}

export function isSessionMode(provider: SessionProvider, value: unknown): value is SessionMode {
  return typeof value === 'string' && sessionModes(provider).includes(value as SessionMode);
}

/** Safe source defaults. Instance settings may override these for new
 * sessions; corrupted persisted state always falls back here. */
export function defaultSessionMode(
  provider: SessionProvider,
  _context: 'create' | 'runtime' = 'runtime',
): SessionMode {
  if (provider === 'codex') return 'workspace-write';
  return 'normal';
}

export function isSessionEffort(provider: SessionProvider, value: unknown): value is SessionEffort {
  if (typeof value !== 'string') return false;
  const allowed: readonly string[] = provider === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS;
  return allowed.includes(value);
}

export type SessionCapability =
  | 'fork' | 'crossProviderFork' | 'compact' | 'rewind' | 'review' | 'archive'
  | 'stableHandle' | 'peerMessaging' | 'permissions' | 'contextUsage'
  | 'turnUsage' | 'structuredOutput' | 'skills' | 'mcp' | 'subagents'
  | 'backgroundWork' | 'fallbackModel' | 'exitPlan' | 'safeFileRevert'
  | 'autoReviewer' | 'permissionProfiles' | 'apps' | 'slashCommands'
  | 'mcpToggle' | 'mcpOauth';

export type SessionCapabilityMap = Readonly<Record<SessionCapability, CapabilityLevel>>;

export const SESSION_CAPABILITIES: Readonly<Record<SessionProvider, SessionCapabilityMap>> = {
  claude: {
    fork: 'native', crossProviderFork: 'adapted', compact: 'native', rewind: 'native',
    review: 'adapted', archive: 'adapted', stableHandle: 'adapted', peerMessaging: 'adapted',
    permissions: 'native', contextUsage: 'native', turnUsage: 'native',
    structuredOutput: 'native', skills: 'native', mcp: 'native', subagents: 'native',
    backgroundWork: 'native', fallbackModel: 'native', exitPlan: 'native',
    safeFileRevert: 'adapted', autoReviewer: 'none', permissionProfiles: 'none',
    apps: 'none', slashCommands: 'native', mcpToggle: 'native', mcpOauth: 'none',
  },
  codex: {
    fork: 'native', crossProviderFork: 'adapted', compact: 'native', rewind: 'native',
    review: 'native', archive: 'native', stableHandle: 'adapted', peerMessaging: 'adapted',
    permissions: 'native', contextUsage: 'native', turnUsage: 'native',
    structuredOutput: 'native', skills: 'native', mcp: 'native', subagents: 'native',
    backgroundWork: 'native', fallbackModel: 'none', exitPlan: 'none',
    safeFileRevert: 'none', autoReviewer: 'native', permissionProfiles: 'native',
    apps: 'native', slashCommands: 'none', mcpToggle: 'none', mcpOauth: 'native',
  },
};

export function sessionCapabilities(provider: SessionProvider): SessionCapabilityMap {
  return SESSION_CAPABILITIES[provider];
}

export function supportsSessionCapability(
  provider: SessionProvider,
  capability: SessionCapability,
): boolean {
  return SESSION_CAPABILITIES[provider][capability] !== 'none';
}
