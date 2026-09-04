import { describe, expect, it } from 'vitest';

import {
  advisoriesFromReport,
  blockingAdvisories,
  productionPackageVersions,
} from '../scripts/npm-audit-bulk.mjs';

describe('npm bulk audit', () => {
  it('sends only production-reachable package versions', () => {
    const payload = productionPackageVersions({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/runtime': { version: '1.2.3' },
        'node_modules/dev-only': { version: '2.0.0', dev: true },
        'node_modules/optional-runtime': { version: '3.0.0', optional: true },
        'node_modules/parent/node_modules/@scope/nested': { version: '4.0.0' },
        'node_modules/parent-2/node_modules/runtime': { version: '1.3.0' },
      },
    });

    expect(payload).toEqual({
      '@scope/nested': ['4.0.0'],
      'optional-runtime': ['3.0.0'],
      runtime: ['1.2.3', '1.3.0'],
    });
  });

  it('blocks high and critical advisories but not lower severities', () => {
    const report = {
      alpha: [
        { id: 1, severity: 'moderate', title: 'moderate issue' },
        { id: 2, severity: 'HIGH', title: 'high issue' },
      ],
      beta: [{ id: 3, severity: 'critical', title: 'critical issue' }],
    };

    expect(advisoriesFromReport(report)).toHaveLength(3);
    expect(blockingAdvisories(report).map((entry: { id: number }) => entry.id)).toEqual([2, 3]);
  });

  it('rejects malformed reports instead of treating them as clean', () => {
    expect(() => advisoriesFromReport({ alpha: { severity: 'high' } })).toThrow(/invalid advisories/);
    expect(() => productionPackageVersions({ lockfileVersion: 3 })).toThrow(/packages map/);
  });
});
