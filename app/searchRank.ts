// Pure matching, scoring and pick-memory of the global search palette
// (SearchModal.tsx). No React, no DOM except the storage wrapper.

/** Whitespace-separated lower-cased terms, deduplicated, bounded. */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  for (const t of q.toLowerCase().split(/\s+/)) {
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

const WORD_START = /[\s/_\-.:@]/;

/** Score of ONE term against one lower-cased haystack: prefix > word prefix > substring. */
function termScore(hay: string, t: string, primary: boolean): number {
  if (!hay) return 0;
  const i = hay.indexOf(t);
  if (i < 0) return 0;
  if (i === 0) return primary ? 100 : 30;
  if (WORD_START.test(hay[i - 1])) return primary ? 70 : 25;
  return primary ? 50 : 15;
}

/**
 * AND over the terms: each must hit at least one field (lower-cased
 * substring). `fields[0..primaryCount)` are the name-like fields. Null = no match.
 */
export function scoreFields(fields: readonly string[], terms: readonly string[], primaryCount = 1): number | null {
  if (!terms.length) return 0;
  let total = 0;
  for (const t of terms) {
    let best = 0;
    for (let i = 0; i < fields.length; i++) {
      const s = termScore(fields[i], t, i < primaryCount);
      if (s > best) best = s;
    }
    if (best === 0) return null;
    total += best;
  }
  return total / terms.length;
}

/** Merged [start,end) ranges of every term occurrence in `text` (case-insensitive). */
export function highlightRanges(text: string, terms: readonly string[]): Array<[number, number]> {
  if (!text || !terms.length) return [];
  const lower = text.toLowerCase();
  // toLowerCase can change the length (rare Unicode); do not mis-slice then.
  if (lower.length !== text.length) return [];
  const raw: Array<[number, number]> = [];
  for (const t of terms) {
    if (!t) continue;
    for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + t.length)) raw.push([i, i + t.length]);
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Recent activity as a bonus in [0, 30]: halves every ~2 days. */
export function recencyBonus(lastMs: number | null | undefined, now: number): number {
  if (!lastMs || lastMs <= 0) return 0;
  const days = Math.max(0, (now - lastMs) / 86_400_000);
  return 30 / (1 + days / 2);
}

// ── Picks: what the user opened, bounded, remembered per browser ──────────

export const PICKS_STORAGE_KEY = 'hub.search.picks.v1';
const MAX_PICK_KEYS = 200;
const MAX_PICK_QUERIES = 50;

export type Picks = {
  /** key -> { n: times picked, last: ms of the latest pick } */
  k: Record<string, { n: number; last: number }>;
  /** normalized query -> { key: last picked, t: ms } */
  q: Record<string, { key: string; t: number }>;
};

export const emptyPicks = (): Picks => ({ k: {}, q: {} });

export function parsePicks(raw: string | null): Picks {
  if (!raw) return emptyPicks();
  try {
    const j = JSON.parse(raw);
    const out = emptyPicks();
    if (j && typeof j === 'object') {
      for (const [key, v] of Object.entries(j.k ?? {})) {
        const e = v as { n?: unknown; last?: unknown };
        if (typeof e?.n === 'number' && typeof e?.last === 'number') out.k[key] = { n: e.n, last: e.last };
      }
      for (const [qs, v] of Object.entries(j.q ?? {})) {
        const e = v as { key?: unknown; t?: unknown };
        if (typeof e?.key === 'string' && typeof e?.t === 'number') out.q[qs] = { key: e.key, t: e.t };
      }
    }
    return out;
  } catch { return emptyPicks(); }
}

function newest<T>(rec: Record<string, T>, at: (v: T) => number, max: number): Record<string, T> {
  const ents = Object.entries(rec);
  if (ents.length <= max) return rec;
  ents.sort((a, b) => at(b[1]) - at(a[1]));
  return Object.fromEntries(ents.slice(0, max));
}

/** A new Picks with `key` counted and `query` remembered; bounded. */
export function recordPick(p: Picks, key: string, query: string, now: number): Picks {
  const prev = p.k[key];
  const k = newest({ ...p.k, [key]: { n: (prev?.n ?? 0) + 1, last: now } }, (v) => v.last, MAX_PICK_KEYS);
  const qs = query.trim().toLowerCase().slice(0, 100);
  const q = qs ? newest({ ...p.q, [qs]: { key, t: now } }, (v) => v.t, MAX_PICK_QUERIES) : p.q;
  return { k, q };
}

/** Bonus for items the user opened before: frequency (capped) + a fading recency. */
export function pickBonus(p: Picks, key: string, now: number): number {
  const e = p.k[key];
  if (!e) return 0;
  const days = Math.max(0, (now - e.last) / 86_400_000);
  return Math.min(e.n, 10) * 4 + 20 / (1 + days);
}

/** Added to the item this exact query last opened. */
export const QUERY_PICK_BONUS = 1000;
export function lastPickedFor(p: Picks, query: string): string | null {
  return p.q[query.trim().toLowerCase()]?.key ?? null;
}

// ── Session status dot (the sidebar's mapping, see Sidebar.tsx DOT_CLASS) ──

const DOT: Record<string, string> = {
  active: 'dot-green', starting: 'dot-amber', thinking: 'dot-amber-pulse',
  sleeping: 'dot-gray', killed: 'dot-gray', error: 'dot-red', failed: 'dot-red',
  background: 'dot-violet-pulse', waiting: 'dot-orange-pulse', question: 'dot-orange-pulse',
};

/** `attention` is attentionForRow(); blocked/question outrank the live status. */
export function dotClassFor(status: string, attention: string | null): string {
  const eff = attention === 'blocked' ? 'waiting' : attention === 'question' ? 'question' : status;
  return DOT[eff] ?? 'dot-gray';
}

export function basename(p: string): string {
  const t = p.replace(/\/+$/, '');
  return t.slice(t.lastIndexOf('/') + 1) || t;
}

/** Last two path segments: "proj/sub". */
export function pathTail(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || p;
}
