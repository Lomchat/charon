import asyncio
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from charon_agent import account_profiles as profiles
from charon_agent.codex_session import CodexSession
from charon_agent.session import AgentSession
from charon_agent.session import _build_options_with_fallback
from charon_agent.usage import _read_oauth
from charon_agent.server import Server


def isolated_env(root):
    """Agent home AND both default provider homes inside the test directory:
    profiles link shared entries from the default homes."""
    return {'CHARON_AGENT_HOME': root, 'CLAUDE_CONFIG_DIR': os.path.join(root, 'host-claude'),
            'CODEX_HOME': os.path.join(root, 'host-codex')}


class ProfileIsolationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, isolated_env(self.temp.name))
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_profiles_have_independent_homes_without_changing_daemon_env(self):
        before = dict(os.environ)
        first = profiles.profile_env('claude', '0123456789abcdef')
        second = profiles.profile_env('claude', 'fedcba9876543210')
        self.assertNotEqual(first['CLAUDE_CONFIG_DIR'], second['CLAUDE_CONFIG_DIR'])
        self.assertEqual(dict(os.environ), before)
        self.assertEqual(first['CLAUDE_CODE_OAUTH_TOKEN'], '')
        self.assertEqual(first['CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'], '')
        self.assertEqual(Path(first['CLAUDE_CONFIG_DIR']).stat().st_mode & 0o777, 0o700)

    def test_invalid_profile_never_resolves_to_default_credentials(self):
        for value in ('../default', '', '/root/.claude', 2, 'ABCDEF0123456789'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                profiles.config_dir('claude', value)

    def test_usage_reads_only_selected_profiles_credentials(self):
        for pid, token in [('0123456789abcdef', 'first'), ('fedcba9876543210', 'second')]:
            directory = profiles.config_dir('claude', pid)
            directory.mkdir(parents=True)
            (directory / '.credentials.json').write_text(json.dumps({'claudeAiOauth': {'accessToken': token}}))
        self.assertEqual(_read_oauth('0123456789abcdef')['accessToken'], 'first')
        self.assertEqual(_read_oauth('fedcba9876543210')['accessToken'], 'second')

    def test_codex_profile_survives_native_state_serialization(self):
        session = CodexSession('session', cwd='/tmp', name=None, permission_mode='normal', claude_session_id=None,
                               on_state_change=lambda: None, emit=lambda _: None,
                               codex_config={'accountProfile': '0123456789abcdef'})
        restored = CodexSession('restored', cwd='/tmp', name=None, permission_mode='normal', claude_session_id=None,
                               on_state_change=lambda: None, emit=lambda _: None,
                                codex_config=session._persisted_codex_config())
        self.assertEqual(restored.codex_config['accountProfile'], '0123456789abcdef')
        with mock.patch('charon_agent.codex_session.make_codex_config', side_effect=lambda **kwargs: kwargs):
            config = restored._session_sdk_config()
        self.assertEqual(config['env']['CODEX_HOME'], str(profiles.config_dir('codex', '0123456789abcdef')))

    def test_selected_claude_profile_overrides_an_inherited_home(self):
        session = AgentSession('session', cwd='/tmp', name=None, permission_mode='normal', claude_session_id=None,
                               on_state_change=lambda: None, emit=lambda _: None,
                               session_config={'accountProfile': '0123456789abcdef', 'env': {'CLAUDE_CONFIG_DIR': '/wrong'}})
        self.assertEqual(session._advanced_option_kwargs()['env']['CLAUDE_CONFIG_DIR'],
                         str(profiles.config_dir('claude', '0123456789abcdef')))

    def test_old_sdk_cannot_drop_the_account_environment_and_use_default_login(self):
        def old_options(**kwargs):
            if 'env' in kwargs:
                raise TypeError("unexpected keyword argument 'env'")
            return kwargs
        with mock.patch('charon_agent.session.ClaudeAgentOptions', old_options):
            with self.assertRaisesRegex(TypeError, 'isolate account profiles'):
                _build_options_with_fallback({'env': {'CLAUDE_CONFIG_DIR': '/isolated'}}, lambda _: None)


class SharedConfigTest(unittest.TestCase):
    PID = '0123456789abcdef'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, isolated_env(self.temp.name))
        self.env.start()
        self.host = Path(os.environ['CLAUDE_CONFIG_DIR'])
        self.host.mkdir()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_profile_shares_settings_and_skills_but_not_login_or_history(self):
        (self.host / 'settings.json').write_text('{"enabledPlugins": {"lsp": true}}')
        (self.host / 'skills' / 'review').mkdir(parents=True)
        (self.host / '.credentials.json').write_text('host login')
        (self.host / '.claude.json').write_text('{"oauthAccount": {}}')
        (self.host / 'projects').mkdir()
        home = Path(profiles.profile_env('claude', self.PID)['CLAUDE_CONFIG_DIR'])
        self.assertTrue((home / 'settings.json').is_symlink())
        self.assertEqual((home / 'settings.json').read_text(), '{"enabledPlugins": {"lsp": true}}')
        self.assertTrue((home / 'skills' / 'review').is_dir())
        for private in ('.credentials.json', '.claude.json', 'projects'):
            self.assertFalse(os.path.lexists(home / private), private)
        # Nothing to share yet: no dangling link the CLI could trip over.
        self.assertFalse(os.path.lexists(home / 'CLAUDE.md'))

    def test_a_profiles_own_file_is_kept_and_later_default_entries_arrive(self):
        home = profiles.config_dir('claude', self.PID)
        home.mkdir(parents=True)
        (home / 'settings.json').write_text('this account only')
        (self.host / 'settings.json').write_text('shared')
        profiles.profile_env('claude', self.PID)
        self.assertFalse((home / 'settings.json').is_symlink())
        self.assertEqual((home / 'settings.json').read_text(), 'this account only')
        (self.host / 'CLAUDE.md').write_text('house rules')
        profiles.profile_env('claude', self.PID)
        self.assertEqual((home / 'CLAUDE.md').read_text(), 'house rules')

    def test_codex_profile_shares_config_but_keeps_its_own_credentials(self):
        host = Path(os.environ['CODEX_HOME'])
        host.mkdir()
        (host / 'config.toml').write_text('model = "gpt"')
        (host / 'AGENTS.md').write_text('rules')
        (host / 'auth.json').write_text('host login')
        (host / 'sessions').mkdir()
        home = Path(profiles.profile_env('codex', self.PID)['CODEX_HOME'])
        self.assertEqual((home / 'config.toml').read_text(), 'model = "gpt"')
        self.assertEqual((home / 'AGENTS.md').read_text(), 'rules')
        self.assertFalse(os.path.lexists(home / 'auth.json'))
        self.assertFalse(os.path.lexists(home / 'sessions'))

    def test_default_profile_links_nothing(self):
        (self.host / 'settings.json').write_text('{}')
        self.assertEqual(profiles.profile_env('claude', 'default'), {})
        self.assertFalse((Path(self.temp.name) / 'accounts').exists())


class ProfileStatusTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, isolated_env(self.temp.name))
        self.env.start()
        profiles._cache.clear()
        profiles._locks.clear()

    async def asyncTearDown(self):
        self.env.stop()
        self.temp.cleanup()
        profiles._cache.clear()
        profiles._locks.clear()

    async def test_external_login_changes_are_detected_without_usage_api_calls(self):
        pid = '0123456789abcdef'
        path = profiles.config_dir('codex', pid)
        path.mkdir(parents=True)
        credential = path / 'auth.json'
        credential.write_text('account A')
        status = mock.AsyncMock(return_value={'ok': True, 'logged_in': True, 'email': 'a@example.com'})
        with mock.patch('charon_agent.codex_login.auth_status', status):
            first = await profiles.status('codex', pid)
            again = await profiles.status('codex', pid)
            self.assertEqual(first['account_key'], again['account_key'])
            status.assert_awaited_once_with(pid)
            credential.write_text('account B')
            status.return_value = {'ok': True, 'logged_in': True, 'email': 'b@example.com'}
            second = await profiles.status('codex', pid)
            self.assertNotEqual(first['account_key'], second['account_key'])
            self.assertEqual(status.await_count, 2)
            self.assertNotIn('account B', json.dumps(second))

    async def test_claude_probe_reads_profile_oauth_even_with_inherited_host_managed_auth(self):
        async def spawn(*args, **kwargs):
            # The CLI suppresses local OAuth when host-managed auth is enabled.
            logged_in = not kwargs['env'].get('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST')
            return types.SimpleNamespace(returncode=0, communicate=mock.AsyncMock(
                return_value=(json.dumps({'loggedIn': logged_in, 'email': 'profile@example.com'}).encode(), b'')))

        with mock.patch.dict(os.environ, {'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST': '1'}), \
                mock.patch('charon_agent.account_profiles.asyncio.create_subprocess_exec', spawn):
            result = await profiles.status('claude', '0123456789abcdef')
        self.assertTrue(result['logged_in'])
        self.assertIsNotNone(result['account_key'])

    async def test_claude_probe_reports_the_accounts_own_display_name_for_the_verified_login_only(self):
        pid = '0123456789abcdef'
        home = profiles.config_dir('claude', pid)
        home.mkdir(parents=True, exist_ok=True)
        (home / '.claude.json').write_text(json.dumps({'oauthAccount': {
            'emailAddress': 'Profile@example.com', 'displayName': 'Ada', 'fullName': 'Ada Lovelace'}}))

        def spawn_for(email):
            async def spawn(*args, **kwargs):
                return types.SimpleNamespace(returncode=0, communicate=mock.AsyncMock(
                    return_value=(json.dumps({'loggedIn': True, 'email': email}).encode(), b'')))
            return spawn

        with mock.patch('charon_agent.account_profiles.asyncio.create_subprocess_exec', spawn_for('profile@example.com')):
            result = await profiles.status('claude', pid, force=True)
        self.assertEqual(result['display_name'], 'Ada')
        # A config file describing ANOTHER login never names this one.
        with mock.patch('charon_agent.account_profiles.asyncio.create_subprocess_exec', spawn_for('other@example.com')):
            result = await profiles.status('claude', pid, force=True)
        self.assertNotIn('display_name', result)

    async def test_a_renamed_claude_account_relabels_without_a_forced_probe(self):
        pid = '0123456789abcdef'
        home = profiles.config_dir('claude', pid)
        home.mkdir(parents=True, exist_ok=True)
        account = {'emailAddress': 'p@example.com', 'accountUuid': 'u', 'organizationUuid': 'o', 'displayName': 'Ada'}
        (home / '.claude.json').write_text(json.dumps({'oauthAccount': account}))
        spawned = []

        async def spawn(*args, **kwargs):
            spawned.append(args)
            return types.SimpleNamespace(returncode=0, communicate=mock.AsyncMock(
                return_value=(json.dumps({'loggedIn': True, 'email': 'p@example.com'}).encode(), b'')))

        with mock.patch('charon_agent.account_profiles.asyncio.create_subprocess_exec', spawn):
            first = await profiles.status('claude', pid, force=True)
            (home / '.claude.json').write_text(json.dumps({'oauthAccount': {**account, 'displayName': 'Grace'}}))
            second = await profiles.status('claude', pid)
        self.assertEqual(first['display_name'], 'Ada')
        self.assertEqual(second['display_name'], 'Grace')
        # Same login: the cache answered (no second CLI run) and the generation held.
        self.assertEqual(len(spawned), 1)
        self.assertEqual(first['generation'], second['generation'])
        self.assertEqual(first['account_key'], second['account_key'])

    async def test_claude_fork_copies_only_the_native_history_to_the_destination_profile(self):
        source_id, target_id = '0123456789abcdef', 'fedcba9876543210'
        server = Server(socket_path=Path(self.temp.name) / 'agent.sock', state_path=Path(self.temp.name) / 'state.json')
        source = types.SimpleNamespace(kind='claude', session_id='session', status='active', cwd='/project',
                                       claude_session_id='original-native', session_config={'accountProfile': source_id})
        server.sessions['session'] = source
        target_dir = profiles.config_dir('claude', target_id)
        target_dir.mkdir(parents=True)
        credential = target_dir / '.credentials.json'
        credential.write_text('destination credentials')
        sdk = types.ModuleType('claude_agent_sdk')
        sdk.fork_session = lambda *_args, **_kwargs: None

        def fork(profile, function, native_id, **kwargs):
            self.assertEqual((profile, function, native_id), (source_id, 'fork_session', 'original-native'))
            transcript = profiles.config_dir('claude', profile) / 'projects' / '-project' / 'branched-native.jsonl'
            transcript.parent.mkdir(parents=True)
            transcript.write_text('branched history')
            return {'session_id': 'branched-native'}

        with mock.patch.dict(sys.modules, {'claude_agent_sdk': sdk}), mock.patch('charon_agent.server.sdk_call', fork):
            result = await server.dispatch('fork_session', {'session_id': 'session', 'account_profile': target_id}, None)
        self.assertEqual(result['claude_session_id'], 'branched-native')
        self.assertEqual((target_dir / 'projects' / '-project' / 'branched-native.jsonl').read_text(), 'branched history')
        self.assertEqual(credential.read_text(), 'destination credentials')
        self.assertEqual(source.claude_session_id, 'original-native')
        self.assertFalse((profiles.config_dir('claude', source_id) / 'projects' / '-project' / 'branched-native.jsonl').exists())

    async def test_claude_fork_between_accounts_sharing_projects_keeps_the_branch(self):
        # Hub accounts link `projects` to one shared dir: "moving" the branch
        # would copy it onto itself, then unlink the only copy.
        source_id, target_id = '0123456789abcdef', 'fedcba9876543210'
        shared = Path(self.temp.name) / 'shared-projects'
        shared.mkdir()
        for pid in (source_id, target_id):
            profiles.config_dir('claude', pid).mkdir(parents=True)
            (profiles.config_dir('claude', pid) / 'projects').symlink_to(shared)
        server = Server(socket_path=Path(self.temp.name) / 'agent.sock', state_path=Path(self.temp.name) / 'state.json')
        server.sessions['session'] = types.SimpleNamespace(kind='claude', session_id='session', status='active', cwd='/project',
                                                           claude_session_id='original-native', session_config={'accountProfile': source_id})
        sdk = types.ModuleType('claude_agent_sdk')
        sdk.fork_session = lambda *_args, **_kwargs: None

        def fork(profile, function, native_id, **kwargs):
            (shared / '-project').mkdir()
            (shared / '-project' / 'branched-native.jsonl').write_text('branched history')
            (shared / '-project' / 'branched-native' / 'subagents').mkdir(parents=True)
            return {'session_id': 'branched-native'}

        with mock.patch.dict(sys.modules, {'claude_agent_sdk': sdk}), mock.patch('charon_agent.server.sdk_call', fork):
            result = await server.dispatch('fork_session', {'session_id': 'session', 'account_profile': target_id}, None)
        self.assertEqual(result['claude_session_id'], 'branched-native')
        self.assertEqual((shared / '-project' / 'branched-native.jsonl').read_text(), 'branched history')
        self.assertTrue((shared / '-project' / 'branched-native' / 'subagents').is_dir())

    async def test_native_account_id_separates_workspaces_using_the_same_email(self):
        pid = '0123456789abcdef'
        directory = profiles.config_dir('codex', pid)
        directory.mkdir(parents=True)
        credentials = directory / 'auth.json'
        credentials.write_text(json.dumps({'tokens': {'account_id': 'workspace-a'}}))
        with mock.patch('charon_agent.codex_login.auth_status', mock.AsyncMock(
                return_value={'ok': True, 'logged_in': True, 'email': 'a@example.com'})):
            first = await profiles.status('codex', pid)
            credentials.write_text(json.dumps({'tokens': {'account_id': 'workspace-b'}}))
            second = await profiles.status('codex', pid)
        self.assertNotEqual(first['account_key'], second['account_key'])

    async def test_refreshing_a_token_keeps_the_same_account_identity(self):
        pid = '0123456789abcdef'
        path = profiles.config_dir('codex', pid)
        path.mkdir(parents=True)
        (path / 'auth.json').write_text('token 1')
        with mock.patch('charon_agent.codex_login.auth_status', mock.AsyncMock(
                return_value={'ok': True, 'logged_in': True, 'email': 'a@example.com'})):
            first = await profiles.status('codex', pid)
            (path / 'auth.json').write_text('token 2')
            second = await profiles.status('codex', pid)
        self.assertEqual(first['account_key'], second['account_key'])
        self.assertNotEqual(first['generation'], second['generation'])

    async def test_cached_key_serves_a_session_whose_start_probe_failed(self):
        pid = '0123456789abcdef'
        self.assertIsNone(profiles.cached_account_key('codex', pid))
        self.assertIsNone(profiles.cached_account_key('codex', '../escape'))
        path = profiles.config_dir('codex', pid)
        path.mkdir(parents=True)
        (path / 'auth.json').write_text('token')
        with mock.patch('charon_agent.codex_login.auth_status', mock.AsyncMock(
                return_value={'ok': True, 'logged_in': True, 'email': 'a@example.com'})):
            status = await profiles.status('codex', pid)
        self.assertEqual(profiles.cached_account_key('codex', pid), status['account_key'])

    async def test_rate_limit_events_fall_back_to_the_last_verified_key(self):
        events = []
        session = AgentSession('session', cwd='/tmp', name=None, permission_mode='normal', claude_session_id=None,
                               on_state_change=lambda: None, emit=events.append,
                               session_config={'accountProfile': '0123456789abcdef'})
        session._account_key = None
        with mock.patch('charon_agent.session.cached_account_key', return_value='verified'):
            session._emit('rate_limit', status='allowed')
        self.assertEqual(events[-1]['account_key'], 'verified')
        self.assertEqual(events[-1]['account_profile'], '0123456789abcdef')

    def test_live_rate_limit_path_carries_the_profile(self):
        # The real reader goes _translate → _wire_event, never _emit: an
        # untagged reading was filed under the VPS's DEFAULT account.
        session = AgentSession('session', cwd='/tmp', name=None, permission_mode='normal', claude_session_id=None,
                               on_state_change=lambda: None, emit=lambda _: None,
                               session_config={'accountProfile': '0123456789abcdef'})
        session._account_key = 'key-b'
        RateLimitEvent = type('RateLimitEvent', (), {})
        ev = RateLimitEvent()
        ev.rate_limit_info = types.SimpleNamespace(status='allowed', unifiedWindows={
            'five_hour': {'utilization': 0.25, 'resetsAt': 4102444800},
        })
        out = [session._wire_event(e) for e in session._translate(ev) if e.get('event') == 'rate_limit']
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]['account_profile'], '0123456789abcdef')
        self.assertEqual(out[0]['account_key'], 'key-b')
        self.assertIn('windows', out[0])

    def test_codex_wire_path_carries_the_profile(self):
        session = CodexSession('session', cwd='/tmp', name=None, permission_mode='normal', claude_session_id=None,
                               on_state_change=lambda: None, emit=lambda _: None,
                               codex_config={'accountProfile': '0123456789abcdef'})
        session._account_key = 'key-b'
        msg = session._wire_event({'event': 'codex_signal', 'kind': 'account_limits', 'detail': {}})
        self.assertEqual(msg['account_profile'], '0123456789abcdef')
        self.assertEqual(msg['account_key'], 'key-b')
        other = session._wire_event({'event': 'codex_signal', 'kind': 'fs_changed'})
        self.assertNotIn('account_profile', other)


