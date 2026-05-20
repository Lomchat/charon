"""Entry point — selects between daemon mode and --connect mode."""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from . import __version__


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
    args = p.parse_args(argv)

    state_dir = _default_state_dir()
    socket_path = args.socket or _default_socket(state_dir)
    state_path = args.state or _default_state_file(state_dir)

    if args.connect:
        from .client import connect_main
        return connect_main(socket_path)

    # Daemon mode
    from .server import Server
    server = Server(socket_path=socket_path, state_path=state_path)
    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
