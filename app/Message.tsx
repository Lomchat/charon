'use client';
import React, { memo, useCallback, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { AgentKind } from '@/lib/types/api';
import AgentLogo from './AgentLogo';
import { providerName, providerText } from '@/lib/providerText';
import { apiErrorText, providerAccountLabel } from '@/lib/providerAccounts';
import { useAccounts } from './accountsStore';
import { IconAlarm, IconClipboard } from './icons';
import { hastText, hastCodeLanguage } from './hastText';
import { isClaudeAuthExpired } from '@/lib/authExpired';
import { isTurnInterrupted } from '@/lib/turnInterrupted';
import { parseSessionError, type SessionErrorPayload } from '@/lib/sessionError';
import { parseScheduledResume } from '@/lib/scheduledResume';
import { describeSchedule, parseScheduledFire, scheduledTaskBody, scheduledTaskTitle } from '@/lib/scheduledTasks';
import { resolveResetAtMs } from '@/lib/rateLimitReset';
import { formatMessageTime, useTodayStart } from './messageTime';
import { findTextLinks, messageFileTarget, remarkCodeUrls, remarkFilePaths } from './messageLinks';
import { openTab as openWorkspaceTab } from './tabStore';
import { revealLine, revealView } from './revealLine';
import { peerRequestTarget } from './peerMessageLinks';
import { splitQuotedLines } from './chatQuote';

// Shared desktop/mobile type defined in `./sessionTypes`. Re-exported here
// to preserve historical imports (`import { Msg } from './Message'`).
import type { Msg } from './sessionTypes';
export type { Msg };

// Stable plugin/component identities. Besides avoiding small allocations on
// every bubble render, this lets react-markdown reuse more of its processing
// setup for completed messages.
export const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkCodeUrls];
const MermaidDiagram = dynamic(() => import('./MermaidDiagram'), {
  ssr: false,
  loading: () => <p className="mermaid-status" role="status">Rendering diagram…</p>,
});
export const MARKDOWN_REHYPE_PLUGINS: NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
];
export const MARKDOWN_COMPONENTS: NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']> = {
  pre: CodeBlock,
  table: ({ node: _node, ...props }) => (
    <div className="md-table-scroll" role="region" aria-label="Scrollable table" tabIndex={0}>
      <table {...props} />
    </div>
  ),
};

type Props = {
  m: Msg;
  vpsId?: string;
  cwd?: string | null;
  streaming?: boolean;
  // If provided, the tool_result linked to this tool_use is rendered inline below (⎿ style)
  attachedResult?: Msg;
  // TRUE when this session can still produce a tool_result — i.e. a turn is in
  // flight. A tool_use with no result is only "running" while that holds: once
  // the session is idle, the turn that owned it is over and the result can
  // never come (the CLI was restarted, slept or killed under it, §14.91). The
  // parent computes it per message, so only the unresolved tool cards see the
  // value flip (memo, §14.38).
  orphaned?: boolean;
  // Which backend produced this session (Claude vs Codex). Drives the small
  // per-message agent logo next to the model chip so it's clear who's speaking.
  kind?: AgentKind;
  // Opens the Claude sign-in modal for this session's VPS. Rendered as a CTA
  // under an assistant bubble that IS the "OAuth token expired" message
  // (§14.65) — the fix is one click away from the error instead of a hunt
  // through the sidebar. MUST be a stable reference (memo, §14.38).
  onReauth?: () => void;
  // Sends "Continue" to this session. Rendered as a CTA under an assistant
  // bubble that IS the CLI's "connection closed mid-response" report (§14.68),
  // so resuming a turn the transport cut is one click instead of retyping.
  // The parent hands it ONLY to the last visible message (an interruption in
  // the middle of the history has already been dealt with) and never while a
  // turn is running. MUST be a stable reference (memo, §14.38).
  onContinue?: () => void;
  // The SELECTED model, set only on a bubble answered by the model the provider
  // substituted for it (`substitutedModel` in SessionView): the chip
  // turns red like the runtime cell.
  substitutedFor?: string | null;
  onScheduleResume?: () => Promise<void>;
  onCancelScheduledResume?: (scheduleId: string) => Promise<void>;
  // Usage-limit error, newest row: switch this session to another hub account
  // and continue there (§14.115). `currentAccount` = the one that hit it.
  onContinueWithAccount?: (accountId: string) => Promise<void>;
  currentAccount?: string;
  peerSessionId?: string | null;
  onOpenPeerSession?: (sessionId: string) => void;
  onPeerRequestHover?: (messageId: string | null) => void;
  onPeerRequestJump?: (messageId: string) => void;
  peerReplyTo?: string | null;
};