class OffLoopTest(unittest.IsolatedAsyncioTestCase):
    """An isolated profile's SDK helpers spawn an interpreter: the event loop
    every session and shell shares must never wait on one."""

    def session(self):
        return AgentSession('session', cwd='/tmp', name='work', permission_mode='normal',
                            claude_session_id='native', on_state_change=lambda: None, emit=lambda _: None,
                            session_config={'accountProfile': '0123456789abcdef'})

    async def test_cli_title_write_runs_in_a_worker_thread_once(self):
        session = self.session()
        threads = []

        def write(name):
            threads.append(threading.get_ident())
            return True

        session.write_cli_title = write
        session._queue_cli_title('work')
        session._queue_cli_title('work')  # one write in flight, not two
        await session._cli_title_task
        self.assertEqual(len(threads), 1)
        self.assertNotEqual(threads[0], threading.get_ident())
        self.assertEqual(session._cli_title_value, 'work')

    async def test_subagent_and_identity_reads_leave_the_loop(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        server = Server(socket_path=Path(temp.name) / 'agent.sock', state_path=Path(temp.name) / 'state.json')
        session = self.session()
        threads = []

        def record(result):
            def read(*_args):
                threads.append(threading.get_ident())
                return result
            return read

        session.subagents = record({'ok': True, 'agents': []})
        session.subagent_messages = record({'ok': True, 'messages': []})
        session.identity = record({'ok': True})
        server.sessions['session'] = session
        await server.dispatch('list_subagents', {'session_id': 'session'}, None)
        await server.dispatch('get_subagent_messages', {'session_id': 'session', 'agent_id': 'a'}, None)
        await server.dispatch('session_identity', {'session_id': 'session'}, None)
        self.assertEqual(len(threads), 3)
        self.assertNotIn(threading.get_ident(), threads)


if __name__ == '__main__':
    unittest.main()
