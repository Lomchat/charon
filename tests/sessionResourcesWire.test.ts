import { describe, expect, it } from 'vitest';
import { browserSessionResources } from '@/lib/server/claude/sessionResourcesWire';

describe('browserSessionResources', () => {
  it('keeps only the App fields the inspector reads', () => {
    const out = browserSessionResources({
      ok: true,
      skills: [{ name: 'deploy', path: '/s', interface: { big: true } }],
      apps: [{
        id: 'connector_1', name: 'Drive', description: null,
        is_accessible: true, is_enabled: true, install_url: 'https://x',
        icon_assets: { svg: 'x'.repeat(400) }, app_metadata: { a: 1 }, branding: null,
      }],
      apps_error: null,
    });
    expect(out.apps).toEqual([{
      id: 'connector_1', name: 'Drive', description: null,
      is_accessible: true, is_enabled: true, install_url: 'https://x',
    }]);
    // Skills are rendered in full and pass through untouched.
    expect(out.skills[0].interface).toEqual({ big: true });
    expect(out.apps_error).toBeNull();
  });

  it('leaves results without an App list alone', () => {
    const failure = { ok: false, reason: 'unavailable' };
    expect(browserSessionResources(failure)).toBe(failure);
    const claude = { ok: true, skills: [], commands: [{ name: 'review' }] };
    expect(browserSessionResources(claude)).toBe(claude);
  });
});
