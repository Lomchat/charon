'use client';
import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

// Shared desktop/mobile type defined in `./sessionTypes`. Re-exported here
// to preserve historical imports (`import { Msg } from './Message'`).
import type { Msg } from './sessionTypes';
export type { Msg };

type Props = {
  m: Msg;
  streaming?: boolean;
  // If provided, the tool_result linked to this tool_use is rendered inline below (⎿ style)
  attachedResult?: Msg;
};

function Message({ m, streaming = false, attachedResult }: Props) {
  if (m.role === 'tool_use') return <ToolUseCard m={m} attachedResult={attachedResult} />;
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
        {m.createdAt > 0 && <time>{fmtTime(m.createdAt)}</time>}
      </header>
      <div className="content md">
        {isAssistant ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
            components={{
              a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
            }}
          >
            {m.content}
          </ReactMarkdown>
        ) : (
          <span>{m.content}</span>
        )}
      </div>
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

function ToolUseCard({ m, attachedResult }: { m: Msg; attachedResult?: Msg }) {
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
    <div className={`bubble tool-use ${resultObj ? 'has-result' : 'running'}${resultObj?.isError ? ' err' : ''}`}>
      <header className="bubble-h" onClick={() => setOpenInput((v) => !v)}>
        <span className="caret">{openInput ? '▾' : '▸'}</span>
        <span className="tu-glyph">⚒</span>
        <span className="tu-name">{name}</span>
        <span className="tu-summary">{summary}</span>
        {!resultObj && <span className="tu-running"><span className="dot" /> running</span>}
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
    case 'Read':       return String(input.file_path ?? '');
    case 'Edit':       return String(input.file_path ?? '') + (input.replace_all ? ' (replace_all)' : '');
    case 'Write':      return String(input.file_path ?? '');
    case 'MultiEdit':  return String(input.file_path ?? '') + ` (${(input.edits ?? []).length} edits)`;
    case 'Bash':       return String(input.command ?? '').slice(0, 100);
    case 'Grep':       return `"${input.pattern ?? ''}" in ${input.path ?? '.'}`;
    case 'Glob':       return String(input.pattern ?? '');
    case 'TodoWrite':  return `${(input.todos ?? []).length} todos`;
    case 'WebFetch':   return String(input.url ?? '');
    case 'WebSearch':  return String(input.query ?? '');
    default: {
      const keys = Object.keys(input);
      if (keys.length === 0) return '';
      const first = keys[0];
      const v = input[first];
      return `${first}=${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v).slice(0, 80)}`;
    }
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
