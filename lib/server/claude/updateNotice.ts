// Wording of the fleet auto-update notifications (Telegram + push).
//
// PLAIN module on purpose (no 'server-only', no db): the formatting is the
// whole point and it must be unit-testable — cf. tests/updateNotice.test.ts.
//
// Two rules shape every string here, both born from a real Telegram fil:
//  1. Say the target versions ONCE, in the head. The first version of the
//     summary repeated the same 4-version tuple after each of 9 VPS names, on
//     a single line — the only varying token was the name.
//  2. Only report what the reader can act on. A VPS that fails the same way
//     every 30min (the transient-failure retry, sdkWatch.ts) is ONE piece of
//     news, not one per tick — hence the ledger below.

/** A VPS row in the "✓ updated" list. `detail` is set only when the result
 *  DIVERGED from the target (pip -U is non-fatal, so a VPS can update its pyz
 *  and stay behind on a package) — sameness needs no words. */
export type UpdatedEntry = { name: string; detail?: string };
export type FailedEntry = { name: string; detail: string; repeated?: boolean };

/** `['codex-cli 0.150.1', 'charon-agent v0.77']` → `codex-cli 0.150.1 + charon-agent v0.77` */
function head(targets: string[]): string {
  return targets.length ? targets.join(' + ') : 'agent update';
}

function names(list: string[]): string {
  return list.join(', ');
}

/**
 * The post-run summary — sent after a tick that actually did something.
 * Empty `updated`+`failed` yields '' (the caller must not send it).
 */
export function formatUpdateSummary(input: {
  targets: string[];
  updated: UpdatedEntry[];
  failed: FailedEntry[];
  busy: string[];
}): string {
  const { targets, updated, failed, busy } = input;
  if (updated.length === 0 && failed.length === 0) return '';
  const considered = updated.length + failed.length + busy.length;
  const count = considered > updated.length
    ? `${updated.length}/${considered} VPS`
    : `${updated.length} VPS`;
  const lines: string[] = [`🔄 ${head(targets)} → ${count}`];
  if (updated.length) {
    lines.push(`✓ ${names(updated.map((u) => (u.detail ? `${u.name} (${u.detail})` : u.name)))}`);
  }
  if (busy.length) lines.push(`⏸ ${names(busy)} — busy, retry later`);
  // One line per failure: the reason differs per VPS and is the actionable bit.
  for (const f of failed) {
    lines.push(`✗ ${f.name} · ${f.detail}${f.repeated ? ' (still)' : ''}`);
  }
  return lines.join('\n');
}

/**
 * The "a new version is out" heads-up. Sent ONLY for axes whose auto-update
 * gate is OFF: with the gate on, the summary lands a couple of minutes later
 * and says what actually happened, so announcing first is pure duplication.
 * VPSes are grouped by transition — 11 identical bullets said nothing 1 line
 * could not.
 */
export function formatUpdateAnnouncement(input: {
  targets: string[];
  behind: { name: string; reason: string }[];
}): string {
  const { targets, behind } = input;
  if (behind.length === 0) return '';
  const groups = new Map<string, string[]>();
  for (const b of behind) {
    const g = groups.get(b.reason);
    if (g) g.push(b.name); else groups.set(b.reason, [b.name]);
  }
  const lines = [`⬆ ${head(targets)} available — auto-update is OFF`];
  for (const [reason, list] of groups) lines.push(`${reason} · ${names(list)}`);
  lines.push(`Update from the sidebar button (${behind.length} VPS).`);
  return lines.join('\n');
}

// ── Failure ledger: notify on a CHANGE of state, never on a repeat ──────────
// `vpsId → the update target it is known to be failing on`. In memory, like
// sdkWatch's `attempted` map: losing it on a Charon restart re-announces a
// still-broken VPS once, which is the right amount of reminder.

export type FailureLedger = Map<string, string>;

/** Record a failed update. True ⇒ this is NEWS (first failure, or a new
 *  target since the last one) and belongs in a notification. */
export function recordFailure(ledger: FailureLedger, vpsId: string, target: string): boolean {
  const known = ledger.get(vpsId);
  ledger.set(vpsId, target);
  return known !== target;
}

/** Record a successful update. True ⇒ this VPS was failing and recovered. */
export function clearFailure(ledger: FailureLedger, vpsId: string): boolean {
  return ledger.delete(vpsId);
}
