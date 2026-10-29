import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Browser page translation rewrites text nodes under React, and the next
// re-render throws removeChild/insertBefore NotFoundError (the view falls into
// its error screen). Every document root must opt out.
describe('browser translation', () => {
  it.each(['app/layout.tsx', 'app/global-error.tsx'])('%s opts its <html> out', (file) => {
    const source = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    const tags = source.match(/<html\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toContain('translate="no"');
  });
});
