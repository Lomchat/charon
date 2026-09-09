"""Survive app-server schema drift on the Codex SDK's request/response path.

Charon deliberately runs the standalone Codex CLI AHEAD of the Python SDK
(``codex_session._external_codex_bin``): the SDK owns the process, router and
models, the separately-released CLI is the app-server. So the app-server can
answer with thread history the SDK's generated pydantic models cannot type yet
— a brand new item ``type``, or, as happened first, a new value in an existing
enum: CLI 0.153.4 reports ``subAgentActivity`` with ``kind:"completed"`` while
SDK 0.147.0 knows only started/interacted/interrupted.

Pydantic then fails the WHOLE response for that one item. ``thread/resume``
raised on any thread whose history contained one, resume does not retry a typed
error (§14.74, rightly — a blind retry is how a thread id gets destroyed), the
session landed in ``error``, and every later resume replayed the same failure
against the same immutable history. The thread became **permanently
unresumable while the CLI itself read it fine**.

Notifications already degrade — ``client.py § _coerce_notification`` falls back
to ``UnknownNotification`` — so only request/response validation was strict.
This module closes that asymmetry the same way, with two bounded pieces:

* :func:`install` drops the INDIVIDUAL history items the SDK cannot type,
  never the whole response. It walks only the documented thread-carrying
  shapes and only removes entries the SDK's own ``ThreadItem`` union rejects,
  so a missing response field, an unknown ``model`` or a protocol error still
  raises exactly as before. Charon renders its transcript from SQLite, so an
  item the SDK cannot represent is one the hub was never going to read.
* :class:`ResumedThread` is the response model for ``thread/resume`` itself.
  Charon reads exactly ONE field of it — the thread id it already knew — so
  validating thirty turns of history there is pure downside: drift in ANY of
  those fields, item or not, would brick the session again.

Stdlib only: no pydantic import, no SDK version coupling. ``request()`` calls
``response_model.model_validate(payload)`` and nothing else, so a duck-typed
class is a valid response model.
"""
from __future__ import annotations

import sys
from types import SimpleNamespace
from typing import Any, Iterator

#: Responses that can carry thread history. Everything else keeps the SDK's
#: exact behaviour — this is a repair for one shape, not a global relaxation.
THREAD_RESPONSE_METHODS = frozenset({
    "thread/start",
    "thread/resume",
    "thread/read",
    "thread/fork",
    "thread/rollback",
    "thread/list",
    "thread/search",
    "thread/compact",
})

#: Distinct drift signatures already reported, so one bad history item does not
#: print once per turn per resume. Bounded: drift has few shapes, and a leak
#: here would live as long as the daemon.
_reported: set[str] = set()
_REPORT_CAP = 64


def _report(item: dict, exc: Exception) -> None:
    detail = " ".join(str(exc).split())[:200]
    key = f"{item.get('type')}|{detail[:120]}"
    if key in _reported or len(_reported) >= _REPORT_CAP:
        return
    _reported.add(key)
    print(
        "codex: dropping a thread item this SDK cannot type "
        f"(type={item.get('type')!r}): {detail}",
        file=sys.stderr,
    )


def _threads(payload: dict) -> Iterator[dict]:
    """Yield every thread object a v2 response can carry."""
    thread = payload.get("thread")
    if isinstance(thread, dict):
        yield thread
    for key in ("threads", "results"):
        entries = payload.get(key)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            # thread/search wraps each hit, thread/list returns them bare.
            nested = entry.get("thread")
            yield nested if isinstance(nested, dict) else entry


def drop_untypeable_items(payload: dict, item_model: Any) -> int:
    """Remove the history items ``item_model`` rejects. Returns how many.

    Mutates ``payload`` in place — it is the freshly decoded JSON of a single
    response and has no other owner.
    """
    dropped = 0
    for thread in _threads(payload):
        turns = thread.get("turns")
        if not isinstance(turns, list):
            continue
        for turn in turns:
            if not isinstance(turn, dict):
                continue
            items = turn.get("items")
            if not isinstance(items, list):
                continue
            kept: list[Any] = []
            for item in items:
                if not isinstance(item, dict):
                    kept.append(item)
                    continue
                try:
                    item_model.model_validate(item)
                except Exception as exc:  # noqa: BLE001 - any rejection counts
                    dropped += 1
                    _report(item, exc)
                    continue
                kept.append(item)
            if len(kept) != len(items):
                turn["items"] = kept
    return dropped


class ResumedThread:
    """`thread/resume`, parsed for the one field Charon actually reads.

    ``_sdk_thread_start`` turns the response into ``AsyncThread(client,
    result.thread.id)`` and ``set_security`` discards it entirely, so the id is
    the whole contract. Anything stricter is a way for the app-server's history
    to make a live session unresumable (see the module docstring).
    """

    __slots__ = ("raw", "thread")

    def __init__(self, raw: Any) -> None:
        self.raw = raw if isinstance(raw, dict) else {}
        thread = self.raw.get("thread")
        thread_id = thread.get("id") if isinstance(thread, dict) else None
        if not isinstance(thread_id, str) or not thread_id:
            raise ValueError("thread/resume response carries no thread id")
        self.thread = SimpleNamespace(id=thread_id)

    @classmethod
    def model_validate(cls, data: Any) -> "ResumedThread":
        return cls(data)


def _thread_item_model() -> Any:
    """The SDK's own union — the only judge of what it can type."""
    from openai_codex.generated.v2_all import ThreadItem

    return ThreadItem


def install(client_cls: Any = None) -> bool:
    """Make every typed thread response tolerant of unknown history items.

    Patches the SDK's single request funnel. ``CodexClient.request`` is the
    only caller of ``_request_raw`` and every typed response — including the
    ones the SDK itself issues from ``AsyncThread.read`` / ``thread_fork`` —
    goes through it, so one hook covers call sites we do not own.
    """
    if client_cls is None:
        try:
            from openai_codex.client import CodexClient as client_cls  # type: ignore[no-redef]
        except Exception as exc:  # pragma: no cover - depends on the venv
            print(f"codex: schema tolerance unavailable: {exc}", file=sys.stderr)
            return False
    if getattr(client_cls, "_charon_schema_tolerance", False):
        return True
    original = getattr(client_cls, "_request_raw", None)
    if not callable(original):
        # Say it out loud. Silence here is a session that becomes permanently
        # unresumable the next time the CLI's schema moves.
        print(
            "codex: CodexClient._request_raw is gone — schema tolerance NOT installed",
            file=sys.stderr,
        )
        return False

    def _request_raw(self: Any, method: str, params: Any = None) -> Any:
        raw = original(self, method, params)
        if method in THREAD_RESPONSE_METHODS and isinstance(raw, dict):
            try:
                drop_untypeable_items(raw, _thread_item_model())
            except Exception:  # noqa: BLE001
                pass  # a repair must never break a response that would parse
        return raw

    client_cls._request_raw = _request_raw
    client_cls._charon_schema_tolerance = True
    return True
