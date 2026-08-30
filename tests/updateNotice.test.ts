import { describe, it, expect } from 'vitest';
import { displayVersion } from '@/lib/version';
import {
  formatUpdateSummary, formatUpdateAnnouncement, recordFailure, clearFailure,
  type FailureLedger,
} from '@/lib/server/claude/updateNotice';

// The fleet auto-update notification is the most frequent thing Charon says on
// Telegram (four staleness axes × a near-daily release cadence). What is
// pinned here is READABILITY and VOLUME, both of which regressed silently
// before: the target versions belong in the head, once; a failure is news at
// most once per target; a trailing `.0` is noise.

describe('displayVersion', () => {
  it('drops a trailing .0', () => {
    expect(displayVersion('1.123.0')).toBe('1.123');
    expect(displayVersion('0.147.0')).toBe('0.147');
    expect(displayVersion('0.77.0')).toBe('0.77');
  });

  it('leaves a meaningful patch alone', () => {
    expect(displayVersion('0.150.1')).toBe('0.150.1');
    expect(displayVersion('0.2.145')).toBe('0.2.145');
  });

  it('never trims below two segments', () => {
    expect(displayVersion('1.0.0')).toBe('1.0');
    expect(displayVersion('10.0')).toBe('10.0');
  });

  it('is total on empty/unknown input', () => {
    expect(displayVersion(null)).toBe('');
    expect(displayVersion(undefined)).toBe('');
    expect(displayVersion('  0.150.1 ')).toBe('0.150.1');
  });
});

describe('formatUpdateSummary', () => {
  const nine = ['chalco', 'HOST_AMD', 'IMMERSIO', 'kasspi', 'WS_4RTX_1', 'WS_DB', 'WS_FS_1', 'WS_KAMAILIO', 'WS_MASTER'];

  it('states the target ONCE and then only names', () => {
    const text = formatUpdateSummary({
      targets: ['codex-cli 0.150.1'],
      updated: nine.map((name) => ({ name })),
      failed: [],
      busy: [],
    });
    expect(text).toBe(
      '🔄 codex-cli 0.150.1 → 9 VPS\n'
      + `✓ ${nine.join(', ')}`,
    );
    // The version appears exactly once — the old shape repeated the whole
    // 4-version tuple after every name, on one line.
    expect(text.match(/0\.150\.1/g)).toHaveLength(1);
  });

  it('shows a ratio as soon as some VPS did not make it', () => {
    const text = formatUpdateSummary({
      targets: ['codex-cli 0.150.1', 'charon-agent v0.77'],
      updated: [{ name: 'HOST_AMD' }],
      failed: [{ name: 'ElevenDuel', detail: 'restart failed: [timeout]' }],
      busy: ['WS_DB'],
    });
    expect(text.split('\n')).toEqual([
      '🔄 codex-cli 0.150.1 + charon-agent v0.77 → 1/3 VPS',
      '✓ HOST_AMD',
      '⏸ WS_DB — busy, retry later',
      '✗ ElevenDuel · restart failed: [timeout]',
    ]);
  });

  it('details a VPS only when its result diverged from the target', () => {
    const text = formatUpdateSummary({
      targets: ['claude-agent-sdk 0.2.145'],
      updated: [{ name: 'HOST_AMD' }, { name: 'kasspi', detail: 'still claude 0.2.144' }],
      failed: [],
      busy: [],
    });
    expect(text).toContain('✓ HOST_AMD, kasspi (still claude 0.2.144)');
  });

  it('marks a failure already reported for this target', () => {
    const text = formatUpdateSummary({
      targets: ['codex-cli 0.150.1'],
      updated: [{ name: 'HOST_AMD' }],
      failed: [{ name: 'ElevenDuel', detail: 'restart failed: [timeout]', repeated: true }],
      busy: [],
    });
    expect(text).toContain('✗ ElevenDuel · restart failed: [timeout] (still)');
  });

  it('has nothing to say when nothing was attempted', () => {
    expect(formatUpdateSummary({ targets: ['codex-cli 0.150.1'], updated: [], failed: [], busy: ['WS_DB'] })).toBe('');
  });
});

describe('formatUpdateAnnouncement', () => {
  it('groups VPSes by transition instead of one bullet each', () => {
    const text = formatUpdateAnnouncement({
      targets: ['codex-cli 0.150.1'],
      behind: [
        { name: 'ElevenDuel', reason: 'cli 0.150→0.150.1' },
        { name: 'kasspi', reason: 'cli 0.150→0.150.1' },
        { name: 'WS_DB', reason: 'cli 0.147→0.150.1' },
      ],
    });
    expect(text.split('\n')).toEqual([
      '⬆ codex-cli 0.150.1 available — auto-update is OFF',
      'cli 0.150→0.150.1 · ElevenDuel, kasspi',
      'cli 0.147→0.150.1 · WS_DB',
      'Update from the sidebar button (3 VPS).',
    ]);
  });

  it('says nothing when no VPS is behind', () => {
    expect(formatUpdateAnnouncement({ targets: ['codex-cli 0.150.1'], behind: [] })).toBe('');
  });
});

describe('failure ledger', () => {
  it('reports a failure once per target, not once per retry', () => {
    const ledger: FailureLedger = new Map();
    expect(recordFailure(ledger, 'vps1', 'target-A')).toBe(true);  // news
    expect(recordFailure(ledger, 'vps1', 'target-A')).toBe(false); // 30min later, same wall
    expect(recordFailure(ledger, 'vps1', 'target-A')).toBe(false);
    expect(recordFailure(ledger, 'vps1', 'target-B')).toBe(true);  // a new version IS news
  });

  it('forgets a VPS that recovered, so its next failure is news again', () => {
    const ledger: FailureLedger = new Map();
    recordFailure(ledger, 'vps1', 'target-A');
    expect(clearFailure(ledger, 'vps1')).toBe(true);   // recovered
    expect(clearFailure(ledger, 'vps1')).toBe(false);  // already clean
    expect(recordFailure(ledger, 'vps1', 'target-A')).toBe(true);
  });

  it('keeps VPSes independent', () => {
    const ledger: FailureLedger = new Map();
    expect(recordFailure(ledger, 'vps1', 'target-A')).toBe(true);
    expect(recordFailure(ledger, 'vps2', 'target-A')).toBe(true);
    expect(recordFailure(ledger, 'vps1', 'target-A')).toBe(false);
  });
});
