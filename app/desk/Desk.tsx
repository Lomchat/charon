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
import {
  initSyncPosition, isDegraded, setFocus, subscribeAll, subscribeReconnect,
} from '@/app/globalEventStream';
import {
  addOverlay, hydrateSummaries, seedFromListResponse, useSessionList, useVpsRuntime,
} from '@/app/sync/summaryStore';
import { createRerunner } from '@/app/sync/revResource';
import ConfirmModal from '@/app/ConfirmModal';
import { getDraft, subscribeDrafts } from '@/app/inputDraftStore';
import NewSessionWizard from '@/app/NewSessionWizard';
import { useCacheTick } from '@/app/PromptCacheMarks';
import PromptModal from '@/app/PromptModal';
import SessionContextMenu from '@/app/SessionContextMenu';
import { canResumeSession, canSleepSession } from '@/app/sessionBulkActions';
import { sidebarPathKey } from '@/app/sidebarPathGroups';
import { api } from '@/lib/api';
import { isCacheWarm, sessionCacheReading } from '@/lib/promptCache';
import type { SessionActivity } from '@/lib/sessionActivity';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { SyncStamp } from '@/lib/sync/protocol';
import type { Vps, VpsFolder, VpsPath } from '@/lib/types/api';
import { dropActivity, putActivity, replaceActivities } from './activityStore';
import { readBest, useArcade } from './arcadeStore';
import { Game, type Pick, type Scene } from './game/game';
import { agentName, folderOf, moodOf, wantsYou, type Mood } from './game/model';
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
import UnitPanel, { PlacePanel } from './ui/UnitPanel';

// The safety net keeps Charon's own rhythm (§14.24): 60 s, 15 s on a hub too
// old to publish summaries.
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

