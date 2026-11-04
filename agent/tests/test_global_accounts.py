import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from charon_agent import global_accounts as ga
from charon_agent import account_profiles as profiles

CLAUDE_ID = '0123456789abcdef'
CODEX_ID = 'fedcba9876543210'
CURSOR_ID = 'aaaaaaaaaaaaaaaa'


def claude_account(token='tok-1', **extra):
    creds = {'accessToken': token, 'expiresAt': 123, 'scopes': ['user:inference'],
             'subscriptionType': 'max', 'rateLimitTier': 'tier',
             'oauthAccount': {'accountUuid': 'acc-1', 'organizationUuid': 'org-1', 'emailAddress': 'a@example.com'}}
    creds.update(extra)
    return {'id': CLAUDE_ID, 'provider': 'claude', 'email': 'a@example.com', 'account_key': 'key-claude',
            'plan': 'max', 'credentials': creds}


class GlobalAccountsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = self.temp.name
        self.env = mock.patch.dict(os.environ, {
            'CHARON_AGENT_HOME': os.path.join(root, 'charon'),
            'CLAUDE_CONFIG_DIR': os.path.join(root, 'host-claude'),
            'CODEX_HOME': os.path.join(root, 'host-codex')})
        self.env.start()
        ga._meta.clear()
        profiles._cache.clear()
        self.home = Path(root) / 'host-claude'
        (self.home / 'projects' / '-srv-app').mkdir(parents=True)
        (self.home / 'settings.json').write_text('{}')
        (self.home / '.claude.json').write_text(json.dumps({'projects': {'/srv/app': {'mcpServers': {}}}, 'oauthAccount': {'accountUuid': 'local'}}))

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_claude_credentials_never_carry_a_refresh_token(self):
        result = ga.apply({'accounts': [claude_account(refreshToken='SECRET')]})
        self.assertEqual(result['applied'], [CLAUDE_ID])
        directory = ga.account_dir('claude', CLAUDE_ID)
        creds = json.loads((directory / '.credentials.json').read_text())['claudeAiOauth']
        self.assertEqual(creds['accessToken'], 'tok-1')
        self.assertNotIn('refreshToken', creds)
        self.assertNotIn('SECRET', (directory / '.credentials.json').read_text())
        self.assertEqual(oct((directory / '.credentials.json').stat().st_mode & 0o777), '0o600')

    def test_claude_home_shares_history_and_settings_with_the_default_home(self):
        ga.apply({'accounts': [claude_account()]})
        directory = ga.account_dir('claude', CLAUDE_ID)
        self.assertEqual(os.readlink(directory / 'projects'), str(self.home / 'projects'))
        self.assertEqual(os.readlink(directory / 'settings.json'), str(self.home / 'settings.json'))
        # A history dir absent from the default home is created THERE first.
        self.assertTrue((self.home / 'file-history').is_dir())
        self.assertTrue((directory / 'file-history').is_symlink())
        # Private `.claude.json`: seeded from the default one, this account's identity.
        seeded = json.loads((directory / '.claude.json').read_text())
        self.assertEqual(seeded['oauthAccount']['accountUuid'], 'acc-1')
        self.assertIn('/srv/app', seeded['projects'])
        local = json.loads((self.home / '.claude.json').read_text())
        self.assertEqual(local['oauthAccount']['accountUuid'], 'local')

    def test_a_refresh_push_rewrites_the_token_but_not_the_cli_state(self):
        ga.apply({'accounts': [claude_account()]})
        directory = ga.account_dir('claude', CLAUDE_ID)
        state = json.loads((directory / '.claude.json').read_text())
        state['cliOwned'] = 1
        (directory / '.claude.json').write_text(json.dumps(state))
        ga.apply({'accounts': [claude_account(token='tok-2')]})
        self.assertEqual(ga.claude_token(CLAUDE_ID), 'tok-2')
        self.assertEqual(json.loads((directory / '.claude.json').read_text())['cliOwned'], 1)

    def test_profile_env_and_status_for_a_global_account(self):
        ga.apply({'accounts': [claude_account(),
                               {'id': CODEX_ID, 'provider': 'codex', 'email': 'c@example.com', 'account_key': 'key-codex',
                                'credentials': {'accessToken': 'at', 'accountId': 'acct', 'planType': 'pro'}}]})
        env = profiles.profile_env('claude', CLAUDE_ID)
        self.assertEqual(env['CLAUDE_CONFIG_DIR'], str(ga.account_dir('claude', CLAUDE_ID)))
        self.assertEqual(env['CLAUDE_CODE_OAUTH_TOKEN'], '')
        codex_env = profiles.profile_env('codex', CODEX_ID)
        self.assertEqual(codex_env['CODEX_HOME'], os.environ['CODEX_HOME'])
        self.assertEqual(profiles.config_dir('codex', CODEX_ID), Path(os.environ['CODEX_HOME']))
        status = asyncio.run(profiles.status('codex', CODEX_ID))
        self.assertTrue(status['logged_in'])
        self.assertEqual(status['account_key'], 'key-codex')
        self.assertEqual(status['email'], 'c@example.com')

    def test_codex_refresh_answer_hands_the_newest_push(self):
        ga.apply({'accounts': [{'id': CODEX_ID, 'provider': 'codex', 'credentials': {'accessToken': 'old', 'accountId': 'acct'}}]})
        ga.apply({'accounts': [{'id': CODEX_ID, 'provider': 'codex', 'credentials': {'accessToken': 'new', 'accountId': 'acct', 'planType': 'pro'}}]})
        self.assertEqual(ga.codex_refresh_answer(CODEX_ID),
                         {'accessToken': 'new', 'chatgptAccountId': 'acct', 'chatgptPlanType': 'pro'})

    def test_global_codex_login_wraps_the_approval_handler(self):
        from charon_agent.codex_session import global_codex_login
        ga.apply({'accounts': [{'id': CODEX_ID, 'provider': 'codex', 'credentials': {'accessToken': 'at', 'accountId': 'acct'}}]})
        calls = []

        class Sync:
            _approval_handler = staticmethod(lambda method, params: {'decision': 'decline', 'm': method})

        class Raw:
            _sync = Sync()

            async def account_login_start(self, params):
                calls.append(params)

        raw = Raw()
        asyncio.run(global_codex_login(raw, CODEX_ID))
        self.assertEqual(calls[0]['type'], 'chatgptAuthTokens')
        self.assertEqual(raw._sync._approval_handler('account/chatgptAuthTokens/refresh', {})['accessToken'], 'at')
        self.assertEqual(raw._sync._approval_handler('item/x', {})['m'], 'item/x')
        # A legacy/default profile is left alone.
        other = Raw()
        asyncio.run(global_codex_login(other, 'default'))
        self.assertEqual(len(calls), 1)

    def test_cursor_key_is_per_account_and_never_falls_back(self):
        from charon_agent.cursor_runtime import effective_api_key
        with mock.patch('charon_agent.cursor_runtime.stored_api_key', return_value='local-key'):
            ga.apply({'accounts': [{'id': CURSOR_ID, 'provider': 'cursor', 'credentials': {'apiKey': 'k1', 'expiresAt': 9}}]})
            self.assertEqual(effective_api_key(CURSOR_ID), 'k1')
            self.assertEqual(effective_api_key(None), 'local-key')
            (ga.account_dir('cursor', CURSOR_ID) / 'cursor-key.json').unlink()
            self.assertIsNone(effective_api_key(CURSOR_ID))
        with mock.patch('charon_agent.cursor_runtime.stored_api_key', return_value=None), \
                mock.patch.dict(os.environ, {'CURSOR_API_KEY': ''}):
            ga.apply({'accounts': [{'id': CURSOR_ID, 'provider': 'cursor', 'credentials': {'apiKey': 'k2'}}]})
            self.assertEqual(effective_api_key(None), 'k2')

    def test_replace_drops_other_global_accounts_but_never_a_legacy_profile(self):
        ga.apply({'accounts': [claude_account(),
                               {'id': CODEX_ID, 'provider': 'codex', 'credentials': {'accessToken': 'a', 'accountId': 'b'}}]})
        legacy = Path(os.environ['CHARON_AGENT_HOME']) / 'accounts' / 'claude' / '1111111111111111'
        legacy.mkdir(parents=True)
        result = ga.apply({'accounts': [claude_account()], 'replace': True})
        self.assertEqual(result['removed'], [CODEX_ID])
        self.assertTrue(legacy.is_dir())
        self.assertFalse(ga.account_dir('codex', CODEX_ID).exists())
        self.assertEqual([a['id'] for a in ga.listing()], [CLAUDE_ID])

    def test_invalid_entries_are_reported_without_blocking_others(self):
        result = ga.apply({'accounts': [{'id': 'bad', 'provider': 'claude'},
                                        {'id': CODEX_ID, 'provider': 'codex', 'credentials': {'accessToken': 'x'}},
                                        claude_account()]})
        self.assertEqual(result['applied'], [CLAUDE_ID])
        self.assertEqual(len(result['errors']), 2)

    def test_merge_history_links_conversations_and_merges_memory(self):
        legacy = Path(os.environ['CHARON_AGENT_HOME']) / 'accounts' / 'claude' / '2222222222222222'
        proj = legacy / 'projects' / '-srv-app'
        (proj / 'memory').mkdir(parents=True)
        (proj / 'sess-1.jsonl').write_text('{"a":1}\n')
        (proj / 'memory' / 'MEMORY.md').write_text('- [B](b.md) — b\n- [Shared](s.md) — s\n')
        (proj / 'memory' / 'b.md').write_text('profile b')
        (proj / 'memory' / 's.md').write_text('profile version')
        home_mem = self.home / 'projects' / '-srv-app' / 'memory'
        home_mem.mkdir(parents=True)
        (home_mem / 'MEMORY.md').write_text('- [Shared](s.md) — s\n- [A](a.md) — a\n')
        (home_mem / 's.md').write_text('home version')
        (legacy / 'history.jsonl').write_text('{"p":1}\n')
        result = ga.merge_history('claude', '2222222222222222')
        self.assertTrue(result['ok'])
        target = self.home / 'projects' / '-srv-app' / 'sess-1.jsonl'
        self.assertEqual(target.read_text(), '{"a":1}\n')
        self.assertEqual(target.stat().st_ino, (proj / 'sess-1.jsonl').stat().st_ino)
        index = (home_mem / 'MEMORY.md').read_text().splitlines()
        self.assertEqual(index, ['- [Shared](s.md) — s', '- [A](a.md) — a', '- [B](b.md) — b'])
        self.assertEqual((home_mem / 's.md').read_text(), 'home version')
        self.assertEqual((home_mem / 's.from-222222.md').read_text(), 'profile version')
        self.assertTrue(ga.transcript_exists('sess-1') is False)  # not a uuid-shaped id
        self.assertEqual(ga.merge_history('claude', '2222222222222222')['linked'], 0)  # idempotent
        self.assertIn('{"p":1}', (self.home / 'history.jsonl').read_text())
        self.assertTrue((proj / 'sess-1.jsonl').exists())  # the legacy home stays intact

    def test_transcript_exists(self):
        sid = '4170cb3f-df5b-4f9b-9246-4a43924483c2'
        (self.home / 'projects' / '-srv-app' / f'{sid}.jsonl').write_text('{}')
        self.assertTrue(ga.transcript_exists(sid))
        self.assertFalse(ga.transcript_exists('4170cb3f-0000-4f9b-9246-4a43924483c2'))
        self.assertFalse(ga.transcript_exists('../../etc/passwd'))


if __name__ == '__main__':
    unittest.main()
