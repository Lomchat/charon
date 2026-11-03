import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from charon_agent.session import AgentSession, _subagent_content_text


class SubagentReaderTests(unittest.TestCase):
    def test_sdk_message_envelope_and_latest_window(self):
        session = object.__new__(AgentSession)
        session.claude_session_id = 'native-session'
        session.session_config = {'accountProfile': '0123456789abcdef'}
        session.cwd = '/project'
        messages = [SimpleNamespace(type='assistant', uuid=str(i), message={
            'role': 'assistant', 'content': [{'type': 'text', 'text': str(i)}]
        }) for i in range(500)]
        sdk = SimpleNamespace(get_subagent_messages=lambda: None)
        with patch.dict(sys.modules, {'claude_agent_sdk': sdk}), patch('charon_agent.session.sdk_call', return_value=messages) as call:
            result = session.subagent_messages('agent-id', 2)
        self.assertEqual([m['content'] for m in result['messages']], ['498', '499'])
        self.assertEqual(result['messages'][0]['role'], 'assistant')
        self.assertNotIn('limit', call.call_args.kwargs)

    def test_legacy_content_and_private_blocks(self):
        self.assertEqual(_subagent_content_text('plain'), 'plain')
        self.assertEqual(_subagent_content_text(None), '')
        self.assertEqual(_subagent_content_text([
            {'type': 'thinking', 'thinking': 'hidden'},
            {'type': 'tool_use', 'name': 'Read', 'input': {'secret': 'hidden'}},
            {'type': 'text', 'text': 'Visible'},
        ]), '› Read\n\nVisible')
        self.assertEqual(len(_subagent_content_text([{'type': 'text', 'text': 'x' * 10000}])), 8000)
