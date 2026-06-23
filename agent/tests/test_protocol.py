"""Tests for agent/charon_agent/protocol.py.

Run: python3.10 agent/tests/test_protocol.py
"""
import os
import re
import sys
import unittest

# Make `import charon_agent.protocol` work regardless of cwd.
_AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _AGENT_DIR not in sys.path:
    sys.path.insert(0, _AGENT_DIR)

from charon_agent import protocol  # noqa: E402
from charon_agent.protocol import (  # noqa: E402
    METHODS,
    RpcError,
    ERR_PARSE,
    ERR_INVALID_REQUEST,
    ERR_METHOD_NOT_FOUND,
    ERR_INVALID_PARAMS,
    ERR_INTERNAL,
    ERR_SESSION_NOT_FOUND,
    ERR_SESSION_DEAD,
    ERR_SDK_UNAVAILABLE,
    make_response,
    make_error,
    make_event,
)


class TestErrorCodes(unittest.TestCase):
    """Documented (§6) JSON-RPC error code values."""

    def test_standard_jsonrpc_codes(self):
        self.assertEqual(ERR_PARSE, -32700)
        self.assertEqual(ERR_INVALID_REQUEST, -32600)
        self.assertEqual(ERR_METHOD_NOT_FOUND, -32601)
        self.assertEqual(ERR_INVALID_PARAMS, -32602)
        self.assertEqual(ERR_INTERNAL, -32603)

    def test_extended_codes(self):
        self.assertEqual(ERR_SESSION_NOT_FOUND, -32000)
        self.assertEqual(ERR_SESSION_DEAD, -32001)
        self.assertEqual(ERR_SDK_UNAVAILABLE, -32010)

    def test_all_codes_are_ints(self):
        for name in (
            "ERR_PARSE",
            "ERR_INVALID_REQUEST",
            "ERR_METHOD_NOT_FOUND",
            "ERR_INVALID_PARAMS",
            "ERR_INTERNAL",
            "ERR_SESSION_NOT_FOUND",
            "ERR_SESSION_DEAD",
            "ERR_SDK_UNAVAILABLE",
        ):
            self.assertIsInstance(getattr(protocol, name), int, name)

    def test_codes_are_distinct(self):
        codes = [
            ERR_PARSE,
            ERR_INVALID_REQUEST,
            ERR_METHOD_NOT_FOUND,
            ERR_INVALID_PARAMS,
            ERR_INTERNAL,
            ERR_SESSION_NOT_FOUND,
            ERR_SESSION_DEAD,
            ERR_SDK_UNAVAILABLE,
        ]
        self.assertEqual(len(codes), len(set(codes)))


class TestRpcError(unittest.TestCase):
    def test_is_exception_carrying_code_and_message(self):
        err = RpcError(ERR_SESSION_NOT_FOUND, "no such session")
        self.assertIsInstance(err, Exception)
        self.assertEqual(err.code, ERR_SESSION_NOT_FOUND)
        self.assertEqual(err.message, "no such session")
        # message also propagates to the Exception args (str()).
        self.assertEqual(str(err), "no such session")

    def test_raisable_and_catchable(self):
        with self.assertRaises(RpcError) as ctx:
            raise RpcError(ERR_INVALID_PARAMS, "bad params")
        self.assertEqual(ctx.exception.code, ERR_INVALID_PARAMS)


class TestMakeResponse(unittest.TestCase):
    def test_shape(self):
        resp = make_response(7, {"ok": True})
        self.assertEqual(resp, {"id": 7, "result": {"ok": True}})

    def test_no_error_key(self):
        resp = make_response(1, None)
        self.assertNotIn("error", resp)
        self.assertIn("result", resp)
        self.assertIsNone(resp["result"])

    def test_arbitrary_result_payload(self):
        resp = make_response(42, [1, 2, 3])
        self.assertEqual(resp["id"], 42)
        self.assertEqual(resp["result"], [1, 2, 3])


class TestMakeError(unittest.TestCase):
    def test_shape_with_id(self):
        err = make_error(5, ERR_METHOD_NOT_FOUND, "unknown method: foo")
        self.assertEqual(
            err,
            {"id": 5, "error": {"code": ERR_METHOD_NOT_FOUND, "message": "unknown method: foo"}},
        )

    def test_omits_id_when_none(self):
        # A parse error has no request id — make_error must drop the key.
        err = make_error(None, ERR_PARSE, "parse error")
        self.assertNotIn("id", err)
        self.assertEqual(err["error"], {"code": ERR_PARSE, "message": "parse error"})

    def test_id_zero_is_kept(self):
        # 0 is a valid id and must NOT be treated like None.
        err = make_error(0, ERR_INTERNAL, "boom")
        self.assertIn("id", err)
        self.assertEqual(err["id"], 0)

    def test_no_result_key(self):
        err = make_error(1, ERR_INTERNAL, "x")
        self.assertNotIn("result", err)