function Message({ m, vpsId, cwd, streaming = false, attachedResult, kind = 'claude', onReauth, onContinue, substitutedFor, onScheduleResume, onCancelScheduledResume, onContinueWithAccount, currentAccount, orphaned = false, peerSessionId, onOpenPeerSession, onPeerRequestHover, onPeerRequestJump, peerReplyTo }: Props) {
  if (m.role === 'tool_use') return <ToolUseCard m={m} attachedResult={attachedResult} orphaned={orphaned} />;
  if (m.role === 'tool_result') return <ToolResultCard m={m} />;
  if (m.role === 'event' || m.role === 'edit_snapshot') return null;
  // user_question and exit_plan_request are already represented by the
  // AskUserQuestion / ExitPlanMode tool_use above — we don't render the raw duplicate.
  if (m.role === 'user_question' || m.role === 'exit_plan_request') return null;
  if (m.role === 'thinking') return <ThinkingBubble m={m} />;
  if (m.role === 'compaction') return <CompactionMarker m={m} kind={kind} />;
  if (m.role === 'scheduled_fire') return <ScheduledFireBubble m={m} />;
  if (m.role === 'forkpoint') return <ForkMarker m={m} />;
  if (m.role === 'plan') return <PlanCard m={m} />;
  if (m.role === 'scheduled_resume') {
    const scheduled = parseScheduledResume(m.content);
    return scheduled ? <ScheduledResumeMessage m={m} scheduled={scheduled} onCancel={onCancelScheduledResume} /> : null;
  }
  // Low-level Codex lifecycle signals used to render as expandable raw-JSON
  // cards. They are session state, not conversation, and are now deliberately
  // absent from the transcript (old cached rows included).
  if (m.role === 'activity') return null;
  if (m.role === 'error') {
    const parsed = parseSessionError(m.content);
    const error = parsed ?? {
      type: 'session_error', provider: kind, kind: 'api', message: m.content,
      action: null, fatal: false, resetAt: null,
    } satisfies SessionErrorPayload;
    return <SessionErrorMessage m={m} error={error} onReauth={onReauth} onContinue={onContinue} onScheduleResume={onScheduleResume}
      onContinueWithAccount={onContinueWithAccount} currentAccount={currentAccount} />;
  }

  // Borderless until `stop` names the final answer (S2): a live bubble is
  // intermediate whatever it turns out to be; legacy NULL rows stay bordered.
  const isAssistant = m.role === 'assistant';
  // Peer inputs keep the input bubble but identify their sender by handle.
  const isExternal = m.role === 'external';
  const isPeerStatus = m.role === 'peer_status';
  const requestId = peerRequestTarget(m) ?? (isAssistant ? peerReplyTo : null);
  const isPeerReply = isAssistant && !!requestId;
  const peerStatusLabel = m.peerStatus === 'accepted' ? 'accepted'
    : m.peerStatus === 'processing' ? 'processing'
    : m.peerStatus === 'replied' ? 'replied'
    : m.peerStatus === 'timed_out' ? 'timed out'
    : m.peerStatus === 'failed' ? 'failed' : null;
  return (
    <div
      className={`bubble role-${m.role}${isPeerReply ? ' peer-reply' : ''}${isAssistant && (m.assistantFinal === 0 || streaming) ? ' intermediate' : ''}${streaming ? ' streaming' : ''}`}
      data-msg-role={m.role}
      data-peer-message-id={m.messageId ?? (isExternal ? m.id : undefined)}
    >
      <header className="bubble-h">
        {isExternal ? (
          <PeerSessionLink
            className="tag peer-sender"
            sessionId={peerSessionId} onOpen={onOpenPeerSession}
            title={m.from
              ? `Open sender session @${m.from}`
              : 'Sent by another session'}
          >
            {m.from ? `@${m.from}` : 'Peer session'}
          </PeerSessionLink>
        ) : <span className="tag">{isPeerStatus ? 'sent' : m.role}</span>}
        {isExternal && m.fromProvider && (
          <AgentLogo kind={m.fromProvider} size={12} className="bubble-agent-logo" />
        )}
        {isPeerStatus && (
          <PeerSessionLink sessionId={peerSessionId} onOpen={onOpenPeerSession} title="Open recipient session">
            {m.peerTarget ? `to @${m.peerTarget}` : 'to peer session'}
          </PeerSessionLink>
        )}
        {isPeerStatus && m.fromProvider && (
          <AgentLogo kind={m.fromProvider} size={12} className="bubble-agent-logo" />
        )}
        {isPeerStatus && peerStatusLabel && (
          requestId
            ? <PeerRequestLink requestId={requestId} onHover={onPeerRequestHover} onJump={onPeerRequestJump} />
            : <span className={`peer-state ${m.peerStatus}`}>{peerStatusLabel}</span>
        )}
        {(isExternal || isAssistant) && requestId && (
          <PeerRequestLink requestId={requestId} onHover={onPeerRequestHover} onJump={onPeerRequestJump} />
        )}
        {/* Per-message agent attribution (assistant only): a small Claude/Codex
            logo so it's always clear which backend is speaking, next to the
            API-confirmed model id (from AssistantMessage.model, NOT the model's
            own self-identification). The chip is absent on messages persisted
            before the feature / on old agents — the logo still shows. */}
        {isAssistant && (
          <AgentLogo kind={kind} size={12} className="bubble-agent-logo" />
        )}
        {isAssistant && m.model && (
          <span className={`model-chip${substitutedFor ? ' is-substituted' : ''}`}
            title={substitutedFor
              ? `API-confirmed model for this message: ${m.model} · selected: ${substitutedFor}`
              : `API-confirmed model for this message: ${m.model}`}>
            {m.model}
          </span>
        )}
        {m.createdAt > 0 && (
          <span className="bubble-h-meta">
            <MessageTime ts={m.createdAt} />
            <CopyMessageButton content={m.content} />
          </span>
        )}
      </header>
      <div className="content md">
        {isAssistant ? (
          streaming ? (
            // Parsing + auto-detecting/highlighting the entire growing answer
            // at 60Hz was quadratic work. The final persisted bubble gets the
            // full Markdown renderer; the live tail stays deliberately cheap.
            <span className="streaming-plain">{m.content}</span>
          ) : (
            <MessageMarkdown content={m.content} vpsId={vpsId} cwd={cwd} />
          )
        ) : (
          <span>{m.role === 'user'
            ? <QuotedText text={m.content} vpsId={vpsId} cwd={cwd} />
            : <LinkifiedText text={m.content} vpsId={vpsId} cwd={cwd} />}</span>
        )}
      </div>
      {isPeerStatus && m.peerError && (
        <div className="peer-error">{m.peerError}</div>
      )}
      {/* Bottom mirror of the header's date/time + copy — the same info at
          the end of a long message, so a reader doesn't have to scroll back
          up to see when it was sent or to copy it. */}
      {m.createdAt > 0 && (
        <footer className="bubble-f">
          <MessageTime ts={m.createdAt} />
          <CopyMessageButton content={m.content} />
        </footer>
      )}
      {isAssistant && onReauth && kind === 'claude' && isClaudeAuthExpired(m.content) && (
        <div className="bubble-reauth">
          <span>{providerText.signInExpired('claude')}</span>
          <button type="button" className="wiz-btn primary" onClick={onReauth}>
            Sign in to Claude
          </button>
        </div>
      )}
      {isAssistant && onContinue && isTurnInterrupted(m.content, m.model) && (
        <ContinueCta onContinue={onContinue} />
      )}
    </div>
  );
}

