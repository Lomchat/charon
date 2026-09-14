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
from charon_agent.endpoint_responses import response_event, response_stream


class EndpointResponsesTests(unittest.TestCase):
    def completed(self, usage):
        return {'type': 'response.completed', 'response': {
            'id': 'test', 'status': 'completed', 'output': [{'type': 'message'}], 'usage': usage}}

    def test_gateway_billing_metadata_is_optional_not_fabricated_token_usage(self):
        event = self.completed({'prompt_tokens': None, 'completion_tokens': None,
                                'total_tokens': 60, 'cost': 0.001})
        result = response_event(event)
        self.assertIsNone(result['response']['usage'])
        self.assertEqual(result['response']['output'], event['response']['output'])
        self.assertEqual(result['response']['status'], 'completed')
        self.assertEqual(event['response']['usage']['total_tokens'], 60)

    def test_valid_or_absent_usage_and_non_response_events_are_unchanged(self):
        for usage in (None, {'input_tokens': 12, 'output_tokens': 4, 'total_tokens': 16,
                             'input_tokens_details': {'cached_tokens': 2}}):
            event = self.completed(usage)
            self.assertIs(response_event(event), event)
        for event in ({'type': 'error', 'error': {'message': 'failed'}},
                      {'type': 'response.output_text.delta', 'delta': 'hello'},
                      {'type': 'message_stop'}, None):
            self.assertIs(response_event(event), event)

    def test_invalid_usage_does_not_hide_a_failed_response(self):
        event = self.completed({'input_tokens': True, 'output_tokens': -1, 'total_tokens': '12'})
        event['type'] = 'response.failed'
        event['response'].update(status='failed', error={'message': 'upstream error'})
        result = response_event(event)
        self.assertEqual(result['response']['error'], {'message': 'upstream error'})
        self.assertEqual(result['response']['status'], 'failed')

    def test_fragmented_multiline_sse_preserves_events_and_comments(self):
        event = self.completed({'cost': 0.001})
        prefix = b': heartbeat\r\n\r\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n'
        middle = (b'event: response.completed\r\nid: 7\r\ndata: {"type":"response.completed",\r\n'
                  + b'data: "response":' + json.dumps(event['response']).encode() + b'}\r\n\r\n')
        suffix = b'data: [DONE]\n\n'
        raw = prefix + middle + suffix

        class Fragmented(io.BytesIO):
            def read1(self, size):
                return self.read(3)

        result = b''.join(response_stream(Fragmented(raw)))
        self.assertTrue(result.startswith(prefix))
        self.assertTrue(result.endswith(suffix))
        self.assertIn(b'event: response.completed\r\nid: 7\r\n', result)
        completed = next(json.loads(line[5:]) for line in result.splitlines()
                         if line.startswith(b'data: {') and b'"response":' in line)
        self.assertIsNone(completed['response']['usage'])

    def test_incomplete_frames_stay_incomplete_and_event_memory_is_bounded(self):
        incomplete = b'data: {"type":"response.completed"'
        self.assertEqual(b''.join(response_stream(io.BytesIO(incomplete))), incomplete)
        with patch('charon_agent.endpoint_responses.MAX_EVENT_BYTES', 32):
            for payload in (b'data: ' + b'x' * 40, b'data: ' + b'x' * 40 + b'\n\n'):
                with self.assertRaises(ValueError):
                    list(response_stream(io.BytesIO(payload)))

    def test_actual_relay_removes_incomplete_usage_before_codex_reads_completion(self):
        wire = b'data: ' + json.dumps(self.completed({'total_tokens': 60, 'cost': 0.001})).encode() + b'\n\n'
        received_auth = []

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *args): pass

            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                received_auth.append(self.headers.get('Authorization'))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                self.end_headers()
                self.wfile.write(wire)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        endpoint = {'baseUrl': f'http://127.0.0.1:{server.server_port}', 'auth': 'bearer',
                    'token': 'upstream-secret', 'model': 'test'}
        relay = EndpointProxy(lambda: endpoint, 'codex')
        try:
            connection = relay.connection()
            req = urllib.request.Request(connection['baseUrl'] + '/v1/responses',
                data=b'{"model":"test","stream":true}',
                headers={'Authorization': 'Bearer ' + connection['token']})
            with urllib.request.urlopen(req, timeout=3) as response:
                body = response.read()
            result = json.loads(body.removeprefix(b'data: '))
            self.assertIsNone(result['response']['usage'])
            self.assertEqual(result['response']['status'], 'completed')
            self.assertEqual(received_auth, ['Bearer upstream-secret'])
            self.assertNotIn(b'upstream-secret', body)
        finally:
            relay.stop()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == '__main__': unittest.main()
