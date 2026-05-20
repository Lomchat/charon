"""--connect mode: bidirectional stdin/stdout ↔ Unix socket proxy.

Used by Charon over SSH:
  ssh user@host -- ~/.charon/charon-agent.pyz --connect

The implementation uses synchronous threads rather than asyncio: asyncio
refuses connect_read/write_pipe when stdin/stdout are regular files
(shell pipes, redirections), which made the proxy unusable.

Exit codes:
  0 — clean exit (EOF on one side)
  2 — socket not found (the agent is not running)
  3 — connect failed (permission, etc.)
"""
from __future__ import annotations

import socket
import sys
import threading
from pathlib import Path


def _pump_to_socket(src_fd: int, sock: socket.socket, downlink_done: threading.Event) -> None:
    """stdin → socket. On stdin EOF, we shutdown(WR) the socket to signal
    to the server that we won't send anything more, without killing the socket read."""
    import os
    try:
        while not downlink_done.is_set():
            chunk = os.read(src_fd, 8192)
            if not chunk:
                break
            try:
                sock.sendall(chunk)
            except (BrokenPipeError, ConnectionResetError, OSError):
                break
    except (OSError, ValueError):
        pass
    try:
        sock.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def _pump_from_socket(sock: socket.socket, dst_fd: int, done: threading.Event) -> None:
    """socket → stdout. When the socket closes (server EOF), we exit."""
    import os
    try:
        while True:
            try:
                chunk = sock.recv(8192)
            except (ConnectionResetError, OSError):
                break
            if not chunk:
                break
            n = 0
            while n < len(chunk):
                try:
                    n += os.write(dst_fd, chunk[n:])
                except BrokenPipeError:
                    return
    finally:
        done.set()


def connect_main(socket_path: Path) -> int:
    if not socket_path.exists():
        print(f"charon-agent: socket {socket_path} not found (daemon not started?)",
              file=sys.stderr)
        return 2
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(str(socket_path))
    except (FileNotFoundError, ConnectionRefusedError, PermissionError, OSError) as e:
        print(f"charon-agent: connect failed: {e}", file=sys.stderr)
        return 3

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    downlink_done = threading.Event()

    # stdin → socket
    t_up = threading.Thread(
        target=_pump_to_socket, args=(stdin_fd, sock, downlink_done),
        name="stdin→sock", daemon=True,
    )
    # socket → stdout (reference: this is the one that decides when we exit)
    t_down = threading.Thread(
        target=_pump_from_socket, args=(sock, stdout_fd, downlink_done),
        name="sock→stdout", daemon=True,
    )
    t_up.start()
    t_down.start()

    try:
        downlink_done.wait()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        sock.close()
    return 0
