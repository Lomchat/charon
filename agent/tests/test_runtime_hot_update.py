"""Hot agent updates, end to end (§14.117): real daemon, real runtime process.

What this protects — each one a way to lose a user's work:
  1. A daemon restart in the MIDDLE of a streaming turn: the turn keeps
     running in its runtime, and the next daemon logs every event exactly
     once (none lost while it was down, none doubled by the resend).
  2. An update (new generation): the session is reported outdated, a
     `migrate_session` moves it to a new runtime without the hub ever seeing
     it stop, and the drained runtime retires.
  3. A background task blocks the move (the move would kill it).
  4. A runtime that dies (OOM, kill -9): its sessions come back in a new one.

Uses the built .pyz and the test-only "echo" provider
(fixtures/echo_provider.py); skips when the environment cannot run it.
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PYZ = os.path.normpath(os.path.join(HERE, "..", "dist", "charon-agent.pyz"))
ECHO = os.path.join(HERE, "fixtures", "echo_provider.py")
SID = "e" * 32


class _Conn:
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
        return json.loads(line)

    def call(self, method, params=None, timeout=20.0):
        self._nid += 1
        mid = self._nid
        self.s.sendall((json.dumps({"id": mid, "method": method, "params": params or {}}) + "\n").encode())
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = self._readline(deadline - time.time())
            if msg.get("id") == mid and ("result" in msg or "error" in msg):
                if msg.get("error"):
                    raise AssertionError(f"{method} -> {msg['error']}")
                return msg.get("result")
            if "event" in msg:
                self.events.append(msg)
        raise AssertionError(f"{method}: no answer")

    def wait_event(self, pred, timeout=20.0):
        for ev in self.events:
            if pred(ev):
                return ev
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                msg = self._readline(deadline - time.time())
            except socket.timeout:
                break
            if "event" in msg:
                self.events.append(msg)
                if pred(msg):
                    return msg
        raise AssertionError("event not seen")

    def close(self):
        self.s.close()


def _chunks(events):
    return [e["text"] for e in events
            if e.get("event") == "assistant_text" and e.get("text", "").startswith("[")]


@unittest.skipUnless(os.path.isfile(PYZ) and sys.version_info >= (3, 10), "needs the built pyz")
class HotUpdateTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="charon-hot-")
        self.sock = os.path.join(self.home, "agent.sock")
        self.daemon = None

    def tearDown(self):
        self._stop_daemon(sig=signal.SIGKILL)
        # Runtimes are detached on purpose: end every process started from
        # this test's private home (a unique temp path names only ours).
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    if self.home.encode() in f.read():
                        os.kill(int(pid), signal.SIGKILL)
            except OSError:
                pass
        shutil.rmtree(self.home, ignore_errors=True)

    def _start_daemon(self, generation):
        env = dict(os.environ, HOME=self.home, CHARON_AGENT_HOME=self.home,
                   CHARON_TEST_PROVIDER=ECHO, CHARON_RUNTIME_GENERATION=generation,
                   CHARON_MIGRATE_QUIET_S="0.3")
        env.pop("CLAUDE_CONFIG_DIR", None)
        log = open(os.path.join(self.home, "daemon.log"), "ab")
        self.daemon = subprocess.Popen([sys.executable, PYZ], env=env, stdout=log, stderr=log,
                                       stdin=subprocess.DEVNULL)
        log.close()
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                c = _Conn(self.sock)
                c.call("ping", timeout=5)
                return c
            except (OSError, AssertionError, EOFError):
                time.sleep(0.1)
        raise AssertionError("daemon did not come up:\n" + self._log())

    def _stop_daemon(self, sig=signal.SIGTERM):
        if self.daemon is not None and self.daemon.poll() is None:
            self.daemon.send_signal(sig)
            self.daemon.wait(15)
        self.daemon = None

    def _log(self):
        try:
            with open(os.path.join(self.home, "daemon.log")) as f:
                return f.read()[-4000:]
        except OSError:
            return ""

    def _session(self, conn):
        return next(s for s in conn.call("hello")["sessions"] if s["session_id"] == SID)

    def _wait_status(self, conn, status, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._session(conn)["status"] == status:
                return
            time.sleep(0.1)
        raise AssertionError(f"never {status}: {self._session(conn)}\n{self._log()}")

    def test_restart_update_and_crash_keep_the_session(self):
        # ── 1. a daemon restart mid-turn ────────────────────────────────────
        c = self._start_daemon("gen-a")
        c.call("start_session", {"session_id": SID, "cwd": self.home, "kind": "echo"})
        self._wait_status(c, "active")
        c.call("subscribe", {"session_id": SID, "after_seq": 0})
        c.call("send_input", {"session_id": SID, "content": "slow:30"})
        c.wait_event(lambda e: e.get("text") == "[5]")
        rt_pid = c.call("hello")["runtimes"][0]["pid"]
        before = list(c.events)
        last_seq = max(e["seq"] for e in before if isinstance(e.get("seq"), int))
        c.close()
        self._stop_daemon()                      # the turn is still streaming

        c = self._start_daemon("gen-a")
        hello = c.call("hello")
        self.assertTrue(hello["hot_update"])
        self.assertEqual([r["pid"] for r in hello["runtimes"]], [rt_pid])
        c.call("subscribe", {"session_id": SID, "after_seq": last_seq})
        c.wait_event(lambda e: e.get("event") == "stop")
        after = [e for e in c.events if isinstance(e.get("seq"), int) and e["seq"] > last_seq]
        self.assertEqual(_chunks(before) + _chunks(after), [f"[{i}]" for i in range(30)])
        seqs = [e["seq"] for e in before + after if isinstance(e.get("seq"), int)]
        self.assertEqual(len(seqs), len(set(seqs)), "an event was logged twice")
        answer = c.wait_event(lambda e: str(e.get("text", "")).startswith("pid="))
        self.assertIn(f"pid={rt_pid} ", answer["text"])
        self._wait_status(c, "active")
        c.close()
        self._stop_daemon()

        # ── 2. an update: outdated, then moved while idle ───────────────────
        c = self._start_daemon("gen-b")
        info = self._session(c)
        self.assertTrue(info["outdated"])
        self.assertEqual(info["status"], "active")
        c.call("subscribe", {"session_id": SID, "after_seq": 10**9})
        res = c.call("migrate_session", {"session_id": SID}, timeout=60)
        self.assertTrue(res.get("migrated"), res)
        statuses = [e.get("status") for e in c.events if e.get("event") == "status"]
        self.assertFalse({"sleeping", "starting"} & set(statuses), statuses)
        self.assertFalse(self._session(c)["outdated"])
        deadline = time.time() + 10
        while os.path.exists(os.path.join(self.home, "runtimes", "gen-a.sock")) and time.time() < deadline:
            time.sleep(0.1)
        self.assertFalse(os.path.exists(os.path.join(self.home, "runtimes", "gen-a.sock")),
                         "the drained runtime did not retire")
        # An answer is never overtaken by a later event (a hub took a noop
        # resume's `starting` AFTER the `active` that followed it, and kept
        # sessions "starting" forever): `thinking` comes after `ok`.
        c.events.clear()
        c.call("send_input", {"session_id": SID, "content": "hi"})
        self.assertFalse([e for e in c.events if e.get("status") == "thinking"],
                         "an event overtook the answer it followed")
        answer = c.wait_event(lambda e: e.get("text", "").endswith("echo=hi"))
        self.assertNotIn(f"pid={rt_pid} ", answer["text"])

        # ── 3. a running background task blocks the move ────────────────────
        c.call("send_input", {"session_id": SID, "content": "bg"})
        c.wait_event(lambda e: e.get("text", "").endswith("echo=bg"))
        self._wait_status(c, "active")
        c.close()
        self._stop_daemon()
        c = self._start_daemon("gen-c")
        time.sleep(0.5)
        res = c.call("migrate_session", {"session_id": SID})
        self.assertEqual((res.get("busy"), res.get("reason")), (True, "background task"), res)

        # ── 4. the runtime dies: its session comes back ─────────────────────
        b_pid = next(r["pid"] for r in c.call("hello")["runtimes"] if r["generation"] == "gen-b")
        os.kill(b_pid, signal.SIGKILL)
        deadline = time.time() + 30
        while time.time() < deadline:
            info = self._session(c)
            if info["runtime_generation"] == "gen-c" and info["status"] == "active":
                break
            time.sleep(0.2)
        self.assertEqual((info["runtime_generation"], info["status"]), ("gen-c", "active"),
                         self._log())
        c.call("subscribe", {"session_id": SID, "after_seq": 10**9})
        c.call("send_input", {"session_id": SID, "content": "back"})
        c.wait_event(lambda e: e.get("text", "").endswith("echo=back"))
        c.close()


class BootStateTest(unittest.TestCase):
    """state.json is read before runtimes are adopted: a save the adoption
    triggers must not drop the rows (asleep sessions, peer ledger) no runtime
    reported — they would be gone for good."""

    def test_rows_survive_a_save_before_restore(self):
        import asyncio
        from pathlib import Path
        sys.path.insert(0, os.path.join(HERE, ".."))
        from charon_agent.server import Server
        from charon_agent.state import load_state, save_state
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "state.json"
            row = {"kind": "claude", "session_id": "f" * 32, "cwd": d, "status": "sleeping",
                   "claude_session_id": "native-1"}
            save_state(path, [row], pending_kills=["k" * 32])
            server = Server(socket_path=Path(d) / "agent.sock", state_path=path)
            server._load_state_rows()
            asyncio.run(server._save_state_now())
            data = load_state(path)
            self.assertEqual([r["session_id"] for r in data["sessions"]], [row["session_id"]])
            self.assertEqual(data.get("pending_kills"), ["k" * 32])


if __name__ == "__main__":
    unittest.main()
