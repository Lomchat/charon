"""Persistent PTY shells hosted by the agent.

A shell is a bash process inside a PTY. The agent owns the master file
descriptor and streams output through the same `_emit` pipeline used by
Claude sessions: every `shell_output` event gets a durable log entry
(via `EventLog`, in a dedicated `~/.charon/shells/` subdir to keep the
namespace separate from sessions) AND a live broadcast to subscribers.
Input goes the other way: Charon calls `shell_input` with bytes; we
write them to the master FD.

Persistence semantics
---------------------
- **Survives Charon restart** ✓: the agent keeps the PTY open, the bash
  child keeps running. On reconnect Charon re-subscribes with
  `after_seq` and the event log replays exactly what it missed → the
  user sees full scrollback up to the cursor.
- **Does NOT survive agent restart** ✗: the master FD is local to the
  agent process; bash gets SIGHUP when the agent exits. This is the
  documented trade-off vs. an external tmux session. Agent restarts
  are rare (only on `.pyz` updates). On agent boot we clean up the
  orphan shell event logs (cf. `Server._restore_existing`).
"""
from __future__ import annotations

import asyncio
import errno
import fcntl
import os
import pty
import signal
import struct
import sys
import termios
import time
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
# to `active` once output settles. See `_on_readable` / `_monitor_idle`.
SHELL_BUSY_SETTLE_SECONDS = 1.5  # quiet gap before clearing the "busy" status
SHELL_BUSY_INPUT_GUARD = 1.0     # output within this window of a keystroke = echo (don't flag busy)


def _set_winsize(fd: int, cols: int, rows: int) -> None:
    """ioctl(TIOCSWINSZ) on the master FD → kernel updates the PTY size +
    sends SIGWINCH to the foreground process group. Best-effort: a closed
    FD or an EBADF after cleanup is silently ignored."""
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    except OSError:
        pass


