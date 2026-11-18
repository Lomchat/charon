// What the board knows about a session — derived, never invented. Every
// predicate here asks Charon (lib/sessionAttention.ts, app/sessionUnread.ts):
// a robot can never say "needs you" while the sidebar says "working".
import { attentionForRow, rowStatus } from '@/lib/sessionAttention';
import { colorToHex } from '@/lib/rowColors';
import { isWorkingStatus } from '@/app/sessionUnread';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { Vps, VpsFolder } from '@/lib/types/api';

/** The fields the board reads off a summary (the test harness feeds fakes). */
export type DeskSession = Pick<SessionSummary,
  'id' | 'vpsId' | 'cwd' | 'name' | 'handle' | 'kind' | 'status' | 'liveStatus'
  | 'unreadStop' | 'pendingPermissions' | 'pendingBlocking' | 'pendingAsync'
  | 'color' | 'lastSeenSeq' | 'position' | 'createdAt' | 'model'>
  & Partial<Pick<SessionSummary, 'runningBgTasks' | 'promptCache' | 'accountProfile' | 'parentSessionId'>>;

export type DeskVps = Pick<Vps, 'id' | 'name' | 'folderId' | 'agentStatus'>;
export type DeskFolder = Pick<VpsFolder, 'id' | 'name'>;

/** Every machine gets an island; one without a session, an islet. */
export type DeskModel = {
  sessions: DeskSession[];
  vps: DeskVps[];
  folders: DeskFolder[];
};

/**
 * One word for what a robot is doing — its colour, its pose, its marker.
 *   blocked   a blocking gate: the turn is parked on you
 *   question  an async question, answerable any time
 *   done      finished, and nobody has read it yet
 *   error     failed turn or crashed session
 *   work      a turn is running        bg  turn over, background tasks still run
 *   idle      connected, nothing to do sleep  paused
 */
export type Mood = 'blocked' | 'question' | 'done' | 'error' | 'work' | 'bg' | 'idle' | 'sleep';

export const MOOD_COLOR: Record<Mood, string> = {
  blocked: '#ffb020',
  question: '#ffb020',
  done: '#4ade80',
  error: '#ff5d5d',
  work: '#4da3ff',
  bg: '#35d0c7',
  idle: '#8a94a8',
  sleep: '#566076',
};

export const MOOD_WORD: Record<Mood, string> = {
  blocked: 'needs you',
  question: 'asks',
  done: 'done',
  error: 'failed',
  work: 'working',
  bg: 'background',
  idle: 'idle',
  sleep: 'asleep',
};

export function moodOf(s: DeskSession): Mood {
  const attention = attentionForRow(s);
  if (attention === 'blocked') return 'blocked';
  if (attention === 'question') return 'question';
  if (attention === 'error') return 'error';
  if (attention === 'unread') return 'done';
  const status = rowStatus(s);
  if (status === 'sleeping') return 'sleep';
  if (status === 'error' || status === 'failed' || status === 'killed') return 'error';
  if (status === 'background') return 'bg';
  if (isWorkingStatus(status)) return 'work';
  return 'idle';
}

/**
 * A turn is running: the robot is at its console. Background tasks left
 * behind by a turn that ended are not one — it stands by, its drones work on.
 */
export function inTurn(s: DeskSession): boolean {
  const status = rowStatus(s);
  return isWorkingStatus(status) && status !== 'background';
}

/** A mood that waits on the user (the quest log, the Tab cycle). */
export function wantsYou(mood: Mood, s: DeskSession): boolean {
  if (mood === 'blocked' || mood === 'question' || mood === 'done') return true;
  return mood === 'error' && attentionForRow(s) === 'error';
}

export function folderOf(cwd: string | null | undefined): string {
  const parts = String(cwd ?? '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '~';
}

/** The name a robot wears: Charon's name, else its address, else its folder. */
export function agentName(s: Pick<DeskSession, 'name' | 'handle' | 'cwd'>): string {
  const name = (s.name ?? '').trim();
  if (name) return name;
  if (s.handle) return `@${s.handle}`;
  return folderOf(s.cwd);
}

/** One level per this many tokens of context. */
export const LEVEL_TOKENS = 100_000;

/**
 * A robot's level is the size of its context: 0–100k tokens is level 0,
 * 100–200k level 1, and so on. The context is the prompt of the session's
 * last request (`promptCache.promptTokens`: what its next message re-reads);
 * null while the session has no reading (never ran, or a provider that
 * reports none).
 */
export function levelOf(s: Pick<DeskSession, 'promptCache'>): { level: number; tokens: number; into: number } | null {
  const tokens = s.promptCache?.promptTokens;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return null;
  return { level: Math.floor(tokens / LEVEL_TOKENS), tokens, into: tokens % LEVEL_TOKENS };
}

/**
 * The prompt cache, as the board shows it (lib/promptCache.ts § CacheReading):
 * a fire at the console, as tall as the cache has life left, gone once it is
 * cold. Its colour deepens by quarter of the TTL, like the sidebar's flame:
 * `ember` is the fire's body, `core` its heart and the HUD's text.
 */
export const HEAT: Record<1 | 2 | 3 | 4, { ember: string; core: string }> = {
  4: { ember: '#ff8a2a', core: '#ffe08a' },
  3: { ember: '#f2792b', core: '#ffc76a' },
  2: { ember: '#d5622f', core: '#f3a352' },
  1: { ember: '#a3472f', core: '#dc7b46' },
};
/** The colour a session was given in Charon, when it is one a canvas can paint. */
export function ownColour(s: Pick<DeskSession, 'color'>): string | null {
  return colorToHex(typeof s.color === 'string' ? s.color.trim() : null);
}

/** Rug colours that read on a wooden deck, for a team whose lead wears none. */
const TEAM_TINTS = ['#c2505c', '#3fa7a3', '#6d7fe0', '#a96fd0', '#5fae6a', '#d6893e'];

/**
 * The colour of a team — a session and the sub-sessions that work for it: its
 * lead's own colour, else one picked by its id (the same team keeps its rug).
 */
export function teamTint(lead: Pick<DeskSession, 'id' | 'color'>): string {
  return ownColour(lead) ?? TEAM_TINTS[hashStr(lead.id) % TEAM_TINTS.length];
}

/** `colour` pulled toward `other` by `amount` (0 = itself, 1 = the other); both `#rrggbb`. */
export function blend(colour: string, other: string, amount: number): string {
  const a = parseInt(colour.slice(1), 16);
  const b = parseInt(other.slice(1), 16);
  const mix = (shift: number) => Math.round(((a >> shift) & 255) * (1 - amount) + ((b >> shift) & 255) * amount);
  return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, '0')}`;
}

export function hashStr(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32): the same island always has the same coast. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
