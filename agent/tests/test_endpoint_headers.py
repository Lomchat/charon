import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from charon_agent.endpoint_headers import endpoint_headers
from charon_agent.endpoint_proxy import EndpointProxy
from charon_agent.custom_endpoints import _probe


class EndpointHeaderTests(unittest.TestCase):
    def setUp(self):
        self.endpoint = {'baseUrl': 'https://opencode.ai/zen/go', 'auth': 'bearer',
                         'token': 'private-credential', 'model': 'test'}

    def test_one_go_credential_authenticates_both_native_protocols(self):
        for path, expected in [('/v1/messages', 'x-api-key'), ('/v1/responses', 'Authorization'),
                               ('/v1/models', 'Authorization'), ('/v1/messages/count_tokens', 'x-api-key')]:
            headers = endpoint_headers(self.endpoint, path, 'stable-session')
            self.assertEqual(headers['x-opencode-session'], 'stable-session')
            self.assertTrue(headers['User-Agent'].startswith('Charon/'))
            self.assertEqual(headers[expected], ('Bearer ' if expected == 'Authorization' else '') + 'private-credential')
            self.assertNotIn('Authorization' if expected == 'x-api-key' else 'x-api-key', headers)

    def test_go_rules_do_not_change_other_hosts_paths_or_no_auth(self):
        for url in ['http://opencode.ai/zen/go', 'https://opencode.ai.example/zen/go',
                    'https://opencode.ai/another', 'https://local.example/zen/go']:
            headers = endpoint_headers({**self.endpoint, 'baseUrl': url}, '/v1/messages', 'session')
            self.assertNotIn('x-opencode-session', headers)
            self.assertEqual(headers['Authorization'], 'Bearer private-credential')
            self.assertNotIn('x-api-key', headers)
        headers = endpoint_headers({**self.endpoint, 'auth': 'none'}, '/v1/messages', 'session')
        self.assertNotIn('Authorization', headers)
        self.assertNotIn('x-api-key', headers)

    def test_session_identity_survives_proxy_recreation_and_is_isolated(self):
        for session in ['first', 'second', 'first']:
            relay = EndpointProxy(lambda: self.endpoint, 'codex', session_id=session)
            try:
                self.assertEqual(relay.session_id, session)
                self.assertNotEqual(relay.connection()['token'], self.endpoint['token'])
            finally:
                relay.stop()

    def test_probe_shares_identity_across_catalog_tool_and_result(self):
        seen = []
        def request(endpoint, path, body=None):
            seen.append(endpoint['_probe_session'])
            if body is None: return {'data': []}
            if len(body['messages']) == 1:
                return [{'type': 'message_start'}, {'type': 'content_block_start', 'index': 0,
                    'content_block': {'type': 'tool_use', 'id': 'call', 'name': 'endpoint_check', 'input': {'value': 'connection-test'}}},
                    {'type': 'message_stop'}]
            return [{'type': 'content_block_delta', 'delta': {'text': 'OK'}}, {'type': 'message_stop'}]
        with patch('charon_agent.custom_endpoints._request', side_effect=request):
            self.assertTrue(_probe(self.endpoint, 'claude', 'test')['ok'])
        self.assertEqual(len(seen), 3)
        self.assertEqual(len(set(seen)), 1)
        self.assertNotIn('_probe_session', self.endpoint)


if __name__ == '__main__': unittest.main()
