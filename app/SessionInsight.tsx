'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentKind } from '@/lib/types/api';
import { sessionCapabilities } from '@/lib/sessionCapabilities';
import InsightSection from './InsightSection';
import {
  contextUsagePercentage, contextUsagePresentation, contextWindowTokenLabel,
  insightSnapshotRequestState,
  isMcpServerReady, type SessionContextUsage,
} from './sessionInsightState';

/**
 * Session state that does not belong in the transcript: identity, security
 * profiles, provider resources, context pressure, MCP health and sub-agents.
 *
 * They share a panel rather than each taking a ToolPanel tab because six tab
 * labels already do not fit in 340px (§11) — and they answer the same kind of
 * question: "what is the state of this session, beyond the transcript".
 *
 * Everything here degrades to a sentence. Some surfaces differ by provider on
 * an agent that may predate them, on a VPS that may be unreachable, for a session
 * that may be asleep — so `reason` is rendered, never thrown.
 */

type McpServer = {
  name?: string | null; status?: string | null; tool_count?: number | null;
  error?: string | null; auth_status?: string | null; tools?: string[];
};
type Mcp = { ok?: boolean; error?: string; reason?: string; servers?: McpServer[] };
type SubMsg = { role?: string; content?: string };
type SubAgent = { id: string; parent_id?: string | null; depth?: number; name?: string | null; role?: string | null; preview?: string; status?: string };
type SubAgents = { ok?: boolean; error?: string; reason?: string; agents?: Array<string | SubAgent> };
type SecurityProfile = { id?: string; description?: string | null; allowed?: boolean };
type GuardianDenial = { review_id?: string; action?: unknown; rationale?: string | null; risk_level?: string | null };
type Security = { ok?: boolean; error?: string; reason?: string; reviewer?: 'user' | 'auto_review'; permission_profile?: string | null; profiles?: SecurityProfile[]; denials?: GuardianDenial[]; profile_reason?: string; runtime_reason?: string; runtime_error?: string };
type Skill = { name?: string; path?: string; description?: string; enabled?: boolean; short_description?: string | null };
type CodexApp = { id?: string; name?: string; description?: string | null; is_accessible?: boolean; is_enabled?: boolean; install_url?: string | null };
type Command = { name?: string; description?: string | null; argument_hint?: string | null };
type Resources = {
  ok?: boolean; error?: string; reason?: string; provider?: string;
  skills?: Skill[]; apps?: CodexApp[]; commands?: Command[]; plugins?: unknown[];
  skill_errors?: unknown[];
};

type LoadedState = {
  mcp: boolean;
  subagents: boolean;
  security: boolean;
  resources: boolean;
};

const FOCUS_REFRESH_AFTER_MS = 30_000;

function LoadingInsight() {
  return <p className="si-loading" role="status"><span aria-hidden="true" />loading…</p>;
}

function why(r: { reason?: string; error?: string } | null): string | null {
  if (!r) return null;
  if (r.reason === 'unsupported') return 'needs a newer agent on this VPS';
  if (r.reason === 'offline') return 'the VPS agent is offline';
  if (r.error) return r.error;
  return null;
}

