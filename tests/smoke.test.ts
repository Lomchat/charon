import { describe, it, expect } from 'vitest';

// Harness smoke test — confirms vitest + the @ alias resolve. Real suites live
// alongside the code (lib/**/*.test.ts) and under tests/.
describe('test harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
