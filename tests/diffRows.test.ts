import { describe, it, expect } from 'vitest';
import { changeBlocks, countChanges, rowsFromContents, rowsFromPatch } from '../app/diffRows';

// ── The one row model behind both split views (§14.86) ─────────────────────
//
// Two sources, opposite shapes: a session edit gives BEFORE and AFTER
// contents, git gives a unified PATCH. Both normalise to the same rows, or the
// two readers drift apart. The patch side is the delicate one: it must NOT
// re-diff (git already decided what changed), it must carry git's own line
// numbers, and the jump between hunks has to be visible.

const P = (s: string) => s.replace(/^\n/, '');

describe('rowsFromPatch', () => {
  it('keeps git line numbers and pairs a replacement into one row', () => {
    const rows = rowsFromPatch(P(`
diff --git a/f.ts b/f.ts
index 111..222 100644
--- a/f.ts
+++ b/f.ts
@@ -10,4 +10,4 @@ context header
 keep one
-old line
+new line
 keep two
`));
    expect(rows.map((r) => r.kind)).toEqual(['eq', 'mod', 'eq']);
    expect(rows[0]).toMatchObject({ leftLine: 10, rightLine: 10, leftText: 'keep one' });
    // A rewritten line is ONE row with both sides, not a red row and a green
    // row several lines apart.
    expect(rows[1]).toMatchObject({ leftLine: 11, rightLine: 11, leftText: 'old line', rightText: 'new line' });
    expect(rows[2]).toMatchObject({ leftLine: 12, rightLine: 12 });
  });

  it('drifts the two sides independently on a pure insertion', () => {
    const rows = rowsFromPatch(P(`
@@ -1,2 +1,4 @@
 a
+b
+c
 d
`));
    expect(rows.map((r) => r.kind)).toEqual(['eq', 'add', 'add', 'eq']);
    expect(rows[1].rightLine).toBe(2);
    expect(rows[1].leftLine).toBeUndefined();   // nothing on the left for an insertion
    expect(rows[2]).toMatchObject({ rightLine: 3 });
    // The trailing context is line 2 on the left but line 4 on the right.
    expect(rows[3]).toMatchObject({ leftLine: 2, rightLine: 4 });
  });

  it('a deletion leaves the right column empty', () => {
    const rows = rowsFromPatch(P(`
@@ -1,3 +1,1 @@
 a
-b
-c
`));
    expect(rows.map((r) => r.kind)).toEqual(['eq', 'del', 'del']);
    expect(rows[1].leftLine).toBe(2);
    expect(rows[1].rightText).toBeUndefined();  // nothing on the right for a deletion
  });

  it('marks the jump between hunks instead of silently skipping lines', () => {
    // Line numbers leaping from 12 to 300 with no marker reads as a bug.
    const rows = rowsFromPatch(P(`
@@ -10,2 +10,2 @@
 a
-b
@@ -300,2 +300,2 @@
 y
+z
`));
    const gap = rows.find((r) => r.kind === 'gap');
    expect(gap).toBeTruthy();
    expect(gap!.skipped).toBe(288);
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'add', rightLine: 301 });
  });

  it('ignores headers and the no-newline marker', () => {
    const rows = rowsFromPatch(P(`
diff --git a/x b/x
new file mode 100644
--- /dev/null
+++ b/x
@@ -0,0 +1,1 @@
+only
\\ No newline at end of file
`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'add', rightText: 'only' });
  });

  it('is empty for a patch with no hunks (rename, mode change, binary)', () => {
    // The caller falls back to the raw text, which is the only thing that says
    // what actually happened.
    expect(rowsFromPatch('diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n')).toEqual([]);
    expect(rowsFromPatch('')).toEqual([]);
  });

  it('does not mistake a context line that starts with a minus for a deletion', () => {
    // The marker is column 0; ' -x' is context whose text is '-x'.
    const rows = rowsFromPatch('@@ -1,2 +1,2 @@\n -x\n+y\n');
    expect(rows[0]).toMatchObject({ kind: 'eq', leftText: '-x' });
  });
});

describe('rowsFromContents', () => {
  it('aligns a replacement as one row and numbers both sides', () => {
    const rows = rowsFromContents('a\nold\nc\n', 'a\nnew\nc\n');
    expect(rows.map((r) => r.kind)).toEqual(['eq', 'mod', 'eq']);
    expect(rows[1]).toMatchObject({ leftLine: 2, rightLine: 2, leftText: 'old', rightText: 'new' });
  });

  it('handles a brand-new file and a deleted one', () => {
    expect(rowsFromContents('', 'a\nb\n').map((r) => r.kind)).toEqual(['add', 'add']);
    expect(rowsFromContents('a\nb\n', '').map((r) => r.kind)).toEqual(['del', 'del']);
  });
});

describe('changeBlocks', () => {
  it('steps by BLOCK, not by line', () => {
    // Stepping through a forty-line replacement one line at a time is not
    // navigation, so a contiguous run counts once.
    const rows = rowsFromPatch(P(`
@@ -1,6 +1,6 @@
 a
-b
-c
+B
+C
 d
-e
+E
 f
`));
    expect(changeBlocks(rows)).toHaveLength(2);
  });

  it('is empty when nothing changed, so the stepper hides', () => {
    expect(changeBlocks(rowsFromContents('same\n', 'same\n'))).toEqual([]);
  });
});

describe('countChanges', () => {
  it('counts a modification on both sides', () => {
    const rows = rowsFromPatch('@@ -1,2 +1,2 @@\n-a\n+A\n+B\n');
    expect(countChanges(rows)).toEqual({ add: 2, del: 1 });
  });
});