/** A touch screen: focusing a field there opens a keyboard over the board. */
const coarsePointer = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

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
  const orderRef = useRef<HTMLTextAreaElement | null>(null);
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
  const [recruit, setRecruit] = useState<{ vpsId: string; cwd: string | null } | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());

  // Hidden sessions stay out of every list but the eye view (§14.118).
  const sessions = useMemo(
    () => all.filter((s) => s.hidden !== 1 && (showSleeping || moodOf(s) !== 'sleep')),
    [all, showSleeping],
  );
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s] as const)), [sessions]);
  const quests = useMemo(() => questsOf(sessions), [sessions]);
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
    const home = homeIsland(islandsOf(initialSummaries.filter((s) => s.hidden !== 1), vpsList, folders), remembered);
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
  const modal = Boolean(open || help || recruit || renaming || deleting);


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
  const toggleSoundRef = useRef(toggleSound);
  toggleSoundRef.current = toggleSound;

  /** The mini-game's button: a run on the island on stage, or the end of one. */
  const play = useCallback(() => {
    const board = gameRef.current;
    if (!board) return;
    if (board.arcadeOn) { board.stopArcade(); return; }
    // The keyboard is the game's: nothing selected, no field holding the caret.
    setPick(null);
    setMenu(null);
    (document.activeElement as HTMLElement | null)?.blur?.();
    // The click is the gesture a browser wants before it plays a sound.
    if (sound) setSound(true);
    if (!board.startArcade()) setError('The game is played on an island with robots: pick one in the selector first.');
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
          const vpsId = next.kind === 'vps' ? next.id : next.kind === 'plot' ? next.vpsId : board.islandOf(next.id);
          if (vpsId) travelRef.current({ kind: 'island', id: vpsId });
          setPick(next.kind === 'agent' ? next : null);
          return;
        }
        setPick(next);
        if (how === 'double' && next?.kind === 'agent') setOpenId(next.id);
      },
      onZoom: setZoom,
      onArcade: (what) => { if (what === 'sound') toggleSoundRef.current(); },
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

  const onOrder = useCallback(async (id: string, text: string) => {
    await api.sendSessionInput(id, text, crypto.randomUUID());
    sfx.act();
    refreshIfDegraded();
  }, [refreshIfDegraded]);

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

  const selectedPermission = useMemo(
    () => (selectedId ? quests.find((q) => q.sessionId === selectedId && q.kind === 'permission') ?? null : null),
    [quests, selectedId],
  );
  const selectedMood = selected ? moodOf(selected) : null;
  const canRead = selected != null && (selectedMood === 'done' || (selectedMood === 'error' && wantsYou('error', selected)));

  // `SessionContextMenu` needs a STABLE onClose: its 350 ms guard lives in an
  // effect keyed on it, and this page re-renders often.
  const closeMenu = useCallback(() => setMenu(null), []);

  /* ──────────────────────────────────────────────────────────── keyboard ── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A run of the mini-game owns the keyboard (the board routes it).
      if (modal || arcade.on || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      // Enter / Space on a focused control (a button, a link, the recap that
      // folds) is that control's own: not also a shortcut of the board.
      if ((key === 'Enter' || key === ' ')
        && (e.defaultPrevented || (e.target as HTMLElement | null)?.closest?.('button, a[href], [role="button"]'))) return;
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
          if (menu) setMenu(null);
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
          if (selectedId) { e.preventDefault(); orderRef.current?.focus(); }
          break;
        case 'y':
          if (selectedPermission && !busy.has(selectedPermission.key)) onPermission(selectedPermission, true);
          break;
        case 'n':
          if (selectedPermission && !busy.has(selectedPermission.key)) onPermission(selectedPermission, false);
          break;
        case 'r':
          if (selectedId && canRead) onRead(selectedId);
          break;
        case 'x':
          if (selectedId && selectedMood === 'work') lifecycle('stop', selectedId);
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
  }, [modal, arcade.on, menu, selectedId, selectedPermission, selectedMood, canRead, busy, inhabited, nextQuest, openSession,
    select, onPermission, onRead, lifecycle, travel, stepIsland, toggleMap, play]);

  /* ─────────────────────────────────────────────────────────────── render ── */

  const siblings = useMemo(() => {
    if (!open) return [];
    return all
      .filter((s) => s.vpsId === open.vpsId && s.id !== open.id && s.handle)
      .map((s) => ({ id: s.id, name: s.name ?? null, handle: s.handle as string, status: String(s.liveStatus ?? s.status) }));
  }, [all, open]);

  const place = useMemo(() => {
    if (!pick || pick.kind === 'agent') return null;
    const vpsId = pick.kind === 'vps' ? pick.id : pick.vpsId;
    const machine = vpsById.get(vpsId);
    if (!machine) return null;
    const here = sessions.filter((s) => s.vpsId === vpsId);
    if (pick.kind === 'vps') {
      const state = machine.agentStatus === 'ok' ? 'agent connected' : `agent ${machine.agentStatus}`;
      return {
        title: machine.name, vpsId, cwd: null as string | null,
        lines: [`${here.length} agent${here.length === 1 ? '' : 's'} · ${state}`],
      };
    }
    const n = here.filter((s) => sidebarPathKey(s.cwd) === pick.cwd).length;
    return {
      title: pick.cwd, vpsId, cwd: pick.cwd === '~' ? null : pick.cwd,
      lines: [`${machine.name} · ${n} agent${n === 1 ? '' : 's'} on this deck`],
    };
  }, [pick, vpsById, sessions]);

  return (
    <div className={`desk${arcade.on ? ' is-arcade' : ''}${(selected && !open) || place ? ' has-drawer' : ''}`}>
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
            permission={selectedPermission}
            busy={selectedPermission ? busy.has(selectedPermission.key) : busy.has(`${selected.id}:read`)}
            orderRef={orderRef}
            // Every robot, a permission pending or not (Y / N then need Esc
            // first, or a click on Allow / Deny). A finger gets no on-screen
            // keyboard it did not ask for.
            autoFocus={!coarsePointer}
            onNext={nextQuest}
            onOpen={() => openSession(selected.id)}
            onOrder={(text) => onOrder(selected.id, text)}
            onStop={() => lifecycle('stop', selected.id)}
            onSleep={canSleepSession(selected) ? () => lifecycle('sleep', selected.id) : undefined}
            onResume={canResumeSession(selected) ? () => lifecycle('resume', selected.id) : undefined}
            onRead={canRead ? () => onRead(selected.id) : undefined}
            onPermission={onPermission}
            onMore={(x, y) => setMenu({ id: selected.id, x, y })}
            onClose={() => select(null)}
          />
        )}
        {place && (
          <PlacePanel
            title={place.title}
            lines={place.lines}
            canRecruit
            onRecruit={() => setRecruit({ vpsId: place.vpsId, cwd: place.cwd })}
            onClose={() => select(null)}
          />
        )}

        <ArcadeHud />

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
          showColor={false}
          onRename={() => setRenaming(menuSession.id)}
          onSleep={canSleepSession(menuSession) ? () => lifecycle('sleep', menuSession.id) : undefined}
          onResume={canResumeSession(menuSession) ? () => lifecycle('resume', menuSession.id) : undefined}
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
          initialVpsId={recruit.vpsId}
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
          onOpenSession={openSession}
          onSessionsChanged={refreshIfDegraded}
        />
      )}

      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}
