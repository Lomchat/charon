// The user's own `/` commands (§14.121): named prompts the composer expands
// before sending. The hub only stores them; expansion is the browser's.
import 'server-only';
import crypto from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { db, userCommands } from '@/lib/db';
import { RESERVED_SLASH_NAMES, USER_COMMAND_NAME_RE } from '@/lib/slashCommands';
import type { UserCommand, UserCommandInput } from '@/lib/types/api';

const MAX_PROMPT = 20_000;
const MAX_DESCRIPTION = 200;
const MAX_COMMANDS = 200;

function view(row: typeof userCommands.$inferSelect): UserCommand {
  return { id: row.id, name: row.name, description: row.description, prompt: row.prompt, updatedAt: row.updatedAt };
}

export function listUserCommands(): UserCommand[] {
  return db.select().from(userCommands).orderBy(asc(userCommands.name)).all().map(view);
}

/** Checked input; `partial` = an update (any subset). Throws a user-facing message. */
export function parseUserCommandInput(raw: unknown, partial = false): Partial<UserCommandInput> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Partial<UserCommandInput> = {};
  if (r.name !== undefined || !partial) {
    const name = typeof r.name === 'string' ? r.name.trim().replace(/^\//, '').toLowerCase() : '';
    if (!USER_COMMAND_NAME_RE.test(name)) {
      throw new Error('The name takes lowercase letters, digits, ".", "-" or "_" (40 at most), and starts with a letter or digit.');
    }
    if (RESERVED_SLASH_NAMES.has(name)) throw new Error(`/${name} is one of Charon's own commands.`);
    out.name = name;
  }
  if (r.description !== undefined) {
    if (typeof r.description !== 'string') throw new Error('The description must be text.');
    out.description = r.description.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
  }
  if (r.prompt !== undefined || !partial) {
    const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
    if (!prompt) throw new Error('The prompt is empty.');
    if (prompt.length > MAX_PROMPT) throw new Error(`The prompt is too long (${MAX_PROMPT} characters at most).`);
    out.prompt = prompt;
  }
  return out;
}

function nameTaken(name: string, exceptId?: string): boolean {
  const row = db.select({ id: userCommands.id }).from(userCommands).where(eq(userCommands.name, name)).get();
  return !!row && row.id !== exceptId;
}

export function createUserCommand(input: Partial<UserCommandInput>): string {
  if (db.select({ id: userCommands.id }).from(userCommands).all().length >= MAX_COMMANDS) {
    throw new Error(`${MAX_COMMANDS} commands at most.`);
  }
  if (nameTaken(input.name!)) throw new Error(`/${input.name} already exists.`);
  const id = crypto.randomBytes(8).toString('hex');
  db.insert(userCommands).values({
    id, name: input.name!, description: input.description ?? '', prompt: input.prompt!,
  }).run();
  return id;
}

export function updateUserCommand(id: string, input: Partial<UserCommandInput>): void {
  const row = db.select().from(userCommands).where(eq(userCommands.id, id)).get();
  if (!row) throw new Error('This command no longer exists.');
  if (input.name && nameTaken(input.name, id)) throw new Error(`/${input.name} already exists.`);
  db.update(userCommands).set({ ...input, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(userCommands.id, id)).run();
}

export function deleteUserCommand(id: string): void {
  db.delete(userCommands).where(eq(userCommands.id, id)).run();
}
