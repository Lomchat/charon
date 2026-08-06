// Read `charon_agent.__version__` OUT OF a built .pyz — the version the hub
// would actually deploy, not the one sitting in the sources.
//
// Why parse the artefact instead of `agent/charon_agent/__init__.py`:
// staleness is now version-ordered (§14.6), so the hub deploys when
// built > deployed. If the hub advertised the SOURCE version while shipping a
// stale (not-rebuilt) pyz, every update would deploy bytes that report the OLD
// version back — "still outdated" — and the fleet would be redeployed every
// 30min forever. Reading the pyz makes that class of loop impossible: what we
// compare is what we ship. (`tests/builtAgentVersion.test.ts` additionally
// pins pyz == sources so the mismatch is caught in CI.)
//
// A zipapp is [optional shebang line] + [a plain ZIP archive], so this is a
// minimal ZIP reader: locate the End Of Central Directory, walk the central
// directory to the entry, inflate it. Node stdlib only (node:zlib) — no dep,
// and the file is ~70KB so reading it whole is free.

import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const VERSION_RE = /^__version__\s*=\s*['"]([^'"]+)['"]/m;

/** Extract one file's bytes from a (possibly shebang-prefixed) zip buffer. */
function readZipEntry(buf: Buffer, wanted: string): Buffer | null {
  // --- End Of Central Directory: scan backwards (max 64KB of trailing comment)
  let eocd = -1;
  const floor = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const entries = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  // The offsets inside the archive are relative to the start of the ZIP, which
  // sits AFTER the shebang line. Recover that prefix length from the EOCD
  // (which physically follows the central directory) rather than assuming the
  // shebang's byte length — build.sh may change it.
  const prefix = eocd - cenSize - cenOffset;
  if (prefix < 0) return null;

  // --- Central directory walk
  let p = prefix + cenOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) return null;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      // --- Local header: its name/extra lengths are authoritative for the
      // data offset (the extra field commonly differs from the central one).
      const lp = prefix + localOff;
      if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== LOC_SIG) return null;
      const lNameLen = buf.readUInt16LE(lp + 26);
      const lExtraLen = buf.readUInt16LE(lp + 28);
      const start = lp + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return zlib.inflateRawSync(raw);
      return null; // unsupported compression — build.sh only emits 0/8
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

/**
 * `__version__` declared inside `<pyz>/charon_agent/__init__.py`, or null when
 * the file is absent / unreadable / not a zipapp. Never throws.
 */
export function readPyzVersion(pyzPath: string): string | null {
  try {
    const buf = fs.readFileSync(pyzPath);
    const entry = readZipEntry(buf, 'charon_agent/__init__.py');
    if (!entry) return null;
    const m = VERSION_RE.exec(entry.toString('utf8'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}