function PeerSessionLink({ sessionId, onOpen, title, children, className = 'from-chip' }: {
  sessionId?: string | null; onOpen?: (id: string) => void;
  title: string; children: React.ReactNode; className?: string;
}) {
  if (!sessionId) return <span className={className} title={title}>{children}</span>;
  return <a className={`${className} peer-session-link`} href={`/?session=${encodeURIComponent(sessionId)}`}
    title={title} onClick={(event) => {
      if (!onOpen || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onOpen(sessionId);
    }}>{children}</a>;
}

function PeerRequestLink({ requestId, onHover, onJump }: {
  requestId: string; onHover?: (id: string | null) => void; onJump?: (id: string) => void;
}) {
  return <button type="button" className="peer-state replied peer-request-link"
    title="Show the original message" onMouseEnter={() => onHover?.(requestId)}
    onMouseLeave={() => onHover?.(null)} onFocus={() => onHover?.(requestId)}
    onBlur={() => onHover?.(null)} onClick={() => onJump?.(requestId)}>replied</button>;
}

export function MessageMarkdown({ content, vpsId, cwd }: {
  content: string; vpsId?: string; cwd?: string | null;
}) {
  // Bare paths become explorer links too — only where a VPS can open them.
  const remarkPlugins = useMemo<NonNullable<React.ComponentProps<typeof ReactMarkdown>['remarkPlugins']>>(
    () => (vpsId
      ? [...MARKDOWN_REMARK_PLUGINS, [remarkFilePaths, { accept: (href: string) => !!messageFileTarget(href, vpsId, cwd) }]]
      : MARKDOWN_REMARK_PLUGINS),
    [vpsId, cwd],
  );
  const urlTransform = useCallback<NonNullable<React.ComponentProps<typeof ReactMarkdown>['urlTransform']>>(
    (url, key) => key === 'href' && messageFileTarget(url, vpsId, cwd) ? url : defaultUrlTransform(url),
    [vpsId, cwd],
  );
  const components = useMemo(() => ({
    ...MARKDOWN_COMPONENTS,
    a: ({ node: _node, ...props }: React.ComponentProps<'a'> & { node?: unknown }) => (
      <MessageLink {...props} vpsId={vpsId} cwd={cwd} />
    ),
  }), [vpsId, cwd]);
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      components={components} urlTransform={urlTransform}>
      {content}
    </ReactMarkdown>
  );
}

