/** One hub-owned account per provider (§14.115): every new session runs on
 *  one, so a test that creates sessions seeds them. Credentials stay an opaque
 *  placeholder — nothing here pushes them to an agent. */
export const TEST_ACCOUNTS = { claude: 'c1c1c1c1c1c1c1c1', codex: 'c2c2c2c2c2c2c2c2', cursor: 'c3c3c3c3c3c3c3c3' } as const;

export function seedProviderAccounts(db: any, schema: any): void {
  for (const [provider, id] of Object.entries(TEST_ACCOUNTS)) {
    db.insert(schema.providerAccounts).values({
      id, provider, name: '', position: 0, email: `${provider}@example.test`, accountKey: `key-${provider}`,
      credentials: 'sealed-placeholder', status: 'ok',
    }).onConflictDoNothing().run();
  }
}
