"""Session runtime: a detached process that OWNS live provider sessions (§14.117).

Why this exists
---------------
The provider CLIs (Claude, the Codex app-server, the Cursor bridge) are
children of whoever holds their SDK client, wired to it by pipes. When that
holder was the daemon, an agent update — which restarts the daemon — cut every
running turn and background task on the VPS, so updates had to wait for a
quiet box that always-on agents never give.

The fix mirrors the shell holder (§14.44): the sessions belong to a process
whose lifetime is NOT the daemon's.

    charon-agent daemon (restartable)        runtime <generation> (detached)
    ┌───────────────────────────┐  JSON   ┌───────────────────────────────┐
    │ RemoteSession proxies      │ ◄─────► │ runtimes/<gen>.sock           │
    │ event log · subscribers    │  lines  │ session objects → CLIs        │
    │ peer ledger · fs · git …   │         │ unacked spool (daemon away)   │
    └───────────────────────────┘         └───────────────────────────────┘

A GENERATION names the code a runtime runs: the frozen zipapp
(`runtimes/<sha>.pyz`, never the live path an update swaps) plus the provider
SDK versions it imported. A daemon restart with the same generation adopts
its runtime and nothing moves. After an update the old runtime keeps its
sessions running (they are "outdated"); the hub moves each one when it is idle
(`migrate_session`: stop here, resume in the current runtime), and an outdated
runtime with no session left retires.

Wire protocol (one JSON object per line, both ways)
---------------------------------------------------
daemon → runtime:
    {"id", "op": "attach", "acked": {"rid", "n"}}    first line of a connection
    {"id", "op": "create", "row": {...}, "start": bool}
    {"id", "op": "call", "sid", "method", "params"}  session_ops.run
    {"id", "op": "release", "sid", "stop": mark|null, "only_if_idle": bool}
    {"id", "op": "accounts_changed", "ids": [...]}
    {"id", "op": "retire"} · {"id", "op": "ping"}
    {"ack": n}                                       numbered lines processed
runtime → daemon:
    {"res": id, "result": ...} | {"res": id, "error": {"code", "message"}}
    {"n", "ev": payload}                             a session event (pre-seq)
    {"n", "st": {"sid", "info", "persist", "x"}}     a session's state mirror

Numbered lines stay in the runtime until the daemon acks them, and are resent
on the next attach past the daemon's DURABLE watermark (`<gen>/acked.json`,
written after the events were logged): a daemon that restarts mid-stream loses
no event and logs none twice. Responses belong to their connection only.

Robustness notes
----------------
- Runs from the frozen copy, so its lazy imports never read a swapped archive
  (the holder's rule, §14.44); the provider SDK packages are imported up
  front for the same reason — an update pip-upgrades them in place.
- Own session (`setsid`): the daemon's child ledger never lists it, and its
  own `ChildLedger` (in `<gen>/p<pid>/`, per PROCESS: a respawn of the same
  generation must never have its children reaped as the dead one's) lets the
  daemon reap its CLIs if it is
  SIGKILLed (§14.113).
- One runtime per generation: a live socket owner makes a second one exit.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import os
import pkgutil
import signal
import sys
import time
import traceback
import uuid
from collections import deque
from pathlib import Path
from typing import Any

from . import session_ops
from .child_ledger import ChildLedger, proc_stat
from .protocol import ERR_INTERNAL, ERR_METHOD_NOT_FOUND, ERR_SESSION_NOT_FOUND, RpcError

PROTO = 1
READER_LIMIT = 16 * 1024 * 1024
# Numbered lines kept while no daemon reads them. A daemon restart lasts
# seconds; past this bound the OLDEST lines go (logged) rather than the box.
UNACKED_MAX_BYTES = 256 * 1024 * 1024
# A runtime with no session and no daemon for this long is an orphan.
ORPHAN_IDLE_S = 600.0
# Unattached this long while a daemon answers: that daemon will not adopt us.
ORPHAN_PROBE_S = 20.0
STOP_GRACE_S = 8.0
# Input this recent may sit between the queue and the turn's first status:
# a move now could drop it.
RECENT_INPUT_S = float(os.environ.get("CHARON_MIGRATE_QUIET_S") or 15.0)
EXIT_ALREADY_RUNNING = 4

# Events too frequent to re-send the session's state mirror after each one.
_NO_STATE_EVENTS = frozenset({
    "assistant_text", "thinking", "usage", "generation_progress", "tool_progress",
    "edit_progress", "plan_progress", "bg_task_progress", "codex_signal",
    "tool_activity", "endpoint_usage", "rate_limit",
})

# Provider SDK packages imported whole at boot (see module docstring).
_PRELOAD_PACKAGES = ("claude_agent_sdk", "openai_codex", "cursor_sdk")


def runtimes_dir(state_dir: Path) -> Path:
    return Path(state_dir) / "runtimes"


def runtime_socket(state_dir: Path, generation: str) -> Path:
    return runtimes_dir(state_dir) / f"{generation}.sock"


def runtime_home(state_dir: Path, generation: str) -> Path:
    return runtimes_dir(state_dir) / generation


def process_home(home: Path, pid: int) -> Path:
    """One runtime PROCESS's pid file + child ledger."""
    return Path(home) / f"p{pid}"


