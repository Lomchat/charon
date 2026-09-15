import asyncio
import io
import json
import os
import sys
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from charon_agent.endpoint_proxy import EndpointProxy
from charon_agent.endpoint_responses import response_stream
from charon_agent.endpoint_usage import EndpointUsage


def frame(event):
    return b'data: ' + json.dumps(event).encode() + b'\n\n'


class EndpointUsageTests(unittest.TestCase):
    def test_fal_total_survives_normalization_without_inventing_a_breakdown(self):
        usage = EndpointUsage('codex')
        raw = frame({'type': 'response.completed', 'response': {'usage': {
            'prompt_tokens': None, 'completion_tokens': None, 'total_tokens': 58, 'cost': 0.01}}})
        normalized = b''.join(response_stream(io.BytesIO(raw), usage.event))
        self.assertIsNone(json.loads(normalized[6:])['response']['usage'])
        result = usage.result(streaming=True)
        self.assertEqual((result['input_tokens'], result['output_tokens'], result['total_tokens'], result['partial']),
                         (None, None, 58, False))

    def test_claude_snapshots_merge_without_double_counting_and_include_cache(self):
        usage = EndpointUsage('claude')
        raw = (frame({'type': 'message_start', 'message': {'usage': {'input_tokens': 10,
            'cache_read_input_tokens': 50, 'cache_creation_input_tokens': 20, 'output_tokens': 1}}})
            + b'data: {"type":"message_delta",\r\ndata: "usage":{"output_tokens":12}}\r\n\r\n'
            + frame({'type': 'message_delta', 'usage': {'output_tokens': 12}})
            + frame({'type': 'message_stop'}))
        for i in range(0, len(raw), 3): usage.feed(raw[i:i+3], streaming=True)
        result = usage.result(streaming=True)
        self.assertEqual((result['input_tokens'], result['output_tokens'], result['total_tokens']), (80, 12, 92))
        self.assertFalse(result['partial'])

    def test_responses_cached_tokens_are_already_in_input_and_json_zero_is_valid(self):
        for data in ({'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120,
                      'input_tokens_details': {'cached_tokens': 80}},
                     {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0}):
            usage = EndpointUsage('codex')
            usage.feed(json.dumps({'usage': data}).encode(), streaming=False)
            result = usage.result(streaming=False)
            self.assertEqual(result['input_tokens'], data['input_tokens'])
            self.assertEqual(result['total_tokens'], data['total_tokens'])

    def test_errors_invalid_counters_and_truncated_streams_never_become_zero_usage(self):
        usage = EndpointUsage('codex')
        usage.event({'response': {'usage': {'input_tokens': True, 'output_tokens': -2, 'total_tokens': '20'}}})
        self.assertIsNone(usage.result(streaming=True)['total_tokens'])
        self.assertTrue(usage.result(streaming=True)['partial'])
        with patch('charon_agent.endpoint_usage.MAX_EVENT_BYTES', 32):
            usage.feed(b'x' * 40, streaming=True)
            self.assertLessEqual(len(usage.pending), 32)
        self.assertIsNone(usage.result(streaming=True)['input_tokens'])


class EndpointUsageRelayTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_http_relays_record_each_request_once_on_the_event_loop(self):
        for engine in ('codex', 'claude'):
            with self.subTest(engine=engine):
                wire = (frame({'type': 'response.completed', 'response': {'usage': {'total_tokens': 58}}})
                    if engine == 'codex' else frame({'type': 'message_start', 'message': {'usage': {'input_tokens': 30}}})
                    + frame({'type': 'message_delta', 'usage': {'output_tokens': 4}}) + frame({'type': 'message_stop'}))
                class Upstream(BaseHTTPRequestHandler):
                    def log_message(self, *args): pass
                    def do_POST(self):
                        self.rfile.read(int(self.headers['Content-Length']))
                        self.send_response(200)
                        self.send_header('Content-Type', 'text/event-stream')
                        self.end_headers()
                        self.wfile.write(wire)
                server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                calls = []
                loop_thread = threading.get_ident()
                def record(usage):
                    self.assertEqual(threading.get_ident(), loop_thread)
                    calls.append(usage)
                relay = EndpointProxy(lambda: {'baseUrl': f'http://127.0.0.1:{server.server_port}',
                    'auth': 'none', 'model': 'test'}, engine, record)
                def request():
                    path = '/v1/responses' if engine == 'codex' else '/v1/messages'
                    req = urllib.request.Request(relay.connection()['baseUrl'] + path, data=b'{"stream":true}',
                        headers={'Authorization': 'Bearer ' + relay.token})
                    with urllib.request.urlopen(req, timeout=5) as response: return response.read()
                try:
                    for _ in range(2):
                        body = await asyncio.to_thread(request)
                        self.assertTrue(body)
                    await asyncio.sleep(0)
                    self.assertEqual(len(calls), 2)
                    self.assertNotEqual(calls[0]['request_id'], calls[1]['request_id'])
                    self.assertEqual(calls[0]['total_tokens'], 58 if engine == 'codex' else 34)
                    self.assertFalse(calls[0]['partial'])
                finally:
                    await asyncio.to_thread(relay.stop)
                    await asyncio.to_thread(server.shutdown)
                    server.server_close()
                    thread.join(timeout=2)


if __name__ == '__main__': unittest.main()
