"""Durable per-session event log.

Why this exists
---------------
The agent emits a constant stream of events per session (assistant_text
deltas, tool_use, tool_result, edit_snapshot, todo_update, …). Charon
persists them into SQLite, but only while it is connected. If Charon is
down (restart, network, etc.) and the agent keeps running, events pile
up in the in-memory ring buffer (`RING_SIZE` in server.py). When the
ring overflows, those events are lost forever — Charon's DB will never
catch up, and the browser polling will never see them.

This module adds a durable JSON-Lines log per session at
    ~/.charon/events/<session_id>.jsonl

with a monotonically increasing `seq` field on every event. On reconnect,
Charon can call `subscribe({session_id, after_seq})` to get exactly the
events it missed, instead of being limited to whatever the ring still
holds.

Design
------
- One file per session, append-only, line-delimited JSON (`\n`).
- `seq` is the only "primary key"; we never reuse a seq. Seqs start at 1.
- Rotation: when the current file exceeds `MAX_FILE_BYTES`, it is renamed
  with a `.<n>` suffix and a fresh file starts. We keep at most
  `MAX_ROTATIONS` rotated files (oldest deleted).
- Reads (`read_since`) merge across rotations transparently.
- `current_seq` is cached in memory; on load it's recovered by scanning
  the last few lines of the active file.
- All I/O is sync. Single writer per session (asyncio loop is
  single-threaded, all _emit calls flow through the server). POSIX
  guarantees atomic appends up to PIPE_BUF (~4KB); our events are well
  under that.

Failure modes
-------------
- Corrupt line (e.g. partial write during crash): skipped on read with
  a warning to stderr. The seq counter on load takes the max valid seq
  found in the file.
- Disk full: append raises; the caller logs and continues (the ring
  buffer is still populated, so live subscribers don't notice).
- Concurrent delete (rare): tolerated; next append recreates the file.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Iterable


# Tunables. Defaults: 10 MB per file × 3 rotations = 30 MB worst case per
# session. At ~200 B/event that's 150k events of history, well beyond any
# realistic Charon downtime window. Compaction (truncating already-
# acknowledged events) is intentionally out of scope for now — disk is
# cheap, and the deletion path runs on session delete anyway.
# Overridable via env (P0.4 — retention knobs): CHARON_EVLOG_MAX_BYTES /
# CHARON_EVLOG_ROTATIONS, e.g. through a systemd-user drop-in
# (Environment=...) for VPSes with tight disks or very long hub outages.
def _env_int(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, ""))
        return v if v > 0 else default
    except ValueError:
        return default

MAX_FILE_BYTES = _env_int("CHARON_EVLOG_MAX_BYTES", 10 * 1024 * 1024)
MAX_ROTATIONS = _env_int("CHARON_EVLOG_ROTATIONS", 3)


class EventLog:
    """Per-session durable event log. Not thread-safe — single writer."""

    def __init__(self, session_id: str, base_dir: Path) -> None:
        if not session_id or '/' in session_id or '\0' in session_id:
            raise ValueError(f"invalid session_id: {session_id!r}")
        self.session_id = session_id
        self.base_dir = base_dir
        self.path = base_dir / f"{session_id}.jsonl"
        self._seq = 0
        self._loaded = False
        # Cached earliest retained seq (None = unknown/empty). Invalidated
        # when rotation drops the oldest file — consumers (subscribe) use it
        # to detect an unrecoverable replay gap (hub cursor < earliest - 1).
        self._earliest: int | None = None

    # ── lifecycle ────────────────────────────────────────────────────────
    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self._seq = self._recover_seq()
        self._loaded = True

    def _recover_seq(self) -> int:
        """Best-effort: max seq found across the active file AND all
        rotated files. Returns 0 if no file at all (fresh session).
        Tolerates corruption by skipping bad lines.

        Why we also scan rotations: in steady state the active file
        holds the latest seqs (rotations are renames of older content),
        but if a rotation happens and the process crashes before the
        next append writes to the new active file, the active file
        does not exist on reload — yet .1 holds high seqs we must not
        clash with. Scanning all files makes recovery robust to that
        edge case without runtime cost (recovery runs once at startup).
        """
        max_seq = 0
        files: list[Path] = []
        for n in range(MAX_ROTATIONS, 0, -1):
            p = self.base_dir / f"{self.session_id}.jsonl.{n}"
            if p.exists():
                files.append(p)
        if self.path.exists():
            files.append(self.path)
        for path in files:
            try:
                with path.open("rb") as f:
                    for raw in f:
                        try:
                            obj = json.loads(raw.decode("utf-8", "replace"))
                            s = obj.get("seq")
                            if isinstance(s, int) and s > max_seq:
                                max_seq = s
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            continue
            except OSError as e:
                print(
                    f"[event_log] WARN: failed to recover seq for "
                    f"{self.session_id} ({path.name}): {e}",
                    file=sys.stderr, flush=True,
                )
        return max_seq

    # ── append ───────────────────────────────────────────────────────────
    def append(self, event: dict[str, Any]) -> int:
        """Append an event to the log, attaching `seq` and `ts`.
        Returns the assigned seq. Caller may want to mutate the returned
        dict so downstream consumers see the same shape — but in our
        usage the dict is built fresh per emit so we just return seq."""
        self._ensure_loaded()
        self._seq += 1
        seq = self._seq
        record = {"seq": seq, "ts": time.time(), **event}
        # Mutate the event dict in place too, so live broadcasts see the
        # seq alongside whatever fields the caller set.
        event["seq"] = seq
        event.setdefault("ts", record["ts"])
        # default=str: never let a stray non-JSON-native value (e.g. a Codex
        # SDK pydantic wrapper leaking into an event payload) fail the durable
        # append — the live socket send already tolerates it the same way.
        line = json.dumps(record, separators=(",", ":"), default=str) + "\n"
        try:
            self._maybe_rotate()
            # 'a' is atomic at the syscall level on POSIX for writes <= PIPE_BUF.
            with self.path.open("a", encoding="utf-8") as f:
                f.write(line)
        except OSError as e:
            # Don't crash the agent if disk is full — the ring buffer is
            # the in-memory fallback for live subscribers.
            print(
                f"[event_log] WARN: append failed for "
                f"{self.session_id}: {e}",
                file=sys.stderr, flush=True,
            )
        return seq

    def _maybe_rotate(self) -> None:
        try:
            size = self.path.stat().st_size if self.path.exists() else 0
        except OSError:
            return
        if size < MAX_FILE_BYTES:
            return
        # Shift .N -> .N+1, drop the oldest. Dropping a file changes the
        # earliest retained seq → invalidate the cache (recomputed lazily).
        self._earliest = None
        for n in range(MAX_ROTATIONS, 0, -1):
            src = self.base_dir / f"{self.session_id}.jsonl.{n}"
            if n == MAX_ROTATIONS:
                if src.exists():
                    try:
                        src.unlink()
                    except OSError:
                        pass
                continue
            dst = self.base_dir / f"{self.session_id}.jsonl.{n + 1}"
            if src.exists():
                try:
                    src.rename(dst)
                except OSError:
                    pass
        try:
            self.path.rename(self.base_dir / f"{self.session_id}.jsonl.1")
        except OSError as e:
            print(
                f"[event_log] WARN: rotation failed for "
                f"{self.session_id}: {e}",
                file=sys.stderr, flush=True,
            )

    # ── read ─────────────────────────────────────────────────────────────
    def read_since(self, after_seq: int, limit: int | None = None) -> list[dict[str, Any]]:
        """Return events with seq > after_seq, ordered ascending.

        Merges across rotated files. The rotated files (.1, .2, …) hold
        OLDER events than the current file; we read from the oldest
        rotation forward.
        """
        self._ensure_loaded()
        out: list[dict[str, Any]] = []
        files = self._iter_files_oldest_first()
        for fp in files:
            for evt in _read_jsonl(fp):
                s = evt.get("seq")
                if isinstance(s, int) and s > after_seq:
                    out.append(evt)
                    if limit is not None and len(out) >= limit:
                        return out
        # Defensive ordering: sequencer should already give us sorted, but
        # in pathological cases (manual rotation, corruption) the merge
        # might not be monotone. Sort by seq to be safe.
        out.sort(key=lambda e: e.get("seq", 0))
        return out

    def read_tail(self, max_output_bytes: int) -> list[dict[str, Any]]:
        """Return the SUFFIX of the log whose cumulative output size is
        <= `max_output_bytes`, ordered ascending (chronological).

        This is the "show the bottom fast" path for shells (agent >= 0.9.0).
        Replaying the entire durable log on every reopen made a long-running
        shell take several seconds to scroll to the bottom AND re-streamed up
        to 30 MB VPS→hub on each reconnect. Replaying only the tail (the last
        ~N bytes of `data`) renders the latest screen near-instantly with
        bounded egress.

        Budget is measured against the `data` field length (shell_output
        payloads); non-output events (shell_status) inside the window are kept
        as-is. We slice on WHOLE event boundaries — never mid-event — so UTF-8
        and JSON stay intact. Trade-off (accepted by design): the first
        retained chunk may start mid-ANSI-state, so colors/cursor can be
        briefly off until the program repaints (interactive TUIs repaint on
        the next refresh anyway); scrollback older than the cap is gone.

        Reads files newest-first and stops as soon as the budget is met, so a
        512 KB tail of a 30 MB log only touches the active file in the common
        case.
        """
        self._ensure_loaded()
        if max_output_bytes <= 0:
            return []
        collected: list[dict[str, Any]] = []
        total = 0
        # newest file → oldest file
        for fp in reversed(self._iter_files_oldest_first()):
            evts = list(_read_jsonl(fp))
            # newest event → oldest within the file
            for evt in reversed(evts):
                collected.append(evt)
                d = evt.get("data")
                if isinstance(d, str):
                    total += len(d)
                if total >= max_output_bytes:
                    collected.reverse()
                    collected.sort(key=lambda e: e.get("seq", 0))
                    return collected
        collected.reverse()
        collected.sort(key=lambda e: e.get("seq", 0))
        return collected

    def _iter_files_oldest_first(self) -> list[Path]:
        """Returns rotated files in oldest-first order, then current."""
        rotated: list[Path] = []
        for n in range(MAX_ROTATIONS, 0, -1):
            p = self.base_dir / f"{self.session_id}.jsonl.{n}"
            if p.exists():
                rotated.append(p)
        if self.path.exists():
            rotated.append(self.path)
        return rotated

    def current_seq(self) -> int:
        self._ensure_loaded()
        return self._seq

    def earliest_seq(self) -> int | None:
        """Smallest seq still retained on disk (None if the log is empty).

        Seqs are DENSE (+1 per append, never reused), so `earliest_seq > N+1`
        proves events N+1 .. earliest-1 were rotated away and can never be
        replayed — that's the signal `subscribe` uses to report a `gap` to
        the hub instead of silently starting the replay at the oldest
        retained event (P0.4). Cached; invalidated when rotation drops the
        oldest file. Cost when uncached: first parseable line of the oldest
        file (readers are lazy generators)."""
        self._ensure_loaded()
        if self._earliest is not None:
            return self._earliest
        for fp in self._iter_files_oldest_first():
            for evt in _read_jsonl(fp):
                s = evt.get("seq")
                if isinstance(s, int):
                    self._earliest = s
                    return s
        return None

    # ── delete ──────────────────────────────────────────────────────────
    def delete(self) -> None:
        """Remove the log files for this session. Used on session
        delete (kill). Idempotent."""
        for n in range(MAX_ROTATIONS, 0, -1):
            p = self.base_dir / f"{self.session_id}.jsonl.{n}"
            try:
                if p.exists():
                    p.unlink()
            except OSError:
                pass
        try:
            if self.path.exists():
                self.path.unlink()
        except OSError:
            pass
        # Reset in-memory state — a subsequent append would re-create.
        self._seq = 0
        self._loaded = False
        self._earliest = None


def _read_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    """Yields parsed objects from a JSON-Lines file, skipping bad lines."""
    try:
        with path.open("rb") as f:
            for raw in f:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict):
                    yield obj
    except OSError as e:
        print(
            f"[event_log] WARN: read failed for {path}: {e}",
            file=sys.stderr, flush=True,
        )


def cleanup_orphans(base_dir: Path, known_session_ids: set[str]) -> int:
    """Removes log files for sessions not in `known_session_ids`. Called
    at agent boot. Returns the number of files cleaned up."""
    if not base_dir.exists():
        return 0
    n = 0
    try:
        for entry in base_dir.iterdir():
            if not entry.is_file():
                continue
            name = entry.name
            # Match `<sid>.jsonl` or `<sid>.jsonl.<rot>`.
            if not name.endswith(".jsonl") and ".jsonl." not in name:
                continue
            stem = name.split(".jsonl", 1)[0]
            if stem not in known_session_ids:
                try:
                    entry.unlink()
                    n += 1
                except OSError:
                    pass
    except OSError as e:
        print(
            f"[event_log] WARN: cleanup_orphans failed: {e}",
            file=sys.stderr, flush=True,
        )
    return n
