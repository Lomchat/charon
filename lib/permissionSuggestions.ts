/**
 * Claude's own "don't ask again" options for a permission card.
 *
 * The CLI ships them with every escalation (`ToolPermissionContext
 * .suggestions`, the same choices its terminal dialog offers) in this wire
 * shape. A card answer picks one BY INDEX into the list exactly as the agent
 * emitted it, and the agent hands that object back to the CLI verbatim — so
 * filtering for display must keep the original indices.
 */

export type PermissionSuggestionDestination =
  | 'userSettings' | 'projectSettings' | 'localSettings' | 'session';

export interface PermissionSuggestion {
  type: 'addRules' | 'replaceRules' | 'removeRules' | 'setMode'
    | 'addDirectories' | 'removeDirectories';
  rules?: Array<{ toolName: string; ruleContent?: string | null }>;
  behavior?: 'allow' | 'deny' | 'ask';
  mode?: string;
  directories?: string[];
  destination?: PermissionSuggestionDestination;
}

/** One answer button: the suggestion's index in the card's list + its label. */
export interface OfferedSuggestion { index: number; label: string }

const MAX_SUGGESTIONS = 16;

/** Parse untrusted JSON (DB column, agent event) into suggestions, keeping
 *  every entry's position: an unreadable one becomes `null`, never removed. */
export function parseSuggestions(raw: unknown): Array<PermissionSuggestion | null> {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SUGGESTIONS).map((s) =>
    s && typeof s === 'object' && typeof (s as PermissionSuggestion).type === 'string'
      ? s as PermissionSuggestion : null);
}

/** A rule in the CLI's settings / `--allowedTools` spelling. */
export function ruleString(rule: { toolName?: unknown; ruleContent?: unknown }): string {
  const tool = typeof rule.toolName === 'string' ? rule.toolName.trim() : '';
  if (!tool) return '';
  return typeof rule.ruleContent === 'string' && rule.ruleContent
    ? `${tool}(${rule.ruleContent})` : tool;
}

/** The allow rules a picked suggestion adds (what Charon remembers). */
export function allowRulesOf(s: PermissionSuggestion | null | undefined): string[] {
  if (!s || s.type !== 'addRules' || s.behavior !== 'allow' || !Array.isArray(s.rules)) return [];
  return s.rules.map(ruleString).filter(Boolean);
}

const SCOPE: Record<PermissionSuggestionDestination, string> = {
  session: 'this session',
  localSettings: 'this project',
  projectSettings: 'this project, shared',
  userSettings: 'every project',
};

const MODE_WORDS: Record<string, string> = {
  acceptEdits: 'allow all edits (switch to accept edits)',
  default: 'switch to normal',
  auto: 'switch to auto',
};

function labelOf(s: PermissionSuggestion): string | null {
  const scope = s.destination ? SCOPE[s.destination] : undefined;
  const where = scope ? ` — ${scope}` : '';
  if (s.type === 'addRules' && s.behavior === 'allow') {
    const rules = allowRulesOf(s);
    return rules.length ? `always allow ${rules.join(', ')}${where}` : null;
  }
  if (s.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.length) {
    return `allow access to ${s.directories.join(', ')}${where}`;
  }
  if (s.type === 'setMode' && s.mode && MODE_WORDS[s.mode]) return MODE_WORDS[s.mode];
  return null;
}

/** The suggestions worth a button, in the CLI's order, with their indices. */
export function offeredSuggestions(raw: unknown): OfferedSuggestion[] {
  const out: OfferedSuggestion[] = [];
  parseSuggestions(raw).forEach((s, index) => {
    const label = s ? labelOf(s) : null;
    if (label) out.push({ index, label });
  });
  return out;
}

/** The CLI's own words for a permission card (Claude `ToolPermissionContext`):
 *  its prompt sentence, a subtitle, the path that triggered it, and the
 *  sub-agent asking. */
export interface PermissionPrompt {
  title?: string;
  description?: string;
  blockedPath?: string;
  agentId?: string;
}

const PROMPT_FIELDS: Array<[keyof PermissionPrompt, number]> = [
  ['title', 300], ['description', 600], ['blockedPath', 1024], ['agentId', 120],
];

/** Untrusted object or JSON (agent event, DB column) ⇒ a prompt, or
 *  undefined when it says nothing. */
export function parsePermissionPrompt(raw: unknown): PermissionPrompt | undefined {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return undefined; }
  }
  if (!v || typeof v !== 'object') return undefined;
  const out: PermissionPrompt = {};
  for (const [key, max] of PROMPT_FIELDS) {
    const s = (v as Record<string, unknown>)[key];
    if (typeof s === 'string' && s.trim()) out[key] = s.trim().slice(0, max);
  }
  return Object.keys(out).length ? out : undefined;
}
