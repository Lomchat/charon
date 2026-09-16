import asyncio
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from charon_agent.endpoint_credentials import _crypt, public_config
from charon_agent.endpoint_proxy import request_body
from charon_agent.endpoint_runtime import claude_env, codex_overrides, redact
from charon_agent.state import save_state, load_state
from charon_agent.custom_endpoints import probe


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.endpoint = {'baseUrl': 'http://localhost:8000', 'model': 'custom', 'name': 'Local', 'auth': 'bearer', 'token': 'secret-for-test'}

    def test_agent_state_encrypts_and_restores_credentials_without_changing_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            rows = [{'session_id': 'one', 'provider_config': {'customEndpoint': self.endpoint}}, {'session_id': 'normal'}]
            save_state(path, rows)
            self.assertNotIn('secret-for-test', path.read_text())
            self.assertEqual(load_state(path)['sessions'], rows)
            self.assertEqual((path.parent / '.endpoint-key').stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.endpoint['token'], 'secret-for-test')
            self.assertNotIn('token', public_config(rows[0]['provider_config'])['customEndpoint'])

    def test_aes_gcm_rejects_modified_ciphertext(self):
        key, iv = os.urandom(32), os.urandom(12)
        ct, tag = _crypt(b'secret', key, iv)
        with self.assertRaises(ValueError):
            _crypt(bytes([ct[0] ^ 1]) + ct[1:], key, iv, tag)

    def test_runtime_overrides_never_mutate_the_shared_environment(self):
        before = dict(os.environ)
        first = claude_env(self.endpoint, 'custom', None)
        second = claude_env({**self.endpoint, 'token': 'different'}, 'second', 'low')
        self.assertEqual(first['ANTHROPIC_AUTH_TOKEN'], 'secret-for-test')
        self.assertEqual(second['ANTHROPIC_AUTH_TOKEN'], 'different')
        self.assertEqual(first['ANTHROPIC_DEFAULT_HAIKU_MODEL'], 'custom')
        self.assertEqual(first['CLAUDE_CODE_OAUTH_TOKEN'], '')
        overrides, env = codex_overrides(self.endpoint, 'custom', None)
        self.assertNotIn('secret-for-test', '\n'.join(overrides))
        self.assertEqual(env['CHARON_ENDPOINT_TOKEN'], 'secret-for-test')
        self.assertEqual(dict(os.environ), before)

    def test_no_auth_does_not_reuse_subscription_credentials(self):
        env = claude_env({**self.endpoint, 'auth': 'none', 'token': ''}, 'custom', None)
        self.assertEqual(env['ANTHROPIC_AUTH_TOKEN'], '')
        self.assertTrue(env['ANTHROPIC_API_KEY'])
        overrides, env = codex_overrides({**self.endpoint, 'auth': 'none', 'token': ''}, 'custom', None)
        self.assertNotIn('env_key', '\n'.join(overrides))

    def test_probe_rejects_a_plain_text_response_without_tool_calls(self):
        with patch('charon_agent.custom_endpoints.catalog', return_value=[]), patch('charon_agent.custom_endpoints._request', return_value=[{'type': 'message_start'}, {'type': 'message_stop'}]):
            result = asyncio.run(probe(self.endpoint, 'claude'))
            self.assertFalse(result['ok'])
            self.assertIn('tool call', result['check']['error'])

    def test_claude_probe_uses_auto_tools_and_replays_thinking_and_signature(self):
        events = [
            {'type': 'message_start'},
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'thinking', 'thinking': '', 'signature': ''}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'thinking_delta', 'thinking': 'Use the tool.'}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'signature_delta', 'signature': 'signed-thinking'}},
            {'type': 'content_block_start', 'index': 1, 'content_block': {'type': 'text', 'text': ''}},
            {'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'text_delta', 'text': 'Checking.'}},
            {'type': 'content_block_start', 'index': 2, 'content_block': {'type': 'tool_use', 'id': 'call-1', 'name': 'endpoint_check', 'input': {}}},
            {'type': 'content_block_delta', 'index': 2, 'delta': {'type': 'input_json_delta', 'partial_json': '{"value":'}},
            {'type': 'content_block_delta', 'index': 2, 'delta': {'type': 'input_json_delta', 'partial_json': '"connection-test"}'}},
            {'type': 'message_stop'},
        ]
        def request(endpoint, path, body):
            self.assertEqual(body['tool_choice'], {'type': 'auto'})
            if len(body['messages']) == 1:
                return events
            content = body['messages'][1]['content']
            self.assertEqual(content[0], {'type': 'thinking', 'thinking': 'Use the tool.', 'signature': 'signed-thinking'})
            self.assertEqual(content[1], {'type': 'text', 'text': 'Checking.'})
            self.assertEqual(content[2]['input'], {'value': 'connection-test'})
            self.assertEqual(body['messages'][2]['content'][0]['tool_use_id'], 'call-1')
            return [{'type': 'content_block_delta', 'delta': {'text': 'OK'}}, {'type': 'message_stop'}]
        with patch('charon_agent.custom_endpoints.catalog', return_value=[]), patch('charon_agent.custom_endpoints._request', side_effect=request):
            self.assertTrue(asyncio.run(probe(self.endpoint, 'claude'))['ok'])
        self.assertEqual(events[1]['content_block']['thinking'], '')

    def test_responses_probe_replays_reasoning_and_rejects_incomplete_tool_result(self):
        output = [{'type': 'reasoning', 'id': 'reason-1', 'summary': [], 'encrypted_content': 'opaque-reasoning'},
                  {'type': 'function_call', 'call_id': 'call-1', 'name': 'endpoint_check', 'arguments': '{"value":"connection-test"}'}]
        for complete in (True, False):
            with self.subTest(complete=complete):
                def request(endpoint, path, body):
                    self.assertEqual(body['tool_choice'], 'auto')
                    if len(body['input']) == 1:
                        return [{'type': 'response.created'}, {'type': 'response.completed', 'response': {'output': output}}]
                    self.assertEqual(body['input'][1:3], output)
                    self.assertEqual(body['input'][3]['call_id'], 'call-1')
                    return [{'type': 'response.output_text.delta', 'delta': 'OK'}] + ([{'type': 'response.completed'}] if complete else [])
                with patch('charon_agent.custom_endpoints.catalog', return_value=[]), patch('charon_agent.custom_endpoints._request', side_effect=request):
                    result = asyncio.run(probe(self.endpoint, 'codex'))
                    self.assertEqual(result['ok'], complete)

    def test_probe_reports_bounded_provider_error_without_credential(self):
        error = {'error': {'message': 'Thinking mode rejects tool_choice secret-for-test ' + 'x' * 1000}}
        with patch('charon_agent.custom_endpoints.catalog', return_value=[]), patch('charon_agent.custom_endpoints._request',
                side_effect=urllib.error.HTTPError('https://example.test', 400, 'Bad request', {}, io.BytesIO(json.dumps(error).encode()))):
            message = asyncio.run(probe(self.endpoint, 'codex'))['check']['error']
        self.assertIn('Thinking mode rejects tool_choice', message)
        self.assertNotIn('secret-for-test', message)
        self.assertIn('[redacted]', message)
        self.assertLess(len(message), 600)

    def test_unverified_reasoning_is_omitted_even_when_the_cli_supplies_defaults(self):
        original = {'model': 'custom', 'reasoning': {'effort': 'high'}, 'service_tier': 'priority'}
        self.assertEqual(request_body(original, self.endpoint, 'codex'), {'model': 'custom'})
        self.assertIn('reasoning', original)
        self.assertEqual(request_body({'model': 'custom', 'output_config': {'effort': 'high'}}, self.endpoint, 'claude'), {'model': 'custom'})
        known = {**self.endpoint, 'checks': {'codex': {'ok': True, 'model': 'custom', 'effortLevels': ['high']}}}
        self.assertNotIn('reasoning', request_body(original, known, 'codex'))
        self.assertEqual(request_body(original, known, 'codex', 'high')['reasoning'], {'effort': 'high'})
        self.assertNotIn('reasoning', request_body({**original, 'model': 'different'}, known, 'codex'))

    def test_missing_agent_key_preserves_unrelated_sessions_and_refuses_custom_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            save_state(path, [{'session_id': 'custom', 'provider_config': {'customEndpoint': self.endpoint}}, {'session_id': 'normal'}])
            (path.parent / '.endpoint-key').unlink()
            restored = load_state(path)['sessions']
            self.assertEqual(restored[1], {'session_id': 'normal'})
            self.assertEqual(restored[0]['status'], 'error')
            endpoint = restored[0]['provider_config']['customEndpoint']
            with self.assertRaises(ValueError): claude_env(endpoint, 'custom', None)

    def test_new_codex_thread_is_not_a_resume_handle_until_a_turn_is_submitted(self):
        from charon_agent.codex_session import CodexSession
        events = []
        def session(native=None):
            return CodexSession('test', cwd='/tmp', name='test', permission_mode='accept-all',
                claude_session_id=native, emit=events.append, on_state_change=lambda: None)
        fresh = session()
        fresh.claude_session_id = 'in-memory-thread'
        self.assertIsNone(fresh.to_info()['claude_session_id'])
        self.assertIsNone(fresh.to_persist()['claude_session_id'])
        fresh._record_materialized_thread()
        self.assertEqual(fresh.to_persist()['claude_session_id'], 'in-memory-thread')
        self.assertEqual(events[-1]['claude_session_id'], 'in-memory-thread')
        self.assertEqual(session('imported').to_persist()['claude_session_id'], 'imported')

    def test_errors_and_nested_events_redact_the_token(self):
        self.assertEqual(redact({'text': ['a secret-for-test b']}, self.endpoint), {'text': ['a [redacted] b']})


if __name__ == '__main__': unittest.main()
