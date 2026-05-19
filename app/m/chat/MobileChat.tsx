'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { createPatch } from 'diff';
import { api } from '@/lib/api';
import type { Vps, VpsPath } from '@/lib/db/schema';
import type { WorkerStatus, PermissionMode } from '@/lib/server/claude/types';
import { getCached, fetchAndCache, invalidate as invalidateCache } from '../chatCache';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────
// Types Msg / ToolCallEntry / Todo / EditSnapshot / PermissionRequest /
// PendingQuestion / PendingExitPlan importés depuis le module partagé avec
// la vue desktop. La forme inclut `sessionId: string` (rempli côté mobile
// avec le sessionId courant, voir constructions plus bas).
import type {
  Msg, ToolCallEntry, Todo, EditSnapshot,
  PermissionRequest, PendingQuestion, PendingExitPlan,
} from '../../sessionTypes';
import { useClaudeSessionStream, type StreamCache } from '../../useClaudeSessionStream';
import { useCrossSessionInteractionFeed } from '../../useCrossSessionInteractionFeed';

type SessionMeta = {
  id: string;
  vpsId: string;
  cwd: string;
  name: string | null;
  status: WorkerStatus;
  permissionMode: PermissionMode;
};

// ──────────────────────────────────────────────────────────────────────────
// MobileChat
// ──────────────────────────────────────────────────────────────────────────
type Props = {
  sessionId: string;
  vpsList: Vps[];
  vpsPaths: VpsPath[];
};

const STATUS_LABEL: Record<WorkerStatus, string> = {
  starting: 'démarrage',
  active: 'actif',
  thinking: 'réfléchit',
  sleeping: 'endormi',
  killed: 'tué',
  error: 'erreur',
  reconnecting: 'reconnexion…',
};
const STATUS_DOT: Record<WorkerStatus, string> = {
  starting: 'amber',
  active: 'green',
  thinking: 'amber-pulse',
  sleeping: 'gray',
  killed: 'gray',
  error: 'red',
  reconnecting: 'amber-pulse',
};

