"""Persistent PTY shells — agent-side CLIENT of a detached holder process.

Since 0.10.0 the PTY + bash live in a separate, detached *holder*
process (`holder.py`, spawned as `charon-agent.pyz --shell-holder <id>`
with `start_new_session=True`). This module is the agent-side client:
it spawns/attaches to the holder over `~/.charon/shells/<id>.sock`,
relays bytes both ways, and keeps the SAME outward surface as before
(`_emit` events `shell_output`/`shell_status`/`shell_exit`/`shell_idle`,
attributes `pid`/`cols`/`rows`/`exited`/…), so `server.py` and the whole
Charon side are unchanged apart from boot-time re-attachment.

Persistence semantics (0.10.0)
------------------------------
- **Survives Charon restart** ✓ (unchanged): the agent keeps running,
  the durable event log replays what Charon missed.
- **Survives AGENT restart** ✓ (NEW): bash belongs to the holder, which
  outlives the agent. On boot the agent scans `~/.charon/shells/*.sock`
  and calls `attach()` on each. Output produced while the agent was down
  was spooled by the holder and is replayed into the durable event log
  on attach — no scrollback hole.
- Requires `KillMode=process` in the systemd unit (bootstrap.ts writes
  it; the agent-update path rewrites the unit) — otherwise systemd's
  default control-group sweep kills the holders on service restart.
- Does NOT survive a VPS reboot (nothing does without a process).

Idle / busy detection stays HERE (not in the holder): the heuristics
feed `_emit`, which only the agent can do, and keeping the holder dumb
(pure byte relay + spool) is what makes it safe to leave running across
.pyz updates. During the post-attach spool replay both heuristics are
suppressed (`_replaying_spool`) so a reattach can't fire a phantom
"finished something" notification or a stale busy tab.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional


# ── Idle / "finished something" detection (agent >= 0.8.0) ──────────────────
# Heuristic quiescence detector for interactive TUIs (codex, claude, a long
# build, npm install…). There is NO reliable "command finished" signal inside
# a REPL/TUI — OSC 133 shell-integration markers only fire on shell-command
# exit, never when "claude stopped talking" inside its own prompt. So we watch
# the raw output stream: a burst of output followed by a quiet gap = something
# probably finished.
#
# A `shell_idle` event fires on the active→idle transition, gated to filter
# noise:
#   - the burst must be "consequential": it streamed for >= BURST_MIN_SECONDS
#     (rules out instant commands like `ls`, `git status`) OR dumped
#     >= BURST_MIN_BYTES at once (a big one-shot output worth flagging);
#   - output AND input must have been quiet for >= IDLE_SECONDS (don't fire
#     while the user is mid-interaction).
# Imperfect by nature (a long tool-pause inside claude can split one answer
# into two bursts → two notifications; a >6s typing pause can false-fire).
# Constants are deliberately module-level so they're trivial to tune.
SHELL_IDLE_SECONDS = 6.0        # quiet window before we call it "idle"
SHELL_BURST_MIN_SECONDS = 3.0   # min streaming duration for a burst to count
SHELL_BURST_MIN_BYTES = 8192    # …OR min total bytes for a one-shot dump
SHELL_MONITOR_INTERVAL = 1.0    # how often the monitor task re-checks

# ── Live "busy" (thinking) status (agent >= 0.9.0) ──────────────────────────
# Distinct from the idle NOTIFICATION above: this drives the UI's blue
# "thinking" tab, mirroring Claude sessions. It must feel responsive, so it
# clears after a SHORT quiet gap (not the 6 s notification window). We flip to
# `busy` when output flows that is not just an echo of recent typing, and back
# to `active` once output settles. See `_handle_output` / `_monitor_idle`.
SHELL_BUSY_SETTLE_SECONDS = 1.5  # quiet gap before clearing the "busy" status
SHELL_BUSY_INPUT_GUARD = 1.0     # output within this window of a keystroke = echo (don't flag busy)

# How long to wait for a freshly-spawned holder's socket to accept.
HOLDER_SPAWN_TIMEOUT_S = 5.0
# Reader limit for the holder socket: one output line can carry up to 64 KB
# of PTY text, ×3 for replacement chars, ×~2 for JSON escapes. 2 MB is lavish.
HOLDER_READER_LIMIT = 2 << 20


class AgentShell:
    """Agent-side proxy for one holder-hosted bash. Single writer (the
    asyncio loop). Emits the same events as the pre-0.10.0 in-process
    implementation; see module docstring."""

    def __init__(
        self,
        shell_id: str,
        *,
        cwd: Optional[str],
        name: Optional[str],
        emit: Callable[[dict[str, Any]], None],
        shells_dir: Path,
    ) -> None:
        self.shell_id = shell_id
        self.cwd = cwd
        self.name = name
        self.emit = emit
        self.shells_dir = shells_dir
        self.sock_path = shells_dir / f"{shell_id}.sock"
        self.pid: Optional[int] = None          # bash pid (from holder hello)
        self.holder_pid: Optional[int] = None
        self.exited = False
        self.exit_code: Optional[int] = None
        self.created_at = time.time()           # overwritten by hello on attach
        self.cols = 120
        self.rows = 32
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._read_task: Optional[asyncio.Task] = None
        # ── idle/busy detection state (see module constants) ──
        self._last_output_ts = 0.0
        self._last_input_ts = 0.0
        self._active_burst = False
        self._burst_start_ts = 0.0
        self._burst_bytes = 0
        self._busy_emitted = False
        self._replaying_spool = False
        self._monitor_task: Optional[asyncio.Task] = None

    # ── public ───────────────────────────────────────────────────────────

    def to_info(self) -> dict[str, Any]:
        return {
            "shell_id": self.shell_id,
            "cwd": self.cwd,
            "name": self.name,
            "created_at": self.created_at,
            "cols": self.cols,
            "rows": self.rows,
            "exited": self.exited,
            "exit_code": self.exit_code,
            "pid": self.pid,
        }

    async def start(self, initial_cols: Optional[int] = None,
                    initial_rows: Optional[int] = None) -> None:
        """Spawn a fresh detached holder (which forks bash), then connect."""
        if initial_cols and initial_cols > 0:
            self.cols = max(2, min(500, int(initial_cols)))
        if initial_rows and initial_rows > 0:
            self.rows = max(2, min(300, int(initial_rows)))
        self._spawn_holder()
        await self._connect(timeout=HOLDER_SPAWN_TIMEOUT_S)
        self._post_connect()

    async def attach(self) -> None:
        """Connect to an ALREADY-RUNNING holder (agent boot after restart).
        Raises if the socket is stale — caller unlinks it and moves on."""
        await self._connect(timeout=2.0)
        self._post_connect()

    def write(self, data: str) -> None:
        """Forward keystrokes to bash (via the holder). No-ops when dead."""
        if self.exited:
            return
        self._last_input_ts = time.time()
        self._send({"input": data})

    def resize(self, cols: int, rows: int) -> None:
        cols = max(2, min(500, int(cols)))
        rows = max(2, min(300, int(rows)))
        self.cols = cols
        self.rows = rows
        self._send({"resize": [cols, rows]})

    def kill(self) -> None:
        """User-initiated end: the holder SIGHUPs bash, reaps it, removes
        its socket + spool and exits; we hear back via {"exit": …}."""
        if self.exited:
            return
        if self._writer is None:
            # Holder unreachable (never attached / already gone).
            self._handle_exit(None)
            return
        self._send({"kill": True})

    # ── internals ────────────────────────────────────────────────────────

    def _holder_argv(self) -> list[str]:
        """Command line for the detached holder. Runs the same .pyz with the
        same interpreter; falls back to `-m charon_agent` in dev (no pyz)."""
        pyz = os.path.abspath(sys.argv[0]) if sys.argv and sys.argv[0] else ""
        if pyz and os.path.isfile(pyz):
            base = [sys.executable, pyz]
        else:
            base = [sys.executable, "-m", "charon_agent"]
        argv = base + [
            "--shell-holder", self.shell_id,
            "--cols", str(self.cols),
            "--rows", str(self.rows),
        ]
        if self.cwd:
            argv += ["--cwd", self.cwd]
        if self.name:
            argv += ["--name", self.name]
        return argv

    def _spawn_holder(self) -> None:
        env = dict(os.environ)
        pkg_parent = str(Path(__file__).resolve().parent.parent)
        env["PYTHONPATH"] = pkg_parent + (
            os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
        )
        # Holder stdout/stderr → the shared agent log (O_APPEND, so the
        # systemd-appended agent writes interleave safely).
        log_path = self.shells_dir.parent / "agent.log"
        try:
            log_fh = open(log_path, "ab")
        except OSError:
            log_fh = subprocess.DEVNULL  # type: ignore[assignment]
        try:
            subprocess.Popen(
                self._holder_argv(),
                stdin=subprocess.DEVNULL,
                stdout=log_fh,
                stderr=log_fh,
                env=env,
                close_fds=True,
                # Own session: the holder survives the agent's death and is
                # immune to our signals. (systemd-side survival additionally
                # needs KillMode=process in the unit — cf. bootstrap.ts.)
                start_new_session=True,
            )
        finally:
            if log_fh is not subprocess.DEVNULL:
                try:
                    log_fh.close()  # type: ignore[union-attr]
                except OSError:
                    pass

    async def _connect(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        last_err: Exception | None = None
        while time.monotonic() < deadline:
            try:
                reader, writer = await asyncio.open_unix_connection(
                    str(self.sock_path), limit=HOLDER_READER_LIMIT
                )
                break
            except (ConnectionRefusedError, FileNotFoundError, OSError) as e:
                last_err = e
                await asyncio.sleep(0.05)
        else:
            raise RuntimeError(
                f"holder for shell {self.shell_id} not reachable: {last_err}"
            )
        # First line MUST be the hello.
        line = await asyncio.wait_for(reader.readline(), timeout=5.0)
        if not line:
            writer.close()
            raise RuntimeError(f"holder for shell {self.shell_id} closed before hello")
        try:
            hello = json.loads(line).get("hello") or {}
        except (json.JSONDecodeError, AttributeError):
            writer.close()
            raise RuntimeError(f"holder for shell {self.shell_id} sent garbage hello")
        self.pid = hello.get("pid")
        self.holder_pid = hello.get("holder_pid")
        if isinstance(hello.get("cwd"), str):
            self.cwd = hello["cwd"]
        if isinstance(hello.get("name"), str):
            self.name = hello["name"]
        if isinstance(hello.get("created_at"), (int, float)):
            self.created_at = float(hello["created_at"])
        if isinstance(hello.get("cols"), int):
            self.cols = hello["cols"]
        if isinstance(hello.get("rows"), int):
            self.rows = hello["rows"]
        self._reader = reader
        self._writer = writer
        # The holder streams its offline spool (if any) right after hello,
        # closed by {"spool_end": true}. Suppress busy/idle heuristics until
        # then — replayed history is not live activity.
        self._replaying_spool = True
        # Seed the input clock so the first prompt / spool tail can't trip
        # the busy input-guard.
        self._last_input_ts = time.time()

    def _post_connect(self) -> None:
        loop = asyncio.get_event_loop()
        self._read_task = loop.create_task(self._read_loop())
        self._monitor_task = loop.create_task(self._monitor_idle())
        self.emit({
            "event": "shell_status",
            "session_id": self.shell_id,  # routing key for _emit
            "shell_id": self.shell_id,
            "status": "active",
            "cols": self.cols,
            "rows": self.rows,
            "pid": self.pid,
        })

    async def _read_loop(self) -> None:
        assert self._reader is not None
        try:
            while True:
                line = await self._reader.readline()
                if not line:
                    # Holder gone (crash / kill -9). Its death closed the PTY
                    # master → bash got SIGHUP → the shell is dead either way.
                    self._handle_exit(None)
                    return
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if "output" in msg and isinstance(msg["output"], str):
                    self._handle_output(msg["output"])
                elif "spool_end" in msg:
                    self._replaying_spool = False
                elif "exit" in msg:
                    code = msg["exit"]
                    self._handle_exit(code if isinstance(code, int) else None)
                    return
        except asyncio.CancelledError:
            raise
        except Exception as e:
            sys.stderr.write(f"[shell {self.shell_id}] read loop error: {e}\n")
            self._handle_exit(None)

    def _handle_output(self, text: str) -> None:
        now = time.time()
        if not self._replaying_spool:
            # ── idle-detection bookkeeping ──
            if not self._active_burst:
                self._active_burst = True
                self._burst_start_ts = now
                self._burst_bytes = 0
            self._burst_bytes += len(text)
            self._last_output_ts = now
            # ── busy/active status (agent >= 0.9.0) ──
            # Flip to "busy" (the UI's blue/thinking tab) when output flows
            # that is NOT just an echo of very recent typing. Emitted once per
            # active span; the monitor clears it back to "active" after
            # SHELL_BUSY_SETTLE_SECONDS of quiet.
            if not self._busy_emitted and (now - self._last_input_ts) > SHELL_BUSY_INPUT_GUARD:
                self._busy_emitted = True
                self.emit({
                    "event": "shell_status",
                    "session_id": self.shell_id,
                    "shell_id": self.shell_id,
                    "status": "busy",
                    "cols": self.cols,
                    "rows": self.rows,
                    "pid": self.pid,
                })
        self.emit({
            "event": "shell_output",
            "session_id": self.shell_id,
            "shell_id": self.shell_id,
            "data": text,
        })

    async def _monitor_idle(self) -> None:
        """Fire `shell_idle` once per burst when output goes quiet, and clear
        the transient busy status. Identical heuristic to pre-0.10.0; see the
        module-level constants. Runs until the shell exits."""
        try:
            while not self.exited:
                await asyncio.sleep(SHELL_MONITOR_INTERVAL)
                if self._replaying_spool:
                    continue
                now = time.time()
                quiet = now - self._last_output_ts
                # (1) Clear the "busy"/thinking status after a SHORT quiet gap.
                if self._busy_emitted and quiet >= SHELL_BUSY_SETTLE_SECONDS:
                    self._busy_emitted = False
                    self.emit({
                        "event": "shell_status",
                        "session_id": self.shell_id,
                        "shell_id": self.shell_id,
                        "status": "active",
                        "cols": self.cols,
                        "rows": self.rows,
                        "pid": self.pid,
                    })
                # (2) "Finished something" notification on the longer window.
                if not self._active_burst:
                    continue
                if quiet < SHELL_IDLE_SECONDS:
                    continue
                self._active_burst = False
                burst_seconds = self._last_output_ts - self._burst_start_ts
                burst_bytes = self._burst_bytes
                input_idle = now - self._last_input_ts
                consequential = (
                    burst_seconds >= SHELL_BURST_MIN_SECONDS
                    or burst_bytes >= SHELL_BURST_MIN_BYTES
                )
                if consequential and input_idle >= SHELL_IDLE_SECONDS:
                    self.emit({
                        "event": "shell_idle",
                        "session_id": self.shell_id,
                        "shell_id": self.shell_id,
                        "idle_seconds": round(now - self._last_output_ts, 1),
                        "burst_seconds": round(burst_seconds, 1),
                        "burst_bytes": burst_bytes,
                    })
        except asyncio.CancelledError:
            raise
        except Exception as e:  # never let the monitor kill the loop
            sys.stderr.write(f"[shell {self.shell_id}] idle monitor error: {e}\n")

    def _send(self, obj: dict[str, Any]) -> None:
        w = self._writer
        if w is None:
            return
        try:
            w.write((json.dumps(obj, separators=(",", ":")) + "\n").encode())
            asyncio.get_event_loop().create_task(self._drain(w))
        except Exception:
            pass

    async def _drain(self, w: asyncio.StreamWriter) -> None:
        try:
            await w.drain()
        except Exception:
            pass

    def _handle_exit(self, exit_code: Optional[int]) -> None:
        """Idempotent: mark dead, stop tasks, emit shell_exit."""
        if self.exited:
            return
        self.exited = True
        self.exit_code = exit_code
        if self._monitor_task is not None:
            try:
                self._monitor_task.cancel()
            except Exception:
                pass
            self._monitor_task = None
        if self._writer is not None:
            try:
                self._writer.close()
            except Exception:
                pass
            self._writer = None
        self.emit({
            "event": "shell_exit",
            "session_id": self.shell_id,
            "shell_id": self.shell_id,
            "code": exit_code,
        })