function readableStatus(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export default function SessionInsight({
  sessionId, kind, context: ctx, contextLoaded, contextLoading,
  onRefreshContext, onCompact, compacting, compactDisabled, compactError,
}: {
  sessionId: string;
  kind: AgentKind;
  context: SessionContextUsage | null;
  contextLoaded: boolean;
  contextLoading: boolean;
  onRefreshContext: () => Promise<void>;
  onCompact: () => void | Promise<void>;
  compacting: boolean;
  compactDisabled: boolean;
  compactError?: string | null;
}) {
  const isCodex = kind === 'codex';
  const capabilities = sessionCapabilities(kind);
  const hasSecurity = capabilities.permissionProfiles !== 'none';
  const [mcp, setMcp] = useState<Mcp | null>(null);
  const [subagents, setSubagents] = useState<SubAgents | null>(null);
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  const [agentMsgs, setAgentMsgs] = useState<SubMsg[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState<LoadedState>({
    mcp: false,
    subagents: false,
    security: !hasSecurity,
    resources: false,
  });
  const [security, setSecurity] = useState<Security | null>(null);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [resources, setResources] = useState<Resources | null>(null);
  const [resourcePrompt, setResourcePrompt] = useState('');
  const [resourceBusy, setResourceBusy] = useState<string | null>(null);
  const [mcpOauthUrls, setMcpOauthUrls] = useState<Record<string, string>>({});
  const loadGeneration = useRef(0);
  const loadInflight = useRef<Promise<void> | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const loadRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRetryAttempt = useRef(0);
  const loadLastStartedAt = useRef(0);
  const forceAfterInflight = useRef(false);
  const loadRef = useRef<(force?: boolean) => Promise<void>>(async () => {});

  const load = useCallback((force = false): Promise<void> => {
    if (loadInflight.current) {
      if (force) forceAfterInflight.current = true;
      return loadInflight.current;
    }
    if (loadRetryTimer.current) {
      clearTimeout(loadRetryTimer.current);
      loadRetryTimer.current = null;
    }
    const generation = ++loadGeneration.current;
    const controller = new AbortController();
    loadController.current = controller;
    loadLastStartedAt.current = Date.now();
    setBusy(true);
    const get = async (path: string) => {
      const separator = path.includes('?') ? '&' : '?';
      try {
        const response = await fetch(`${path}${force ? `${separator}force=1` : ''}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        return response.ok
          ? body
          : { ok: false, error: body?.error || `request failed (${response.status})` };
      } catch (error) {
        if (controller.signal.aborted) return null;
        return { ok: false, error: String((error as Error)?.message || error) };
      }
    };
    const finish = (key: keyof LoadedState, apply: () => void) => {
      if (loadGeneration.current !== generation) return;
      apply();
      setLoaded((current) => current[key] ? current : { ...current, [key]: true });
    };

    const promise = (async () => {
      let shouldRetry = false;
      let serverRetryAfterMs = 0;
      // Sequential browser reads leave several HTTP/1.1 connections free for
      // chat input even behind a proxy. The first three routes themselves
      // return non-blocking snapshots; security is last because older agents
      // can still make that one a normal, awaited RPC.
      const requests: Array<{
        key: keyof LoadedState;
        path: string;
        apply: (value: any) => void;
      }> = [
        { key: 'resources', path: `/api/claude/sessions/${sessionId}/resources`, apply: setResources },
        { key: 'subagents', path: `/api/claude/sessions/${sessionId}/subagents`, apply: setSubagents },
        { key: 'mcp', path: `/api/claude/sessions/${sessionId}/mcp`, apply: setMcp },
      ];
      if (hasSecurity) {
        requests.push({
          key: 'security',
          path: `/api/claude/sessions/${sessionId}/security`,
          apply: setSecurity,
        });
      }

      for (const request of requests) {
        const value = await get(request.path);
        if (controller.signal.aborted || loadGeneration.current !== generation) return;
        const requestState = insightSnapshotRequestState(value);
        if (!requestState.waiting) {
          finish(request.key, () => request.apply(value));
        }
        if (requestState.shouldRetry) {
          shouldRetry = true;
          serverRetryAfterMs = Math.max(serverRetryAfterMs, requestState.retryAfterMs);
        }
      }

      if (loadGeneration.current !== generation) return;
      setBusy(shouldRetry);
      if (shouldRetry) {
        const attempt = ++loadRetryAttempt.current;
        const backoff = Math.min(10_000, 500 * (2 ** Math.min(5, attempt)));
        loadRetryTimer.current = setTimeout(() => {
          loadRetryTimer.current = null;
          void loadRef.current(false);
        }, Math.max(serverRetryAfterMs, backoff));
      } else {
        loadRetryAttempt.current = 0;
      }
    })().finally(() => {
      if (loadController.current === controller) {
        loadController.current = null;
        loadInflight.current = null;
      }
      if (loadGeneration.current === generation && forceAfterInflight.current) {
        forceAfterInflight.current = false;
        if (loadRetryTimer.current) {
          clearTimeout(loadRetryTimer.current);
          loadRetryTimer.current = null;
        }
        queueMicrotask(() => { void loadRef.current(true); });
      }
    });
    loadInflight.current = promise;
    return promise;
  }, [sessionId, hasSecurity]);
  loadRef.current = load;

  // The retry is completion-driven, not a poll: it only consumes a background
  // snapshot that the server has already started. Once all sections settle,
  // there are no timers.
  useEffect(() => {
    loadRetryAttempt.current = 0;
    forceAfterInflight.current = false;
    void load(false);
    return () => {
      loadGeneration.current += 1;
      forceAfterInflight.current = false;
      if (loadRetryTimer.current) {
        clearTimeout(loadRetryTimer.current);
        loadRetryTimer.current = null;
      }
      loadController.current?.abort(new DOMException('session details changed', 'AbortError'));
      loadController.current = null;
      loadInflight.current = null;
    };
  }, [load]);
  useEffect(() => {
    const refreshOnReturn = () => {
      if (document.visibilityState !== 'visible') return;
      if (loadInflight.current || loadRetryTimer.current) return;
      if (Date.now() - loadLastStartedAt.current < FOCUS_REFRESH_AFTER_MS) return;
      void load(false);
    };
    window.addEventListener('focus', refreshOnReturn);
    return () => window.removeEventListener('focus', refreshOnReturn);
  }, [load]);

  const refreshAll = useCallback(async () => {
    await Promise.allSettled([load(true), onRefreshContext()]);
  }, [load, onRefreshContext]);

  const openTranscript = useCallback(async (id: string) => {
    if (openAgent === id) { setOpenAgent(null); setAgentMsgs(null); return; }
    setOpenAgent(id); setAgentMsgs(null);
    const r = await fetch(`/api/claude/sessions/${sessionId}/subagents?agent=${encodeURIComponent(id)}`)
      .then((x) => x.json()).catch(() => null);
    setAgentMsgs(Array.isArray(r?.messages) ? r.messages : []);
  }, [openAgent, sessionId]);

  const pct = contextUsagePercentage(ctx);
  const tokenLabel = contextWindowTokenLabel(ctx);
  const contextPresentation = contextUsagePresentation(ctx, pct);
  const agents: SubAgent[] = Array.isArray(subagents?.agents)
    ? subagents.agents.map((item) => typeof item === 'string' ? { id: item, depth: 1 } : item)
    : [];
  const pendingSections = Object.values(loaded).filter((value) => !value).length
    + (contextLoaded ? 0 : 1);
  const resourceCount = (resources?.skills?.length ?? 0)
    + (resources?.apps?.length ?? 0)
    + (resources?.commands?.length ?? 0);

  const updateSecurity = useCallback(async (patch: { reviewer?: 'user' | 'auto_review'; permissionProfile?: string | null }) => {
    setSecurityBusy(true);
    try {
      const r = await fetch(`/api/claude/sessions/${sessionId}/security`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await r.json().catch(() => null);
      setSecurity(data);
    } finally { setSecurityBusy(false); }
  }, [sessionId]);

  const invokeResource = useCallback(async (kind: 'skill' | 'app' | 'command', item: Skill | CodexApp | Command) => {
    const name = kind === 'skill' ? (item as Skill).name
      : kind === 'app' ? (item as CodexApp).id : (item as Command).name;
    const path = kind === 'skill' ? (item as Skill).path
      : kind === 'app' ? `app://${(item as CodexApp).id}` : null;
    if (!name || (isCodex && kind !== 'command' && !path)) return;
    const prompt = resourcePrompt.trim();
    const display = kind === 'command' ? `/${name}${prompt ? ` ${prompt}` : ''}`
      : `$${name}${prompt ? ` ${prompt}` : ''}`;
    const content = !isCodex && kind === 'skill'
      ? `Use the "${name}" skill for this request.${prompt ? `\n\n${prompt}` : ''}`
      : display;
    setResourceBusy(`${kind}:${name}`);
    try {
      await fetch(`/api/claude/sessions/${sessionId}/input`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, ...(isCodex && kind !== 'command' ? { codexInputs: [
          { type: 'text', text: display },
          kind === 'skill' ? { type: 'skill', name, path } : { type: 'mention', name, path },
        ] } : {}) }),
      });
      setResourcePrompt('');
    } finally { setResourceBusy(null); }
  }, [isCodex, resourcePrompt, sessionId]);

  return (
    <div className="session-insight">
      <div className="si-head">
        <span>session details</span>
        <span className="si-head-actions">
          {(busy || contextLoading) && <small role="status">
            {pendingSections > 0 ? `loading ${pendingSections} section${pendingSections === 1 ? '' : 's'}…` : 'refreshing…'}
          </small>}
          <button type="button" onClick={() => void refreshAll()} disabled={busy || contextLoading} title="refresh">↻</button>
        </span>
      </div>

      <InsightSection title="names" loading={!contextLoaded}
        meta={!contextLoaded ? 'loading…' : (ctx?.identity ? 'Charon + CLI' : 'unavailable')}>
        {!contextLoaded ? <LoadingInsight /> : ctx?.identity ? <>
          {/* Display names and native titles are mirrored but independent.
              Showing both makes a pending/failed convergence explicit. */}
          <ul className="si-cats">
            <li><span>Charon</span><b>{ctx.identity.name || '(unnamed)'}</b></li>
            <li><span>{kind === 'codex' ? 'Codex' : 'Claude'}</span><b>{ctx.identity.cli_title || '—'}</b></li>
          </ul>
          {ctx.identity.cli_title && ctx.identity.cli_title !== ctx.identity.name && (
            <p className="si-none si-diverged">
              The CLI still knows this session under a different name — it is
              re-asserted at the next turn.
            </p>
          )}
        </> : <p className="si-none">{why(ctx) ?? 'identity unavailable'}</p>}
      </InsightSection>

      {capabilities.permissionProfiles !== 'none' && <InsightSection
        title="permission profiles"
        loading={!loaded.security}
        meta={!loaded.security ? 'loading…' : (security?.ok
          ? (security.permission_profile || 'legacy sandbox') : 'unavailable')}
      >
        {!loaded.security ? <LoadingInsight /> : security?.ok ? <>
          <label className="si-control">
            <span>profile</span>
            <select disabled={securityBusy} value={security.permission_profile ?? ''} onChange={(e) => {
              void updateSecurity({ permissionProfile: e.target.value || null });
            }}>
              <option value="">legacy sandbox</option>
              {(security.profiles ?? []).map((profile) => <option key={profile.id} value={profile.id}
                disabled={profile.allowed === false}>{profile.id}{profile.allowed === false ? ' (blocked)' : ''}</option>)}
            </select>
          </label>
          {(security.profile_reason === 'unsupported' || security.runtime_reason || security.runtime_error) && (
            <p className="si-none">profiles unavailable until the Codex session is running on a compatible agent</p>
          )}
          {!!security.denials?.length && <div className="si-denials">
            <p className="si-line">recent denials</p>
            {security.denials.map((denial) => <div className="si-denial" key={denial.review_id}>
              <span title={JSON.stringify(denial.action)}>{denial.rationale || denial.risk_level || 'Denied action'}</span>
              <button type="button" disabled={securityBusy} onClick={async () => {
                setSecurityBusy(true);
                try {
                  await fetch(`/api/claude/sessions/${sessionId}/security`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'approve_denial', reviewId: denial.review_id }),
                  });
                  await load(true);
                } finally { setSecurityBusy(false); }
              }}>approve once</button>
            </div>)}
          </div>}
        </> : <p className="si-none">{why(security) ?? 'not running'}</p>}
      </InsightSection>}

      <InsightSection
        title={capabilities.apps !== 'none' ? 'skills & apps' : 'skills & commands'}
        loading={!loaded.resources}
        meta={!loaded.resources ? 'loading…' : (resources?.ok
          ? `${resourceCount} available` : 'unavailable')}
      >
        {!loaded.resources ? <LoadingInsight /> : resources?.ok ? <>
          <textarea className="si-resource-prompt" rows={2} value={resourcePrompt}
            onChange={(e) => setResourcePrompt(e.target.value)}
            placeholder={`Optional instruction for the selected ${capabilities.apps !== 'none' ? 'skill or app' : 'skill or command'}`} />
          {!!resources.skills?.length && <ul className="si-resources">
            {resources.skills.map((skill) => <li key={skill.path || skill.name}>
              <span><b>${skill.name}</b><small>{skill.description || skill.short_description}</small></span>
              <button type="button" disabled={!!resourceBusy || skill.enabled === false}
                onClick={() => void invokeResource('skill', skill)}>
                {resourceBusy === `skill:${skill.name}` ? '…' : 'use'}
              </button>
              {skill.path && <button type="button" disabled={!!resourceBusy} onClick={async () => {
                setResourceBusy(`toggle:${skill.name}`);
                try {
                  await fetch(`/api/claude/sessions/${sessionId}/resources`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ name: skill.name, path: skill.path, enabled: skill.enabled === false }),
                  });
                  await load(true);
                } finally { setResourceBusy(null); }
              }}>{skill.enabled === false ? 'enable' : 'disable'}</button>}
            </li>)}
          </ul>}
          {!!resources.commands?.length && <ul className="si-resources commands">
            {resources.commands.map((command) => <li key={command.name}>
              <span><b>/{command.name}</b><small>{command.description || command.argument_hint}</small></span>
              <button type="button" disabled={!!resourceBusy}
                onClick={() => void invokeResource('command', command)}>
                {resourceBusy === `command:${command.name}` ? '…' : 'use'}
              </button>
            </li>)}
          </ul>}
          {!!resources.apps?.length && <ul className="si-resources apps">
            {resources.apps.map((app) => <li key={app.id}>
              <span><b>{app.name || app.id}</b><small>{app.description}</small></span>
              <button type="button" disabled={!!resourceBusy || app.is_accessible === false || app.is_enabled === false}
                onClick={() => void invokeResource('app', app)}>
                {resourceBusy === `app:${app.id}` ? '…' : 'use'}
              </button>
              {app.install_url && <a href={app.install_url} target="_blank" rel="noreferrer">connect</a>}
            </li>)}
          </ul>}
          {!resources.skills?.length && !resources.apps?.length && !resources.commands?.length
            && <p className="si-none">none available</p>}
        </> : <p className="si-none">{why(resources) ?? 'not running'}</p>}
      </InsightSection>

      <InsightSection title="context window" defaultOpen loading={!contextLoaded}
        meta={!contextLoaded ? 'loading…' : contextPresentation.meta}>
        {!contextLoaded ? <LoadingInsight /> : <>
        <div className="si-context-actions">
          {ctx?.status?.type ? (
            <span>status: {readableStatus(ctx.status.type)}
              {(ctx.status.activeFlags ?? ctx.status.active_flags)?.length
                ? ` · ${(ctx.status.activeFlags ?? ctx.status.active_flags)?.map(readableStatus).join(', ')}` : ''}
            </span>
          ) : <span />}
          <button type="button" onClick={() => void onCompact()}
            disabled={compacting || compactDisabled}
            title={compactDisabled ? 'The session must be running and idle to compact' : 'Compact the model context now'}>
            {compacting ? 'compacting…' : 'compact'}
          </button>
        </div>
        {compactError && <p className="si-context-error" title={compactError}>compaction failed: {compactError}</p>}
        {ctx?.ok && pct != null ? (
          <>
            <div className="si-bar" title={tokenLabel ? `${tokenLabel} tokens` : 'context usage'}>
              {/* Amber past the auto-compact threshold: that is the point where
                  the session is about to stop remembering, which is the only
                  number here anyone acts on. */}
              <span
                className={`si-bar-fill${pct >= 75 ? ' hot' : ''}`}
                style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
              />
            </div>
            <div className="si-line">
              {Math.round(pct)}% used
              {tokenLabel && ` · ${tokenLabel}`}
            </div>
            {!!ctx.categories?.length && (
              <ul className="si-cats">
                {ctx.categories.filter((c) => c.tokens).slice(0, 6).map((c, i) => (
                  <li key={i}><span>{c.name}</span><b>{Math.round((c.tokens ?? 0) / 1000)}k</b></li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="si-none">{contextPresentation.empty}</p>
        )}
        {ctx?.recorded_usage && (
          <div className="si-line" title={ctx.recorded_usage.models?.join(', ')}>
            recorded: {ctx.recorded_usage.turns} turn{ctx.recorded_usage.turns === 1 ? '' : 's'}
            {' · '}↑ {compactNumber(ctx.recorded_usage.output_tokens)} out
            {' · '}↓ {compactNumber(ctx.recorded_usage.input_tokens)} in
            {ctx.recorded_usage.cache_read_tokens > 0
              ? ` · ${compactNumber(ctx.recorded_usage.cache_read_tokens)} cached` : ''}
            {ctx.recorded_usage.cost_usd > 0
              ? ` · $${ctx.recorded_usage.cost_usd.toFixed(4)}` : ''}
          </div>
        )}
        </>}
      </InsightSection>

      <InsightSection title="MCP servers" defaultOpen loading={!loaded.mcp}
        meta={!loaded.mcp ? 'loading…' : (mcp?.ok
          ? `${mcp.servers?.length ?? 0} configured` : 'unavailable')}>
        {!loaded.mcp ? <LoadingInsight /> : mcp?.ok && mcp.servers?.length ? (
          <ul className="si-mcp">
            {mcp.servers.map((sv, i) => (
              <li key={i} className={`si-mcp-row ${String(sv.status ?? '').toLowerCase()}`}>
                <span className="si-mcp-name">{sv.name}</span>
                <span className="si-mcp-status" title={sv.tools?.join(', ')}>{sv.status}
                  {sv.auth_status && sv.auth_status !== 'unsupported' && ` · auth: ${sv.auth_status}`}
                  {sv.tool_count != null && ` · ${sv.tool_count} tools`}
                </span>
                {!isMcpServerReady(sv.status) && <button
                  type="button"
                  onClick={async () => {
                    await fetch(`/api/claude/sessions/${sessionId}/mcp`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'reconnect', name: sv.name }),
                    }).catch(() => {});
                    void load(true);
                  }}
                >reconnect</button>}
                {capabilities.mcpOauth !== 'none' && ['notloggedin', 'auth required'].includes(
                  String(sv.auth_status || sv.status || '').toLowerCase().replace(/[^a-z ]/g, ''),
                ) && <button type="button" onClick={async () => {
                  const response = await fetch(`/api/claude/sessions/${sessionId}/mcp`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'oauth', name: sv.name }),
                  });
                  const data = await response.json().catch(() => null);
                  if (response.ok && data?.authorization_url && sv.name) {
                    setMcpOauthUrls((current) => ({ ...current, [sv.name!]: data.authorization_url }));
                  }
                }}>connect</button>}
                {sv.name && mcpOauthUrls[sv.name] && <a href={mcpOauthUrls[sv.name]}
                  target="_blank" rel="noreferrer">open login</a>}
                {capabilities.mcpToggle !== 'none' && <button type="button" onClick={async () => {
                  await fetch(`/api/claude/sessions/${sessionId}/mcp`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'toggle', name: sv.name,
                      enabled: String(sv.status ?? '').toLowerCase() === 'disabled' }),
                  }).catch(() => {});
                  void load(true);
                }}>{String(sv.status ?? '').toLowerCase() === 'disabled' ? 'enable' : 'disable'}</button>}
                {sv.error && <span className="si-mcp-err" title={sv.error}>{sv.error.slice(0, 60)}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="si-none">{mcp?.ok ? 'none configured' : (why(mcp) ?? 'not running')}</p>
        )}
      </InsightSection>

      <InsightSection title="sub-agents" loading={!loaded.subagents}
        meta={!loaded.subagents ? 'loading…' : (subagents?.ok === false
          ? 'unavailable' : `${agents.length} spawned`)}>
        {!loaded.subagents ? <LoadingInsight /> : subagents?.ok === false ? (
          <p className="si-none">{why(subagents) ?? 'not running'}</p>
        ) : agents.length ? (
          <ul className="si-agents">
            {agents.map((agent) => (
              <li key={agent.id} style={{ paddingLeft: `${Math.max(0, (agent.depth ?? 1) - 1) * 10}px` }}>
                <button type="button" className="si-agent" onClick={() => void openTranscript(agent.id)}>
                  {openAgent === agent.id ? '▾' : '▸'} {agent.name || agent.role || agent.id.slice(0, 24)}
                  {agent.status && <small> · {agent.status}</small>}
                </button>
                {agent.preview && <div className="si-agent-preview">{agent.preview}</div>}
                {openAgent === agent.id && (
                  <div className="si-transcript">
                    {agentMsgs == null ? <em>loading…</em>
                      : agentMsgs.length === 0 ? <em>empty transcript</em>
                      : agentMsgs.map((m, i) => (
                        <div key={i} className={`si-msg ${m.role}`}>
                          <span className="si-msg-role">{m.role}</span>
                          <pre>{m.content}</pre>
                        </div>
                      ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="si-none">none spawned</p>
        )}
      </InsightSection>
    </div>
  );
}
