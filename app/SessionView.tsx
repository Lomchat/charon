'use client';
import { api } from '@/lib/api';
import { pendingUpdateRows } from '@/lib/runtimeUpdate';
import PickerControl from './PickerControl';
import SessionAccountChoice from './SessionAccountChoice';
import type { AccountSwitchTarget } from './UsageAccountSwitch';
import dynamic from '@/app/dynamic';
import { useSessionEndpoint } from './useSessionEndpoint';
import { endpointParameters, supportsCustomEndpoint, type EndpointState } from '@/lib/customEndpoints';
import EndpointModelPicker from './EndpointModelPicker';
import EndpointEffortPicker, { EndpointEffortSummary } from './EndpointEffortPicker';
import { isOpenCodeGo } from '@/lib/opencodeModels';

import SessionSettingsModal from './SessionSettingsModal';
import { IconArrowRepeat, IconGear, IconPause, IconPlay, IconStop, IconRewind, IconGitBranch, IconBullseye, IconChatSide, IconSparkle } from './icons';
import { goalIsLive, shownGoal } from '@/lib/sessionGoal';
import { sameModel } from '@/lib/strictModel';
import type { SessionRecap } from '@/lib/sessionRecap';
import { FoldEdge, foldRootProps, useBubbleFold } from './bubbleFold';
import { coldResumeShare, fmtTokens as fmtDriverTokens } from '@/lib/usageDrivers';
import type { InsightUsage } from './SessionInsight';
import type { TurnLedger } from '@/lib/promptCache';
import { Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import type { Vps } from '@/lib/db/schema';
import { addOverlay, getSummary, subscribeSummaries } from './sync/summaryStore';
import type { SessionListItem, AgentKind, SessionAttachment, FastModeVerdict } from '@/lib/types/api';
import {
  asSessionProvider, hasEffortAxis, isSessionEffort, PROVIDERS, sessionCapabilities, sessionModes,
  showsTurnCost, supportsSessionCapability,
  type SessionMode,
} from '@/lib/sessionCapabilities';
import {
  expandUserCommand, filterSlash, isSkillItem, parseCharonCommand, skillInputItems, slashMenu, userSlashItems,
  type SlashAction, type SlashItem,
} from '@/lib/slashCommands';
import { useSlashCatalog } from './slashCatalog';
import { ensureUserCommands, useUserCommands } from './userCommandsStore';
import { openTab as openWorkspaceTab } from './tabStore';
import { isTurnInterrupted } from '@/lib/turnInterrupted';
import { parseSessionError } from '@/lib/sessionError';
import { isClaudeAuthExpired } from '@/lib/authExpired';
import { resolveResetAtMs } from '@/lib/rateLimitReset';
import Message, { type Msg, summarizeToolInput, FileLinkContext } from './Message';
import ToolPanel from './ToolPanel';
import BgTasksBar from './BgTasksBar';
import ScheduledTasksBar from './ScheduledTasksBar';
import GoalBar, { GoalEditor } from './GoalBar';
import Switch from './Switch';
import { codexSpeedOf, useCodexSpeeds } from './codexModelsCache';
import { SpeedRow, SwitchRow, fastModeBlocker, fastModeOffered } from './EffortSwitches';
import { CLAUDE_FAST_HINT } from '@/lib/speedCosts';
import UsageMeter, { UsageRings } from './UsageMeter';
import SessionTokenMeter from './SessionTokenMeter';
import type { SessionTokenUsage } from '@/lib/sessionTokenUsage';
import QuestionCard from './QuestionCard';
import AsyncQuestionBubble from './AsyncQuestionBubble';
import AsyncQuestionStrip, { ComposerWithAsyncStrip } from './AsyncQuestionStrip';
import { liveStreamingMessage, rowKey } from './sync/transcriptReducer';
import { PendingInputs, type PendingItem } from './PendingInputs';
import ExitPlanCard from './ExitPlanCard';
import ApprovalDeadline from './ApprovalDeadline';
import PermissionActions from './PermissionActions';
import type {
  PermissionRequest, PendingQuestion, PendingExitPlan, ToolCallEntry,
} from './sessionTypes';
import { useSessionStream, type StreamCache } from './useSessionStream';
import type { ResponseSpeedSnapshot } from './responseSpeed';
import ModelPicker from './ModelPicker';
import EffortPicker from './EffortPicker';
import { PROVIDER_CATALOGS } from './modelPickers';
import AgentLogo from './AgentLogo';
import { MODE_SWITCH_META, providerName, providerText } from '@/lib/providerText';
import { describeGate, describeLive, toolDetail, type LiveLine } from '@/lib/liveActivity';
import ForkModal from './ForkModal';
import { accountProfileId } from '@/lib/accountProfiles';
import { copySessionNotifications } from './browserNotifications';
import RewindModal from './RewindModal';

import {
  getCached, fetchAndCache, invalidate as invalidateCache,
  extendWithOlder as extendCacheWithOlder,
} from './sessionCache';
import { useInputDraft } from './inputDraftStore';
import { useStableCallback, useStableOptionalCallback, useStableValue, shallowEqualRows } from './useStable';
import { useUsage } from './usageStore';
import { COMPOSER_MAX_VIEWPORT_SHARE, DEFAULT_COMPOSER_SIZE, revealComposer, useComposerSize, type ComposerSize } from './composerSize';
import { formatQuote, insertQuoteBlock } from './chatQuote';
import QuoteSelectionButton from './QuoteSelectionButton';
import ComposerGrip from './ComposerGrip';
import PendingZone from './PendingZone';
import { isPathDrag, readPathDrag } from './pathDrag';
import { toolPanelLeft, uploadZoneOf } from './fileDropZones';
import { IconInsert } from './fileIcons';
import {
  useSessionAttachments, type PendingUpload,
} from './sessionAttachments';
import { IconPaperclip, IconSend, IconUpload } from './icons';
import { chatBubbleAbove } from './chatScroll';
import { shouldShowChatRole, transcriptViewFor } from './chatVisibility';
import { canCompactSession } from './sessionInsightState';
import { useSessionContext } from './useSessionContext';
import HeaderContextGauge from './HeaderContextGauge';
import { ContextWindowContext, useSessionCacheReading } from './PromptCacheMarks';
import { peerAssistantReplies, peerSessionTarget } from './peerMessageLinks';
import { attentionForRow } from '@/lib/sessionAttention';
import { usePeerMessageNavigation } from './usePeerMessageNavigation';
import { outcome } from './outcome';

// Renders one active session. Stream state lives in useSessionStream;
// global navigation, modals and polling stay in HubPanel.

type Props = {
  sessionId: string;
  selected: SessionListItem;
  /** Show technical transcript activity (tool calls/results, plans and
   * reasoning). False is the conversation view: the session GET is asked for
   * `view=conversation` (CLAUDE.md §14.25/§14.107). */
  showTools: boolean;
  /** `showTools` has been read from storage (HubPanel's mount effect).
   *  Until then the transcript fetches nothing — React runs this child's
   *  effects before the parent's, so a page load with tools hidden would
   *  otherwise fetch the full window first. Absent (other mounts, e.g. the
   *  desk modal): `showTools` is final and picks the view. */
  showToolsReady?: boolean;
  /** This session's addressable handle (unique on its VPS). Shown in the
   *  header so the user knows what other agents type to reach it. */
  handle?: string | null;
  /** Kept for wire compatibility with older parents. New Charon handles are
   * durable DB identities and therefore always confirmed. */
  handleConfirmed?: boolean;
  /** Other sessions on the SAME machine — the ones this one can address.
   *  Feeds the `@` menu in the composer. */
  siblings?: Array<{ id: string; name: string | null; handle: string; confirmed?: boolean; status: string }>;
  selectedVps: Vps | null;
  // Opens the Claude sign-in modal for this session's VPS — handed down to
  // <Message> so a provider authentication-error bubble carries its own fix
  // (Claude hosted OAuth or Codex device-code login, §14.65/68).
  onReauth?: () => void;
  // Sound + native Notification handled by the parent (cross-session), but
  // we can still play a beep on stop if configured.
  notifSoundEnabled?: boolean;
  // Detection of "claude-agent-sdk not installed" error on the VPS → parent
  // opens an install session for this VPS (cf. HubPanel.openInstallSession).
  onImportError?: (vps: Vps) => void;
  // Post-kill navigation (parent setSelectedId(null) + refresh).
  onKilled: () => void;
  // After reverting a file edit → refresh parent's sessions list.
  onAfterRevert?: () => void;
  // The header `/usage` gauges read app/usageStore.ts themselves (`useUsage`,
  // in the leaves that draw them): a reading never re-renders this view.
  onUsageRefresh?: () => void;
  /** Whose gauges these are, shown when the usage detail opens. */
  usageAccountLabel: string | null;
  profileNumber?: number;
  // Opens the ToolPanel drawer on narrow screens (<=1100px it's hidden behind
  // a transform). Used by the git chip, which must reveal the panel it points
  // at — on desktop the panel is always visible and this is a no-op.
  onOpenTools?: (tab?: 'git' | 'calls') => void;
  /** Jump to another session, from the explorer's activity icons (§14.88). */
  // §14.78: opening something that was just CREATED must carry the created row
  // and pin it. A bare id loses the race against the session-list refresh, and
  // an unpinned tab is a preview the next preview evicts.
  onOpenSession?: (
    sessionId: string,
    hint?: { vpsId: string; cwd: string },
    pin?: boolean,
  ) => void;
  /** The phone's "＋ agent" beside the cwd: the new-session wizard on this
   *  session's VPS and path, asking only which backend (or a shell) and a
   *  name (the TabBar carries the desktop equivalent, hidden ≤820px). */
  onNewAgentHere?: () => void;
  /** The explorer's folder tabs and "New Session Here…" (ToolPanel). */
  onOpenFolder?: (vpsId: string, cwd: string) => void;
  onNewSessionIn?: (vpsId: string, cwd: string) => void;
  /** `/shell`: a terminal in this folder (the shell wizard, prefilled). */
  onNewShellIn?: (vpsId: string, cwd: string) => void;
  /** `/routine`: the Routines modal on a new routine prefilled from here. */
  onNewRoutine?: (draft: { vpsId: string; cwd: string; kind: AgentKind; prompt: string }) => void;
  /** A narrow embed (the desk's drawer): no Tools panel, the header always
   *  unfolded, a composer that ignores the shared composer size (no grip, never
   *  collapsed) and grows with its text. Adds `.is-compact` on `.app-main`. */
  compact?: boolean;
  /** The composer's textarea, for a host that focuses it with its own keys.
   *  Null while a gate card or the Resume CTA holds the composer's place. */
  composerRef?: Ref<HTMLTextAreaElement>;
  /** Enter (no modifier) or Tab in an EMPTY composer: no text, no upload in
   *  flight, no `/` or `@` menu open. True = the host handled it. */
  onEmptyComposerKey?: (key: 'Enter' | 'Tab', shift: boolean) => boolean;
};

// Module-side session cache — sessionCache.ts shared desktop/mobile.
// The StreamCache instance is created once, not per-render.
const sharedCacheRef: StreamCache = {
  get: (id, view) => getCached(id, view),
  fetch: (id, opts) => fetchAndCache(id, opts),
  invalidate: (id) => invalidateCache(id),
  extendWithOlder: (id, older, view) => extendCacheWithOlder(id, older, view),
};

/** A blocking gate the summary lists but the transcript lacks for this long
 *  (no window in flight) ⇒ one `gate-payload` window per gate id (S3). */
const GATE_PAYLOAD_GRACE_MS = 3_000;
/** How often a reader at the live end checks for a transcript to trim. */
const TRIM_CHECK_MS = 4_000;

const CustomEndpointModal = dynamic(() => import('./CustomEndpointModal'), { ssr: false });

const SYNC_CUE_DELAY_MS = 400;

/** Aside (§14.119) whenever the session's process is up — mid-turn or idle:
 *  the CLI answers it either way. Asleep there is nothing to ask. */
const ASIDE_STATUSES = new Set(['active', 'thinking', 'background', 'failed']);

/** Pair tool_use ↔ tool_result for inline rendering: a result whose call is
 *  in the list rides on it (`attached`), the others stand alone. */
function pairToolResults(messages: Msg[]): { msg: Msg; attached?: Msg }[] {
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
}

/** A ref the parent handed down, set like React would (a callback or an object). */
function assignRef<T>(ref: Ref<T> | undefined, el: T): void {
  if (typeof ref === 'function') ref(el);
  else if (ref) (ref as { current: T }).current = el;
}

// The header actions' requests, outside the component: they throw, and the
// handlers branch on `outcome()` (React Compiler, app/outcome.ts).
async function postCompact(sessionId: string): Promise<void> {
  const r = await fetch(`/api/sessions/${sessionId}/compact`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || 'compaction failed');
}
async function postRollback(sessionId: string, messageId: string): Promise<void> {
  const r = await fetch(`/api/sessions/${sessionId}/rollback`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageId }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || 'rewind failed');
}
async function postFork(sessionId: string, targetKind: AgentKind, options?: {
  lastTurnId?: string; cutoffMessageId?: number; replacementPrompt?: string; targetProfile?: string;
}): Promise<{ id: string; vpsId: string; cwd?: string | null }> {
  const r = await fetch(`/api/sessions/${sessionId}/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetKind, ...options }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.session?.id) throw new Error(j?.error || 'fork failed');
  return j.session;
}

export default function SessionView({
  sessionId, selected, showTools, showToolsReady, selectedVps, handle, handleConfirmed, siblings: siblingsProp,
  onImportError, onKilled, onAfterRevert: onAfterRevertProp, onUsageRefresh: onUsageRefreshProp, usageAccountLabel,
  onReauth: onReauthProp, profileNumber,
  onOpenTools: onOpenToolsProp,
  onOpenSession: onOpenSessionProp,
  onNewAgentHere,
  onOpenFolder: onOpenFolderProp,
  onNewSessionIn: onNewSessionInProp,
  onNewShellIn, onNewRoutine,
  compact = false, composerRef, onEmptyComposerKey: onEmptyComposerKeyProp,
}: Props) {
  // The parent passes inline arrows and a freshly mapped `siblings` on every
  // render; below this line they keep ONE identity, so memo(MessageHistory),
  // memo(Message), memo(ToolPanel) and memo(ChatInputBar) hold (§14.38). An
  // unstable prop here re-rendered — and re-parsed — every bubble per frame.
  const onOpenSession = useStableOptionalCallback(onOpenSessionProp);
  const parentSessionId = selected.parentSessionId ?? null;
  const onReauth = useStableOptionalCallback(onReauthProp);
  const onOpenTools = useStableOptionalCallback(onOpenToolsProp);
  const onOpenFolder = useStableOptionalCallback(onOpenFolderProp);
  const onNewSessionIn = useStableOptionalCallback(onNewSessionInProp);
  const onAfterRevert = useStableOptionalCallback(onAfterRevertProp);
  const onUsageRefresh = useStableOptionalCallback(onUsageRefreshProp);
  const onEmptyComposerKey = useStableOptionalCallback(onEmptyComposerKeyProp);
  const fileLinks = useContext(FileLinkContext);
  const siblings = useStableValue(siblingsProp, shallowEqualRows);
  const usageProfile = accountProfileId(selected);
  const [endpoint, refreshEndpoint] = useSessionEndpoint(sessionId, selected.endpoint);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const closeSessionSettings = useCallback(() => setSessionSettingsOpen(false), []);
  // Phone header (≤820px): ONE folded row until ▾ unfolds the cwd, repo,
  // usage, context and the other actions. Desktop CSS ignores the class.
  const [barExpanded, setBarExpanded] = useState(false);
  const stream = useSessionStream(sessionId, {
    cache: sharedCacheRef,
    onKilled,
    // The fetched view follows the RENDERED `showTools` (never a stored
    // preference the caller did not pass: the desk sets its own).
    view: showToolsReady === false ? null : transcriptViewFor(showTools),
    provider: asSessionProvider(selected.kind),
  });
  const {
    messages, currentAssistant, streamingInto, status, compacting: liveCompacting, held, waiting, pending, runtimeOutdated, runtimeVersions, permissionMode,
    liveActivity,
    model, fallbackModel, effort, ultracode, fastMode, fastModeVerdict, serviceTier, modelPendingApply, effortPendingApply,
    effectiveModel, liveUsage, tokenUsage, responseSpeed,
    toolCalls, toolCallCount, edits, editsMissing, loadEditContents, bgTasks, bgOlderEnded,
    permQueue, questionQueue, exitPlanQueue,
    prefillInput, error, isLoadingHistory, isSyncing, historyReady,
    hasMore, isLoadingMore, view: transcriptView, windowInFlight, requestWindow,
    send: streamSend, sendNow, interrupt, forceStop, setMode, setModel, setEffort, setUltracode, setFastMode, setServiceTier,
    doSleep, doResume, doRestart,
    respondPermission, respondQuestion, respondExitPlan,
    clearPrefillInput, loadMoreHistory, trimHistory, setHistoryHold, clearError,
  } = stream;

  // ── Missing gate payload (S3 defense) ─────────────────────────────────────
  // The session summary (the cross-session store's row) lists a BLOCKING gate
  // this transcript's queues lack: its frame never reached us. After a grace
  // (the frame may be in flight) with no window in flight, ask for ONE window
  // per gate id — the card's payload only comes with the session GET.
  const summaryGates = (selected as { gates?: Array<{ id: string; blocking: boolean }> }).gates;
  const missingGateKey = useMemo(() => {
    if (!summaryGates?.length) return '';
    const held = new Set<string>();
    for (const p of permQueue) held.add(p.id);
    for (const q of questionQueue) held.add(q.id);
    for (const e of exitPlanQueue) held.add(e.id);
    return summaryGates.filter((g) => g.blocking && !held.has(g.id)).map((g) => g.id).sort().join('\n');
  }, [summaryGates, permQueue, questionQueue, exitPlanQueue]);
  const gatePayloadAskedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!missingGateKey || windowInFlight || !historyReady) return;
    const missing = missingGateKey.split('\n').filter((id) => !gatePayloadAskedRef.current.has(id));
    if (!missing.length) return;
    const timer = setTimeout(() => {
      for (const id of missing) gatePayloadAskedRef.current.add(id);
      requestWindow('gate-payload');
    }, GATE_PAYLOAD_GRACE_MS);
    return () => clearTimeout(timer);
  }, [missingGateKey, windowInFlight, historyReady, requestWindow]);

  // Backend of this session (Claude vs Codex). Drives the mode selector
  // (permission modes vs sandbox levels), the model/effort pickers, the
  // per-message logo, the diff rendering, and whether a config change shows the
  // deferred "apply now ↻" badge (Codex applies on the next turn → no badge).
  const sessionKind: AgentKind = asSessionProvider(selected.kind);
  const substitute = substitutedModel(sessionKind, model, effectiveModel);
  const vpsId = selectedVps?.id ?? '';
  const {
    context: sessionContext,
    loaded: contextLoaded,
    loading: contextLoading,
    refresh: refreshContext,
  } = useSessionContext(sessionId);
  const compactAllowed = canCompactSession(status, sessionKind);
  // The prompt cache the last turn left, on the shared 30 s clock (§ prompt cache).
  const promptCache = useSessionCacheReading(selected);
  // What drives usage (lib/usageDrivers.ts, §14.119): the loaded turns' cache
  // ledgers and background work's own tokens. Recomputed on row changes only
  // (never per token), and stable between them for the memo'd Tools panel.
  const usageInput = useMemo((): InsightUsage => {
    const ledgers: TurnLedger[] = [];
    for (const m of messages) if (m.role === 'assistant' && m.turnUsage) ledgers.push(m.turnUsage);
    let tokens = 0, items = 0, workflows = 0;
    for (const t of bgTasks) {
      const n = t.usage?.tokens ?? 0;
      if (n > 0) { tokens += n; items++; if (t.taskType === 'local_workflow') workflows++; }
    }
    return {
      ledgers: ledgers.slice(-40), background: { tokens, items, workflows },
      effort, ultracode, ttlS: selected.promptCache?.ttlS ?? null,
    };
  }, [messages, bgTasks, effort, ultracode, selected.promptCache?.ttlS]);
  // The model's window, for the turn ledgers' "context N%" (PromptCacheMarks).
  const contextWindowTokens = Number(sessionContext?.max_tokens) > 0 ? Number(sessionContext?.max_tokens) : null;

  // The git refresh on a finished turn lives in gitStore's summary watcher:
  // it fires for EVERY session, not only the one on screen.
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const was = prevStatusRef.current;
    prevStatusRef.current = status ?? null;
    // Context telemetry changes once per model request, not on every streamed
    // token. Refresh on the authoritative lifecycle edge, including
    // starting→active after a resume. The initial null→status edge is skipped:
    // the hook already owns that first request for header + Tools.
    if (was !== null && was !== status && status
        && !['thinking', 'starting', 'reconnecting'].includes(status)) {
      void refreshContext();
    }
  }, [status, refreshContext]);

  // ── Session attachments ───────────────────────────────────────────────────
  // One list, two consumers: <ChatInputBar> (underline + insert on upload) and
  // the ToolPanel "files" tab (re-download / copy / re-insert). Held here so
  // they can never disagree. cf. app/sessionAttachments.ts.
  const {
    attachments, pending: pendingUploads, upload: uploadAttachments,
    remove: removeAttachment, dismissPending: dismissPendingUpload,
  } = useSessionAttachments(sessionId);
  // "Insert this path into the message" from the Files tab. Carries a nonce so
  // inserting the SAME path twice in a row still fires (a plain string would
  // be === the previous value and the drain effect would skip it).
  // `block` = a quote from the chat (chatQuote.ts): spliced on its own lines
  // with the caret below it, where a path is spliced inline.
  const [insertRequest, setInsertRequest] = useState<InsertRequest | null>(null);
  const requestInsertPath = useCallback((text: string) => {
    setInsertRequest({ text, nonce: Date.now() });
  }, []);
  const requestQuote = useCallback((text: string) => {
    const quote = formatQuote(text);
    if (quote) setInsertRequest({ text: quote, nonce: Date.now(), block: true });
  }, []);
  const clearInsertRequest = useCallback(() => setInsertRequest(null), []);

  // ── Local UI state (scroll, error details) ────────────────────────────────
  // NOTE: the textarea `input` state now lives inside <ChatInputBar> (isolated
  // at the bottom of this file). Keeping it out of this component is what stops
  // a keystroke from re-rendering the whole session view — and therefore the
  // (expensive) message list. See CLAUDE.md §11 / §14.
  // Fork = branch into native Claude OR import this history into a fresh Codex
  // thread. The source stays live in both cases (§14.94).
  const [forkModalOpen, setForkModalOpen] = useState(false);
  const [forking, setForking] = useState<AgentKind | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [rewindOpen, setRewindOpen] = useState(false);
  const [goalEditorOpen, setGoalEditorOpen] = useState(false);
  // A question beside the conversation (§14.119): the row and its answer
  // arrive as frames; a refusal puts the text back in the box (the caller).
  const [asideError, setAsideError] = useState<string | null>(null);
  const askAside = useCallback(async (question: string) => {
    setAsideError(null);
    try { await api.askSideQuestion(sessionId, question); }
    catch (e) { setAsideError(e instanceof Error ? e.message : String(e)); throw e; }
  }, [sessionId]);
  const [rewinding, setRewinding] = useState(false);
  const [rewindError, setRewindError] = useState<string | null>(null);
  const doCompact = useCallback(async () => {
    if (compacting || !compactAllowed) return;
    setCompacting(true);
    setCompactError(null);
    // Codex compact() resolves after the operation. Claude queues /compact
    // and refreshes again on thinking→active, so this immediate read is both
    // useful for Codex and harmless for Claude.
    const r = await outcome(postCompact(sessionId).then(() => refreshContext()));
    if (!r.ok) setCompactError(r.message);
    setCompacting(false);
  }, [compacting, compactAllowed, refreshContext, sessionId]);
  const doRewind = useCallback(async (messageId: string) => {
    if (rewinding || status === 'thinking') return;
    setRewinding(true); setRewindError(null);
    const r = await outcome(postRollback(sessionId, messageId));
    if (!r.ok) { setRewindError(r.message); setRewinding(false); return; }
    // The local hook intentionally never deletes historical rows during an
    // SSE stream. Reload once after this explicit destructive action so its
    // cache is rebuilt from the now-rewound SQLite transcript.
    window.location.reload();
  }, [rewinding, sessionId, status]);
  // The recap under the last answer (§14.122): shown only while the row it
  // follows is still the conversation's last word and nothing is running.
  const recap = selected.recap ?? null;
  const shownRecap = useMemo(
    () => recapToShow(recap, messages, status === 'thinking' || status === 'starting' || !!currentAssistant),
    [recap, messages, status, currentAssistant],
  );
  // ── Charon's own `/` commands (lib/slashCommands.ts) ──────────────────────
  // The note under the composer says why one did nothing; its text then stays
  // in the box (the handler answers false).
  // `ok` = a confirmation (it fades), not a refusal.
  const [slashNote, setSlashNote] = useState<{ text: string; ok?: boolean } | null>(null);
  useEffect(() => {
    if (!slashNote?.ok) return;
    const t = setTimeout(() => setSlashNote(null), 4000);
    return () => clearTimeout(t);
  }, [slashNote]);
  const [runtimeOpen, setRuntimeOpen] = useState<{ which: 'model' | 'effort'; nonce: number } | null>(null);
  const openRuntimePicker = useCallback((which: 'model' | 'effort') => {
    setBarExpanded(true);   // the phone's folded header hides the pickers
    setRuntimeOpen({ which, nonce: Date.now() });
  }, []);
  // `/diff`, `/mcp`: the Tools panel on that tab (a one-shot request).
  const [toolTabRequest, setToolTabRequest] = useState<'git' | 'calls' | null>(null);
  const clearToolTabRequest = useCallback(() => setToolTabRequest(null), []);
  const runSlash = useStableCallback(async (action: SlashAction, arg: string): Promise<boolean> => {
    setSlashNote(null);
    const refuse = (why: string) => { setSlashNote({ text: why }); return false; };
    const inform = (what: string) => { setSlashNote({ text: what, ok: true }); return true; };
    const live = ['active', 'failed', 'background'].includes(status ?? '');
    const cwd = selected.cwd ?? '';
    const run = async (): Promise<boolean> => {
      switch (action) {
        case 'model':
          if (!arg) { openRuntimePicker('model'); return true; }
          await setModel(arg, supportsSessionCapability(sessionKind, 'fallbackModel') ? fallbackModel : null);
          return true;
        case 'effort': {
          if (!arg) { openRuntimePicker('effort'); return true; }
          const word = arg.toLowerCase();
          if (sessionKind === 'claude' && /^ultracode(\s+(on|off))?$/.test(word)) {
            await setUltracode(!word.endsWith('off'));
            return true;
          }
          if (sessionKind === 'claude' && /^fast(\s+(on|off))?$/.test(word)) {
            await setFastMode(!word.endsWith('off'));
            return true;
          }
          if (sessionKind === 'codex' && /^(standard|fast|ultrafast)$/.test(word)) {
            await setServiceTier(word === 'standard' ? 'default' : word === 'fast' ? 'priority' : word);
            return true;
          }
          if (!isSessionEffort(sessionKind, word)) {
            openRuntimePicker('effort');
            return refuse(`/effort: "${arg}" is not a level this session knows — pick one above.`);
          }
          await setEffort(word);
          return true;
        }
        case 'rename':
          if (!arg) return refuse('/rename: write the new name after it.');
          await api.renameAgentSession(sessionId, arg.slice(0, 200));
          return true;
        case 'clear':
          if (!onNewSessionIn || !vpsId || !selected.cwd) return refuse('/clear: no new session can be opened from here.');
          onNewSessionIn(vpsId, selected.cwd);
          return true;
        case 'aside':
          if (!arg) return refuse('/btw: write the question after it.');
          if (!ASIDE_STATUSES.has(status ?? '')) return refuse('/btw: resume the session to ask it aside.');
          // A refusal is already shown by the aside's own note.
          try { await askAside(arg); } catch { return false; }
          return true;
        case 'rewind':
          if (!live) return refuse(status === 'thinking' || status === 'starting'
            ? '/rewind: wait for the turn to end.' : '/rewind: resume the session first.');
          setRewindError(null);
          setRewindOpen(true);
          return true;
        case 'compact':
          if (!compactAllowed) return refuse('/compact: the session must be awake and idle.');
          void doCompact();
          return true;
        case 'goal':
          if (!arg) { setGoalEditorOpen(true); return true; }
          await api.setSessionGoal(sessionId, arg);
          return true;
        case 'mode': {
          const modes = sessionModes(sessionKind);
          const key = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
          const want = key(arg);
          const exact = modes.find((m) => key(m) === want || key(MODE_SWITCH_META[m]?.label ?? '') === want);
          const prefix = want ? modes.filter((m) => key(m).startsWith(want) || key(MODE_SWITCH_META[m]?.label ?? '').startsWith(want)) : [];
          const mode = exact ?? (prefix.length === 1 ? prefix[0] : undefined);
          if (!mode) return refuse(`/mode: one of ${modes.join(', ')}.`);
          await setMode(mode);
          return true;
        }
        case 'review': {
          const words = arg.split(/\s+/).filter(Boolean);
          const target = !words.length ? { type: 'uncommittedChanges' }
            : /^(base|branch)$/i.test(words[0]!) && words[1] ? { type: 'baseBranch', branch: words[1] }
            : /^commit$/i.test(words[0]!) && words[1] ? { type: 'commit', sha: words[1] }
            : null;
          if (!target) return refuse('/review: nothing, `base <branch>` or `commit <sha>`.');
          const r = await fetch(`/api/sessions/${sessionId}/review`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target, delivery: 'inline' }),
          });
          const j = await r.json().catch(() => null);
          if (!r.ok || !j?.ok) return refuse(`/review: ${j?.error || 'the review did not start'}`);
          return true;
        }
        case 'fork':
          if (!selected.nativeSessionId) return refuse('/fork: send a message before forking.');
          setForkError(null);
          setForkModalOpen(true);
          return true;
        case 'export': {
          const a = document.createElement('a');
          a.href = `/api/sessions/${sessionId}/export`;
          a.download = '';
          document.body.appendChild(a);
          a.click();
          a.remove();
          return true;
        }
        case 'shell':
          if (!onNewShellIn || !vpsId || !cwd) return refuse('/shell: no terminal can be opened from here.');
          onNewShellIn(vpsId, cwd);
          return true;
        case 'diff':
        case 'mcp':
          setToolTabRequest(action === 'diff' ? 'git' : 'calls');
          onOpenTools?.(action === 'diff' ? 'git' : 'calls');
          return true;
        case 'memory': {
          const file = PROVIDERS[sessionKind].instructionsFile;
          if (!vpsId || !cwd) return refuse('/memory: this session has no folder.');
          try { await api.fsReadRange(vpsId, cwd, file, 0, 1); }
          catch { return refuse(`/memory: this folder has no ${file} yet.`); }
          if (fileLinks) {
            const target = { vpsId, root: cwd, path: file };
            const url = fileLinks.hrefFor(target);
            if (url) window.open(url, '_blank', 'noopener'); else fileLinks.onUnavailable?.(target);
            return true;
          }
          await openWorkspaceTab({ vpsId, path: cwd, kind: 'file', ref: file, pin: true });
          return true;
        }
        case 'copy': {
          const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim()
            && m.assistantFinal !== 0) ?? [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
          if (!last) return refuse('/copy: no answer yet.');
          await navigator.clipboard.writeText(last.content);
          return inform('Copied the last answer.');
        }
        case 'retry': {
          const last = [...messages].reverse().find((m) => m.role === 'user' && m.content.trim());
          if (!last) return refuse('/retry: no message to send again.');
          await streamSend(last.content);
          return true;
        }
        case 'sleep':
          await doSleep();
          return true;
        case 'stop':
          await forceStop();
          return true;
        case 'routine':
          if (!onNewRoutine || !vpsId || !cwd) return refuse('/routine: this session has no folder.');
          onNewRoutine({ vpsId, cwd, kind: sessionKind, prompt: arg });
          return true;
      }
      return false;
    };
    const r = await outcome(run());
    return r.ok ? r.value : refuse(`/${action === 'aside' ? 'btw' : action}: ${r.message}`);
  });
  const doFork = useCallback(async (targetKind: AgentKind, options?: {
    lastTurnId?: string; cutoffMessageId?: number; replacementPrompt?: string; targetProfile?: string;
  }) => {
    if (forking) return;
    setForking(targetKind);
    setForkError(null);
    const r = await outcome(postFork(sessionId, targetKind, options));
    if (r.ok) {
      const branch = r.value;
      // The branch inherits the source's notification rules. The Telegram half
      // came across with the fork itself; this one is localStorage, so only
      // this device can carry it — fire-and-forget, since a push-sync hiccup
      // must not turn a successful fork into an error.
      void copySessionNotifications(sessionId, branch.id).catch(() => {});
      // Open the branch straight away: the point of forking is to work in it.
      // Creating, not browsing — so hand over the row we just got back and PIN
      // it (§14.78). Looking the id up in `sessions` would lose the race with
      // the list refresh and land on a pane the tab bar does not list.
      setForkError(null);
      setForkModalOpen(false);
      onOpenSession?.(branch.id, { vpsId: branch.vpsId, cwd: branch.cwd ?? '' }, true);
    } else {
      setForkError(r.message);
    }
    setForking(null);
  }, [forking, sessionId, onOpenSession]);

  const [errorOpen, setErrorOpen] = useState(false);
  const [errorCopied, setErrorCopied] = useState(false);

  // Shown only once a sync has lasted a beat: on a good link the fresh answer
  // lands first and the cue never flashes. Mounted late rather than faded in
  // late — an invisible row would still nudge the transcript twice.
  const [showSyncing, setShowSyncing] = useState(false);
  useEffect(() => {
    if (!isSyncing) { setShowSyncing(false); return; }
    const timer = setTimeout(() => setShowSyncing(true), SYNC_CUE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isSyncing]);

  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const peerReplies = useMemo(() => peerAssistantReplies(messages), [messages]);
  const { hoverRequest, jumpToRequest, isJumping: isPeerJumping } = usePeerMessageNavigation(chatBodyRef, {
    messages, hasMore, isLoadingMore, historyReady, loadMoreHistory, setHistoryHold,
  });
  const { jumpToRequest: jumpToQuestion, isJumping: isQuestionJumping } = usePeerMessageNavigation(chatBodyRef, {
    messages, hasMore, isLoadingMore, historyReady, loadMoreHistory, setHistoryHold,
  }, { targetAttribute: 'data-question-id', flashClass: 'question-flash', focus: true });
  // The live assistant text: its own `__streaming` bubble, or the persisted
  // row an `assistant_reopened` extends (drawn in place, no second bubble).
  const liveMessage = useMemo(
    () => liveStreamingMessage(messages, { assistant: currentAssistant, streamingInto, thinkingOpen: '' }),
    [messages, currentAssistant, streamingInto],
  );
  const pendingAsyncQuestions = useMemo(() => questionQueue.filter((q) => q.delivery === 'async')
    .sort((a, b) => a.createdAt - b.createdAt), [questionQueue]);
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // At the live end, a transcript grown by older pages or a long run is
  // re-windowed (useSessionStream § trimHistory); scrolling up re-fetches.
  useEffect(() => {
    if (!isAtBottom) return;
    const t = window.setInterval(trimHistory, TRIM_CHECK_MS);
    return () => window.clearInterval(t);
  }, [isAtBottom, trimHistory]);
  const [newCount, setNewCount] = useState(0);
  const lastMessageCountRef = useRef(0);

  // Import-error detection → parent callback to open an install session.
  // The "No module named claude_agent_sdk" error message comes from the
  // Python SDK that cannot load the module — the agent is probably
  // installed but the pip dependency is missing.
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
  // Pair tool_use ↔ tool_result for inline rendering.
  const renderable = useMemo(() => pairToolResults(messages), [messages]);

  // What the provider has not read yet waits beside the composer, not in the
  // conversation (lib/waitingInputs.ts): it enters where it is read.
  const pendingSet = useMemo(() => new Set(pending.map((p) => p.id)), [pending]);
  const visibleRenderable = useMemo(
    () => renderable.filter(({ msg }) => !pendingSet.has(msg.id)
      && (showTools || shouldShowChatRole(msg.role, false))),
    [renderable, showTools, pendingSet],
  );
  const pendingItems = useMemo<PendingItem[]>(() => {
    if (!pending.length) return [];
    const byId = new Map(messages.map((m, i) => [m.id, [m, i] as const]));
    const heldBy = new Map(held.map((h) => [rowKey(h.rowId), h] as const));
    const waitingBy = new Map(waiting.map((w) => [rowKey(w.rowId), w] as const));
    const out: Array<PendingItem & { at: number }> = [];
    for (const { id, key } of pending) {
      const hit = byId.get(id);
      if (!hit) continue;
      const h = heldBy.get(id);
      const w = waitingBy.get(id);
      out.push({
        id, key, at: hit[1], content: hit[0].content,
        state: h ? 'held' : w ? 'waiting' : 'sending',
        error: h?.error ?? null,
        since: w?.since,
        sendNowId: w?.sendNow ? w.clientMessageId : null,
      });
    }
    // Send order: their place in the transcript they were appended to.
    return out.sort((a, b) => a.at - b.at);
  }, [pending, messages, held, waiting]);
  // The oldest one that can be read now (Ctrl/⌘+⇧+↵ on an empty composer).
  const nowFirst = pendingItems.find((p) => p.sendNowId)?.sendNowId ?? null;
  const sendFirstNow = useCallback((): boolean => {
    if (!nowFirst) return false;
    void sendNow(nowFirst);
    return true;
  }, [nowFirst, sendNow]);
  // A message read leaves the tray and rises into the chat where it lands.
  const pendingPrev = useRef<Set<string>>(pendingSet);
  useEffect(() => {
    const gone = [...pendingPrev.current].filter((id) => !pendingSet.has(id));
    pendingPrev.current = pendingSet;
    const root = chatBodyRef.current;
    if (!gone.length || !root) return;
    requestAnimationFrame(() => {
      for (const id of gone) {
        const el = root.querySelector<HTMLElement>(`[data-fold-key="${CSS.escape(id)}"]`);
        if (!el) continue;
        el.classList.add('just-read');
        el.addEventListener('animationend', () => el.classList.remove('just-read'), { once: true });
      }
    });
  }, [pendingSet]);

  // ── "Continue" affordance for a turn the transport cut (§14.68) ───────────
  // The CLI closes such a turn with a synthetic assistant bubble ("API Error:
  // Connection closed mid-response…"); the one-word fix is to send "Continue".
  // We offer it on the LAST VISIBLE message only: further down the history the
  // interruption was already handled (a user bubble follows), and a row of
  // dead buttons up the scrollback is noise. Side-channel rows (event /
  // edit_snapshot) render as null, so they must be skipped when looking for
  // "the last thing the user sees" — otherwise a trailing edit_snapshot would
  // hide the CTA. Gated on the turn being over: while it's thinking, Continue
  // would just queue a redundant prompt.
  const continuableMsgId = useMemo(() => {
    if (status === 'thinking' || status === 'starting' || currentAssistant) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'event' || m.role === 'edit_snapshot') continue;
      if (m.role === 'assistant' && isTurnInterrupted(m.content, m.model)) return m.id;
      if (m.role === 'error' && parseSessionError(m.content)?.action === 'continue') return m.id;
      return null;
    }
    return null;
  }, [messages, status, currentAssistant]);

  const schedulableMsgId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'event' || m.role === 'edit_snapshot') continue;
      const parsed = m.role === 'error' ? parseSessionError(m.content) : null;
      return parsed?.kind === 'rate_limit' && resolveResetAtMs(parsed.resetAt, parsed.message) ? m.id : null;
    }
    return null;
  }, [messages]);

  // The newest chat row is a usage-limit error: offer the provider's other
  // hub accounts (§14.115) — switch, then "Continue" on that account.
  const limitMsgId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'event' || m.role === 'edit_snapshot') continue;
      return m.role === 'error' && parseSessionError(m.content)?.kind === 'rate_limit' ? m.id : null;
    }
    return null;
  }, [messages]);
  // The newest chat row is an auth-expiry error (§14.65): it alone carries the
  // remedy (sign in, Continue, or another account), and not while a turn
  // runs — an older one was dealt with by whatever came after it.
  const authMsgId = useMemo(() => {
    if (status === 'thinking' || status === 'starting' || currentAssistant) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'event' || m.role === 'edit_snapshot') continue;
      if (m.role === 'assistant') return sessionKind === 'claude' && isClaudeAuthExpired(m.content) ? m.id : null;
      return m.role === 'error' && parseSessionError(m.content)?.action === 'sign_in' ? m.id : null;
    }
    return null;
  }, [messages, status, currentAssistant, sessionKind]);
  // The finish on screen (§14.47): while the session's finish is unread — it
  // stays so until the user acts on the session, leaves it or sends — the
  // turn's final answer wears the sidebar card's pulse, red when the turn
  // failed (then an error row may be that answer). A turn that ended on its
  // compaction (the button, `/compact`) has the marker as its answer: never
  // the answer above it, which belongs to an earlier turn. Nothing past the
  // turn's input: a turn that ended without a final answer lights no older one.
  const finishAttention = attentionForRow(selected);
  const finishCue = finishAttention === 'unread' || finishAttention === 'error' ? finishAttention : null;
  const finishMsgId = useMemo(() => {
    if (!finishCue) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' || m.role === 'external' || m.role === 'scheduled_fire') return null;
      if (m.role === 'assistant' && m.assistantFinal !== 0) return m.id;
      if (m.role === 'compaction') return m.id;
      if (finishCue === 'error' && m.role === 'error') return m.id;
    }
    return null;
  }, [messages, finishCue]);
  // ANY action in the open session reads it, the same ack as leaving: a
  // click anywhere in it (link, button, scroll pill, composer, scrollbar), a
  // key, a wheel scroll — `<main>`'s capture handlers, which also see its
  // portalled menus. Hovering is no action. Optimistic (a summary overlay,
  // §14.32): the cue goes at once, a failure brings it back; the overlay
  // zeroes `unreadStop`, which unplugs the handlers until the next finish.
  const markFinishRead = useCallback(() => {
    const o = addOverlay(sessionId, { unreadStop: 0 });
    api.markSessionRead(sessionId).then((r) => o.ack(r?.sync), () => o.fail());
  }, [sessionId]);
  const readOnAction = selected.unreadStop ? markFinishRead : undefined;
  const currentAccount = accountProfileId(selected);
  // The usage popovers offer the provider's other accounts (§14.115); a turn
  // in flight, or background tasks the restart would kill with the CLI
  // (§14.91), make the switch wait.
  const bgRunning = selected.runningBgTasks ?? 0;
  const accountSwitch = useMemo((): AccountSwitchTarget => ({
    sessionId, current: currentAccount,
    waitFor: status === 'thinking' || status === 'starting' ? { kind: 'turn' }
      : status === 'background' || bgRunning > 0 ? { kind: 'background', tasks: bgRunning }
      : null,
  }), [sessionId, currentAccount, status, bgRunning]);
  const continueWithAccount = useCallback(async (accountId: string) => {
    await api.switchSessionAccount(sessionId, accountId);
    void streamSend('Continue');
  }, [sessionId, streamSend]);

  // Stable ref (memo(Message), §14.38). `send` is optimistic, so the user
  // bubble appears at once and `continuableMsgId` goes null on the next render.
  const sendContinue = useCallback(() => { void streamSend('Continue'); }, [streamSend]);
  const scheduleResume = useCallback(async (messageId: string) => {
    const sourceMessageId = Number(messageId.replace(/^m/, ''));
    if (!Number.isSafeInteger(sourceMessageId)) throw new Error('invalid rate-limit message');
    const res = await fetch(`/api/sessions/${sessionId}/scheduled-resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceMessageId }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'could not schedule resume');
  }, [sessionId]);
  const cancelScheduledResume = useCallback(async (scheduleId: string) => {
    const res = await fetch(`/api/sessions/${sessionId}/scheduled-resume`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduleId }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'could not cancel resume');
  }, [sessionId]);
  const revertAndRefresh = useCallback(() => { onAfterRevert?.(); }, [onAfterRevert]);

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
    for (const q of questionQueue) if (q.delivery !== 'async') items.push({ kind: 'question', createdAt: q.createdAt, q });
    for (const ep of exitPlanQueue) items.push({ kind: 'exit_plan', createdAt: ep.createdAt, ep });
    if (!items.length) return null;
    items.sort((a, b) => a.createdAt - b.createdAt);
    return items[0];
  }, [permQueue, questionQueue, exitPlanQueue]);

  const turnStartedAt = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].createdAt;
    }
    return null;
  }, [messages]);

  // Fallback of the ThinkingBar's line when the hub has no live activity
  // (a hub restart mid-turn): the most recent UNRESOLVED tool, but only
  // if it belongs to the CURRENT turn. The turn guard (startedAt >= the last
  // user message) stops a tool left unresolved by a past turn — an interrupted
  // turn, or the transient gap before a refetch re-pairs results — from
  // flashing as "running" the instant a new turn merely starts thinking.
  // See CLAUDE.md §14 gotcha 39.
  const currentTool = useMemo(() => {
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      const c = toolCalls[i];
      if (c.result) continue;
      if (turnStartedAt !== null && c.startedAt < turnStartedAt) return null;
      return c;
    }
    return null;
  }, [toolCalls, turnStartedAt]);

  // What the ThinkingBar says the turn is doing (§14.124), tools shown or
  // not: a blocking gate first (the turn waits for the user), then the hub's
  // live activity, then the fallback tool.
  const liveLine = useMemo<LiveLine | null>(() => {
    const p = oldestPending;
    if (p?.kind === 'permission') return describeGate({ kind: 'permission', tool: p.perm.tool, input: p.perm.input, createdAt: p.createdAt });
    if (p?.kind === 'question') return describeGate({ kind: 'question', question: p.q.questions[0]?.question, createdAt: p.createdAt });
    if (p?.kind === 'exit_plan') return describeGate({ kind: 'exit_plan', createdAt: p.createdAt });
    const name = providerName(sessionKind);
    if (liveActivity) return describeLive(liveActivity, name);
    if (!currentTool) return null;
    const since = currentTool.startedAt * 1000;
    return describeLive({
      beat: 'tool', since,
      tool: { id: currentTool.id, name: currentTool.name, detail: toolDetail(currentTool.name, currentTool.input), since },
    }, name);
  }, [oldestPending, liveActivity, currentTool, sessionKind]);

  // ── Scroll mechanics (column-reverse, |scrollTop| ≈ 0 = visual bottom) ───
  // In column-reverse:
  //   scrollTop ≈ 0           → visually at the bottom (newest message)
  //   |scrollTop| ≈ scrollHeight - clientHeight → visually at the top (oldest)
  // So distance from VISUAL TOP = scrollHeight - clientHeight - |scrollTop|.
  // loadMore threshold: ~one screenful before the end, so the fetch is already
  // in flight by the time the user gets there. It used to be 400px, which a
  // wheel flick crosses in a single frame: the reader hit the actual top and
  // sat there waiting for the round trip, which is most of what "scrolling
  // back is hard work" was.
  // `isAtTop` = at the ABSOLUTE top (used to decide whether the ↑ button
  // should disappear; it stays as long as there's something to scroll back up to).
  const [isAtTop, setIsAtTop] = useState(false);
  // Top-center "⤒ message start" pill: shown when the NEWEST chat bubble is an
  // assistant message (typically the long end-of-turn recap) whose TOP is
  // scrolled out of view above — i.e. the user is inside/below a long final
  // message and wants to jump back to its beginning.
  const [showJumpToMsgStart, setShowJumpToMsgStart] = useState(false);
  const measureChatScroll = useCallback(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const atBottom = Math.abs(el.scrollTop) < 80;
    if (atBottom !== isAtBottomRef.current) {
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
    }
    if (atBottom) setNewCount(0);
    // Scrolled away from the bottom = the user is reading back through the
    // transcript. Hold the poll's clean full reload until they return, or it
    // discards the paginated pages mid-read (CLAUDE.md §14 gotcha 24).
    setHistoryHold(!atBottom || isPeerJumping || isQuestionJumping);
    // Near-top detect → loadMore. The hook guards against concurrent calls
    // and hasMore=false. The browser does scroll anchoring natively when
    // we append to the end of the DOM (= visual top in column-reverse),
    // so the position is preserved without manually fiddling with scrollTop.
    const max = el.scrollHeight - el.clientHeight;
    const distFromTop = max - Math.abs(el.scrollTop);
    // One screenful of lead time, so a wheel flick doesn't outrun the fetch.
    const loadAhead = Math.max(400, el.clientHeight);
    // `max > 0` guard: when the content is shorter than the container there is
    // nothing to scroll, distFromTop is 0, and this would otherwise paginate
    // the whole history in a loop on every commit.
    if (max > 0 && distFromTop < loadAhead && hasMore && !isLoadingMore) {
      loadMoreHistory();
    }
    setIsAtTop(max <= 0 || distFromTop < 4);
    // Jump-to-message-start pill visibility. In column-reverse the FIRST
    // [data-msg-role] element in DOM order is the newest user/assistant
    // bubble (tool/thinking cards don't carry the attribute — irrelevant
    // here). Show only when that bubble is an assistant one AND its top sits
    // >4px above the visible top (start of the message out of view). Cheap:
    // querySelector stops at the first match, which is near the DOM start.
    const newest = el.querySelector<HTMLElement>('[data-msg-role]');
    let jumpable = false;
    if (newest && newest.dataset.msgRole === 'assistant') {
      const gap = el.getBoundingClientRect().top - newest.getBoundingClientRect().top;
      jumpable = gap > 4;
    }
    setShowJumpToMsgStart(jumpable);
  }, [hasMore, isLoadingMore, loadMoreHistory, setHistoryHold, isPeerJumping, isQuestionJumping]);
  // rAF-coalesced scroll handler. The measurement above reads scrollHeight /
  // clientHeight and two getBoundingClientRect — each one forces a synchronous
  // layout, and with `content-visibility: auto` on every bubble that layout has
  // to materialize the sizes of the nodes coming into view. Running it on every
  // wheel event (which browsers fire far faster than they paint) made scrolling
  // back through a long transcript visibly stutter. One measurement per frame
  // is all the pills and the loadMore trigger can act on anyway.
  const scrollRafRef = useRef<number | null>(null);
  const handleChatScroll = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      measureChatScroll();
    });
  }, [measureChatScroll]);
  useEffect(() => () => {
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
  }, []);
  // Recompute isAtTop when the content changes (new messages → max moves).
  useEffect(() => { handleChatScroll(); }, [visibleRenderable.length, handleChatScroll]);
  const onPillClick = useCallback(() => {
    setNewCount(0);
    const el = chatBodyRef.current;
    if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // ── Scroll-up, message by message ─────────────────────────────────────
  // TWO up buttons stacked above the ↓ pill, one per role, so the user can
  // walk back through EITHER side of the conversation:
  //   green (top, double chevron) → previous USER message  = "previous turn"
  //   blue  (middle, single)      → previous AGENT message = the agent's own
  //                                 replies, incl. the intermediate bubbles a
  //                                 single turn flushes around tool calls.
  // Same mechanics for both: jump to the closest bubble of that role whose top
  // sits ABOVE the visible area; repeated clicks keep walking up. If there is
  // no such bubble left but history remains, paginate instead (a later click
  // continues into the freshly-loaded rows); at the very top with nothing left
  // to load, jump to the visual top.
  //
  // We use scrollIntoView({block:'start'}) which aligns the top of the
  // element with the top of the container IN SCREEN COORDS, independently
  // of the sign of scrollTop (Chrome negative, Firefox positive in column-reverse).
  // Roles come from Message.tsx's `data-msg-role` — only the rendered chat
  // bubbles carry it (tool/thinking cards don't), which is exactly the set
  // worth stopping on.
  const scrollUpToRole = useCallback((role: 'user' | 'assistant') => {
    const el = chatBodyRef.current;
    if (!el) return;
    const target = chatBubbleAbove(el, role);
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (hasMore && !isLoadingMore) {
      // No more message of that role above, but there's still history left:
      // paginate. Once the older messages are loaded, the user can click
      // again to keep scrolling up.
      loadMoreHistory();
    } else {
      // Visual top reached: align the last DOM child (= visually at the
      // very top in column-reverse) with the top of the container.
      const last = el.lastElementChild as HTMLElement | null;
      if (last) last.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [hasMore, isLoadingMore, loadMoreHistory]);
  const onScrollUpUserClick = useCallback(() => scrollUpToRole('user'), [scrollUpToRole]);
  const onScrollUpAgentClick = useCallback(() => scrollUpToRole('assistant'), [scrollUpToRole]);

  // The ↑ buttons stay visible as long as there's something to scroll up to:
  //   - not at the ABSOLUTE visual top, OR
  //   - there's still history left to paginate (hasMore || isLoadingMore).
  const showScrollUpButton = !isAtTop || hasMore || isLoadingMore;

  // ── Jump to the start of the last (assistant) message ─────────────────
  // Fast deterministic scroll (~240ms ease-out) instead of native
  // scrollIntoView({behavior:'smooth'}): a long recap means a multi-thousand-px
  // hop, and native smooth is slow/inconsistent across browsers for that.
  // Absolute scrollTop math is sign-agnostic (Chrome AND Firefox use negative
  // scrollTop in column-reverse; the delta is continuous either way), and
  // appended older pages (visual top = DOM end) don't shift existing
  // coordinates, so the animation stays stable even if loadMore fires.
  const onJumpToMsgStart = useCallback(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const bubble = el.querySelector<HTMLElement>('[data-msg-role="assistant"]');
    if (!bubble) return;
    const start = el.scrollTop;
    // Land with the bubble's top 8px below the container top (breathing room;
    // also puts the post-jump gap at -8 < 4 → the pill auto-hides).
    const delta = bubble.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    if (Math.abs(delta) < 2) return;
    const t0 = performance.now();
    const DURATION = 240;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / DURATION);
      const ease = 1 - Math.pow(1 - p, 3); // ease-out cubic
      el.scrollTop = start + delta * ease;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, []);

  // Count new VISIBLE messages when the user is NOT at the bottom, for the ↓ N
  // pill. Hidden tool/reasoning rows must not advertise a message the reader
  // cannot reach. Toggling the preference only changes the baseline; it is not
  // new activity.
  const previousShowToolsRef = useRef(showTools);
  useEffect(() => {
    const prev = lastMessageCountRef.current;
    const cur = visibleRenderable.length;
    if (previousShowToolsRef.current !== showTools) {
      previousShowToolsRef.current = showTools;
      lastMessageCountRef.current = cur;
      setNewCount(0);
      return;
    }
    if (cur > prev && !isAtBottomRef.current) {
      setNewCount((c) => c + (cur - prev));
    }
    lastMessageCountRef.current = cur;
  }, [visibleRenderable.length, showTools]);

  // ── Action wrappers (just handle local UI around the hook) ────────────────
  // The "pause" button in the header used to be a false friend: it called
  // `kill` which put the session in a non-resumable `'killed'` state. The
  // rework removed this middle state. Permanent deletion now happens via
  // the sidebar context menu (right-click → "Delete permanently"),
  // not from this area. See CLAUDE.md §11 and §14.

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
    <ContextWindowContext.Provider value={contextWindowTokens}>
      {sessionSettingsOpen && <SessionSettingsModal session={selected} onClose={closeSessionSettings} />}
      <main className={`app-main${compact ? ' is-compact' : ''}`}
        onPointerDownCapture={readOnAction} onKeyDownCapture={readOnAction} onWheelCapture={readOnAction}>
        <div className={`app-bar${barExpanded || compact ? ' is-expanded' : ''}`}>
          <div className="session-header-layout">
          {/* Session identity: title, then cwd. The path is the fastest
              "where am I?" cue when several sessions share a name (or have
              none). Context occupancy used to be this block's third line; it
              belongs to the MODEL, so it now closes the runtime panel. */}
          <div className="bar-ident">
            {/* `display: contents` on desktop; the phone's one-line title. */}
            <span className="bar-title">
            <span className="bar-name">{selected.name || '(unnamed)'}</span>
            {/* `@parent › @handle ↻`: one row under the name on desktop,
                `display: contents` in the phone's title line. */}
            {(handle || parentSessionId || runtimeOutdated) && (
              <span className="bar-handle-line">
                {parentSessionId && onOpenSession && (
                  <ParentChip parentId={parentSessionId} onOpen={onOpenSession} beforeHandle={!!handle} />
                )}
                {/* The addressing form of the same identity. Shown next to the
                    name because it is what ANOTHER agent on this machine types to
                    reach this session — knowing it requires seeing it. */}
                {handle && (
                  <span
                    className="bar-handle"
                    title={`Stable Charon address on ${selectedVps?.name ?? 'this machine'} (${selected.addressable ? 'currently reachable' : 'not currently reachable'})`}
                  >@{handle}</span>
                )}
                {/* The agent was updated under this session (§14.117): it still
                    runs the previous versions, and moves itself to the new ones
                    the next time it is idle. Nothing to do: a sign, the versions
                    in its tooltip. */}
                {runtimeOutdated && (
                  <span className="bar-outdated" role="img" aria-label="Agent update pending"
                    title={[...pendingUpdateRows(runtimeVersions, selectedVps),
                      'Applied by itself the next time this session is idle'].join('\n')}
                  ><IconArrowRepeat /></span>
                )}
              </span>
            )}
            {/* Phone only: its hit area spans the whole title line. */}
            <button type="button" className="bar-expand" aria-expanded={barExpanded}
              aria-label={barExpanded ? 'Hide session details' : 'Show session details'}
              title={barExpanded ? 'Hide session details' : 'Show session details'}
              onClick={() => setBarExpanded((v) => !v)}>
              <span aria-hidden>▾</span>
            </button>
            </span>
            {selected.cwd && (
              <span className="bar-sub">
                <CwdSubtitle cwd={selected.cwd} vpsName={selectedVps?.name} />
                {onNewAgentHere && (
                  <button type="button" className="bar-new-agent" onClick={onNewAgentHere}
                    aria-label="New agent or shell in this folder" title="New agent or shell in this folder">
                    ＋ agent
                  </button>
                )}
              </span>
            )}
            {/* The phone's account usage (CSS-gated ≤820px, where the runtime
                panel drops its usage cell). A custom endpoint bills per token
                instead, and the runtime panel already shows those. */}
            {!endpoint.active && <LiveUsageRings vpsId={vpsId} profile={usageProfile} vpsName={selectedVps?.name}
              onRefresh={onUsageRefresh} kind={sessionKind} accountLabel={usageAccountLabel} switchTarget={accountSwitch} />}
          </div>
          <SessionRuntimePanel
            tokenUsage={tokenUsage} vpsName={selectedVps?.name} onUsageRefresh={onUsageRefresh}
            usageAccountLabel={usageAccountLabel} accountSwitch={accountSwitch}
            kind={sessionKind} accountProfile={usageProfile} profileNumber={profileNumber} vpsId={vpsId} sessionId={sessionId} endpoint={endpoint} onEndpointChanged={refreshEndpoint}
            model={model} fallbackModel={fallbackModel} effort={effort}
            ultracode={ultracode} onSetUltracode={sessionKind === 'claude' ? setUltracode : undefined}
            fastMode={fastMode} fastModeVerdict={fastModeVerdict} onSetFastMode={sessionKind === 'claude' ? setFastMode : undefined}
            serviceTier={serviceTier} onSetServiceTier={sessionKind === 'codex' ? setServiceTier : undefined}
            modelPendingApply={modelPendingApply} effortPendingApply={effortPendingApply}
            effectiveModel={effectiveModel}
            onSetModel={setModel} onSetEffort={setEffort}
            onApplyNow={doRestart}
            openRequest={runtimeOpen}
            context={supportsSessionCapability(sessionKind, 'contextUsage') || supportsSessionCapability(sessionKind, 'compact') ? (
              <HeaderContextGauge
                context={endpoint.active && !endpoint.active.checks?.[sessionKind as 'claude' | 'codex']?.contextWindow ? null : sessionContext}
                loading={contextLoading}
                cache={promptCache}
                onCompact={supportsSessionCapability(sessionKind, 'compact') ? doCompact : null}
                compacting={compacting || liveCompacting}
                compactDisabled={!compactAllowed}
                compactError={compactError}
              />
            ) : null}
          />

          <div className="session-header-controls">
            {/* `is-primary` = the one action the phone's folded row keeps:
                resume while stopped, else stop. */}
            <div className="session-header-actions" role="group" aria-label="Session actions">
              {status === 'sleeping' || status === 'error' ? (
                <button type="button" className="session-action is-primary" onClick={() => doResume()} aria-label="Resume session" title="Resume session"><IconPlay /></button>
              ) : (
                <button type="button" className="session-action" onClick={doSleep} aria-label="Sleep session" title="Sleep session"><IconPause /></button>
              )}
              <button type="button" className={`session-action session-action-stop${status === 'sleeping' || status === 'error' ? '' : ' is-primary'}`} onClick={forceStop}
                disabled={!['thinking', 'active', 'starting', 'failed', 'background'].includes(status ?? '')}
                aria-label="Stop session" title="Force stop — the session can be resumed"><IconStop /></button>
              <button type="button" className="session-action"
                onClick={() => { setForkError(null); setForkModalOpen(true); }}
                disabled={!!forking || !selected.nativeSessionId}
                aria-label="Fork session" aria-busy={!!forking}
                title={selected.nativeSessionId ? 'Fork conversation' : 'Send a message before forking'}>
                <IconGitBranch />
              </button>
              {/* Rewind must be capability-gated before invoking its native
                  history transport (§14.102). */}
              {supportsSessionCapability(sessionKind, 'rewind') && (
                <button type="button" className="session-action"
                  onClick={() => { setRewindError(null); setRewindOpen(true); }}
                  disabled={rewinding || status === 'thinking' || status === 'starting' || status === 'sleeping' || status === 'error'}
                  aria-label="Rewind session" aria-busy={rewinding}
                  title={status === 'sleeping' || status === 'error' ? 'Resume the session before rewinding' : 'Rewind to an earlier turn'}><IconRewind /></button>
              )}
              {supportsSessionCapability(sessionKind, 'goal') && (
                <button type="button" className={`session-action${goalIsLive(shownGoal(selected.goal)) ? ' has-goal' : ''}`}
                  onClick={() => setGoalEditorOpen(true)}
                  aria-label="Session goal" title={goalIsLive(shownGoal(selected.goal)) ? 'Change the goal' : 'Set a goal the session keeps working toward'}><IconBullseye /></button>
              )}
              <button type="button" className="session-action session-settings-button" onClick={() => setSessionSettingsOpen(true)} aria-label="Session settings" title="Session settings"><IconGear /></button>
            </div>
          </div>
          </div>
        </div>

        {status === 'reconnecting' && (
          <div className="app-reconnect-banner">
            <span className="msg"><span className="spin">↻</span> auto-reconnecting…</span>
          </div>
        )}

        {(status === 'sleeping' || status === 'error') && (
          <div className="app-disconnect-banner-wrap">
            <div className="app-disconnect-banner" onClick={() => doResume()} role="button">
              <span className="msg">
                inactive session — click to reconnect
                {error?.msg ? <em className="why"> · {error.msg.split('\n')[0].slice(0, 160)}</em> : null}
              </span>
              <span className="resume-chip">↺ resume</span>
            </div>
            {error?.msg && (
              <div className="app-error-details">
                <div className="err-tools">
                  <button type="button" onClick={(e) => { e.stopPropagation(); setErrorOpen((v) => !v); }}>
                    {errorOpen ? '▾ hide details' : '▸ show details'}
                  </button>
                  <button type="button" className="copy-btn" onClick={(e) => { e.stopPropagation(); copyError(); }} title="copy the error">
                    {errorCopied ? '✓ copied' : '📋 copy'}
                  </button>
                  <button type="button" className="dismiss-btn" onClick={(e) => { e.stopPropagation(); clearError(); }} title="hide the error">✕</button>
                </div>
                {errorOpen && <pre className="err-pre">{error.msg}</pre>}
              </div>
            )}
          </div>
        )}

        {status !== 'sleeping' && status !== 'error' && error && (
          <div className="app-error">
            <span className="msg">{error.msg.split('\n')[0].slice(0, 200)}</span>
            <button type="button" className="copy-btn" onClick={copyError} title="copy the error">
              {errorCopied ? '✓' : '📋'}
            </button>
            <button onClick={clearError}>✕</button>
          </div>
        )}

        <div className="app-chat-wrap">
          <QuoteSelectionButton chatRef={chatBodyRef} onQuote={requestQuote} />
          <div className="app-chat" ref={chatBodyRef} onScroll={handleChatScroll}>
            {isLoadingHistory && messages.length === 0 ? (
              // Placeholder during the 1st refetch — differentiates "empty
              // session" from "history not yet loaded". Disappears as soon
              // as applyApiData has run (cache or fetch).
              <div className="app-history-loading" role="status" aria-live="polite">
                <span className="app-history-loading-spinner" aria-hidden />
                <span>loading history…</span>
              </div>
            ) : (
              <>
                {/* First DOM child = visual BOTTOM (column-reverse): the cue
                    sits exactly where the missing messages will land, so a
                    cached transcript never reads as a finished one. */}
                {showSyncing && (
                  <div className="app-sync-indicator" role="status" aria-live="polite"
                    title="What you see may be out of date — fetching the latest from the server">
                    <span className="app-history-loading-spinner" aria-hidden />
                    <span>checking for new messages…</span>
                  </div>
                )}
                {shownRecap && <RecapNote recap={shownRecap} />}
                {liveMessage?.id === '__streaming' && (
                  <Message m={{ ...liveMessage, model: effectiveModel }} streaming kind={sessionKind}
                    substitutedFor={substitute ? model : null}
                    peerReplyTo={peerReplies.streamingReplyTo} onPeerRequestHover={hoverRequest} onPeerRequestJump={jumpToRequest} />
                )}
                <MessageHistory
                  siblings={siblings} onOpenPeerSession={onOpenSession}
                  onPeerRequestHover={hoverRequest} onPeerRequestJump={jumpToRequest}
                  peerReplyToById={peerReplies.replyToById}
                  renderable={visibleRenderable}
                  liveRow={liveMessage?.id === '__streaming' ? null : liveMessage}
                  kind={sessionKind}
                  substitute={substitute} selectedModel={model}
                  vpsId={selected.vpsId}
                  cwd={selected.cwd}
                  onReauth={endpoint.active ? undefined : onReauth}
                  authMsgId={endpoint.active ? null : authMsgId}
                  continuableMsgId={continuableMsgId}
                  onContinue={sendContinue}
                  onScheduleResume={scheduleResume}
                  onCancelScheduledResume={cancelScheduledResume}
                  schedulableMsgId={schedulableMsgId}
                  limitMsgId={endpoint.active ? null : limitMsgId}
                  currentAccount={currentAccount}
                  onContinueWithAccount={continueWithAccount}
                  finishMsgId={finishMsgId} finishCue={finishCue}
                  // Conservative on purpose: `reconnecting` means we don't
                  // know yet, and a wrong "interrupted" is worse than a
                  // late one.
                  turnInFlight={status === 'thinking' || status === 'starting'
                    || status === 'reconnecting' || !!currentAssistant}
                />
                {/* "Loading older" / "start of history" indicator.
                    In column-reverse, the last DOM child renders visually at
                    the TOP of the chat — exactly where the user wants it. */}
                {(hasMore || isLoadingMore) && (
                  <div className="app-loadmore-indicator" role="status" aria-live="polite">
                    {isLoadingMore ? (
                      <><span className="app-history-loading-spinner" aria-hidden /> loading history…</>
                    ) : (
                      <button type="button" onClick={() => loadMoreHistory()}>↑ load older</button>
                    )}
                  </div>
                )}
                {!hasMore && !isLoadingMore && messages.length > 0 && (
                  <div className="app-history-start">— start of history —</div>
                )}
              </>
            )}
          </div>
          {/* Top-center pill: jump to the START of the last assistant message
              (the long end-of-turn recap). Only when the turn is over (not
              thinking/starting) and the message start is scrolled out of view. */}
          {showJumpToMsgStart && status !== 'thinking' && status !== 'starting' && (
            <button
              type="button"
              className="app-jump-msg-start-pill"
              onClick={onJumpToMsgStart}
              aria-label="scroll to the start of the last message"
              title="scroll to the start of the last message"
            >
              <span className="app-scroll-arrow">⤒</span> scroll to start
            </button>
          )}
          {/* Fixed area for the scroll buttons. The ↓ pill may disappear
              (when at the bottom), but the two ↑ buttons keep their fixed
              positions above, independently — and they show/hide together so
              the stack never shifts under the cursor. */}
          {showScrollUpButton && (
            <button
              type="button"
              className="app-scroll-up-pill is-user"
              onClick={onScrollUpUserClick}
              aria-label="scroll up to the previous user message"
              title="previous user message"
            >
              <span className="app-scroll-arrow app-scroll-arrow-dbl" aria-hidden="true">
                <span>▴</span>
                <span>▴</span>
              </span>
            </button>
          )}
          {showScrollUpButton && (
            <button
              type="button"
              className="app-scroll-up-pill is-agent"
              onClick={onScrollUpAgentClick}
              aria-label="scroll up to the previous agent message"
              title="previous agent message"
            >
              <span className="app-scroll-arrow">▴</span>
            </button>
          )}
          {!isAtBottom && (
            <button
              type="button"
              className={`app-scroll-pill${newCount > 0 ? ' has-new' : ''}`}
              onClick={onPillClick}
              aria-label={newCount > 0 ? `${newCount} new message — go to bottom` : 'go to bottom'}
              title={newCount > 0 ? `${newCount} new message` : 'go to bottom'}
            >
              <span className="app-scroll-arrow">▾</span>
              {newCount > 0 && <span className="app-scroll-count">{newCount}</span>}
            </button>
          )}
        </div>

        <PendingInputs items={pendingItems} turnRunning={status === 'thinking'}
          compacting={liveCompacting} onSendNow={sendNow} />

        {status === 'thinking' && (
          <ThinkingBar
            label={liveCompacting ? providerText.compacting(sessionKind) : providerText.thinking(sessionKind)}
            compacting={liveCompacting}
            onInterrupt={interrupt}
            line={liveLine}
            toolCount={liveUsage?.tools ?? (showTools ? stepCount : 0)}
            startedAt={turnStartedAt}
            tokens={showTools ? (liveUsage?.output ?? null) : null}
            responseSpeed={responseSpeed}
          />
        )}

        {status !== 'thinking' && responseSpeed?.tokensPerSecond != null && (
          <div className="turn-cost" role="status" title="Latest timed SDK report: generated output tokens divided by elapsed turn time, including tools and waiting.">
            <span>last SDK report</span>
            <strong>{responseSpeed.tokensPerSecond.toFixed(1)} tok/s avg</strong>
          </div>
        )}

        {/* A turn's price, for the providers that actually charge one
            (`showsTurnCost`). Claude reports a cost too, but it is the tokens
            valued at API list price while the session spends PLAN QUOTA — a
            dollar figure for something nobody is billed, when the honest
            gauge is the usage meter. Hidden on a custom endpoint for the
            same reason: Charon does not know that operator's rates. */}
        {!endpoint.active && showTools && showsTurnCost(sessionKind)
          && liveUsage?.final && liveUsage.costUsd != null && liveUsage.costUsd > 0 && (
          <div className="turn-cost" role="status">
            <span>last turn</span>
            <strong>{fmtCost(liveUsage.costUsd)}</strong>
          </div>
        )}

        {/* Background tasks (Bash run_in_background / bg subagents): slim
            status line above the input, click → details modal. Renders null
            when the session has no live/recent background work.
            ⚠ NOT gated on `showTools`: that preference filters transcript
            ROWS (tool calls, reasoning, plans — cf. chatVisibility.ts), and
            this bar is live STATE plus the only route to the per-task ⊘
            (§14.91). Gating it meant a reader in conversation view — the
            usual choice on a phone, where the preference is per-browser —
            could neither see nor stop background work.
            The wrapper is `display: contents` except on a phone holding two
            strips or more: then they share ONE row (app.css). */}
        <div className="status-strips">
          <BgTasksBar tasks={bgTasks} olderEnded={bgOlderEnded} sessionId={sessionId} vpsId={vpsId} cwd={selected.cwd || null}
            provider={asSessionProvider(sessionKind)}
            sessionStatus={status ?? 'sleeping'} />
          {/* What will wake the session later (CronCreate / ScheduleWakeup /
              /loop), from its summary. Same placement, same reason. */}
          <ScheduledTasksBar state={selected.scheduledTasks} sessionStatus={status ?? 'sleeping'} />
          {/* What the session keeps working toward (§14.119). */}
          {supportsSessionCapability(sessionKind, 'goal') && (
            <GoalBar goal={selected.goal} sessionId={sessionId} provider={asSessionProvider(sessionKind)} />
          )}
        </div>
        {goalEditorOpen && <GoalEditor sessionId={sessionId} provider={asSessionProvider(sessionKind)}
          initial={selected.goal} onClose={() => setGoalEditorOpen(false)} />}

        {/* Async questions: ONE strip above the composer slot and above the
            Resume CTA (answering auto-resumes), never in place of either.
            Input area below — replaced by resume CTA if disconnected, or
            QuestionCard/ExitPlanCard/PermissionCard if pending. */}
        <ComposerWithAsyncStrip strip={
          <AsyncQuestionStrip questions={pendingAsyncQuestions} onRespond={respondQuestion}
            onShowInTranscript={jumpToQuestion} isJumping={isQuestionJumping}
            vpsId={vpsId} cwd={selected.cwd || null} />
        }>
        {(status === 'sleeping' || status === 'error') ? (
          <div className="app-disconnect-cta">
            <button onClick={() => doResume()}>↺ RESUME THIS SESSION</button>
          </div>
        ) : oldestPending ? (
          <PendingZone
            kind={oldestPending.kind}
            id={oldestPending.kind === 'permission' ? oldestPending.perm.id
              : oldestPending.kind === 'question' ? oldestPending.q.id
              : oldestPending.ep.id}
          >
            {oldestPending.kind === 'question' && (
              <QuestionCard
                questions={oldestPending.q.questions} vpsId={vpsId} cwd={selected.cwd || null}
                onAnswer={(answers) => respondQuestion(oldestPending.q.id, answers)}
                onCancel={() => respondQuestion(oldestPending.q.id, null)}
              />
            )}
            {oldestPending.kind === 'exit_plan' && (
              <ExitPlanCard
                kind={sessionKind}
                plan={oldestPending.ep.plan}
                onApprove={() => respondExitPlan(oldestPending.ep.id, 'approve')}
                onReject={(feedback) => respondExitPlan(oldestPending.ep.id, 'reject', feedback)}
              />
            )}
            {oldestPending.kind === 'permission' && (
              <InlinePermissionCard
                perm={oldestPending.perm}
                kind={sessionKind}
                onRespond={(allow, always, suggestion) =>
                  respondPermission(oldestPending.perm.id, allow, always, suggestion)}
              />
            )}
          </PendingZone>
        ) : (
          <>
          {promptCache?.phase === 'cold' && status === 'active' && (() => {
            // The next message re-sends everything without the cache (§14.119):
            // say how much, and — subscription accounts — what share of the
            // 5-hour limit that is (the CLI's own rate).
            const tokens = promptCache.promptTokens;
            const share = coldResumeShare(tokens, sessionContext?.cold_resume_quota);
            const why = promptCache.reason === 'model' ? 'the model changed'
              : promptCache.reason === 'account' ? 'the account changed' : 'it expired';
            return <div className="cold-resume-note" role="note">
              <span className="crn-ico" aria-hidden>❄</span>
              <span>Cache cold ({why}): your next message re-sends <b>{fmtDriverTokens(tokens)}</b> tokens without it
                {share?.worthSaying ? <> — about <b>{Math.round(share.percent)}%</b> of your 5-hour limit</> : null}.</span>
            </div>;
          })()}
          {asideError && <div className="aside-error" role="alert">
            <span>aside: {asideError}</span>
            <button type="button" onClick={() => setAsideError(null)} aria-label="dismiss">×</button>
          </div>}
          {slashNote && <div className={`aside-error${slashNote.ok ? ' is-ok' : ''}`} role={slashNote.ok ? 'status' : 'alert'}>
            <span>{slashNote.text}</span>
            <button type="button" onClick={() => setSlashNote(null)} aria-label="dismiss">×</button>
          </div>}
          <ChatInputBar
            sessionId={sessionId}
            kind={sessionKind}
            permissionMode={permissionMode}
            onSetMode={setMode}
            onSend={streamSend}
            prefillInput={prefillInput}
            clearPrefillInput={clearPrefillInput}
            pending={pendingUploads}
            onUploadFiles={uploadAttachments}
            onDismissPending={dismissPendingUpload}
            insertRequest={insertRequest}
            clearInsertRequest={clearInsertRequest}
            siblings={siblings}
            compacting={liveCompacting}
            onAside={ASIDE_STATUSES.has(status ?? '') && supportsSessionCapability(sessionKind, 'sideQuestion') ? askAside : undefined}
            slashKey={`${sessionKind}|${vpsId}|${selected.cwd ?? ''}`}
            onSlashAction={runSlash}
            compact={compact}
            textareaRef={composerRef}
            onEmptyKey={onEmptyComposerKey}
            onNowEmpty={sendFirstNow}
          />
          </>
        )}
        </ComposerWithAsyncStrip>
      </main>

      {!compact && <ToolPanel
        sessionId={sessionId}
        kind={sessionKind}
        toolCalls={toolCalls}
        toolCallCount={toolCallCount}
        transcriptView={transcriptView}
        edits={edits}
        editsMissing={editsMissing}
        onNeedEdits={loadEditContents}
        onRevert={revertAndRefresh}
        attachments={attachments}
        onRemoveAttachment={removeAttachment}
        requestedTab={toolTabRequest}
        onTabConsumed={clearToolTabRequest}
        onInsertPath={requestInsertPath}
        vpsId={vpsId || null}
        cwd={selected.cwd || null}
        repoBusy={status === 'thinking'}
        onOpenSession={onOpenSession}
        onOpenFolder={onOpenFolder}
        onNewSessionIn={onNewSessionIn}
        onReveal={onOpenTools}
        context={sessionContext}
        contextLoaded={contextLoaded}
        contextLoading={contextLoading}
        onRefreshContext={refreshContext}
        onCompact={doCompact}
        compacting={compacting || liveCompacting}
        compactDisabled={!compactAllowed}
        compactError={compactError}
        usage={supportsSessionCapability(sessionKind, 'contextUsage') ? usageInput : null}
        deferInsight={!historyReady}
      />}
      {forkModalOpen && (
        <ForkModal
          sourceKind={sessionKind}
          sessionId={sessionId}
          sourceName={selected.name || '(unnamed)'}
          vpsName={selectedVps?.name}
          vps={selectedVps ?? null}
          busy={forking}
          error={forkError}
          onChoose={(kind, options) => { void doFork(kind, options); }}
          onClose={() => { if (!forking) setForkModalOpen(false); }}
        />
      )}
      {rewindOpen && <RewindModal messages={messages}
        provider={providerName(sessionKind)} busy={rewinding} error={rewindError}
        onConfirm={(messageId) => { void doRewind(messageId); }}
        onClose={() => { if (!rewinding) setRewindOpen(false); }} />}
    </ContextWindowContext.Provider>
  );
}

// ── View-specific sub-components ────────────────────────────────────────────

// Completed history is immutable while an assistant streams. Keeping the map
// inside a memoized child means a delta no longer creates/reconciles hundreds
// of <Message> elements; only the small live-tail bubble changes.
const MessageHistory = memo(function MessageHistory({
  renderable, kind, vpsId, cwd, onReauth, authMsgId, continuableMsgId, schedulableMsgId, onContinue, onScheduleResume, onCancelScheduledResume, turnInFlight,
  limitMsgId, currentAccount, onContinueWithAccount, finishMsgId, finishCue,
  siblings, onOpenPeerSession, onPeerRequestHover, onPeerRequestJump, peerReplyToById,
  liveRow, substitute, selectedModel,
}: {
  renderable: { msg: Msg; attached?: Msg }[];
  // A persisted row the live text is extending (`assistant_reopened`): drawn
  // in its place with the buffer appended, as a streaming bubble.
  liveRow?: Msg | null;
  kind: AgentKind;
  // `substitutedModel`: bubbles answered by it get a red chip naming the
  // selected model. Strings, and only the matching bubbles see the value
  // (memo, §14.38).
  substitute: string | null;
  selectedModel: string | null;
  profileNumber?: number;
  vpsId: string;
  cwd: string | null;
  onReauth?: () => void;
  authMsgId: string | null;
  continuableMsgId: string | null;
  schedulableMsgId: string | null;
  onContinue: () => void;
  onScheduleResume: (messageId: string) => Promise<void>;
  onCancelScheduledResume: (scheduleId: string) => Promise<void>;
  limitMsgId: string | null;
  currentAccount: string;
  onContinueWithAccount: (accountId: string) => Promise<void>;
  // The bubble showing the unread finish, and its colour (§14.47): only that
  // bubble sees the value (memo, §14.38).
  finishMsgId: string | null;
  finishCue: 'unread' | 'error' | null;
  // Is a turn in flight right now? A tool_use with no tool_result can only
  // still be running while one is: outside a turn nothing can produce that
  // result anymore (§14.91). Only the unresolved tool cards receive the
  // derived `orphaned`, so a turn boundary re-runs this map but re-renders
  // at most those few messages (memo, §14.38).
  turnInFlight: boolean;
  siblings?: Array<{ id: string; handle: string }>;
  onOpenPeerSession?: (sessionId: string) => void;
  onPeerRequestHover: (messageId: string | null) => void;
  onPeerRequestJump: (messageId: string) => void;
  peerReplyToById: ReadonlyMap<string, string>;
}) {
  return [...renderable].reverse().map(({ msg, attached }) => {
    if (msg.role === 'async_question') return <AsyncQuestionBubble key={msg.id} message={msg} vpsId={vpsId} cwd={cwd} />;
    const live = liveRow && liveRow.id === msg.id ? liveRow : null;
    const m = live ?? msg;
    return <Message
      key={msg.id} m={m} streaming={!!live}
      attachedResult={attached} kind={kind}
      substitutedFor={substitute && m.model === substitute ? selectedModel : null}
      vpsId={vpsId} cwd={cwd}
      onReauth={msg.id === authMsgId ? onReauth : undefined}
      onContinue={msg.id === continuableMsgId || msg.id === authMsgId ? onContinue : undefined}
      onScheduleResume={msg.id === schedulableMsgId ? () => onScheduleResume(msg.id) : undefined}
      onContinueWithAccount={msg.id === limitMsgId || msg.id === authMsgId ? onContinueWithAccount : undefined}
      currentAccount={msg.id === limitMsgId || msg.id === authMsgId ? currentAccount : undefined}
      onCancelScheduledResume={onCancelScheduledResume}
      orphaned={msg.role === 'tool_use' && !attached && !turnInFlight}
      peerSessionId={peerSessionTarget(msg, siblings)} onOpenPeerSession={onOpenPeerSession}
      onPeerRequestHover={onPeerRequestHover} onPeerRequestJump={onPeerRequestJump}
      peerReplyTo={peerReplyToById.get(msg.id)}
      finishCue={msg.id === finishMsgId ? finishCue : null}
    />;
  });
});

// Isolated input bar. It owns the textarea `input` state (via useInputDraft)
// so that typing only re-renders THIS small component — never the parent
// SessionView, and therefore never the message list. Before this
// isolation, every keystroke re-rendered the whole session view; combined with
// the (now memoized) <Message>, that meant re-parsing markdown + re-running
// syntax highlighting for the entire history on each keypress, which is why
// long sessions lagged by seconds. Memoized too, so a parent re-render
// (new message, status change) doesn't needlessly re-render it either.
// See CLAUDE.md §11 / §14.
type InsertRequest = { text: string; nonce: number; block?: boolean };

/** The recap to draw under the last answer (§14.122): none while a turn runs
 *  (`busy`), nor once the row it follows is no longer the last word. */
export function recapToShow(recap: SessionRecap | null, messages: Msg[], busy: boolean): SessionRecap | null {
  if (!recap || busy) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' || m.role === 'assistant' || m.role === 'external' || m.role === 'error') {
      return m.id === rowKey(recap.afterRowId) ? recap : null;
    }
  }
  return null;
}

