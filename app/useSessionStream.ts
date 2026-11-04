'use client';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { sessionApi } from '@/lib/api';
import type { SessionTokenUsage } from '@/lib/sessionTokenUsage';
import type {
  Msg, ToolCallEntry, EditSnapshot,
  PermissionRequest, PendingQuestion, PendingExitPlan,
} from './sessionTypes';
import { ResponseSpeedTracker, type ResponseSpeedSnapshot } from './responseSpeed';
import { bgTasksToArray, type BgTask } from './bgTasks';
import { publishFsChanged } from './fsChangeBus';
import type { WorkerStatus } from '@/lib/server/hub/types';
import type {
  AgentSessionDetailResponse, AgentSessionMessageWindow,
} from '@/lib/types/api';
import { PROVIDERS, type SessionMode, type SessionProvider } from '@/lib/sessionCapabilities';
import type { TranscriptView } from '@/lib/transcriptRows';
import { cmpRev, type SyncRev } from '@/lib/sync/rev';
import {
  subscribeSession, setFocus, subscribeResync, subscribeSyncReady, getSyncPosition, getSessionFrameRev,
  getFocusTicket, isStreamLive, requestReconnect, noteHttpSync, type EventReception,
} from './globalEventStream';
import {
  applyFrame, applyLocalResolution, applyLocalSend, applyLocalSendAck, applyLocalSendFailed, toolCallTotal, applyOlderPage, applySnapshot,
  createTranscriptState, isCoveredBySnapshot, newClientMessageId, pendingGateIds,
  type Effect, type SessionFrame, type TranscriptState,
} from './sync/transcriptReducer';
import { TranscriptJournal } from './sync/transcriptJournal';
import { createWindowSync, type WindowReason, type WindowSync } from './sync/windowSync';
import { decideRepair } from './sync/repairPolicy';
import { OverlayBox, type OverlayHandle } from './sync/optimistic';
import { readShowToolsPreference, transcriptViewFor } from './chatVisibility';
import type { FetchSessionOptions } from './sessionCache';

// Session-expired (401) handling (CLAUDE.md §14.45, P8). After a long outage
// the 24h sliding session cookie may have lapsed; every API call then 401s
// silently. We hard-reload ONCE → middleware redirects cleanly to
// /login?next=… . Module-level guard so concurrent 401s don't storm.
let _authReloadDone = false;
function reloadForExpiredSession(): void {
  if (_authReloadDone) return;
  if (typeof window === 'undefined') return;
  _authReloadDone = true;
  try { window.location.reload(); } catch {}
}

const errorText = (e: unknown): string => String((e as Error)?.message ?? e);

/** The `sync` stamp of an action route's answer (absent from older hubs). */
function syncOf(res: unknown): SyncRev | null {
  const s = (res as { sync?: unknown } | null | undefined)?.sync as { epoch?: unknown; rev?: unknown } | undefined;
  return s && typeof s.epoch === 'number' && typeof s.rev === 'number' ? { epoch: s.epoch, rev: s.rev } : null;
}

/** The frame's reception: bytes, arrival time, bus revision (null on a legacy
 *  stream) and whether it is ring catch-up (excluded from kB/s). */
type Reception = EventReception;

/** Probe cadence while the tab is visible (CLAUDE.md §14.24). */
const PROBE_INTERVAL_MS = 15_000;
/** While a probe waits for the stream to reach its revision. */
const PROBE_WAIT_RECHECK_MS = 500;
/** Assistant text / delta reasoning: at most one React commit per 80 ms (§14.17). */
const DELTA_COMMIT_MS = 80;

// useSessionStream — a thin adapter over the pure transcript sync
// (CLAUDE.md §14.107, app/sync/): a state ref + `applyFrame`/`applySnapshot`
// (transcriptReducer.ts) + ONE window GET at a time (windowSync.ts) + a
// journal of the frames received meanwhile (transcriptJournal.ts) + an
// effect runner that skips every effect of a re-dispatched (journal) frame.
// A rev-gated probe (repairPolicy.ts) replaces the escalating poll; actions
// show overlays (optimistic.ts) until the stream delivered their revision.
// One instance per session view (`key={selectedId}` in HubPanel).

export type StreamCache = {
  get(id: string, view: TranscriptView): AgentSessionDetailResponse | undefined;
  /** The window GET (`opts.focus`: applied atomically, never joined). */
  fetch(id: string, opts: FetchSessionOptions): Promise<AgentSessionDetailResponse>;
  invalidate?(id: string): void;
  /** Keep loaded older pages across remounts. */
  extendWithOlder?(id: string, older: AgentSessionMessageWindow, view: TranscriptView): void;
};