/** YOUR bubble's body, where `> ` lines (a quote made from the chat,
 *  chatQuote.ts) render as a quote block. Peers' text stays literal. Spans
 *  only: this sits inside the bubble's inline wrapper; `.msg-quote` is
 *  display:block. */
function QuotedText({ text, vpsId, cwd }: { text: string; vpsId?: string; cwd?: string | null }) {
  const segs = useMemo(() => splitQuotedLines(text), [text]);
  if (!segs.some((x) => x.quote)) return <LinkifiedText text={text} vpsId={vpsId} cwd={cwd} />;
  return <>{segs.map((x, i) => x.quote
    ? <span key={i} className="msg-quote"><LinkifiedText text={x.text} vpsId={vpsId} cwd={cwd} /></span>
    : <LinkifiedText key={i} text={x.text} vpsId={vpsId} cwd={cwd} />)}</>;
}

/** Plain text (your bubble, a peer's, an agent's question): web URLs, and file
 *  paths where a VPS can open them. */
export function LinkifiedText({ text, vpsId, cwd }: { text: string; vpsId?: string; cwd?: string | null }) {
  const parts = useMemo(() => {
    const hits = findTextLinks(text, vpsId ? (href) => !!messageFileTarget(href, vpsId, cwd) : undefined);
    if (!hits.length) return null;
    const nodes: React.ReactNode[] = [];
    let at = 0;
    for (const h of hits) {
      if (h.start > at) nodes.push(text.slice(at, h.start));
      nodes.push(
        <MessageLink key={h.start} className={h.kind === 'path' ? 'file-path-link' : undefined}
          href={h.href} vpsId={vpsId} cwd={cwd}>
          {text.slice(h.start, h.end)}
        </MessageLink>,
      );
      at = h.end;
    }
    if (at < text.length) nodes.push(text.slice(at));
    return nodes;
  }, [text, vpsId, cwd]);
  return <>{parts ?? text}</>;
}

export function MessageLink({ href, vpsId, cwd, ...props }: React.ComponentProps<'a'> & {
  vpsId?: string; cwd?: string | null;
}) {
  const file = messageFileTarget(href ?? '', vpsId, cwd);
  if (!file) return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
  const abs = `${file.root.replace(/\/$/, '')}/${file.path}${file.line ? `:${file.line}` : ''}`;
  return <a title={`Open ${abs} in the explorer`} {...props} href={href} onClick={(event) => {
    event.preventDefault();
    // A line means the source at that line; a bare file is opened to be READ:
    // HTML live, Markdown rendered, when the file has such a view.
    if (file.line) revealLine(file.vpsId, file.root, file.path, file.line);
    else revealView(file.vpsId, file.root, file.path, 'rendered');
    void openWorkspaceTab({ vpsId: file.vpsId, path: file.root, kind: 'file', ref: file.path, pin: false });
  }} />;
}

function SessionErrorMessage({ m, error, onReauth, onContinue, onScheduleResume, onContinueWithAccount, currentAccount }: {
  m: Msg;
  error: SessionErrorPayload;
  onReauth?: () => void;
  onContinue?: () => void;
  onScheduleResume?: () => Promise<void>;
  onContinueWithAccount?: (accountId: string) => Promise<void>;
  currentAccount?: string;
}) {
  const firstLine = error.message.split('\n')[0].slice(0, 500);
  const hasDetails = error.message.includes('\n') || error.message.length > firstLine.length;
  const kindLabel = error.kind === 'authentication' ? 'authentication'
    : error.kind === 'rate_limit' ? 'rate limit'
    : error.kind === 'transport' ? 'connection' : 'API';
  const resetAt = error.kind === 'rate_limit' ? resolveResetAtMs(error.resetAt, error.message) : null;
  return (
    <div className="bubble role-error" data-msg-role="error">
      <header className="bubble-h">
        <span className="tag">error</span>
        <AgentLogo kind={error.provider} size={12} className="bubble-agent-logo" />
        <span className="error-kind">{kindLabel}</span>
        {m.createdAt > 0 && <MessageTime ts={m.createdAt} />}
      </header>
      <div className="content error-message">{firstLine}</div>
      {hasDetails && (
        <details className="error-details">
          <summary>show technical details</summary>
          <pre>{error.message}</pre>
        </details>
      )}
      {error.action === 'sign_in' && onReauth && (
        <div className="bubble-reauth">
          <span>{providerText.signInExpired(error.provider)}</span>
          <button type="button" className="wiz-btn primary" onClick={onReauth}>
            {providerText.signInAction(error.provider)}
          </button>
        </div>
      )}
      {error.action === 'continue' && onContinue && <ContinueCta onContinue={onContinue} />}
      {error.kind === 'rate_limit' && onContinueWithAccount && (
        <ContinueWithAccountCta provider={error.provider} current={currentAccount ?? ''} onPick={onContinueWithAccount} />
      )}
      {resetAt && onScheduleResume && (
        <ScheduleResumeCta resetAt={resetAt} onSchedule={onScheduleResume} />
      )}
    </div>
  );
}

