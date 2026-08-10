import { describe, it, expect, vi } from 'vitest';

// `git.ts` pulls in AgentClientPool, which is `server-only` and therefore
// unresolvable outside Next. The function under test is pure; the pool is
// stubbed purely so the module graph loads.
vi.mock('@/lib/server/agent/AgentClientPool', () => ({ getAgentClientForVpsId: () => null }));

const { webUrlFromRemote } = await import('@/lib/server/claude/git');

// The remote is a string out of a VPS's git config and the result goes into an
// `<a href>`, so this function is a small trust boundary as well as a
// convenience. Two things are pinned: it understands the three spellings a
// remote actually comes in, and it returns null rather than guessing for
// anything it can't rebuild into a plain https URL.

describe('webUrlFromRemote — the shapes that exist in the wild', () => {
  const cases: [string, string][] = [
    ['git@github.com:owner/repo.git', 'https://github.com/owner/repo'],
    ['git@github.com:owner/repo', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo', 'https://github.com/owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['git://github.com/owner/repo.git', 'https://github.com/owner/repo'],
    // credentials in the URL must not survive into the link
    ['https://user:token@github.com/owner/repo.git', 'https://github.com/owner/repo'],
    // self-hosted, nested groups — the reason this is host-agnostic
    ['git@gitlab.example.com:group/sub/repo.git', 'https://gitlab.example.com/group/sub/repo'],
    ['https://bitbucket.org/team/repo.git', 'https://bitbucket.org/team/repo'],
    // an ssh port is meaningless to a browser
    ['ssh://git@git.example.com:2222/o/r.git', 'https://git.example.com/o/r'],
    ['git@git.example.com:2222/o/r.git', 'https://git.example.com/o/r'],
    ['https://github.com/owner/repo/', 'https://github.com/owner/repo'],
  ];
  for (const [input, want] of cases) {
    it(input, () => expect(webUrlFromRemote(input)).toBe(want));
  }
});

describe('webUrlFromRemote — refuses anything it cannot rebuild', () => {
  const nulls = [
    '', '   ', null, undefined,
    '/srv/local/repo.git',            // a local path is not browsable
    '../relative/repo',
    'file:///srv/repo.git',
    'host-without-dot:owner/repo',    // not a public hostname
    'git@github.com:',                // no path
    // and the ones that matter: nothing may smuggle a scheme or a traversal
    // into the href we build.
    'javascript:alert(1)',
    'git@github.com:../../etc/passwd',
    'https://github.com/a/b?x=1',
    'https://github.com/a/b#frag',
  ];
  for (const input of nulls) {
    it(JSON.stringify(input), () => expect(webUrlFromRemote(input as string)).toBeNull());
  }

  it('never emits anything but an https origin', () => {
    for (const [input] of [
      ['git@github.com:o/r.git'], ['https://x.io/a/b'], ['ssh://git@y.dev/c/d.git'],
    ] as [string][]) {
      const out = webUrlFromRemote(input)!;
      expect(out.startsWith('https://')).toBe(true);
      expect(() => new URL(out)).not.toThrow();
    }
  });
});