export type UseSessionStreamOptions = {
  /** Module-level cache (`sessionCache.ts`): paints before the first window answer. */
  cache?: StreamCache;
  /** The session was deleted (the caller navigates away). */
  onKilled?: () => void;
  /** Transcript view. `null`: not resolved yet — nothing is fetched, the cache
   *  does not paint. `undefined`: the hook reads the stored preference itself
   *  (`readShowToolsPreference`) in its mount effect. */
  view?: TranscriptView | null;
  /** The session's backend, when the caller knows it (its first frames are
   *  read right before the first snapshot names it). */
  provider?: SessionProvider;
};

export type SessionStreamState = {
  sessionMeta: AgentSessionDetailResponse['session'] | null;
  messages: Msg[];
  currentAssistant: string;
  // Row `m<id>` the live text extends (`assistant_reopened`, or the GET's
  // `streamingExtends`): `currentAssistant` is then only what follows that
  // row's content, drawn into it (transcriptReducer § liveStreamingMessage).
  streamingInto: number | null;
  status: WorkerStatus | null;
  // Claude permission mode OR Codex sandbox level (same DB field, kind-dependent).
  permissionMode: SessionMode;
  model: string | null;
  fallbackModel: string | null;
  effort: string | null;
  modelPendingApply: boolean;
  effortPendingApply: boolean;
  effectiveModel: string | null;
  tokenUsage: SessionTokenUsage | null;
  liveUsage: { output: number; input?: number; final?: boolean; durationMs?: number; costUsd?: number | null } | null;
  responseSpeed: ResponseSpeedSnapshot | null;
  toolCalls: ToolCallEntry[];
  /** `tool_use` rows of the whole session (window GET), null before it / older hubs. */
  toolCallCount: number | null;
  edits: Map<string, EditSnapshot>;
  files: Set<string>;
  bgTasks: BgTask[];
  permQueue: PermissionRequest[];
  questionQueue: PendingQuestion[];
  exitPlanQueue: PendingExitPlan[];
  prefillInput: string | null;
  error: { msg: string } | null;
  // true as long as no snapshot (cache or network) was applied.
  isLoadingHistory: boolean;
  // true while the screen is not confirmed current: from mount until the
  // first fresh window answer, and again after a wake-up until the probe
  // (or a window) confirms it.
  isSyncing: boolean;
  // Latches true once the first window request settled (side requests wait).
  historyReady: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** The transcript view in use (null until resolved). */
  view: TranscriptView | null;
  /** A window GET is in flight. */
  windowInFlight: boolean;
};

export type SessionStreamActions = {
  send(content: string): Promise<void>;
  interrupt(): Promise<void>;
  forceStop(): Promise<void>;
  setMode(mode: SessionMode): Promise<void>;
  setModel(model: string | null, fallbackModel?: string | null): Promise<void>;
  setEffort(effort: string | null): Promise<void>;
  doSleep(): Promise<void>;
  doResume(): Promise<void>;
  doRestart(): Promise<void>;
  /** Permanent deletion. The caller MUST have confirmed on the UI side. */
  doDelete(): Promise<void>;
  /** `always`: Codex's native session grant. `suggestion`: Claude — the index
   *  of the CLI's "don't ask again" option picked (lib/permissionSuggestions.ts). */
  respondPermission(permId: string, allow: boolean, always?: boolean, suggestion?: number): Promise<void>;
  respondQuestion(qid: string, answers: Record<string, string> | null): Promise<void>;
  respondExitPlan(qid: string, decision: 'approve' | 'reject', feedback?: string): Promise<void>;
  clearPrefillInput(): void;
  /** ONE clean window GET (tail mode: loaded older pages are kept). */
  refetchHistory(): Promise<void>;
  /** A clean window GET for a precise reason (e.g. `gate-payload`). */
  requestWindow(reason: WindowReason): void;
  loadMoreHistory(): Promise<void>;
  /** Kept for callers: window answers apply in `tail` mode, which keeps the
   *  pages a reader scrolled up into — nothing needs holding any more. */
  setHistoryHold(hold: boolean): void;
  clearError(): void;
};

