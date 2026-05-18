"""Entry point — choisit entre le mode daemon et le mode --connect."""
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
        description="Daemon Claude pour les sessions Charon (mode daemon par défaut).",
    )
    p.add_argument("--version", action="version", version=f"charon-agent {__version__}")
    p.add_argument("--socket", type=Path, default=None,
                   help="chemin du Unix socket (défaut: ~/.charon/agent.sock)")
    p.add_argument("--state", type=Path, default=None,
                   help="chemin de state.json (défaut: ~/.charon/state.json)")
    p.add_argument("--connect", action="store_true",
                   help="mode proxy stdio ↔ socket (utilisé par Charon via SSH)")
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
