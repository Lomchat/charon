import { describe, expect, it } from 'vitest';
import {
  findExistingUploadTargets, receiveExitReason, uploadNameError, uploadPathError,
} from '../lib/fsUpload';

// The explorer drop asks about every conflict once, up front. These pin the
// shape of that question: one listing per parent, nothing listed below a
// folder that does not exist yet, and a stat only when a listing was cut.
describe('findExistingUploadTargets', () => {
  const tree: Record<string, { name: string; dir: boolean }[]> = {
    '': [{ name: 'src', dir: true }, { name: 'logo.png', dir: false }, { name: 'notes', dir: false }],
    src: [{ name: 'app.ts', dir: false }],
  };
  const listed: string[] = [];
  const list = async (dir: string) => {
    listed.push(dir);
    return tree[dir] ? { ok: true, entries: tree[dir] } : { ok: false };
  };
  const stat = async () => ({ ok: true, exists: false });

  it('reports files and folders that exist, with one listing per parent', async () => {
    listed.length = 0;
    const existing = await findExistingUploadTargets(
      ['logo.png', 'new.png', 'src', 'src/app.ts', 'src/other.ts', 'notes'], list, stat);
    expect(existing).toEqual([
      { path: 'logo.png', dir: false },
      { path: 'src', dir: true },
      { path: 'notes', dir: false },
      { path: 'src/app.ts', dir: false },
    ]);
    expect(listed).toEqual(['', 'src']);
  });

  it('never lists below a folder that is about to be created', async () => {
    listed.length = 0;
    const existing = await findExistingUploadTargets(
      ['photos', 'photos/a.jpg', 'photos/2024/b.jpg', 'photos/2024'], list, stat);
    expect(existing).toEqual([]);
    expect(listed).toEqual(['']);
  });

  it('falls back to a stat for names a truncated listing did not show', async () => {
    const existing = await findExistingUploadTargets(
      ['big.bin', 'folder', 'free.txt'],
      async () => ({ ok: true, truncated: true, entries: [] }),
      async (path) => (path === 'big.bin'
        ? { ok: true, exists: true }
        : path === 'folder' ? { ok: false, error: 'not a file' } : { ok: true, exists: false }),
    );
    expect(existing).toEqual([{ path: 'big.bin', dir: false }, { path: 'folder', dir: true }]);
  });
});

describe('upload names and receiver exit codes', () => {
  it('keeps any real file name and refuses only what cannot be one', () => {
    expect(uploadNameError('Capture d’écran 2026-09-30 à 10.00.png')).toBeNull();
    expect(uploadNameError('.env')).toBeNull();
    for (const bad of ['', '.', '..', 'a/b', 'a\0b', 'x'.repeat(256)]) {
      expect(uploadNameError(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(uploadPathError('src/assets/logo.png')).toBeNull();
    expect(uploadPathError('src/../etc/passwd')).not.toBeNull();
    expect(uploadPathError('/etc/passwd')).not.toBeNull();
  });

  it('maps the agent exit codes onto reasons the browser can act on', () => {
    expect(receiveExitReason(27)).toBe('exists');
    expect(receiveExitReason(22)).toBe('is_dir');
    expect(receiveExitReason(21)).toBe('missing');
    expect(receiveExitReason(26)).toBe('missing');
    expect(receiveExitReason(20)).toBe('bad_path');
    expect(receiveExitReason(2)).toBe('unsupported');
    expect(receiveExitReason(255)).toBe('error');
    expect(receiveExitReason(null)).toBe('error');
  });
});

// A dropped FOLDER only exists as FileSystemEntry objects; a real drag is the
// only way to get one in a browser, so the walk is pinned here with fakes.
describe('planDrop', () => {
  type Fake = { name: string; isDirectory: boolean; isFile: boolean; kids?: Fake[]; body?: string };
  const file = (name: string, body = name): Fake => ({ name, isDirectory: false, isFile: true, body });
  const dir = (name: string, kids: Fake[]): Fake => ({ name, isDirectory: true, isFile: false, kids });
  // Like Chrome: readEntries hands out batches, then an empty one.
  const entry = (f: Fake): FileSystemEntry => (f.isDirectory
    ? {
      ...f,
      createReader: () => {
        let sent = false;
        return { readEntries: (ok: (e: FileSystemEntry[]) => void) => { ok(sent ? [] : f.kids!.map(entry)); sent = true; } };
      },
    }
    : { ...f, file: (ok: (x: File) => void) => ok(new File([f.body!], f.name)) }) as unknown as FileSystemEntry;

  it('walks folders parents-first and keeps every original name', async () => {
    const { planDrop } = await import('../app/fileDropZones');
    const plan = await planDrop([
      { entry: entry(dir('photos', [file('a b.jpg'), dir('2024', [file('é.png')]), dir('empty', [])])), file: null },
      { entry: null, file: new File(['x'], 'loose.txt') },
    ]);
    expect(plan.top).toEqual(['photos', 'loose.txt']);
    expect(plan.dirs).toEqual(['photos', 'photos/2024', 'photos/empty']);
    expect(plan.files.map((f) => f.rel)).toEqual(['photos/a b.jpg', 'photos/2024/é.png', 'loose.txt']);
  });

  it('refuses a drop past the item cap instead of uploading part of it', async () => {
    const { planDrop } = await import('../app/fileDropZones');
    const { FS_UPLOAD_MAX_ITEMS } = await import('../lib/fsUpload');
    const many = Array.from({ length: FS_UPLOAD_MAX_ITEMS + 1 }, (_, i) => file(`f${i}`));
    await expect(planDrop([{ entry: entry(dir('big', many)), file: null }])).rejects.toThrow(/archive/);
  });
});
