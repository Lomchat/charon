'use client';
import { memo, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { createPatch } from 'diff';
import { api } from '@/lib/api';
import type { AgentKind, SessionAttachment } from '@/lib/types/api';
import SplitDiffModal from './SplitDiffModal';
import { fmtSize } from './sessionAttachments';
import GitTab from './GitTab';
import TreeTab from './TreeTab';
import SearchTab from './SearchTab';
import { useGitStatus, workspaceDirtyCount } from './gitStore';
import { IconTree } from './fileIcons';
import {
  IconClipboard, IconDiff, IconDownload, IconEye, IconFileEarmark, IconGitBranch,
  IconPaperclip, IconPlusSquare, IconSearch, IconTools, IconTrash,
} from './icons';

// Shared desktop/mobile types defined in `./sessionTypes`. Re-exported here
// to preserve historical imports (`import { ToolCallEntry, EditSnapshot }
// from './ToolPanel'`).
export type { ToolCallEntry, EditSnapshot } from './sessionTypes';
import type { ToolCallEntry, EditSnapshot } from './sessionTypes';

type Props = {
  sessionId: string | null;
  // Backend of the session. Codex ships a ready-made UNIFIED DIFF (in the edit
  // snapshot's `after`, before=null) instead of a before/after pair — rendered
  // as a raw patch. cf. CLAUDE.md §14.59.
  kind?: AgentKind;
  toolCalls: ToolCallEntry[];
  edits: Map<string, EditSnapshot>;
  onRevert: () => void; // refresh signal
  // Files the user attached to this session (drag & drop / paperclip). The
  // list is owned by ClaudeSessionView so this panel and the input bar always
  // show the same thing. cf. app/sessionAttachments.ts.
  attachments?: SessionAttachment[];
  onRemoveAttachment?: (id: string) => void;
  // Re-insert a path into the message being composed.
  onInsertPath?: (path: string) => void;
  /** Jump to the session touching a file, from the explorer (§14.88). */
  onOpenSession?: (sessionId: string) => void;
  // Source control (§14.76). Scoped to the REPO containing `cwd`, not to the
  // session — which is why it takes (vpsId, cwd) and not sessionId.
  vpsId?: string | null;
  cwd?: string | null;
  /** A session is mid-turn in this repo: warn before committing, never block. */
  repoBusy?: boolean;
  /** One-shot "open on this tab" request (from the header's dirty chip). */
  requestedTab?: Tab | null;
  onTabConsumed?: () => void;
  /** Reveal the panel — it is a drawer below 1100px, where switching a tab
   *  nobody can see is the same as doing nothing. */
  onReveal?: () => void;
};

const SessionInsight = dynamic(() => import('./SessionInsight'), { ssr: false });

export type Tab = 'edits' | 'git' | 'tree' | 'search' | 'files' | 'calls';

// Six tabs in 340px: the labels alone (10px, letter-spacing .16em, uppercase)
// do not fit. Only the ACTIVE tab is labelled; the others are icon-only and
// their count shrinks to a corner dot. That is not just a width trick — the
// panel is a drawer on touch (<=1100px) where `title` tooltips don't exist, so
// icon-only-everywhere would be undiscoverable. The active label is the legend,
// which is also why every label has to stay SHORT: five icons plus one long
// label is what fits. `edits` is the SESSION's edits — what an agent changed
// in this conversation — and `git` is the working tree; they were both called
// some flavour of "diff" and got confused for each other constantly.
// `files` is the project explorer and `attach` is the session's attachments —
// the paperclip tab was labelled "files" before the tree existed, and keeping
// that name for the smaller of the two would have made the new one unfindable.
const TABS: { id: Tab; label: string; Icon: (p: { className?: string }) => React.ReactElement }[] = [
  { id: 'tree', label: 'files', Icon: IconTree },
  { id: 'search', label: 'search', Icon: IconSearch },
  { id: 'git', label: 'git', Icon: IconGitBranch },
  { id: 'edits', label: 'edits', Icon: IconDiff },
  { id: 'files', label: 'attach', Icon: IconPaperclip },
  { id: 'calls', label: 'tools', Icon: IconTools },
];

function ToolPanel({
  sessionId, kind = 'claude', toolCalls, edits, onRevert,
  attachments = [], onRemoveAttachment, onInsertPath, onOpenSession,
  vpsId = null, cwd = null, repoBusy = false, requestedTab = null, onTabConsumed,
  onReveal,
}: Props) {
  const [tab, setTab] = useState<Tab>('tree');
  // Hide content-less skeleton entries (edit_snapshot content is stripped by
  // the GET and refilled lazily — CLAUDE.md §14 gotcha 41). A both-null entry
  // has no diff to show; it appears once loadEdits fills its content.
  const editArr = useMemo(
    () => Array.from(edits.values()).filter((e) => e.before != null || e.after != null),
    [edits],
  );

  // The dirty chip in the chat header opens this panel ON the git tab. It's a
  // one-shot request rather than a controlled prop so the user can switch tabs
  // afterwards without the parent yanking them back.
  useEffect(() => {
    if (!requestedTab) return;
    setTab(requestedTab);
    onTabConsumed?.();
  }, [requestedTab, onTabConsumed]);

  // Ctrl/Cmd+Shift+F — search across files. Bound here rather than in either
  // parent because this component is the only thing both call sites have in
  // common, and it already owns the active tab.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'f') return;
      e.preventDefault();
      setTab('search');
      onReveal?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onReveal]);

  // Same poll the chip and the git tab already share — keyed on (vpsId, cwd),
  // so asking for it here costs nothing extra (§14.76).
  const { workspace } = useGitStatus(vpsId, cwd);
  const gitDirty = workspaceDirtyCount(workspace);

  const counts: Record<Tab, number> = {
    edits: editArr.length,
    // The working tree's dirty count, same badge as the others — the chip in
    // the header is only visible next to a chat, and this panel also renders
    // beside a file editor.
    git: gitDirty,
    tree: 0,   // a file count would be meaningless on a lazily-expanded tree
    search: 0, // the hit count is the answer, and it belongs above the results
    files: attachments.length,
    calls: toolCalls.length,
  };

  return (
    <aside className="tool-panel">
      <nav className="tp-tabs">
        {TABS.map(({ id, label, Icon }) => {
          const on = tab === id;
          const n = counts[id];
          return (
            <button
              key={id}
              className={`${on ? 'on' : ''}${n > 0 ? ' has-badge' : ''}`}
              onClick={() => setTab(id)}
              title={label}
              aria-label={label}
              aria-current={on ? 'page' : undefined}
            >
              <Icon className="tp-ico" />
              {on && <span className="tp-label">{label}</span>}
              {n > 0 && <span className="badge">{n}</span>}
            </button>
          );
        })}
      </nav>
      <div className="tp-body">
        {tab === 'edits' && <EditsTab sessionId={sessionId} kind={kind} edits={editArr} onRevert={onRevert} />}
        {tab === 'git' && <GitTab sessionId={sessionId} kind={kind} vpsId={vpsId} cwd={cwd} busy={repoBusy} onOpenSession={onOpenSession} />}
        {tab === 'tree' && <TreeTab vpsId={vpsId} cwd={cwd} sessionId={sessionId} onInsertPath={onInsertPath} onOpenSession={onOpenSession} />}
        {tab === 'search' && <SearchTab vpsId={vpsId} cwd={cwd} onInsertPath={onInsertPath} />}
        {tab === 'calls' && (
          <>
            {/* Context window, MCP health and sub-agent transcripts share this
                tab rather than each taking their own: six tab labels already
                do not fit in 340px (§11), and all three answer "what is the
                state of this session, beyond the transcript". */}
            {sessionId && <SessionInsight sessionId={sessionId} isCodex={kind === 'codex'} />}
            <CallsTab calls={toolCalls} />
          </>
        )}
        {tab === 'files' && (
          <FilesTab
            sessionId={sessionId}
            attachments={attachments}
            onRemove={onRemoveAttachment}
            onInsert={onInsertPath}
          />
        )}
      </div>
    </aside>
  );
}

