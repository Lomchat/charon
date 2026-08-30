import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../lib/fileRange';
import {
  buildAgentFileStreamSshArgs, buildAgentZipStreamSshArgs,
} from '../lib/server/agent/sshShared.js';

describe('large file byte ranges', () => {
  it('accepts full, open-ended and suffix ranges', () => {
    expect(parseByteRange(null, 1000)).toEqual({ ok: true, range: null });
    expect(parseByteRange('bytes=100-199', 1000)).toEqual({
      ok: true, range: { start: 100, end: 199, length: 100 },
    });
    expect(parseByteRange('bytes=900-', 1000)).toEqual({
      ok: true, range: { start: 900, end: 999, length: 100 },
    });
    expect(parseByteRange('bytes=-25', 1000)).toEqual({
      ok: true, range: { start: 975, end: 999, length: 25 },
    });
  });

  it('clamps an end beyond EOF and rejects malformed/unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=950-5000', 1000)).toEqual({
      ok: true, range: { start: 950, end: 999, length: 50 },
    });
    for (const value of ['bytes=100-50', 'bytes=1000-', 'bytes=-0', 'bytes=0-1,4-5', 'items=0-1']) {
      expect(parseByteRange(value, 1000), value).toEqual({ ok: false });
    }
    expect(parseByteRange('bytes=0-0', 0)).toEqual({ ok: false });
  });
});

describe('dedicated SSH file stream command', () => {
  const vps = { ip: '127.0.0.1', sshUser: 'root', sshPort: 22 };

  it('base64url-encodes paths instead of interpolating shell syntax', () => {
    const hostileRoot = "/srv/a'$(touch nope)";
    const hostilePath = 'data/file\n--oops.bin';
    const args = buildAgentFileStreamSshArgs(vps, {
      root: hostileRoot, path: hostilePath,
      offset: 12, length: 34, expectedVersion: 'a:b:c:d',
    });
    const command = args.at(-1)!;
    expect(command).toContain('--stream-file ');
    expect(command).toContain('--offset 12 --length 34');
    expect(command).not.toContain(hostileRoot);
    expect(command).not.toContain(hostilePath);
    expect(command).not.toContain('touch nope');
  });

  it('refuses unsafe numeric arguments before spawning ssh', () => {
    expect(() => buildAgentFileStreamSshArgs(vps, {
      root: '/srv', path: 'x', offset: -1, length: 1,
    })).toThrow(/non-negative safe integers/);
  });

  it('builds an injection-safe streaming ZIP command for a directory', () => {
    const hostileRoot = "/srv/a'$(touch nope)";
    const hostilePath = 'folder\n--oops';
    const args = buildAgentZipStreamSshArgs(vps, {
      root: hostileRoot, path: hostilePath,
    });
    const command = args.at(-1)!;
    expect(command).toContain('--stream-zip ');
    expect(command).not.toContain(hostileRoot);
    expect(command).not.toContain(hostilePath);
    expect(command).not.toContain('touch nope');
  });
});
