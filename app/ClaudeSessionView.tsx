'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Vps } from '@/lib/db/schema';
import type { SessionListItem } from '@/lib/types/api';
import { api } from '@/lib/api';
import Message, { type Msg, summarizeToolInput } from './Message';
import ToolPanel from './ToolPanel';
import QuestionCard from './QuestionCard';
import ExitPlanCard from './ExitPlanCard';
import type {
  PermissionRequest, PendingQuestion, PendingExitPlan, ToolCallEntry,
} from './sessionTypes';
import { useClaudeSessionStream, type StreamCache } from './useClaudeSessionStream';
import { getCached, fetchAndCache, invalidate as invalidateCache } from './sessionCache';

// ClaudeSessionView
// ─────────────────────────────────────────────────────────────────────────────
// Composant qui rend toute la zone "session active" du dashboard desktop :
//   - Barre des actions (sleep / resume / kill / interrupt / force-stop)
//   - Bannière reconnexion / déconnexion / erreur
//   - Slot pour BootstrapBanner / LoginConsole (passés par le parent)
//   - Chat scroll-reverse + scroll pill
//   - ThinkingBar pendant 'thinking'
//   - Input bar (mode switch + textarea + send) — remplacée par
//     QuestionCard / ExitPlanCard / InlinePermissionCard si pending
//   - ToolPanel (diffs / todos / calls / files)
//
// Toute la logique SSE + state per-session est dans useClaudeSessionStream,
// donc ce composant est essentiellement du rendu + computeds.
//
// Le parent (ClaudePanel) garde : sidebar, modals globaux, push, service
// worker, popup permission cross-session, polling sessions list, etc.

type Props = {
  sessionId: string;
  selected: SessionListItem;
  selectedVps: Vps | null;
  // Slot pour overlays parent (BootstrapBanner pendant install agent,
  // LoginConsole pour `claude login`). Rendus entre la bar et le chat.
  overlay?: React.ReactNode;
  // Sound + native Notification gérés côté parent (cross-session), mais on
  // peut quand même jouer un beep sur stop si configuré.
  notifSoundEnabled?: boolean;
  // Détection d'erreur "claude-agent-sdk pas installé" → parent décide
  // d'afficher le BootstrapBanner (a accès au vpsRow + state global).
  onImportError?: (vps: Vps) => void;
  // Navigation post-kill (parent setSelectedId(null) + refresh).
  onKilled: () => void;
  // Après revert d'une édition fichier → refresh sessions list parent.
  onAfterRevert?: () => void;
};

// Cache de la session côté module — sessionCache.ts partagé desktop/mobile.
// L'instance StreamCache est créée une fois, pas par-render.
const sharedCacheRef: StreamCache = {
  get: (id) => getCached(id),
  fetch: (id, force) => fetchAndCache(id, force),
  invalidate: (id) => invalidateCache(id),
};

