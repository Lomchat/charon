import 'server-only';
import { getSetting, setSetting } from './settings';
import { parsePricingDoc, type PricingTable } from '@/lib/modelPricing';

/**
 * Fetch and cache Cursor's published price table (parser: `lib/modelPricing.ts`).
 *
 * Cached like the Claude catalog (§14.43) and NOT checked into the repo: a
 * hardcoded price list is the exact shape of bug this codebase keeps paying for
 * — it would keep rendering confident numbers long after they stopped being
 * true, and nothing would ever say so.
 *
 * Both failure modes are chosen to read as silence rather than as a wrong
 * number: an unpriced model shows no price, and a failed or empty refresh keeps
 * the last good table instead of blanking every price at once (§14.72e).
 */

// Listed in Cursor's own `llms.txt`, i.e. a machine-readable surface they
// publish on purpose. The rendered HTML page is NOT usable — its tables are
// client-rendered and the numbers are absent from the served markup.
const DOC_URL = 'https://cursor.com/docs/models-and-pricing.md';
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
// The doc is ~40KB; a redirect to something enormous must not be buffered.
const MAX_CHARS = 2 * 1024 * 1024;

function cached(): PricingTable {
  try {
    const raw = getSetting('cursor.pricing_cache');
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed as PricingTable : {};
  } catch { return {}; }
}

let inflight: Promise<PricingTable> | null = null;

async function refresh(): Promise<PricingTable> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(DOC_URL, {
      signal: controller.signal,
      // ⚠ `accept: text/markdown` makes this URL 404 — the docs host content-
      // negotiates and does not offer that type for a file whose own extension
      // is `.md`. `*/*` is the header that works, and asking for the obvious
      // thing was a silent empty price table until it was measured end to end.
      headers: { 'user-agent': 'charon', accept: '*/*' },
    });
    if (!res.ok) return cached();
    const table = parsePricingDoc((await res.text()).slice(0, MAX_CHARS));
    // An empty parse means the document changed shape. Keep the last good table
    // and retry at the next TTL rather than erasing every price at once.
    if (!Object.keys(table).length) return cached();
    setSetting('cursor.pricing_cache', JSON.stringify(table));
    setSetting('cursor.pricing_cache_at', String(Date.now()));
    return table;
  } catch {
    return cached();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The price table, refreshed at most once a day.
 *
 * Never throws, and never blocks on the network when something is cached: a
 * stale price beside a model beats an empty picker while a docs site is slow.
 */
export async function getCursorPricing(): Promise<PricingTable> {
  const at = Number(getSetting('cursor.pricing_cache_at') || '0');
  const have = cached();
  const fresh = at > 0 && Date.now() - at < TTL_MS;
  if (fresh && Object.keys(have).length) return have;
  inflight ??= refresh().finally(() => { inflight = null; });
  // With nothing cached the caller waits; otherwise the stale table answers now
  // and the refresh lands for the next reader.
  return Object.keys(have).length ? have : inflight;
}
