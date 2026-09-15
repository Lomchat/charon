"""Image-budget policy tests stay stdlib-only, independent of the runtime codec."""
import copy
import http.client
import json
import os
import sys
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from charon_agent.endpoint_images import EndpointImages, ImageBudgetError, encode_image, image_parts
from charon_agent.endpoint_proxy import EndpointProxy

FAL = {'baseUrl': 'https://fal.run/openrouter/router/openai', 'auth': 'none'}


def image(n=900): return 'data:image/png;base64,' + 'A' * n


def body(engine, images):
    if engine == 'codex':
        return {'input': [{'role': 'user', 'content': [{'type': 'input_image', 'image_url': url} for url in images]}],
                'tools': [{'type': 'function', 'name': 'inspect', 'parameters': {'type': 'object'}}]}
    return {'messages': [{'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'tool',
        'content': [{'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': url.split(',')[1]}} for url in images]}]}]}


class EndpointImagesTests(unittest.TestCase):
    @patch('charon_agent.endpoint_images.FAL_IMAGE_BUDGET', 2000)
    def test_oldest_images_shrink_first_without_losing_images_tools_or_originals(self):
        for engine in ('codex', 'claude'):
            with self.subTest(engine=engine):
                calls = []
                def encoder(url, edge, quality):
                    calls.append((url, edge, quality))
                    return 'data:image/jpeg;base64,' + 'B' * 100
                processor = EndpointImages(encoder)
                original = body(engine, [image(), image(), image()])
                backup = copy.deepcopy(original)
                converted = processor.prepare(original, FAL)
                before, after = list(image_parts(original)), list(image_parts(converted))
                self.assertEqual(len(after), 3)
                self.assertLessEqual(sum(len(p[2]) for p in after), 2000)
                self.assertEqual([p[2] for p in after[1:]], [p[2] for p in before[1:]])
                self.assertEqual(original, backup)
                self.assertEqual(converted.get('tools'), original.get('tools'))
                self.assertEqual(processor.prepare(original, FAL), converted)
                self.assertEqual(len(calls), 1, 'cached history must not be encoded again each tool round trip')
                if engine == 'claude': self.assertEqual(after[0][0]['media_type'], 'image/jpeg')

    @patch('charon_agent.endpoint_images.FAL_IMAGE_BUDGET', 2000)
    def test_other_endpoints_small_payloads_tool_arguments_and_remote_urls_are_untouched(self):
        def forbidden(*args): raise AssertionError('codec should not run')
        processor = EndpointImages(forbidden)
        for url in ('http://localhost:8000', 'https://fal.run.example/openrouter/router/openai', 'https://fal.run/another-model'):
            original = body('codex', [image(3000)])
            self.assertIs(processor.prepare(original, {'baseUrl': url}), original)
        for original in (body('codex', [image(100)]),
                         {'input': [{'type': 'function_call', 'arguments': json.dumps({'type': 'input_image', 'image_url': image(3000)})}]},
                         {'messages': [{'content': [{'type': 'tool_use', 'input': {'type': 'input_image', 'image_url': image(3000)}}]}]},
                         body('codex', ['https://example.invalid/large-image.png'])):
            self.assertIs(processor.prepare(original, FAL), original)

    @patch('charon_agent.endpoint_images.FAL_IMAGE_BUDGET', 1000)
    def test_progressively_reduces_size_but_never_drops_unencodable_images(self):
        calls = []
        def encoder(url, edge, quality):
            calls.append(edge)
            return 'data:image/jpeg;base64,' + 'B' * (2000 if edge is None else 100)
        original = body('codex', [image(3000)])
        self.assertLess(sum(len(p[2]) for p in image_parts(EndpointImages(encoder).prepare(original, FAL))), 1000)
        self.assertEqual(calls, [None, 1600])
        with self.assertRaisesRegex(ImageBudgetError, 'originals have been preserved'):
            EndpointImages(lambda *args: None).prepare(original, FAL)
        self.assertEqual(len(list(image_parts(original))), 1)

    def test_missing_runtime_codec_has_an_actionable_error_without_import_time_dependency(self):
        with patch.dict(sys.modules, {'PIL': None}):
            with self.assertRaisesRegex(ImageBudgetError, 'Update this VPS'):
                encode_image(image(), None, 90)

    @patch('charon_agent.endpoint_images.FAL_IMAGE_BUDGET', 100)
    @patch('charon_agent.endpoint_images.MAX_CACHE_BYTES', 50)
    def test_cache_is_bounded_and_retains_no_source_images(self):
        processor = EndpointImages(lambda *args: 'data:image/jpeg;base64,' + 'B' * 10)
        for n in range(200, 210): processor.prepare(body('codex', [image(n)]), FAL)
        self.assertLessEqual(processor.cache_bytes, 50)
        self.assertEqual(len(processor.cache), 1)


class ImageRelayTests(unittest.TestCase):
    @patch('charon_agent.endpoint_images.FAL_IMAGE_BUDGET', 2000)
    def test_real_relay_forwards_compressed_history_and_preserves_local_large_request_cap(self):
        seen = []
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                received = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                seen.append(received)
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(b'{"ok":true}')
        server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        real_opener = urllib.request.build_opener()
        class RoutedOpener:
            def open(self, request, **kwargs):
                return real_opener.open(urllib.request.Request(f'http://127.0.0.1:{server.server_port}/v1/responses',
                    data=request.data, headers=dict(request.headers)), **kwargs)
        relay = EndpointProxy(lambda: FAL, 'codex')
        relay.images.encoder = lambda *args: 'data:image/jpeg;base64,' + 'B' * 100
        try:
            original = body('codex', [image(), image(), image()])
            with patch('charon_agent.endpoint_proxy.urllib.request.build_opener', return_value=RoutedOpener()):
                client = http.client.HTTPConnection('127.0.0.1', relay.server.server_port, timeout=5)
                client.request('POST', '/v1/responses', json.dumps(original), {'Authorization': 'Bearer ' + relay.token})
                response = client.getresponse()
                self.assertEqual(response.status, 200); response.read(); client.close()
            self.assertEqual(len(seen), 1)
            self.assertEqual(len(list(image_parts(seen[0]))), 3)
            self.assertLessEqual(sum(len(p[2]) for p in image_parts(seen[0])), 2000)
            self.assertEqual(seen[0]['input'][0]['content'][-1], original['input'][0]['content'][-1])
        finally:
            relay.stop(); server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == '__main__': unittest.main()
