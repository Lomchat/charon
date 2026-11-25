// The `/` menu of the composer: the provider's own commands and skills plus
// the ones Charon runs itself. Pure: the browser fetches the inventory
// (`GET .../resources`), this shapes it.
import {
  hasEffortAxis, sessionModes, supportsSessionCapability, type SessionProvider,
} from '@/lib/sessionCapabilities';

/** What Charon does itself instead of sending the text. */
export type SlashAction =
  | 'model' | 'effort' | 'mode' | 'rename' | 'clear' | 'aside' | 'rewind' | 'compact' | 'goal'
  | 'review' | 'fork' | 'export' | 'shell' | 'diff' | 'memory' | 'copy' | 'retry'
  | 'sleep' | 'stop' | 'mcp' | 'routine';

export type SlashItem = {
  /** Without its sigil. */
  name: string;
  /** What the menu writes: `/name`, or `$name` for a Codex skill. */
  insert: string;
  description: string;
  /** The arguments, as the provider spells them (`<instructions>`). */
  hint: string;
  tag: 'charon' | 'mine' | 'skill' | 'command';
  action?: SlashAction;
  /** A user command: the prompt it expands to (`$ARGUMENTS` = what follows). */
  prompt?: string;
  /** A Codex skill: sent as a `skill` input item beside the text. */
  skillPath?: string;
};

type CharonCommand = {
  name: string; action: SlashAction; description: string;
  hint: string | ((p: SessionProvider) => string);
  offered: (p: SessionProvider) => boolean;
};

const always = () => true;

const CHARON_COMMANDS: readonly CharonCommand[] = [
  { name: 'model', action: 'model', hint: '[model]', offered: always,
    description: 'Change the model — the picker, or straight to the one you name' },
  { name: 'effort', action: 'effort', hint: '[level]', offered: hasEffortAxis,
    description: 'Change the effort — the picker, or straight to the level you name' },
  { name: 'mode', action: 'mode', hint: (p) => `<${sessionModes(p).join('|')}>`, offered: always,
    description: 'Switch the permission mode' },
  { name: 'rename', action: 'rename', hint: '<name>', offered: always,
    description: 'Rename this session' },
  { name: 'clear', action: 'clear', hint: '', offered: always,
    description: 'Start a new session in this folder (this one stays as it is)' },
  { name: 'btw', action: 'aside', hint: '<question>', offered: (p) => supportsSessionCapability(p, 'sideQuestion'),
    description: 'Ask aside: answered from what the session knows, never added to the conversation' },
  { name: 'rewind', action: 'rewind', hint: '', offered: (p) => supportsSessionCapability(p, 'rewind'),
    description: 'Rewind the conversation to an earlier turn' },
  // A provider with text commands has its own /compact and /goal (Claude's
  // goal IS its `/goal`); for the others Charon runs them.
  { name: 'compact', action: 'compact', hint: '',
    offered: (p) => !supportsSessionCapability(p, 'slashCommands') && supportsSessionCapability(p, 'compact'),
    description: 'Free up context by summarizing the conversation so far' },
  { name: 'goal', action: 'goal', hint: '<objective>',
    offered: (p) => !supportsSessionCapability(p, 'slashCommands') && supportsSessionCapability(p, 'goal'),
    description: 'Set a goal the session keeps working toward' },
  { name: 'review', action: 'review', hint: '[base <branch> | commit <sha>]',
    offered: (p) => supportsSessionCapability(p, 'review'),
    description: 'Review the changes — uncommitted ones, or against a branch, or one commit' },
  { name: 'fork', action: 'fork', hint: '', offered: always,
    description: 'Fork this conversation into a new session' },
  { name: 'export', action: 'export', hint: '', offered: always,
    description: 'Download the conversation as Markdown' },
  { name: 'shell', action: 'shell', hint: '', offered: always,
    description: 'Open a terminal in this folder' },
  { name: 'diff', action: 'diff', hint: '', offered: always,
    description: 'Open source control on this folder' },
  { name: 'memory', action: 'memory', hint: '', offered: always,
    description: "Open the project's instructions file in the editor" },
  { name: 'copy', action: 'copy', hint: '', offered: always,
    description: 'Copy the last answer' },
  { name: 'retry', action: 'retry', hint: '', offered: always,
    description: 'Send your last message again' },
  { name: 'sleep', action: 'sleep', hint: '', offered: always,
    description: 'Put the session to sleep (it resumes on your next message)' },
  { name: 'stop', action: 'stop', hint: '', offered: always,
    description: 'Stop the session now — it can be resumed' },
  { name: 'mcp', action: 'mcp', hint: '', offered: (p) => supportsSessionCapability(p, 'mcp'),
    description: "Show the session's MCP servers" },
  { name: 'routine', action: 'routine', hint: '[prompt]', offered: always,
    description: 'Schedule this prompt to run every week in this folder' },
];