export default function MobileChat({ sessionId, vpsList }: Props) {
  const router = useRouter();
  // Cache stable (cf. ../chatCache.ts) — passé au hook via le contrat StreamCache.
  // L'invalidation après-kill nettoie l'entrée pour ne pas afficher une session
  // "killed" comme encore active en cas de retour-arrière dans /m/select.
  const cacheRef = useRef<StreamCache>({
    get: (id) => getCached(id),
    fetch: (id, force) => fetchAndCache(id, force),
    invalidate: (id) => invalidateCache(id),
  });

  // ── Stream session (SSE + state + actions) — hook partagé desktop/mobile ──
  const stream = useClaudeSessionStream(sessionId, {
    cache: cacheRef.current,
    onKilled: () => {
      cacheRef.current.invalidate?.(sessionId);
      router.push('/m/select');
    },
  });
  const {
    sessionMeta, messages, currentAssistant, status, permissionMode,
    toolCalls, todos, edits, files,
    permQueue, questionQueue, exitPlanQueue,
    prefillInput, error,
    clearPrefillInput, clearError,
  } = stream;

  // Cross-session interactions feed : compte les perms/questions/exit-plans
  // qui attendent sur des sessions AUTRES que celle-ci. Affiché en bandeau
  // en haut de la vue chat, click → /m/select pour aller les traiter.
  const cross = useCrossSessionInteractionFeed();
  const otherSessionsPending = useMemo(() => {
    const filter = <T extends { sessionId: string }>(arr: T[]) => arr.filter((x) => x.sessionId !== sessionId);
    return filter(cross.perms).length + filter(cross.questions).length + filter(cross.exitPlans).length;
  }, [cross, sessionId]);

  // State purement UI mobile (textarea + menus + scroll).
  const [input, setInput] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const chatBodyRef = useRef<HTMLDivElement | null>(null);

  // Drain de prefill_input : le hook expose un texte que l'agent veut nous
  // faire taper (event SSE prefill_input). On le copie dans la textarea
  // puis on clear pour ne pas re-jouer si la session se ré-ouvre.
  useEffect(() => {
    if (prefillInput !== null) {
      setInput(prefillInput);
      clearPrefillInput();
    }
  }, [prefillInput, clearPrefillInput]);

  // ── Scroll : flex-direction: column-reverse ─────────────────────────────
  // Le chat body est rendu en column-reverse, donc :
  //   - DOM[0] = bas visuel (message le plus récent)
  //   - scrollTop = 0 = vraiment en bas (peu importe le scrollHeight)
  //   - Quand on ajoute un message (à DOM[0]) le browser garde scrollTop=0 →
  //     on suit auto le nouveau message.
  //   - Quand on prepend des anciens en haut (append à la fin du DOM), le
  //     browser fait du scroll anchoring → on reste à la même position.
  //   - Markdown / images qui changent scrollHeight ? scrollTop=0 reste 0,
  //     on est toujours en bas, pas de drift.
  // → 0 useLayoutEffect, le browser fait tout le boulot.
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const lastMessageCountRef = useRef(0);

  // Progressive batching supprimé : on render tous les messages d'un coup.
  // Combiné au cache + column-reverse, ça donne un affichage instant SANS
  // effet "défilage" perçu (plus de batches qui arrivent un par un).

  const handleScroll = useCallback(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    // En column-reverse, scrollTop ≈ 0 signifie "au bas visuel".
    // L'utilisateur "scroll up" pour voir les anciens → scrollTop devient
    // négatif sur certains browsers (Safari) ou positif (Chrome/Firefox).
    // On considère "au bas" = |scrollTop| < threshold.
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

  // Auto-resize de la textarea : on suit le scrollHeight avec un max ~30vh.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = window.innerHeight * 0.3;
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  }, [input]);

  const vps = useMemo(() => vpsList.find((v) => v.id === sessionMeta?.vpsId) ?? null, [vpsList, sessionMeta]);

  // [SSE + state + refetch sont gérés par useClaudeSessionStream (hook
  // partagé desktop/mobile, cf. ../../useClaudeSessionStream.ts). Avant
  // l'extraction, ce fichier contenait ~250 lignes pour applyApiData /
  // refetchHistory / useEffect SSE / useEffect visibilitychange — tout est
  // maintenant dans le hook.]

  // Compte les nouveaux messages QUAND l'utilisateur n'est PAS en bas, pour
  // afficher la pill "↓ N". (Si en bas, on suit déjà auto via column-reverse.)
  useEffect(() => {
    const prev = lastMessageCountRef.current;
    const cur = messages.length;
    if (cur > prev && !isAtBottomRef.current) {
      setNewCount((c) => c + (cur - prev));
    }
    lastMessageCountRef.current = cur;
  }, [messages.length]);

  // Pair tool_use ↔ tool_result pour le rendu inline.
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
    const consumed = new Set<string>();
    for (const m of messages) {
      if (m.role === 'tool_result') {
        try {
          const parsed = JSON.parse(m.content);
          if (parsed?.tool_use_id && resultByToolUseId.has(String(parsed.tool_use_id))) {
            if (consumed.has(m.id)) continue;
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
            if (attached) consumed.add(attached.id);
          }
        } catch {}
        out.push({ msg: m, attached });
        continue;
      }
      out.push({ msg: m });
    }
    return out;
  }, [messages]);

  // ── Pending interaction la plus ancienne ────────────────────────────
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

  const stepCount = useMemo(() => {
    let count = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') break;
      if (messages[i].role === 'tool_use') count++;
    }
    return count;
  }, [messages]);

  // ── Actions UI mobile (wrappers minces autour des actions du hook) ──────
  // Les wrappers gèrent uniquement le state UI mobile (fermer le menu après
  // l'action, vider la textarea après send). La logique métier vit dans
  // useClaudeSessionStream.
  async function send() {
    const content = input.trim();
    if (!content) return;
    setInput('');
    await stream.send(content);
  }
  async function interrupt() {
    setShowMenu(false);
    await stream.interrupt();
  }
  async function forceStop() {
    setShowMenu(false);
    await stream.forceStop();
  }
  async function doSleep() {
    setShowMenu(false);
    await stream.doSleep();
  }
  async function doResume() {
    setShowMenu(false);
    await stream.doResume();
  }
  async function doKill() {
    if (!confirm('Tuer cette session ? Les messages restent en historique.')) return;
    setShowMenu(false);
    await stream.doKill();
    // navigation vers /m/select gérée par le callback onKilled du hook
  }
  // setMode est utilisé directement comme `stream.setMode` dans le JSX.

  // ── Render ────────────────────────────────────────────────────────────
  const title = sessionMeta?.name || (sessionMeta?.cwd ? sessionMeta.cwd.split('/').slice(-2).join('/') : 'session');
  const subtitle = vps && sessionMeta ? `${vps.name}:${sessionMeta.cwd}` : '';

  return (
    <>
      <header className="m-topbar">
        <button className="m-back" onClick={() => router.push('/m/select')} aria-label="retour">←</button>
        <div className="m-title-block">
          <span className="m-title">{title}</span>
          {subtitle && <span className="m-subtitle">{subtitle}</span>}
        </div>
        <div className="m-actions">
          <button
            className="m-act-btn"
            onClick={() => setDrawerOpen(true)}
            aria-label="outils"
            title="diffs / todos / tools"
            disabled={edits.size === 0 && todos.length === 0 && toolCalls.length === 0}
          >▤</button>
          <button
            className="m-act-btn"
            onClick={() => setShowMenu((v) => !v)}
            aria-label="menu"
          >⋮</button>
        </div>
        {showMenu && (
          <MenuPopover
            status={status}
            onClose={() => setShowMenu(false)}
            onSleep={doSleep}
            onResume={doResume}
            onKill={doKill}
            onInterrupt={interrupt}
            onForceStop={forceStop}
          />
        )}
      </header>

      {otherSessionsPending > 0 && (
        <button
          type="button"
          className="m-cross-banner"
          onClick={() => router.push('/m/select')}
          aria-label="aller aux autres sessions"
        >
          ↑ {otherSessionsPending} {otherSessionsPending === 1 ? 'interaction' : 'interactions'} en attente sur d'autres sessions
        </button>
      )}

      <div className="m-chat-statusbar">
        {status === 'thinking' ? (
          <span className="m-status-pill status-amber-pulse">
            <span className="dot" /> claude réfléchit
          </span>
        ) : oldestPending ? (
          <span className="m-status-pill status-orange-pulse">
            <span className="dot" /> attend votre réponse
          </span>
        ) : status ? (
          <span className={`m-status-pill status-${STATUS_DOT[status]}`}>
            <span className="dot" /> {STATUS_LABEL[status]}
          </span>
        ) : null}
        {sessionMeta?.cwd && (
          <span className="m-status-cwd">{sessionMeta.cwd}</span>
        )}
      </div>

      {(status === 'sleeping' || status === 'error') && (
        <div className="m-banner disconnect" onClick={doResume} role="button">
          ↺ session inactive — tap pour reconnecter
          {error?.msg && (<><br/><em style={{ fontStyle: 'italic', fontSize: 10, opacity: 0.7 }}>{error.msg.split('\n')[0].slice(0, 80)}</em></>)}
        </div>
      )}
      {status === 'reconnecting' && (
        <div className="m-banner reconnect">↻ reconnexion auto en cours…</div>
      )}
      {error && status !== 'sleeping' && status !== 'error' && (
        <div className="m-banner error">
          <pre>{error.msg}</pre>
          <button onClick={() => clearError()}>✕</button>
        </div>
      )}

      <div className="m-chat-wrap">
        {/* En column-reverse : DOM[0] = bas visuel.
            On met donc le streaming en 1er, puis les messages en ordre inverse
            (newest first dans le DOM = en bas, oldest last = en haut). */}
        <div className="m-chat-body" ref={chatBodyRef} onScroll={handleScroll}>
          {currentAssistant && (
            <div className="m-bubble assistant streaming">
              <div className="m-bubble-h"><span>assistant</span></div>
              <div className="m-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}>
                  {currentAssistant}
                </ReactMarkdown>
              </div>
            </div>
          )}
          {[...renderable].reverse().map(({ msg, attached }) => (
            <MobileMessage key={msg.id} m={msg} attached={attached} />
          ))}
        </div>
        {!isAtBottom && (
          <button
            type="button"
            className={`m-scroll-pill${newCount > 0 ? ' has-new' : ''}`}
            onClick={onPillClick}
            aria-label={newCount > 0 ? `${newCount} nouveau message — aller en bas` : 'aller en bas'}
          >
            <span className="m-scroll-arrow">▾</span>
            {newCount > 0 && <span className="m-scroll-count">{newCount}</span>}
          </button>
        )}
      </div>

      {status === 'thinking' && (
        <ThinkingBar currentTool={currentTool} stepCount={stepCount} startedAt={turnStartedAt} />
      )}

      {/* Bottom zone : 4 cas
          1. session sleeping/error → resume CTA
          2. session killed → message
          3. interaction pending → carte
          4. normal → mode switch + input bar */}
      {status === 'sleeping' || status === 'error' ? (
        <div className="m-resume-cta">
          <button onClick={doResume}>↺ RESUME CETTE SESSION</button>
        </div>
      ) : status === 'killed' ? (
        <div className="m-killed-banner">
          session tuée — historique consultable, pas reprenable
        </div>
      ) : oldestPending ? (
        <div className="m-pending-zone">
          {oldestPending.kind === 'permission' && (
            <PermCard
              perm={oldestPending.perm}
              onRespond={(allow, always) => stream.respondPermission(oldestPending.perm.id, allow, always)}
            />
          )}
          {oldestPending.kind === 'question' && (
            <QuestionCard
              q={oldestPending.q}
              onAnswer={(answers) => stream.respondQuestion(oldestPending.q.id, answers)}
              onCancel={() => stream.respondQuestion(oldestPending.q.id, null)}
            />
          )}
          {oldestPending.kind === 'exit_plan' && (
            <ExitPlanCard
              plan={oldestPending.ep.plan || fallbackPlanFromMessages}
              onApprove={() => stream.respondExitPlan(oldestPending.ep.id, 'approve')}
              onReject={(feedback) => stream.respondExitPlan(oldestPending.ep.id, 'reject', feedback)}
            />
          )}
        </div>
      ) : (
        <>
          <div className="m-mode-switch" role="radiogroup" aria-label="mode permissions">
            <button
              type="button"
              className={`m-mode-btn normal${permissionMode === 'normal' ? ' on' : ''}`}
              onClick={() => stream.setMode('normal')}
            >▷ normal</button>
            <button
              type="button"
              className={`m-mode-btn acceptEdits${permissionMode === 'acceptEdits' ? ' on' : ''}`}
              onClick={() => stream.setMode('acceptEdits')}
            >▶▶ edits</button>
            <button
              type="button"
              className={`m-mode-btn auto${permissionMode === 'auto' ? ' on' : ''}`}
              onClick={() => stream.setMode('auto')}
            >▶▶ accept all</button>
            <button
              type="button"
              className={`m-mode-btn plan${permissionMode === 'plan' ? ' on' : ''}`}
              onClick={() => stream.setMode('plan')}
            >⏸ plan</button>
          </div>
          <footer className="m-input-bar">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="message à Claude…"
              rows={2}
              onKeyDown={(e) => {
                // Pas de submit sur Enter mobile — toujours saut de ligne natif.
                // Ctrl/Cmd+Enter envoie pour le clavier hardware connecté.
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="m-send" onClick={send} disabled={!input.trim()} aria-label="envoyer">
              ▶
            </button>
          </footer>
        </>
      )}

      {drawerOpen && (
        <Drawer
          onClose={() => setDrawerOpen(false)}
          toolCalls={toolCalls}
          todos={todos}
          edits={edits}
          files={files}
          onRevert={async (filePath, content) => {
            try {
              await api.revertClaudeEdit(sessionId, filePath, content);
            } catch (e: any) {
              alert('revert: ' + (e?.message ?? e));
            }
          }}
        />
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Menu popover (sleep/resume/kill/interrupt)
// ──────────────────────────────────────────────────────────────────────────
function MenuPopover({
  status, onClose, onSleep, onResume, onKill, onInterrupt, onForceStop,
}: {
  status: WorkerStatus | null;
  onClose: () => void;
  onSleep: () => void;
  onResume: () => void;
  onKill: () => void;
  onInterrupt: () => void;
  onForceStop: () => void;
}) {
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 50 }}
        onClick={onClose}
      />
      <div
        style={{
          position: 'absolute', top: 56, right: 8,
          background: 'var(--stone-2)',
          border: '1px solid var(--gold-deep)',
          padding: 6, display: 'flex', flexDirection: 'column', gap: 4,
          zIndex: 51, minWidth: 180,
          boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
        }}
      >
        {status === 'thinking' && (
          <MenuItem onClick={onInterrupt} label="⏸ interrompre" />
        )}
        {['thinking', 'active', 'starting'].includes(status ?? '') && (
          <MenuItem onClick={onForceStop} label="⏹ force stop" danger />
        )}
        {(status === 'sleeping' || status === 'error') ? (
          <MenuItem onClick={onResume} label="↺ resume" />
        ) : status !== 'killed' && (
          <MenuItem onClick={onSleep} label="💤 sleep" />
        )}
        {status !== 'killed' && (
          <MenuItem onClick={onKill} label="✗ kill session" danger />
        )}
      </div>
    </>
  );
}

function MenuItem({ onClick, label, danger }: { onClick: () => void; label: string; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: '10px 12px',
        background: 'transparent',
        border: '1px solid var(--gold-deep)',
        color: danger ? 'var(--crimson)' : 'var(--parchment)',
        fontFamily: 'var(--mono)',
        fontSize: 13,
      }}
    >{label}</button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Messages
// ──────────────────────────────────────────────────────────────────────────
function MobileMessage({ m, attached }: { m: Msg; attached?: Msg }) {
  if (m.role === 'tool_use') return <ToolUseBubble m={m} attached={attached} />;
  if (m.role === 'tool_result') return <ToolResultBubble m={m} />;
  if (m.role === 'event' || m.role === 'edit_snapshot') return null;
  if (m.role === 'user_question' || m.role === 'exit_plan_request') return null;
  if (m.role === 'thinking') return <ThinkingBubble m={m} />;

  const isAssistant = m.role === 'assistant';
  const isUser = m.role === 'user';
  return (
    <div className={`m-bubble ${isUser ? 'user' : isAssistant ? 'assistant' : 'system'}`}>
      <div className="m-bubble-h">
        <span>{m.role}</span>
        {m.createdAt > 0 && <span style={{ marginLeft: 'auto' }}>{fmtTime(m.createdAt)}</span>}
      </div>
      {isAssistant ? (
        <div className="m-md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
            components={{ a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
          >
            {m.content}
          </ReactMarkdown>
        </div>
      ) : (
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.5 }}>{m.content}</div>
      )}
    </div>
  );
}

function ThinkingBubble({ m }: { m: Msg }) {
  const [open, setOpen] = useState(false);
  const first = m.content.split('\n')[0].slice(0, 110);
  const hasMore = m.content.length > first.length;
  return (
    <div className="m-bubble thinking">
      <div className="m-bubble-h" onClick={() => setOpen((v) => !v)} style={{ cursor: hasMore ? 'pointer' : 'default' }}>
        {hasMore && <span>{open ? '▾' : '▸'}</span>}
        <span>thinking</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--parchment-soft)', whiteSpace: open ? 'pre-wrap' : 'normal' }}>
        {open ? m.content : first + (hasMore ? '…' : '')}
      </div>
    </div>
  );
}

function ToolUseBubble({ m, attached }: { m: Msg; attached?: Msg }) {
  const [expanded, setExpanded] = useState(false);
  const [showInput, setShowInput] = useState(false);
  let parsed: any = null;
  try { parsed = JSON.parse(m.content); } catch {}
  const name = parsed?.name ?? '?';
  const input = parsed?.input ?? {};
  const summary = summarizeToolInput(name, input);

  let resultObj: { content: string; isError: boolean } | null = null;
  if (attached) {
    try {
      const rp = JSON.parse(attached.content);
      resultObj = { content: String(rp.content ?? ''), isError: !!rp.is_error };
    } catch {
      resultObj = { content: attached.content, isError: false };
    }
  }

  return (
    <div className={`m-bubble tool-use${resultObj ? ' has-result' : ''}${resultObj?.isError ? ' err' : ''}${expanded ? ' expanded' : ''}`}>
      <div className="m-tu-head" onClick={() => setShowInput((v) => !v)}>
        <span style={{ color: 'var(--lavender)' }}>⚒</span>
        <span className="m-tu-name">{name}</span>
        <span className="m-tu-summary">{summary}</span>
        {!resultObj && <span className="m-tu-status">…</span>}
        {resultObj && <span className="m-tu-status ok">{resultObj.isError ? '✗' : '✓'}</span>}
      </div>
      {showInput && (
        <pre className="m-tu-input">{JSON.stringify(input, null, 2)}</pre>
      )}
      {resultObj && (
        <>
          <div className="m-tu-result" onClick={() => setExpanded((v) => !v)}>
            {resultObj.content || '(vide)'}
          </div>
          {resultObj.content.length > 100 && (
            <span className="m-tu-toggle" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '▾ moins' : '▸ tout afficher'}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function ToolResultBubble({ m }: { m: Msg }) {
  let content = m.content;
  try {
    const parsed = JSON.parse(m.content);
    if (typeof parsed === 'object' && parsed?.content != null) content = String(parsed.content);
  } catch {}
  return (
    <div className="m-bubble tool-use">
      <div className="m-tu-head">
        <span className="m-tu-name">tool_result</span>
      </div>
      <div className="m-tu-result expanded" style={{ display: 'block', whiteSpace: 'pre-wrap' }}>
        {content.slice(0, 4000)}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Thinking bar
// ──────────────────────────────────────────────────────────────────────────
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
    <div className="m-thinking-bar">
      <span className="m-tb-dot" />
      <span style={{ color: 'var(--gold-bright)' }}>réfléchit</span>
      {currentTool && (
        <span className="m-tb-tool">
          · {currentTool.name} {summarizeToolInput(currentTool.name, currentTool.input)}
        </span>
      )}
      <span className="m-tb-elapsed">
        {stepCount > 0 && `· étape ${stepCount}`}
        {elapsed != null && ` · ${fmtElapsed(elapsed)}`}
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Permission / Question / ExitPlan cards (mobile-optimized)
// ──────────────────────────────────────────────────────────────────────────
function PermCard({ perm, onRespond }: { perm: PermissionRequest; onRespond: (allow: boolean, always: boolean) => void }) {
  const summary = summarizeToolInput(perm.tool, perm.input);
  return (
    <div className="m-perm-card">
      <h3>🔒 permission demandée</h3>
      <div className="m-pc-tool">{perm.tool}</div>
      {summary && <div className="m-pc-summary">{summary}</div>}
      <pre>{JSON.stringify(perm.input, null, 2).slice(0, 1200)}</pre>
      <div className="m-pc-actions">
        <button type="button" className="allow" onClick={() => onRespond(true, false)}>autoriser une fois</button>
        <button type="button" className="always" onClick={() => onRespond(true, true)}>toujours (session)</button>
        <button type="button" className="deny" onClick={() => onRespond(false, false)}>refuser</button>
      </div>
    </div>
  );
}

function QuestionCard({ q, onAnswer, onCancel }: {
  q: PendingQuestion;
  onAnswer: (answers: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [selections, setSelections] = useState<Record<number, Set<string>>>(() => {
    const init: Record<number, Set<string>> = {};
    q.questions.forEach((_, i) => { init[i] = new Set(); });
    return init;
  });
  const [customs, setCustoms] = useState<Record<number, string>>({});

  function toggle(qIdx: number, label: string, multi: boolean) {
    setSelections((prev) => {
      const next = { ...prev };
      const cur = new Set(prev[qIdx] ?? new Set<string>());
      if (multi) {
        if (cur.has(label)) cur.delete(label); else cur.add(label);
      } else {
        cur.clear();
        cur.add(label);
      }
      next[qIdx] = cur;
      return next;
    });
  }

  function answerForQuestion(qIdx: number): string | null {
    const custom = (customs[qIdx] ?? '').trim();
    if (custom) return custom;
    const sel = selections[qIdx];
    if (!sel || sel.size === 0) return null;
    return Array.from(sel).join(', ');
  }

  const allAnswered = q.questions.every((_, i) => !!answerForQuestion(i));

  function submit() {
    const answers: Record<string, string> = {};
    q.questions.forEach((qq, i) => {
      const a = answerForQuestion(i);
      if (a) answers[qq.question] = a;
    });
    onAnswer(answers);
  }

  return (
    <div className="m-question-card">
      <h3>❓ question{q.questions.length > 1 ? `s × ${q.questions.length}` : ''}</h3>
      {q.questions.map((qq, qIdx) => {
        const multi = !!qq.multiSelect;
        const sel = selections[qIdx] ?? new Set<string>();
        const customVal = customs[qIdx] ?? '';
        return (
          <div key={qIdx} className="m-q-block">
            {qq.header && <div className="m-q-header">{qq.header}</div>}
            <div className="m-q-text">{qq.question}</div>
            {multi && <div className="m-q-multi-hint">choix multiple ☑</div>}
            {qq.options.map((opt) => {
              const on = sel.has(opt.label);
              return (
                <button
                  type="button"
                  key={opt.label}
                  className={`m-q-option${on ? ' selected' : ''}`}
                  onClick={() => toggle(qIdx, opt.label, multi)}
                >
                  <span className="m-q-radio">{multi ? (on ? '☑' : '☐') : (on ? '◉' : '◯')}</span>
                  <span>{opt.label}</span>
                  {opt.description && <span className="m-q-desc">{opt.description}</span>}
                </button>
              );
            })}
            <textarea
              placeholder="ou réponse libre…"
              value={customVal}
              onChange={(e) => setCustoms((c) => ({ ...c, [qIdx]: e.target.value }))}
              rows={2}
              style={{ marginTop: 6 }}
            />
          </div>
        );
      })}
      <div className="m-pc-actions">
        <button type="button" className="approve" onClick={submit} disabled={!allAnswered}>envoyer</button>
        <button type="button" className="deny" onClick={onCancel}>annuler</button>
      </div>
    </div>
  );
}

function ExitPlanCard({ plan, onApprove, onReject }: {
  plan: string;
  onApprove: () => void;
  onReject: (feedback: string) => void;
}) {
  const [askingFeedback, setAskingFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  return (
    <div className="m-exitplan-card">
      <h3>📋 plan prêt</h3>
      <div style={{ marginTop: 8 }} className="m-md">
        {plan ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
        ) : (
          <em style={{ color: 'var(--parchment-soft)' }}>Le plan a été écrit dans un fichier (voir messages au-dessus).</em>
        )}
      </div>
      {!askingFeedback ? (
        <div className="m-pc-actions">
          <button type="button" className="approve" onClick={onApprove}>approuver et exécuter</button>
          <button type="button" className="reject" onClick={() => setAskingFeedback(true)}>demander des changements</button>
        </div>
      ) : (
        <>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="que veux-tu modifier ?"
            rows={4}
            autoFocus
          />
          <div className="m-pc-actions">
            <button
              type="button"
              className="approve"
              onClick={() => onReject(feedback.trim() || 'Please revise the plan.')}
              disabled={!feedback.trim()}
            >envoyer le feedback</button>
            <button type="button" className="deny" onClick={() => { setAskingFeedback(false); setFeedback(''); }}>annuler</button>
          </div>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Drawer (ToolPanel mobile)
// ──────────────────────────────────────────────────────────────────────────
type DrawerTab = 'diffs' | 'todos' | 'calls' | 'files';
function Drawer({
  onClose, toolCalls, todos, edits, files, onRevert,
}: {
  onClose: () => void;
  toolCalls: ToolCallEntry[];
  todos: Todo[];
  edits: Map<string, EditSnapshot>;
  files: Set<string>;
  onRevert: (filePath: string, content: string | null) => Promise<void>;
}) {
  const [tab, setTab] = useState<DrawerTab>(edits.size > 0 ? 'diffs' : todos.length > 0 ? 'todos' : 'calls');
  const editArr = useMemo(() => Array.from(edits.values()), [edits]);

  return (
    <>
      <div className="m-drawer-bg" onClick={onClose} />
      <div className="m-drawer" role="dialog" aria-modal="true">
        <div className="m-drawer-handle" onClick={onClose} />
        <button className="m-drawer-close" onClick={onClose} aria-label="fermer">✕</button>
        <nav className="m-drawer-tabs">
          <button className={tab === 'diffs' ? 'on' : ''} onClick={() => setTab('diffs')}>
            diffs {editArr.length > 0 && <span className="m-badge">{editArr.length}</span>}
          </button>
          <button className={tab === 'todos' ? 'on' : ''} onClick={() => setTab('todos')}>
            todos {todos.length > 0 && <span className="m-badge">{todos.filter((t) => t.status !== 'completed').length}/{todos.length}</span>}
          </button>
          <button className={tab === 'calls' ? 'on' : ''} onClick={() => setTab('calls')}>
            tools {toolCalls.length > 0 && <span className="m-badge">{toolCalls.length}</span>}
          </button>
          <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
            files {files.size > 0 && <span className="m-badge">{files.size}</span>}
          </button>
        </nav>
        <div className="m-drawer-body">
          {tab === 'diffs' && <DiffsTab edits={editArr} onRevert={onRevert} />}
          {tab === 'todos' && <TodosTab todos={todos} />}
          {tab === 'calls' && <CallsTab calls={toolCalls} />}
          {tab === 'files' && <FilesTab files={files} />}
        </div>
      </div>
    </>
  );
}

function DiffsTab({ edits, onRevert }: { edits: EditSnapshot[]; onRevert: (filePath: string, content: string | null) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (edits.length === 0) return <div className="m-tp-empty">aucun fichier modifié</div>;
  async function revert(filePath: string, before: string | null) {
    if (!confirm(`Restaurer "${filePath}" à son état initial ?`)) return;
    setBusy(filePath);
    try { await onRevert(filePath, before); } finally { setBusy(null); }
  }
  return (
    <>
      {edits.map((e) => {
        const patch = createPatch(e.filePath, e.before ?? '', e.after ?? '', '', '', { context: 3 });
        let add = 0, del = 0;
        for (const l of patch.split('\n')) {
          if (l.startsWith('+') && !l.startsWith('+++')) add++;
          else if (l.startsWith('-') && !l.startsWith('---')) del++;
        }
        const lines = patch.split('\n').slice(4);
        return (
          <div key={e.toolUseId + e.filePath} className="m-tp-diff-card">
            <div className="m-diff-path">{e.filePath}</div>
            <div className="m-diff-stats">
              <span className="add">+{add}</span>
              <span className="del">−{del}</span>
              <button
                style={{ float: 'right', background: 'transparent', border: '1px solid var(--crimson-deep)', color: 'var(--crimson)', padding: '2px 8px', fontSize: 11 }}
                onClick={() => revert(e.filePath, e.before)}
                disabled={busy === e.filePath}
              >{busy === e.filePath ? '…' : 'revert'}</button>
            </div>
            {e.truncated && <div style={{ fontSize: 11, color: '#f0a060', marginTop: 4 }}>⚠ snapshot tronqué</div>}
            <pre>{lines.map((l, i) => {
              let cls = 'ctx';
              if (l.startsWith('+')) cls = 'add';
              else if (l.startsWith('-')) cls = 'del';
              else if (l.startsWith('@@')) cls = 'hunk';
              return <span key={i} className={`dline ${cls}`}>{l + '\n'}</span>;
            })}</pre>
          </div>
        );
      })}
    </>
  );
}

function TodosTab({ todos }: { todos: Todo[] }) {
  if (todos.length === 0) return <div className="m-tp-empty">aucune todo</div>;
  return (
    <ul className="m-tp-todo-list">
      {todos.map((t, i) => (
        <li key={i} className={`todo-${t.status}`}>
          <span className="m-chk">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'}</span>
          <span>{t.content}</span>
        </li>
      ))}
    </ul>
  );
}

function CallsTab({ calls }: { calls: ToolCallEntry[] }) {
  if (calls.length === 0) return <div className="m-tp-empty">aucun tool call</div>;
  return (
    <ul className="m-tp-calls-list">
      {calls.slice().reverse().map((c) => (
        <li key={c.id} className={c.result?.isError ? 'err' : ''}>
          <div>
            <span className="name">{c.name}</span>
            <span style={{ float: 'right', color: 'var(--parchment-soft)' }}>{fmtTime(c.startedAt)}</span>
          </div>
          <div className="input">{summarizeToolInput(c.name, c.input)}</div>
          {c.result && (
            <div style={{ fontSize: 10, color: c.result.isError ? 'var(--crimson)' : 'var(--parchment-soft)', marginTop: 2 }}>
              {c.result.isError ? '✗' : '✓'} {c.result.content.slice(0, 80)}{c.result.content.length > 80 ? '…' : ''}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function FilesTab({ files }: { files: Set<string> }) {
  if (files.size === 0) return <div className="m-tp-empty">aucun fichier touché</div>;
  const sorted = Array.from(files).sort();
  return (
    <ul className="m-tp-files-list">
      {sorted.map((f) => <li key={f}>{f}</li>)}
    </ul>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
function summarizeToolInput(name: string, input: any): string {
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
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtElapsed(s: number): string {
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toString().padStart(2, '0')}s`;
}

// rebuildStateFromMessages : extrait dans `app/sessionRebuild.ts` (partagé
// avec ClaudePanel desktop). Import en haut du fichier.
