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
        _set_winsize(master_fd, self.cols, self.rows)
        # Non-blocking so the reader callback never wedges the loop.
        flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        loop = asyncio.get_event_loop()
        loop.add_reader(master_fd, self._on_readable)
        self._read_registered = True
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

    def _cleanup(self, exit_code: Optional[int]) -> None:
        """Idempotent teardown: remove the reader, close the FD, reap the
        zombie, emit `shell_exit`."""
        if self.exited:
            return
        self.exited = True
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