/** The recap under the last answer (§14.122). Folds like every bubble, from
 *  its left edge (bubbleFold's store: in memory, per answer). */
export const RecapNote = memo(function RecapNote({ recap }: { recap: SessionRecap }) {
  const key = `recap:${recap.afterRowId}`;
  const isFolded = useBubbleFold(key);
  const parts = recap.text.split('`');
  return (
    <div className={`recap-bubble${isFolded ? ' is-folded' : ''}`} {...foldRootProps(key)}>
      <FoldEdge isFolded={isFolded} />
      <span className="recap-label"><IconSparkle />recap</span>
      {isFolded
        ? <span className="recap-fold-text">{parts.join('')}</span>
        : <p>{parts.map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</p>}
    </div>
  );
});

/** The `@parent ›` crumb before a sub-session's handle: read from the summary
 *  store (a sleeping parent is not in `siblings`), as a string so only this
 *  crumb re-renders. */
const ParentChip = memo(function ParentChip({ parentId, onOpen, beforeHandle }: {
  parentId: string; onOpen: (id: string) => void; beforeHandle: boolean;
}) {
  const label = useSyncExternalStore(subscribeSummaries, () => {
    const p = getSummary(parentId);
    return p ? (p.handle ? `@${p.handle}` : p.name || '(unnamed)') : null;
  }, () => null);
  if (label === null) return null;
  return (
    <>
      <button type="button" className="bar-parent" title="Parent session"
        aria-label={`Open parent session ${label}`}
        onClick={() => onOpen(parentId)}
      >{label}</button>
      {beforeHandle && <span className="bar-crumb-sep" aria-hidden>›</span>}
    </>
  );
});

const ChatInputBar = memo(function ChatInputBar({
  sessionId, kind, permissionMode, onSetMode, onSend, prefillInput, clearPrefillInput,
  pending, onUploadFiles, onDismissPending, insertRequest, clearInsertRequest, siblings, compacting = false,
  onAside, slashKey, onSlashAction, compact = false, textareaRef, onEmptyKey, onNowEmpty,
}: {
  /** Ctrl/⌘+⇧+↵ in an empty box: send the oldest waiting message now
   *  (true = there was one). */
  onNowEmpty?: () => boolean;
  /** SessionView's `compact`: the shared composer size is ignored (no grip,
   *  never collapsed, never revealed) and the box grows with its text. */
  compact?: boolean;
  /** The host's handle on the textarea (SessionView `composerRef`). */
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Enter (no modifier) or Tab in an empty box, no menu open: true = handled. */
  onEmptyKey?: (key: 'Enter' | 'Tab', shift: boolean) => boolean;
  /** Ask beside the conversation (§14.119), offered while the session is
   *  awake; the answer never enters the context. Absent = no button. */
  onAside?: (question: string) => Promise<void>;
  /** The `/` menu (lib/slashCommands.ts): its list is cached per
   *  provider|vps|folder; a Charon command runs through `onSlashAction`
   *  (true = done, the box empties; false = the text stays). */
  slashKey: string;
  onSlashAction: (action: SlashAction, arg: string) => Promise<boolean>;
  sessionId: string;
  kind: AgentKind;
  permissionMode: SessionMode;
  onSetMode: (mode: SessionMode) => void;
  onSend: (content: string, codexInputs?: Array<Record<string, unknown>>, now?: boolean) => Promise<void>;
  prefillInput: string | null;
  clearPrefillInput: () => void;
  pending: PendingUpload[];
  onUploadFiles: (files: File[], onEach?: (att: SessionAttachment) => void) => Promise<void>;
  onDismissPending: (key: string) => void;
  // "Insert this path" request coming from the Files tab. Same drain pattern as
  // prefillInput: the parent holds it until this bar is mounted to consume it,
  // so clicking + in the tab while a permission card is showing isn't lost.
  insertRequest: InsertRequest | null;
  clearInsertRequest: () => void;
  /** Other sessions on the same machine, for the `@` menu. `confirmed:false`
   *  = the handle is predicted, not yet what the CLI answers to. */
  siblings?: Array<{ id: string; name: string | null; handle: string; confirmed?: boolean; status: string }>;
  /** The provider is summarising the conversation: the box stays open, what
   *  it sends waits for the end (§14.125) — the placeholder says so. */
  compacting?: boolean;
}) {
  // `input` is wired to `inputDraftStore` so the draft survives session
  // switches (this component remounts via the parent's key={selectedId}) — cf.
  // app/inputDraftStore.ts. F5 wipes everything (in-memory Map).
  const [input, setInput] = useInputDraft(sessionId);
  const [touchInput, setTouchInput] = useState(false);

  // Shared by every session of this browser (composerSize.ts); `sizePreview`
  // is a grip drag in progress, committed on release.
  const [composerSize, setComposerSize] = useComposerSize();
  const [sizePreview, setSizePreview] = useState<ComposerSize | null>(null);
  const shownSize = compact ? DEFAULT_COMPOSER_SIZE : (sizePreview ?? composerSize);
  const sized = !shownSize.hidden && shownSize.height != null;

  const footerRef = useRef<HTMLElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const setTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    taRef.current = el;
    assignRef(textareaRef, el);
  }, [textareaRef]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Last known caret offset. A drop lands on the WINDOW, not the textarea, so
  // by the time we insert, the textarea may not even be focused — without this
  // the path would always be appended at the end, which is exactly what the
  // "insert where my cursor is" requirement rules out.
  const caretRef = useRef<number | null>(null);
  // Mirror of `input` that is updated SYNCHRONOUSLY by insertAtCaret. Dropping
  // three files fires three inserts back-to-back, all before React has
  // re-rendered — reading state there would make each one overwrite the last,
  // and only the final path would survive.
  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; }, [input]);

  // On a phone the box grows with its text (`field-sizing: content` in
  // app.css, between its min and max heights). An engine without it gets
  // the same from scrollHeight; everywhere else the stylesheet owns the height.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta || typeof CSS === 'undefined' || CSS.supports('field-sizing', 'content')) return;
    if (!compact && !window.matchMedia?.('(max-width: 820px)').matches) { ta.style.height = ''; return; }
    ta.style.height = '0px';
    ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`;
  }, [input, compact]);

  // What is being dragged over the page, or null. Two kinds land in the same
  // place (the caret) but do very different things on the way: 'files' uploads
  // to the VPS first, 'path' is already there and only needs splicing.
  const [dragKind, setDragKind] = useState<'files' | 'path' | null>(null);
  // An OS file has a SECOND destination: the explorer on the right uploads it
  // into a folder under its own name (app/fileDropZones.ts). The overlay stops
  // at that panel's edge so both targets are visible at once, and dims while
  // the pointer is over the panel — releasing there never attaches.
  const [overPanel, setOverPanel] = useState(false);
  const [panelRight, setPanelRight] = useState<number | null>(null);

  // Drain prefill_input: copy into the textarea then clear. If this bar is
  // unmounted when a prefill arrives (pending interaction / sleeping session),
  // the hook keeps prefillInput non-null (clearPrefillInput only runs here), so
  // it self-applies the moment the bar remounts.
  useEffect(() => {
    if (prefillInput !== null) {
      if (!compact) revealComposer();
      setInput(prefillInput);
      clearPrefillInput();
    }
  }, [prefillInput, clearPrefillInput, setInput, compact]);

  // Focus on desktop session entry/remount, after pane transitions. Touch
  // devices keep the keyboard closed until the user taps the composer.
  useEffect(() => {
    const media = window.matchMedia?.('(pointer: coarse)');
    const syncTouchInput = () => setTouchInput(media?.matches ?? false);
    syncTouchInput();
    media?.addEventListener('change', syncTouchInput);
    const id = requestAnimationFrame(() => {
      if (media?.matches) return;
      // Embedded (`compact`): the composer can mount under a host's dialog or
      // while a field holds the caret (a gate card left its place) — the
      // caret stays where the user is typing.
      if (compact) {
        const held = document.activeElement as HTMLElement | null;
        const typing = held != null && (held.tagName === 'INPUT' || held.tagName === 'TEXTAREA'
          || held.tagName === 'SELECT' || held.isContentEditable);
        if (typing || held?.closest?.('[role="dialog"], .app-modal-bg')) return;
      }
      taRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      media?.removeEventListener('change', syncTouchInput);
    };
  }, [sessionId, compact]);

  const rememberCaret = useCallback(() => {
    const ta = taRef.current;
    if (ta) caretRef.current = ta.selectionStart;
  }, []);

  /**
   * Insert text at the remembered caret, padding with spaces so a path never
   * gets glued to an adjacent word (`voir/tmp/a.png` would be unreadable to
   * the model AND break the exact-match underline).
   */
  const insertAtCaret = useCallback((text: string) => {
    const cur = inputRef.current;
    const pos = Math.min(caretRef.current ?? cur.length, cur.length);
    const before = cur.slice(0, pos);
    const after = cur.slice(pos);
    const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const trail = after.length === 0 || !/^\s/.test(after) ? ' ' : '';
    const chunk = lead + text + trail;
    const next = before + chunk + after;
    inputRef.current = next;
    if (!compact) revealComposer();
    setInput(next);
    const caret = before.length + chunk.length;
    caretRef.current = caret;
    // After React commits the new value — setting the selection before that
    // would be overwritten by the controlled re-render.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      try { ta.setSelectionRange(caret, caret); } catch { /* detached */ }
    });
  }, [setInput, compact]);

  /** A quote: on its own lines, the caret on the line right below it. */
  const insertBlockAtCaret = useCallback((block: string) => {
    const { next, caret } = insertQuoteBlock(inputRef.current, caretRef.current ?? inputRef.current.length, block);
    inputRef.current = next;
    if (!compact) revealComposer();
    setInput(next);
    caretRef.current = caret;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      try { ta.setSelectionRange(caret, caret); } catch { /* detached */ }
      // A long quote appended at the end: keep the caret, not the top of
      // the quote, in view (setSelectionRange does not scroll everywhere).
      if (caret === next.length) ta.scrollTop = ta.scrollHeight;
    });
  }, [setInput, compact]);

  // ── `@` mention menu ────────────────────────────────────────────────────
  // Naming a session is only half of addressing it: you also have to know what
  // the others are called. Typing `@` lists the sessions on THIS machine — the
  // ones this session can actually reach, since cross-session messaging is
  // filesystem-scoped — and picking one inserts its handle, so "tell @api to
  // regenerate the types" names a real, resolvable target instead of a guess.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);

  const mentionMatches = useMemo(() => {
    if (!mention || !siblings?.length) return [];
    const q = mention.query.toLowerCase();
    return siblings
      .filter((x) => !q || x.handle.toLowerCase().includes(q)
        || (x.name ?? '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [mention, siblings]);

  // ── `/` command menu ────────────────────────────────────────────────────
  // At the very START of the message, like the CLI: the provider's commands
  // and skills plus Charon's own (lib/slashCommands.ts). Picking one writes
  // it and a space; Enter then sends — or, for a Charon command, runs it here.
  const catalog = useSlashCatalog(sessionId, kind, slashKey);
  const ensureCatalog = catalog.ensure;
  const userCommands = useUserCommands();
  const slashItems = useMemo(
    () => slashMenu(kind, catalog.native ?? [], userSlashItems(userCommands)),
    [kind, catalog.native, userCommands],
  );
  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const slashMatches = useMemo(() => (slash ? filterSlash(slashItems, slash.query) : []), [slash, slashItems]);
  const slashListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    slashListRef.current?.querySelector('.ci-mention.on')?.scrollIntoView({ block: 'nearest' });
  }, [slashIdx, slash]);
  // What the command at the start of the box does and takes, under the menu's
  // shape, once it is written out.
  const slashHint = useMemo(() => {
    if (slash) return null;
    const m = /^[/$]\S+/.exec(input);
    return m ? slashItems.find((it) => it.insert === m[0]) ?? null : null;
  }, [input, slash, slashItems]);

  /** Re-derive the pending mention from the text and caret. `@` only opens a
   *  menu at a word boundary — an email address or a decorator must not. */
  const syncMention = useCallback((value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const s = /^\/(\S*)$/.exec(upto);
    if (s) {
      setSlash({ query: s[1]! });
      setSlashIdx(0);
      setMention(null);
      ensureCatalog();
      ensureUserCommands();
      return;
    }
    setSlash(null);
    // A `$skill` typed by hand still needs its path at send time.
    if (/(?:^|\s)\$\S*$/.test(upto)) ensureCatalog();
    const m = /(?:^|\s)@([a-zA-Z0-9-]*)$/.exec(upto);
    if (!m) { setMention(null); return; }
    setMention({ start: caret - m[1].length - 1, query: m[1] });
    setMentionIdx(0);
  }, [ensureCatalog]);

  const applySlash = useCallback((item: SlashItem) => {
    const rest = inputRef.current.replace(/^\S*/, '').replace(/^[ \t]+/, '');
    const head = `${item.insert} `;
    const next = head + rest;
    const pos = head.length;
    inputRef.current = next;
    setInput(next);
    caretRef.current = pos;
    setSlash(null);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      try { ta.setSelectionRange(pos, pos); } catch { /* detached */ }
    });
  }, [setInput]);

  const applyMention = useCallback((handle: string) => {
    if (!mention) return;
    const cur = inputRef.current;
    const caret = Math.min(caretRef.current ?? cur.length, cur.length);
    const next = cur.slice(0, mention.start) + '@' + handle + ' ' + cur.slice(caret);
    const pos = mention.start + handle.length + 2;
    inputRef.current = next;
    setInput(next);
    caretRef.current = pos;
    setMention(null);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      try { ta.setSelectionRange(pos, pos); } catch { /* detached */ }
    });
  }, [mention, setInput]);

  // Drain "insert this path" (Files tab) and "quote this" (chat selection).
  useEffect(() => {
    if (!insertRequest) return;
    if (insertRequest.block) insertBlockAtCaret(insertRequest.text);
    else insertAtCaret(insertRequest.text);
    clearInsertRequest();
  }, [insertRequest, insertAtCaret, insertBlockAtCaret, clearInsertRequest]);

  const handleFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    // The path is appended as each upload lands, so the user sees progress
    // rather than a frozen bar followed by a burst of paths.
    void onUploadFiles(files, (att) => insertAtCaret(att.remotePath));
  }, [onUploadFiles, insertAtCaret]);

  // ── Window-level drag & drop ──────────────────────────────────────────────
  // Listeners go on the window, not the textarea: the requirement is to drop
  // anywhere on the page. Scoping is automatic — this bar only exists while a
  // chat session is open, so a drop over a shell terminal or an install log
  // never reaches here.
  useEffect(() => {
    // Depth counter, because dragenter/dragleave fire for every child element
    // the pointer crosses; a naive boolean flickers the overlay constantly.
    let depth = 0;
    let inPanel = false;
    const setInPanel = (v: boolean) => { if (v !== inPanel) { inPanel = v; setOverPanel(v); } };
    const panelOf = (t: EventTarget | null) => t instanceof Element && !!t.closest('.tool-panel');
    // Which of the app's three HTML5 drags this is — see app/pathDrag.ts. A
    // tab or sidebar REORDER carries only 'text/plain' and matches neither, so
    // dragging a tab must never light up the chat's drop overlay.
    const kindOf = (e: DragEvent): 'files' | 'path' | null => {
      const dt = e.dataTransfer;
      if (!dt) return null;
      if (Array.prototype.indexOf.call(dt.types, 'Files') !== -1) return 'files';
      return isPathDrag(dt) ? 'path' : null;
    };
    const onEnter = (e: DragEvent) => {
      const kind = kindOf(e);
      if (!kind) return;
      depth += 1;
      // Measured once per drag: where the panel starts is where the chat's
      // side of the screen ends.
      if (depth === 1) {
        const left = kind === 'files' ? toolPanelLeft() : null;
        setPanelRight(left == null ? null : Math.max(0, window.innerWidth - left));
      }
      setDragKind(kind);
    };
    const onOver = (e: DragEvent) => {
      const kind = kindOf(e);
      if (!kind) return;
      // MANDATORY: without preventDefault the drop event never fires and the
      // browser navigates away to the dropped file instead.
      e.preventDefault();
      if (kind === 'path' && panelOf(e.target)) {
        // A path dragged over the panel is the explorer's business (a MOVE
        // onto one of its folders, TreeTab): its own verdict stands, and the
        // rest of the panel takes nothing.
        if (e.dataTransfer && !uploadZoneOf(e.target)) e.dataTransfer.dropEffect = 'none';
        setInPanel(false);
        return;
      }
      if (kind === 'files' && panelOf(e.target)) {
        // The panel is the server side: only the explorer's zone accepts, so
        // the cursor itself says "not here" over the tabs or the git view.
        setInPanel(true);
        if (e.dataTransfer) e.dataTransfer.dropEffect = uploadZoneOf(e.target) ? 'copy' : 'none';
        return;
      }
      setInPanel(false);
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!kindOf(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) { setDragKind(null); setInPanel(false); }
    };
    const onDrop = (e: DragEvent) => {
      const kind = kindOf(e);
      if (!kind) return;
      e.preventDefault();
      depth = 0;
      setDragKind(null);
      setInPanel(false);
      if (kind === 'path') {
        // Dropping back onto the explorer is how a drag gets CANCELLED — the
        // panel is both the source and, being fixed on the right, the easiest
        // place to let go by accident. Everywhere else is a valid target.
        if (e.target instanceof Element && e.target.closest('.tool-panel')) return;
        const p = readPathDrag(e.dataTransfer);
        // No upload: this path already exists on the VPS, so it goes straight
        // to the caret and `pending` stays empty (no blocking upload overlay).
        if (p) insertAtCaret(p);
        return;
      }
      // Released over the right panel: its explorer uploads into a folder
      // (TreeTab), and anywhere else there is deliberately a no-op.
      if (panelOf(e.target)) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      handleFiles(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFiles, insertAtCaret]);

  // Paste a screenshot straight into the message (Cmd/Ctrl+V). Same pipeline as
  // a drop — on desktop this is how screenshots actually reach a chat.
  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;   // plain text paste → let the browser do it
    e.preventDefault();
    rememberCaret();
    handleFiles(files);
  }, [handleFiles, rememberCaret]);

  // An upload is in flight (an entry with an `error` is a finished failure, not
  // progress). Drives the blocking overlay: the ssh push to the VPS takes a few
  // seconds, and without a visible gate the user types into a textarea that is
  // about to have a path spliced into it at a caret that has since moved.
  const uploading = pending.filter((p) => !p.error);

  // A compaction leaves the box open: what it sends waits for the end
  // (hub-held, §14.125) and its bubble says so.
  // `now`: Ctrl/⌘+Shift+Enter — mid-turn, the CLI reads it at once.
  const send = useCallback(async (now = false) => {
    const content = input.trim();
    if (!content) return;
    setInput('');
    inputRef.current = '';
    caretRef.current = 0;
    setSlash(null);
    const command = parseCharonCommand(content, slashItems);
    if (command) {
      let done = false;
      try { done = await onSlashAction(command.item.action!, command.arg); } catch { done = false; }
      if (!done && !inputRef.current) { setInput(content); inputRef.current = content; }
      return;
    }
    // A user command goes out as the prompt it names (the transcript shows it).
    const text = expandUserCommand(content, slashItems) ?? content;
    const skills = skillInputItems(text, slashItems);
    await onSend(text, skills.length ? [{ type: 'text', text }, ...skills] : undefined, now);
  }, [input, onSend, setInput, slashItems, onSlashAction]);

  const aside = useCallback(async () => {
    const question = input.trim();
    if (!question || !onAside) return;
    setInput('');
    inputRef.current = '';
    caretRef.current = 0;
    try { await onAside(question); }
    catch { setInput(question); inputRef.current = question; }
  }, [input, onAside, setInput]);

  return (
    <footer
      ref={footerRef}
      className={`app-input-bar${shownSize.hidden ? ' is-collapsed' : ''}${sized ? ' is-sized' : ''}${
        sizePreview ? ` is-resizing${!sizePreview.hidden && sizePreview.height == null ? ' at-detent' : ''}` : ''}${
        compact ? ' is-compact' : ''}`}
    >
      {!compact && <ComposerGrip footerRef={footerRef} textRef={taRef} size={composerSize}
        onPreview={setSizePreview} onCommit={setComposerSize} />}
      {/* The provider registry owns the mode ladder; providerText owns labels
          and glyphs (§14.102). */}
      <div className={`mode-switch ${kind}`} role="radiogroup" aria-label={providerText.modeSwitchAria(kind)}>
        {sessionModes(kind).map((m) => {
          const meta = MODE_SWITCH_META[m];
          if (!meta) return null;
          return (
            <button
              key={m}
              type="button" role="radio"
              aria-checked={permissionMode === m}
              className={`m-btn ${m}${permissionMode === m ? ' on' : ''}`}
              onClick={() => onSetMode(m)}
              title={meta.title}
            >
              <span className="m-glyph">{meta.glyph}</span><span className="m-label">{meta.label}</span>
            </button>
          );
        })}
      </div>
      {/* The same ladder for a phone: ONE chip that opens a picker, beside 📎
          and send under the text (app.css shows one of the two by width).
          It wears the active radio's colours, so a dangerous mode stays loud. */}
      <div className={`mode-switch ci-mode ${kind}`}>
        <PickerControl
          value={permissionMode}
          onValueChange={(v) => {
            const m = sessionModes(kind).find((x) => x === v);
            if (m) onSetMode(m);
          }}
          className={`m-btn on ${permissionMode}`}
          aria-label={`${providerText.modeSwitchAria(kind)}: ${MODE_SWITCH_META[permissionMode]?.label ?? permissionMode}`}
        >
          {sessionModes(kind).map((m) => {
            const meta = MODE_SWITCH_META[m];
            return meta && (
              <option key={m} value={m} title={meta.title}>
                <span className="m-glyph">{meta.glyph}</span>{' '}<span className="m-label">{meta.label}</span>
              </option>
            );
          })}
        </PickerControl>
      </div>
      {slash && slashMatches.length > 0 && (
        <div className="ci-mentions ci-slash" role="listbox" aria-label="commands and skills" ref={slashListRef}>
          {slashMatches.map((it, i) => {
            // Commands first, then skills, each under its title.
            const group = isSkillItem(it) ? 'Skills' : 'Commands';
            const prev = slashMatches[i - 1];
            const head = !prev || (isSkillItem(prev) ? 'Skills' : 'Commands') !== group;
            return (
              <Fragment key={it.insert}>
                {head && <div className="cis-group" role="presentation">{group}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === slashIdx}
                  className={`ci-mention${i === slashIdx ? ' on' : ''}`}
                  // mousedown, not click: same reason as the `@` menu below.
                  onMouseDown={(e) => { e.preventDefault(); applySlash(it); }}
                  onMouseEnter={() => setSlashIdx(i)}
                >
                  <span className="cis-line">
                    <span className="cis-name">{it.insert}</span>
                    {(it.tag === 'charon' || it.tag === 'mine') && (
                      <span className={`cis-tag ${it.tag}`}>{it.tag === 'charon' ? 'Charon' : 'mine'}</span>
                    )}
                    {it.hint && <span className="cis-hint">{it.hint}</span>}
                  </span>
                  {it.description && <span className="cis-desc">{it.description}</span>}
                </button>
              </Fragment>
            );
          })}
          {catalog.loading && <div className="cis-loading" role="status">loading this session's commands…</div>}
        </div>
      )}
      {slashHint && (slashHint.hint || slashHint.description) && !(mention && mentionMatches.length > 0) && (
        <div className="ci-slash-hint" aria-live="polite">
          <span className="cis-name">{slashHint.insert}</span>
          {slashHint.hint && <span className="cis-hint">{slashHint.hint}</span>}
          {slashHint.description && <span className="cis-desc">{slashHint.description}</span>}
        </div>
      )}
      {mention && mentionMatches.length > 0 && (
        <div className="ci-mentions" role="listbox" aria-label="sessions on this machine">
          {mentionMatches.map((x, i) => (
            <button
              key={x.id}
              type="button"
              role="option"
              aria-selected={i === mentionIdx}
              className={`ci-mention${i === mentionIdx ? ' on' : ''}`}
              // mousedown, not click: click fires after blur, and the blur has
              // already torn the menu down.
              onMouseDown={(e) => { e.preventDefault(); applyMention(x.handle); }}
              onMouseEnter={() => setMentionIdx(i)}
            >
              <span className={`cim-handle${x.confirmed === false ? ' unconfirmed' : ''}`}>@{x.handle}{x.confirmed === false ? '?' : ''}</span>
              {x.name && x.name !== x.handle && <span className="cim-name">{x.name}</span>}
              <span className={`cim-state ${x.status}`}>{x.status}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={setTextarea}
        enterKeyHint="enter"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          caretRef.current = e.target.selectionStart;
          syncMention(e.target.value, e.target.selectionStart ?? 0);
        }}
        onPaste={onPaste}
        onSelect={rememberCaret}
        onClick={rememberCaret}
        onKeyUp={rememberCaret}
        onBlur={rememberCaret}
        placeholder={compacting ? providerText.composerCompacting(kind)
          : touchInput
          ? providerText.composerHint(kind, true)
          : providerText.composerHint(kind, false)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          // Mobile Enter always inserts a newline, even with the @ menu open.
          if (e.key === 'Enter' && window.matchMedia?.('(pointer: coarse)').matches) return;
          // An open `/` menu owns the same keys: Enter/Tab writes the command
          // out (a second Enter sends it).
          if (slash && slashMatches.length > 0) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSlashIdx((i) => {
                const n = slashMatches.length;
                return (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
              });
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              applySlash(slashMatches[Math.min(slashIdx, slashMatches.length - 1)]!);
              return;
            }
            if (e.key === 'Escape') { e.preventDefault(); setSlash(null); return; }
          }
          // While the @ menu is open it owns the navigation keys — otherwise
          // Enter would send a half-typed handle instead of completing it.
          if (mention && mentionMatches.length > 0) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setMentionIdx((i) => {
                const n = mentionMatches.length;
                return (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
              });
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              applyMention(mentionMatches[mentionIdx]!.handle);
              return;
            }
            if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
          }
          if (onEmptyKey && !input.trim() && uploading.length === 0
            && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey))
            && onEmptyKey(e.key === 'Tab' ? 'Tab' : 'Enter', e.shiftKey)) { e.preventDefault(); return; }
          if (e.key !== 'Enter') return;
          if (e.altKey && onAside && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            void aside();
            return;
          }
          if (e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey) {
            e.preventDefault();
            if (!input.trim() && uploading.length === 0 && onNowEmpty?.()) return;
            void send(true);
            return;
          }
          if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
          e.preventDefault();
          send();
        }}
        rows={3}
        // Inline: a user-chosen value must outrank every density/breakpoint
        // min-height. Clamped to the same viewport share the grip allows.
        style={sized
          ? { minHeight: `min(${shownSize.height}px, ${COMPOSER_MAX_VIEWPORT_SHARE * 100}dvh)` }
          : undefined}
      />
      <div className="ci-send-col">
        <button
          type="button"
          className="ci-attach"
          onClick={() => { rememberCaret(); fileInputRef.current?.click(); }}
          title="attach a file — it is uploaded to the session workspace and its path inserted here"
          aria-label="attach a file"
        >
          <IconPaperclip />
        </button>
        {onAside && (
          <button type="button" className="aside" onClick={() => void aside()} disabled={!input.trim()}
            aria-label="ask aside"
            title="Ask aside (Alt+Enter): answered now, from what the session knows, without stopping it — neither the question nor the answer enters the conversation">
            <IconChatSide /><span className="aside-label">aside</span>
          </button>
        )}
        {/* The word on a desktop, the icon on a phone (app.css). */}
        <button className="send" onClick={() => void send()} disabled={!input.trim()} aria-label="send"
          title={compacting ? providerText.composerCompacting(kind) : undefined}>
          <span className="send-label">send</span><IconSend className="send-icon" />
        </button>
      </div>
      {/* No `accept` filter: any file type goes through, on purpose — whether
          the agent can do something with it is ITS verdict, not ours. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="ci-file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Reset so re-picking the SAME file fires change again.
          e.target.value = '';
          handleFiles(files);
        }}
      />
      {pending.length > 0 && (
        <div className="ci-pending">
          {pending.map((p) => (
            <span key={p.key} className={`ci-chip${p.error ? ' err' : ''}`} title={p.error ?? undefined}>
              <span className="ci-chip-name">{p.name}</span>
              {p.error
                ? <button type="button" className="ci-chip-x" onClick={() => onDismissPending(p.key)} aria-label="dismiss">✕</button>
                : <span className="ci-chip-spin">uploading…</span>}
            </span>
          ))}
        </div>
      )}
      {dragKind && (
        <div
          className={`ci-drop-overlay${dragKind === 'files' && overPanel ? ' is-elsewhere' : ''}`}
          style={dragKind === 'files' && panelRight != null ? { right: panelRight } : undefined}
        >
          <div className="ci-drop-card">
            {dragKind === 'path' ? <IconInsert /> : <IconPaperclip />}
            <span className="ci-drop-text">
              <span className="ci-drop-title">{dragKind === 'path' ? 'insert path' : 'attach to message'}</span>
              <span className="ci-drop-sub">
                {dragKind === 'path'
                  // Saying "the path" and not "the file" is the whole point:
                  // nothing is copied anywhere, the agent is simply told where
                  // to look on its own disk.
                  ? 'drop to put this path in the message'
                  : 'uploaded to .charon/uploads/ — its path goes into your message'}
              </span>
              {dragKind === 'files' && panelRight != null && (
                <span className="ci-drop-alt">
                  <IconUpload />or drop it on a folder in the explorer to upload it there
                </span>
              )}
            </span>
          </div>
        </div>
      )}
      {/* Blocking gate while the upload runs. Same visual language as the drop
          overlay, but this one INTERCEPTS pointer events on purpose: the hub
          has to push the bytes to the VPS over ssh, which takes seconds, and
          the path is spliced in at the remembered caret when it lands. Letting
          the user keep typing or click send in the meantime means the insert
          arrives somewhere they no longer expect — or after the message has
          already gone. */}
      {uploading.length > 0 && (
        <div className="ci-upload-overlay" role="status" aria-live="polite">
          <div className="ci-drop-card">
            <span className="ci-spinner" aria-hidden="true" />
            <span>
              uploading {uploading.length > 1 ? `${uploading.length} files` : uploading[0].name}
              {' — '}pushing to the session workspace…
            </span>
          </div>
        </div>
      )}
    </footer>
  );
});

function InlinePermissionCard({ perm, kind, onRespond }: {
  perm: PermissionRequest;
  kind: AgentKind;
  onRespond: (allow: boolean, always: boolean, suggestion?: number) => void;
}) {
  // The CLI's own sentence ("Claude wants to read foo.txt") beats ours.
  const prompt = perm.prompt;
  const summary = prompt?.title ?? summarizeToolInput(perm.tool, perm.input);
  return (
    <div className="inline-perm-card">
      <header className="ip-head">
        <span className="ip-tag">🔒 permission</span>
        <span className="ip-tool">{perm.tool}</span>
        {prompt?.agentId && <span className="ip-chip" title={prompt.agentId}>sub-agent</span>}
        {summary && <span className="ip-summary">{summary}</span>}
      </header>
      <ApprovalDeadline expiresAt={perm.expiresAt} />
      {prompt?.description && <p className="ip-desc">{prompt.description}</p>}
      {prompt?.blockedPath && <p className="ip-path"><span aria-hidden>📁</span> <code>{prompt.blockedPath}</code></p>}
      {perm.reason && <p className="ip-reason">{perm.reason}</p>}
      <pre className="ip-input">{JSON.stringify(perm.input, null, 2).slice(0, 1200)}</pre>
      <footer className="ip-actions">
        <PermissionActions kind={kind} suggestions={perm.suggestions} onRespond={onRespond} />
      </footer>
    </div>
  );
}

/**
 * Header subtitle: the cwd the session was opened in.
 *
 * The path is split into [leading dirs, last segment] so that only the HEAD
 * ellipsizes when the bar is narrow — the last segment is what actually
 * identifies the project, so it must never be the part that gets cut. (A
 * plain `text-overflow: ellipsis` on the whole path would eat exactly that.)
 * Full path (+ VPS name) stays available in the tooltip.
 */
function CwdSubtitle({ cwd, vpsName }: { cwd: string; vpsName?: string }) {
  const clean = cwd.replace(/\/+$/, '') || cwd;
  const cut = clean.lastIndexOf('/');
  const head = cut > 0 ? clean.slice(0, cut + 1) : '';
  const tail = cut > 0 ? clean.slice(cut + 1) : clean;
  return (
    <span className="bar-cwd" title={vpsName ? `${vpsName} · ${cwd}` : cwd}>
      {head && <span className="c-head">{head}</span>}
      <span className="c-tail">{tail}</span>
    </span>
  );
}

function ThinkingBar({
  line, toolCount, startedAt, tokens, responseSpeed, onInterrupt, label, compacting = false,
}: {
  /** What the turn is doing now (lib/liveActivity.ts); null = unknown: the
   *  provider's generic label. */
  line: LiveLine | null;
  /** Tool calls of this turn so far (hub-counted; tools shown or not). */
  toolCount: number;
  startedAt: number | null;
  tokens: number | null;
  responseSpeed: ResponseSpeedSnapshot | null;
  onInterrupt: () => void | Promise<void>;
  label?: string;
  /** The provider is summarising the conversation: no tool, speed or
   *  token figures describe that (they belong to the turn around it). */
  compacting?: boolean;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  void tick;
  const now = Date.now();
  const elapsed = startedAt ? Math.max(0, Math.floor(now / 1000 - startedAt)) : null;
  const step = compacting ? null : line;
  // The step's own clock, once it lasts — and only when it is not the turn's
  // (a turn still waiting for its first token would show the same time twice).
  const stepElapsed = step ? Math.max(0, Math.floor((now - step.since) / 1000)) : 0;
  const showStep = !!step && stepElapsed >= 3 && (startedAt == null || step.since / 1000 - startedAt > 2);
  const shownLabel = step?.label ?? label;
  return (
    <div className={`thinking-bar${compacting ? ' is-compacting' : ''}${step?.gated ? ' is-gated' : ''}`}>
      <span className="t-dot" aria-hidden="true" />
      <span key={shownLabel} className="t-label" title={shownLabel}>{shownLabel}</span>
      <button
        type="button"
        className="t-interrupt"
        onClick={() => { void onInterrupt(); }}
        title="Interrupt the current turn"
      >interrupt</button>
      {step && (step.detail || step.note || showStep || step.extra.length > 0) && (
        <span key={`${step.label}\n${step.since}`} className="t-now">
          {step.detail && <span className="t-detail" title={step.detail}>{step.detail}</span>}
          {step.note && <span className="t-note" title={step.note}>{step.note}</span>}
          {showStep && <span className="t-since" title="Time spent on this step">{fmtElapsed(stepElapsed)}</span>}
          {step.extra.map((x) => <span key={x} className="t-extra">{x}</span>)}
        </span>
      )}
      {compacting ? (
        <span className="t-meta">
          {elapsed != null && <>{fmtElapsed(elapsed)}</>}
        </span>
      ) : <span className="t-meta">
        <span className="t-speed" title="Live received SSE JSON payloads over the last 3 seconds, including reasoning and tools. Measured UTF-8 bytes; 1 kB = 1000 bytes. Excludes HTTP framing and compression.">
          ↓ {((responseSpeed?.bytesPerSecond ?? 0) / 1_000).toFixed(1)} kB/s
        </span>
        <span className="t-sdk-speed" title="Average generated output tokens reported by the SDK, divided by elapsed turn time (including reasoning, tools and waiting). Updates only on native counter reports; the age shows when the last report arrived. Waiting means no timed SDK report is available.">
          <span className="sep">·</span> {responseSpeed?.tokensPerSecond != null
            ? `${responseSpeed.tokensPerSecond.toFixed(1)} tok/s avg${(responseSpeed.sdkAgeSeconds ?? 0) >= 3 ? ` (${fmtElapsed(responseSpeed.sdkAgeSeconds!)} ago)` : ''}`
            : 'tok/s pending'}
        </span>
        {toolCount > 0 && <span className="t-step"><span className="sep">·</span> ⚒ {toolCount} tool{toolCount === 1 ? '' : 's'}</span>}
        {elapsed != null && <><span className="sep">·</span> {fmtElapsed(elapsed)}</>}
        {tokens != null && tokens > 0 && <span className="t-count"><span className="sep">·</span> ↑ {fmtTokens(tokens)} tokens</span>}
      </span>}
    </div>
  );
}

/** A turn's cost. Sub-cent turns are the common case, so two decimals would
 *  render most of them as "$0.00" — show enough digits to be a number. */
function fmtCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

function fmtElapsed(s: number): string {
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toString().padStart(2, '0')}s`;
}