/** "Continue with <account>" (§14.115): the provider's other signed-in hub
 *  accounts, least used first when their gauges are known. */
function ContinueWithAccountCta({ provider, current, onPick }: {
  provider: AgentKind; current: string; onPick: (accountId: string) => Promise<void>;
}) {
  const { data } = useAccounts();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = (id: string) => {
    const u = data.usage[id];
    return Math.max(u?.fiveHour?.utilization ?? 0, u?.sevenDay?.utilization ?? 0);
  };
  const others = data.accounts.filter((a) => a.provider === provider && a.id !== current && a.status !== 'expired')
    .sort((a, b) => load(a.id) - load(b.id));
  if (!others.length) return null;
  return (
    <div className="bubble-continue continue-with-account">
      <span>Another account can take over — same conversation:</span>
      {others.map((a) => (
        <button key={a.id} type="button" className="wiz-btn primary" disabled={!!busy} onClick={async () => {
          setBusy(a.id); setError(null);
          try { await onPick(a.id); } catch (e) { setError(apiErrorText(e)); setBusy(null); }
        }}>
          {busy === a.id ? 'switching…' : `Continue with ${providerAccountLabel(providerName(provider), a)}`}
        </button>
      ))}
      {error && <span className="runtime-choice-error" role="alert">{error}</span>}
    </div>
  );
}

function formatReset(instant: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'long',
  }).format(new Date(instant));
}

function ScheduleResumeCta({ resetAt, onSchedule }: { resetAt: number; onSchedule: () => Promise<void> }) {
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  return (
    <div className="bubble-continue scheduled-resume-cta">
      <span>The limit resets at {formatReset(resetAt)}. Charon will wait an extra two minutes before sending.</span>
      <button type="button" className="wiz-btn primary" disabled={state === 'saving'} onClick={async () => {
        setState('saving');
        try { await onSchedule(); } catch { setState('error'); }
      }}>
        {state === 'saving' ? 'scheduling…' : state === 'error' ? 'retry scheduling' : 'Resume after reset'}
      </button>
    </div>
  );
}

function ScheduledResumeMessage({ m, scheduled, onCancel }: {
  m: Msg;
  scheduled: NonNullable<ReturnType<typeof parseScheduledResume>>;
  onCancel?: (scheduleId: string) => Promise<void>;
}) {
  const [cancelling, setCancelling] = useState(false);
  const label = scheduled.status === 'sent' ? 'automatic resume sent'
    : scheduled.status === 'sending' ? 'sending automatic resume…'
    : scheduled.status === 'cancelled' ? 'automatic resume cancelled'
    : scheduled.attempts ? 'automatic resume retry scheduled' : 'automatic resume scheduled';
  return (
    <div className="bubble role-scheduled-resume" data-msg-role="scheduled_resume">
      <header className="bubble-h">
        <span className="tag">scheduled</span>
        {m.createdAt > 0 && <MessageTime ts={m.createdAt} />}
      </header>
      <div className="content">
        <strong>{label}</strong>
        {scheduled.status === 'scheduled' && <span> for {formatReset(scheduled.runAt)}</span>}
        {scheduled.status === 'sent' && scheduled.sentAt && <span> at {formatReset(scheduled.sentAt)}</span>}
        <div className="scheduled-resume-prompt">“{scheduled.content}”</div>
        {scheduled.lastError && <div className="scheduled-resume-error">Last attempt failed: {scheduled.lastError}</div>}
      </div>
      {scheduled.status === 'scheduled' && onCancel && (
        <button type="button" className="wiz-btn" disabled={cancelling} onClick={async () => {
          setCancelling(true);
          try { await onCancel(scheduled.scheduleId); } finally { setCancelling(false); }
        }}>{cancelling ? 'cancelling…' : 'Cancel'}</button>
      )}
    </div>
  );
}

// "The turn was cut mid-response" affordance (§14.68). Its own component
// because <Message> returns early for the non-bubble roles — a useState at the
// top of Message would break the rules of hooks.
//
// The button disables itself on click and is NOT re-enabled: `send` is
// optimistic (it appends the user bubble + flips the status to 'thinking'
// synchronously), so the parent stops passing `onContinue` a tick later and
// this whole node unmounts. The flag only has to cover the double-click window.
function ContinueCta({ onContinue }: { onContinue: () => void }) {
  const [sent, setSent] = useState(false);
  return (
    <div className="bubble-continue">
      <span>The connection dropped mid-answer — this turn stopped early.</span>
      <button
        type="button"
        className="wiz-btn primary"
        disabled={sent}
        onClick={() => { setSent(true); onContinue(); }}
        title="send &quot;Continue&quot; to resume where it stopped"
      >
        {sent ? 'sending…' : 'Continue'}
      </button>
    </div>
  );
}

