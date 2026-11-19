'use client';

// The desk: Charon's fleet as a game board, and the HUD laid over it.
//
// ─── Where the data comes from ──────────────────────────────────────────────
//  1. Charon's summary store (`app/sync/summaryStore.ts`, §14.108) — THE same
//     `useSessionList()` as the sidebar: status, unread marker, pending gates.
//     Seeded by the page, kept live by `session_summary` frames, reconciled by
//     a resync or the 60 s poll. The desk patches nothing.
//  2. `session_activity` frames (lib/sessionActivity.ts) — what each session is
//     doing right now. Tool calls and text are focus-routed, so the hub folds
//     them into one small LOW digest per session while a desk is watching; the
//     snapshot GET is both the first paint and the heartbeat that keeps them
//     coming.
//  3. The page's own props (machines, folders) and the VPS slice of the store.
//
// ─── One island at a time ───────────────────────────────────────────────────
// The board shows a SCENE: one machine's island (the default — the desk opens
// on the last one visited, else on the one that most wants you) or the map.
// The selector, the number keys and every "go to this robot" travel between
// them; what happens on the other islands is told by the selector's cards,
// the quest log and the counters, which stay fleet-wide.
//
// ─── The dependency points one way ──────────────────────────────────────────
// `app/desk/**` imports `@/app/**` and `@/lib/**`; nothing imports the desk.
// What a session may receive is never decided here: every action is the route
// Charon's own UI calls, behind Charon's own guards.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileLinkContext } from '@/app/Message';
import {
  initSyncPosition, isDegraded, setFocus, subscribeAll, subscribeReconnect,
} from '@/app/globalEventStream';
import {
  addOverlay, hydrateSummaries, seedFromListResponse, useSessionList, useVpsRuntime,
} from '@/app/sync/summaryStore';
import { createRerunner } from '@/app/sync/revResource';
import ConfirmModal from '@/app/ConfirmModal';
import dynamic from '@/app/dynamic';
import { getDraft, subscribeDrafts } from '@/app/inputDraftStore';
import NewSessionWizard from '@/app/NewSessionWizard';
import { useCacheTick } from '@/app/PromptCacheMarks';
import { useStableCallback } from '@/app/useStable';
import PromptModal from '@/app/PromptModal';
import ResetsModalHost from '@/app/ResetsModalHost';
import SessionContextMenu from '@/app/SessionContextMenu';
import TabNotificationBadge from '@/app/TabNotificationBadge';
import { writeWorkspacePanelTab } from '@/app/workspacePanelState';
import { canResumeSession, canSleepSession } from '@/app/sessionBulkActions';
import { useShowHidden } from '@/app/showPaused';
import { sidebarPathKey } from '@/app/sidebarPathGroups';
import { accountProfileId, DEFAULT_ACCOUNT_PROFILE } from '@/lib/accountProfiles';
import { api } from '@/lib/api';
import { isCacheWarm, sessionCacheReading } from '@/lib/promptCache';
import { attentionForRow } from '@/lib/sessionAttention';
import { asSessionProvider, type SessionProvider } from '@/lib/sessionCapabilities';
import type { SessionActivity } from '@/lib/sessionActivity';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { SyncStamp } from '@/lib/sync/protocol';
import type { AgentKind, Vps, VpsFolder, VpsPath } from '@/lib/types/api';
import { dropActivity, putActivity, replaceActivities } from './activityStore';
import { readBest, useArcade } from './arcadeStore';
import { Game, type Pick, type Scene } from './game/game';
import { agentName, folderOf, moodOf, teamTint, wantsYou, type Mood } from './game/model';
import { homeIsland, islandsOf } from './islands';
import { questsOf, type Quest } from './quests';
import { setSound, sfx } from './sound';
import ArcadeHud from './ui/ArcadeHud';
import Help from './ui/Help';
import IslandBar from './ui/IslandBar';
import LimitsPanel from './ui/LimitsPanel';
import QuestLog from './ui/QuestLog';
import SessionModal from './ui/SessionModal';
import TopBar, { type Tally } from './ui/TopBar';
import { CHARON_LAYER, type DrawerHost, type DrawerSibling } from './ui/drawerHost';
import { makeDeskFileLinks } from './ui/fileLinks';
import UnitPanel from './ui/UnitPanel';

// The safety net keeps Charon's own rhythm (§14.24): 60 s, 15 s on a hub too
// old to publish summaries.
// Rare dialogs, in their own chunks (as HubPanel loads them).
const AccountLoginModal = dynamic(() => import('@/app/AccountLoginModal'), { ssr: false });
const RoutinesModal = dynamic(() => import('@/app/RoutinesModal'), { ssr: false });

const POLL_MS = 60_000;
const POLL_DEGRADED_MS = 15_000;
/** A beat older than this is state, not news: no effect is replayed for it. */
const FRESH_MS = 5_000;

type Props = {
  vpsList: Vps[];
  folders: VpsFolder[];
  vpsPaths?: VpsPath[];
  initialSummaries: SessionSummary[];
  initialSync: (SyncStamp & { buildId: string }) | null;
  initialActivity?: Record<string, SessionActivity>;
};

type Feed = { key: number; at: number; text: string; tone: 'ask' | 'done' | 'fail' | 'work'; sessionId: string };

function flag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function keep(key: string, value: boolean): void {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* private mode */ }
}

const SCENE_KEY = 'desk.scene';

/** Charon's own layers over the board (its modals, the runtime popover, a
 *  picker list, the upload gate): while one is in the DOM, every key is its. */
/** The permission card the drawer SHOWS (unfolded). Y / N click its own
 *  buttons, so the key can only answer what is on screen. */
const SHOWN_PERMISSION = '.dk-unit .dk-sv .pz-wrap.permission:not(.is-collapsed) .ip-actions';
/** A just-made session (a fork) is waited for this long, then given up. */
const GO_WAIT_MS = 10_000;
/** A second Y / N on the same gate within this is the first one's echo, not a retry. */
const ANSWER_GUARD_MS = 3_000;

type RoutineDraft = { vpsId: string; cwd: string; kind: AgentKind; prompt: string };