export default memo(ToolPanel);

function EditsTab({ sessionId, kind, edits, onRevert }: { sessionId: string | null; kind: AgentKind; edits: EditSnapshot[]; onRevert: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<EditSnapshot | null>(null);

  // Codex hands us a ready-made unified diff (in `after`); Claude gives a
  // before/after pair we diff ourselves. Side-by-side split + revert only make
  // sense for the Claude pair (a bare patch has no clean "before" to restore).
  const isCodex = kind === 'codex';
  const prepared = useMemo(() => edits.map((edit) => {
    const patch = isCodex ? (edit.after ?? '') : makeUnifiedDiff(edit.filePath, edit.before ?? '', edit.after ?? '');
    return { edit, patch, stats: countDiff(patch) };
  }), [edits, isCodex]);

  if (edits.length === 0) return <div className="tp-empty">no files modified in this session</div>;

  async function revert(filePath: string, before: string | null) {
    if (!sessionId) return;
    if (!confirm(`Restore "${filePath}" to its initial state?`)) return;
    setBusy(filePath);
    try {
      await api.revertClaudeEdit(sessionId, filePath, before);
      onRevert();
    } catch (e: any) {
      alert('revert: ' + (e?.message ?? e));
    } finally { setBusy(null); }
  }

  return (
    <>
      <div className="tp-edits">
        {prepared.map(({ edit: e, patch, stats }) => {
          return (
            <div key={e.toolUseId + e.filePath} className="diff-card">
              <div className="diff-head">
                <div className="diff-path-row">
                  <span className="path">{e.filePath}</span>
                </div>
                <div className="diff-meta-row">
                  <span className="stats">
                    <span className="add">+{stats.add}</span>
                    <span className="del">−{stats.del}</span>
                  </span>
                  {!isCodex && (
                    <>
                      <button className="compare" onClick={() => setOpen(e)} title="compare side by side">⇄ split</button>
                      <button className="revert" disabled={busy === e.filePath} onClick={() => revert(e.filePath, e.before)}>
                        {busy === e.filePath ? '…' : 'revert'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {e.truncated && <div className="warn">⚠ truncated snapshot (file &gt; 256KB)</div>}
              {!isCodex && e.before == null && <div className="note">new file (Write)</div>}
              <pre className="diff-body">{isCodex ? renderRawPatch(patch) : renderDiffHtml(patch)}</pre>
            </div>
          );
        })}
      </div>
      {open && (
        <SplitDiffModal
          filePath={open.filePath}
          before={open.before}
          after={open.after}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/**
 * Files attached to the session.
 *
 * The point of this tab is continuity: within one session the user can see
 * which files are actually in play on the VPS, get them back, and re-attach one
 * to a later message without hunting through the transcript for the path.
 *
 * Three actions per file, in order of how often they're wanted:
 *  - `+`  re-insert the path into the message being composed (the whole reason
 *         the tab exists — a file uploaded 40 messages ago is one click away).
 *  - copy the path (for a shell, or to paste into another session).
 *  - download the hub-side copy.
 * Removal is deliberately last and unlabelled-by-default: it drops the entry and
 * best-effort deletes the remote file, which would strand any earlier message
 * that references it.
 */
function FilesTab({ sessionId, attachments, onRemove, onInsert }: {
  sessionId: string | null;
  attachments: SessionAttachment[];
  onRemove?: (id: string) => void;
  onInsert?: (path: string) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copyPath(a: SessionAttachment) {
    try {
      await navigator.clipboard.writeText(a.remotePath);
      setCopied(a.id);
      setTimeout(() => setCopied((c) => (c === a.id ? null : c)), 1200);
    } catch {
      // Clipboard API needs a secure context (https / localhost). On plain
      // http the path is still selectable in the DOM — don't pretend it worked.
      alert(a.remotePath);
    }
  }

  if (attachments.length === 0) {
    return (
      <div className="tp-empty">
        no files attached yet
        <br />
        <span className="tp-empty-hint">drop a file anywhere on the page, or use the 📎 button</span>
      </div>
    );
  }

  return (
    <ul className="files-list">
      {attachments.map((a) => (
        <li key={a.id}>
          <div className="f-head">
            <IconFileEarmark className="f-icon" />
            <span className="f-name" title={a.name}>{a.name}</span>
            <span className="f-size">{fmtSize(a.size)}</span>
          </div>
          <div className="f-path" title={a.remotePath}>{a.remotePath}</div>
          <div className="f-actions">
            {/* Open in a new tab and let the browser render it natively —
                image, PDF, audio, video, text. Shown only when the SERVER says
                it will serve this file inline (`previewMime`), so the button
                can never promise a preview the route would refuse.
                `rel=noopener` because the new tab is a sandboxed document we
                don't want holding a handle on `window.opener`. */}
            {sessionId && a.previewMime && (
              <a
                className="f-open"
                href={api.sessionAttachmentUrl(sessionId, a.id, { inline: true })}
                target="_blank"
                rel="noopener noreferrer"
                title={`open in a new tab (${a.previewMime})`}
              >
                <IconEye /> open
              </a>
            )}
            <button type="button" onClick={() => onInsert?.(a.remotePath)} title="insert this path into the message">
              <IconPlusSquare /> insert
            </button>
            <button type="button" onClick={() => copyPath(a)} title="copy the path on the VPS">
              <IconClipboard /> {copied === a.id ? 'copied' : 'copy'}
            </button>
            {sessionId && (
              <a
                className="f-dl"
                href={api.sessionAttachmentUrl(sessionId, a.id)}
                download={a.name}
                title="download the copy kept by Charon"
              >
                <IconDownload /> get
              </a>
            )}
            <button
              type="button"
              className="f-rm"
              onClick={() => {
                if (confirm(`Remove "${a.name}" from this session?\n\nThe copy on the VPS is deleted too — any earlier message pointing at this path will stop resolving.`)) {
                  onRemove?.(a.id);
                }
              }}
              title="remove from the session (deletes the file on the VPS)"
            >
              <IconTrash />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function CallsTab({ calls }: { calls: ToolCallEntry[] }) {
  if (calls.length === 0) return <div className="tp-empty">no tool calls</div>;
  return (
    <ul className="calls-list">
      {calls.slice().reverse().map((c) => (
        <li key={c.id} className={c.result?.isError ? 'err' : ''}>
          <div className="head">
            <span className="name">{c.name}</span>
            <span className="time">{fmtTime(c.startedAt)}</span>
          </div>
          <div className="input">{summarizeInput(c.name, c.input)}</div>
          {c.result && (
            <div className="result">
              {c.result.isError ? '✗ ' : '✓ '}
              {c.result.content.slice(0, 80)}{c.result.content.length > 80 ? '…' : ''}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────
function makeUnifiedDiff(filePath: string, before: string, after: string): string {
  return createPatch(filePath, before, after, '', '', { context: 3 });
}

function countDiff(patch: string): { add: number; del: number } {
  let add = 0, del = 0;
  for (const l of patch.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return { add, del };
}

function renderDiffHtml(patch: string): React.ReactNode {
  const lines = patch.split('\n').slice(4); // strip header
  return lines.map((l, i) => {
    let cls = 'ctx';
    if (l.startsWith('+')) cls = 'add';
    else if (l.startsWith('-')) cls = 'del';
    else if (l.startsWith('@@')) cls = 'hunk';
    return <span key={i} className={`dline ${cls}`}>{l + '\n'}</span>;
  });
}

// Render a Codex-supplied unified diff verbatim (Codex already produces the
// patch — we must NOT re-diff it). Classifies every line: file/patch headers
// dimmed, @@ hunks highlighted, +/− add/del. No fixed header slice (Codex
// patches don't share createPatch's exact 4-line preamble).
function renderRawPatch(patch: string): React.ReactNode {
  const lines = patch.split('\n');
  return lines.map((l, i) => {
    let cls = 'ctx';
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('*** ')) cls = 'meta';
    else if (l.startsWith('@@')) cls = 'hunk';
    else if (l.startsWith('+')) cls = 'add';
    else if (l.startsWith('-')) cls = 'del';
    return <span key={i} className={`dline ${cls}`}>{l + '\n'}</span>;
  });
}

function summarizeInput(name: string, input: any): string {
  if (!input) return '';
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit':
      return String(input.file_path ?? '').slice(0, 60);
    case 'Bash':
      return String(input.command ?? '').slice(0, 60);
    default:
      return JSON.stringify(input).slice(0, 60);
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