def encode(obj: dict[str, Any]) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str)
            + "\n").encode("utf-8")


def _preload() -> None:
    """Import every module a session may need, now, from the frozen archive
    and from the SDK versions installed at this instant."""
    for mod in ("session", "codex_session", "cursor_session", "cursor_runtime",
                "codex_compat", "prompt_cache", "custom_endpoints", "endpoint_proxy",
                "endpoint_responses", "stream_metrics", "account_profiles",
                "global_accounts", "usage", "history"):
        try:
            importlib.import_module(f"charon_agent.{mod}")
        except Exception:
            pass
    for name in _PRELOAD_PACKAGES:
        try:
            pkg = importlib.import_module(name)
        except Exception:
            continue
        for info in pkgutil.walk_packages(getattr(pkg, "__path__", []), prefix=name + ".",
                                          onerror=lambda _name: None):
            try:
                importlib.import_module(info.name)
            except Exception:
                pass


class _Slot:
    """One hosted session. `released` silences a dropped object's late emits
    (a force-stopped run winding down in the background)."""

    __slots__ = ("sid", "session", "released", "bg", "last_input")

    def __init__(self, sid: str) -> None:
        self.sid = sid
        self.session: Any = None
        self.released = False
        # Background tasks the provider reported started and not yet ended:
        # stopping the CLI would kill them (§14.91). Kept HERE, not in the
        # daemon, so a daemon restart forgets nothing.
        self.bg: set[str] = set()
        self.last_input = 0.0

    def track(self, payload: dict[str, Any]) -> None:
        name = payload.get("event")
        if name == "bg_task":
            task_id = payload.get("task_id")
            if not isinstance(task_id, str) or not task_id:
                return
            if payload.get("terminal") is True or payload.get("kind") == "finished":
                self.bg.discard(task_id)
            elif payload.get("kind") == "started":
                self.bg.add(task_id)
        elif name == "ready" or (name == "status" and payload.get("status") in (
                "sleeping", "error", "killed")):
            self.bg.clear()

    def blocker(self, *, recent: bool = True) -> str | None:
        """`session_ops.migration_blocker` plus what only the runtime saw.
        `recent=False` for the mirrored copy: a clock-based answer would stay
        stale in the daemon until the next state line."""
        if self.bg:
            return "background task"
        if recent and time.monotonic() - self.last_input < RECENT_INPUT_S:
            return "recent input"
        return session_ops.migration_blocker(self.session)


class _Host:
    """What `session_ops.run` needs from whoever holds the session."""

    def __init__(self, runtime: "Runtime", sid: str) -> None:
        self._runtime = runtime
        self._sid = sid

    def schedule_save(self) -> None:
        self._runtime.push_state(self._sid)


class _Conn:
    def __init__(self, writer: asyncio.StreamWriter) -> None:
        self.writer = writer
        self.queue: deque[bytes] = deque()
        self.wake = asyncio.Event()
        self.closed = False
        # Live numbered lines flow only once the attach resent the backlog:
        # before it, they are part of that backlog.
        self.attached = False


