import asyncio
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from charon_agent.custom_endpoints import catalog, probe
from charon_agent.endpoint_catalogs import CATALOGS, endpoint_catalog


class EndpointCatalogTests(unittest.TestCase):
    def test_only_exact_registered_bases_can_discover_models(self):
        for base in ['https://fal.run/openrouter/router/openai', 'http://localhost:8000',
                     'https://openrouter.ai', 'https://openrouter.ai/api/other',
                     'http://openrouter.ai/api', 'https://openrouter.ai:8443/api',
                     'https://openrouter.ai.example/api', 'https://user@openrouter.ai/api',
                     'https://openrouter.ai/api?key=secret', 'https://openrouter.ai/api#x']:
            endpoint = {'baseUrl': base, 'model': 'custom'}
            with self.subTest(base=base), patch('charon_agent.custom_endpoints._request') as request:
                self.assertIsNone(endpoint_catalog(base))
                with self.assertRaisesRegex(ValueError, 'not available'):
                    catalog(endpoint)
                result = asyncio.run(probe(endpoint, 'codex', 'models'))
                self.assertFalse(result['ok'])
                self.assertIn('not available', result['catalogError'])
                request.assert_not_called()

    def test_registered_routes_preserve_credentials_and_parse_openrouter_context(self):
        for route in CATALOGS:
            endpoint = {'baseUrl': route['baseUrl'], 'token': 'provider-secret', 'auth': 'bearer'}
            with self.subTest(provider=route['name']), patch('charon_agent.custom_endpoints._request', return_value={
                'data': [{'id': 'model-a', 'context_length': 128000}]
            }) as request:
                result = asyncio.run(probe(endpoint, 'codex', 'models'))
                self.assertTrue(result['ok'])
                self.assertEqual(result['models'], [{'id': 'model-a', 'contextWindow': 128000}])
                sent, path = request.call_args.args
                self.assertEqual(sent['baseUrl'], route['baseUrl'])
                self.assertEqual(sent['token'], 'provider-secret')
                self.assertEqual(path, route['modelsPath'])
                self.assertEqual(request.call_count, 1)

    def test_inference_test_does_not_discover_even_for_registered_providers(self):
        for base in ['https://fal.run/openrouter/router/openai', 'http://localhost:8000', 'https://opencode.ai/zen/go']:
            endpoint = {'baseUrl': base, 'model': 'custom'}
            output = [{'type': 'function_call', 'call_id': 'call-1', 'name': 'endpoint_check', 'arguments': '{"value":"connection-test"}'}]
            with self.subTest(base=base), patch('charon_agent.custom_endpoints.catalog') as discovery, patch('charon_agent.custom_endpoints._request', side_effect=[
                [{'type': 'response.created'}, {'type': 'response.completed', 'response': {'output': output}}],
                [{'type': 'response.output_text.delta', 'delta': 'OK'}, {'type': 'response.completed'}],
            ]) as request:
                result = asyncio.run(probe(endpoint, 'codex'))
                self.assertTrue(result['ok'])
                discovery.assert_not_called()
                self.assertEqual(request.call_count, 2)
                for call in request.call_args_list:
                    self.assertEqual(call.args[1], '/v1/responses')
                    self.assertIsInstance(call.args[2], dict)


if __name__ == '__main__': unittest.main()