class AgentShell:
    """A PTY-hosted bash session. Single writer (the asyncio loop).

    Owns: the master FD + the bash child PID + a `cols/rows` cache for
    later resize requests that arrive before the FD is open.
    Emits: `shell_output` (every read), `shell_exit` (on cleanup).
    Does NOT touch state.json (shells are intentionally not persisted
    across agent restarts — see module docstring).
    """

    def __init__(
        self,
        shell_id: str,
        *,
        cwd: Optional[str],
        name: Optional[str],
        emit: Callable[[dict[str, Any]], None],
    ) -> None:
        self.shell_id = shell_id
        self.cwd = cwd
        self.name = name
        self.emit = emit
        self.pid: Optional[int] = None
        self.master_fd: Optional[int] = None
        self.exited = False
        self.exit_code: Optional[int] = None
        self.created_at = time.time()
        self.cols = 120
        self.rows = 32
        self._read_registered = False
        # ── idle detection state (see module constants) ──
        self._last_output_ts = 0.0   # time.time() of the last non-empty read
        self._last_input_ts = 0.0    # time.time() of the last keystroke write
        self._active_burst = False   # True while output is "flowing"
        self._burst_start_ts = 0.0   # when the current burst started
        self._burst_bytes = 0        # bytes accumulated in the current burst
        self._busy_emitted = False   # True after we told Charon status=busy (thinking tab)
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

    async def start(self, initial_cols: Optional[int] = None, initial_rows: Optional[int] = None) -> None:
        """Fork bash inside a fresh PTY. Wires the master FD into the
        asyncio loop's reader set so output flows automatically."""
        if initial_cols and initial_cols > 0:
            self.cols = max(2, min(500, int(initial_cols)))
        if initial_rows and initial_rows > 0:
            self.rows = max(2, min(300, int(initial_rows)))
        pid, master_fd = pty.fork()
        if pid == 0:
            # ── Child ──
            # pty.fork sets up the slave as the controlling terminal; we just
            # have to chdir / set the env / exec bash. Any exception here is
            # fatal for the child only — _exit() avoids running parent atexit
            # handlers (which could deadlock the loop in shared state).
            try:
                if self.cwd and os.path.isdir(self.cwd):
                    os.chdir(self.cwd)
            except OSError:
                pass
            env = dict(os.environ)
            # xterm-256color is a universally-present, fully-featured terminfo
            # — htop/vim/nano/less all work with no extra setup. node-pty (no
            # longer in the path) used the same name; xterm.js on the browser
            # speaks it too.
            env['TERM'] = 'xterm-256color'
            try:
                os.execvpe('bash', ['bash', '-l'], env)
            except OSError as e:
                # Fall back to /bin/sh if bash isn't on PATH (minimal images).
                try:
                    os.execvpe('sh', ['sh', '-l'], env)
                except OSError as e2:
                    sys.stderr.write(f"[shell {self.shell_id}] exec failed: {e} / {e2}\n")
                    os._exit(127)
        # ── Parent ──
        self.pid = pid
        self.master_fd = master_fd
        # Seed the input clock so the login banner / first prompt (printed
        # immediately, with no keystroke yet) isn't mistaken for a program
        # "busy" burst by the input-echo guard in _on_readable.
        self._last_input_ts = time.time()
        _set_winsize(master_fd, self.cols, self.rows)
        # Non-blocking so the reader callback never wedges the loop.
        flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        loop = asyncio.get_event_loop()
        loop.add_reader(master_fd, self._on_readable)
        self._read_registered = True
        # Background idle watcher: detects active→idle transitions and emits
        # `shell_idle` (see _monitor_idle). One task per shell — shells are
        # few, so the overhead is negligible; cancelled in _cleanup.
        self._monitor_task = loop.create_task(self._monitor_idle())
        # Tell subscribers the shell is up (`shell_status` carries dims +
        # pid; useful for the Charon UI / debugging).
        self.emit({
            "event": "shell_status",
            "session_id": self.shell_id,  # routing key for _emit
            "shell_id": self.shell_id,
            "status": "active",
            "cols": self.cols,
            "rows": self.rows,
            "pid": self.pid,
        })

    def write(self, data: bytes) -> None:
        """Forward bytes to the bash stdin (via the PTY master). Silently
        no-ops on a dead shell."""
        if self.exited or self.master_fd is None:
            return
        # Record input intent regardless of write success — the idle monitor
        # uses this to avoid firing "finished" while the user is typing.
        self._last_input_ts = time.time()
        try:
            os.write(self.master_fd, data)
        except OSError:
            pass

    def resize(self, cols: int, rows: int) -> None:
        """Set the PTY window size — propagates SIGWINCH to bash and
        anything in its foreground process group (htop, vim, …)."""
        cols = max(2, min(500, int(cols)))
        rows = max(2, min(300, int(rows)))
        self.cols = cols
        self.rows = rows
        if self.master_fd is not None:
            _set_winsize(self.master_fd, cols, rows)

    def kill(self) -> None:
        """User-initiated end. SIGHUP the bash child (it'll cascade to its
        descendants thanks to the PTY) then close the master."""
        if self.pid and not self.exited:
            try:
                os.kill(self.pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
            except OSError:
                pass
        self._cleanup(None)

    # ── internals ────────────────────────────────────────────────────────

    def _on_readable(self) -> None:
        """add_reader callback. Drains as much as is available in one
        syscall (up to 64 KB) and emits a single `shell_output` event.
        Larger drains reduce per-byte overhead vs. one event per char."""
        if self.master_fd is None:
            return
        try:
            data = os.read(self.master_fd, 65536)
        except BlockingIOError:
            return
        except OSError as e:
            # EIO on a master FD = the child closed the slave (exited or
            # was killed). EBADF would be a programming bug (post-close).
            if e.errno in (errno.EIO, errno.EBADF):
                self._cleanup(None)
            return
        if not data:
            # 0 bytes on a readable FD = EOF, same as EIO above.
            self._cleanup(None)
            return
        # ── idle-detection bookkeeping ──
        # Start a new burst on the idle→active edge; accumulate otherwise.
        now = time.time()
        if not self._active_burst:
            self._active_burst = True
            self._burst_start_ts = now
            self._burst_bytes = 0
        self._burst_bytes += len(data)
        self._last_output_ts = now
        # ── busy/active status (agent >= 0.9.0) ──
        # Flip to "busy" (the UI's blue/thinking tab) when output flows that is
        # NOT just an echo of very recent typing. Emitted once per active span;
        # the monitor clears it back to "active" after SHELL_BUSY_SETTLE_SECONDS
        # of quiet. The input guard keeps normal prompt typing from flickering
        # the tab. Note this fans out to shell watchers (Charon) but NOT as
        # shell_output, so it's a cheap lifecycle signal.
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
        # utf-8 with `replace` loses fidelity on raw binary output (e.g.
        # `cat /bin/ls`) but keeps the wire JSON-safe without base64's 4/3
        # bloat. Acceptable for an interactive shell terminal where binary
        # piping to stdout is exceptional.
        text = data.decode('utf-8', errors='replace')
        self.emit({
            "event": "shell_output",
            "session_id": self.shell_id,
            "shell_id": self.shell_id,
            "data": text,
        })

    async def _monitor_idle(self) -> None:
        """Fire `shell_idle` once per burst when output goes quiet.

        Runs until the shell exits (or the task is cancelled in _cleanup).
        See the module-level constants for the gating heuristic. The event
        is broadcast-only (the server's _emit does NOT log/ring it — it's a
        transient hint, replaying stale "finished" pings on reconnect would
        be wrong).
        """
        try:
            while not self.exited:
                await asyncio.sleep(SHELL_MONITOR_INTERVAL)
                now = time.time()
                quiet = now - self._last_output_ts
                # (1) Clear the "busy"/thinking status after a SHORT quiet gap.
                # This is the responsive UI indicator (blue tab), independent
                # of the longer "finished something" notification below.
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
                # (2) "Finished something" notification on the longer idle
                # window (unchanged heuristic).
                if not self._active_burst:
                    continue
                if quiet < SHELL_IDLE_SECONDS:
                    continue  # still flowing (or too soon) — keep waiting
                # active → idle transition: evaluate the gate once, then
                # disarm (the next read re-arms a fresh burst).
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

    def _cleanup(self, exit_code: Optional[int]) -> None:
        """Idempotent teardown: remove the reader, close the FD, reap the
        zombie, emit `shell_exit`."""
        if self.exited:
            return
        self.exited = True
        if self._monitor_task is not None:
            try:
                self._monitor_task.cancel()
            except Exception:
                pass
            self._monitor_task = None
        # If we didn't get an explicit code, ask the kernel.
        if exit_code is None and self.pid:
            try:
                _, status = os.waitpid(self.pid, os.WNOHANG)
                if os.WIFEXITED(status):
                    exit_code = os.WEXITSTATUS(status)
                elif os.WIFSIGNALED(status):
                    exit_code = -os.WTERMSIG(status)
            except OSError:
                pass
        self.exit_code = exit_code
        loop = asyncio.get_event_loop()
        if self._read_registered and self.master_fd is not None:
            try:
                loop.remove_reader(self.master_fd)
            except Exception:
                pass
            self._read_registered = False
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None
        self.emit({
            "event": "shell_exit",
            "session_id": self.shell_id,
            "shell_id": self.shell_id,
            "code": exit_code,
        })
