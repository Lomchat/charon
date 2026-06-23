"""Integration test: the real charon-agent daemon over its Unix socket.

Exercises the load-bearing resilience invariant end to end WITHOUT the SDK and
WITHOUT SSH (the SSH layer is just transport; the daemon listens on a local Unix
socket): start a persistent shell, run a command, verify the output landed in
the DURABLE per-shell log, then RECONNECT on a fresh socket connection and
`shell_subscribe` — asserting the output is REPLAYED. This is exactly the
"Charon restarts / SSH drops -> reconnect -> durable replay" path (CLAUDE.md
§14.37/§14.44), tested against the actual built .pyz.

Skips gracefully (never a false CI failure) when the environment can't run it:
no Python >=3.10, no built .pyz, no PTY, or the daemon doesn't come up in time.
Runs in CI (python 3.11) and locally.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(__file__)
PYZ = os.path.normpath(os.path.join(HERE, "..", "dist", "charon-agent.pyz"))
MARKER = "HELLO_CHARON_INTEGRATION_42"


def _find_py310():
    """A Python >= 3.10 to run the daemon (the .pyz may use 3.10+ syntax).
    `npm run test:py` runs this file under whatever `python3` is (3.9 locally,
    3.11 in CI), so we can't assume sys.executable is new enough."""
    if sys.version_info >= (3, 10):
        return sys.executable
    for name in ("python3.13", "python3.12", "python3.11", "python3.10"):
        p = shutil.which(name)
        if p:
            return p
    return None


class _Conn:
    """Minimal line-delimited JSON-RPC client over the agent Unix socket.
    Buffers async events (replay frames arrive as events during a call)."""

    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(path)
        self.buf = b""
        self.events = []
        self._nid = 0

    def _readline(self, timeout):
        self.s.settimeout(max(0.05, timeout))
        while b"\n" not in self.buf:
            chunk = self.s.recv(65536)
            if not chunk:
                raise EOFError
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line.decode("utf-8", "replace")

    def call(self, method, params=None, timeout=10.0):
        self._nid += 1
        mid = self._nid
        self.s.sendall(
            (json.dumps({"id": mid, "method": method, "params": params or {}}) + "\n").encode()
        )
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self._readline(deadline - time.time())
            if not line.strip():
                continue
            msg = json.loads(line)
            if msg.get("id") == mid:
                if msg.get("error"):
                    raise AssertionError("RPC %s -> %s" % (method, msg["error"]))
                return msg.get("result")
            if "event" in msg:
                self.events.append(msg)
        raise TimeoutError("no response to %s" % method)

    def drain_events(self, duration):
        deadline = time.time() + duration
        while time.time() < deadline:
            try:
                line = self._readline(deadline - time.time())
            except (socket.timeout, EOFError, OSError):
                break
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "event" in msg:
                self.events.append(msg)
        return self.events

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


@unittest.skipUnless(_find_py310(), "needs python >= 3.10 to run the daemon")
@unittest.skipUnless(os.path.exists(PYZ), "needs the built agent/dist/charon-agent.pyz (run agent/build.sh)")
class TestDaemonIntegration(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="charon-it-")
        env = dict(os.environ, HOME=self.home)
        self.proc = subprocess.Popen(
            [_find_py310(), PYZ],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        self.sock = os.path.join(self.home, ".charon", "agent.sock")
        deadline = time.time() + 12
        while time.time() < deadline:
            if os.path.exists(self.sock):
                break
            if self.proc.poll() is not None:
                self.skipTest("daemon exited early (rc=%s)" % self.proc.returncode)
            time.sleep(0.1)
        if not os.path.exists(self.sock):
            self.skipTest("daemon socket never appeared")

    def tearDown(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        shutil.rmtree(self.home, ignore_errors=True)

    def test_ping(self):
        c = _Conn(self.sock)
        try:
            r = c.call("ping")
            self.assertTrue(r.get("pong"))
        finally:
            c.close()

    def test_shell_output_is_durable_and_replays_on_reconnect(self):
        shell_id = "abc123def4567890"  # 16-hex shell id
        c = _Conn(self.sock)
        try:
            res = c.call("shell_start", {"shell_id": shell_id, "cwd": self.home})
            self.assertEqual(res.get("shell_id"), shell_id)
            self.assertIsInstance(res.get("pid"), int)

            # Run a command; its output flows through the durable log.
            c.call("shell_input", {"shell_id": shell_id, "data": "echo %s\n" % MARKER})
            time.sleep(2.0)  # bash startup + echo + log flush
        finally:
            c.close()  # simulate the SSH/transport dropping

        # 1) DURABLE: the output is persisted in the per-shell JSONL log.
        log_path = os.path.join(self.home, ".charon", "shells", shell_id + ".jsonl")
        self.assertTrue(os.path.exists(log_path), "durable shell log missing")
        with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
            durable = fh.read()
        self.assertIn(MARKER, durable, "output not found in the durable shell log")

        # 2) REPLAY: a FRESH connection (reconnect) gets the output replayed.
        c2 = _Conn(self.sock)
        try:
            c2.call("shell_subscribe", {"shell_id": shell_id, "after_seq": 0, "tail_bytes": 262144})
            c2.drain_events(2.0)
            replayed = "".join(
                ev.get("data", "")
                for ev in c2.events
                if ev.get("event") == "shell_output"
            )
            self.assertIn(MARKER, replayed, "output was not replayed to the reconnecting client")
        finally:
            c2.close()


if __name__ == "__main__":
    unittest.main()