/** Names a user command cannot take: Charon's own always win. */
export const RESERVED_SLASH_NAMES: ReadonlySet<string> = new Set(CHARON_COMMANDS.map((c) => c.name));

/** A user command's name: what follows `/`. */
export const USER_COMMAND_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Whether the session has an inventory worth fetching for the menu. */
export function hasNativeSlashItems(p: SessionProvider): boolean {
  return supportsSessionCapability(p, 'slashCommands') || supportsSessionCapability(p, 'skills');
}

/** Text commands the menu never offers (the CLI lists them all): terminal-only
 *  or unavailable to an SDK host, renamed/removed, or replaced by Charon's
 *  own (above). */
const HIDDEN_COMMANDS = new Set([
  'color', 'focus', 'fast', 'agents', 'extra-usage', 'heapdump', 'ultrareview',
  '__remote-workflow', 'workflow-launch-exec',
  'model', 'effort', 'rename', 'clear', 'btw', 'rewind',
]);

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The provider's part of the menu, from `GET .../resources`. Null = it
 *  answered nothing usable (asleep, an error): keep the last known list.
 *  A provider with text commands lists them (its skills among them, `/name`);
 *  one without names its skills `$name`, sent with their path. */
export function nativeSlashItems(provider: SessionProvider, resources: unknown): SlashItem[] | null {
  const r = (resources && typeof resources === 'object' ? resources : {}) as Raw;
  if (r.ok === false) return null;
  const skills = Array.isArray(r.skills) ? (r.skills as Raw[]) : [];
  if (supportsSessionCapability(provider, 'slashCommands')) {
    const commands = Array.isArray(r.commands) ? (r.commands as Raw[]) : [];
    // Asleep: the CLI is not there to list its commands; the skills on disk
    // are. A partial list only — the caller prefers its last full one.
    if (!commands.length) return null;
    // The CLI's own skill names (agent >= 0.135.0, after a first turn), else
    // the skills on disk; plugin skills are `plugin:name`.
    const skillNames = new Set([
      ...skills.map((s) => str(s.name)),
      ...(Array.isArray(r.skill_names) ? (r.skill_names as unknown[]).map(str) : []),
    ].filter(Boolean));
    return commands.flatMap((c) => {
      const name = str(c.name);
      if (!name || HIDDEN_COMMANDS.has(name)) return [];
      return [{
        name, insert: `/${name}`, description: oneLine(str(c.description)), hint: str(c.argument_hint),
        tag: skillNames.has(name) || name.includes(':') ? 'skill' as const : 'command' as const,
      }];
    });
  }
  if (!supportsSessionCapability(provider, 'skills')) return [];
  if (!Array.isArray(r.skills)) return null;
  return skills.flatMap((s) => {
    const name = str(s.name);
    const path = str(s.path);
    if (!name || !path || s.enabled === false) return [];
    const iface = (s.interface && typeof s.interface === 'object' ? s.interface : {}) as Raw;
    const description = str(iface.short_description) || str(s.short_description) || str(s.description);
    return [{ name, insert: `$${name}`, description: oneLine(description), hint: '', tag: 'skill' as const, skillPath: path }];
  });
}

/** A text-command provider's skills on disk (`/name`), for a sleeping
 *  session with no list known yet. */
export function diskSkills(resources: unknown): SlashItem[] {
  const r = (resources && typeof resources === 'object' ? resources : {}) as Raw;
  const skills = Array.isArray(r.skills) ? (r.skills as Raw[]) : [];
  return skills.flatMap((s) => {
    const name = str(s.name);
    if (!name || s.enabled === false) return [];
    return [{ name, insert: `/${name}`, description: oneLine(str(s.description)), hint: '', tag: 'skill' as const }];
  });
}

