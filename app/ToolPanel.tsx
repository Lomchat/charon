'use client';
import { useMemo, useState } from 'react';
import { createPatch } from 'diff';
import { api } from '@/lib/api';
import SplitDiffModal from './SplitDiffModal';

// Shared desktop/mobile types defined in `./sessionTypes`. Re-exported here
// to preserve historical imports (`import { ToolCallEntry, Todo,
// EditSnapshot } from './ToolPanel'`).
export type { ToolCallEntry, Todo, EditSnapshot } from './sessionTypes';
import type { ToolCallEntry, Todo, EditSnapshot } from './sessionTypes';

type Props = {
  sessionId: string | null;
  toolCalls: ToolCallEntry[];
  todos: Todo[];
  edits: Map<string, EditSnapshot>;
  onRevert: () => void; // refresh signal
};

type Tab = 'diffs' | 'todos' | 'calls';

export default function ToolPanel({ sessionId, toolCalls, todos, edits, onRevert }: Props) {
  const [tab, setTab] = useState<Tab>('diffs');
  const editArr = useMemo(() => Array.from(edits.values()), [edits]);

  return (
    <aside className="tool-panel">
      <nav className="tp-tabs">
        <button className={tab === 'diffs' ? 'on' : ''} onClick={() => setTab('diffs')}>
          diffs {editArr.length > 0 && <span className="badge">{editArr.length}</span>}
        </button>
        <button className={tab === 'todos' ? 'on' : ''} onClick={() => setTab('todos')}>
          todos {todos.length > 0 && <span className="badge">{todos.filter((t) => t.status !== 'completed').length}/{todos.length}</span>}
        </button>
        <button className={tab === 'calls' ? 'on' : ''} onClick={() => setTab('calls')}>
          tools {toolCalls.length > 0 && <span className="badge">{toolCalls.length}</span>}
        </button>
      </nav>
      <div className="tp-body">
        {tab === 'diffs' && <DiffsTab sessionId={sessionId} edits={editArr} onRevert={onRevert} />}
        {tab === 'todos' && <TodosTab todos={todos} />}
        {tab === 'calls' && <CallsTab calls={toolCalls} />}
      </div>
    </aside>
  );
}

function DiffsTab({ sessionId, edits, onRevert }: { sessionId: string | null; edits: EditSnapshot[]; onRevert: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<EditSnapshot | null>(null);
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
      <div className="tp-diffs">
        {edits.map((e) => {
          const patch = makeUnifiedDiff(e.filePath, e.before ?? '', e.after ?? '');
          const stats = countDiff(patch);
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
                  <button className="compare" onClick={() => setOpen(e)} title="compare side by side">⇄ split</button>
                  <button className="revert" disabled={busy === e.filePath} onClick={() => revert(e.filePath, e.before)}>
                    {busy === e.filePath ? '…' : 'revert'}
                  </button>
                </div>
              </div>
              {e.truncated && <div className="warn">⚠ truncated snapshot (file &gt; 256KB)</div>}
              {e.before == null && <div className="note">new file (Write)</div>}
              <pre className="diff-body">{renderDiffHtml(patch)}</pre>
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

function TodosTab({ todos }: { todos: Todo[] }) {
  if (todos.length === 0) return <div className="tp-empty">no todos</div>;
  return (
    <ul className="todo-list">
      {todos.map((t, i) => (
        <li key={i} className={`todo-${t.status}`}>
          <span className="chk">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'}</span>
          <span className="text">{t.content}</span>
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