export function useSessionStream(
  sessionId: string,
  options: UseSessionStreamOptions = {},
): SessionStreamState & SessionStreamActions {
  const { cache, onKilled, view: viewOption, provider } = options;
  const onKilledRef = useRef(onKilled);
  useEffect(() => { onKilledRef.current = onKilled; }, [onKilled]);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  // ── The transcript (pure state; the ref is the truth, React a projection) ─
  const stateRef = useRef<TranscriptState>(createTranscriptState(sessionId, provider));
  const [state, setState] = useState<TranscriptState>(stateRef.current);
  const publish = useCallback(() => setState(stateRef.current), []);

  // ── View: resolved before the first GET (null ⇒ nothing fetched) ─────────
  const [view, setView] = useState<TranscriptView | null>(viewOption === undefined ? null : viewOption);
  useEffect(() => {
    setView(viewOption === undefined ? transcriptViewFor(readShowToolsPreference()) : viewOption);
  }, [viewOption]);
  const viewRef = useRef<TranscriptView | null>(view);
  // The view the caller asks for RIGHT NOW (render-time): `view`/`viewRef`
  // follow it one and two effects later, and a scroll trigger fired by the
  // re-filtered list in between must not page the outgoing view.
  const requestedViewRef = useRef<TranscriptView | null>(view);
  requestedViewRef.current = viewOption === undefined ? view : viewOption;

  // ── Hook-level UI state ─────────────────────────────────────────────────
  const [prefillInput, setPrefillInput] = useState<string | null>(null);
  const [error, setError] = useState<{ msg: string; retrying?: boolean } | null>(null);
  const loadErrorShownRef = useRef(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isSyncing, setIsSyncing] = useState(true);
  const [historyReady, setHistoryReady] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [windowInFlight, setWindowInFlight] = useState(false);
  const loadMoreInflightRef = useRef(false);
  const freshAppliedRef = useRef(false);

  // ── Response speed (§14.50) ─────────────────────────────────────────────
  const responseSpeedRef = useRef(new ResponseSpeedTracker());
  const [responseSpeed, setResponseSpeed] = useState<ResponseSpeedSnapshot | null>(null);
  const resetResponseSpeed = useCallback(() => {
    responseSpeedRef.current.reset();
    setResponseSpeed(null);
  }, []);

  // ── Overlays (CLAUDE.md §14.32) ─────────────────────────────────────────
  const lastRev = useCallback((): SyncRev | null => {
    const p = getSyncPosition();
    return p.epoch != null && p.lastRev != null ? { epoch: p.epoch, rev: p.lastRev } : null;
  }, []);
  const overlaysRef = useRef<{
    status: OverlayBox<WorkerStatus>; mode: OverlayBox<SessionMode>;
    model: OverlayBox<{ model: string | null; fallbackModel: string | null }>; effort: OverlayBox<string | null>;
  } | null>(null);
  overlaysRef.current ??= {
    status: new OverlayBox({ lastRev }), mode: new OverlayBox({ lastRev }),
    model: new OverlayBox({ lastRev }), effort: new OverlayBox({ lastRev }),
  };
  const overlays = overlaysRef.current;
  const [, bumpOverlays] = useReducer((x: number) => x + 1, 0);
  const overlayWatchRef = useRef<number | null>(null);
  // An overlay ends when the stream reaches its revision, the cap, or the POST
  // fails: re-render at that moment (one cheap check per 250 ms while any is up).
  // Called right after every `overlays.X.set(...)`: render the optimistic
  // value NOW (nothing else re-renders before the POST settles), then watch
  // the overlays' identities (not their count: a set and an expiry in the
  // same tick keep it).
  const shownSignature = useCallback(() => [overlays.status, overlays.mode, overlays.model, overlays.effort]
    .map((b) => b.shownToken).join(','), [overlays]);
  const overlaySigRef = useRef('');
  const watchOverlays = useCallback(() => {
    if (typeof window === 'undefined') return;
    overlaySigRef.current = shownSignature();
    bumpOverlays();
    if (overlayWatchRef.current != null) return;
    overlayWatchRef.current = window.setInterval(() => {
      const sig = shownSignature();
      if (sig !== overlaySigRef.current) { overlaySigRef.current = sig; bumpOverlays(); }
      if (/^[0,]*$/.test(sig) && overlayWatchRef.current != null) {
        clearInterval(overlayWatchRef.current);
        overlayWatchRef.current = null;
      }
    }, 250);
  }, [shownSignature]);
  useEffect(() => () => {
    if (overlayWatchRef.current != null) clearInterval(overlayWatchRef.current);
  }, []);
  const settle = useCallback(<T,>(h: OverlayHandle, p: Promise<T>): Promise<T> => p.then(
    (res) => { h.ack(syncOf(res)); bumpOverlays(); return res; },
    (e) => { h.fail(); bumpOverlays(); throw e; },
  ), []);

  // ── Effect runner (a journal re-dispatch never runs effects) ─────────────
  const wsRef = useRef<WindowSync | null>(null);
  const runEffects = useCallback((effects: Effect[]) => {
    for (const e of effects) {
      switch (e.kind) {
        case 'killed': onKilledRef.current?.(); break;
        case 'banner': setError('retrying' in e ? { msg: e.msg, retrying: true } : { msg: e.msg }); break;
        case 'clearBanner': setError(null); break;
        case 'clearRetryBanner': setError((cur) => (cur?.retrying ? null : cur)); break;
        case 'prefill': setPrefillInput(e.content); break;
        case 'fsChanged': publishFsChanged(stateRef.current.session?.vpsId ?? '', e.paths); break;
        case 'window': wsRef.current?.request(e.reason); break;
        case 'refetch':
          // eslint-disable-next-line no-console
          console.info(`[charon] ${sessionId.slice(0, 8)}: ${e.reason} → window`);
          wsRef.current?.request('missed-frame');
          break;
        default: break;
      }
    }
  }, [sessionId]);

  const ctxFor = useCallback((rev: SyncRev | null, fromJournal: boolean) => ({
    fromJournal, rev, nowMs: Date.now(),
    view: viewRef.current ?? 'full',
    provider: stateRef.current.provider,
    hubBoundaries: stateRef.current.hubBoundaries,
  }), []);

  const dispatchFrame = useCallback((ev: SessionFrame, rev: SyncRev | null, fromJournal: boolean) => {
    const out = applyFrame(stateRef.current, ev, ctxFor(rev, fromJournal));
    stateRef.current = out.state;
    if (!fromJournal && out.effects.length) runEffects(out.effects);
  }, [ctxFor, runEffects]);

  // ── Delta batching: one combined delta per ≤ 80 ms commit ────────────────
  const pendingDeltaRef = useRef<{ type: 'assistant_text' | 'thinking'; text: string; rev: SyncRev | null } | null>(null);
  const deltaTimerRef = useRef<number | null>(null);
  const clearDeltaTimer = useCallback(() => {
    if (deltaTimerRef.current != null) {
      clearTimeout(deltaTimerRef.current);
      deltaTimerRef.current = null;
    }
  }, []);
  const flushDelta = useCallback(() => {
    clearDeltaTimer();
    const p = pendingDeltaRef.current;
    if (!p) return;
    pendingDeltaRef.current = null;
    const ev = (p.type === 'assistant_text'
      ? { type: 'assistant_text', delta: p.text }
      : { type: 'thinking', text: p.text }) as SessionFrame;
    dispatchFrame(ev, p.rev, false);
  }, [clearDeltaTimer, dispatchFrame]);

  // ── Live frames ─────────────────────────────────────────────────────────
  const journalRef = useRef(new TranscriptJournal<SessionFrame>());
  const handleEvent = useCallback((ev: SessionFrame, reception?: Reception) => {
    const rev = reception?.rev ?? null;
    // Recorded while a window GET is in flight, then applied (I6).
    if (rev && journalRef.current.active) journalRef.current.record(ev, rev, reception?.bytes ?? 0);
    if (responseSpeedRef.current.observe(ev, reception?.at ?? performance.now(), reception?.bytes, reception?.catchUp ?? false)) {
      setResponseSpeed(null);
    } else if (ev.type === 'usage' || ev.type === 'stop') {
      setResponseSpeed(responseSpeedRef.current.read(performance.now()));
    }
    const delta = ev.type === 'assistant_text'
      || (ev.type === 'thinking' && PROVIDERS[stateRef.current.provider].thinkingDelivery === 'delta');
    if (delta) {
      if (isCoveredBySnapshot(stateRef.current, ev.type, rev)) return;
      const text = ev.type === 'assistant_text' ? ev.delta : (ev as { text: string }).text;
      const p = pendingDeltaRef.current;
      if (p && p.type !== ev.type) flushDelta();
      const cur = pendingDeltaRef.current;
      pendingDeltaRef.current = { type: ev.type as 'assistant_text' | 'thinking', text: (cur?.text ?? '') + text, rev };
      if (deltaTimerRef.current == null && typeof window !== 'undefined') {
        deltaTimerRef.current = window.setTimeout(() => {
          deltaTimerRef.current = null;
          flushDelta();
          publish();
        }, DELTA_COMMIT_MS);
      }
      return;
    }
    // Any other frame lands AFTER the text received before it.
    flushDelta();
    dispatchFrame(ev, rev, false);
    publish();
  }, [dispatchFrame, flushDelta, publish]);

  // ── Window answers ───────────────────────────────────────────────────────
  const applyWindow = useCallback((r: AgentSessionDetailResponse, mode: 'replace' | 'tail',
    replay: Array<{ ev: SessionFrame; rev: SyncRev }>) => {
    // A stamped answer: the batch is either inside the snapshot (≤ R) or
    // journaled (> R) — dropped. An unstamped one (older hub) has no journal:
    // the batch joins the buffer the snapshot reconciles with.
    if (r.sync && pendingDeltaRef.current?.rev) {
      clearDeltaTimer();
      pendingDeltaRef.current = null;
    } else {
      flushDelta();
    }
    stateRef.current = applySnapshot(stateRef.current, r,
      { ...ctxFor(null, true), view: r.view ?? viewRef.current ?? 'full', mode });
    for (const { ev, rev } of replay) dispatchFrame(ev, rev, true);
    publish();
    freshAppliedRef.current = true;
    setLoadFailed(false);
    // A retried mount landed: its failure banner is obsolete.
    if (loadErrorShownRef.current) { loadErrorShownRef.current = false; setError(null); }
    setIsSyncing(false);
    setHistoryReady(true);
    // A newer hub process answered: `fetchWindow`'s noteHttpSync already made
    // the stream follow (§3.1) — a second trigger here would kill the stream
    // it just opened.
  }, [clearDeltaTimer, flushDelta, ctxFor, dispatchFrame, publish]);

  // ── Mount: focus → subscribe → resync/ready listeners → view ─────────────
  useEffect(() => {
    void setFocus(sessionId);
    const journal = journalRef.current;
    const ws = createWindowSync({
      fetchWindow: ({ view: v, conn, focusSeq, signal }) => {
        const c = cacheRef.current;
        const p = c
          ? c.fetch(sessionId, { view: v, force: true, signal, focus: { conn, focusSeq } })
          : sessionApi.get(sessionId, signal, { view: v, conn, focusSeq });
        // §3.1 HTTP epoch rule: a newer epoch means the hub restarted ⇒ reconnect
        // (windowSync itself ignores an older-epoch answer).
        return p.then((r) => { noteHttpSync(r.sync); return r; });
      },
      apply: applyWindow,
      journal,
      focusTicket: getFocusTicket,
      // Cold open: wait for the conn's registration, else the hub answers
      // unfocused and the hello retry downloads the window again.
      streamReady: isStreamLive,
      epoch: () => getSyncPosition().epoch,
      onError: (e) => {
        const msg = errorText(e);
        if (msg.includes('→ 404')) { onKilledRef.current?.(); return; }
        if (msg.includes('→ 401')) { reloadForExpiredSession(); return; }
        if (!stateRef.current.loaded) {
          setError({ msg });
          setLoadFailed(true);
          loadErrorShownRef.current = true;
        }
      },
      onFlight: (inFlight) => {
        setWindowInFlight(inFlight);
        // Failed or not, the transcript no longer occupies the link.
        if (!inFlight) setHistoryReady(true);
      },
    });
    wsRef.current = ws;
    const unsubscribe = subscribeSession(sessionId, handleEvent as (ev: SessionFrame & { sessionId: string }, r: EventReception) => void);
    const unsubResync = subscribeResync((r) => ws.onResync(r.rev));
    const unsubReady = subscribeSyncReady(() => ws.onHelloComplete());
    return () => {
      unsubscribe();
      unsubResync();
      unsubReady();
      ws.dispose();
      if (wsRef.current === ws) wsRef.current = null;
      clearDeltaTimer();
      pendingDeltaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // The view drives the window: the first non-null one mounts (after a cache
  // paint), a change re-windows (messages kept until the answer lands).
  useEffect(() => {
    viewRef.current = view;
    const ws = wsRef.current;
    if (!ws) return;
    if (view && !freshAppliedRef.current && !stateRef.current.loaded) {
      const cached = cacheRef.current?.get(sessionId, view);
      if (cached?.session) {
        stateRef.current = applySnapshot(stateRef.current, cached, { ...ctxFor(null, true), mode: 'replace' });
        publish();
      }
    }
    ws.setView(view);
  }, [view, sessionId, ctxFor, publish]);

  // ── Probe: rev-gated, every 15 s while visible + on wake-ups (§14.24) ─────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let disposed = false;
    let probing = false;
    let waitingSince: number | null = null;
    let waitTimer: number | null = null;
    const ac = new AbortController();
    const decide = (p: Parameters<typeof decideRepair>[0]) => {
      waitTimer = null;
      const ws = wsRef.current;
      if (disposed || !ws) return;
      const s = stateRef.current;
      const frameRev = getSessionFrameRev(sessionId);
      // The NETWORK snapshot only: a cache-painted `s.snapshotRev` must never
      // vouch for the transcript (frames received while unmounted are > it).
      const snap = ws.snapshotRev;
      const sessionFrameRev = cmpRev(frameRev, snap) > 0 ? frameRev : snap;
      const d = decideRepair(p, {
        inFlight: ws.inFlight, epoch: getSyncPosition().epoch, lastRev: lastRev(), sessionFrameRev,
        knownRowIds: s.knownRowIds, knownPendingIds: pendingGateIds(s), waitingSinceMs: waitingSince, nowMs: Date.now(),
      });
      if (d.action === 'wait') {
        waitingSince ??= Date.now();
        waitTimer = window.setTimeout(() => decide(p), PROBE_WAIT_RECHECK_MS);
        return;
      }
      waitingSince = null;
      if (d.action === 'none') {
        if (!ws.inFlight && p.maxMessageId > stateRef.current.afterId) {
          stateRef.current = { ...stateRef.current, afterId: p.maxMessageId };
        }
        setIsSyncing(false);
      } else if (d.action === 'window') {
        ws.request(d.reason);
      } else {
        requestReconnect(d.reason);
      }
    };
    const probe = async () => {
      const ws = wsRef.current;
      const v = viewRef.current;
      if (disposed || !ws || !v || ws.inFlight || probing || waitTimer != null) return;
      if (document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (!ws.everApplied) {
        // The mount window failed (503, network, timeout) — even over a cache
        // paint (`loaded` then, but stale): nothing else re-asks, so the tick
        // and every wake-up retry it.
        ws.retryMount();
        return;
      }
      probing = true;
      try {
        const p = await sessionApi.probe(sessionId,
          { conn: getFocusTicket().conn, afterId: stateRef.current.afterId, view: v }, ac.signal);
        if (!disposed) decide(p);
      } catch (e) {
        if (disposed) return;
        const msg = errorText(e);
        // An older hub has no probe route (or the session is gone): the
        // window GET answers both (its own 404 navigates away).
        if (msg.includes('→ 404')) wsRef.current?.request('probe-404');
        else if (msg.includes('→ 401')) reloadForExpiredSession();
      } finally {
        probing = false;
      }
    };
    const wake = (stale: boolean) => {
      if (stale) setIsSyncing(true);
      void probe();
    };
    const onVisibility = () => {
      resetResponseSpeed();
      if (document.visibilityState === 'visible') wake(true);
    };
    const onOnline = () => { resetResponseSpeed(); wake(true); };
    const onFocus = () => wake(false);
    // A notification was clicked targeting a session (HubPanel, SW `open-session`).
    const onNotifOpen = (e: Event) => {
      const sid = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sid || sid === sessionId) wake(true);
    };
    const timer = window.setInterval(() => { void probe(); }, PROBE_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onFocus);
    window.addEventListener('charon:notif-open', onNotifOpen as EventListener);
    return () => {
      disposed = true;
      ac.abort();
      clearInterval(timer);
      if (waitTimer != null) clearTimeout(waitTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('charon:notif-open', onNotifOpen as EventListener);
    };
  }, [sessionId, lastRev, resetResponseSpeed]);

  // ── Displayed values (overlays over the transcript) ──────────────────────
  const status = overlays.status.value(state.status as WorkerStatus) ?? null;
  const permissionMode = overlays.mode.value(state.meta.permissionMode);
  const modelPair = overlays.model.value({ model: state.meta.model, fallbackModel: state.meta.fallbackModel });
  const effort = overlays.effort.value(state.meta.effort);

  useEffect(() => {
    if (status !== 'thinking') {
      responseSpeedRef.current.stopReception();
      setResponseSpeed(responseSpeedRef.current.read(performance.now()));
      return;
    }
    responseSpeedRef.current.start(performance.now());
    setResponseSpeed(responseSpeedRef.current.read(performance.now()));
    const timer = window.setInterval(() => {
      setResponseSpeed(responseSpeedRef.current.read(performance.now()));
    }, 500);
    return () => clearInterval(timer);
  }, [status]);

  // ── Lazy edit-content loading (CLAUDE.md §14 gotcha 41) ──────────────────
  const editsLoadInflightRef = useRef(false);
  const editsLoadAttemptedRef = useRef<Set<string>>(new Set());
  const loadEdits = useCallback(async (targetPaths: string[]) => {
    if (editsLoadInflightRef.current || targetPaths.length === 0) return;
    editsLoadInflightRef.current = true;
    try {
      const r = await sessionApi.getEdits(sessionId);
      const byPath = new Map(r.edits.map((e) => [e.filePath, e] as const));
      const prev = stateRef.current.edits;
      const next = new Map(prev);
      let changed = false;
      for (const path of targetPaths) {
        const cur = next.get(path);
        // Gone, or already loaded/filled live meanwhile.
        if (!cur || cur.before != null || cur.after != null) continue;
        const got = byPath.get(path);
        if (got && (got.before != null || got.after != null)) {
          next.set(path, { ...cur, before: got.before, after: got.after,
            truncated: cur.truncated || got.truncated, toolUseId: got.toolUseId || cur.toolUseId });
          changed = true;
        }
      }
      if (changed) {
        stateRef.current = { ...stateRef.current, edits: next };
        publish();
      }
      for (const path of targetPaths) {
        const got = byPath.get(path);
        if (!got || (got.before == null && got.after == null)) editsLoadAttemptedRef.current.add(path);
      }
    } catch {
      // Transient: the next edits change retries. The diffs tab is non-critical.
    } finally {
      editsLoadInflightRef.current = false;
    }
  }, [sessionId, publish]);
  // Waits for `historyReady`: diff contents can weigh hundreds of KB.
  useEffect(() => {
    if (!historyReady) return;
    const unloaded: string[] = [];
    for (const [k, v] of state.edits) {
      if (v.before == null && v.after == null && !editsLoadAttemptedRef.current.has(k)) unloaded.push(k);
    }
    if (unloaded.length) void loadEdits(unloaded);
  }, [state.edits, loadEdits, historyReady]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const loadMoreHistory = useCallback(async () => {
    if (loadMoreInflightRef.current) return;
    const s = stateRef.current;
    const cursor = s.oldestChatId;
    const v = viewRef.current ?? 'full';
    if (cursor == null || !s.hasMore) return;
    // A view switch is pending or its window flies: the cursor belongs to the
    // outgoing window and the answer would be dropped (applyOlderPage).
    if (requestedViewRef.current != null && requestedViewRef.current !== v) return;
    if (wsRef.current?.replacing) return;
    loadMoreInflightRef.current = true;
    setIsLoadingMore(true);
    try {
      const older = await sessionApi.loadOlder(sessionId, cursor, 200, v);
      if (viewRef.current !== v) return;          // a view switch replaced the window
      stateRef.current = applyOlderPage(stateRef.current, older, cursor,
        { view: v, provider: stateRef.current.provider });
      publish();
      if (older.messages.length > 0) {
        try { cacheRef.current?.extendWithOlder?.(sessionId, older, v); } catch {}
      }
    } catch (e) {
      setError({ msg: errorText(e) });
    } finally {
      setIsLoadingMore(false);
      loadMoreInflightRef.current = false;
    }
  }, [sessionId, publish]);

  const send = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    // Optimistic bubble `u-<clientMessageId>` + a `thinking` overlay: the id
    // rides the POST (the agent's idempotency key) and comes back on
    // `user_echo` and in the answer's `rowId` — whichever arrives first
    // renames the bubble `m<rowId>` in place (snapshots re-append it while
    // unmaterialised, optimistic.ts). On failure the bubble stays until the
    // next snapshot (the dominant failure, the agent RPC throwing, happens
    // AFTER the row was persisted: its echo / the snapshot still name it; a
    // never-persisted send is then dropped) and the status overlay reverts.
    const clientMessageId = newClientMessageId();
    stateRef.current = applyLocalSend(stateRef.current, clientMessageId, trimmed, Date.now());
    publish();
    const h = overlays.status.set('thinking');
    watchOverlays();
    resetResponseSpeed();
    try {
      const res = await settle(h, sessionApi.sendInput(sessionId, trimmed, clientMessageId));
      const rowId = typeof res?.rowId === 'number' ? res.rowId : null;
      if (rowId != null) {
        stateRef.current = applyLocalSendAck(stateRef.current, clientMessageId, rowId);
        publish();
      }
    } catch (e) {
      // The bubble stays until the next snapshot settles it (kept if the row
      // was persisted before the failure, dropped otherwise).
      stateRef.current = applyLocalSendFailed(stateRef.current, clientMessageId);
      setError({ msg: errorText(e) });
    }
  }, [sessionId, publish, overlays, watchOverlays, settle, resetResponseSpeed]);

  const interrupt = useCallback(async () => {
    try { await sessionApi.interrupt(sessionId); }
    catch (e) { setError({ msg: errorText(e) }); }
  }, [sessionId]);

  const forceStop = useCallback(async () => {
    try { await sessionApi.forceStop(sessionId); }
    catch (e) { setError({ msg: errorText(e) }); }
  }, [sessionId]);

  const setMode = useCallback(async (mode: SessionMode) => {
    if (permissionMode === mode) return;
    const h = overlays.mode.set(mode);
    watchOverlays();
    try { await settle(h, sessionApi.setMode(sessionId, mode)); }
    catch (e) { setError({ msg: errorText(e) }); }
  }, [sessionId, permissionMode, overlays, watchOverlays, settle]);

  const setModel = useCallback(async (newModel: string | null, newFallbackModel: string | null = null) => {
    if (newModel === modelPair.model && newFallbackModel === modelPair.fallbackModel) return;
    const h = overlays.model.set({ model: newModel, fallbackModel: newFallbackModel });
    watchOverlays();
    try { await settle(h, sessionApi.setModel(sessionId, newModel, newFallbackModel)); }
    catch (e) { setError({ msg: errorText(e) }); }
  }, [sessionId, modelPair.model, modelPair.fallbackModel, overlays, watchOverlays, settle]);

  const setEffort = useCallback(async (newEffort: string | null) => {
    // A pending endpoint selection may differ from the persisted effort; even
    // choosing the persisted value must reach the server to replace that queue.
    const h = overlays.effort.set(newEffort);
    watchOverlays();
    try { await settle(h, sessionApi.setEffort(sessionId, newEffort)); }
    catch (e) { setError({ msg: errorText(e) }); throw e; }
  }, [sessionId, overlays, watchOverlays, settle]);

  const doSleep = useCallback(async () => {
    const h = overlays.status.set('sleeping');
    watchOverlays();
    try { await settle(h, sessionApi.sleep(sessionId)); }
    catch (e) { setError({ msg: errorText(e) }); }
  }, [sessionId, overlays, watchOverlays, settle]);

  const doResume = useCallback(async () => {
    setError(null);
    const h = overlays.status.set('starting');
    watchOverlays();
    try { await settle(h, sessionApi.resume(sessionId)); }
    catch (e) { setError({ msg: errorText(e) }); }
  }, [sessionId, overlays, watchOverlays, settle]);

  // In-place SDK restart (awaited sleep + resume) — "apply now" (§14.35).
  const doRestart = useCallback(async () => {
    setError(null);
    const h = overlays.status.set('starting');
    watchOverlays();
    try {
      await settle(h, sessionApi.restart(sessionId));
      const s = stateRef.current;
      stateRef.current = { ...s, meta: { ...s.meta, modelPendingApply: false, effortPendingApply: false } };
      publish();
    } catch (e) { setError({ msg: errorText(e) }); }
  }, [sessionId, overlays, watchOverlays, settle, publish]);

  const doDelete = useCallback(async () => {
    try {
      await sessionApi.remove(sessionId);
      onKilledRef.current?.();
    } catch (e) { setError({ msg: errorText(e) }); }
  }, [sessionId]);

  // Pessimistic acks (§14.18): the card goes only after the POST succeeded;
  // a snapshot older than the answer's `sync` does not bring it back.
  const respondPermission = useCallback(async (
    permId: string, allow: boolean, always = false, suggestion?: number,
  ) => {
    try {
      const res = await sessionApi.respondPermission(sessionId, permId, allow, always, suggestion);
      stateRef.current = applyLocalResolution(stateRef.current, 'permission', permId, syncOf(res));
      publish();
    } catch (e) { setError({ msg: errorText(e) }); }
  }, [sessionId, publish]);

  const respondQuestion = useCallback(async (qid: string, answers: Record<string, string> | null) => {
    try {
      const res = await sessionApi.respondQuestion(sessionId, qid, answers);
      stateRef.current = applyLocalResolution(stateRef.current, 'question', qid, syncOf(res), answers);
      publish();
    } catch (e) { setError({ msg: errorText(e) }); throw e; }
  }, [sessionId, publish]);

  const respondExitPlan = useCallback(async (qid: string, decision: 'approve' | 'reject', feedback?: string) => {
    try {
      const res = await sessionApi.respondExitPlan(sessionId, qid, decision, feedback);
      stateRef.current = applyLocalResolution(stateRef.current, 'exit_plan', qid, syncOf(res));
      publish();
    } catch (e) { setError({ msg: errorText(e) }); }
  }, [sessionId, publish]);

  const clearPrefillInput = useCallback(() => setPrefillInput(null), []);
  const clearError = useCallback(() => setError(null), []);
  const requestWindow = useCallback((reason: WindowReason) => { wsRef.current?.request(reason); }, []);
  const refetchHistory = useCallback(async () => { wsRef.current?.request('missed-frame'); }, []);
  const setHistoryHold = useCallback((hold: boolean) => { void hold; }, []);

  const bgTasks = useMemo(() => bgTasksToArray(state.bgTasks), [state.bgTasks]);
  // Snapshot count + live tool_use ids since (grows between window answers).
  const toolCallCount = toolCallTotal(state);

  return useMemo(() => ({
    sessionMeta: state.session,
    messages: state.messages,
    currentAssistant: state.buf.assistant,
    streamingInto: state.buf.streamingInto,
    status, permissionMode,
    model: modelPair.model, fallbackModel: modelPair.fallbackModel, effort,
    modelPendingApply: state.meta.modelPendingApply, effortPendingApply: state.meta.effortPendingApply,
    effectiveModel: state.meta.effectiveModel,
    liveUsage: state.liveUsage, tokenUsage: state.tokenUsage, responseSpeed,
    toolCalls: state.toolCalls, toolCallCount, edits: state.edits, files: state.files, bgTasks,
    permQueue: state.queues.permissions, questionQueue: state.queues.questions, exitPlanQueue: state.queues.exitPlans,
    prefillInput, error,
    isLoadingHistory: !state.loaded && !loadFailed,
    isSyncing, historyReady,
    hasMore: state.hasMore, isLoadingMore, view, windowInFlight,
    send, interrupt, forceStop, setMode, setModel, setEffort,
    doSleep, doResume, doRestart, doDelete,
    respondPermission, respondQuestion, respondExitPlan,
    clearPrefillInput, refetchHistory, requestWindow, loadMoreHistory, setHistoryHold, clearError,
  }), [
    state, status, permissionMode, modelPair.model, modelPair.fallbackModel, effort, responseSpeed,
    toolCallCount, bgTasks, prefillInput, error, loadFailed, isSyncing, historyReady, isLoadingMore, view,
    windowInFlight,
    send, interrupt, forceStop, setMode, setModel, setEffort,
    doSleep, doResume, doRestart, doDelete,
    respondPermission, respondQuestion, respondExitPlan,
    clearPrefillInput, refetchHistory, requestWindow, loadMoreHistory, setHistoryHold, clearError,
  ]);
}

