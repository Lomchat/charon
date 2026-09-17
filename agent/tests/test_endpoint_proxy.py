"""Large multimodal histories must cross the real HTTP relay intact."""
import hashlib
import http.client
import json
import os
import sys
import threading
import unittest
import urllib.request
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from charon_agent.endpoint_proxy import EndpointProxy, MAX_REQUEST_BYTES


class EndpointProxyBodyTests(unittest.TestCase):
    def setUp(self):
        self.received = []
        self.relays = []
        received = self.received

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *args): pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if self.path == '/v1/responses':
                    image = body['input'][0]['content'][0]['image_url'].split(',', 1)[1]
                else:
                    image = body['messages'][0]['content'][0]['source']['data']
                received.append({
                    'path': self.path, 'model': body['model'],
                    'auth': self.headers.get('Authorization'),
                    'bytes': len(image), 'sha256': hashlib.sha256(image.encode()).hexdigest(),
                })
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        for relay in self.relays:
            relay.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def relay(self, engine):
        endpoint = {'baseUrl': f'http://127.0.0.1:{self.server.server_port}',
                    'auth': 'bearer', 'token': 'upstream-secret', 'model': 'image-test'}
        relay = EndpointProxy(lambda: endpoint, engine)
        self.relays.append(relay)
        return relay

    def test_history_over_the_old_16_mib_limit_reaches_both_provider_apis_intact(self):
        image = 'ABCD' * (5 * 1024 * 1024)  # 20 MiB of base64 image data.
        expected_sha = hashlib.sha256(image.encode()).hexdigest()
        for engine, path in (('codex', '/v1/responses'), ('claude', '/v1/messages')):
            with self.subTest(engine=engine):
                if engine == 'codex':
                    body = {'model': 'image-test', 'input': [{'role': 'user', 'content': [
                        {'type': 'input_image', 'image_url': 'data:image/png;base64,' + image}]}]}
                else:
                    body = {'model': 'image-test', 'max_tokens': 10, 'messages': [{'role': 'user', 'content': [
                        {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': image}}]}]}
                connection = self.relay(engine).connection()
                request = urllib.request.Request(connection['baseUrl'] + path,
                    data=json.dumps(body).encode(),
                    headers={'Authorization': 'Bearer ' + connection['token'], 'Content-Type': 'application/json'})
                with urllib.request.urlopen(request, timeout=10) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read()), {'ok': True})
                self.assertEqual(self.received[-1], {
                    'path': path, 'model': 'image-test', 'auth': 'Bearer upstream-secret',
                    'bytes': len(image), 'sha256': expected_sha,
                })

    def test_oversized_headers_are_rejected_before_reading_or_forwarding_the_body(self):
        relay = self.relay('codex')
        connection = http.client.HTTPConnection('127.0.0.1', relay.server.server_port, timeout=3)
        try:
            connection.putrequest('POST', '/v1/responses')
            connection.putheader('Authorization', 'Bearer ' + relay.connection()['token'])
            connection.putheader('Content-Length', str(MAX_REQUEST_BYTES + 1))
            connection.endheaders()  # No body: rejection must be immediate.
            response = connection.getresponse()
            self.assertEqual(response.status, 413)
            self.assertIn(b'256 MiB', response.read())
            self.assertEqual(self.received, [])
        finally:
            connection.close()

    def test_sdk_model_listing_for_unknown_providers_is_local_only(self):
        for base in ('https://fal.run/openrouter/router/openai', 'http://localhost:8000'):
            endpoint = {'baseUrl': base, 'auth': 'bearer', 'token': 'never-forward-this', 'model': 'configured-model'}
            relay = EndpointProxy(lambda: endpoint, 'codex')
            self.relays.append(relay)
            conn = http.client.HTTPConnection('127.0.0.1', relay.server.server_port, timeout=3)
            try:
                with patch('charon_agent.endpoint_proxy.urllib.request.build_opener') as upstream:
                    conn.request('GET', '/v1/models?client_version=test', headers={'Authorization': 'Bearer ' + relay.token})
                    response = conn.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read()), {'object': 'list', 'data': [
                        {'id': 'configured-model', 'object': 'model', 'owned_by': 'custom'}]})
                    upstream.assert_not_called()
            finally:
                conn.close()


if __name__ == '__main__': unittest.main()