class Runtime:
    def __init__(self, generation: str, state_dir: Path, daemon_socket: Path) -> None:
        self.generation = generation
        self.state_dir = Path(state_dir)
        self.daemon_socket = Path(daemon_socket)
        self.sock_path = runtime_socket(self.state_dir, generation)
        self.home = runtime_home(self.state_dir, generation)
        # Identity of THIS process: a respawned runtime of the same generation
        # starts numbering again, so the daemon's watermark must not apply.
        self.rid = uuid.uuid4().hex
        self.slots: dict[str, _Slot] = {}
        self._n = 0
        self._unacked: deque[tuple[int, bytes]] = deque()
        self._unacked_bytes = 0
        self._conn: _Conn | None = None
        self._last_st: dict[str, str] = {}
        self._retiring = False
        self._stop = asyncio.Event()
        self._daemon_seen = time.monotonic()
        self._socket_ino: int | None = None
        self._tasks: set[asyncio.Task] = set()

    # ── Hosted sessions ──────────────────────────────────────────────────────
    @property
    def sessions(self) -> dict[str, Any]:
        return {sid: slot.session for sid, slot in self.slots.items() if slot.session is not None}

    def _emitter(self, slot: _Slot):
        def emit(payload: dict[str, Any]) -> None:
            if slot.released:
                return
            if isinstance(payload, dict):
                slot.track(payload)
            self._send_numbered({"ev": payload})
            name = payload.get("event") if isinstance(payload, dict) else None
            if name not in _NO_STATE_EVENTS and slot.session is not None:
                self.push_state(slot.sid)
        return emit

    def _state_saver(self, slot: _Slot):
        def on_state_change() -> None:
            if not slot.released and slot.session is not None:
                self.push_state(slot.sid)
        return on_state_change

    def push_state(self, sid: str, *, force: bool = False) -> None:
        slot = self.slots.get(sid)
        s = slot.session if slot is not None else None
        if s is None or slot.released:
            return
        try:
            x = session_ops.session_extras(s)
            x["blocker"] = slot.blocker(recent=False)
            x["bg"] = len(slot.bg)
            snap = {"sid": sid, "info": s.to_info(), "persist": s.to_persist(), "x": x}
            key = json.dumps(snap, sort_keys=True, default=str)
        except Exception:
            traceback.print_exc(file=sys.stderr)
            return
        if not force and self._last_st.get(sid) == key:
            return
        self._last_st[sid] = key
        self._send_numbered({"st": snap})

    # ── Outgoing lines ───────────────────────────────────────────────────────
    def _send_numbered(self, obj: dict[str, Any]) -> None:
        self._n += 1
        obj["n"] = self._n
        try:
            line = encode(obj)
        except Exception:
            traceback.print_exc(file=sys.stderr)
            return
        self._unacked.append((self._n, line))
        self._unacked_bytes += len(line)
        while self._unacked_bytes > UNACKED_MAX_BYTES and len(self._unacked) > 1:
            n, old = self._unacked.popleft()
            self._unacked_bytes -= len(old)
            print(f"[runtime {self.generation}] daemon away too long: dropped line {n}",
                  file=sys.stderr, flush=True)
        conn = self._conn
        if conn is not None and conn.attached and not conn.closed:
            conn.queue.append(line)
            conn.wake.set()

    def _respond(self, conn: _Conn, req_id: Any, *, result: Any = None,
                 error: tuple[int, str] | None = None) -> None:
        if conn.closed or conn is not self._conn:
            return  # its daemon is gone; the next one never asked
        msg: dict[str, Any] = {"res": req_id}
        if error is not None:
            msg["error"] = {"code": error[0], "message": error[1]}
        else:
            msg["result"] = result
        try:
            conn.queue.append(encode(msg))
        except Exception as e:
            conn.queue.append(encode({"res": req_id, "error": {
                "code": ERR_INTERNAL, "message": f"unencodable result: {e}"}}))
        conn.wake.set()

    def _ack(self, n: int) -> None:
        while self._unacked and self._unacked[0][0] <= n:
            _, line = self._unacked.popleft()
            self._unacked_bytes -= len(line)

    async def _writer_loop(self, conn: _Conn) -> None:
        try:
            while not conn.closed:
                if not conn.queue:
                    conn.wake.clear()
                    await conn.wake.wait()
                    continue
                batch = []
                size = 0
                while conn.queue and size < 1 << 20:
                    line = conn.queue.popleft()
                    batch.append(line)
                    size += len(line)
                conn.writer.write(b"".join(batch))
                await conn.writer.drain()
        except (ConnectionError, OSError, asyncio.CancelledError):
            pass
        finally:
            conn.closed = True

    # ── Daemon connection ────────────────────────────────────────────────────
    async def _on_daemon(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        conn = _Conn(writer)
        old = self._conn
        if old is not None:
            # One daemon at a time: a newcomer is a restarted daemon.
            old.closed = True
            old.wake.set()
            try:
                old.writer.close()
            except Exception:
                pass
        self._conn = conn
        self._daemon_seen = time.monotonic()
        writer_task = asyncio.create_task(self._writer_loop(conn))
        try:
            while not conn.closed:
                try:
                    raw = await reader.readline()
                except (ValueError, asyncio.LimitOverrunError):
                    break
                if not raw:
                    break
                try:
                    msg = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if "ack" in msg:
                    if isinstance(msg["ack"], int):
                        self._ack(msg["ack"])
                    continue
                if msg.get("op") == "attach":
                    self._attach(conn, msg)
                    continue
                task = asyncio.create_task(self._handle_op(conn, msg))
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)
        finally:
            conn.closed = True
            conn.wake.set()
            if self._conn is conn:
                self._conn = None
                self._daemon_seen = time.monotonic()
            writer_task.cancel()
            try:
                writer.close()
            except Exception:
                pass
            self._check_exit()

    def _attach(self, conn: _Conn, msg: dict[str, Any]) -> None:
        """Synchronous on purpose: the hello, the resent backlog and a fresh
        state for every session are queued before any later line."""
        acked = msg.get("acked") if isinstance(msg.get("acked"), dict) else {}
        after = acked.get("n") if acked.get("rid") == self.rid and isinstance(acked.get("n"), int) else 0
        self._ack(after)
        self._respond(conn, msg.get("id"), result=self.hello())
        for n, line in self._unacked:
            if n > after:
                conn.queue.append(line)
        conn.attached = True
        for sid in list(self.slots):
            self.push_state(sid, force=True)
        conn.queue.append(encode({"synced": True}))
        conn.wake.set()

    def hello(self) -> dict[str, Any]:
        stat = proc_stat(os.getpid())
        return {
            "proto": PROTO,
            "generation": self.generation,
            "rid": self.rid,
            "pid": os.getpid(),
            "start": stat[3] if stat else None,
            "argv0": str(Path(sys.argv[0]).resolve()) if sys.argv and sys.argv[0] else None,
            "sessions": sorted(self.slots),
            "retiring": self._retiring,
        }

    # ── Operations ───────────────────────────────────────────────────────────
    async def _handle_op(self, conn: _Conn, msg: dict[str, Any]) -> None:
        req_id = msg.get("id")
        op = msg.get("op")
        try:
            if op == "call":
                result = await self._op_call(msg)
            elif op == "create":
                result = await self._op_create(msg)
            elif op == "release":
                result = await self._op_release(msg)
            elif op == "accounts_changed":
                result = self._op_accounts_changed(msg)
            elif op == "retire":
                self._retiring = True
                self._check_exit()
                result = {"ok": True, "sessions": len(self.slots)}
            elif op == "ping":
                result = {"pong": True, "sessions": len(self.slots)}
            else:
                raise RpcError(ERR_METHOD_NOT_FOUND, f"unknown runtime op: {op}")
            self._respond(conn, req_id, result=result)
        except RpcError as e:
            self._respond(conn, req_id, error=(e.code, e.message))
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            self._respond(conn, req_id, error=(ERR_INTERNAL, f"{type(e).__name__}: {e}"))

    def _require(self, sid: Any) -> Any:
        slot = self.slots.get(sid) if isinstance(sid, str) else None
        if slot is None or slot.session is None:
            raise RpcError(ERR_SESSION_NOT_FOUND, f"session {sid} not found")
        return slot.session

    async def _op_call(self, msg: dict[str, Any]) -> Any:
        sid = msg.get("sid")
        s = self._require(sid)
        method = msg.get("method")
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        if method == "send_input":
            self.slots[sid].last_input = time.monotonic()
        try:
            return await session_ops.run(str(method), params, s, _Host(self, sid))
        finally:
            self.push_state(sid)

    async def _op_create(self, msg: dict[str, Any]) -> Any:
        row = msg.get("row")
        if not isinstance(row, dict) or not isinstance(row.get("session_id"), str) \
                or not isinstance(row.get("cwd"), str):
            raise RpcError(ERR_INTERNAL, "create: bad row")
        sid = row["session_id"]
        if sid in self.slots:
            # Idempotent: a retried create must never build a second object.
            self.push_state(sid, force=True)
            return {"ok": True, "status": self.slots[sid].session.status, "existing": True}
        slot = _Slot(sid)
        s = session_ops.build_session(
            row, emit=self._emitter(slot), on_state_change=self._state_saver(slot),
            socket_path=self.daemon_socket)
        slot.session = s
        self.slots[sid] = slot
        if msg.get("start"):
            self.push_state(sid, force=True)
            try:
                await s.start()
            except Exception as e:
                # Registered either way: the daemon must never host it twice.
                traceback.print_exc(file=sys.stderr)
                s.status = "error"
                self._emitter(slot)({"event": "error", "session_id": sid,
                                     "msg": f"start failed: {e}", "fatal": True})
                self._emitter(slot)({"event": "status", "session_id": sid, "status": "error"})
        else:
            status = row.get("status")
            s.status = status if status in ("sleeping", "error") else "sleeping"
            self.push_state(sid, force=True)
        return {"ok": True, "status": s.status}

    async def _op_release(self, msg: dict[str, Any]) -> Any:
        sid = msg.get("sid")
        s = self._require(sid)
        if msg.get("only_if_idle"):
            why = self.slots[sid].blocker()
            if why:
                return {"ok": False, "busy": True, "reason": why}
        mark = msg.get("stop")
        try:
            if mark in ("sleeping", "killed"):
                await s.stop(mark=mark)
            elif session_ops.live_task(s):
                await s.stop(mark="sleeping")
        except Exception:
            # Released anyway: a session the daemon drops must not live on here.
            traceback.print_exc(file=sys.stderr)
            task = getattr(s, "_main_task", None)
            if task is not None and not task.done():
                task.cancel()
        persist = s.to_persist()
        info = s.to_info()
        slot = self.slots.pop(sid)
        slot.released = True
        self._last_st.pop(sid, None)
        self._check_exit()
        return {"ok": True, "persist": persist, "info": info}

    def _op_accounts_changed(self, msg: dict[str, Any]) -> Any:
        """The daemon applied hub accounts (§14.115): drop what this process
        cached about them so the next read comes from disk."""
        ids = {str(i) for i in (msg.get("ids") or []) if isinstance(i, str)}
        dropped = 0
        try:
            from .account_profiles import _cache as profile_cache
            for key in [k for k in profile_cache if k[1] in ids]:
                profile_cache.pop(key, None)
                dropped += 1
        except Exception:
            pass
        try:
            from . import global_accounts
            with global_accounts._lock:
                for key in [k for k in global_accounts._meta if k[1] in ids]:
                    global_accounts._meta.pop(key, None)
                    dropped += 1
        except Exception:
            pass
        return {"ok": True, "dropped": dropped}

    # ── Lifetime ─────────────────────────────────────────────────────────────
    def _check_exit(self) -> None:
        if self.slots:
            return
        if self._retiring:
            self._stop.set()

    async def _daemon_hosts_us(self) -> bool | None:
        """Ask the live daemon whether it runs runtimes. None = no answer."""
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(str(self.daemon_socket), limit=READER_LIMIT), 3.0)
        except (OSError, asyncio.TimeoutError):
            return None
        try:
            writer.write(b'{"id":0,"method":"hello"}\n')
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), 10.0)
            result = json.loads(line.decode("utf-8", "replace")).get("result")
            return isinstance(result, dict) and "hot_update" in result
        except Exception:
            return None
        finally:
            writer.close()

    async def _watchdog(self) -> None:
        while not self._stop.is_set():
            await asyncio.sleep(ORPHAN_PROBE_S)
            if self._conn is not None:
                continue
            away = time.monotonic() - self._daemon_seen
            if self.slots and away > ORPHAN_PROBE_S:
                # A daemon that answers but does not attach us never will: an
                # older agent (a rollback, which knows no runtime) or one that
                # gave our sessions up. Our sessions must not run beside the
                # copies it may start: stop them.
                hosts = await self._daemon_hosts_us()
                if hosts is not None and self._conn is None:
                    why = "the daemon does not run session runtimes" if not hosts \
                        else "the live daemon did not adopt this runtime"
                    print(f"[runtime {self.generation}] {why}: stopping "
                          f"{len(self.slots)} session(s)", file=sys.stderr, flush=True)
                    self._stop.set()
                continue
            if not self.slots and away > ORPHAN_IDLE_S:
                print(f"[runtime {self.generation}] no session and no daemon: exiting",
                      file=sys.stderr, flush=True)
                self._stop.set()

    async def _socket_owned(self) -> bool:
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(str(self.sock_path)), timeout=3.0)
        except (OSError, asyncio.TimeoutError):
            return False
        writer.close()
        return True

    async def serve(self) -> int:
        rdir = runtimes_dir(self.state_dir)
        rdir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(rdir, 0o700)
        except OSError:
            pass
        if self.sock_path.exists():
            if await self._socket_owned():
                print(f"[runtime {self.generation}] already running: exiting",
                      file=sys.stderr, flush=True)
                return EXIT_ALREADY_RUNNING
            try:
                self.sock_path.unlink()
            except OSError:
                pass
        self.proc_home = process_home(self.home, os.getpid())
        self.proc_home.mkdir(parents=True, exist_ok=True)
        stat = proc_stat(os.getpid())
        try:
            (self.proc_home / "pid.json").write_text(json.dumps({
                "pid": os.getpid(), "start": stat[3] if stat else None, "rid": self.rid,
            }))
        except OSError:
            pass
        ledger_task = asyncio.create_task(ChildLedger(self.proc_home).loop())
        server = await asyncio.start_unix_server(
            self._on_daemon, path=str(self.sock_path), limit=READER_LIMIT)
        try:
            os.chmod(self.sock_path, 0o600)
            self._socket_ino = os.stat(self.sock_path).st_ino
        except OSError:
            pass
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self._stop.set)
            except NotImplementedError:
                pass
        try:
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
        except (OSError, ValueError):
            pass
        watchdog = asyncio.create_task(self._watchdog())
        print(f"[runtime {self.generation}] pid {os.getpid()} listening on {self.sock_path}",
              file=sys.stderr, flush=True)
        try:
            await self._stop.wait()
        finally:
            watchdog.cancel()
            server.close()
            try:
                if os.stat(self.sock_path).st_ino == self._socket_ino:
                    self.sock_path.unlink()
            except OSError:
                pass
            # Killed with sessions (never a retirement, which waits for none):
            # stop their CLIs without telling anyone — a daemon that sees this
            # runtime vanish restores the live ones itself.
            slots = list(self.slots.values())
            for slot in slots:
                slot.released = True
            if slots:
                await asyncio.gather(*(
                    asyncio.wait_for(slot.session.stop(mark="sleeping"), STOP_GRACE_S)
                    for slot in slots if slot.session is not None
                ), return_exceptions=True)
            ledger_task.cancel()
            try:
                (self.proc_home / "pid.json").unlink()
            except OSError:
                pass
        print(f"[runtime {self.generation}] bye", file=sys.stderr, flush=True)
        return 0


def runtime_main(generation: str, state_dir: Path, daemon_socket: Path) -> int:
    _preload()
    rt = Runtime(generation, state_dir, daemon_socket)
    try:
        return asyncio.run(rt.serve())
    except KeyboardInterrupt:
        return 0
