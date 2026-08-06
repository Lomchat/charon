import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readPyzVersion } from '@/lib/server/agent/pyzVersion';

// The committed artefact and the sources MUST declare the same __version__.
//
// This is the guard rail of the version-ordered update rule (§14.6): the hub
// only redeploys when the version it SHIPS is strictly newer than the one a
// VPS reports. `readPyzVersion` reads the .pyz precisely so a forgotten
// rebuild can never advertise a version the shipped bytes don't carry — this
// test makes that mistake red in CI instead of silent.
const ROOT = path.resolve(__dirname, '..');
const PYZ = path.join(ROOT, 'agent/dist/charon-agent.pyz');
const SRC = path.join(ROOT, 'agent/charon_agent/__init__.py');

describe('built agent version', () => {
  it('reads __version__ out of the committed pyz', () => {
    const v = readPyzVersion(PYZ);
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('pyz version === sources version (rebuild the pyz after bumping!)', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const m = /^__version__\s*=\s*['"]([^'"]+)['"]/m.exec(src);
    expect(m, 'no __version__ in agent/charon_agent/__init__.py').toBeTruthy();
    expect(
      readPyzVersion(PYZ),
      'agent/dist/charon-agent.pyz is stale — run `bash agent/build.sh` and commit it',
    ).toBe(m![1]);
  });

  it('returns null on a missing / non-zip file', () => {
    expect(readPyzVersion(path.join(ROOT, 'does-not-exist.pyz'))).toBeNull();
    expect(readPyzVersion(SRC)).toBeNull();
  });
});
