import { describe, it, expect } from 'vitest';
import { agentBuildRelation, isAgentOutdated, compareVersions } from '@/lib/version';

// Agent staleness is VERSION-ORDERED, not sha-equality (§14.6).
//
// The property that matters is antisymmetry: if hub A considers a VPS
// outdated, hub B (running that VPS's build) must NOT consider A's build
// outdated. A strict order gives that for free — which is precisely what the
// old `sha !== builtSha` check could not give, and why two co-tenant hubs on
// different commits rolled a shared VPS back and forth every 30min (§14.70).

describe('agentBuildRelation', () => {
  it('flags a strictly older deployed version as outdated', () => {
    expect(agentBuildRelation('0.23.1', '0.24.0')).toBe('outdated');
    expect(agentBuildRelation('0.23.1', '0.23.2')).toBe('outdated');
    expect(isAgentOutdated('0.9.0', '0.10.0')).toBe(true); // numeric, not lexical
  });

  it('never proposes an update over a NEWER agent (the anti-ping-pong branch)', () => {
    expect(agentBuildRelation('0.24.0', '0.23.1')).toBe('ahead');
    expect(isAgentOutdated('0.24.0', '0.23.1')).toBe(false);
  });

  it('ignores a sha divergence at equal version — bump __version__ to propagate', () => {
    // Same version, whatever the bytes: not an update. The sha is not even an
    // input to the decision, which is the point of this test.
    expect(agentBuildRelation('0.23.1', '0.23.1')).toBe('current');
    expect(isAgentOutdated('0.23.1', '0.23.1')).toBe(false);
  });

  it('acts on nothing when either side is unknown', () => {
    expect(agentBuildRelation(null, '0.24.0')).toBe('unknown');
    expect(agentBuildRelation('0.24.0', null)).toBe('unknown');
    expect(agentBuildRelation('', '')).toBe('unknown');
    expect(isAgentOutdated(undefined, undefined)).toBe(false);
  });

  it('is antisymmetric — two hubs can never both want to deploy (§14.70)', () => {
    const builds = ['0.9.0', '0.10.0', '0.23.1', '0.24.0', '1.0.0'];
    for (const a of builds) {
      for (const b of builds) {
        const aWantsToDeploy = isAgentOutdated(b, a); // hub A ships `a`, VPS runs `b`
        const bWantsToDeploy = isAgentOutdated(a, b);
        expect(aWantsToDeploy && bWantsToDeploy).toBe(false);
        // and equal builds settle instead of oscillating
        if (a === b) expect(aWantsToDeploy || bWantsToDeploy).toBe(false);
      }
    }
  });

  it('converges: after the update the VPS reports the deployed version', () => {
    const built = '0.24.0';
    let deployed = '0.23.1';
    let deploys = 0;
    for (let i = 0; i < 10; i++) {
      if (isAgentOutdated(deployed, built)) { deployed = built; deploys++; }
    }
    // Exactly ONE deploy across ten ticks — no 30min redeploy loop.
    expect(deploys).toBe(1);
  });

  it('reuses compareVersions semantics (0.2.87 < 0.2.116)', () => {
    expect(compareVersions('0.2.87', '0.2.116')).toBe(-1);
    expect(isAgentOutdated('0.2.87', '0.2.116')).toBe(true);
  });
});
