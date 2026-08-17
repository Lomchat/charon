'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Three things the session already knew and never told anyone: how full its
 * context window is, whether its MCP servers actually connected, and what the
 * sub-agents it spawned did.
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
};

type McpServer = { name?: string | null; status?: string | null; tool_count?: number | null; error?: string | null };
type Mcp = { ok?: boolean; error?: string; reason?: string; servers?: McpServer[] };
type SubMsg = { role?: string; content?: string };
type BgTerminal = { process_id?: string; processId?: string; command?: string; cwd?: string; cpu_percent?: number | null; cpuPercent?: number | null; rss_kb?: number | null; rssKb?: number | null };
type SecurityProfile = { id?: string; description?: string | null; allowed?: boolean };
type GuardianDenial = { review_id?: string; action?: unknown; rationale?: string | null; risk_level?: string | null };
type Security = { ok?: boolean; error?: string; reason?: string; reviewer?: 'user' | 'auto_review'; permission_profile?: string | null; profiles?: SecurityProfile[]; denials?: GuardianDenial[] };
type Skill = { name?: string; path?: string; description?: string; enabled?: boolean; short_description?: string | null };
type CodexApp = { id?: string; name?: string; description?: string | null; is_accessible?: boolean; is_enabled?: boolean; install_url?: string | null };
type Resources = { ok?: boolean; error?: string; reason?: string; skills?: Skill[]; apps?: CodexApp[]; skill_errors?: unknown[] };

function why(r: { reason?: string; error?: string } | null): string | null {
  if (!r) return null;
  if (r.reason === 'unsupported') return 'needs a newer agent on this VPS';
  if (r.reason === 'offline') return 'the VPS agent is offline';
  if (r.error) return r.error;
  return null;
}