// Memoized on purpose. The chat renders one <Message> per history item, and
// any parent re-render (streaming token, status change — and, before the input
// was isolated, every keystroke) would otherwise re-run this for ALL messages,
// re-parsing markdown + re-running syntax highlighting → O(N) work that made
// long sessions lag by seconds. Props (m / attachedResult) come from a useMemo
// in the parent, so their references stay stable until the message actually
// changes, letting memo's shallow compare skip the re-render. See CLAUDE.md §11.
export default memo(Message);

/**
 * Full-width rule marking where the CLI compacted the conversation.
 *
 * The distinction it draws is the whole point: everything ABOVE is still here
 * and still readable — Charon's transcript lives in its own SQLite, not in the
 * CLI's file — but the MODEL no longer remembers it. Without this, a session
 * that suddenly stops knowing what was agreed ten minutes ago just reads as
 * broken, and the user's next move is to re-explain into a void.
 *
 * A rule rather than a bubble: it is a boundary between two regions of the
 * conversation, not something anyone said.
 */
function CompactionMarker({ m, kind }: { m: Msg; kind: AgentKind }) {
  const auto = m.content === 'auto';
  return (
    <div className="compaction-marker" role="separator">
      <span className="cm-label">
        Conversation compacted{auto ? ' automatically' : ''} — {providerName(kind)} no longer
        remembers the messages above
      </span>
    </div>
  );
}

/** The turn a scheduled task's prompt started (lib/scheduledTasks.ts): in the
 *  user's place, since the CLI spoke for them, with the prompt folded. */
function ScheduledFireBubble({ m }: { m: Msg }) {
  const fire = parseScheduledFire(m.content);
  if (!fire) return null;
  const title = scheduledTaskTitle({ prompt: fire.prompt, id: fire.taskId ?? '' });
  const body = scheduledTaskBody(fire);
  const when = fire.schedule ? describeSchedule(fire.schedule, fire.recurring ?? true)
    : fire.source === 'loop_wakeup' ? 'loop wake-up' : null;
  return (
    <div className="bubble role-scheduled_fire" data-msg-role="scheduled_fire">
      <header className="bubble-h">
        <span className="sf-ico" aria-hidden><IconAlarm /></span>
        <span className="tag">scheduled task</span>
        {when && <span className="sf-when">{when}</span>}
        {fire.taskId && <span className="sf-id">{fire.taskId}</span>}
        {m.createdAt > 0 && <MessageTime ts={m.createdAt} />}
      </header>
      <div className="sf-title">{title}</div>
      {body && body !== title && (
        <details className="sf-prompt">
          <summary>prompt it sent</summary>
          <div className="content">{body}</div>
        </details>
      )}
    </div>
  );
}

function PlanCard({ m }: { m: Msg }) {
  let plan: any = {};
  try { plan = JSON.parse(m.content); } catch {}
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  return (
    <div className="codex-plan-card">
      <header><span className="tag">plan</span>{plan.partial && <span>live</span>}</header>
      {plan.explanation && <p>{String(plan.explanation)}</p>}
      {steps.length > 0 ? (
        <ol>{steps.map((s: any, i: number) => {
          const status = String(s.status ?? 'pending').toLowerCase();
          const mark = status.includes('complete') ? '✓' : status.includes('progress') ? '●' : '○';
          return <li key={i} className={`plan-${status}`}><span>{mark}</span>{String(s.step ?? '')}</li>;
        })}</ol>
      ) : <pre>{String(plan.text ?? '')}</pre>}
    </div>
  );
}

/**
 * The fork boundary. Deliberately the OPPOSITE message to the compaction
 * marker above: there, the history is intact and the model's memory is not;
 * here, both are — the branch inherited the transcript AND the context.
 */
function ForkMarker({ m }: { m: Msg }) {
  return (
    <div className="fork-marker" role="separator">
      <span className="fm-label">
        Conversation forked{m.content ? ` from “${m.content}”` : ''} — all
        earlier history is inherited
      </span>
    </div>
  );
}

function ThinkingBubble({ m }: { m: Msg }) {
  const [open, setOpen] = useState(false);
  const first = m.content.split('\n')[0].slice(0, 110);
  const hasMore = m.content.length > first.length;
  return (
    <div className="bubble thinking">
      <header className="bubble-h" onClick={() => setOpen((v) => !v)} style={{ cursor: hasMore ? 'pointer' : 'default' }}>
        {hasMore && <span className="caret">{open ? '▾' : '▸'}</span>}
        <span className="tag">thinking</span>
        {m.createdAt > 0 && <MessageTime ts={m.createdAt} />}
      </header>
      {!open ? (
        <div className="thinking-preview">{first}{hasMore ? '…' : ''}</div>
      ) : (
        <div className="thinking-full">{m.content}</div>
      )}
    </div>
  );
}