function recall(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export default function Desk({ vpsList, folders, vpsPaths = [], initialSummaries, initialSync, initialActivity }: Props) {
  // Like `HubPanel`: the store is seeded from the page on first render, and the
  // stream's first connection resumes from that revision (§9).
  initSyncPosition(initialSync);
  hydrateSummaries(initialSummaries, initialSync);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  // The drawer's order box = Charon's composer textarea (SessionView `composerRef`).
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const gameRef = useRef<Game | null>(null);
  // The same game, as state: the selector's miniatures attach to it once it exists.
  const [game, setGame] = useState<Game | null>(null);

  const all = useSessionList(initialSummaries);
  const runtime = useVpsRuntime();
  const vps = useMemo(() => vpsList.map((row) => {
    const live = runtime.get(row.id);
    return live ? { ...row, ...live } as Vps : row;
  }), [vpsList, runtime]);
  const vpsById = useMemo(() => new Map(vps.map((v) => [v.id, v] as const)), [vps]);

  const [showSleeping, setShowSleeping] = useState(() => flag('desk.sleeping', true));
  const [sound, setSoundOn] = useState(() => flag('desk.sound', false));
  // The mini-game (game/arcade.ts): on while a run lasts; its best score.
  const arcade = useArcade();
  const [best, setBest] = useState(0);
  useEffect(() => { setBest(readBest()); }, [arcade.on, arcade.record]);
  // Open by default, except where it would cover half of a small screen.
  const [questsOpen, setQuestsOpen] = useState(() => flag('desk.quests', window.innerWidth > 820));
  const [limitsOpen, setLimitsOpen] = useState(() => flag('desk.limits', window.innerWidth > 820));
  const [zoom, setZoom] = useState(2);
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [feed, setFeed] = useState<Feed[]>([]);

  const [pick, setPick] = useState<Pick | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // The wizard for a new agent: on that machine, in that folder (null: to be chosen).
  const [recruit, setRecruit] = useState<{ vpsId: string | null; cwd: string | null } | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  // The session whose @handle is being changed (Charon's PromptModal).
  const [handling, setHandling] = useState<string | null>(null);
  // Charon's sign-in, for one session's account; `n` remounts it on each ask.
  const [loginFor, setLoginFor] = useState<{ n: number; provider: SessionProvider; accountId: string | null } | null>(null);
  // `/routine`: Charon's Routines modal on a new routine prefilled from the drawer.
  const [routineDraft, setRoutineDraft] = useState<RoutineDraft | null>(null);
  // A robot asked for before its summary landed (a fork just made).
  const [pendingGo, setPendingGo] = useState<{ id: string; full: boolean } | null>(null);
  // The hub sidebar's own hidden switch (one setting, one meaning): on = the
  // hidden robots ONLY, off = none of them (§14.118).
  const [hiddenShown, toggleHidden] = useShowHidden();

  const sessions = useMemo(
    () => all.filter((s) => (s.hidden === 1) === hiddenShown && (showSleeping || moodOf(s) !== 'sleep')),
    [all, showSleeping, hiddenShown],
  );
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s] as const)), [sessions]);
  const quests = useMemo(() => questsOf(sessions), [sessions]);
  // The sessions that want you — finished unread, failed unread, waiting on an
  // answer: the count the hub's own tab wears (HeaderSessionNav), by the same
  // predicate. It goes on this tab's favicon and title too.
  const wanting = useMemo(() => sessions.filter((s) => attentionForRow(s) != null).length, [sessions]);
  // The page's own title, as the server wrote it (pages.ts): the count goes before it.
  const [pageTitle] = useState(() => document.title);
  const tally = useMemo(() => {
    const t: Tally = { blocked: 0, question: 0, done: 0, error: 0, work: 0, bg: 0, idle: 0, sleep: 0 };
    for (const s of sessions) t[moodOf(s)] += 1;
    return t;
  }, [sessions]);

  // The warm prompt caches (lib/promptCache.ts), on the app's shared 30 s
  // clock: the one that goes cold first leads, the running turns close.
  const cacheNow = useCacheTick(true);
  const warm = useMemo(() => sessions
    .map((s) => ({ id: s.id, reading: sessionCacheReading(s, cacheNow) }))
    .filter((w) => isCacheWarm(w.reading))
    .sort((a, b) => (a.reading!.phase === 'live' ? 1 : 0) - (b.reading!.phase === 'live' ? 1 : 0)
      || a.reading!.remainingMs - b.reading!.remainingMs)
    .map((w) => w.id), [sessions, cacheNow]);

  // The islands, in the selector's order: the inhabited ones, then the rest.
  const islands = useMemo(() => islandsOf(sessions, vps, folders), [sessions, vps, folders]);
  const inhabited = useMemo(() => islands.filter((i) => i.total > 0), [islands]);
  const travelOrder = useMemo(
    () => [...inhabited, ...islands.filter((i) => i.total === 0)].map((i) => i.id),
    [islands, inhabited],
  );
  const [scene, setScene] = useState<Scene | null>(() => {
    const remembered = recall(SCENE_KEY);
    if (remembered === 'map') return { kind: 'map' };
    const home = homeIsland(islandsOf(initialSummaries.filter((s) => (s.hidden === 1) === hiddenShown), vpsList, folders), remembered);
    return home ? { kind: 'island', id: home } : null;
  });
  const sceneRef = useRef(scene);
  const slideRef = useRef<-1 | 0 | 1>(0);
  const lastIsland = useRef<string | null>(scene?.kind === 'island' ? scene.id : null);

  const selectedId = pick?.kind === 'agent' ? pick.id : null;
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const open = openId ? byId.get(openId) ?? all.find((s) => s.id === openId) ?? null : null;
  const menuSession = menu ? byId.get(menu.id) ?? null : null;
  const renamingSession = renaming ? byId.get(renaming) ?? null : null;
  const deletingSession = deleting ? byId.get(deleting) ?? null : null;
  const handlingSession = handling ? byId.get(handling) ?? null : null;
  const modal = Boolean(open || help || recruit || renaming || deleting || handlingSession || loginFor || routineDraft);
  // The selected robot's team (sub-sessions): who it works for, who works for
  // it, and the colour of their rug — its root's, as on the board.
  const selectedLead = selected?.parentSessionId ? byId.get(selected.parentSessionId) ?? null : null;
  const selectedCrew = useMemo(
    () => (selectedId ? sessions.filter((s) => s.parentSessionId === selectedId) : []),
    [sessions, selectedId],
  );
  const selectedTint = useMemo(() => {
    if (!selected || (!selectedLead && !selectedCrew.length)) return null;
    let root = selected;
    for (let hops = 0; hops < 8 && root.parentSessionId; hops += 1) {
      const up = byId.get(root.parentSessionId);
      if (!up || up.vpsId !== root.vpsId) break;
      root = up;
    }
    return teamTint(root);
  }, [selected, selectedLead, selectedCrew, byId]);


  /* ─────────────────────────────────────────────────────────── the board ── */

  const select = useCallback((next: Pick | null) => setPick(next), []);

  /** Show another scene. The camera slides in from the side the island is on. */
  const travel = useCallback((next: Scene) => {
    const now = sceneRef.current;
    if (now && now.kind === next.kind && (next.kind === 'map' || (now.kind === 'island' && now.id === next.id))) return;
    const at = (s: Scene | null) => (s?.kind === 'island' ? travelOrder.indexOf(s.id) : -1);
    const from = at(now);
    const to = at(next);
    slideRef.current = from >= 0 && to >= 0 ? (to > from ? 1 : -1) : 0;
    sceneRef.current = next;
    if (next.kind === 'island') lastIsland.current = next.id;
    try { localStorage.setItem(SCENE_KEY, next.kind === 'map' ? 'map' : next.id); } catch { /* private mode */ }
    setScene(next);
    setMenu(null);
    // What was selected on the island left behind stays there.
    setPick(null);
  }, [travelOrder]);

  /** Go to a robot, wherever it is: its island comes on stage, it is selected. */
  const visit = useCallback((id: string) => {
    const session = byId.get(id);
    if (!session) return;
    travel({ kind: 'island', id: session.vpsId });
    setPick({ kind: 'agent', id });
  }, [byId, travel]);

  // The engine's callbacks are bound once: they read the latest through refs.
  const travelRef = useRef(travel);
  travelRef.current = travel;

  const toggleSound = useCallback(() => {
    setSoundOn((on) => { setSound(!on); keep('desk.sound', !on); return !on; });
  }, []);

  /** The mini-game's button: a run on the island on stage, or the end of one. */
  const play = useCallback(() => {
    const board = gameRef.current;
    if (!board) return;
    if (board.arcadeOn) { board.stopArcade(); return; }
    // The keyboard is the game's: nothing selected, no field holding the caret.
    setPick(null);
    setMenu(null);
    (document.activeElement as HTMLElement | null)?.blur?.();
    // The click is the gesture a browser wants before it plays a sound: the
    // desk's own cues, when they are on (the game has its own sound, and its
    // own switch — the M key).
    if (sound) setSound(true);
    if (!board.startArcade()) setError('Pick an island with robots first.');
  }, [sound]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const board = new Game(stage, {
      onPick: (next, how, x, y) => {
        if (how === 'menu') {
          if (next?.kind === 'agent') { setPick(next); setMenu({ id: next.id, x, y }); }
          else setMenu(null);
          return;
        }
        setMenu(null);
        // On the map, a click on an island goes there (and keeps the robot it hit).
        if (sceneRef.current?.kind === 'map' && next) {
          const vpsId = next.kind === 'vps' ? next.id : next.kind === 'agent' ? board.islandOf(next.id) : next.vpsId;
          if (vpsId) travelRef.current({ kind: 'island', id: vpsId });
          setPick(next.kind === 'agent' ? next : null);
          return;
        }
        // A "+": a new agent there — that deck's folder, or one to choose.
        if (next?.kind === 'spawn') {
          setRecruit({ vpsId: next.vpsId, cwd: next.cwd === '~' ? null : next.cwd });
          return;
        }
        // On an island only a robot is selected: a click on a deck, the grass
        // or the water lets go of the one that was.
        setPick(next?.kind === 'agent' ? next : null);
        if (how === 'double' && next?.kind === 'agent') setOpenId(next.id);
      },
      onZoom: setZoom,
    });
    gameRef.current = board;
    setGame(board);
    board.attachMinimap(minimapRef.current);
    // A debugging handle, nothing more: `window.desk` in the console.
    (window as unknown as { desk?: Game }).desk = board;
    board.start();
    return () => {
      delete (window as unknown as { desk?: Game }).desk;
      board.dispose();
      gameRef.current = null;
      setGame(null);
    };
  }, []);

  // What the HUD covers, told to the board BEFORE it frames anything: the
  // island is centred in what is left (under the two top rows, right of the
  // quest log when it is open).
  useEffect(() => {
    const measure = () => {
      const board = gameRef.current;
      if (!board) return;
      const head = headRef.current?.getBoundingClientRect();
      // The left column (quest log, limits) stands on the left of a wide
      // screen, lies at the foot of a narrow one (≤820px, desk.css). Folded,
      // both are a title each: nothing to keep clear of.
      const narrow = window.innerWidth <= 820;
      const column = questsOpen || limitsOpen ? document.querySelector('.dk-left')?.getBoundingClientRect() : null;
      board.setSafeArea({
        left: column && !narrow ? Math.round(column.right + 10) : 0,
        top: head ? Math.round(head.bottom + 6) : 0,
        right: 0,
        bottom: column && narrow ? Math.round(window.innerHeight - column.top + 8) : 8,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (headRef.current) observer.observe(headRef.current);
    const column = document.querySelector('.dk-left');
    if (column) observer.observe(column);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [questsOpen, limitsOpen]);

  useEffect(() => {
    gameRef.current?.setModel({ sessions, vps, folders });
  }, [sessions, vps, folders]);

  useEffect(() => {
    if (!scene) return;
    gameRef.current?.setScene(scene, slideRef.current);
    slideRef.current = 0;
  }, [scene]);

  // The eye turned (or its stored state just arrived): an island left without
  // a robot is not where to stand while others have some.
  const eyeSeen = useRef(hiddenShown);
  useEffect(() => {
    if (eyeSeen.current === hiddenShown) return;
    eyeSeen.current = hiddenShown;
    const now = sceneRef.current;
    if (now?.kind !== 'island' || islands.some((i) => i.id === now.id && i.total > 0)) return;
    const home = homeIsland(inhabited, null);
    if (home) travel({ kind: 'island', id: home });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenShown]);

  // A machine that left the fleet cannot stay on stage.
  useEffect(() => {
    if (scene?.kind === 'map') return;
    if (scene && islands.some((i) => i.id === scene.id)) return;
    const home = homeIsland(islands, null);
    if (home) travel({ kind: 'island', id: home });
  }, [scene, islands, travel]);

  // Robots with an order typed and not sent wear a pencil: the draft store
  // only speaks when a session starts or stops holding text.
  useEffect(() => {
    const mark = () => gameRef.current?.setDrafts(new Set(sessions.filter((s) => getDraft(s.id).trim()).map((s) => s.id)));
    mark();
    return subscribeDrafts(mark);
  }, [sessions]);

  // The selection, on the board: brackets, and the robot kept clear of the
  // drawer that just opened over the right of the stage (the view goes back
  // once nothing is selected).
  useEffect(() => {
    const board = gameRef.current;
    if (!board) return;
    board.select(pick);
    if (pick?.kind === 'agent') {
      // The drawer stands on the right of a wide screen, lies at the foot of
      // a narrow one (desk.css). Its own size, not its box: it slides in.
      const panel = document.querySelector<HTMLElement>('.dk-unit');
      const side = window.innerWidth > 820;
      board.reveal(pick.id, !panel ? {} : side ? { right: panel.offsetWidth + 20 } : { bottom: panel.offsetHeight + 20 });
    } else if (!pick) board.rest();
  }, [pick, scene]);

  // The keyboard belongs to whatever is open on top of the board.
  useEffect(() => { gameRef.current?.setInputEnabled(!modal); }, [modal]);

  // A selection whose session left the board is no selection.
  useEffect(() => {
    if (selectedId && !byId.has(selectedId)) select(null);
  }, [selectedId, byId, select]);

  /* ──────────────────────────────────────────────────────────────── data ── */

  const [lister] = useState(() => createRerunner(async () => {
    try {
      seedFromListResponse(await api.listSessions());
      setError(null);
      setLive(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLive(false);
    }
  }));
  const refresh = useCallback(() => { void lister.trigger(); }, [lister]);
  const refreshIfDegraded = useCallback(() => { if (isDegraded()) refresh(); }, [refresh]);

  /** The activity snapshot: first paint, backstop, and the hub's heartbeat. */
  const pullActivity = useCallback(() => {
    api.getDeskActivity().then((r) => {
      replaceActivities(r.activity ?? {});
      gameRef.current?.setActivities(r.activity ?? {});
    }).catch(() => { /* an older hub: the board simply shows no detail */ });
  }, []);

  useEffect(() => {
    if (initialActivity) {
      replaceActivities(initialActivity);
      gameRef.current?.setActivities(initialActivity);
    }
    refresh();
    pullActivity();
    let lastAt = Date.now();
    const timer = setInterval(() => {
      if (document.hidden) return;
      const every = isDegraded() ? POLL_DEGRADED_MS : POLL_MS;
      if (Date.now() - lastAt < every - 1_000) return;
      lastAt = Date.now();
      refresh();
      pullActivity();
    }, POLL_DEGRADED_MS);
    const onVisible = () => {
      if (document.hidden) return;
      lastAt = Date.now();
      refresh();
      pullActivity();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // `initialActivity` is the page seed: read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, pullActivity]);

  useEffect(() => {
    const off = subscribeAll((event) => {
      if (isDegraded() && (event.type === 'session_list_changed' || event.type === 'status'
        || event.type === 'session_unread' || event.type === 'permission_request'
        || event.type === 'user_question' || event.type === 'exit_plan_request'
        || event.type === 'interaction_resolved')) {
        refresh();
      }
      if (event.type !== 'session_activity') return;
      const id = event.sessionId;
      const activity = event.activity;
      putActivity(id, activity);
      gameRef.current?.beat(id, activity, Date.now() - activity.at < FRESH_MS);
    });
    // A reconnect resumes (nothing lost) or resyncs (the store gets the
    // snapshot); the activity digest is not in either, so it is pulled again.
    const offReconnect = subscribeReconnect(() => { setLive(true); pullActivity(); });
    return () => { off(); offReconnect(); };
  }, [refresh, pullActivity]);

  // What just happened, read off the moods changing: the feed and the cues.
  const moods = useRef<Map<string, Mood> | null>(null);
  const feedKey = useRef(0);
  useEffect(() => {
    const before = moods.current;
    const now = new Map<string, Mood>();
    const news: Feed[] = [];
    let cue: 'quest' | 'done' | 'fail' | null = null;
    for (const s of sessions) {
      const mood = moodOf(s);
      now.set(s.id, mood);
      const was = before?.get(s.id);
      if (!before || was === mood) continue;
      const name = agentName(s);
      const add = (text: string, tone: Feed['tone']) => {
        feedKey.current += 1;
        news.push({ key: feedKey.current, at: Date.now(), text, tone, sessionId: s.id });
      };
      if (mood === 'blocked' || mood === 'question') { add(`${name} needs you`, 'ask'); cue = 'quest'; }
      else if (mood === 'done') { add(`${name} finished`, 'done'); cue ??= 'done'; }
      else if (mood === 'error') { add(`${name} failed`, 'fail'); cue ??= 'fail'; }
      else if (mood === 'work' && was !== 'blocked' && was !== 'bg') add(`${name} started working`, 'work');
      if (mood !== 'work' && mood !== 'bg' && mood !== 'blocked') dropActivity(s.id);
    }
    moods.current = now;
    if (news.length) setFeed((list) => [...list, ...news].slice(-6));
    if (cue) sfx[cue]();
  }, [sessions]);

  // Feed lines fade on their own.
  useEffect(() => {
    if (!feed.length) return undefined;
    const timer = setTimeout(() => setFeed((list) => list.filter((f) => Date.now() - f.at < 9_000)), 2_000);
    return () => clearTimeout(timer);
  }, [feed]);

  /* ───────────────────────────────────────────────────────────── actions ── */

  // Watching a session — opened in full, or its conversation in the drawer —
  // is focusing it: the same route Charon calls, the one its live frames
  // follow. LEAVING it is the read receipt (§14.47). The desk owns the focus:
  // the drawer's transcript focuses on mount, and nothing else lets go of it.
  const watchedId = openId ?? selected?.id ?? null;
  useEffect(() => {
    if (!watchedId) { void setFocus(null); return; }
    if (document.visibilityState !== 'visible') return;
    void setFocus(watchedId);
  }, [watchedId]);

  const fail = useCallback((what: string, e: unknown) => {
    setError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  }, []);

  /** A quest settled from the desk: the small cue that says so. */
  const cleared = useCallback(() => { sfx.act(); }, []);

  /** Run one action on a quest; the card stays disabled until it settles. */
  const during = useCallback(async (key: string, run: () => Promise<unknown>) => {
    setBusy((set) => new Set(set).add(key));
    try {
      await run();
    } finally {
      setBusy((set) => { const next = new Set(set); next.delete(key); return next; });
    }
  }, []);

  // Pessimistic on purpose (§14.18): the quest leaves when the summary says
  // the gate is gone, never before.
  const onPermission = useCallback((quest: Quest, allow: boolean) => {
    if (!quest.gate) return;
    void during(quest.key, () => api.respondPermission(quest.sessionId, quest.gate!.id, allow))
      .then(() => { cleared(); refreshIfDegraded(); }, (e) => fail(allow ? 'allow' : 'deny', e));
  }, [during, cleared, refreshIfDegraded, fail]);

  const onRead = useCallback((id: string) => {
    const overlay = addOverlay(id, { unreadStop: 0 });
    void during(`${id}:read`, () => api.markSessionRead(id).then((r) => overlay.ack(r?.sync)))
      .then(() => { cleared(); refreshIfDegraded(); }, (e) => { overlay.fail(); fail('read', e); });
  }, [during, cleared, refreshIfDegraded, fail]);

  const lifecycle = useCallback((action: 'sleep' | 'resume' | 'stop', id: string) => {
    const call = action === 'sleep' ? api.sleepSession : action === 'resume' ? api.resumeSession : api.interruptSession;
    void call(id).then(() => refreshIfDegraded(), (e: unknown) => fail(action, e));
  }, [refreshIfDegraded, fail]);

  const deleteOne = useCallback(async (id: string) => {
    const r = await api.deleteAgentSession(id);
    addOverlay(id, { removed: true }).ack(r?.sync);
    setOpenId((current) => (current === id ? null : current));
    refreshIfDegraded();
  }, [refreshIfDegraded]);

  const applyRename = useCallback(async (id: string, name: string) => {
    const overlay = addOverlay(id, { name: name || null });
    try {
      const r = await api.renameAgentSession(id, name || null);
      overlay.ack(r?.sync);
    } catch (e) {
      overlay.fail();
      throw e;
    }
    setRenaming(null);
    refreshIfDegraded();
  }, [refreshIfDegraded]);

  // The menu's other items: HubPanel's handlers (setColor, setHidden,
  // updateSessionHandle), single target.
  /** Throws, so the PromptModal stays open on a 409 (§14.80). The route
   *  normalizes the handle: the overlay carries ITS answer. */
  const applyHandle = useCallback(async (id: string, value: string) => {
    const updated = await api.updateSessionHandle(id, value);
    addOverlay(id, { handle: updated?.handle ?? null } as Partial<SessionSummary>).ack(updated?.sync);
    setHandling(null);
    refreshIfDegraded();
  }, [refreshIfDegraded]);

  const applyColour = useCallback((id: string, color: string | null) => {
    const overlay = addOverlay(id, { color });
    void api.patchAgentSession(id, { color })
      .then((r) => { overlay.ack(r?.sync); refreshIfDegraded(); }, (e: unknown) => { overlay.fail(); fail('colour', e); });
  }, [refreshIfDegraded, fail]);

  /** Hide / show back (§14.118): the session keeps running, its sub-sessions
   *  follow it (the route's `ids`). A robot that leaves the eye's view leaves
   *  the board, so it is let go of first. */
  const applyHidden = useCallback((id: string, hidden: boolean) => {
    if (hidden !== hiddenShown && id === selectedId) select(null);
    const overlay = addOverlay(id, { hidden: hidden ? 1 : 0 });
    void api.setSessionHidden(id, hidden)
      .then((r) => { overlay.ack(r?.sync); refreshIfDegraded(); }, (e: unknown) => { overlay.fail(); fail(hidden ? 'hide' : 'show', e); });
  }, [hiddenShown, selectedId, select, refreshIfDegraded, fail]);

  const openSession = useCallback((id: string) => {
    const session = byId.get(id);
    if (session && wantsYou(moodOf(session), session)) cleared();
    visit(id);
    setOpenId(id);
  }, [byId, cleared, visit]);

  /** Next robot in a mood (the chips), or next one that wants you (Tab). */
  const cycle = useCallback((match: (s: SessionSummary) => boolean, back = false) => {
    const pool = sessions.filter(match);
    if (!pool.length) return;
    const at = pool.findIndex((s) => s.id === selectedId);
    const next = pool[(at + (back ? -1 : 1) + pool.length) % pool.length];
    visit(next.id);
  }, [sessions, selectedId, visit]);

  const cycleMood = useCallback((mood: Mood) => {
    cycle((s) => {
      const m = moodOf(s);
      if (mood === 'blocked') return m === 'blocked' || m === 'question';
      if (mood === 'work') return m === 'work' || m === 'bg';
      return m === mood;
    });
  }, [cycle]);

  const nextQuest = useCallback((back = false) => {
    if (!quests.length) return;
    const ids = [...new Set(quests.map((q) => q.sessionId))];
    const at = ids.indexOf(selectedId ?? '');
    visit(ids[(at + (back ? -1 : 1) + ids.length) % ids.length]);
  }, [quests, selectedId, visit]);

  /** The next warm cache: the one closest to going cold first. */
  const nextWarm = useCallback(() => {
    if (!warm.length) return;
    visit(warm[(warm.indexOf(selectedId ?? '') + 1) % warm.length]);
  }, [warm, selectedId, visit]);

  /** Previous / next inhabited island, round and round. */
  const stepIsland = useCallback((dir: -1 | 1) => {
    if (!inhabited.length) return;
    const now = sceneRef.current;
    const at = now?.kind === 'island' ? inhabited.findIndex((i) => i.id === now.id) : -1;
    const next = at < 0 ? (dir > 0 ? 0 : inhabited.length - 1) : (at + dir + inhabited.length) % inhabited.length;
    travel({ kind: 'island', id: inhabited[next].id });
  }, [inhabited, travel]);

  /** The map, or back from it to the island last visited. */
  const toggleMap = useCallback(() => {
    if (sceneRef.current?.kind !== 'map') { travel({ kind: 'map' }); return; }
    const back = lastIsland.current && islands.some((i) => i.id === lastIsland.current)
      ? lastIsland.current : homeIsland(islands, null);
    if (back) travel({ kind: 'island', id: back });
  }, [islands, travel]);

  const selectedMood = selected ? moodOf(selected) : null;
  const canRead = selected != null && (selectedMood === 'done' || (selectedMood === 'error' && wantsYou('error', selected)));

  // `SessionContextMenu` needs a STABLE onClose: its 350 ms guard lives in an
  // effect keyed on it, and this page re-renders often.
  const closeMenu = useCallback(() => setMenu(null), []);

  /* ─────────────────────────────────────────────────────────── the drawer ── */

  // What the board lends the drawer (ui/drawerHost.ts): stable functions in
  // one object that never changes, so the context re-renders nobody.
  /** Show a robot: on the board ⇒ its island, selected (or its full view when
   *  `full`); known but off the board ⇒ its full view. False = not known yet. */
  const land = useStableCallback((id: string, full: boolean): boolean => {
    if (byId.has(id)) {
      if (full) openSession(id); else visit(id);
      return true;
    }
    if (all.some((s) => s.id === id)) { setOpenId(id); return true; }
    return false;
  });
  const goTo = useStableCallback((id: string, hint?: { vpsId: string; cwd: string }) => {
    // Unknown with a hint = just made (a fork): go once its summary lands.
    if (!land(id, false) && hint) { setPendingGo({ id, full: false }); refresh(); }
  });
  /** The full view's own "go to": it stays a full view; an unknown id is
   *  waited for, hint or not. */
  const goToFull = useStableCallback((id: string) => {
    if (!land(id, true)) { setPendingGo({ id, full: true }); refresh(); }
  });
  const openFull = useStableCallback((id: string) => openSession(id));
  const nextRobot = useStableCallback((back: boolean) => nextQuest(back));
  const drawerLifecycle = useStableCallback((action: 'sleep' | 'resume' | 'stop', id: string) => lifecycle(action, id));
  const readOne = useStableCallback((id: string) => onRead(id));
  const openMenu = useStableCallback((id: string, x: number, y: number) => setMenu({ id, x, y }));
  const deselect = useStableCallback(() => select(null));
  // Sign in again = the hub sign-in for that session's account
  // (app/loginModals.tsx § hubLogin: the default profile is no account id).
  const reauth = useStableCallback((id: string) => {
    const s = all.find((row) => row.id === id);
    if (!s) return;
    const profile = accountProfileId(s);
    setLoginFor((was) => ({
      n: (was?.n ?? 0) + 1,
      provider: asSessionProvider(s.kind),
      accountId: profile === DEFAULT_ACCOUNT_PROFILE ? null : profile,
    }));
  });
  const newSessionIn = useStableCallback((vpsId: string, cwd: string) => setRecruit({ vpsId, cwd }));
  const newRoutine = useStableCallback((draft: Parameters<DrawerHost['newRoutine']>[0]) => setRoutineDraft(draft));
  const openTools = useStableCallback((id: string, tab?: 'git' | 'calls') => {
    // The full view's Tools panel opens on the tab that was asked for (`/diff`, `/mcp`).
    const s = tab ? byId.get(id) ?? all.find((x) => x.id === id) : null;
    if (s && tab) writeWorkspacePanelTab(s.vpsId, s.cwd, tab);
    openSession(id);
  });
  const sessionsChanged = useStableCallback(() => refreshIfDegraded());
  const killed = useStableCallback((_id: string) => { select(null); refreshIfDegraded(); });
  const host = useMemo<DrawerHost>(() => ({
    composerRef, goTo, openFull, next: nextRobot, lifecycle: drawerLifecycle, read: readOne, openMenu, deselect,
    reauth, newSessionIn, newRoutine, openTools, sessionsChanged, killed,
  }), [goTo, openFull, nextRobot, drawerLifecycle, readOne, openMenu, deselect, reauth, newSessionIn, newRoutine,
    openTools, sessionsChanged, killed]);

  // File links in the drawer and the full view: `/view` in a new tab, else the path copied.
  const fileLinks = useMemo(() => makeDeskFileLinks((t) => setError(t)), []);

  // A robot asked for before its summary: shown once it lands, given up after
  // GO_WAIT_MS (then the banner says so).
  useEffect(() => {
    if (pendingGo && land(pendingGo.id, pendingGo.full)) setPendingGo(null);
  }, [pendingGo, all, byId, land]);
  useEffect(() => {
    if (!pendingGo) return undefined;
    const timer = setTimeout(() => { setPendingGo(null); setError('not on the desk'); }, GO_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pendingGo]);

  /* ──────────────────────────────────────────────────────────── keyboard ── */

  // Keys Charon's layers own. Marked in the CAPTURE phase, before any other
  // listener runs: a layer's own handler may close it before the board's
  // listener would look. The game's keys (pan, zoom) obey the same verdict.
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const yielded = useRef(new WeakSet<Event>());
  useEffect(() => {
    const onCapture = (e: KeyboardEvent) => {
      const layer = document.querySelector(CHARON_LAYER) != null;
      if (layer) yielded.current.add(e);
      gameRef.current?.setInputEnabled(!modalRef.current && !layer);
    };
    document.addEventListener('keydown', onCapture, true);
    return () => document.removeEventListener('keydown', onCapture, true);
  }, []);

  // The card a Y / N just answered: its POST is on its way and the card stays
  // until it settles (§14.18) — the same GATE again within a moment is not a
  // second answer. Keyed by the gate's id (two cards can read the same), and
  // short: after it, a press is a retry of an answer that failed.
  const answered = useRef<{ key: string; at: number } | null>(null);
  const answerShown = useCallback((allow: boolean, gateId: string | null): boolean => {
    const actions = document.querySelector(SHOWN_PERMISSION);
    const button = actions?.querySelector<HTMLButtonElement>(allow ? 'button.allow' : 'button.deny');
    if (!actions || !button || button.disabled) return false;
    const card = actions.closest('.pz-wrap');
    const key = gateId ?? ['.ip-head', '.ip-input', '.ip-reason']
      .map((sel) => card?.querySelector(sel)?.textContent ?? '').join('\n');
    const last = answered.current;
    if (last && last.key === key && Date.now() - last.at < ANSWER_GUARD_MS) return true;
    answered.current = { key, at: Date.now() };
    button.click();
    return true;
  }, []);

  /** `/`: the order box, else what holds its place (the gate card, the Resume button). */
  const focusOrder = useCallback(() => {
    if (composerRef.current) { composerRef.current.focus(); return; }
    // A folded card: its grip (the only control left there).
    document.querySelector<HTMLElement>(
      '.dk-unit .dk-sv .app-pending-zone:not([hidden]) button, .dk-unit .dk-sv .app-disconnect-cta button, '
      + '.dk-unit .dk-sv .pz-wrap.is-collapsed .pz-toggle',
    )?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Handled already (Charon's menus, the quote key, a picker), or a Charon
      // layer is open: never also a shortcut of the board.
      if (e.defaultPrevented || yielded.current.has(e)) return;
      // A run of the mini-game owns the keyboard (the board routes it).
      if (modal || arcade.on || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      // The session menu is the top layer: Escape closes it, and nothing under it.
      if (e.key === 'Escape' && menu) { setMenu(null); return; }
      if (isTyping(target)) {
        if (e.key === 'Escape') target!.blur();
        return;
      }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      // Tab from a control of the drawer walks the drawer's controls (a gate
      // card's options, the runtime cells): the board's Tab is for the board.
      if (key === 'Tab' && target && target !== document.body && target.closest?.('.dk-unit')) return;
      // Enter / Space on a focused control (a button, a link, the recap that
      // folds) is that control's own: not also a shortcut of the board.
      if ((key === 'Enter' || key === ' ') && target?.closest?.('button, a[href], [role="button"]')) return;
      const game = gameRef.current;
      switch (key) {
        case 'Tab':
        case ' ':
          e.preventDefault();
          nextQuest(e.shiftKey);
          break;
        case 'Enter':
          if (selectedId) { e.preventDefault(); openSession(selectedId); }
          break;
        case 'Escape':
          // A control of the drawer lets go first: the keys come back to the board.
          if (target && target !== document.body && target.closest?.('.dk-unit')) target.blur();
          else if (menu) setMenu(null);
          else select(null);
          break;
        case 'f':
        case '0':
          game?.fit();
          break;
        case 'm':
          toggleMap();
          break;
        case 'g':
          play();
          break;
        case 'PageUp':
        case 'PageDown':
          e.preventDefault();
          stepIsland(key === 'PageUp' ? -1 : 1);
          break;
        case '/':
          if (selectedId) { e.preventDefault(); focusOrder(); }
          break;
        case 'y':
        case 'n': {
          // Inside a gate card (an option button) the letters are not answers.
          if (target?.closest?.('.dk-sv .pz-wrap')) break;
          // Y / N answer only the permission card on screen; key repeat never.
          if (document.querySelector(SHOWN_PERMISSION)) {
            if (!e.repeat) {
              // The card shown is the oldest blocking gate (Charon's order): its id, when it is a permission.
              const oldest = (selected?.gates ?? []).filter((g) => g.blocking)
                .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
              answerShown(key === 'y', oldest?.kind === 'permission' ? oldest.id : null);
            }
            break;
          }
          // No card shown: N is "new", an agent on the island on stage (beside
          // the selected robot), unless that robot waits on a gate.
          if (key === 'n' && !selected?.gates?.some((g) => g.blocking)) {
            const here = sceneRef.current?.kind === 'island' ? sceneRef.current.id : null;
            const cwd = selected && selected.vpsId === here ? sidebarPathKey(selected.cwd) : null;
            setRecruit({ vpsId: here, cwd: cwd === '~' ? null : cwd });
          }
          break;
        }
        case 'r':
          if (selectedId && canRead) onRead(selectedId);
          break;
        case 'x':
          // The head's Stop rule (UnitHead § stoppable).
          if (selectedId && (selectedMood === 'work' || (selectedMood === 'blocked' && selected?.liveStatus === 'thinking'))) lifecycle('stop', selectedId);
          break;
        case '?':
          setHelp(true);
          break;
        default:
          // 1…9: straight to that island of the selector.
          if (/^[1-9]$/.test(key) && inhabited[Number(key) - 1]) travel({ kind: 'island', id: inhabited[Number(key) - 1].id });
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, arcade.on, menu, selectedId, selected, selectedMood, canRead, inhabited, nextQuest, openSession,
    select, onRead, lifecycle, travel, stepIsland, toggleMap, play, focusOrder, answerShown]);

  /* ─────────────────────────────────────────────────────────────── render ── */

  // The `@` menu of the session shown (full view, else drawer): its machine's sessions.
  const shown = open ?? selected;
  const siblings = useMemo<DrawerSibling[]>(() => {
    if (!shown) return [];
    return all
      .filter((s) => s.vpsId === shown.vpsId && s.id !== shown.id && s.handle)
      .map((s) => ({ id: s.id, name: s.name ?? null, handle: s.handle as string, status: String(s.liveStatus ?? s.status) }));
  }, [all, shown]);


  return (
    <FileLinkContext.Provider value={fileLinks}>
    <div className={`desk${arcade.on ? ' is-arcade' : ''}${selected && !open ? ' has-drawer' : ''}`}>
      {/* The board mounts its canvas and its labels in here. */}
      <div className="dk-stage" ref={stageRef} />

      <div className="dk-hud">
        <div className="dk-head" ref={headRef}>
          <TopBar
            tally={tally}
            total={sessions.length}
            warm={warm.length}
            best={Math.max(best, arcade.best)}
            playing={arcade.on}
            zoom={zoom}
            live={live}
            sound={sound}
            showSleeping={showSleeping}
            onCycle={cycleMood}
            onWarm={nextWarm}
            onPlay={play}
            onZoom={(delta) => gameRef.current?.zoomBy(delta)}
            onFit={() => gameRef.current?.fit()}
            onSound={toggleSound}
            onSleeping={() => setShowSleeping((on) => { keep('desk.sleeping', !on); return !on; })}
            hiddenShown={hiddenShown}
            onHidden={toggleHidden}
            onHelp={() => setHelp(true)}
          />
          <IslandBar islands={islands} scene={scene} game={game} onScene={travel} onStep={stepIsland} />
        </div>

        {/* The left column: what waits on you, and what the accounts have left. */}
        <div className="dk-left">
          <QuestLog
            quests={quests}
            sessions={byId}
            vps={vpsById}
            selectedId={selectedId}
            busy={busy}
            open={questsOpen}
            onToggle={() => setQuestsOpen((on) => { keep('desk.quests', !on); return !on; })}
            onVisit={visit}
            onOpen={openSession}
            onPermission={onPermission}
            onRead={onRead}
          />
          <LimitsPanel
            sessions={sessions}
            open={limitsOpen}
            onToggle={() => setLimitsOpen((on) => { keep('desk.limits', !on); return !on; })}
          />
        </div>

        <div className="dk-corner">
          <ol className="dk-feed" aria-live="polite">
            {feed.map((f) => (
              <li key={f.key} data-tone={f.tone}>
                <button type="button" onClick={() => visit(f.sessionId)}>{f.text}</button>
              </li>
            ))}
          </ol>
          <canvas
            ref={minimapRef}
            className="dk-minimap"
            aria-label="minimap"
            onPointerDown={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const jump = (x: number, y: number) => gameRef.current?.jumpFromMinimap(x - rect.left, y - rect.top);
              jump(e.clientX, e.clientY);
              e.currentTarget.setPointerCapture(e.pointerId);
              const target = e.currentTarget;
              const move = (ev: PointerEvent) => jump(ev.clientX, ev.clientY);
              const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); };
              target.addEventListener('pointermove', move);
              target.addEventListener('pointerup', up);
            }}
          />
        </div>

        {selected && !open && (
          <UnitPanel
            session={selected}
            vps={vpsById.get(selected.vpsId) ?? null}
            lead={selectedLead}
            crew={selectedCrew}
            teamTint={selectedTint}
            siblings={siblings}
            canRead={canRead}
            reading={busy.has(`${selected.id}:read`)}
            host={host}
          />
        )}

        <ArcadeHud />
        <TabNotificationBadge count={wanting} name={pageTitle} />

        {error && (
          <button type="button" className="dk-banner" onClick={() => setError(null)} title="dismiss">
            {error}
          </button>
        )}
      </div>

      {/* Charon's own menu and dialogs, mounted as they are: what a session can
          receive is Charon's to say. */}
      {menuSession && menu && (
        <SessionContextMenu
          title={agentName(menuSession)}
          subtitle={menuSession.cwd || undefined}
          x={menu.x}
          y={menu.y}
          currentColor={menuSession.color ?? null}
          onRename={() => setRenaming(menuSession.id)}
          onEditHandle={() => setHandling(menuSession.id)}
          onColor={(color) => { if ((menuSession.color ?? null) !== color) applyColour(menuSession.id, color); }}
          onSleep={canSleepSession(menuSession) ? () => lifecycle('sleep', menuSession.id) : undefined}
          onResume={canResumeSession(menuSession) ? () => lifecycle('resume', menuSession.id) : undefined}
          onHide={() => applyHidden(menuSession.id, menuSession.hidden !== 1)}
          hideLabel={menuSession.hidden === 1 ? 'Show (unhide)' : undefined}
          onDelete={() => setDeleting(menuSession.id)}
          onClose={closeMenu}
        />
      )}

      {renamingSession && (
        <PromptModal
          title="Rename session"
          initial={renamingSession.name ?? ''}
          placeholder={folderOf(renamingSession.cwd)}
          confirmLabel="rename"
          busyLabel="renaming…"
          icon="✎"
          onSubmit={(value) => applyRename(renamingSession.id, value)}
          onClose={() => setRenaming(null)}
        />
      )}

      {handlingSession && (
        <PromptModal
          title="Change session address"
          hint={<>Stable on this VPS and independent from the display name. You may type it with or without <code>@</code>; spaces and accents are normalized.</>}
          initial={handlingSession.handle ?? ''}
          placeholder="api-worker"
          confirmLabel="change address"
          busyLabel="changing…"
          icon="@"
          validate={(value) => (value.replace(/^@/, '').trim() ? null : 'a handle is required')}
          onSubmit={(value) => applyHandle(handlingSession.id, value)}
          onClose={() => setHandling(null)}
        />
      )}

      {deletingSession && (
        <ConfirmModal
          title="Delete session"
          confirmLabel="delete permanently"
          busyLabel="deleting…"
          onConfirm={() => deleteOne(deletingSession.id).then(() => setDeleting(null))}
          onClose={() => setDeleting(null)}
        >
          <div className="confirm-target">
            <span className="ct-name">{agentName(deletingSession)}</span>
            <span className="ct-sub">{deletingSession.cwd}</span>
          </div>
          <p className="confirm-text">
            The session and its whole history (messages, permissions, logs) will be
            permanently deleted. This cannot be undone — to keep it, put it to sleep instead.
          </p>
        </ConfirmModal>
      )}

      {recruit && (
        <NewSessionWizard
          kind="agent"
          vpsList={vps}
          vpsFolders={folders}
          vpsPaths={vpsPaths}
          initialVpsId={recruit.vpsId ?? undefined}
          initialCwd={recruit.cwd}
          onClose={() => setRecruit(null)}
          onCreatedSession={(created) => {
            setRecruit(null);
            refresh();
            // Its island now; the robot itself once its summary has landed.
            travel({ kind: 'island', id: created.vpsId });
            setTimeout(() => setPick({ kind: 'agent', id: created.id }), 900);
          }}
        />
      )}

      {open && (
        <SessionModal
          session={open}
          vps={vpsById.get(open.vpsId) ?? null}
          siblings={siblings}
          onClose={() => setOpenId(null)}
          onOpenSession={goToFull}
          onSessionsChanged={refreshIfDegraded}
          onReauth={reauth}
          onNewSessionIn={newSessionIn}
          onNewRoutine={newRoutine}
        />
      )}

      {/* Mounted here, not in the drawer: they outlive a deselection. */}
      {loginFor && (
        <AccountLoginModal
          key={loginFor.n}
          provider={loginFor.provider}
          accountId={loginFor.accountId}
          onClose={() => setLoginFor(null)}
        />
      )}

      {routineDraft && (
        <RoutinesModal
          vpsList={vps}
          vpsPaths={vpsPaths}
          sessions={all}
          initial={routineDraft}
          onOpenSession={goTo}
          onClose={() => setRoutineDraft(null)}
        />
      )}

      {help && <Help onClose={() => setHelp(false)} />}
      {/* The drawer's usage popover opens Charon's resets modal (§14.126). */}
      <ResetsModalHost />
    </div>
    </FileLinkContext.Provider>
  );
}
