import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { encrypt, decrypt } from '@/lib/server/crypto';

vi.mock('server-only', () => ({}));
import { planRotation, applyRotation, verifyRotation, rewriteEnv } from '../scripts/rotate-master-password.mjs';

// Changing MASTER_PASSWORD must not lose a single stored secret (§12): every
// sealed value the hub keeps — bare, `enc:v1:`-prefixed or nested in a JSON
// config — has to open with the new key and only with it.
describe('rotate-master-password', () => {
  it('re-seals every stored secret under the new key and closes the logins', () => {
    const oldKey = crypto.randomBytes(32), newKey = crypto.randomBytes(32), lostKey = crypto.randomBytes(32);
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE provider_accounts (id TEXT PRIMARY KEY, credentials TEXT NOT NULL);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, provider_config TEXT);
      CREATE TABLE session_messages (id INTEGER PRIMARY KEY, content TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
    `);
    const config = JSON.stringify({
      customEndpoint: { baseUrl: 'https://x', secret: encrypt('endpoint-token', oldKey) },
      pendingConnection: { endpoint: { secret: encrypt('pending-token', oldKey) }, model: 'm' },
      accountProfile: 'a',
    });
    const inTranscript = encrypt('not a secret store', oldKey);
    const alreadyLost = encrypt('gone', lostKey);
    db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('telegram.bot_token', 'enc:v1:' + encrypt('bot-token', oldKey));
    db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('claude.api_key', 'enc:v1:' + alreadyLost);
    db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('app.theme', 'dark');
    db.prepare('INSERT INTO provider_accounts VALUES (?, ?)').run('acc', encrypt('{"refresh":"r"}', oldKey));
    db.prepare('INSERT INTO agent_sessions VALUES (?, ?)').run('s1', config);
    db.prepare('INSERT INTO session_messages VALUES (1, ?)').run(inTranscript);
    db.prepare("INSERT INTO sessions VALUES ('h')").run();

    const plan = planRotation(db, oldKey, newKey);
    expect(plan.undecryptable).toEqual(['app_settings.value#2']);
    applyRotation(db, plan.changes);
    verifyRotation(db, plan.changes, newKey);

    const setting = (k: string) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k) as { value: string }).value;
    expect(decrypt(setting('telegram.bot_token').slice('enc:v1:'.length), newKey)).toBe('bot-token');
    expect(() => decrypt(setting('telegram.bot_token').slice('enc:v1:'.length), oldKey)).toThrow();
    expect(setting('claude.api_key')).toBe('enc:v1:' + alreadyLost);
    expect(setting('app.theme')).toBe('dark');
    const acc = (db.prepare("SELECT credentials FROM provider_accounts").get() as { credentials: string }).credentials;
    expect(decrypt(acc, newKey)).toBe('{"refresh":"r"}');
    const cfg = JSON.parse((db.prepare('SELECT provider_config FROM agent_sessions').get() as { provider_config: string }).provider_config);
    expect(decrypt(cfg.customEndpoint.secret, newKey)).toBe('endpoint-token');
    expect(decrypt(cfg.pendingConnection.endpoint.secret, newKey)).toBe('pending-token');
    expect(cfg.accountProfile).toBe('a');
    expect((db.prepare('SELECT content FROM session_messages').get() as { content: string }).content).toBe(inTranscript);
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('writes the env file literally, whatever the password holds', () => {
    const env = "A=1\nMASTER_PASSWORD='old'\n# note\nexport MASTER_SALT=abc\n";
    expect(rewriteEnv(env, { MASTER_PASSWORD: 'pa$&ss $1 word', MASTER_SALT: 'beef', NEW_KEY: 'v' }))
      .toBe("A=1\nMASTER_PASSWORD='pa$&ss $1 word'\n# note\nMASTER_SALT='beef'\nNEW_KEY='v'\n");
  });
});