/** The user's own commands (Settings › commands) as menu items. */
export function userSlashItems(commands: ReadonlyArray<{ name: string; description: string; prompt: string }>): SlashItem[] {
  return commands.map((c) => ({
    name: c.name, insert: `/${c.name}`, tag: 'mine',
    description: c.description || oneLine(c.prompt).slice(0, 140),
    hint: c.prompt.includes('$ARGUMENTS') ? '<arguments>' : '', prompt: c.prompt,
  }));
}

/** A message that starts with a user command, expanded: `$ARGUMENTS` takes
 *  what follows the name (appended after a blank line when the prompt has no
 *  placeholder). Null = not one. */
export function expandUserCommand(text: string, items: readonly SlashItem[]): string | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const item = items.find((it) => it.prompt != null && it.name === m[1]);
  if (!item) return null;
  const args = (m[2] ?? '').trim();
  if (item.prompt!.includes('$ARGUMENTS')) return item.prompt!.split('$ARGUMENTS').join(args).trim();
  return args ? `${item.prompt}\n\n${args}` : item.prompt!;
}

/** Charon's commands for this provider, the user's, then the native ones
 *  neither replaces, by name. */
export function slashMenu(
  provider: SessionProvider, native: readonly SlashItem[], mine: readonly SlashItem[] = [],
): SlashItem[] {
  const own: SlashItem[] = CHARON_COMMANDS.filter((c) => c.offered(provider)).map((c) => ({
    name: c.name, insert: `/${c.name}`, description: c.description, tag: 'charon', action: c.action,
    hint: typeof c.hint === 'function' ? c.hint(provider) : c.hint,
  }));
  // Charon's, then the user's, then the provider's: the first claim on a name wins.
  const taken = new Set<string>();
  const all: SlashItem[] = [];
  for (const it of [...own, ...mine, ...native]) {
    if (taken.has(it.insert)) continue;
    taken.add(it.insert);
    all.push(it);
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export const isSkillItem = (it: SlashItem): boolean => it.tag === 'skill';

/** Menu order for a query: commands, then skills, each by name prefix, name
 *  substring, then description. `/ski`…`/skills` lists every skill. */
export function filterSlash(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.toLowerCase();
  const rank = (it: SlashItem): number => {
    const n = it.name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.includes(q)) return 1;
    if (it.description.toLowerCase().includes(q)) return 2;
    return -1;
  };
  const pick = (list: SlashItem[], all: boolean): SlashItem[] => (all ? list : list
    .map((it) => [rank(it), it] as const)
    .filter(([r]) => r >= 0)
    .sort((a, b) => a[0] - b[0])
    .map(([, it]) => it));
  const wantsSkills = q.length >= 3 && 'skills'.startsWith(q);
  return [
    ...pick(items.filter((it) => !isSkillItem(it)), !q),
    ...pick(items.filter(isSkillItem), !q || wantsSkills),
  ];
}

/** A message that is a Charon command: `/name args…` at its very start. */
export function parseCharonCommand(
  text: string, items: readonly SlashItem[],
): { item: SlashItem; arg: string } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const item = items.find((it) => it.action && it.name === m[1]);
  return item ? { item, arg: (m[2] ?? '').trim() } : null;
}

/** Skills named in a message (`$name`) that travel as `skill` input items
 *  (only `$` skills carry a path: providers without text commands). */
export function skillInputItems(
  text: string, items: readonly SlashItem[],
): Array<{ type: 'skill'; name: string; path: string }> {
  const byName = new Map(items.filter((it) => it.skillPath).map((it) => [it.name, it.skillPath!]));
  const out: Array<{ type: 'skill'; name: string; path: string }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)\$([A-Za-z0-9._:-]+)/g)) {
    const name = m[1]!.replace(/[.:]+$/, '');
    const path = byName.get(name);
    if (path && !seen.has(name) && out.length < 15) { seen.add(name); out.push({ type: 'skill', name, path }); }
  }
  return out;
}
