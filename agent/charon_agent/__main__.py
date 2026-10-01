"""Entry point — selects between daemon mode and --connect mode."""
from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import os
import signal
import sys
from pathlib import Path

from . import __version__


def _decode_stream_arg(raw: str) -> str:
    """Decode one URL-safe base64 CLI argument emitted by the hub."""
    padded = raw + "=" * (-len(raw) % 4)
    try:
        return base64.b64decode(padded, altchars=b"-_", validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError) as e:
        raise ValueError("invalid stream argument") from e


def _default_state_dir() -> Path:
    return Path(os.environ.get("CHARON_AGENT_HOME") or Path.home() / ".charon")


def _default_socket(state_dir: Path) -> Path:
    return state_dir / "agent.sock"


def _default_state_file(state_dir: Path) -> Path:
    return state_dir / "state.json"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="charon-agent",
        description="Claude daemon for Charon sessions (daemon mode by default).",
    )
    p.add_argument("--version", action="version", version=f"charon-agent {__version__}")
    p.add_argument("--socket", type=Path, default=None,
                   help="path to the Unix socket (default: ~/.charon/agent.sock)")
    p.add_argument("--state", type=Path, default=None,
                   help="path to state.json (default: ~/.charon/state.json)")
    p.add_argument("--connect", action="store_true",
                   help="stdio ↔ socket proxy mode (used by Charon over SSH)")
    p.add_argument("--peer-mcp", metavar="SOURCE_SESSION_ID", default=None,
                   help="internal: expose the provider-neutral peer bus over stdio MCP")
    stream_mode = p.add_mutually_exclusive_group()
    stream_mode.add_argument("--stream-file", nargs=2, metavar=("ROOT_B64", "PATH_B64"), default=None,
                             help="internal: stream one contained file over stdout")
    stream_mode.add_argument("--stream-zip", nargs=2, metavar=("ROOT_B64", "PATH_B64"), default=None,
                             help="internal: stream one contained directory as ZIP over stdout")
    stream_mode.add_argument("--receive-file", nargs=2, metavar=("ROOT_B64", "PATH_B64"), default=None,
                             help="internal: write --length bytes of stdin into one contained file")
    p.add_argument("--offset", type=int, default=0,
                   help="stream-file: first byte offset")
    p.add_argument("--length", type=int, default=None,
                   help="stream-file / receive-file: exact byte count")
    p.add_argument("--overwrite", action="store_true",
                   help="receive-file: replace an existing file instead of refusing")
    p.add_argument("--expected-version", default=None,
                   help="stream-file: base64url fs_stat version precondition")
    # ── Shell holder mode (>= 0.10.0) ──
    # A detached per-shell process owning the PTY + bash so the shell
    # survives agent restarts. Spawned BY the agent, never by hand.
    p.add_argument("--shell-holder", metavar="SHELL_ID", default=None,
                   help="internal: run as the detached PTY holder for a shell")
    p.add_argument("--cwd", default=None, help="holder: shell working directory")
    p.add_argument("--name", default=None, help="holder: shell display name")
    p.add_argument("--cols", type=int, default=120, help="holder: initial cols")
    p.add_argument("--rows", type=int, default=32, help="holder: initial rows")
    args = p.parse_args(argv)

    state_dir = _default_state_dir()
    socket_path = args.socket or _default_socket(state_dir)
    state_path = args.state or _default_state_file(state_dir)

    if args.stream_file:
        from .fsnav import STREAM_BAD_PATH, stream_file_to
        try:
            root, path = (_decode_stream_arg(v) for v in args.stream_file)
            expected = (_decode_stream_arg(args.expected_version)
                        if args.expected_version is not None else None)
        except ValueError as e:
            print(str(e), file=sys.stderr, flush=True)
            return STREAM_BAD_PATH
        code, error = stream_file_to(
            root, path, sys.stdout.buffer,
            offset=args.offset, length=args.length,
            expected_version=expected,
        )
        if error:
            print(error, file=sys.stderr, flush=True)
        return code

    if args.stream_zip:
        from .fsnav import STREAM_BAD_PATH, stream_directory_zip_to
        try:
            root, path = (_decode_stream_arg(v) for v in args.stream_zip)
        except ValueError as e:
            print(str(e), file=sys.stderr, flush=True)
            return STREAM_BAD_PATH
        code, error = stream_directory_zip_to(root, path, sys.stdout.buffer)
        if error:
            print(error, file=sys.stderr, flush=True)
        return code

    if args.receive_file:
        from .fsnav import (
            STREAM_BAD_PATH, STREAM_BAD_RANGE, STREAM_IO_ERROR, receive_file_from,
        )
        try:
            root, path = (_decode_stream_arg(v) for v in args.receive_file)
        except ValueError as e:
            print(str(e), file=sys.stderr, flush=True)
            return STREAM_BAD_PATH
        if args.length is None:
            print("--length is required", file=sys.stderr, flush=True)
            return STREAM_BAD_RANGE

        # A signal must still run the temp cleanup: SystemExit unwinds through
        # receive_file_from's `finally`, where the default action would not.
        def _interrupted(_signum, _frame):
            raise SystemExit(STREAM_IO_ERROR)
        for sig in (signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, _interrupted)

        def _ready() -> None:
            # The hub waits for this line before sending a byte: every refusal
            # (exists, missing folder, outside the root) is decided by then.
            sys.stdout.write("ready\n")
            sys.stdout.flush()

        code, error = receive_file_from(
            root, path, sys.stdin.buffer, args.length,
            overwrite=args.overwrite, ready=_ready,
        )
        if error:
            print(error, file=sys.stderr, flush=True)
        return code

    if args.shell_holder:
        from .holder import holder_main
        return holder_main(
            args.shell_holder,
            cwd=args.cwd,
            name=args.name,
            cols=args.cols,
            rows=args.rows,
            state_dir=state_dir,
        )

    if args.connect:
        from .client import connect_main
        return connect_main(socket_path)

    if args.peer_mcp:
        from .peer_mcp import run as peer_mcp_main
        return peer_mcp_main(args.peer_mcp, str(socket_path))

    # Daemon mode
    from .server import AlreadyRunning, EXIT_ALREADY_RUNNING, Server
    server = Server(socket_path=socket_path, state_path=state_path)
    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    except AlreadyRunning as e:
        # Loud and non-zero rather than a silent second daemon on the same
        # state.json (§14.97). Under `Restart=always` systemd will retry, so
        # the unit visibly flaps until the leftover process is killed —
        # exactly the signal that was missing when it went unnoticed.
        print(f"[server] refusing to start: {e}", file=sys.stderr, flush=True)
        return EXIT_ALREADY_RUNNING
    return 0


if __name__ == "__main__":
    sys.exit(main())
