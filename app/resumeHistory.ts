// The resume modal's list (ResumeModal): what this VPS holds that Charon does
// NOT show — sessions never imported, plus the ARCHIVED ones (nowhere else to
// bring them back from). A session in the sidebar is never listed: it is
// already one click away. De-duplicated on (kind, native id). PLAIN module:
// the modal renders it, vitest pins it.
import type { AgentKind, HistorySession, ScannedSession, SessionListItem } from '@/lib/types/api';

/** `new`: on the VPS, never imported. `archived`: a Charon session put away. */
export type ResumeState = 'new' | 'archived';

export type ResumeItem = {
  /** `kind:nativeId`, or `db:<id>` for an archived session with no native id. */
  key: string;
  kind: AgentKind;
  nativeId: string | null;
  cwd: string;
  title: string;
  firstPrompt: string;
  lastPrompt: string;
  /** null = unknown (an archived row the index lacks); `approx` = sampled, show the size. */
  prompts: number | null;
  approx: boolean;
  model: string;
  effort?: string;
  branch: string;
  mtimeMs: number;
  size: number | null;
  state: ResumeState;
  /** The archived Charon session (state `archived`). */
  session?: SessionListItem;
  /** Codex: an archived native thread — import unarchives it. */
  archivedNative?: boolean;
};

/**
 * The index rows no visible Charon session resumes, and the archived Charon
 * sessions (carrying their transcript's row when the index has it).
 */
export function mergeHistory(rows: readonly HistorySession[], charon: readonly SessionListItem[]): ResumeItem[] {
  const visible = new Set<string>();
  const archived = new Map<string, SessionListItem>();
  for (const s of charon) {
    if (!s.nativeSessionId) continue;
    const k = `${s.kind ?? 'claude'}:${s.nativeSessionId}`;
    if (s.archived === 1) { if (!archived.has(k)) archived.set(k, s); } else visible.add(k);
  }
  const out: ResumeItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.kind}:${r.sessionId}`;
    if (seen.has(key) || visible.has(key)) continue;
    seen.add(key);
    const s = archived.get(key);
    out.push({
      key, kind: r.kind, nativeId: r.sessionId, cwd: s?.cwd || r.cwd,
      title: s?.name || r.title || r.firstPrompt || r.sessionId.slice(0, 8),
      firstPrompt: r.firstPrompt, lastPrompt: r.lastPrompt,
      prompts: r.prompts, approx: r.approx, model: r.model, effort: r.effort, branch: r.branch,
      mtimeMs: Math.max(r.mtime * 1000, s?.lastActivityMs ?? 0),
      size: r.size, state: s ? 'archived' : 'new', session: s, archivedNative: !s && !!r.archived,
    });
  }
  for (const s of charon) {
    if (s.archived !== 1) continue;
    const kind = (s.kind ?? 'claude') as AgentKind;
    const key = s.nativeSessionId ? `${kind}:${s.nativeSessionId}` : `db:${s.id}`;
    if (seen.has(key) || visible.has(key)) continue;
    seen.add(key);
    out.push({
      key, kind, nativeId: s.nativeSessionId ?? null, cwd: s.cwd,
      title: s.name || s.firstUserMessage || leaf(s.cwd),
      firstPrompt: s.firstUserMessage ?? '', lastPrompt: '',
      prompts: null, approx: false, model: s.model ?? '', branch: '',
      mtimeMs: s.lastActivityMs ?? s.createdAt * 1000, size: null,
      state: 'archived', session: s,
    });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The legacy per-provider scans (an agent without history_index). */
export function scannedToHistory(kind: AgentKind, rows: readonly ScannedSession[]): HistorySession[] {
  return rows.map((s) => ({
    kind, sessionId: s.sessionId, cwd: s.cwd,
    title: s.aiTitle || s.summary || s.firstUserText || '',
    firstPrompt: s.firstUserText ?? '', lastPrompt: s.lastPrompt ?? '',
    prompts: s.messageCount ?? 0, approx: true, model: s.model ?? '',
    effort: 'effort' in s ? s.effort : undefined, branch: s.gitBranch ?? '',
    mtime: s.mtime, size: s.size, archived: 'archived' in s ? !!s.archived : undefined,
  }));
}

/**
 * Hidden by "Hide noise" — never an archived session: a transcript with no
 * prompt at all (a `/clear`, a warm-up), or one started under /tmp.
 */
export function isNoise(it: ResumeItem): boolean {
  if (it.state !== 'new') return false;
  if (it.cwd === '/tmp' || it.cwd.startsWith('/tmp/')) return true;
  return !it.approx && it.prompts === 0;
}

export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Every word must appear somewhere: title, prompts, folder, branch, model. */
export function matchesQuery(it: ResumeItem, query: string): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = normalize([it.title, it.firstPrompt, it.lastPrompt, it.cwd, it.branch, it.model, it.session?.handle ?? ''].join(' '));
  return words.every((w) => hay.includes(w));
}

export type ProjectGroup = { cwd: string; count: number; fresh: number; latestMs: number };

/** Folders, most recently active first; `fresh` = not imported yet. */
export function groupProjects(items: readonly ResumeItem[]): ProjectGroup[] {
  const by = new Map<string, ProjectGroup>();
  for (const it of items) {
    const g = by.get(it.cwd) ?? { cwd: it.cwd, count: 0, fresh: 0, latestMs: 0 };
    g.count++;
    if (it.state === 'new') g.fresh++;
    g.latestMs = Math.max(g.latestMs, it.mtimeMs);
    by.set(it.cwd, g);
  }
  return [...by.values()].sort((a, b) => b.latestMs - a.latestMs);
}

export function leaf(path: string): string {
  return path.split('/').filter(Boolean).pop() || path || '/';
}

/** claude-opus-5-5 → opus-5.5; Codex/Cursor ids read fine as they are. */
export function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)(\[1m\])?$/, '-$1.$2$3');
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