// 14200 → "14.2k", 850 → "850" (mirrors Claude Code's terminal counter).
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
}

// The model the provider answered with INSTEAD of the selected one, or null.
// ONE rule for the runtime cell and every bubble's model chip, so both turn
// red together. Only the backend with a fallback model can substitute (a
// provider whose configured id is a ROUTER legitimately answers with another
// model, §14.102); "same model" is strict mode's rule (`sameModel`: an alias
// resolves to `claude-<alias>-…`), so the warning and §14.118 never disagree.
function substitutedModel(kind: AgentKind, model: string | null, effectiveModel: string | null): string | null {
  return supportsSessionCapability(kind, 'fallbackModel')
    && !!model && !!effectiveModel && !sameModel(model, effectiveModel) ? effectiveModel : null;
}

/** The phone header's gauges, reading the usage store themselves: a reading
 *  re-renders these rings only (app/usageStore.ts). */
function LiveUsageRings({ vpsId, profile, kind, ...rest }: {
  vpsId: string; profile: string; kind: AgentKind;
} & Omit<React.ComponentProps<typeof UsageRings>, 'usage' | 'kind'>) {
  const usage = useUsage(vpsId, asSessionProvider(kind), profile);
  return <UsageRings usage={usage} kind={kind} {...rest} />;
}

