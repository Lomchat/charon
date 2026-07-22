"""Shell holder: a tiny detached process that OWNS the PTY + bash, so a
persistent shell survives charon-agent restarts (and .pyz updates).

Why this exists
---------------
Before 0.10.0 the agent process owned the PTY master FD directly
(`pty.fork()` inside `AgentShell`). That made shells die with the agent:
on agent exit the kernel closes the master FD, bash gets SIGHUP, and the
whole point of a "persistent" shell evaporates on every `.pyz` update —
worst of all on a self-hosted VPS where working ON charon restarts the
agent that hosts your own shell.

The fix is structural: the PTY must belong to a process whose lifetime
is NOT the agent's. This module is that process. The agent spawns it
detached (`start_new_session=True` → it survives the agent;
`KillMode=process` in the systemd unit → systemd doesn't sweep it on
`systemctl --user restart charon-agent`), then talks to it over a tiny
per-shell Unix socket. On boot, the agent scans `~/.charon/shells/*.sock`
and re-attaches to every live holder.

Topology
--------
    charon-agent (restartable)          holder (lives as long as bash)
    ┌──────────────────────┐  line-JSON  ┌──────────────────────────┐
    │ AgentShell (client)  │ ◄─────────► │ ~/.charon/shells/<id>.sock│
    │  _emit → event log   │             │  PTY master ── bash -l    │
    └──────────────────────┘             │  <id>.spool (agent down)  │
                                         └──────────────────────────┘

Wire protocol (one JSON object per line, both ways)
---------------------------------------------------
holder → agent:
    {"hello": {shell_id, pid, holder_pid, cwd, name, created_at,
               cols, rows, proto}}          on connect
    {"output": "<utf-8 text>"}              PTY bytes (errors='replace')
    {"spool_end": true}                     after the offline-spool replay
    {"exit": <code|null>}                   bash died; holder exits after
agent → holder:
    {"input": "<text>"}                     keystrokes
    {"resize": [cols, rows]}                TIOCSWINSZ
    {"kill": true}                          SIGHUP bash, clean up, exit

Spool
-----
While no agent is connected (agent restarting / down), PTY output is
appended to `~/.charon/shells/<id>.spool`. On the next agent attach the
holder pauses the PTY reader, streams the whole spool as ordinary
`output` lines (the agent ingests them into the durable event log →
zero scrollback hole), sends `spool_end`, deletes the spool, then
resumes live relaying. The spool is capped at SPOOL_MAX_BYTES: beyond
that it is truncated (newest output wins) with a visible marker.

Robustness notes
----------------
- The holder imports EVERYTHING it needs at startup. This matters: it
  runs from the zipapp `.pyz`, and a later redeploy REPLACES that file —
  a lazy import after the swap would load mismatched code. No lazy
  imports in this module.
- Exactly one agent connection at a time; a new connection replaces the
  old one (agent crash + fast restart race).
- SIGTERM/SIGINT (system shutdown): SIGHUP bash, reap, clean up, exit.
- The bash child is properly reaped (waitpid retry, then SIGKILL) so the
  exit code is accurate and no zombie outlives the holder.
"""
from __future__ import annotations

import asyncio
import errno
import fcntl
import json
import os
import pty
import signal
import struct
import sys
import termios
import time
from pathlib import Path
from typing import Any, Optional

PROTO_VERSION = 1
READ_CHUNK = 65536          # one os.read per readable callback
SPOOL_MAX_BYTES = 8 * 1024 * 1024
SPOOL_SEND_CHUNK = 32768    # spool replay chunk (keeps lines < any reader limit)
SOCK_READER_LIMIT = 1 << 20  # control lines are tiny, but be generous
REAP_TIMEOUT_S = 5.0


def _set_winsize(fd: int, cols: int, rows: int) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    except OSError:
        pass


def _log(shell_id: str, msg: str) -> None:
    print(f"[holder {shell_id}] {msg}", file=sys.stderr, flush=True)


