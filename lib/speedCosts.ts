// Published speed and cost of the faster tiers, as one-line tooltip hints.
//
// Figures, not guesses: a model the sources do not cover gets no number.
// Sources (re-check when the providers move them):
// - Codex: https://learn.chatgpt.com/docs/pricing (usage multipliers) and
//   https://learn.chatgpt.com/docs/agent-configuration/speed (speed). The
//   catalog's own tier description ("2x speed, …") wins for Fast's speed.
// - Claude: Anthropic fast mode, `speed: "fast"`: up to 2.5× output speed at
//   2× the per-token price (Opus 5.5 $8/$40 vs $4/$20; Fable 5.2 $16/$80).

const times = (n: number) => `${n}×`;

type CodexUsage = { tier: string; models: RegExp; plan: number; credits: number; promo?: { credits: number; until: string; label: string } };

const CODEX_USAGE: CodexUsage[] = [
  { tier: 'priority', models: /^gpt-6\.2-(astra|sol)\b/, plan: 2, credits: 2 },
  { tier: 'priority', models: /^gpt-6\.1-(sol|terra)\b|^gpt-6-(astra|sol|luna)\b/, plan: 2.5, credits: 2 },
  { tier: 'ultrafast', models: /^gpt-6\.2-(astra|sol)\b/, plan: 6, credits: 6,
    promo: { credits: 3, until: '2027-03-01T08:00:00Z', label: 'until Feb 28, 2027' } },
  { tier: 'ultrafast', models: /^gpt-6-astra\b|^gpt-6\.1-sol\b/, plan: 8, credits: 6 },
];

const CODEX_ULTRAFAST_SPEED: { models: RegExp; upTo: number }[] = [
  { models: /^gpt-6\.2-(astra|sol)\b/, upTo: 4.5 },
  { models: /^gpt-6-astra\b/, upTo: 8 },
];

/** "≈2× faster · 2× plan usage (2× on credits)" for a Codex speed tier on a
 *  model; `catalogHint` is the tier's own description. Standard = 1×. */
export function codexSpeedHint(tier: string, modelId: string, catalogHint?: string, now = Date.now()): string {
  if (tier === 'default') return 'Normal speed · normal usage';
  const parts: string[] = [];
  const said = /(\d+(?:\.\d+)?)\s*x\s+speed/i.exec(catalogHint ?? '')?.[1];
  const upTo = tier === 'ultrafast' ? CODEX_ULTRAFAST_SPEED.find((s) => s.models.test(modelId))?.upTo : undefined;
  if (said) parts.push(`≈${times(Number(said))} faster`);
  else if (upTo) parts.push(`up to ${times(upTo)} faster`);
  const usage = CODEX_USAGE.find((u) => u.tier === tier && u.models.test(modelId));
  if (usage) {
    const promo = usage.promo && now < Date.parse(usage.promo.until) ? usage.promo : null;
    parts.push(`${times(usage.plan)} plan usage (${times(promo ? promo.credits : usage.credits)} on credits${promo ? ` ${promo.label}` : ''})`);
  } else if (/increased usage/i.test(catalogHint ?? '')) {
    parts.push('more plan usage');
  }
  return parts.join(' · ') || catalogHint || '';
}

/** The fleet default's span over every model, for Settings. */
export function codexSpeedRange(tier: string): string | null {
  const rows = CODEX_USAGE.filter((u) => u.tier === tier);
  if (!rows.length) return null;
  const plans = rows.map((u) => u.plan);
  const lo = Math.min(...plans), hi = Math.max(...plans);
  return `${lo === hi ? times(lo) : `${lo}–${times(hi)}`} plan usage`;
}

/** Claude's fast mode: the same figures on every model that has it. */
export const CLAUDE_FAST_HINT = 'Up to 2.5× faster output · 2× the price per token';
