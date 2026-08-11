'use client';
import { diffLines } from 'diff';

/**
 * The one row model behind BOTH split views (§14.86).
 *
 * There are two sources of a diff in this app and they arrive in opposite
 * shapes: a session edit gives the full BEFORE and AFTER contents, while git
 * gives a unified PATCH. Rather than two renderers that drift apart, both are
 * normalised into these rows and drawn by `SplitDiffView`.
 */
export type DiffRow = {
  kind: 'eq' | 'add' | 'del' | 'mod' | 'gap';
  leftLine?: number;
  rightLine?: number;
  leftText?: string;
  rightText?: string;
  /** For a `gap` row: how many unchanged lines the patch skipped, if known. */
  skipped?: number;
};

function splitLines(s: string): string[] {
  // Preserve trailing empty lines correctly; drop the final newline so each
  // element is one displayable line.
  if (s === '') return [];
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
}

/**
 * Pair a removed block with the added block that follows it, so a rewritten
 * line shows as one `mod` row instead of a red row and a green row several
 * lines apart. Shared by both producers — it is most of what makes a split
 * view readable.
 */
function pairBlocks(
  dels: string[], adds: string[], out: DiffRow[],
  counters: { left: number; right: number },
): void {
  const n = Math.max(dels.length, adds.length);
  for (let k = 0; k < n; k++) {
    if (k < dels.length && k < adds.length) {
      out.push({
        kind: 'mod',
        leftLine: counters.left++, rightLine: counters.right++,
        leftText: dels[k], rightText: adds[k],
      });
    } else if (k < dels.length) {
      out.push({ kind: 'del', leftLine: counters.left++, leftText: dels[k] });
    } else {
      out.push({ kind: 'add', rightLine: counters.right++, rightText: adds[k] });
    }
  }
}

/** Session edits: full before/after contents → aligned rows. */
export function rowsFromContents(before: string, after: string): DiffRow[] {
  const parts = diffLines(before, after);
  const rows: DiffRow[] = [];
  const c = { left: 1, right: 1 };

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const lines = splitLines(p.value);
    if (!p.added && !p.removed) {
      for (const ln of lines) {
        rows.push({ kind: 'eq', leftLine: c.left++, rightLine: c.right++, leftText: ln, rightText: ln });
      }
    } else if (p.removed) {
      const next = parts[i + 1];
      if (next?.added) { pairBlocks(lines, splitLines(next.value), rows, c); i++; }
      else pairBlocks(lines, [], rows, c);
    } else {
      pairBlocks([], lines, rows, c);
    }
  }
  return rows;
}

/**
 * Git: a unified patch → the same rows.
 *
 * We do NOT re-diff anything — git already decided what changed, and a second
 * opinion computed in the browser would disagree with the numbers shown
 * everywhere else. This only re-shapes the hunks into two columns, and the
 * jump between hunks becomes an explicit `gap` row rather than a silent one:
 * a split view whose line numbers leap from 40 to 300 with no marker reads as
 * a rendering bug.
 */
export function rowsFromPatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const c = { left: 1, right: 1 };
  let dels: string[] = [];
  let adds: string[] = [];
  let started = false;

  const flush = () => {
    if (dels.length || adds.length) { pairBlocks(dels, adds, rows, c); dels = []; adds = []; }
  };

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      flush();
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (!m) continue;
      const nextLeft = Number(m[1]);
      const nextRight = Number(m[2]);
      if (started) {
        rows.push({ kind: 'gap', skipped: Math.max(0, nextLeft - c.left) || undefined });
      }
      started = true;
      c.left = nextLeft;
      c.right = nextRight;
      continue;
    }
    if (!started) continue;                    // headers: diff/index/---/+++
    if (raw.startsWith('\\')) continue;        // "\ No newline at end of file"
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === '+') { adds.push(text); continue; }
    if (marker === '-') { dels.push(text); continue; }
    // A context line, or the empty last element of the split.
    if (marker === ' ' || raw === '') {
      flush();
      if (raw === '') continue;
      rows.push({ kind: 'eq', leftLine: c.left++, rightLine: c.right++, leftText: text, rightText: text });
      continue;
    }
    flush();                                   // anything else: treat as context
    rows.push({ kind: 'eq', leftLine: c.left++, rightLine: c.right++, leftText: raw, rightText: raw });
  }
  flush();
  return rows;
}

/**
 * First row index of each contiguous run of changes — what the ▲/▼ between the
 * two panes step through. A block, not a row: stepping line by line through a
 * 40-line replacement is not navigation.
 */
export function changeBlocks(rows: DiffRow[]): number[] {
  const out: number[] = [];
  let inBlock = false;
  rows.forEach((r, i) => {
    const changed = r.kind === 'add' || r.kind === 'del' || r.kind === 'mod';
    if (changed && !inBlock) out.push(i);
    inBlock = changed;
  });
  return out;
}

export function countChanges(rows: DiffRow[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const r of rows) {
    if (r.kind === 'add') add++;
    else if (r.kind === 'del') del++;
    else if (r.kind === 'mod') { add++; del++; }
  }
  return { add, del };
}