export default function ClaudeSessionView({
  sessionId, selected, selectedVps,
  overlay, onImportError, onKilled, onAfterRevert,
}: Props) {
  const stream = useClaudeSessionStream(sessionId, {
    cache: sharedCacheRef,
    onKilled,
  });
  const {
    messages, currentAssistant, status, permissionMode,
    toolCalls, todos, edits, files,
    permQueue, questionQueue, exitPlanQueue,
    prefillInput, error,
    send: streamSend, interrupt, forceStop, setMode,
    doSleep, doResume, doKill: streamDoKill,
    respondPermission, respondQuestion, respondExitPlan,
    clearPrefillInput, clearError,
  } = stream;

  // ── State UI local (textarea, scroll, error détails) ──────────────────────
  const [input, setInput] = useState('');
  const [errorOpen, setErrorOpen] = useState(false);
  const [errorCopied, setErrorCopied] = useState(false);

  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const lastMessageCountRef = useRef(0);

  // Drain de prefill_input : copie dans la textarea puis clear.
  useEffect(() => {
    if (prefillInput !== null) {
      setInput(prefillInput);
      clearPrefillInput();
    }
  }, [prefillInput, clearPrefillInput]);

  // Détection import-error → callback parent pour BootstrapBanner.
  // Le message d'erreur "No module named claude_agent_sdk" remonte du SDK
  // Python qui ne peut pas charger le module — l'agent est probablement
  // installé mais pas la dépendance pip.
  useEffect(() => {
    if (!error?.msg) return;
    const needsBootstrap =
      /No module named ['"]?claude_agent_sdk['"]?/i.test(error.msg) ||
      /claude-agent-sdk indisponible/i.test(error.msg) ||
      /ModuleNotFoundError/i.test(error.msg);
    if (needsBootstrap && selectedVps && onImportError) {
      clearError();
      onImportError(selectedVps);
    }
  }, [error, selectedVps, onImportError, clearError]);

  // ── Computeds ─────────────────────────────────────────────────────────────
  // Pair tool_use ↔ tool_result pour rendu inline.
  const renderable = useMemo(() => {
    const resultByToolUseId = new Map<string, Msg>();
    for (const m of messages) {
      if (m.role !== 'tool_result') continue;
      try {
        const parsed = JSON.parse(m.content);
        if (parsed?.tool_use_id) resultByToolUseId.set(String(parsed.tool_use_id), m);
      } catch {}
    }
    const out: { msg: Msg; attached?: Msg }[] = [];
    const consumedResults = new Set<string>();
    for (const m of messages) {
      if (m.role === 'tool_result') {
        try {
          const parsed = JSON.parse(m.content);
          if (parsed?.tool_use_id && resultByToolUseId.has(String(parsed.tool_use_id))) {
            if (consumedResults.has(m.id)) continue;
            continue;
          }
        } catch {}
        out.push({ msg: m });
        continue;
      }
      if (m.role === 'tool_use') {
        let attached: Msg | undefined;
        try {
          const parsed = JSON.parse(m.content);
          if (parsed?.id) {
            attached = resultByToolUseId.get(String(parsed.id));
            if (attached) consumedResults.add(attached.id);
          }
        } catch {}
        out.push({ msg: m, attached });
        continue;
      }
      out.push({ msg: m });
    }
    return out;
  }, [messages]);

  const stepCount = useMemo(() => {
    let count = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user') break;
      if (m.role === 'tool_use') count++;
    }
    return count;
  }, [messages]);

  type PendingInteraction =
    | { kind: 'permission'; createdAt: number; perm: PermissionRequest }
    | { kind: 'question'; createdAt: number; q: PendingQuestion }
    | { kind: 'exit_plan'; createdAt: number; ep: PendingExitPlan };
  const oldestPending = useMemo<PendingInteraction | null>(() => {
    const items: PendingInteraction[] = [];
    for (const p of permQueue) items.push({ kind: 'permission', createdAt: p.createdAt, perm: p });
    for (const q of questionQueue) items.push({ kind: 'question', createdAt: q.createdAt, q });
    for (const ep of exitPlanQueue) items.push({ kind: 'exit_plan', createdAt: ep.createdAt, ep });
    if (!items.length) return null;
    items.sort((a, b) => a.createdAt - b.createdAt);
    return items[0];
  }, [permQueue, questionQueue, exitPlanQueue]);

  const fallbackPlanFromMessages = useMemo(() => {
    if (!oldestPending || oldestPending.kind !== 'exit_plan' || oldestPending.ep.plan) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'tool_use') continue;
      try {
        const parsed = JSON.parse(m.content);
        if ((parsed.name === 'Write' || parsed.name === 'Edit') &&
            typeof parsed.input?.file_path === 'string' &&
            parsed.input.file_path.startsWith('/root/.claude/plans/')) {
          if (parsed.name === 'Write' && typeof parsed.input.content === 'string') {
            return String(parsed.input.content);
          }
          const snap = edits.get(parsed.input.file_path);
          if (snap?.after) return snap.after;
        }
      } catch {}
    }
    return '';
  }, [oldestPending, messages, edits]);

  const currentTool = useMemo(() => {
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      if (!toolCalls[i].result) return toolCalls[i];
    }
    return null;
  }, [toolCalls]);

  const turnStartedAt = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].createdAt;
    }
    return null;
  }, [messages]);

  // ── Scroll mechanics (column-reverse, |scrollTop| ≈ 0 = bas visuel) ───────
  const handleChatScroll = useCallback(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const atBottom = Math.abs(el.scrollTop) < 80;
    if (atBottom !== isAtBottomRef.current) {
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
    }
    if (atBottom) setNewCount(0);
  }, []);
  const onPillClick = useCallback(() => {
    setNewCount(0);
    const el = chatBodyRef.current;
    if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Compte les nouveaux messages quand l'user n'est PAS en bas, pour la pill ↓ N.
  useEffect(() => {
    const prev = lastMessageCountRef.current;
    const cur = messages.length;
    if (cur > prev && !isAtBottomRef.current) {
      setNewCount((c) => c + (cur - prev));
    }
    lastMessageCountRef.current = cur;
  }, [messages.length]);

  // ── Actions wrappers (gèrent juste l'UI locale autour du hook) ────────────
  const send = useCallback(async () => {
    const content = input.trim();
    if (!content) return;
    setInput('');
    await streamSend(content);
  }, [input, streamSend]);

  const doKill = useCallback(async () => {
    if (!confirm('Tuer cette session ? Les messages restent en historique.')) return;
    await streamDoKill();
  }, [streamDoKill]);

  const copyError = useCallback(async () => {
    if (!error?.msg) return;
    try {
      await navigator.clipboard.writeText(error.msg);
      setErrorCopied(true);
      setTimeout(() => setErrorCopied(false), 1500);
    } catch {}
  }, [error]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <main className="claude-main">
        <div className="claude-bar">
          <span className="bar-name">{selected.name || '(sans nom)'}</span>
          {status === 'sleeping' || status === 'killed' || status === 'error' ? (
            <button onClick={() => doResume()} disabled={selected.status === 'killed'}>resume</button>
          ) : (
            <button onClick={doSleep}>sleep</button>
          )}
          <button className="kill" onClick={doKill}>kill</button>
          <button onClick={interrupt} disabled={status !== 'thinking'}>interrupt</button>
          <button
            className="kill"
            onClick={forceStop}
            disabled={!['thinking', 'active', 'starting'].includes(status ?? '')}
            title="Cancel forcé (SDK bloqué) — la session passe sleeping, resume possible"
          >force stop</button>
        </div>

        {status === 'reconnecting' && (
          <div className="claude-reconnect-banner">
            <span className="msg"><span className="spin">↻</span> reconnexion auto en cours…</span>
          </div>
        )}

        {(status === 'sleeping' || status === 'error') && (
          <div className="claude-disconnect-banner-wrap">
            <div className="claude-disconnect-banner" onClick={() => doResume()} role="button">
              <span className="msg">
                session inactive — cliquez pour reconnecter
                {error?.msg ? <em className="why"> · {error.msg.split('\n')[0].slice(0, 160)}</em> : null}
              </span>
              <span className="resume-chip">↺ resume</span>
            </div>
            {error?.msg && (
              <div className="claude-error-details">
                <div className="err-tools">
                  <button type="button" onClick={(e) => { e.stopPropagation(); setErrorOpen((v) => !v); }}>
                    {errorOpen ? '▾ masquer détails' : '▸ voir détails'}
                  </button>
                  <button type="button" className="copy-btn" onClick={(e) => { e.stopPropagation(); copyError(); }} title="copier l'erreur">
                    {errorCopied ? '✓ copié' : '📋 copier'}
                  </button>
                  <button type="button" className="dismiss-btn" onClick={(e) => { e.stopPropagation(); clearError(); }} title="masquer l'erreur">✕</button>
                </div>
                {errorOpen && <pre className="err-pre">{error.msg}</pre>}
              </div>
            )}
          </div>
        )}

        {status !== 'sleeping' && status !== 'error' && error && (
          <div className="claude-error">
            <span className="msg">{error.msg.split('\n')[0].slice(0, 200)}</span>
            <button type="button" className="copy-btn" onClick={copyError} title="copier l'erreur">
              {errorCopied ? '✓' : '📋'}
            </button>
            <button onClick={clearError}>✕</button>
          </div>
        )}

        {overlay}

        <div className="claude-chat-wrap">
          <div className="claude-chat" ref={chatBodyRef} onScroll={handleChatScroll}>
            {currentAssistant && (
              <Message m={{ id: '__streaming', role: 'assistant', content: currentAssistant, createdAt: 0 }} streaming />
            )}
            {[...renderable].reverse().map(({ msg, attached }) => (
              <Message key={msg.id} m={msg} attachedResult={attached} />
            ))}
          </div>
          {!isAtBottom && (
            <button
              type="button"
              className={`claude-scroll-pill${newCount > 0 ? ' has-new' : ''}`}
              onClick={onPillClick}
              aria-label={newCount > 0 ? `${newCount} nouveau message — aller en bas` : 'aller en bas'}
              title={newCount > 0 ? `${newCount} nouveau message` : 'aller en bas'}
            >
              <span className="claude-scroll-arrow">▾</span>
              {newCount > 0 && <span className="claude-scroll-count">{newCount}</span>}
            </button>
          )}
        </div>

        {status === 'thinking' && (
          <ThinkingBar currentTool={currentTool} stepCount={stepCount} startedAt={turnStartedAt} />
        )}

        {/* Zone d'input — remplacée par CTA resume si déconnectée, ou
            QuestionCard/ExitPlanCard/PermissionCard si pending. */}
        {(status === 'sleeping' || status === 'error') ? (
          <div className="claude-disconnect-cta">
            <button onClick={() => doResume()}>↺ RESUME CETTE SESSION</button>
          </div>
        ) : status === 'killed' ? (
          <div className="claude-killed-cta">
            session tuée — historique consultable, mais pas reprenable
          </div>
        ) : oldestPending ? (
          <div className="claude-pending-zone">
            {oldestPending.kind === 'question' && (
              <QuestionCard
                questions={oldestPending.q.questions}
                onAnswer={(answers) => respondQuestion(oldestPending.q.id, answers)}
                onCancel={() => respondQuestion(oldestPending.q.id, null)}
              />
            )}
            {oldestPending.kind === 'exit_plan' && (
              <ExitPlanCard
                plan={oldestPending.ep.plan || fallbackPlanFromMessages}
                onApprove={() => respondExitPlan(oldestPending.ep.id, 'approve')}
                onReject={(feedback) => respondExitPlan(oldestPending.ep.id, 'reject', feedback)}
              />
            )}
            {oldestPending.kind === 'permission' && (
              <InlinePermissionCard
                perm={oldestPending.perm}
                onRespond={(allow, always) => respondPermission(oldestPending.perm.id, allow, always)}
              />
            )}
          </div>
        ) : (
          <footer className="claude-input-bar">
            <div className="mode-switch" role="radiogroup" aria-label="mode permissions">
              <button
                type="button" role="radio"
                aria-checked={permissionMode === 'normal'}
                className={`m-btn normal${permissionMode === 'normal' ? ' on' : ''}`}
                onClick={() => setMode('normal')}
                title="normal — demande la permission à chaque outil"
              >
                <span className="m-glyph">▷</span><span className="m-label">normal</span>
              </button>
              <button
                type="button" role="radio"
                aria-checked={permissionMode === 'acceptEdits'}
                className={`m-btn acceptEdits${permissionMode === 'acceptEdits' ? ' on' : ''}`}
                onClick={() => setMode('acceptEdits')}
                title="accept edits — auto-accepte les éditions de fichier, demande pour le reste"
              >
                <span className="m-glyph">▶▶</span><span className="m-label">accept edits</span>
              </button>
              <button
                type="button" role="radio"
                aria-checked={permissionMode === 'auto'}
                className={`m-btn auto${permissionMode === 'auto' ? ' on' : ''}`}
                onClick={() => setMode('auto')}
                title="accept all — accepte tout sans demander (DANGER)"
              >
                <span className="m-glyph">▶▶</span><span className="m-label">accept all</span>
              </button>
              <button
                type="button" role="radio"
                aria-checked={permissionMode === 'plan'}
                className={`m-btn plan${permissionMode === 'plan' ? ' on' : ''}`}
                onClick={() => setMode('plan')}
                title="plan mode — propose un plan sans exécuter d'outils"
              >
                <span className="m-glyph">⏸</span><span className="m-label">plan mode</span>
              </button>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="message à Claude (Entrée envoie, Shift/Ctrl+Entrée saut de ligne)"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
                e.preventDefault();
                send();
              }}
              rows={3}
            />
            <button className="send" onClick={send} disabled={!input.trim()}>envoyer</button>
          </footer>
        )}
      </main>

      <ToolPanel
        sessionId={sessionId}
        toolCalls={toolCalls}
        todos={todos}
        edits={edits}
        files={files}
        onRevert={() => onAfterRevert?.()}
      />
    </>
  );
}

