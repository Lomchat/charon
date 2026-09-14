import type { ModelPrice } from './types/api';

/**
 * Per-model token prices: parsing them, keying them, and saying them.
 *
 * Pure and client-safe, so the parser is testable against the real document and
 * the browser formats the same numbers the server stored. The fetching and
 * caching half lives in `lib/server/claude/cursorPricing.ts`.
 *
 * Why a document at all: the model CATALOG carries no price, no multiplier and
 * no tier (§14.103), while Cursor publishes `models-and-pricing.md` — listed in
 * its own `llms.txt`, plain markdown, $/million tokens per model. Parsing that
 * beats checking a table into this repo, which would keep rendering confident
 * numbers long after they stopped being true.
 */

export type PricingTable = Record<string, ModelPrice>;

/** Match a catalog display name to a doc row.
 *
 *  The two vocabularies differ in punctuation and in one prefix: the catalog
 *  brands its own models ("Cursor Grok 4.6") while the doc lists them bare
 *  ("Grok 4.6"). Everything else lines up on a lowercase alphanumeric key. */
export function priceKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^cursor\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * The same name with its WORDS SORTED — a fallback key.
 *
 * The two sources disagree on word ORDER for the whole Anthropic family: the
 * catalog says "Claude Sonnet 4.6", the doc says "Claude 4.6 Sonnet". That is
 * seven models silently unpriced, which looks exactly like "Cursor doesn't
 * publish this one". Sorting the tokens makes both spellings meet, and it can
 * only merge names built from the same words — a weaker claim than an alias
 * table, and one that needs no maintenance when the next family lands.
 */
export function sortedPriceKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^cursor\s+/, '')
    .split(/[^a-z0-9.]+/)
    .filter(Boolean)
    .sort()
    .join('');
}

/** A doc row's `(Fast)` suffix is a SEPARATE price, not a separate model — the
 *  fast lane costs 2-3x the standard one, which is the single most useful thing
 *  this table knows. Keyed apart so one model can carry both. */
export function fastPriceKey(name: string): string {
  return `${priceKey(name)}#fast`;
}

const FAST_SUFFIX = /\(\s*fast(?:\s+mode)?\s*\)/i;

function money(cell: string): number | null {
  const m = cell.replace(/[,\s]/g, '').match(/\$?(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Strip a markdown link down to its text: `[Composer 2.5](url)` → `Composer 2.5`. */
function cellText(cell: string): string {
  return cell.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`/g, '').trim();
}

/**
 * Parse every `| Model | Provider | Input | Cache write | Cache read | Output |`
 * table in the document.
 *
 * Driven by the HEADER row, never by column position: the doc holds several
 * tables (the first-party pool, then third-party by vendor) and a column could
 * be added or reordered without anyone telling us. A table whose header is not
 * recognised is skipped entirely, so an unrelated table in the same document
 * cannot inject rows.
 */
export function parsePricingDoc(markdown: string): PricingTable {
  const out: PricingTable = {};
  let cols: Record<string, number> | null = null;

  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) { cols = null; continue; }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) { cols = null; continue; }
    // The `| --- | --- |` separator: keep whatever header we just read.
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;

    if (!cols) {
      const header: Record<string, number> = {};
      cells.forEach((c, i) => { header[c.toLowerCase().replace(/\s+/g, '')] = i; });
      cols = (header.model !== undefined && header.input !== undefined
        && header.output !== undefined) ? header : null;
      continue;
    }

    const name = cellText(cells[cols.model] ?? '');
    const input = money(cells[cols.input] ?? '');
    const output = money(cells[cols.output] ?? '');
    if (!name || input === null || output === null) continue;
    const fast = FAST_SUFFIX.test(name);
    const bare = name.replace(FAST_SUFFIX, '').trim();
    const price: ModelPrice = {
      input,
      output,
      cacheRead: cols.cacheread === undefined ? null : money(cells[cols.cacheread] ?? ''),
      cacheWrite: cols.cachewrite === undefined ? null : money(cells[cols.cachewrite] ?? ''),
      provider: cols.provider === undefined ? null : (cellText(cells[cols.provider] ?? '') || null),
    };
    // Indexed under both keys. The exact one wins on lookup; the word-sorted
    // one only ever fills a gap, and never overwrites an exact row.
    const exact = fast ? fastPriceKey(bare) : priceKey(bare);
    const loose = fast ? `${sortedPriceKey(bare)}#fast` : sortedPriceKey(bare);
    out[exact] = price;
    if (!(loose in out)) out[loose] = price;
  }
  return out;
}

/** Attach prices to one catalog entry, by display name then by id. */
export function priceFor(
  table: PricingTable, label: string, id: string,
): { price?: ModelPrice; fastPrice?: ModelPrice } {
  const hit = table[priceKey(label)] ?? table[priceKey(id)]
    ?? table[sortedPriceKey(label)] ?? table[sortedPriceKey(id)];
  const fast = table[fastPriceKey(label)] ?? table[fastPriceKey(id)]
    ?? table[`${sortedPriceKey(label)}#fast`] ?? table[`${sortedPriceKey(id)}#fast`];
  return { ...(hit ? { price: hit } : {}), ...(fast ? { fastPrice: fast } : {}) };
}

// ── Saying it ───────────────────────────────────────────────────────────────

/** `$5 in · $25 out /Mtok` — the rate line under a model.
 *
 *  `$0.5`, not `$0.50`: these are rates, and the doc's own precision is the
 *  honest one to echo — which is why the numbers are stringified as parsed
 *  rather than fixed to a width. */
export function formatPrice(p: ModelPrice | null | undefined): string | null {
  if (!p) return null;
  return `$${p.input} in · $${p.output} out /Mtok`;
}

/**
 * What the fast lane costs, as a multiplier.
 *
 * A multiplier rather than a second rate line because that is the decision:
 * "fast costs 2x" is actionable where "$4 in · $12 out" needs the reader to do
 * the division. Uses OUTPUT, which dominates a coding turn's bill.
 */
export function fastMultiplier(
  price: ModelPrice | null | undefined, fast: ModelPrice | null | undefined,
): string | null {
  if (!price || !fast || price.output <= 0) return null;
  const ratio = fast.output / price.output;
  if (!Number.isFinite(ratio) || ratio <= 1.01) return null;
  return `${Math.round(ratio * 10) / 10}x`;
}

/**
 * A coarse tier, for sorting expensive from cheap at a glance.
 *
 * The bands are round numbers on OUTPUT rate, chosen against the shipped
 * catalog so each holds a meaningful group rather than splitting it evenly:
 * a small model, a workhorse, a frontier model, and the ones that cost real
 * money to run for an hour.
 */
export function priceTier(p: ModelPrice | null | undefined): '$' | '$$' | '$$$' | '$$$$' | null {
  if (!p) return null;
  if (p.output < 5) return '$';
  if (p.output < 15) return '$$';
  if (p.output < 40) return '$$$';
  return '$$$$';
}
