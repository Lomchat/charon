import { describe, it, expect } from 'vitest';
import type { Vps } from '@/lib/db/schema';
import { backendLauncher, backendAvailability } from '@/app/vpsHealth';
import { PROVIDERS, SESSION_PROVIDERS } from '@/lib/sessionCapabilities';

/**
 * ONE control per backend per VPS.
 *
 * There used to be two for the same fact: a greyed ＋ that said "not signed in"
 * and could not be pressed, plus a separate sign-in button elsewhere on the
 * row. The thing you wanted to click was dead, and the thing that helped was
 * somewhere else. The launcher now changes MEANING with the state, and these
 * pin the two halves of that rule — including the half that stays disabled,
 * since a launcher must never kick off an install.
 */

function vps(over: Partial<Vps> = {}): Vps {
  return {
    id: 'v1', name: 'box', ip: '10.0.0.1', sshUser: 'root', sshPort: 22,
    agentStatus: 'ok', agentLastError: null,
    agentVersion: '9.9.9', agentPyzSha: 'abc', agentLastSeenAt: null,
    sdkVersion: '1.0.0',
    claudeLoggedIn: 1, claudeLoggedInCheckedAt: null,
    codexAvailable: 1, codexLoggedIn: 1, codexLoggedInCheckedAt: null,
    codexSdkVersion: '1.0.0', codexCliVersion: '1.0.0',
    cursorAvailable: 1, cursorLoggedIn: 1, cursorLoggedInCheckedAt: null,
    cursorSdkVersion: '1.0.0',
    ...over,
  } as unknown as Vps;
}

/** Sign this provider OUT on an otherwise healthy box. */
function signedOut(p: (typeof SESSION_PROVIDERS)[number]): Vps {
  return vps({ [PROVIDERS[p].backend.loggedInColumn]: 0 } as Partial<Vps>);
}

describe('one launcher per backend', () => {
  it('starts a session when the backend is ready', () => {
    for (const p of SESSION_PROVIDERS) {
      const l = backendLauncher(vps(), p);
      expect(l.ready, `${p} should be ready`).toBe(true);
      expect(l.enabled).toBe(true);
      expect(l.warn).toBe(false);
      expect(l.fix).toBeNull();
      expect(l.title).toContain(PROVIDERS[p].label);
    }
  });

  it('stays PRESSABLE when only the sign-in is missing, and becomes the sign-in', () => {
    for (const p of SESSION_PROVIDERS) {
      const l = backendLauncher(signedOut(p), p);
      expect(l.ready, p).toBe(false);
      // The whole point: not disabled. A dead button beside a live one
      // elsewhere is the shape this replaces.
      expect(l.enabled, `${p}: a signed-out launcher must stay clickable`).toBe(true);
      expect(l.warn, p).toBe(true);
      expect(l.fix?.action, p).toBe(PROVIDERS[p].backend.login.action);
      // The tooltip names the backend AND says what the click does now.
      expect(l.title).toContain(PROVIDERS[p].label);
      expect(l.title.toLowerCase()).toContain('sign in');
    }
  });

  it('leaves the OTHER backends alone', () => {
    // Each provider's login is independent; signing one out must not disarm
    // its neighbours' buttons.
    for (const p of SESSION_PROVIDERS) {
      const row = signedOut(p);
      for (const other of SESSION_PROVIDERS) {
        if (other === p) continue;
        expect(backendLauncher(row, other).ready, `${p} signed out broke ${other}`).toBe(true);
      }
    }
  });

  it('refuses to become an INSTALL', () => {
    // A missing runtime is repaired by a long, mutating fleet operation. A
    // launcher aimed at "new session" must not start one, so it stays disabled
    // and the agent bar keeps offering the install next to the reason.
    for (const p of SESSION_PROVIDERS) {
      if (!PROVIDERS[p].backend.availability.blocksLaunch) continue;
      const row = vps({ [PROVIDERS[p].backend.availability.column]: 0 } as Partial<Vps>);
      const l = backendLauncher(row, p);
      expect(l.ready, p).toBe(false);
      expect(l.enabled, `${p}: a launcher must not start an install`).toBe(false);
      expect(l.fix, p).toBeNull();
      expect(l.warn, p).toBe(true);
      // It still SAYS why, or a dead button is a mystery.
      expect(l.title).toContain(PROVIDERS[p].label);
      expect(l.title).toContain(backendAvailability(row, p).reason);
    }
  });

  it('stays disabled when the box itself is unreachable', () => {
    const dead = vps({ agentStatus: 'error', agentLastError: 'ssh-unreachable: no route' });
    for (const p of SESSION_PROVIDERS) {
      const l = backendLauncher(dead, p);
      expect(l.ready, p).toBe(false);
      // No sign-in can fix an unreachable box — offering one would send the
      // user into a modal that cannot succeed.
      expect(l.enabled, p).toBe(false);
      expect(l.fix, p).toBeNull();
    }
  });
});
