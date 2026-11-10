"""Daemon side of the session runtimes (§14.117): proxies and connections.

`server.py` keeps one entry per session in `self.sessions`. For a session
hosted by a runtime process that entry is a `RemoteSession`: it mirrors the
facts the daemon reads (status, handle, kind… pushed by the runtime as `st`
lines) and forwards every operation to its runtime. Code that only reads
attributes or calls `send_input` / `interrupt` (peer routing, subscribe,
hello, state.json) works on it unchanged.

A `RuntimeConn` is one connection to one runtime process. It numbers nothing
itself: it processes the runtime's numbered lines in order, skips the ones it
already logged, and acks them after a DURABLE watermark write
(`runtimes/<gen>/acked.json`) — so a daemon restart neither loses nor doubles
an event (runtime.py, "Wire protocol").
"""
from __future__ import annotations

import asyncio
import hashlib
import itertools
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from .protocol import ERR_SESSION_DEAD, RpcError
from .runtime import READER_LIMIT, encode, runtime_home, runtime_socket, runtimes_dir

LIVE_STATUSES = ("starting", "active", "thinking")
ACK_DELAY_S = 0.05
ATTACH_TIMEOUT_S = 60.0


def compute_generation(pyz_sha: str, versions: dict[str, Any]) -> str:
    """The code a runtime runs: frozen zipapp + provider SDK versions."""
    override = os.environ.get("CHARON_RUNTIME_GENERATION")
    if override:
        safe = "".join(c for c in override if c.isalnum() or c in "-_")[:32]
        if safe:
            return safe
    raw = json.dumps([pyz_sha, versions], sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def _sha12(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def freeze_pyz(state_dir: Path) -> tuple[Path | None, str]:
    """Copy the running zipapp to `runtimes/<sha>.pyz` (never overwritten by
    an update) and return it with its sha. Dev mode (no pyz) → (None, 'dev')."""
    try:
        src = Path(sys.argv[0]).resolve()
    except Exception:
        return None, "dev"
    if not (src.is_file() and src.suffix == ".pyz"):
        return None, "dev"
    rdir = runtimes_dir(state_dir)
    rdir.mkdir(parents=True, exist_ok=True)
    data = src.read_bytes()
    sha = hashlib.sha256(data).hexdigest()[:12]
    dst = rdir / f"{sha}.pyz"
    try:
        if dst.is_file() and _sha12(dst) == sha:
            return dst, sha
    except OSError:
        pass
    tmp = rdir / f".{sha}.pyz.tmp{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    os.replace(tmp, dst)
    return dst, sha


class RemoteSession:
    """The daemon's view of a session living in a runtime process."""

    def __init__(self, server: Any, session_id: str, runtime: "RuntimeConn") -> None:
        self._server = server
        self.session_id = session_id
        self.runtime: RuntimeConn | None = runtime
        self._info: dict[str, Any] = {}
        self._persist: dict[str, Any] = {}
        self._x: dict[str, Any] = {}
        # Daemon-only state (never crosses to the runtime).
        self._connection_changing = False
        self._throughput_metrics: Any = None
        self._migration: asyncio.Future | None = None
        # A LIVE move in progress: its stop/start are hidden (status reads
        # "active", the matching status events are dropped).
        self._masked = False
        self.inflight_ops = 0
        self.last_input_at = 0.0

    def update(self, snap: dict[str, Any]) -> None:
        if isinstance(snap.get("info"), dict):
            self._info = snap["info"]
        if isinstance(snap.get("persist"), dict):
            self._persist = snap["persist"]
        if isinstance(snap.get("x"), dict):
            self._x = snap["x"]

    def _get(self, key: str, default: Any = None) -> Any:
        if key in self._info:
            return self._info[key]
        return self._persist.get(key, default)

    # ── Mirrored facts ───────────────────────────────────────────────────────
    @property
    def real_status(self) -> str:
        return str(self._info.get("status") or self._persist.get("status") or "error")

    @property
    def status(self) -> str:
        # A hot-update move stops the session in one runtime and resumes it in
        # another: to everyone else it stays the idle session it was.
        st = self.real_status
        if self._masked and st in ("sleeping", "starting", "active"):
            return "active"
        return st

    @property
    def kind(self) -> str:
        return str(self._get("kind") or "claude")

    @property
    def handle(self) -> Any:
        return self._get("handle")

    @property
    def name(self) -> Any:
        return self._get("name")

    @property
    def cwd(self) -> Any:
        return self._get("cwd")

    @property
    def parent_session_id(self) -> Any:
        return self._get("parent_session_id")

    @property
    def parent_handle(self) -> Any:
        return self._get("parent_handle")

    @property
    def claude_session_id(self) -> Any:
        return self._get("claude_session_id")

    @property
    def cli_name(self) -> Any:
        return self._persist.get("cli_name") or self._get("handle")

    @property
    def permission_mode(self) -> Any:
        return self._get("permission_mode")

    @property
    def model(self) -> Any:
        return self._get("model")

    @property
    def fallback_model(self) -> Any:
        return self._get("fallback_model")

    @property
    def effort(self) -> Any:
        return self._get("effort")

    @property
    def compacting(self) -> bool:
        return self._x.get("compacting") is True

    @property
    def session_config(self) -> dict[str, Any]:
        value = self._persist.get("provider_config")
        return value if isinstance(value, dict) else {}

    @property
    def generation(self) -> str | None:
        return self.runtime.gen if self.runtime is not None else None

    @property
    def outdated(self) -> bool:
        return self.runtime is not None and self.runtime.gen != self._server.generation

    def to_info(self) -> dict[str, Any]:
        info = dict(self._info)
        info["status"] = self.status
        info["runtime_generation"] = self.generation
        info["outdated"] = self.outdated
        return info

    def to_persist(self) -> dict[str, Any]:
        row = dict(self._persist)
        if self._masked and row.get("status") == "sleeping":
            row["status"] = "active"
        # state.json: a session a runtime runs is written ASLEEP, its real
        # state in `runtime_status`. This daemon restores from the latter; an
        # OLDER daemon (a rollback) knows only `status`, so it never starts a
        # second writer beside a runtime still running the session.
        status = row.get("status")
        if status not in ("sleeping", "killed"):
            row["runtime_status"] = status
            row["status"] = "sleeping"
        return row

    # ── Calls the daemon makes on any session ────────────────────────────────
    async def send_input(self, content: str, codex_inputs: Any = None, *,
                         peer_request_id: str | None = None) -> None:
        params: dict[str, Any] = {"content": content}
        if codex_inputs is not None:
            params["codex_inputs"] = codex_inputs
        if peer_request_id:
            params["peer_request_id"] = peer_request_id
        await self._server._session_op(self, "send_input", params)

    async def interrupt(self) -> None:
        await self._server._session_op(self, "interrupt", {})

    async def stop(self, *, mark: str = "sleeping") -> None:
        await self._server._session_op(
            self, "kill_session" if mark == "killed" else "sleep_session", {})

    async def wait_migration(self, timeout: float = 120.0) -> None:
        fut = self._migration
        if fut is not None:
            try:
                await asyncio.wait_for(asyncio.shield(fut), timeout)
            except asyncio.TimeoutError:
                pass


class RuntimeConn:
    """One connection to one runtime process."""

    def __init__(self, server: Any, generation: str, state_dir: Path) -> None:
        self.server = server
        self.gen = generation
        self.sock_path = runtime_socket(state_dir, generation)
        self.home = runtime_home(state_dir, generation)
        self.hello: dict[str, Any] = {}
        self.connected = False
        self.stopping = False      # daemon shutdown: never recovered
        self.retired = False       # asked to exit once empty
        self.proc: Any = None      # Popen when this daemon spawned it
        # Set while the daemon decides whether a dropped runtime is alive:
        # nobody may open a second connection to its generation meanwhile.
        self.recovering = False
        self.recovered = asyncio.Event()
        self.recovered.set()
        # Until `synced`, `st` lines are the resent backlog: only sessions the
        # runtime still hosts (its hello) may (re)bind to it.
        self._backlog_sids: set[str] | None = None
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._write_lock = asyncio.Lock()
        self._pending: dict[int, asyncio.Future] = {}
        self._ids = itertools.count(1)
        self._attach_id: int | None = None
        self._synced: asyncio.Event | None = None
        self._processed = 0
        self._expected_rid: str | None = None
        self._ack_handle: asyncio.TimerHandle | None = None
        self._read_task: asyncio.Task | None = None

    @property
    def pid(self) -> int | None:
        pid = self.hello.get("pid")
        return pid if isinstance(pid, int) else None

    # ── Durable watermark ────────────────────────────────────────────────────
    def _acked_path(self) -> Path:
        return self.home / "acked.json"

    def _load_acked(self) -> dict[str, Any]:
        try:
            raw = json.loads(self._acked_path().read_text())
            if isinstance(raw, dict) and isinstance(raw.get("n"), int):
                return {"rid": raw.get("rid"), "n": raw["n"]}
        except (OSError, ValueError):
            pass
        return {"rid": None, "n": 0}

    def _write_acked(self) -> None:
        rid = self.hello.get("rid")
        if not rid:
            return
        path = self._acked_path()
        tmp = path.with_name(f"acked.json.tmp{os.getpid()}")
        try:
            tmp.write_text(json.dumps({"rid": rid, "n": self._processed}))
            os.replace(tmp, path)
        except OSError as e:
            print(f"[runtime {self.gen}] watermark write failed: {e}", file=sys.stderr, flush=True)

    def _schedule_ack(self) -> None:
        if self._ack_handle is None:
            self._ack_handle = asyncio.get_running_loop().call_later(ACK_DELAY_S, self._flush_ack)

    def _flush_ack(self) -> None:
        self._ack_handle = None
        if not self.connected:
            return
        self._write_acked()
        self._send_nowait({"ack": self._processed})

    # ── Connection ───────────────────────────────────────────────────────────
    async def connect(self, timeout: float = 5.0) -> None:
        """Connect + attach. Returns once the runtime's resent backlog and a
        fresh state of every hosted session have been PROCESSED, so the
        caller knows exactly which sessions live there."""
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(str(self.sock_path), limit=READER_LIMIT),
            timeout=timeout)
        self._reader, self._writer = reader, writer
        acked = self._load_acked()
        self._expected_rid = acked.get("rid")
        self._processed = acked["n"]
        self._backlog_sids = None
        self._synced = asyncio.Event()
        self._attach_id = next(self._ids)
        fut = asyncio.get_running_loop().create_future()
        self._pending[self._attach_id] = fut
        self._read_task = asyncio.create_task(self._read_loop(reader))
        try:
            self._send_nowait({"id": self._attach_id, "op": "attach", "acked": acked})
            self.hello = await asyncio.wait_for(fut, ATTACH_TIMEOUT_S)
            self.connected = True
            await asyncio.wait_for(self._synced.wait(), ATTACH_TIMEOUT_S)
        except BaseException:
            self.connected = False
            self._read_task.cancel()
            try:
                writer.close()
            except Exception:
                pass
            raise

    def _send_nowait(self, obj: dict[str, Any]) -> None:
        writer = self._writer
        if writer is None:
            return
        try:
            writer.write(encode(obj))
        except Exception:
            pass

    async def request(self, op: str, **fields: Any) -> Any:
        if not self.connected or self._writer is None:
            raise RpcError(ERR_SESSION_DEAD, f"session runtime {self.gen} is not connected")
        req_id = next(self._ids)
        fut = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        try:
            async with self._write_lock:
                self._writer.write(encode({"id": req_id, "op": op, **fields}))
                await self._writer.drain()
        except Exception as e:
            self._pending.pop(req_id, None)
            raise RpcError(ERR_SESSION_DEAD, f"session runtime {self.gen}: {e}")
        return await fut

    async def call(self, sid: str, method: str, params: dict[str, Any]) -> Any:
        return await self.request("call", sid=sid, method=method, params=params)

    async def _read_loop(self, reader: asyncio.StreamReader) -> None:
        try:
            while True:
                raw = await reader.readline()
                if not raw:
                    break
                try:
                    msg = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if "res" in msg:
                    self._resolve(msg)
                    # Let the waiting handler forward this answer BEFORE any
                    # later line: the runtime wrote them in that order, and an
                    # event overtaking an answer (`active` before a resume's
                    # `starting`) leaves the hub with the older truth.
                    await asyncio.sleep(0)
                elif "n" in msg:
                    n = msg["n"]
                    if not isinstance(n, int) or n <= self._processed:
                        continue  # resent line this daemon already logged
                    try:
                        if "ev" in msg:
                            self.server._runtime_event(self, msg["ev"])
                        elif "st" in msg:
                            st = msg["st"]
                            backlog = self._backlog_sids
                            # A resent state of a session released since (moved,
                            # killed) must not steal it back.
                            if backlog is None or (isinstance(st, dict) and st.get("sid") in backlog):
                                self.server._runtime_state(self, st)
                    except Exception:
                        traceback.print_exc(file=sys.stderr)
                    self._processed = n
                    self._schedule_ack()
                elif msg.get("synced") and self._synced is not None:
                    self._backlog_sids = None
                    self._synced.set()
        except (ConnectionError, OSError, ValueError, asyncio.IncompleteReadError):
            pass
        except asyncio.CancelledError:
            raise
        finally:
            was_connected = self.connected
            # What was logged stays logged: a re-attach must not resend it.
            if self._ack_handle is not None:
                self._ack_handle.cancel()
                self._ack_handle = None
            if was_connected and not self.stopping:
                self._write_acked()
            self.connected = False
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(RpcError(
                        ERR_SESSION_DEAD, f"session runtime {self.gen} disconnected"))
                    fut.exception()
            self._pending.clear()
            if was_connected and not self.stopping:
                asyncio.get_running_loop().create_task(self.server._runtime_lost(self))

    def _resolve(self, msg: dict[str, Any]) -> None:
        fut = self._pending.pop(msg.get("res"), None)
        if msg.get("res") == self._attach_id and isinstance(msg.get("result"), dict):
            # Applied HERE, before the next line: a different process of the
            # same generation numbers from 1 again.
            if msg["result"].get("rid") != self._expected_rid:
                self._processed = 0
            self.hello = msg["result"]
            hosted = msg["result"].get("sessions")
            self._backlog_sids = {x for x in hosted if isinstance(x, str)} \
                if isinstance(hosted, list) else set()
            self.connected = True
        if fut is None or fut.done():
            return
        err = msg.get("error")
        if isinstance(err, dict):
            fut.set_exception(RpcError(int(err.get("code") or -32603), str(err.get("message") or "")))
            fut.exception()
        else:
            fut.set_result(msg.get("result"))

    def close_for_shutdown(self) -> None:
        """Daemon exit: stop reading (whatever is unread is resent to the next
        daemon), persist the watermark, close. The runtime keeps running."""
        self.stopping = True
        if self._read_task is not None:
            self._read_task.cancel()
        if self._ack_handle is not None:
            self._ack_handle.cancel()
            self._ack_handle = None
        if self.connected:
            self._write_acked()
        self.connected = False
        if self._writer is not None:
            try:
                self._writer.close()
            except Exception:
                pass


def proc_alive(pid: Any, start: Any) -> bool:
    from .child_ledger import proc_stat
    if not isinstance(pid, int):
        return False
    stat = proc_stat(pid)
    if stat is None or stat[0] == "Z":
        return False
    return start is None or stat[3] == start


def read_pid_file(proc_dir: Path) -> dict[str, Any]:
    try:
        raw = json.loads((proc_dir / "pid.json").read_text())
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def runtime_processes(home: Path) -> list[tuple[Path, dict[str, Any]]]:
    """Every process directory (`p<pid>/`) a generation's runtimes left."""
    out: list[tuple[Path, dict[str, Any]]] = []
    try:
        entries = list(Path(home).iterdir())
    except OSError:
        return out
    for entry in entries:
        if entry.is_dir() and entry.name.startswith("p") and entry.name[1:].isdigit():
            info = read_pid_file(entry)
            info.setdefault("pid", int(entry.name[1:]))
            out.append((entry, info))
    return out


def monotonic() -> float:
    return time.monotonic()