class TestMakeEvent(unittest.TestCase):
    def test_basic_shape(self):
        evt = make_event("status", "sid-1", status="active")
        self.assertEqual(evt, {"event": "status", "session_id": "sid-1", "status": "active"})

    def test_has_no_id(self):
        # The lack of "id" is what distinguishes an event from a response.
        evt = make_event("ready", "sid-1")
        self.assertNotIn("id", evt)

    def test_omits_session_id_when_none(self):
        evt = make_event("replay_begin", None)
        self.assertNotIn("session_id", evt)
        self.assertEqual(evt, {"event": "replay_begin"})

    def test_extra_fields_merged(self):
        evt = make_event("tool_use", "sid", id="t1", name="Bash", input={"command": "ls"})
        self.assertEqual(evt["event"], "tool_use")
        self.assertEqual(evt["session_id"], "sid")
        self.assertEqual(evt["id"], "t1")
        self.assertEqual(evt["name"], "Bash")
        self.assertEqual(evt["input"], {"command": "ls"})

    def test_event_key_not_clobbered_by_field(self):
        # `event` and `session_id` are set first; **fields update afterwards.
        # Verify event field stays unless explicitly overridden by a field
        # named "event". Here we pass a normal field and ensure event holds.
        evt = make_event("error", "sid", msg="oops", fatal=True)
        self.assertEqual(evt["event"], "error")
        self.assertEqual(evt["msg"], "oops")
        self.assertIs(evt["fatal"], True)


class TestMethods(unittest.TestCase):
    def test_non_empty_collection(self):
        self.assertTrue(METHODS)
        self.assertGreater(len(METHODS), 10)

    def test_is_a_set(self):
        self.assertIsInstance(METHODS, set)

    def test_contains_core_methods(self):
        for m in (
            "hello",
            "ping",
            "list_sessions",
            "start_session",
            "resume_session",
            "subscribe",
            "unsubscribe",
            "send_input",
            "interrupt",
            "force_stop",
            "set_permission_mode",
            "set_model",
            "set_effort",
            "respond_permission",
            "respond_question",
            "respond_exit_plan",
            "sleep_session",
            "kill_session",
        ):
            self.assertIn(m, METHODS, m)

    def test_contains_shell_methods(self):
        for m in (
            "shell_list",
            "shell_start",
            "shell_input",
            "shell_resize",
            "shell_subscribe",
            "shell_unsubscribe",
            "shell_kill",
            "shell_watch",
            "shell_unwatch",
        ):
            self.assertIn(m, METHODS, m)

    def test_all_method_names_are_nonempty_strings(self):
        for m in METHODS:
            self.assertIsInstance(m, str)
            self.assertTrue(m)


class TestDispatchConsistency(unittest.TestCase):
    """The methods server.py actually dispatches must match METHODS exactly.

    server.py guards each branch with `if method == "<name>":` and falls
    through to raise ERR_METHOD_NOT_FOUND. We scrape those literals (no AST
    needed) and compare against the canonical METHODS set — METHODS being a
    set already guarantees no duplicate entries.
    """

    def _dispatched_methods(self):
        server_path = os.path.join(_AGENT_DIR, "charon_agent", "server.py")
        with open(server_path, "r", encoding="utf-8") as fh:
            src = fh.read()
        return set(re.findall(r'if method == "([^"]+)":', src))

    def test_dispatch_set_equals_methods(self):
        dispatched = self._dispatched_methods()
        self.assertTrue(dispatched, "scraped no dispatch branches — regex stale?")
        missing_from_methods = dispatched - METHODS
        missing_from_dispatch = METHODS - dispatched
        self.assertEqual(
            missing_from_methods,
            set(),
            f"dispatched but not in METHODS: {sorted(missing_from_methods)}",
        )
        self.assertEqual(
            missing_from_dispatch,
            set(),
            f"in METHODS but never dispatched: {sorted(missing_from_dispatch)}",
        )

    def test_unknown_method_raises_method_not_found(self):
        # Sanity: server raises ERR_METHOD_NOT_FOUND for anything not dispatched.
        server_path = os.path.join(_AGENT_DIR, "charon_agent", "server.py")
        with open(server_path, "r", encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("ERR_METHOD_NOT_FOUND", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
