// The client build this hub process serves (`dist/client/BUILD_ID`, written by
// scripts/build-client.mjs), read ONCE per process.
// The proto-2 `sync_hello` and the SSR stamp carry it so a tab can tell it
// runs an older client than the hub (version skew after a deploy) and offer
// an idle-gated reload (§14.57) — never a forced one.
import fs from 'node:fs';
import path from 'node:path';

const FALLBACK = 'development';

function readBuildId(): string {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'dist', 'client', 'BUILD_ID'), 'utf8').trim();
    // A short url-safe id; anything else is not one.
    return /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/** `dist/client/BUILD_ID`, else `'development'` (dev server, tests). */
export function buildId(): string {
  const g = globalThis as unknown as { __charonBuildId?: string };
  return g.__charonBuildId ??= readBuildId();
}
