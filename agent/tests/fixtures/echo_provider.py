"""A fake provider session for the daemon↔runtime integration test (§14.117).

Registered as kind "echo" only when CHARON_TEST_PROVIDER points at this file.
It honours the session contract `server.py` / `session_ops.py` drive, without
any SDK: input `slow:N` streams N numbered chunks 0.1 s apart (a turn long
enough to restart the daemon in the middle of), `bg` reports a background task
that never ends, anything else answers at once. Every answer names the PID of
the process running it, so the test can tell which runtime served a turn.
"""
from __future__ import annotations

import asyncio
import os
from typing import Any


class EchoSession:
    VALID_EFFORTS = ("low", "high")

    def __init__(self, session_id: str, *, cwd: str, name: str | None, permission_mode: str,
                 claude_session_id: str | None, emit: Any, on_state_change: Any,
                 model: str | None = None, fallback_model: str | None = None,
                 effort: str | None = None, handle: str | None = None,
                 peer_mcp: Any = None, session_config: Any = None) -> None:
        self.session_id = session_id
        self.kind = "echo"
        self.cwd = cwd
        self.name = name
        self.handle = handle
        self.permission_mode = permission_mode
        self.claude_session_id = claude_session_id
        self.model = model
        self.fallback_model = fallback_model
        self.effort = effort
        self.session_config = dict(session_config or {})
        self._emit_cb = emit
        self._on_state_change = on_state_change
        self.status = "starting"
        self.compacting = False
        self._client: Any = None
        self._main_task: asyncio.Task | None = None
        self._stdin_queue: asyncio.Queue = asyncio.Queue()
        self._stopped = asyncio.Event()
        self._ready_evt = asyncio.Event()
        self._session_id_emitted = False
        self._connection_changing = False
        self._pending_perms: dict[str, asyncio.Future] = {}
        self._bg = 0

    def _emit(self, event: str, **fields: Any) -> None:
        self._emit_cb({"event": event, "session_id": self.session_id, **fields})

    async def _save_state(self) -> None:
        res = self._on_state_change()
        if asyncio.iscoroutine(res):
            await res

    async def start(self) -> None:
        if self._main_task is not None:
            return
        self._main_task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        if not self.claude_session_id:
            self.claude_session_id = f"echo-{self.session_id[:8]}"
            self._emit("session_id", claude_session_id=self.claude_session_id)
        self._client = object()
        self._emit("ready")
        self.status = "active"
        self._emit("status", status="active")
        await self._save_state()
        while True:
            item = await self._stdin_queue.get()
            if item is None:
                break
            text = item["content"]
            self.status = "thinking"
            self._emit("status", status="thinking")
            if text.startswith("slow:"):
                for i in range(int(text[5:])):
                    self._emit("assistant_text", text=f"[{i}]")
                    await asyncio.sleep(0.1)
            elif text == "bg":
                self._bg += 1
                self._emit("bg_task", kind="started", task_id=f"t{self._bg}")
            self._emit("assistant_text", text=f"pid={os.getpid()} echo={text}")
            self._emit("stop", reason="end_turn")
            self.status = "active"
            self._emit("status", status="active")
        self._client = None

    async def stop(self, *, mark: str = "sleeping") -> None:
        self.status = mark
        self._emit("status", status=mark)
        await self._stdin_queue.put(None)
        if self._main_task is not None:
            try:
                await asyncio.wait_for(self._main_task, 5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._main_task.cancel()
        self._main_task = None
        self._client = None
        self._stopped.set()
        await self._save_state()

    async def force_stop(self) -> None:
        await self.stop(mark="sleeping")

    async def send_input(self, content: str, *, peer_request_id: str | None = None) -> None:
        if self.status not in ("active", "thinking", "starting"):
            raise RuntimeError(f"session {self.session_id} not running (status={self.status})")
        await self._stdin_queue.put({"content": content})

    async def interrupt(self) -> None:
        return None

    async def set_permission_mode(self, mode: str) -> None:
        self.permission_mode = mode

    async def set_model(self, model: str | None, fallback_model: str | None = None) -> None:
        self.model = model

    async def set_effort(self, effort: str | None) -> None:
        self.effort = effort

    def respond_permission(self, *_: Any, **__: Any) -> bool:
        return False

    def respond_question(self, *_: Any) -> bool:
        return False

    def respond_exit_plan(self, *_: Any) -> bool:
        return False

    def to_info(self) -> dict[str, Any]:
        return {"kind": "echo", "session_id": self.session_id,
                "claude_session_id": self.claude_session_id, "cwd": self.cwd,
                "name": self.name, "handle": self.handle, "status": self.status,
                "model": self.model, "effort": self.effort,
                "permission_mode": self.permission_mode}

    def to_persist(self) -> dict[str, Any]:
        status = "active" if self.status in ("starting", "thinking") else self.status
        return {**self.to_info(), "status": status, "provider_config": self.session_config}
