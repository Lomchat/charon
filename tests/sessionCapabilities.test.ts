import { describe, expect, it } from 'vitest';
import { api, sessionApi } from '@/lib/api';
import {
  CODEX_SANDBOX_MODES,
  SESSION_CAPABILITIES,
  defaultSessionMode,
  isSessionEffort,
  isSessionMode,
  supportsSessionCapability,
  type SessionCapability,
  type SessionProvider,
} from '@/lib/sessionCapabilities';

const PROVIDERS: readonly SessionProvider[] = ['claude', 'codex'];

// These are the product promises for which the dashboard must expose one
// concept even when one provider needs an adapter behind it.
const PARITY_CAPABILITIES: readonly SessionCapability[] = [
  'fork', 'crossProviderFork', 'compact', 'rewind', 'review', 'archive',
  'stableHandle', 'peerMessaging', 'permissions', 'contextUsage', 'turnUsage',
  'structuredOutput', 'skills', 'mcp', 'subagents', 'backgroundWork',
];

describe('provider capability contract', () => {
  it.each(PARITY_CAPABILITIES)('delivers %s for both providers', (capability) => {
    for (const provider of PROVIDERS) {
      expect(supportsSessionCapability(provider, capability)).toBe(true);
      expect(SESSION_CAPABILITIES[provider][capability]).not.toBe('none');
    }
  });

  it('records intentional provider-only features instead of hiding them in UI conditionals', () => {
    expect(SESSION_CAPABILITIES.claude).toMatchObject({
      fallbackModel: 'native', exitPlan: 'native', safeFileRevert: 'adapted',
      slashCommands: 'native', mcpToggle: 'native',
      autoReviewer: 'none', permissionProfiles: 'none', apps: 'none', mcpOauth: 'none',
    });
    expect(SESSION_CAPABILITIES.codex).toMatchObject({
      fallbackModel: 'none', exitPlan: 'none', safeFileRevert: 'none',
      slashCommands: 'none', mcpToggle: 'none',
      autoReviewer: 'native', permissionProfiles: 'native', apps: 'native', mcpOauth: 'native',
    });
  });

  it('keeps both maps structurally identical', () => {
    expect(Object.keys(SESSION_CAPABILITIES.claude).sort())
      .toEqual(Object.keys(SESSION_CAPABILITIES.codex).sort());
  });
});

describe('provider-specific modes and efforts', () => {
  it('keeps mode namespaces disjoint and defaults valid', () => {
    expect(defaultSessionMode('claude', 'create')).toBe('auto');
    expect(defaultSessionMode('claude', 'runtime')).toBe('normal');
    expect(defaultSessionMode('codex', 'create')).toBe('workspace-write');
    expect(defaultSessionMode('codex', 'runtime')).toBe('workspace-write');

    for (const mode of CODEX_SANDBOX_MODES) {
      expect(isSessionMode('codex', mode)).toBe(true);
      expect(isSessionMode('claude', mode)).toBe(false);
    }
    expect(isSessionMode('claude', 'plan')).toBe(true);
    expect(isSessionMode('codex', 'plan')).toBe(false);
  });

  it('does not leak provider-only effort levels', () => {
    expect(isSessionEffort('codex', 'ultra')).toBe(true);
    expect(isSessionEffort('claude', 'ultra')).toBe(false);
    expect(isSessionEffort('claude', 'ultracode')).toBe(true);
    expect(isSessionEffort('codex', 'ultracode')).toBe(false);
    expect(isSessionEffort('codex', 'minimal')).toBe(true);
    expect(isSessionEffort('claude', 'minimal')).toBe(false);
    expect(isSessionEffort('claude', 'high')).toBe(true);
    expect(isSessionEffort('codex', 'high')).toBe(true);
  });
});

describe('provider-neutral HTTP facade', () => {
  it('is a zero-copy compatibility facade over the established endpoints', () => {
    expect(sessionApi.list).toBe(api.listClaudeSessions);
    expect(sessionApi.create).toBe(api.createClaudeSession);
    expect(sessionApi.sendInput).toBe(api.sendClaudeInput);
    expect(sessionApi.respondPermission).toBe(api.respondClaudePermission);
    expect(sessionApi.setMode).toBe(api.setClaudeMode);
  });
});
