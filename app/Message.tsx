'use client';
import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { AgentKind } from '@/lib/types/api';
import AgentLogo from './AgentLogo';
import { isClaudeAuthExpired } from '@/lib/authExpired';
import { isTurnInterrupted } from '@/lib/turnInterrupted';

// Shared desktop/mobile type defined in `./sessionTypes`. Re-exported here
// to preserve historical imports (`import { Msg } from './Message'`).
import type { Msg } from './sessionTypes';
export type { Msg };

// Stable plugin/component identities. Besides avoiding small allocations on
// every bubble render, this lets react-markdown reuse more of its processing
// setup for completed messages.
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_REHYPE_PLUGINS: NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
];
const MARKDOWN_COMPONENTS: NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']> = {
  a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

type Props = {
  m: Msg;
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
};

function Message({ m, streaming = false, attachedResult, kind = 'claude', onReauth, onContinue, orphaned = false }: Props) {
  if (m.role === 'tool_use') return <ToolUseCard m={m} attachedResult={attachedResult} orphaned={orphaned} />;
  if (m.role === 'tool_result') return <ToolResultCard m={m} />;
  if (m.role === 'event' || m.role === 'edit_snapshot') return null;
  // user_question and exit_plan_request are already represented by the
  // AskUserQuestion / ExitPlanMode tool_use above — we don't render the raw duplicate.
  if (m.role === 'user_question' || m.role === 'exit_plan_request') return null;
  if (m.role === 'thinking') return <ThinkingBubble m={m} />;

  const isAssistant = m.role === 'assistant';
  return (
    <div
      className={`bubble role-${m.role}${streaming ? ' streaming' : ''}`}
      data-msg-role={m.role}
    >
      <header className="bubble-h">
        <span className="tag">{m.role}</span>
        {/* Per-message agent attribution (assistant only): a small Claude/Codex
            logo so it's always clear which backend is speaking, next to the
            API-confirmed model id (from AssistantMessage.model, NOT the model's
            own self-identification). The chip is absent on messages persisted
            before the feature / on old agents — the logo still shows. */}
        {isAssistant && (
          <AgentLogo kind={kind} size={12} className="bubble-agent-logo" />
        )}
        {isAssistant && m.model && (
          <span className="model-chip" title={`API-confirmed model for this message: ${m.model}`}>
            {m.model}
          </span>
        )}
        {m.createdAt > 0 && <time>{fmtTime(m.createdAt)}</time>}
      </header>
      <div className="content md">
        {isAssistant ? (
          streaming ? (
            // Parsing + auto-detecting/highlighting the entire growing answer
            // at 60Hz was quadratic work. The final persisted bubble gets the
            // full Markdown renderer; the live tail stays deliberately cheap.
            <span className="streaming-plain">{m.content}</span>
          ) : (
            <ReactMarkdown
              remarkPlugins={MARKDOWN_REMARK_PLUGINS}
              rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
              components={MARKDOWN_COMPONENTS}
            >
              {m.content}
            </ReactMarkdown>
          )
        ) : (
          <span>{m.content}</span>
        )}
      </div>
      {isAssistant && onReauth && kind === 'claude' && isClaudeAuthExpired(m.content) && (
        <div className="bubble-reauth">
          <span>This VPS's Claude sign-in has expired — the session can't run until it's renewed.</span>
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

function ThinkingBubble({ m }: { m: Msg }) {
  const [open, setOpen] = useState(false);
  const first = m.content.split('\n')[0].slice(0, 110);
  const hasMore = m.content.length > first.length;
  return (
    <div className="bubble thinking">
      <header className="bubble-h" onClick={() => setOpen((v) => !v)} style={{ cursor: hasMore ? 'pointer' : 'default' }}>
        {hasMore && <span className="caret">{open ? '▾' : '▸'}</span>}
        <span className="tag">thinking</span>
        {m.createdAt > 0 && <time>{fmtTime(m.createdAt)}</time>}
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
        {m.createdAt > 0 && <time>{fmtTime(m.createdAt)}</time>}
      </header>
      {openInput && <pre className="tu-detail">{JSON.stringify(input, null, 2)}</pre>}
      {resultObj && (
        <div className="tu-result">
          <div className="tr-line" onClick={() => resultIsLong && setOpenResult((v) => !v)} style={{ cursor: resultIsLong ? 'pointer' : 'default' }}>
            <span className="elbow">⎿</span>
            {resultObj.isError ? <span className="r-status err">✗</span> : <span className="r-status ok">✓</span>}
            <span className="r-preview">{resultPreview || '(empty)'}</span>
            {resultIsLong && <span className="caret">{openResult ? '▾' : '▸'}</span>}
          </div>
          {openResult && resultIsLong && (
            <pre className="tr-detail">
              {resultObj.content.slice(0, 8000)}
              {resultObj.content.length > 8000 ? `\n[…truncated ${resultObj.content.length - 8000} chars]` : ''}
            </pre>
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
        <pre className="tr-detail">{content.slice(0, 8000)}{content.length > 8000 ? `\n[…truncated ${content.length - 8000} chars]` : ''}</pre>
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

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
