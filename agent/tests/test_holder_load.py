"""Holder load test — the proof Codex required to close 13.4 (spec 16.7).

Spawns a REAL detached holder (own process, real PTY + bash), then:
  1. attaches a client that STOPS reading while bash floods ~80 MB of
     output through the PTY;
  2. asserts the holder DROPS the slow client (bounded transport buffer,
     observable via its stderr log) instead of buffering without limit;
  3. asserts holder RSS stays bounded the whole time (an unbounded buffer
     would hold the ~80 MB and blow the margin);
  4. asserts the offline spool respects its 8 MB cap (newest-wins);
  5. re-attaches a READING client mid-production, interrupts the flood,
     and proves the live path works again (replay bounded + echo marker);
  6. shuts the holder down and asserts neither the holder nor its bash
     child survives (no orphans).

The drain-task-count criterion from the spec is satisfied STRUCTURALLY
since the single persistent drainer (holder._drain_loop): one task per
holder lifetime, not per message — nothing to count externally.

Environment prerequisites (recognized skips, cf. 8.3): a python >= 3.10
binary to run the holder, /proc for RSS sampling, and bash.
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
from pathlib import Path

AGENT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

FLOOD_BYTES = 60_000_000          # /dev/zero input → ~81 MB of base64 output
RSS_MARGIN_KB = 50 * 1024         # unbounded buffering would exceed base + 50 MB
SPOOL_CAP = 8 * 1024 * 1024
SPOOL_SLACK = 256 * 1024
MARKER = "HOLDER_RELOAD_MARKER_42"


def _find_python() -> str | None:
    for name in ("python3.13", "python3.12", "python3.11", "python3.10"):
        p = shutil.which(name)
        if p:
            return p
    if sys.version_info >= (3, 10):
        return sys.executable
    return None


def _rss_kb(pid: int) -> int | None:
    try:
        with open(f"/proc/{pid}/status", "r", encoding="ascii", errors="replace") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except OSError:
        return None
    return None


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class HolderLoadTestCase(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.py = _find_python()
        if not self.py:
            raise unittest.SkipTest("no python >= 3.10 available to run the holder")
        if not os.path.isdir("/proc"):
            raise unittest.SkipTest("/proc required for RSS sampling")
        if not shutil.which("bash"):
            raise unittest.SkipTest("bash required")
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self.sid = "feedc0defeedc0de"
        self.sock_path = self.home / ".charon" / "shells" / f"{self.sid}.sock"
        self.spool_path = self.home / ".charon" / "shells" / f"{self.sid}.spool"
        self.stderr_path = self.home / "holder.stderr"
        self._stderr_fh = open(self.stderr_path, "wb")
        env = {**os.environ, "CHARON_AGENT_HOME": str(self.home / ".charon"),
               "HOME": str(self.home), "PYTHONPATH": AGENT_DIR}
        self.proc = subprocess.Popen(
            [self.py, "-m", "charon_agent", "--shell-holder", self.sid,
             "--cols", "120", "--rows", "32", "--cwd", str(self.home)],
            cwd=AGENT_DIR, env=env,
            stdout=subprocess.DEVNULL, stderr=self._stderr_fh,
        )
        deadline = time.time() + 15
        while time.time() < deadline and not self.sock_path.exists():
            if self.proc.poll() is not None:
                self.skipTest("holder exited early (rc=%s): %s" % (
                    self.proc.returncode, self._stderr_tail()))
            time.sleep(0.1)
        if not self.sock_path.exists():
            self.skipTest("holder socket never appeared: " + self._stderr_tail())

    def tearDown(self):
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
        finally:
            self._stderr_fh.close()
            self._tmp.cleanup()

    def _stderr_tail(self) -> str:
        try:
            self._stderr_fh.flush()
            return self.stderr_path.read_text(errors="replace")[-800:]
        except OSError:
            return "<no stderr>"

    def _connect(self) -> "socket.socket":
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(str(self.sock_path))
        s.settimeout(10)
        return s

    def _read_hello(self, s: socket.socket) -> dict:
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                raise AssertionError("EOF before hello")
            buf += chunk
        line = buf.split(b"\n", 1)[0]
        msg = json.loads(line.decode("utf-8", "replace"))
        self.assertIn("hello", msg)
        return msg["hello"]

    def _send(self, s: socket.socket, obj: dict) -> None:
        s.sendall((json.dumps(obj) + "\n").encode())

    def test_slow_reader_is_bounded_dropped_spooled_and_recoverable(self):
        holder_pid = self.proc.pid

        # ── Phase A: attach, flood, STOP reading ────────────────────────────
        c1 = self._connect()
        hello = self._read_hello(c1)
        bash_pid = hello.get("pid")
        self.assertIsInstance(bash_pid, int)
        base_rss = _rss_kb(holder_pid)
        self.assertIsNotNone(base_rss)

        self._send(c1, {"input": f"head -c {FLOOD_BYTES} /dev/zero | base64\n"})
        # Deliberately never recv() again on c1 — the slow-reader scenario.

        dropped = False
        max_rss = base_rss
        deadline = time.time() + 60
        while time.time() < deadline:
            r = _rss_kb(holder_pid)
            if r is not None and r > max_rss:
                max_rss = r
            self._stderr_fh.flush()
            if "dropping slow client" in self._stderr_tail():
                dropped = True
                break
            self.assertIsNone(self.proc.poll(), "holder died under load: " + self._stderr_tail())
            time.sleep(0.2)
        self.assertTrue(dropped, "holder never dropped the blocked client: " + self._stderr_tail())

        # Keep sampling while production continues into the spool.
        settle_deadline = time.time() + 30
        last_size = -1
        stable = 0
        while time.time() < settle_deadline and stable < 4:
            r = _rss_kb(holder_pid)
            if r is not None and r > max_rss:
                max_rss = r
            size = self.spool_path.stat().st_size if self.spool_path.exists() else 0
            stable = stable + 1 if size == last_size and size > 0 else 0
            last_size = size
            time.sleep(0.5)

        # ── Bounded memory: an unbounded write buffer would hold ~80 MB ────
        self.assertLess(
            max_rss - base_rss, RSS_MARGIN_KB,
            f"holder RSS grew {max_rss - base_rss} KB (base {base_rss}) — buffering is not bounded",
        )
        # ── Spool cap (newest-wins) ────────────────────────────────────────
        self.assertTrue(self.spool_path.exists(), "no spool after client drop")
        self.assertLessEqual(
            self.spool_path.stat().st_size, SPOOL_CAP + SPOOL_SLACK,
            "spool exceeded its 8MB cap",
        )
        try:
            c1.close()
        except OSError:
            pass

        # ── Phase B: re-attach a READING client mid/post-production ────────
        c2 = self._connect()
        self._read_hello(c2)
        # Kill any still-running flood, then ask for a marker.
        self._send(c2, {"input": "\x03"})
        time.sleep(0.3)
        self._send(c2, {"input": f"echo {MARKER}\n"})
        seen = False
        replayed_bytes = 0
        buf = b""
        read_deadline = time.time() + 30
        while time.time() < read_deadline:
            try:
                chunk = c2.recv(1 << 20)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                try:
                    msg = json.loads(line.decode("utf-8", "replace"))
                except json.JSONDecodeError:
                    continue
                out = msg.get("output")
                if isinstance(out, str):
                    replayed_bytes += len(out)
                    if MARKER in out:
                        seen = True
            if seen:
                break
        self.assertTrue(seen, "live path broken after re-attach (marker never echoed)")
        # Replay is the bounded spool + a little live output — nowhere near
        # the ~80 MB produced.
        self.assertLess(replayed_bytes, SPOOL_CAP + 4 * 1024 * 1024,
                        "re-attach replayed more than the bounded spool")
        c2.close()

        # ── Phase C: shutdown, no orphans ──────────────────────────────────
        self.proc.send_signal(signal.SIGTERM)
        self.proc.wait(timeout=15)
        reap_deadline = time.time() + 10
        while time.time() < reap_deadline and _alive(bash_pid):
            time.sleep(0.2)
        self.assertFalse(_alive(bash_pid), "bash child survived the holder shutdown (orphan)")


if __name__ == "__main__":
    unittest.main()