function ToolUseCard({ m, attachedResult, orphaned = false }: { m: Msg; attachedResult?: Msg; orphaned?: boolean }) {
  const [openInput, setOpenInput] = useState(false);
  const [openResult, setOpenResult] = useState(false);
  let parsed: any = null;
  try { parsed = JSON.parse(m.content); } catch {}
  const name = parsed?.name ?? '?';
  const input = parsed?.input ?? {};
  const summary = summarizeToolInput(name, input);

  // Parse the attached result
  let resultObj: { content: string; isError: boolean } | null = null;
  if (attachedResult) {
    try {
      const rp = JSON.parse(attachedResult.content);
      resultObj = { content: String(rp.content ?? ''), isError: !!rp.is_error };
    } catch {
      resultObj = { content: attachedResult.content, isError: false };
    }
  }

  const resultPreview = resultObj
    ? (() => {
        const lines = resultObj.content.split('\n').filter((l) => l.trim().length > 0);
        return lines.slice(0, 3).join(' · ').slice(0, 200);
      })()
    : null;
  const resultIsLong = resultObj && (resultObj.content.length > 200 || resultObj.content.split('\n').length > 3);

  return (
    <div className={`bubble tool-use ${resultObj ? 'has-result' : orphaned ? 'interrupted' : 'running'}${resultObj?.isError ? ' err' : ''}`}>
      <header className="bubble-h" onClick={() => setOpenInput((v) => !v)}>
        <span className="caret">{openInput ? '▾' : '▸'}</span>
        <span className="tu-glyph">⚒</span>
        <span className="tu-name">{name}</span>
        <span className="tu-summary">{summary}</span>
        {/* A pulsing "running" on a tool whose CLI is gone is the single most
            misleading thing the chat can show — it reads as work in progress
            on a session the sidebar calls ready. Same card, honest label. */}
        {!resultObj && (orphaned
          ? <span className="tu-orphan" title="the session ended before this tool returned — its result can never arrive">⚠ interrupted</span>
          : <span className="tu-running"><span className="dot" /> running</span>)}
        {m.createdAt > 0 && <MessageTime ts={m.createdAt} />}
      </header>
      {openInput && <DetailPre className="tu-detail" text={JSON.stringify(input, null, 2)} />}
      {resultObj && (
        <div className="tu-result">
          <div className="tr-line" onClick={() => resultIsLong && setOpenResult((v) => !v)} style={{ cursor: resultIsLong ? 'pointer' : 'default' }}>
            <span className="elbow">⎿</span>
            {resultObj.isError ? <span className="r-status err">✗</span> : <span className="r-status ok">✓</span>}
            <span className="r-preview">{resultPreview || '(empty)'}</span>
            {resultIsLong && <span className="caret">{openResult ? '▾' : '▸'}</span>}
          </div>
          {openResult && resultIsLong && (
            <DetailPre
              className="tr-detail"
              text={
                resultObj.content.slice(0, 8000) +
                (resultObj.content.length > 8000
                  ? `\n[…truncated ${resultObj.content.length - 8000} chars]`
                  : '')
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

function ToolResultCard({ m }: { m: Msg }) {
  // Displayed standalone when we couldn't link it to a tool_use
  // (should be rare). Discreet style.
  const [open, setOpen] = useState(false);
  let content = m.content;
  try {
    const parsed = JSON.parse(m.content);
    if (typeof parsed === 'object' && parsed?.content != null) content = String(parsed.content);
  } catch {}
  const preview = content.split('\n').slice(0, 2).join(' ').slice(0, 120);
  const isLong = content.length > 240 || content.split('\n').length > 3;
  return (
    <div className="bubble tool-result orphan">
      <header className="bubble-h" onClick={() => isLong && setOpen((v) => !v)} style={{ cursor: isLong ? 'pointer' : 'default' }}>
        {isLong && <span className="caret">{open ? '▾' : '▸'}</span>}
        <span className="tag">tool_result</span>
        <span className="tr-preview">{preview}{content.length > 120 ? '…' : ''}</span>
      </header>
      {(open || !isLong) && (
        <DetailPre
          className="tr-detail"
          text={content.slice(0, 8000) + (content.length > 8000 ? `\n[…truncated ${content.length - 8000} chars]` : '')}
        />
      )}
    </div>
  );
}

export function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    // ── Claude tools ──
    case 'Read':       return String(input.file_path ?? '');
    case 'Edit':       return String(input.file_path ?? '') + (input.replace_all ? ' (replace_all)' : '');
    case 'Write':      return String(input.file_path ?? '');
    case 'MultiEdit':  return String(input.file_path ?? '') + ` (${(input.edits ?? []).length} edits)`;
    case 'Bash':       return String(input.command ?? '').slice(0, 100);
    case 'Grep':       return `"${input.pattern ?? ''}" in ${input.path ?? '.'}`;
    case 'Glob':       return String(input.pattern ?? '');
    case 'WebFetch':   return String(input.url ?? '');
    case 'WebSearch':  return String(input.query ?? '');
    // ── Codex tools (OpenAI) ──
    // `shell`: input.command is an argv array (or a plain string) — show the
    // command line the model is about to run.
    case 'shell':
    case 'local_shell': {
      const c = input.command ?? input.cmd;
      const cmd = Array.isArray(c) ? c.join(' ') : String(c ?? '');
      return cmd.slice(0, 100);
    }
    // `apply_patch`: the file(s) touched, parsed out of the patch envelope.
    case 'apply_patch': {
      const patch = String(input.input ?? input.patch ?? '');
      const files = extractPatchFiles(patch);
      return files.length ? files.join(', ') : 'patch';
    }
    case 'web_search':  return String(input.query ?? input.q ?? '');
    // Codex's plan tool — rendered as a plain tool card (the hub keeps no
    // plan/todo state of its own).
    case 'update_plan': return `${(input.plan ?? input.steps ?? []).length} steps`;
    default: {
      // MCP tools surface as `mcp__server__tool` / `server__tool` / `server/tool`
      // — the tool NAME already shows in the card; summarize the first argument.
      const keys = Object.keys(input);
      if (keys.length === 0) return '';
      const first = keys[0];
      const v = input[first];
      return `${first}=${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v).slice(0, 80)}`;
    }
  }
}

// Extract the file paths from an `apply_patch` envelope. Codex patches use
// `*** Add/Update/Delete File: <path>` markers (and sometimes unified `+++ b/…`
// headers). Best-effort — returns [] when nothing recognizable is found.
function extractPatchFiles(patch: string): string[] {
  const out: string[] = [];
  const re = /^\*\*\* (?:Add|Update|Delete|Move) File:\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) out.push(m[1]);
  if (out.length === 0) {
    const re2 = /^\+\+\+ b\/(.+?)\s*$/gm;
    while ((m = re2.exec(patch)) !== null) out.push(m[1]);
  }
  return out.slice(0, 4);
}

// Every bubble timestamp (header + footer, all roles). Its own component so
// the midnight tick re-renders these few nodes, not the memoized bubbles.
function MessageTime({ ts }: { ts: number }) {
  const todayStart = useTodayStart();
  return <time dateTime={new Date(ts * 1000).toISOString()}>{formatMessageTime(ts, todayStart)}</time>;
}

// THE clipboard action, shared by every copy affordance in a bubble (whole
// message, fenced code block, tool JSON/output pane). One component (not
// inlined in Message) so the `copied` flash is a local hook with no
// rules-of-hooks entanglement with Message's early returns for the other
// roles — and so the three anchors can't drift apart.
function CopyButton({ text, className, title }: { text: string; className: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async (e: React.MouseEvent) => {
    // Several of these sit inside cards whose header/line toggles open on
    // click; copying must not also fold the thing you're copying.
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API needs a secure context — nothing sensible to fall back
      // to inline here (unlike copyPath's alert(), a whole message or code
      // block is too long for a prompt), so this quietly no-ops.
    }
  };
  return (
    <button
      type="button"
      className={`${className}${copied ? ' copied' : ''}`}
      onClick={onClick}
      title={copied ? 'copied' : title}
    >
      {copied ? '✓' : <IconClipboard />}
    </button>
  );
}

// "copy the whole message" — sits next to the timestamp, top and bottom of
// the main chat bubble (§ CLAUDE.md 11).
function CopyMessageButton({ content }: { content: string }) {
  return <CopyButton text={content} className="bubble-copy-btn" title="copy the message text" />;
}

// A fenced code block in an assistant answer (`<pre><code class="hljs
// language-js">`) gets its OWN copy button: the bubble-level one copies the
// surrounding prose too, which is exactly wrong when the block is a snippet
// you're about to paste into a file or a shell. The button hangs off the
// WRAPPER, never inside the `<pre>` — that element scrolls horizontally
// (`.content.md pre`), and a button inside it slides out of view on the first
// long line.
function CodeBlock({ node, children, ...props }: React.ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  const text = hastText(node);
  const mermaid = hastCodeLanguage(node) === 'mermaid';
  return (
    <div className={`code-block${mermaid ? ' mermaid-block' : ''}`}>
      {mermaid ? <MermaidDiagram source={text} /> : <pre {...props}>{children}</pre>}
      {text.trim() !== '' && (
        <CopyButton text={text} className="code-copy-btn" title="copy this code block" />
      )}
    </div>
  );
}

// The tool cards' raw panes — the request JSON and the tool output — are code
// blocks too, just not markdown ones: same wrapper, same corner button, so
// "copy that" means one thing everywhere in the transcript.
function DetailPre({ className, text }: { className: string; text: string }) {
  return (
    <div className="code-block">
      <pre className={className}>{text}</pre>
      <CopyButton text={text} className="code-copy-btn" title="copy this block" />
    </div>
  );
}