export default function SessionInsight({ sessionId, isCodex }: { sessionId: string; isCodex: boolean }) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [mcp, setMcp] = useState<Mcp | null>(null);
  const [agents, setAgents] = useState<string[] | null>(null);
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  const [agentMsgs, setAgentMsgs] = useState<SubMsg[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [terminals, setTerminals] = useState<BgTerminal[] | null>(null);
  const [security, setSecurity] = useState<Security | null>(null);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [resources, setResources] = useState<Resources | null>(null);
  const [resourcePrompt, setResourcePrompt] = useState('');
  const [resourceBusy, setResourceBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [c, m, a, bt, sec, res] = await Promise.all([
        fetch(`/api/claude/sessions/${sessionId}/context`).then((r) => r.json()).catch(() => null),
        fetch(`/api/claude/sessions/${sessionId}/mcp`).then((r) => r.json()).catch(() => null),
        isCodex ? Promise.resolve(null)
          : fetch(`/api/claude/sessions/${sessionId}/subagents`).then((r) => r.json()).catch(() => null),
        isCodex
          ? fetch(`/api/claude/sessions/${sessionId}/background-terminals`).then((r) => r.json()).catch(() => null)
          : Promise.resolve(null),
        isCodex
          ? fetch(`/api/claude/sessions/${sessionId}/security`).then((r) => r.json()).catch(() => null)
          : Promise.resolve(null),
        isCodex
          ? fetch(`/api/claude/sessions/${sessionId}/resources`).then((r) => r.json()).catch(() => null)
          : Promise.resolve(null),
      ]);
      setCtx(c); setMcp(m);
      setAgents(Array.isArray(a?.agents) ? a.agents : null);
      setTerminals(Array.isArray(bt?.terminals) ? bt.terminals : null);
      setSecurity(sec);
      setResources(res);
    } finally {
      setBusy(false);
    }
  }, [sessionId, isCodex]);

  // On mount and on demand only — never on a timer. None of this changes fast
  // enough to justify a poll next to a running turn.
  useEffect(() => { void load(); }, [load]);

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

  const updateSecurity = useCallback(async (reviewer: 'user' | 'auto_review', profile: string | null) => {
    setSecurityBusy(true);
    try {
      const r = await fetch(`/api/claude/sessions/${sessionId}/security`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewer, permissionProfile: profile }),
      });
      const data = await r.json().catch(() => null);
      setSecurity(data);
    } finally { setSecurityBusy(false); }
  }, [sessionId]);

  const invokeResource = useCallback(async (kind: 'skill' | 'app', item: Skill | CodexApp) => {
    const name = kind === 'skill' ? (item as Skill).name : (item as CodexApp).id;
    const path = kind === 'skill' ? (item as Skill).path : `app://${(item as CodexApp).id}`;
    if (!name || !path) return;
    const prompt = resourcePrompt.trim();
    const display = `$${name}${prompt ? ` ${prompt}` : ''}`;
    setResourceBusy(`${kind}:${name}`);
    try {
      await fetch(`/api/claude/sessions/${sessionId}/input`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: display, codexInputs: [
          { type: 'text', text: display },
          kind === 'skill' ? { type: 'skill', name, path } : { type: 'mention', name, path },
        ] }),
      });
      setResourcePrompt('');
    } finally { setResourceBusy(null); }
  }, [resourcePrompt, sessionId]);

  return (
    <div className="session-insight">
      <div className="si-head">
        <span>session</span>
        <button type="button" onClick={() => void load()} disabled={busy} title="refresh">↻</button>
      </div>

      <section className="si-sec">
        <h4>names</h4>
        {/* The violet @handle is derived from CHARON's name. What every tool on
            the VPS knows the session as is the CLI's own title — the two are
            mirrored (agent >= 0.38.0, re-asserted on any difference) but a
            session on an older agent, or one that has not taken a turn since,
            can still disagree. Showing both is cheaper than asking anyone to
            trust that they converged. */}
        <ul className="si-cats">
          <li><span>Charon</span><b>{ctx?.identity?.name || '(unnamed)'}</b></li>
          <li><span>{isCodex ? 'Codex' : 'Claude'}</span><b>{ctx?.identity?.cli_title || '—'}</b></li>
        </ul>
        {ctx?.identity && ctx.identity.cli_title
          && ctx.identity.cli_title !== ctx.identity.name && (
          <p className="si-none si-diverged">
            The CLI still knows this session under a different name — it is
            re-asserted at the next turn.
          </p>
        )}
      </section>

      {isCodex && <section className="si-sec">
        <h4>permissions</h4>
        {security?.ok ? <>
          <label className="si-control">
            <span>reviewer</span>
            <select disabled={securityBusy} value={security.reviewer ?? 'user'} onChange={(e) => {
              void updateSecurity(e.target.value as 'user' | 'auto_review', security.permission_profile ?? null);
            }}>
              <option value="user">ask me</option>
              <option value="auto_review">Approve for me</option>
            </select>
          </label>
          <label className="si-control">
            <span>profile</span>
            <select disabled={securityBusy} value={security.permission_profile ?? ''} onChange={(e) => {
              void updateSecurity(security.reviewer ?? 'user', e.target.value || null);
            }}>
              <option value="">legacy sandbox</option>
              {(security.profiles ?? []).map((profile) => <option key={profile.id} value={profile.id}
                disabled={profile.allowed === false}>{profile.id}{profile.allowed === false ? ' (blocked)' : ''}</option>)}
            </select>
          </label>
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
      </section>}

      {isCodex && <section className="si-sec">
        <h4>skills & apps</h4>
        {resources?.ok ? <>
          <textarea className="si-resource-prompt" rows={2} value={resourcePrompt}
            onChange={(e) => setResourcePrompt(e.target.value)}
            placeholder="Optional instruction for the selected skill or app" />
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
                    body: JSON.stringify({ path: skill.path, enabled: skill.enabled === false }),
                  });
                  await load();
                } finally { setResourceBusy(null); }
              }}>{skill.enabled === false ? 'enable' : 'disable'}</button>}
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
          {!resources.skills?.length && !resources.apps?.length && <p className="si-none">none available</p>}
        </> : <p className="si-none">{why(resources) ?? 'not running'}</p>}
      </section>}

      <section className="si-sec">
        <h4>context window</h4>
        {isCodex && ctx?.status?.type && (
          <div className="si-line">status: {ctx.status.type}
            {(ctx.status.activeFlags ?? ctx.status.active_flags)?.length
              ? ` · ${(ctx.status.activeFlags ?? ctx.status.active_flags)?.join(', ')}` : ''}
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
      </section>

      <section className="si-sec">
        <h4>mcp servers</h4>
        {mcp?.ok && mcp.servers?.length ? (
          <ul className="si-mcp">
            {mcp.servers.map((sv, i) => (
              <li key={i} className={`si-mcp-row ${String(sv.status ?? '').toLowerCase()}`}>
                <span className="si-mcp-name">{sv.name}</span>
                <span className="si-mcp-status">{sv.status}{sv.tool_count != null && ` · ${sv.tool_count} tools`}</span>
                <button
                  type="button"
                  onClick={async () => {
                    await fetch(`/api/claude/sessions/${sessionId}/mcp`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'reconnect', name: sv.name }),
                    }).catch(() => {});
                    void load();
                  }}
                >reconnect</button>
                {sv.error && <span className="si-mcp-err" title={sv.error}>{sv.error.slice(0, 60)}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="si-none">{mcp?.ok ? 'none configured' : (why(mcp) ?? 'not running')}</p>
        )}
      </section>

      {isCodex && <section className="si-sec">
        <h4>background terminals{terminals?.length ? ` (${terminals.length})` : ''}</h4>
        {terminals?.length ? <ul className="si-mcp">
          {terminals.map((term, i) => {
            const processId = term.process_id ?? term.processId ?? '';
            const cpu = term.cpu_percent ?? term.cpuPercent;
            const rss = term.rss_kb ?? term.rssKb;
            return <li key={processId || i} className="si-mcp-row ready">
              <span className="si-mcp-name" title={term.cwd}>{term.command || processId}</span>
              <span className="si-mcp-status">pid {processId}
                {cpu != null ? ` · ${cpu}%` : ''}
                {rss != null ? ` · ${Math.round(rss / 1024)} MB` : ''}
              </span>
              <button type="button" onClick={async () => {
                await fetch(`/api/claude/sessions/${sessionId}/background-terminals`, {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ processId }),
                }).catch(() => {});
                void load();
              }}>stop</button>
            </li>;
          })}
        </ul> : <p className="si-none">none running</p>}
      </section>}

      {!isCodex && <section className="si-sec">
        <h4>sub-agents{agents?.length ? ` (${agents.length})` : ''}</h4>
        {agents?.length ? (
          <ul className="si-agents">
            {agents.map((id) => (
              <li key={id}>
                <button type="button" className="si-agent" onClick={() => void openTranscript(id)}>
                  {openAgent === id ? '▾' : '▸'} {id.slice(0, 24)}
                </button>
                {openAgent === id && (
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
      </section>}
    </div>
  );
}
