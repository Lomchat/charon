'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { AgentKind } from '@/lib/types/api';
import { sessionCapabilities } from '@/lib/sessionCapabilities';
import { isMcpServerReady } from './sessionInsightState';

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

type Ctx = {
  ok?: boolean; error?: string; reason?: string;
  total_tokens?: number; max_tokens?: number; percentage?: number;
  auto_compact_threshold?: number; model?: string;
  status?: { type?: string; activeFlags?: string[]; active_flags?: string[] };
  categories?: Array<{ name?: string | null; tokens?: number | null }>;
  identity?: { name?: string | null; cli_title?: string | null; cli_error?: string };
  recorded_usage?: {
    turns: number; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_write_tokens: number;
    duration_ms: number; cost_usd: number; models?: string[];
  } | null;
};

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
  context: boolean;
  mcp: boolean;
  subagents: boolean;
  security: boolean;
  resources: boolean;
};

function InsightSection({
  title, meta, defaultOpen = false, loading = false, children,
}: {
  title: string;
  meta?: string;
  defaultOpen?: boolean;
  loading?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="si-sec" open={open} aria-busy={loading}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="si-sec-title">
        <span className="si-sec-chevron" aria-hidden="true" />
        <span>{title}</span>
        {meta && <small>{meta}</small>}
      </summary>
      <div className="si-sec-body">{children}</div>
    </details>
  );
}

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

export default function SessionInsight({ sessionId, kind }: { sessionId: string; kind: AgentKind }) {
  const isCodex = kind === 'codex';
  const capabilities = sessionCapabilities(kind);
  const hasSecurity = capabilities.permissionProfiles !== 'none';
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [mcp, setMcp] = useState<Mcp | null>(null);
  const [subagents, setSubagents] = useState<SubAgents | null>(null);
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  const [agentMsgs, setAgentMsgs] = useState<SubMsg[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState<LoadedState>({
    context: false,
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

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setBusy(true);
    const get = (path: string) => fetch(path).then((r) => r.json()).catch(() => null);
    const finish = (key: keyof LoadedState, apply: () => void) => {
      if (loadGeneration.current !== generation) return;
      apply();
      setLoaded((current) => current[key] ? current : { ...current, [key]: true });
    };

    const requests: Promise<void>[] = [
      get(`/api/claude/sessions/${sessionId}/context`)
        .then((value) => finish('context', () => setCtx(value))),
      get(`/api/claude/sessions/${sessionId}/mcp`)
        .then((value) => finish('mcp', () => setMcp(value))),
      get(`/api/claude/sessions/${sessionId}/subagents`)
        .then((value) => finish('subagents', () => setSubagents(value))),
      get(`/api/claude/sessions/${sessionId}/resources`)
        .then((value) => finish('resources', () => setResources(value))),
    ];
    if (hasSecurity) {
      requests.push(get(`/api/claude/sessions/${sessionId}/security`)
        .then((value) => finish('security', () => setSecurity(value))));
    }

    await Promise.allSettled(requests);
    if (loadGeneration.current === generation) setBusy(false);
  }, [sessionId, hasSecurity]);

  // On mount and on demand only — never on a timer. None of this changes fast
  // enough to justify a poll next to a running turn.
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { loadGeneration.current += 1; }, []);
  useEffect(() => {
    const refreshOnReturn = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('focus', refreshOnReturn);
    return () => window.removeEventListener('focus', refreshOnReturn);
  }, [load]);

  const openTranscript = useCallback(async (id: string) => {
    if (openAgent === id) { setOpenAgent(null); setAgentMsgs(null); return; }
    setOpenAgent(id); setAgentMsgs(null);
    const r = await fetch(`/api/claude/sessions/${sessionId}/subagents?agent=${encodeURIComponent(id)}`)
      .then((x) => x.json()).catch(() => null);
    setAgentMsgs(Array.isArray(r?.messages) ? r.messages : []);
  }, [openAgent, sessionId]);

  const pct = typeof ctx?.percentage === 'number'
    ? ctx.percentage
    : (ctx?.total_tokens && ctx?.max_tokens ? (ctx.total_tokens / ctx.max_tokens) * 100 : null);
  const agents: SubAgent[] = Array.isArray(subagents?.agents)
    ? subagents.agents.map((item) => typeof item === 'string' ? { id: item, depth: 1 } : item)
    : [];
  const pendingSections = Object.values(loaded).filter((value) => !value).length;
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
          {busy && <small role="status">
            {pendingSections > 0 ? `loading ${pendingSections} section${pendingSections === 1 ? '' : 's'}…` : 'refreshing…'}
          </small>}
          <button type="button" onClick={() => void load()} disabled={busy} title="refresh">↻</button>
        </span>
      </div>

      <InsightSection title="names" loading={!loaded.context}
        meta={!loaded.context ? 'loading…' : (ctx?.identity ? 'Charon + CLI' : 'unavailable')}>
        {!loaded.context ? <LoadingInsight /> : ctx?.identity ? <>
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
                  await load();
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
                  await load();
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

      <InsightSection title="context window" defaultOpen loading={!loaded.context}
        meta={!loaded.context ? 'loading…' : (pct != null ? `${Math.round(pct)}% used` : 'unavailable')}>
        {!loaded.context ? <LoadingInsight /> : <>
        {ctx?.status?.type && (
          <div className="si-line">status: {readableStatus(ctx.status.type)}
            {(ctx.status.activeFlags ?? ctx.status.active_flags)?.length
              ? ` · ${(ctx.status.activeFlags ?? ctx.status.active_flags)?.map(readableStatus).join(', ')}` : ''}
          </div>
        )}
        {ctx?.ok && pct != null ? (
          <>
            <div className="si-bar" title={`${ctx.total_tokens ?? '?'} / ${ctx.max_tokens ?? '?'} tokens`}>
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
              {ctx.total_tokens != null && ctx.max_tokens != null &&
                ` · ${Math.round(ctx.total_tokens / 1000)}k / ${Math.round(ctx.max_tokens / 1000)}k`}
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
          <p className="si-none">{why(ctx) ?? 'not running'}</p>
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
                    void load();
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
                  void load();
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
