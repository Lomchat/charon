"""Mode --connect : proxy bidirectionnel stdin/stdout ↔ Unix socket.

Utilisé par Charon depuis SSH :
  ssh user@host -- ~/.charon/charon-agent.pyz --connect

L'implémentation utilise des threads synchrones plutôt qu'asyncio : asyncio
refuse connect_read/write_pipe quand stdin/stdout sont des fichiers réguliers
(pipes shell, redirections), ce qui rendait le proxy inutilisable.

Sortie codes :
  0 — clean exit (EOF d'un côté)
  2 — socket introuvable (l'agent ne tourne pas)
  3 — connect failed (permission, etc.)
"""
from __future__ import annotations

import socket
import sys
import threading
from pathlib import Path


def _pump_to_socket(src_fd: int, sock: socket.socket, downlink_done: threading.Event) -> None:
    """stdin → socket. À EOF de stdin, on shutdown(WR) du socket pour signaler
    au serveur qu'on n'enverra plus rien, sans tuer la lecture du socket."""
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
    """socket → stdout. Quand le socket ferme (EOF du serveur), on quitte."""
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
        print(f"charon-agent: socket {socket_path} introuvable (daemon pas démarré ?)",
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
    # socket → stdout (référence : c'est celui-ci qui décide quand on sort)
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
