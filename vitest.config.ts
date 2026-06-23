import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Unit-test runner for the TypeScript server/runtime logic. Pure-ish modules
// only — no Next request lifecycle. Tests live next to the code they cover
// (lib/**/*.test.ts) or under tests/. Node environment (better-sqlite3 is a
// native module and the code is server-side).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'lib/**/*.test.ts'],
    globals: false,
    pool: 'forks', // native better-sqlite3 is happier without worker threads
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
