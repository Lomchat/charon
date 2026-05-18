"""Daemon principal : Unix socket server + JSON-RPC dispatch + session mgmt."""
from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import time
import traceback
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Awaitable

from . import __version__
from . import protocol
from .protocol import (
    ERR_INTERNAL,
    ERR_INVALID_PARAMS,
    ERR_METHOD_NOT_FOUND,
    ERR_PARSE,
    ERR_SDK_UNAVAILABLE,
    ERR_SESSION_DEAD,
    ERR_SESSION_NOT_FOUND,
    RpcError,
)
from .session import AgentSession, SDK_AVAILABLE, SDK_IMPORT_ERROR
from .state import load_state, save_state


RING_SIZE = 300  # events bufferisés par session pour les late subscribers


class Server:
    def __init__(self, *, socket_path: Path, state_path: Path) -> None:
        self.socket_path = socket_path
        self.state_path = state_path
        self.sessions: dict[str, AgentSession] = {}
        self.rings: dict[str, deque[dict[str, Any]]] = {}
        # subscribers : session_id → set[Client]
        self.subscribers: dict[str, set[Client]] = {}
        self._state_lock = asyncio.Lock()
        self._save_pending = False
        self._stopping = False

    # ── Persistance ──────────────────────────────────────────────────────────
    async def _save_state_now(self) -> None:
        async with self._state_lock:
            try:
                sessions = [s.to_persist() for s in self.sessions.values()]
                # save_state est sync (fichier court). Pas besoin de threadpool.
                save_state(self.state_path, sessions)
            except Exception:
                traceback.print_exc(file=sys.stderr)

    def schedule_save(self) -> None:
        """Sauve async, débounced (pour pas écrire plusieurs fois en rafale)."""
        if self._save_pending:
            return
        self._save_pending = True
        asyncio.create_task(self._debounced_save())

    async def _debounced_save(self) -> None:
        try:
            await asyncio.sleep(0.2)
            await self._save_state_now()
        finally:
            self._save_pending = False

    # ── Sessions ─────────────────────────────────────────────────────────────
    def _emit(self, payload: dict[str, Any]) -> None:
        """Callback que les sessions appellent pour broadcast un event."""
        sid = payload.get("session_id")
        if isinstance(sid, str):
            ring = self.rings.setdefault(sid, deque(maxlen=RING_SIZE))
            ring.append(payload)
            for client in list(self.subscribers.get(sid, ())):
                client.send_json(payload)

    async def _create_session(
        self,
        *,
        session_id: str,
        cwd: str,
        name: str | None,
        permission_mode: str,
        claude_session_id: str | None,
    ) -> AgentSession:
        s = AgentSession(
            session_id,
            cwd=cwd,
            name=name,
            permission_mode=permission_mode,
            claude_session_id=claude_session_id,
            emit=self._emit,
            on_state_change=self._save_state_now,
        )
        self.sessions[session_id] = s
        self.rings.setdefault(session_id, deque(maxlen=RING_SIZE))
        await s.start()
        self.schedule_save()
        return s

    async def _restore_existing(self) -> None:
        """Au boot : recharge state.json et tente un resume pour chaque session.

        Sessions ignorées au restore :
          - status='killed'    → dead pour de bon
          - status='sleeping'  → pause explicite par l'utilisateur, reste pause
        Pour les sessions reprises mais sans claude_session_id (jamais sorties
        de 'starting' avant un crash), on les ajoute en mémoire en statut
        'sleeping' pour qu'elles soient visibles mais pas relancées toutes
        seules (la 1re query d'un user les avait jamais initialisées).
        """
        state = load_state(self.state_path)
        sessions = state.get("sessions", []) or []
        for row in sessions:
            try:
                sid = row.get("session_id")
                cwd = row.get("cwd")
                if not sid or not cwd:
                    continue
                status = row.get("status")
                if status in ("killed",):
                    continue
                if status == "sleeping":
                    # Charge en mémoire sans démarrer le SDK
                    self._register_sleeping(row)
                    continue
                print(f"[boot] restoring session {sid} (cwd={cwd})", file=sys.stderr, flush=True)
                await self._create_session(
                    session_id=sid,
                    cwd=cwd,
                    name=row.get("name"),
                    permission_mode=row.get("permission_mode") or "normal",
                    claude_session_id=row.get("claude_session_id"),
                )
            except Exception as e:
                print(f"[boot] restore failed: {e}", file=sys.stderr, flush=True)

    def _register_sleeping(self, row: dict[str, Any]) -> None:
        """Enregistre une session en mémoire en statut 'sleeping' sans la lancer.
        Utilisé au boot pour les sessions paused par l'utilisateur — list_sessions
        les voit, et un resume explicite démarrera le SDK."""
        s = AgentSession(
            row["session_id"],
            cwd=row["cwd"],
            name=row.get("name"),
            permission_mode=row.get("permission_mode") or "normal",
            claude_session_id=row.get("claude_session_id"),
            emit=self._emit,
            on_state_change=self._save_state_now,
        )
        s.status = "sleeping"
        self.sessions[row["session_id"]] = s
        self.rings.setdefault(row["session_id"], deque(maxlen=RING_SIZE))

    # ── JSON-RPC dispatch ───────────────────────────────────────────────────
    async def dispatch(self, method: str, params: dict[str, Any], client: "Client") -> Any:
        if method == "hello":
            return {
                "agent_version": __version__,
                "sdk_available": SDK_AVAILABLE,
                "sdk_error": SDK_IMPORT_ERROR,
                "pid": os.getpid(),
                "sessions": [s.to_info() for s in self.sessions.values()],
            }

        if method == "ping":
            return {"pong": True, "ts": time.time()}

        if method == "list_sessions":
            return [s.to_info() for s in self.sessions.values()]

        if method == "start_session":
            session_id = params.get("session_id") or uuid.uuid4().hex
            cwd = params.get("cwd")
            if not isinstance(cwd, str) or not cwd:
                raise RpcError(ERR_INVALID_PARAMS, "cwd required")
            if session_id in self.sessions:
                raise RpcError(ERR_INVALID_PARAMS, f"session {session_id} already exists")
            if not SDK_AVAILABLE:
                raise RpcError(ERR_SDK_UNAVAILABLE, f"SDK indisponible: {SDK_IMPORT_ERROR}")
            await self._create_session(
                session_id=session_id,
                cwd=cwd,
                name=params.get("name"),
                permission_mode=params.get("permission_mode") or "normal",
                claude_session_id=params.get("claude_session_id"),
            )
            return {"session_id": session_id}

        if method == "subscribe":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            replay = int(params.get("replay") or 0)
            if sid not in self.subscribers:
                self.subscribers[sid] = set()
            self.subscribers[sid].add(client)
            client.subscribed.add(sid)
            ring = self.rings.get(sid)
            sent = 0
            # Marqueur "début du replay" pour que le client puisse skip la
            # persistance DB sur des events qu'il a déjà vus avant son drop.
            if ring and replay > 0:
                items = list(ring)[-replay:]
                if items:
                    client.send_json({"event": "replay_begin", "session_id": sid, "count": len(items)})
                    for item in items:
                        client.send_json(item)
                        sent += 1
                    client.send_json({"event": "replay_end", "session_id": sid})
            # Émet un status pour que le client connaisse l'état courant
            client.send_json({"event": "status", "session_id": sid, "status": s.status})
            return {"ok": True, "replay_count": sent, "status": s.status}

        if method == "unsubscribe":
            sid = self._require_sid(params)
            self.subscribers.get(sid, set()).discard(client)
            client.subscribed.discard(sid)
            return {"ok": True}

        if method == "send_input":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            content = params.get("content")
            if not isinstance(content, str):
                raise RpcError(ERR_INVALID_PARAMS, "content required (str)")
            await s.send_input(content)
            return {"ok": True}

        if method == "interrupt":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            await s.interrupt()
            return {"ok": True}

        if method == "set_permission_mode":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            mode = params.get("mode") or "normal"
            await s.set_permission_mode(mode)
            return {"ok": True, "mode": s.permission_mode}

        if method == "respond_permission":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            perm_id = params.get("perm_id") or params.get("id")
            if not isinstance(perm_id, str):
                raise RpcError(ERR_INVALID_PARAMS, "perm_id required")
            s.respond_permission(perm_id, bool(params.get("allow")))
            return {"ok": True}

        if method == "respond_question":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            q_id = params.get("q_id") or params.get("id")
            if not isinstance(q_id, str):
                raise RpcError(ERR_INVALID_PARAMS, "q_id required")
            answers = params.get("answers")
            s.respond_question(q_id, answers if isinstance(answers, dict) else None)
            return {"ok": True}

        if method == "respond_exit_plan":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            q_id = params.get("q_id") or params.get("id")
            if not isinstance(q_id, str):
                raise RpcError(ERR_INVALID_PARAMS, "q_id required")
            decision = params.get("decision") or "reject"
            feedback = params.get("feedback") or ""
            s.respond_exit_plan(q_id, decision, feedback)
            return {"ok": True}

        if method == "resume_session":
            # Pour une session déjà en mémoire (typiquement après un reboot
            # agent où elle a été enregistrée 'sleeping'), redémarre le SDK.
            sid = self._require_sid(params)
            s = self._require_session(sid)
            if s.status in ("active", "thinking", "starting"):
                return {"ok": True, "status": s.status, "noop": True}
            # Reset l'état interne pour pouvoir restart proprement
            s.status = "starting"
            s._stopped.clear()
            s._ready_evt.clear()
            s._session_id_emitted = False
            s._main_task = None
            await s.start()
            self.schedule_save()
            return {"ok": True, "status": s.status}

        if method == "sleep_session":
            sid = self._require_sid(params)
            s = self._require_session(sid)
            await s.stop(mark="sleeping")
            self.schedule_save()
            return {"ok": True}

        if method == "kill_session":
            sid = self._require_sid(params)
            s = self.sessions.get(sid)
            if s is not None:
                await s.stop(mark="killed")
            self.sessions.pop(sid, None)
            self.rings.pop(sid, None)
            self.subscribers.pop(sid, None)
            self.schedule_save()
            return {"ok": True}

        raise RpcError(ERR_METHOD_NOT_FOUND, f"unknown method: {method}")

    def _require_sid(self, params: dict[str, Any]) -> str:
        sid = params.get("session_id")
        if not isinstance(sid, str) or not sid:
            raise RpcError(ERR_INVALID_PARAMS, "session_id required")
        return sid

    def _require_session(self, sid: str) -> AgentSession:
        s = self.sessions.get(sid)
        if s is None:
            raise RpcError(ERR_SESSION_NOT_FOUND, f"session {sid} not found")
        return s

    # ── Server lifecycle ─────────────────────────────────────────────────────
    async def serve(self) -> None:
        # Clean stale socket
        if self.socket_path.exists():
            try:
                self.socket_path.unlink()
            except OSError as e:
                print(f"[server] can't unlink stale socket: {e}", file=sys.stderr)

        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.socket_path.parent, 0o700)
        except OSError:
            pass

        await self._restore_existing()

        server = await asyncio.start_unix_server(
            self._handle_client, path=str(self.socket_path)
        )
        try:
            os.chmod(self.socket_path, 0o600)
        except OSError:
            pass

        print(
            f"[server] charon-agent {__version__} listening on {self.socket_path} "
            f"(sdk_ok={SDK_AVAILABLE}, sessions={len(self.sessions)})",
            file=sys.stderr,
            flush=True,
        )

        loop = asyncio.get_event_loop()
        stop_evt = asyncio.Event()

        def _signal_handler() -> None:
            print("[server] signal received, shutting down…", file=sys.stderr, flush=True)
            stop_evt.set()

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _signal_handler)
            except NotImplementedError:
                pass

        async with server:
            serve_task = asyncio.create_task(server.serve_forever())
            await stop_evt.wait()
            self._stopping = True
            serve_task.cancel()
            try:
                await serve_task
            except asyncio.CancelledError:
                pass
            # Save final state and stop sessions
            await self._save_state_now()
            for s in list(self.sessions.values()):
                try:
                    await s.stop(mark="sleeping")
                except Exception:
                    pass
            try:
                self.socket_path.unlink()
            except OSError:
                pass
        print("[server] bye", file=sys.stderr, flush=True)

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        client = Client(self, reader, writer)
        try:
            await client.run()
        finally:
            # Remove from all subscriptions
            for sid in list(client.subscribed):
                self.subscribers.get(sid, set()).discard(client)
            client.subscribed.clear()
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass


class Client:
    """Une connexion JSON-RPC ouverte (lecture/écriture multiplexée)."""

    def __init__(
        self,
        server: Server,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        self.server = server
        self.reader = reader
        self.writer = writer
        self.subscribed: set[str] = set()
        self._send_lock = asyncio.Lock()
        self._closed = False

    def send_json(self, obj: dict[str, Any]) -> None:
        """Schedule un envoi (non-bloquant, fire-and-forget)."""
        if self._closed:
            return
        asyncio.create_task(self._send_locked(obj))

    async def _send_locked(self, obj: dict[str, Any]) -> None:
        async with self._send_lock:
            if self._closed:
                return
            try:
                line = json.dumps(obj, default=str) + "\n"
                self.writer.write(line.encode())
                await self.writer.drain()
            except (ConnectionResetError, BrokenPipeError):
                self._closed = True
            except Exception:
                traceback.print_exc(file=sys.stderr)

    async def run(self) -> None:
        while not self._closed:
            try:
                line = await self.reader.readline()
            except (asyncio.IncompleteReadError, ConnectionResetError):
                break
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as e:
                await self._send_locked(
                    protocol.make_error(None, ERR_PARSE, f"json parse: {e}")
                )
                continue
            req_id = msg.get("id")
            method = msg.get("method")
            params = msg.get("params") or {}
            if not isinstance(method, str) or not isinstance(params, dict):
                await self._send_locked(
                    protocol.make_error(
                        req_id if isinstance(req_id, int) else None,
                        ERR_INVALID_REQUEST_,
                        "invalid request shape",
                    )
                )
                continue
            # Dispatch async
            asyncio.create_task(self._handle_one(req_id, method, params))

    async def _handle_one(self, req_id: Any, method: str, params: dict[str, Any]) -> None:
        try:
            result = await self.server.dispatch(method, params, self)
            if isinstance(req_id, int):
                await self._send_locked(protocol.make_response(req_id, result))
        except RpcError as e:
            await self._send_locked(protocol.make_error(req_id, e.code, e.message))
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            await self._send_locked(
                protocol.make_error(req_id, ERR_INTERNAL, f"{type(e).__name__}: {e}")
            )


# Local alias to avoid forward-ref pain in Client.run
ERR_INVALID_REQUEST_ = protocol.ERR_INVALID_REQUEST
