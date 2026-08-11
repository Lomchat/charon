import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Who is reading/writing what, right now (§14.88) ────────────────────────
//
// The source is the tool calls we already stream. The rules that matter are
// about what does NOT light up: an unknown tool is not file activity, a burst
// of reads is one event, and everything expires — this is a liveness light,
// not a record.

vi.mock('server-only', () => ({}));
const F = await import('@/lib/server/claude/fileActivity');

const CWD = '/srv/app';
const at = (ms: number) => ({ vpsId: 'v1', sessionId: 's1', sessionName: 'A', at: ms });

beforeEach(() => {
  const g = globalThis as unknown as { __charonFileActivity?: Map<string, unknown> };
  g.__charonFileActivity?.clear();
});

describe('fileFromToolUse', () => {
  it('recognises the write tools of both backends', () => {
    for (const name of ['Edit', 'Write', 'NotebookEdit', 'apply_patch', 'str_replace_editor']) {
      expect(F.fileFromToolUse(name, { file_path: '/srv/app/a.ts' }, CWD))
        .toEqual({ path: '/srv/app/a.ts', kind: 'write' });
    }
  });

  it('recognises the read tools', () => {
    expect(F.fileFromToolUse('Read', { file_path: '/srv/app/a.ts' }, CWD)?.kind).toBe('read');
    expect(F.fileFromToolUse('view_image', { path: '/srv/app/x.png' }, CWD)?.kind).toBe('read');
  });

  it('resolves a relative path against the session cwd', () => {
    expect(F.fileFromToolUse('Edit', { file_path: 'src/a.ts' }, CWD)?.path).toBe('/srv/app/src/a.ts');
    expect(F.fileFromToolUse('Edit', { file_path: './src/a.ts' }, '/srv/app/')?.path).toBe('/srv/app/src/a.ts');
  });

  it('is null for everything that is not a file touch', () => {
    // Guessing from a stray `path` key would light the tree up on every Glob.
    expect(F.fileFromToolUse('Glob', { path: '/srv/app' }, CWD)).toBeNull();
    expect(F.fileFromToolUse('Bash', { command: 'ls' }, CWD)).toBeNull();
    expect(F.fileFromToolUse('Grep', { pattern: 'x', path: '/srv/app' }, CWD)).toBeNull();
    expect(F.fileFromToolUse('Edit', {}, CWD)).toBeNull();          // no path at all
    expect(F.fileFromToolUse('', null, CWD)).toBeNull();
  });
});

describe('noteActivity', () => {
  it('records a touch and reports it as worth broadcasting', () => {
    expect(F.noteActivity({ ...at(1000), path: '/a', kind: 'write' })).not.toBeNull();
    expect(F.activityFor('v1', 1000).map((x) => x.path)).toEqual(['/a']);
  });

  it('collapses a burst on one file into one broadcast', () => {
    // An agent reading a file in chunks is one thing happening, not forty.
    expect(F.noteActivity({ ...at(1000), path: '/a', kind: 'read' })).not.toBeNull();
    expect(F.noteActivity({ ...at(1200), path: '/a', kind: 'read' })).toBeNull();
    expect(F.noteActivity({ ...at(1400), path: '/a', kind: 'read' })).toBeNull();
    // …but a change of kind is news, even inside the window.
    expect(F.noteActivity({ ...at(1500), path: '/a', kind: 'write' })).not.toBeNull();
    // …and so is another session arriving on the same file.
    expect(F.noteActivity({ ...at(1600), sessionId: 's2', sessionName: 'B', vpsId: 'v1', path: '/a', kind: 'write' }))
      .not.toBeNull();
  });

  it('expires reads sooner than writes', () => {
    F.noteActivity({ ...at(0), path: '/r', kind: 'read' });
    F.noteActivity({ ...at(0), path: '/w', kind: 'write' });
    expect(F.activityFor('v1', 60_000).map((x) => x.path).sort()).toEqual(['/r', '/w']);
    // "an agent glanced at this" stops being interesting long before
    // "an agent rewrote this".
    expect(F.activityFor('v1', 120_000).map((x) => x.path)).toEqual(['/w']);
    expect(F.activityFor('v1', 400_000)).toEqual([]);
  });

  it('is scoped per VPS', () => {
    F.noteActivity({ ...at(0), path: '/a', kind: 'write' });
    F.noteActivity({ ...at(0), vpsId: 'v2', sessionId: 's9', sessionName: 'Z', path: '/b', kind: 'write' });
    expect(F.activityFor('v1', 1).map((x) => x.path)).toEqual(['/a']);
    expect(F.activityFor('v2', 1).map((x) => x.path)).toEqual(['/b']);
  });

  it('forgets everything a deleted session had lit', () => {
    F.noteActivity({ ...at(0), path: '/a', kind: 'write' });
    F.noteActivity({ ...at(0), sessionId: 's2', sessionName: 'B', vpsId: 'v1', path: '/b', kind: 'write' });
    F.clearSessionActivity('s1');
    expect(F.activityFor('v1', 1).map((x) => x.path)).toEqual(['/b']);
  });
});