// ── Sous-composants spécifiques à la vue ────────────────────────────────────

function InlinePermissionCard({ perm, onRespond }: {
  perm: PermissionRequest;
  onRespond: (allow: boolean, always: boolean) => void;
}) {
  const summary = summarizeToolInput(perm.tool, perm.input);
  return (
    <div className="inline-perm-card">
      <header className="ip-head">
        <span className="ip-tag">🔒 permission</span>
        <span className="ip-tool">{perm.tool}</span>
        {summary && <span className="ip-summary">{summary}</span>}
      </header>
      <pre className="ip-input">{JSON.stringify(perm.input, null, 2).slice(0, 1200)}</pre>
      <footer className="ip-actions">
        <button type="button" className="allow" onClick={() => onRespond(true, false)}>allow once</button>
        <button type="button" className="always" onClick={() => onRespond(true, true)}>allow always (session)</button>
        <button type="button" className="deny" onClick={() => onRespond(false, false)}>deny</button>
      </footer>
    </div>
  );
}

function ThinkingBar({
  currentTool, stepCount, startedAt,
}: {
  currentTool: ToolCallEntry | null;
  stepCount: number;
  startedAt: number | null;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  void tick;
  const elapsed = startedAt ? Math.max(0, Math.floor(Date.now() / 1000 - startedAt)) : null;
  return (
    <div className="thinking-bar">
      <span className="t-dot" />
      <span className="t-label">Claude réfléchit</span>
      {currentTool && (
        <span className="t-tool">
          <span className="sep">·</span>
          <span className="glyph">⚒</span>
          <span className="name">{currentTool.name}</span>
          <span className="sum">{summarizeToolInput(currentTool.name, currentTool.input)}</span>
        </span>
      )}
      <span className="t-meta">
        {stepCount > 0 && <><span className="sep">·</span> étape {stepCount}</>}
        {elapsed != null && <><span className="sep">·</span> {fmtElapsed(elapsed)}</>}
      </span>
    </div>
  );
}

function fmtElapsed(s: number): string {
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toString().padStart(2, '0')}s`;
}
