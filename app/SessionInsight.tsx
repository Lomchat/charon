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
 * Everything here degrades to a sentence. These are Claude-only surfaces on an
 * agent that may predate them, on a VPS that may be unreachable, for a session
 * that may be asleep — so `reason` is rendered, never thrown.
 */

type Ctx = {
  ok?: boolean; error?: string; reason?: string;
  total_tokens?: number; max_tokens?: number; percentage?: number;
  auto_compact_threshold?: number; model?: string;
  categories?: Array<{ name?: string | null; tokens?: number | null }>;
  identity?: { name?: string | null; cli_title?: string | null; cli_error?: string };
};

type McpServer = { name?: string | null; status?: string | null; tool_count?: number | null; error?: string | null };
type Mcp = { ok?: boolean; error?: string; reason?: string; servers?: McpServer[] };
type SubMsg = { role?: string; content?: string };

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

  const load = useCallback(async () => {
    if (isCodex) return;
    setBusy(true);
    try {
      const [c, m, a] = await Promise.all([
        fetch(`/api/claude/sessions/${sessionId}/context`).then((r) => r.json()).catch(() => null),
        fetch(`/api/claude/sessions/${sessionId}/mcp`).then((r) => r.json()).catch(() => null),
        fetch(`/api/claude/sessions/${sessionId}/subagents`).then((r) => r.json()).catch(() => null),
      ]);
      setCtx(c); setMcp(m);
      setAgents(Array.isArray(a?.agents) ? a.agents : null);
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

  if (isCodex) {
    return <div className="si-empty">Context, MCP and sub-agents are Claude-only surfaces.</div>;
  }

  const pct = typeof ctx?.percentage === 'number'
    ? ctx.percentage
    : (ctx?.total_tokens && ctx?.max_tokens ? (ctx.total_tokens / ctx.max_tokens) * 100 : null);

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
          <li><span>Claude</span><b>{ctx?.identity?.cli_title || '—'}</b></li>
        </ul>
        {ctx?.identity && ctx.identity.cli_title
          && ctx.identity.cli_title !== ctx.identity.name && (
          <p className="si-none si-diverged">
            The CLI still knows this session under a different name — it is
            re-asserted at the next turn.
          </p>
        )}
      </section>

      <section className="si-sec">
        <h4>context window</h4>
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

      <section className="si-sec">
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
      </section>
    </div>
  );
}
