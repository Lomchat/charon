"""Tests for charon_agent.child_ledger — a SIGKILLed daemon's ghosts (§14.113).

stdlib unittest only. Run with:
    python3.10 agent/tests/test_child_ledger.py

What matters: the next daemon stops exactly the provider CLIs its predecessor
spawned, and nothing else. A shell holder (own session), a recycled pid (other
start time), a still-running previous daemon and a reboot must all leave every
process alone. The decision logic runs against a fake /proc; one test orphans
a real process and checks it is really gone.
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import child_ledger  # noqa: E402
from charon_agent.child_ledger import (  # noqa: E402
    LEDGER_NAME, ChildLedger, children_of, orphans, proc_stat, reap_orphans,
)

BOOT = "11111111-2222-3333-4444-555555555555"


def _stat_line(pid, comm, state, ppid, sid, start):
    # Fields 1..22: pid (comm) state ppid pgrp session tty tpgid flags minflt
    # cminflt majflt cmajflt utime stime cutime cstime priority nice threads
    # itrealvalue starttime.
    rest = [state, ppid, sid, sid] + [0] * 15 + [start]
    return f"{pid} ({comm}) " + " ".join(str(x) for x in rest) + "\n"


class FakeProc:
    def __init__(self, root: Path):
        self.root = root
        (root / "sys" / "kernel" / "random").mkdir(parents=True)
        self.set_boot(BOOT)

    def set_boot(self, boot_id):
        (self.root / "sys" / "kernel" / "random" / "boot_id").write_text(boot_id + "\n")

    def add(self, pid, comm, *, ppid, sid, start, state="S", children=()):
        d = self.root / str(pid)
        (d / "task" / str(pid)).mkdir(parents=True, exist_ok=True)
        (d / "stat").write_text(_stat_line(pid, comm, state, ppid, sid, start))
        (d / "comm").write_text(comm + "\n")
        (d / "task" / str(pid) / "children").write_text(" ".join(str(c) for c in children))

    def remove(self, pid):
        import shutil
        shutil.rmtree(self.root / str(pid))


class FakeProcTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.proc = FakeProc(base / "proc")
        self.state = base / "state"
        self.state.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def write_ledger(self, daemon=(500, 9000, 500), children=(), boot=BOOT):
        self.state.joinpath(LEDGER_NAME).write_text(json.dumps({
            "boot_id": boot,
            "daemon": {"pid": daemon[0], "start": daemon[1], "sid": daemon[2]},
            "children": [{"pid": p, "start": s, "comm": c} for p, s, c in children],
        }))

    def found(self):
        return [o["pid"] for o in orphans(self.state, proc=self.proc.root)]

    def test_snapshot_records_children_sharing_the_daemon_session_only(self):
        self.proc.add(500, "python", ppid=1, sid=500, start=9000, children=(601, 602, 603))
        self.proc.add(601, "claude", ppid=500, sid=500, start=9100)
        self.proc.add(602, "python", ppid=500, sid=602, start=9200)  # holder: setsid
        self.proc.add(603, "codex", ppid=500, sid=500, start=9300, state="Z")
        snap = ChildLedger(self.state, proc=self.proc.root).snapshot(pid=500)
        self.assertEqual(snap["boot_id"], BOOT)
        self.assertEqual(snap["daemon"], {"pid": 500, "start": 9000, "sid": 500})
        self.assertEqual(snap["children"], [{"pid": 601, "start": 9100, "comm": "claude"}])

    def test_the_previous_daemons_children_are_orphans(self):
        # Daemon 500 is gone; its CLI was reparented to the user manager.
        self.proc.add(601, "claude", ppid=1422, sid=500, start=9100)
        self.proc.add(602, "codex", ppid=1422, sid=500, start=9300)
        self.write_ledger(children=[(601, 9100, "claude"), (602, 9300, "codex")])
        self.assertEqual(self.found(), [601, 602])

    def test_a_recycled_pid_is_left_alone(self):
        self.proc.add(601, "nginx", ppid=1, sid=500, start=12345)
        self.write_ledger(children=[(601, 9100, "claude")])
        self.assertEqual(self.found(), [])

    def test_a_process_now_in_its_own_session_is_left_alone(self):
        self.proc.add(602, "python", ppid=1422, sid=602, start=9200)
        self.write_ledger(children=[(602, 9200, "python")])
        self.assertEqual(self.found(), [])

    def test_a_previous_daemon_still_alive_keeps_its_children(self):
        self.proc.add(500, "python", ppid=1422, sid=500, start=9000, children=(601,))
        self.proc.add(601, "claude", ppid=500, sid=500, start=9100)
        self.write_ledger(children=[(601, 9100, "claude")])
        self.assertEqual(self.found(), [])

    def test_a_recycled_daemon_pid_does_not_protect_the_orphans(self):
        self.proc.add(500, "bash", ppid=1, sid=500, start=99999)
        self.proc.add(601, "claude", ppid=1422, sid=500, start=9100)
        self.write_ledger(children=[(601, 9100, "claude")])
        self.assertEqual(self.found(), [601])

    def test_a_reboot_voids_the_ledger(self):
        self.proc.add(601, "claude", ppid=1, sid=500, start=9100)
        self.write_ledger(children=[(601, 9100, "claude")])
        self.proc.set_boot("99999999-0000-0000-0000-000000000000")
        self.assertEqual(self.found(), [])

    def test_gone_and_zombie_children_are_skipped(self):
        self.proc.add(602, "codex", ppid=1422, sid=500, start=9300, state="Z")
        self.write_ledger(children=[(601, 9100, "claude"), (602, 9300, "codex")])
        self.assertEqual(self.found(), [])

    def test_missing_or_corrupt_ledger_is_nothing_to_do(self):
        self.assertEqual(self.found(), [])
        self.state.joinpath(LEDGER_NAME).write_text("{not json")
        self.assertEqual(self.found(), [])
        self.state.joinpath(LEDGER_NAME).write_text(json.dumps({"children": []}))
        self.assertEqual(self.found(), [])

    def test_children_fall_back_to_a_ppid_scan(self):
        # A kernel without CONFIG_PROC_CHILDREN has no task/*/children file.
        self.proc.add(500, "python", ppid=1, sid=500, start=9000)
        self.proc.add(601, "claude", ppid=500, sid=500, start=9100)
        self.proc.add(700, "other", ppid=1, sid=700, start=9400)
        (self.proc.root / "500" / "task" / "500" / "children").unlink()
        self.assertEqual(children_of(500, self.proc.root), {601})

    def test_record_writes_only_on_change(self):
        ledger = ChildLedger(self.state)  # the real /proc: this test process
        self.assertTrue(ledger.record())
        self.assertFalse(ledger.record())
        data = json.loads(self.state.joinpath(LEDGER_NAME).read_text())
        self.assertEqual(data["daemon"]["pid"], os.getpid())
        self.assertEqual(self.state.joinpath(LEDGER_NAME).stat().st_mode & 0o777, 0o600)


@unittest.skipUnless(Path("/proc/self/stat").exists(), "needs Linux /proc")
class RealOrphanTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.state = Path(self._tmp.name)
        self.pid = None

    def tearDown(self):
        if self.pid:
            try:
                os.kill(self.pid, 9)
            except OSError:
                pass
        self._tmp.cleanup()

    def _orphan(self, *, own_session=False):
        """A `sleep` whose parent already exited, like a dead daemon's CLI."""
        cmd = "sleep 60 >/dev/null 2>&1 & echo $!"
        if own_session:
            cmd = "setsid " + cmd
        out = subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, check=True)
        pid = int(out.stdout.split()[-1])
        self.pid = pid
        # `sh` has exited, but its background child may still be a forked `sh`
        # that has not yet run setsid() nor exec'd `sleep`: read it only once it
        # IS the sleep, else its session is still ours.
        for _ in range(250):
            st = proc_stat(pid)
            try:
                comm = Path(f"/proc/{pid}/comm").read_text().strip()
            except OSError:
                comm = ""
            if st is not None and comm == "sleep":
                return pid, st
            time.sleep(0.02)
        self.fail("the orphan never became a running sleep")

    def _ledger(self, pid, st):
        me = proc_stat(os.getpid())
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        # The "previous daemon" is a pid that no longer exists, in our session.
        self.state.joinpath(LEDGER_NAME).write_text(json.dumps({
            "boot_id": boot,
            "daemon": {"pid": 2 ** 22 + 1, "start": 1, "sid": me[2]},
            "children": [{"pid": pid, "start": st[3], "comm": "sleep"}],
        }))

    def _gone(self, pid, start):
        st = proc_stat(pid)
        return st is None or st[0] == "Z" or st[3] != start

    def test_the_orphan_is_stopped(self):
        pid, st = self._orphan()
        self._ledger(pid, st)
        reaped = asyncio.run(reap_orphans(self.state, grace_s=2.0))
        self.assertEqual([t["pid"] for t in reaped], [pid])
        for _ in range(100):
            if self._gone(pid, st[3]):
                break
            time.sleep(0.02)
        self.assertTrue(self._gone(pid, st[3]))

    def test_a_detached_process_survives(self):
        pid, st = self._orphan(own_session=True)
        self._ledger(pid, st)
        self.assertEqual(asyncio.run(reap_orphans(self.state, grace_s=0.2)), [])
        self.assertFalse(self._gone(pid, st[3]))

    def test_sigterm_resistant_orphans_get_sigkill(self):
        out = subprocess.run(
            ["sh", "-c", "sh -c 'trap \"\" TERM; while :; do sleep 0.05; done' >/dev/null 2>&1 & echo $!"],
            capture_output=True, text=True, check=True)
        pid = int(out.stdout.split()[-1])
        self.pid = pid
        time.sleep(0.1)
        st = proc_stat(pid)
        self._ledger(pid, st)
        started = time.monotonic()
        asyncio.run(reap_orphans(self.state, grace_s=0.3))
        for _ in range(100):
            if self._gone(pid, st[3]):
                break
            time.sleep(0.02)
        self.assertTrue(self._gone(pid, st[3]))
        self.assertLess(time.monotonic() - started, 3.0)


if __name__ == "__main__":
    unittest.main()
