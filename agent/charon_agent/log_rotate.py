"""Bounded `agent.log` — the one log nothing was truncating.

The systemd-user unit writes with `StandardOutput=append:<state_dir>/agent.log`
(the nohup fallback does the same with `>>`), so ONE fd is opened with O_APPEND
at start and never reopened. That rules out the usual rename-based rotation:
after a `mv`, every later write still lands in the renamed inode and the fresh
file stays empty forever — the daemon would have to be restarted to notice.

What IS safe on an O_APPEND fd is COPY + TRUNCATE. O_APPEND recomputes the
offset as end-of-file on every write, so truncating to 0 makes the next line
land at 0 instead of leaving a multi-gigabyte sparse hole (which is exactly
what truncating a plain O_WRONLY fd would give you). Lines appended between the
copy and the truncate are lost: bounded, deliberate, and better than the
alternative measured on the fleet — 147 MB and growing on a box installed a few
weeks earlier, with no rotation in sight.

One generation is kept (`agent.log.1`), so the pair is bounded by
2 × MAX_BYTES. Env-overridable like the event log (§5): CHARON_LOG_MAX_BYTES,
CHARON_LOG_ROTATE_CHECK_S.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import sys
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, "") or 0)
        return v if v > 0 else default
    except ValueError:
        return default


MAX_BYTES = _env_int("CHARON_LOG_MAX_BYTES", 8 * 1024 * 1024)
CHECK_INTERVAL_S = _env_int("CHARON_LOG_ROTATE_CHECK_S", 300)


def rotate_if_needed(path: Path, max_bytes: int = MAX_BYTES) -> bool:
    """Copy `path` to `path.1` and truncate it when it exceeds `max_bytes`.

    Returns True when a rotation happened. Never raises: a log that cannot be
    rotated (read-only fs, vanished file, race with a restart) must not take
    the daemon down — the next tick tries again.
    """
    try:
        size = path.stat().st_size
    except OSError:
        return False
    if size <= max_bytes:
        return False
    previous = path.with_name(path.name + ".1")
    try:
        # copyfile, never move: the writer's fd points at THIS inode and must
        # keep pointing at it.
        shutil.copyfile(path, previous)
        # Truncate through a separate fd — the writer's own offset is
        # irrelevant under O_APPEND, and this works whether the writer is
        # systemd, a nohup shell or nothing at all.
        with open(path, "r+b") as fh:
            fh.truncate(0)
    except OSError as e:
        print(f"[log] rotation failed for {path}: {e}", file=sys.stderr, flush=True)
        return False
    print(f"[log] rotated {path.name} at {size} bytes → {previous.name}",
          file=sys.stderr, flush=True)
    return True


async def rotation_loop(path: Path, max_bytes: int = MAX_BYTES,
                        interval_s: int = CHECK_INTERVAL_S) -> None:
    """Check the log size every `interval_s`, forever (cancelled at shutdown).

    The stat + copy run in a thread: an 8 MiB copy is short but the event loop
    also carries live provider streams, and this task has no deadline.
    """
    while True:
        try:
            await asyncio.sleep(interval_s)
            await asyncio.to_thread(rotate_if_needed, path, max_bytes)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # never kill the daemon over a log file
            print(f"[log] rotation loop error: {e}", file=sys.stderr, flush=True)