/** Direct choices use the same provider catalogs as the creation/settings forms. */
function SessionRuntimePanel({
  tokenUsage, vpsName, onUsageRefresh, usageAccountLabel, kind, accountProfile = "default", profileNumber, vpsId, model, fallbackModel, effort,
  ultracode = false, onSetUltracode, fastMode = false, fastModeVerdict = null, onSetFastMode,
  serviceTier = null, onSetServiceTier,
  modelPendingApply, effortPendingApply, effectiveModel,
  onSetModel, onSetEffort, onApplyNow, sessionId, endpoint, onEndpointChanged, context, accountSwitch,
  openRequest,
}: {
  /** `/model` or `/effort` with nothing after it: open that picker (a new
   *  nonce = a new request). */
  openRequest?: { which: 'model' | 'effort'; nonce: number } | null;
  /** Claude's ultracode switch beside effort (§14.56); no setter = no switch. */
  ultracode?: boolean;
  onSetUltracode?: (on: boolean) => Promise<void>;
  /** Claude's fast mode beside effort, offered unless the CLI refused it;
   *  no setter = no switch. */
  fastMode?: boolean;
  fastModeVerdict?: FastModeVerdict | null;
  onSetFastMode?: (on: boolean) => Promise<void>;
  /** Codex's speed tier (§14.59), offered when the model's catalog lists
   *  tiers; no setter = no control. */
  serviceTier?: string | null;
  onSetServiceTier?: (tier: string | null) => Promise<void>;
  accountSwitch: AccountSwitchTarget;
  profileNumber?: number;
  accountProfile?: string;
  sessionId: string; endpoint: EndpointState; onEndpointChanged: () => void;
  /** Context occupancy, closing the block as a full-width strip. A node rather
   *  than the reading itself: the gauge owns when it has nothing to say, and
   *  renders NOTHING then, so the panel keeps its three-cell height. */
  context?: React.ReactNode;
  tokenUsage: SessionTokenUsage | null;
  vpsName?: string | null;
  onUsageRefresh?: () => void;
  usageAccountLabel: string | null;
  kind: AgentKind;
  vpsId: string;
  model: string | null;
  fallbackModel: string | null;
  effort: string | null;
  modelPendingApply: boolean;
  effortPendingApply: boolean;
  effectiveModel: string | null;
  onSetModel: (m: string | null, fallback?: string | null) => Promise<void>;
  onSetEffort: (e: string | null) => Promise<void>;
  onApplyNow?: () => Promise<void> | void;
}) {
  // The account gauges come from the usage store HERE (app/usageStore.ts).
  const usage = useUsage(vpsId, asSessionProvider(kind), accountProfile);
  const speeds = useCodexSpeeds(vpsId, accountProfile, model || effectiveModel || '', !!onSetServiceTier);
  const [endpointOpen, setEndpointOpen] = useState(false);
  const [open, setOpen] = useState<'model' | 'effort' | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
  const effortButton = useRef<HTMLButtonElement>(null);

  function close() {
    (open === 'model' ? modelButton : effortButton).current?.focus({ preventScroll: true });
    setOpen(null);
  }
  useEffect(() => {
    if (!openRequest) return;
    setSaveError(null);
    setOpen(openRequest.which);
  }, [openRequest]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        (open === 'model' ? modelButton : effortButton).current?.focus({ preventScroll: true });
        setOpen(null);
      }
    };
    const onClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  async function choose(value: string) {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    const r = await outcome((async () => {
      if (open === 'model' && (value || null) !== model) {
        // Preserve the independently configured fallback only where the
        // backend HAS one; the others must not be sent a stale id.
        await onSetModel(value || null,
          supportsSessionCapability(kind, 'fallbackModel') ? fallbackModel : null);
        // A per-MODEL effort vocabulary does not survive its model: the knobs
        // the new one does not declare would keep travelling to the provider
        // and keep showing in a cell whose picker cannot offer them (§14.103).
        const prune = PROVIDER_CATALOGS[kind].pruneEffort;
        if (prune && effort) {
          const kept = await prune(vpsId, value || '', effort);
          if (kept !== effort) await onSetEffort(kept);
        }
      } else if (open === 'effort' && (value || null) !== (endpoint.active ? customEffort : effort)) {
        await onSetEffort(value || null);
        if (endpoint.active) onEndpointChanged();
      }
      close();
    })(), 'Could not save this selection.');
    if (!r.ok) setSaveError(r.message);
    setSaving(false);
  }

  const customEfforts = endpointParameters(endpoint.active, kind, model || '');
  const customEffort = endpoint.pending?.effort !== undefined ? endpoint.pending.effort : effort;
  const modelLabel = (model ?? effectiveModel ?? 'Default').replace(/^claude-/, '');
  // An effort that is a PARAMETER SET (`effort=high&fast=false`, the shape a
  // per-model reasoning axis stores — §14.103) is a list of knobs, not a word:
  // on one line the cell ellipsised the whole selection away to "effort…". The
  // provider owns that rendering (`EffortSummary`), because only its catalog
  // knows which knobs the selected model actually reads. Endpoint parameters
  // use the same stacked layout with their own catalog.
  const EffortSummary = endpoint.active ? undefined : PROVIDER_CATALOGS[kind].EffortSummary;
  // Ask the header for the wider centre track. The two cells that hold
  // sentences announce themselves in the DOM (`:has()` in app.css), but a
  // long MODEL id cannot: the panel's default 390px leaves the name cell about
  // sixteen characters, and `deepseek/deepseek-v4.1-flash` is cut while the row
  // around it is empty. An endpoint always asks, because it adds its own name
  // under an id that is usually a vendor-prefixed one.
  const wantsRoom = !!endpoint.active || modelLabel.length > 16;
  // The amber "your model was replaced" warning belongs to the ONE backend
  // that has a fallback model (`substitutedModel`).
  const mismatch = !!substitutedModel(kind, model, effectiveModel);
  // No provider test: both flags come from the provider's own
  // `applied_at_next_start`, which is authoritative and already false for a
  // backend that applies per turn.
  const anyPending = modelPendingApply || effortPendingApply || !!endpoint.pending;
  const showUltracode = ultracode && !endpoint.active && !!onSetUltracode;
  // Fast (Claude): on, and the CLI did not refuse it. Speed (Codex): the
  // tier in force when the model offers it; one it does not is dropped by
  // the CLI (standard speed), so the tag goes and the control stays.
  const fastRow = !!onSetFastMode && !endpoint.active && (fastMode || fastModeOffered(fastModeVerdict));
  const showFast = fastMode && fastRow && !fastModeBlocker(fastModeVerdict);
  const speed = codexSpeedOf(serviceTier, speeds?.defaultTier);
  const speedTier = speeds?.tiers.find((t) => t.id === speed);
  const speedRow = !!onSetServiceTier && !endpoint.active && (!!speeds || speed !== 'default');
  const speedTag = speedRow && speed !== 'default' && !!speedTier ? speedTier.name : null;
  // A switch saves in place: the popover stays open on its row.
  const saveInPlace = async (run: () => Promise<void>) => {
    if (saving) return;
    setSaving(true); setSaveError(null);
    const r = await outcome(run(), 'Could not save this setting.');
    if (!r.ok) setSaveError(r.message);
    setSaving(false);
  };
  const EffortSwitches = endpoint.active ? undefined : PROVIDER_CATALOGS[kind].EffortSwitches;
  const title = `Model: ${model ?? 'default'}${effectiveModel ? ` · effective: ${effectiveModel}` : ''}${anyPending ? ' · pending until resume' : ''}`;
  const pickerProps = { presentation: 'list' as const, disabled: saving, onChange: choose };
  const toggle = (target: 'model' | 'effort') => {
    setSaveError(null);
    setOpen((current) => current === target ? null : target);
  };

  return (
    <div className={`session-runtime-panel${endpoint.active ? ' has-endpoint' : ''}${endpoint.active && (!hasEffortAxis(kind) || customEfforts.length === 0) ? ' without-effort' : ''}${wantsRoom ? ' wants-room' : ''}`} role="group" aria-label="Model, effort and usage">
      <div className="runtime-config" ref={popRef}>
        <button ref={modelButton} type="button" className={`runtime-cell runtime-model${mismatch ? ' has-mismatch' : ''}${anyPending ? ' has-pending' : ''}`}
          onClick={() => toggle('model')} disabled={saving} title={title} aria-label="Change model" aria-haspopup="menu" aria-expanded={open === 'model'}>
          <span className="runtime-value"><AgentLogo kind={kind} profileNumber={profileNumber} size={15} endpointName={endpoint.active?.name} title="" /><span>{modelLabel}</span>{anyPending && <span className="runtime-pending" aria-label="Pending change">•</span>}</span>
          {endpoint.active && <span className="runtime-effective">{endpoint.active.name}</span>}
          {!!model && !!effectiveModel && effectiveModel !== model && <span className="runtime-effective">→ {effectiveModel}</span>}
        </button>
        {/* Only a backend with a real effort AXIS gets the control — a provider
            with none would otherwise show furniture claiming a setting exists.
            `hasEffortAxis`, never `efforts.length`: an empty list also describes
            a ladder declared PER MODEL (Cursor's, §14.103), which the control
            fills from the selection beside it. */}
        {hasEffortAxis(kind) && (!endpoint.active || customEfforts.length > 0) && (
          <button ref={effortButton} type="button" className={`runtime-cell runtime-effort${anyPending ? ' has-pending' : ''}`}
            onClick={() => toggle('effort')} disabled={saving} title={`Effort: ${effort ?? 'default'}${showUltracode ? ' · ultracode on' : ''}${showFast ? ' · fast on' : ''}${speedTag ? ` · speed: ${speedTag}` : ''}`} aria-label="Change effort" aria-haspopup="menu" aria-expanded={open === 'effort'}>
            <span className="runtime-value">
              <span className="runtime-effort-symbol" aria-hidden="true">✦</span>
              {endpoint.active ? <EndpointEffortSummary endpoint={endpoint.active} kind={kind} model={model || ''} effort={customEffort} /> : EffortSummary
                ? <EffortSummary vpsId={vpsId} modelId={model || effectiveModel || ''} effort={effort} />
                : <span>{effort ?? 'Default'}</span>}
            </span>
            {/* Ultracode (§14.56) rides with effort: its badge sits right under
                the effort it is switched from. */}
            {showUltracode && <span className="runtime-switch-tag" title="Ultracode on: big tasks run as dynamic workflows of parallel agents">ultracode</span>}
            {showFast && <span className="runtime-switch-tag tone-info" title={CLAUDE_FAST_HINT}>fast</span>}
            {speedTag && <span className="runtime-switch-tag tone-info" title={speedTier?.hint}>{speedTag.toLowerCase()}</span>}
          </button>
        )}
        {/* The popover kit (app.css § Popover kit): a head, then one tile per
            block — the account tiles, then the catalog with its own filter. */}
        {open && <div className="runtime-choice-popover pop-kit" aria-busy={saving}>
          <div className="pop-head">
            <span className="pop-title">{open === 'model' ? 'Model' : 'Effort'}</span>
            {open === 'model' && supportsCustomEndpoint(kind) && <>
              <button type="button" className="pop-action" onClick={() => { close(); setEndpointOpen(true); }}>⚯ {endpoint.active ? 'Change endpoint…' : 'Custom endpoint…'}</button>
              {endpoint.active && <button type="button" className="pop-action" disabled={saving} onClick={async () => {
                setSaving(true); setSaveError(null);
                const r = await outcome(api.setSessionEndpoint(sessionId, { endpoint: null }).then(() => { onEndpointChanged(); close(); }),
                  'Could not restore connection.');
                if (!r.ok) setSaveError(r.message);
                setSaving(false);
              }}>Return to standard connection</button>}
            </>}
            {endpoint.active?.usageUrl && <a className="pop-action" href={endpoint.active.usageUrl} target="_blank" rel="noopener noreferrer">Open usage ↗</a>}
          </div>
          {open === 'model' && !endpoint.active && <SessionAccountChoice target={accountSwitch} kind={kind}
            disabled={saving} onSwitched={close} />}
          {endpoint.pending && <p className="runtime-choice-note">Connection change queued until current work finishes. <button type="button" onClick={async () => { try { await api.setSessionEndpoint(sessionId, { cancelPending: true }); onEndpointChanged(); } catch (e) { setSaveError(e instanceof Error ? e.message : 'Could not cancel change.'); } }}>Cancel change</button></p>}
          {endpoint.error && <p role="alert" className="runtime-choice-error">{endpoint.error}</p>}

          {/* One control per backend, resolved through PROVIDER_CATALOGS
              (§14.102) — the header must never offer a catalog the session's
              provider cannot run. */}
          <div className="pop-tile pop-tile-list">
            {open === 'model' && <div className="pop-tile-label">Models</div>}
            {(() => {
              const { Model, Effort } = PROVIDER_CATALOGS[kind];
              if (endpoint.active) {
                if (open === 'effort') return <EndpointEffortPicker endpoint={endpoint.active} kind={kind} model={model || ''} effort={customEffort} disabled={saving} onChange={choose} />;
                return <EndpointModelPicker endpoint={endpoint.active} kind={kind} presentation="list" value={model || ''} disabled={saving} onChange={choose} />;
              }

              return open === 'model'
                ? <Model accountProfile={accountProfile} {...pickerProps} vpsId={vpsId} value={model ?? ''} />
                : <Effort accountProfile={accountProfile} {...pickerProps} vpsId={vpsId} value={effort ?? ''}
                    modelId={model || effectiveModel || ''} />;
            })()}
          </div>
          {open === 'effort' && onSetUltracode && !endpoint.active && (
            <SwitchRow className="pop-tile runtime-switch" label="Ultracode" glyph="✦" on={ultracode} disabled={saving}
              hint={`${providerText.ultracodeHint(kind)} Applies at the next start.`}
              onFlip={(on) => void saveInPlace(() => onSetUltracode(on))} />
          )}
          {open === 'effort' && fastRow && onSetFastMode && (
            <SwitchRow className="pop-tile runtime-switch" label="Fast" glyph="»" tone="info" on={fastMode} disabled={saving}
              title={CLAUDE_FAST_HINT}
              hint={fastMode ? fastModeBlocker(fastModeVerdict) ?? 'Applies at the next start.' : 'Applies at the next start.'}
              onFlip={(on) => void saveInPlace(() => onSetFastMode(on))} />
          )}
          {open === 'effort' && speedRow && onSetServiceTier && (
            <SpeedRow className="pop-tile runtime-switch" tiers={speeds?.tiers ?? [{ id: 'default', name: 'Standard' }]}
              value={speed} disabled={saving}
              hint={speed !== 'default' && speeds && !speedTier ? 'Not offered by this model' : undefined}
              onChange={(tier) => void saveInPlace(() => onSetServiceTier(tier === speeds?.defaultTier ? null : tier))} />
          )}
          {open === 'effort' && EffortSwitches && (
            <EffortSwitches vpsId={vpsId} modelId={model || effectiveModel || ''} value={effort ?? ''} disabled={saving}
              className="pop-tile runtime-switch"
              onChange={(v) => void saveInPlace(() => onSetEffort(v || null))} />
          )}
          {open === 'model' && endpoint.active && isOpenCodeGo(endpoint.active.baseUrl) && <p className="runtime-choice-note">Catalog: Models.dev. Go limits, promotions and time-based rates may differ.</p>}
          {saveError && <p className="runtime-choice-error" role="alert">{saveError}</p>}
          {(modelPendingApply || effortPendingApply) && !endpoint.pending && onApplyNow && <button type="button" className="runtime-apply" disabled={saving} onClick={async () => {
            setSaving(true); setSaveError(null);
            const r = await outcome(Promise.resolve().then(onApplyNow).then(() => close()), 'Could not apply the change.');
            if (!r.ok) setSaveError(r.message);
            setSaving(false);
          }}>↻ Apply pending changes</button>}
        </div>}
      </div>
      {endpoint.active ? <SessionTokenMeter usage={tokenUsage} usageUrl={endpoint.active.usageUrl} /> : <UsageMeter usage={usage} vpsName={vpsName} runtime onRefresh={onUsageRefresh} kind={kind} accountLabel={usageAccountLabel} switchTarget={accountSwitch} />}
      {context}
      {endpointOpen && supportsCustomEndpoint(kind) && <CustomEndpointModal sessionId={sessionId} engine={kind} vpsId={vpsId} initial={endpoint.active} onClose={() => setEndpointOpen(false)} onApplied={onEndpointChanged} />}
    </div>
  );
}