class Holder:
    def __init__(
        self,
        shell_id: str,
        *,
        cwd: Optional[str],
        name: Optional[str],
        cols: int,
        rows: int,
        shells_dir: Path,
    ) -> None:
        self.shell_id = shell_id
        self.cwd = cwd
        self.name = name
        self.cols = max(2, min(500, int(cols or 120)))
        self.rows = max(2, min(300, int(rows or 32)))
        self.shells_dir = shells_dir
        self.sock_path = shells_dir / f"{shell_id}.sock"
        self.spool_path = shells_dir / f"{shell_id}.spool"
        self.created_at = time.time()
        self.child_pid: Optional[int] = None
        self.master_fd: Optional[int] = None
        self.exit_code: Optional[int] = None
        self._reader_registered = False
        self._client_writer: Optional[asyncio.StreamWriter] = None
        self._spool_fh = None  # lazily opened append handle
        self._done = asyncio.Event()
        self._cleaning = False
        # Single persistent drainer (Codex 16.7): one task for the whole
        # holder lifetime, woken on demand — the old create_task(drain) per
        # message piled up one pending task PER MESSAGE while a slow agent
        # kept the transport buffer above asyncio's high-water mark.
        self._drain_waker = asyncio.Event()

    # ── PTY ───────────────────────────────────────────────────────────────
    def _fork_bash(self) -> None:
        pid, master_fd = pty.fork()
        if pid == 0:
            # ── Child ── (same setup as the pre-0.10.0 in-agent fork)
            try:
                if self.cwd and os.path.isdir(self.cwd):
                    os.chdir(self.cwd)
            except OSError:
                pass
            env = dict(os.environ)
            env['TERM'] = 'xterm-256color'
            try:
                os.execvpe('bash', ['bash', '-l'], env)
            except OSError as e:
                try:
                    os.execvpe('sh', ['sh', '-l'], env)
                except OSError as e2:
                    sys.stderr.write(f"[holder {self.shell_id}] exec failed: {e} / {e2}\n")
                    os._exit(127)
        self.child_pid = pid
        self.master_fd = master_fd
        _set_winsize(master_fd, self.cols, self.rows)
        flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        loop = asyncio.get_event_loop()
        loop.add_reader(master_fd, self._on_readable)
        self._reader_registered = True

    def _pause_pty_reader(self) -> None:
        if self._reader_registered and self.master_fd is not None:
            try:
                asyncio.get_event_loop().remove_reader(self.master_fd)
            except Exception:
                pass
            self._reader_registered = False

    def _resume_pty_reader(self) -> None:
        if not self._reader_registered and self.master_fd is not None and not self._cleaning:
            asyncio.get_event_loop().add_reader(self.master_fd, self._on_readable)
            self._reader_registered = True

    def _on_readable(self) -> None:
        if self.master_fd is None:
            return
        try:
            data = os.read(self.master_fd, READ_CHUNK)
        except BlockingIOError:
            return
        except OSError as e:
            if e.errno in (errno.EIO, errno.EBADF):
                asyncio.get_event_loop().create_task(self._shutdown())
            return
        if not data:
            asyncio.get_event_loop().create_task(self._shutdown())
            return
        text = data.decode('utf-8', errors='replace')
        if self._client_writer is not None:
            self._send({"output": text})
        else:
            self._spool(text)

    # ── Spool (agent offline) ─────────────────────────────────────────────
    def _spool(self, text: str) -> None:
        try:
            if self._spool_fh is None:
                self._spool_fh = self.spool_path.open("a", encoding="utf-8")
            if self._spool_fh.tell() > SPOOL_MAX_BYTES:
                # Newest output wins: truncate and mark. The agent-side
                # durable log already holds everything spooled BEFORE the
                # last attach, so only the over-cap middle is lost.
                self._spool_fh.close()
                self._spool_fh = self.spool_path.open("w", encoding="utf-8")
                self._spool_fh.write("\r\n\x1b[2m[charon] (offline output exceeded "
                                     "the spool cap — older lines dropped)\x1b[0m\r\n")
            self._spool_fh.write(text)
            self._spool_fh.flush()
        except OSError as e:
            _log(self.shell_id, f"spool write failed: {e}")

    def _close_spool(self) -> None:
        if self._spool_fh is not None:
            try:
                self._spool_fh.close()
            except OSError:
                pass
            self._spool_fh = None

    async def _replay_spool(self, writer: asyncio.StreamWriter) -> None:
        """Stream the offline spool to a freshly-attached agent, then delete
        it. The PTY reader is PAUSED by the caller, so the spool cannot grow
        under us and ordering (spool strictly before live) is guaranteed."""
        self._close_spool()
        try:
            content = self.spool_path.read_text(encoding="utf-8", errors="replace") \
                if self.spool_path.exists() else ""
        except OSError:
            content = ""
        for i in range(0, len(content), SPOOL_SEND_CHUNK):
            writer.write((json.dumps({"output": content[i:i + SPOOL_SEND_CHUNK]},
                                     separators=(",", ":")) + "\n").encode())
            await writer.drain()
        writer.write(b'{"spool_end":true}\n')
        await writer.drain()
        try:
            self.spool_path.unlink(missing_ok=True)
        except OSError:
            pass

    # ── Agent connection ──────────────────────────────────────────────────
    async def _handle_client(self, reader: asyncio.StreamReader,
                             writer: asyncio.StreamWriter) -> None:
        # One agent at a time: a new connection replaces the old.
        if self._client_writer is not None:
            try:
                self._client_writer.close()
            except Exception:
                pass
            self._client_writer = None
        try:
            hello = {
                "hello": {
                    "shell_id": self.shell_id,
                    "pid": self.child_pid,
                    "holder_pid": os.getpid(),
                    "cwd": self.cwd,
                    "name": self.name,
                    "created_at": self.created_at,
                    "cols": self.cols,
                    "rows": self.rows,
                    "proto": PROTO_VERSION,
                }
            }
            writer.write((json.dumps(hello, separators=(",", ":")) + "\n").encode())
            await writer.drain()
            # Spool replay happens with the PTY reader paused so the agent
            # sees offline output strictly before live output.
            self._pause_pty_reader()
            try:
                await self._replay_spool(writer)
            finally:
                self._client_writer = writer
                self._resume_pty_reader()
            _log(self.shell_id, "agent attached")
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if "input" in msg and isinstance(msg["input"], str) \
                        and self.master_fd is not None:
                    try:
                        os.write(self.master_fd, msg["input"].encode("utf-8"))
                    except OSError:
                        pass
                elif "resize" in msg:
                    dims = msg["resize"]
                    if isinstance(dims, list) and len(dims) == 2:
                        try:
                            self.cols = max(2, min(500, int(dims[0])))
                            self.rows = max(2, min(300, int(dims[1])))
                        except (TypeError, ValueError):
                            continue
                        if self.master_fd is not None:
                            _set_winsize(self.master_fd, self.cols, self.rows)
                elif msg.get("kill"):
                    _log(self.shell_id, "kill requested by agent")
                    await self._shutdown(force_after=REAP_TIMEOUT_S)
                    return
        except (ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            _log(self.shell_id, f"client loop error: {type(e).__name__}: {e}")
        finally:
            if self._client_writer is writer:
                self._client_writer = None
                _log(self.shell_id, "agent detached — spooling")
            try:
                writer.close()
            except Exception:
                pass

    # Bounded write-buffer for the attached agent client (P0.5 — Codex 13.4:
    # the old fire-and-forget drain assumed "interactive throughput", but a
    # `yes`, a build or a tail -f easily exceeds that; with a slow/wedged
    # agent the holder accumulated buffers+tasks without limit). Policy on
    # overflow: DROP THE CLIENT — detaching flips the holder back to the
    # bounded 8MB spool (newest-wins), which is exactly the designed offline
    # path; the agent re-attaches and replays the spool. Nothing unbounded.
    _WRITE_BUF_MAX = 4 * 1024 * 1024

    def _send(self, obj: dict[str, Any]) -> None:
        w = self._client_writer
        if w is None:
            return
        try:
            buffered = w.transport.get_write_buffer_size()
        except Exception:
            buffered = 0
        if buffered > self._WRITE_BUF_MAX:
            print(
                f"[holder] write buffer over {self._WRITE_BUF_MAX}B "
                f"({buffered}B) — dropping slow client, back to spool",
                file=sys.stderr, flush=True,
            )
            self._client_writer = None
            try:
                w.close()
            except Exception:
                pass
            return
        try:
            w.write((json.dumps(obj, separators=(",", ":")) + "\n").encode())
            # Wake the single persistent drainer — O(1) tasks regardless of
            # message rate; the buffer-size check above bounds the bytes.
            self._drain_waker.set()
        except Exception:
            self._client_writer = None

    async def _drain_loop(self) -> None:
        """One drainer for the holder's lifetime (Codex 16.7)."""
        while True:
            await self._drain_waker.wait()
            self._drain_waker.clear()
            w = self._client_writer
            if w is None:
                continue
            try:
                await w.drain()
            except Exception:
                if self._client_writer is w:
                    self._client_writer = None

    # ── Teardown ──────────────────────────────────────────────────────────
    async def _reap(self, force_after: float) -> Optional[int]:
        """waitpid with patience, then SIGKILL. Returns the exit code (or
        negative signal number), None if unknowable."""
        if not self.child_pid:
            return None
        deadline = time.monotonic() + force_after
        killed = False
        while True:
            try:
                pid, status = os.waitpid(self.child_pid, os.WNOHANG)
            except ChildProcessError:
                return None
            except OSError:
                return None
            if pid == self.child_pid:
                if os.WIFEXITED(status):
                    return os.WEXITSTATUS(status)
                if os.WIFSIGNALED(status):
                    return -os.WTERMSIG(status)
                return None
            if time.monotonic() >= deadline:
                if killed:
                    return None
                try:
                    os.kill(self.child_pid, signal.SIGKILL)
                except OSError:
                    return None
                killed = True
                deadline = time.monotonic() + 2.0
            await asyncio.sleep(0.1)

    async def _shutdown(self, force_after: float = REAP_TIMEOUT_S) -> None:
        """Idempotent: SIGHUP bash, reap it, tell the agent, remove the
        socket + spool, release the run() loop."""
        if self._cleaning:
            return
        self._cleaning = True
        self._pause_pty_reader()
        if self.child_pid:
            try:
                os.kill(self.child_pid, signal.SIGHUP)
            except (ProcessLookupError, OSError):
                pass
        self.exit_code = await self._reap(force_after)
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None
        self._close_spool()
        w = self._client_writer
        if w is not None:
            try:
                w.write((json.dumps({"exit": self.exit_code},
                                    separators=(",", ":")) + "\n").encode())
                await w.drain()
                w.close()
            except Exception:
                pass
            self._client_writer = None
        for p in (self.sock_path, self.spool_path):
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass
        _log(self.shell_id, f"bash exited (code={self.exit_code}) — holder done")
        self._done.set()

    # ── Main ──────────────────────────────────────────────────────────────
    async def run(self) -> int:
        self.shells_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.shells_dir, 0o700)
        except OSError:
            pass
        # Stale socket from a previous crashed holder with the same id.
        try:
            self.sock_path.unlink(missing_ok=True)
        except OSError:
            pass
        self._fork_bash()
        server = await asyncio.start_unix_server(
            self._handle_client, path=str(self.sock_path), limit=SOCK_READER_LIMIT
        )
        try:
            os.chmod(self.sock_path, 0o600)
        except OSError:
            pass

        loop = asyncio.get_event_loop()
        loop.create_task(self._drain_loop())

        def _on_signal() -> None:
            _log(self.shell_id, "signal received — shutting down")
            loop.create_task(self._shutdown())

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _on_signal)
            except NotImplementedError:
                pass
        # SIGHUP could only come from a controlling terminal we don't have;
        # ignore it defensively (we ARE the thing that must not die).
        try:
            loop.add_signal_handler(signal.SIGHUP, lambda: None)
        except NotImplementedError:
            pass

        _log(self.shell_id,
             f"holding bash pid={self.child_pid} on {self.sock_path} "
             f"({self.cols}x{self.rows}, cwd={self.cwd or '~'})")
        async with server:
            await self._done.wait()
            server.close()
        return 0


def holder_main(
    shell_id: str,
    *,
    cwd: Optional[str],
    name: Optional[str],
    cols: int,
    rows: int,
    state_dir: Path,
) -> int:
    if not shell_id or "/" in shell_id or "\0" in shell_id:
        print(f"[holder] invalid shell id: {shell_id!r}", file=sys.stderr)
        return 2
    holder = Holder(
        shell_id,
        cwd=cwd,
        name=name,
        cols=cols,
        rows=rows,
        shells_dir=state_dir / "shells",
    )
    try:
        asyncio.run(holder.run())
    except KeyboardInterrupt:
        pass
    return 0
