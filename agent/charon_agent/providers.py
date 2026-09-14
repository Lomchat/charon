"""Agent-side provider registry: the ONE place a backend is declared.

Mirrors the hub's ``lib/sessionCapabilities.ts`` registry. Everything that
varies between backends and that the SERVER (rather than the session class)
must know lives here:

  * which session class drives the kind,
  * which constructor kwarg carries its provider construction config,
  * how to tell whether its runtime is importable on this box, and the error
    to report when it is not.

The rule is the same as the hub's: **no ``kind == "codex"`` ternary outside a
provider's own module.** That shape keeps working when a third backend lands
and silently routes it to Claude — a whole provider running under another
one's class and config kwarg, with every test still green. Adding a backend is
one ``PROVIDERS`` entry plus its ``*_session.py``.

Session classes are imported LAZILY, inside the spec's loader: ``server.py``
must keep starting on a box where only one SDK is installed, and a top-level
import of every backend would make one missing dependency fatal for all.
"""
from __future__ import annotations

from typing import Any, Callable


class ProviderSpec:
    """One backend, as the server needs to see it."""

    __slots__ = ("kind", "config_kwarg", "rewind", "compact",
                 "_load_class", "_availability")

    def __init__(
        self,
        kind: str,
        config_kwarg: str,
        load_class: Callable[[], Any],
        availability: Callable[[], "tuple[bool, str]"],
        *,
        rewind: str | None,
        compact: str | None,
    ) -> None:
        self.kind = kind
        # Constructor kwarg carrying the provider construction config. The name
        # is historical per provider ('codex_config' predates the common one)
        # and is part of neither the wire protocol nor the DB.
        self.config_kwarg = config_kwarg
        # ── History surgery, declared rather than inferred ────────────────────
        # `rollback_session` and `compact_session` used to be `kind == "codex"`
        # with a Claude FALLTHROUGH, which is the §14.102 failure in its most
        # destructive form: a Cursor rewind ran Claude's transcript fork, which
        # NULLs `claude_session_id` — for Cursor that column is the agent id,
        # i.e. the only resume handle there is, so the conversation was gone.
        # A backend that cannot do the operation says so and the server answers
        # -32602 instead of borrowing someone else's mechanism.
        #
        #   rewind:  'claude_fork' the server forks the native transcript
        #            'native'      the class implements `rollback(num_turns)`
        #            None          the provider cannot rewind
        #   compact: 'slash_command' the CLI reads `/compact` as a prompt
        #            'native'        the class implements `compact()`
        #            None            the provider cannot compact
        self.rewind = rewind
        self.compact = compact
        self._load_class = load_class
        self._availability = availability

    def session_class(self) -> Any:
        return self._load_class()

    def availability(self) -> "tuple[bool, str]":
        """``(usable, error_detail)`` — the runtime import verdict for this box."""
        return self._availability()


def _claude_class() -> Any:
    from .session import AgentSession
    return AgentSession


def _claude_availability() -> "tuple[bool, str]":
    from .session import SDK_AVAILABLE, SDK_IMPORT_ERROR
    return SDK_AVAILABLE, f"SDK unavailable: {SDK_IMPORT_ERROR}"


def _codex_class() -> Any:
    from .codex_session import CodexSession
    return CodexSession


def _codex_availability() -> "tuple[bool, str]":
    from .codex_session import CODEX_AVAILABLE, CODEX_IMPORT_ERROR
    return CODEX_AVAILABLE, f"Codex SDK unavailable: {CODEX_IMPORT_ERROR}"


def _cursor_class() -> Any:
    from .cursor_session import CursorSession
    return CursorSession


def _cursor_availability() -> "tuple[bool, str]":
    from .cursor_runtime import CURSOR_AVAILABLE, CURSOR_IMPORT_ERROR
    return CURSOR_AVAILABLE, f"Cursor SDK unavailable: {CURSOR_IMPORT_ERROR}"


PROVIDERS: "dict[str, ProviderSpec]" = {
    "claude": ProviderSpec(
        "claude", "session_config", _claude_class, _claude_availability,
        rewind="claude_fork", compact="slash_command",
    ),
    "codex": ProviderSpec(
        "codex", "codex_config", _codex_class, _codex_availability,
        rewind="native", compact="native",
    ),
    # The Cursor SDK exposes neither: no rollback primitive, no transcript fork
    # to branch at, and no compaction command. Declared honestly — the hub also
    # hides both buttons from the registry's `rewind`/`compact` capabilities.
    "cursor": ProviderSpec(
        "cursor", "session_config", _cursor_class, _cursor_availability,
        rewind=None, compact=None,
    ),
}

#: The kind a request may omit. Charon shipped Claude-only, so every kind-less
#: caller means Claude — a data fact, not a preference.
DEFAULT_KIND = "claude"

#: Declared kinds, for the -32602 message listing what IS accepted.
PROVIDER_KINDS = tuple(PROVIDERS)


def get_provider(kind: str | None) -> ProviderSpec:
    """Look a kind up, or raise ``KeyError``.

    Never falls back to a default on an UNKNOWN kind: a hub newer than this
    agent asking for a backend it does not have must get a clean error, not a
    silently mismatched session (its transcript would be driven by the wrong
    model, with the wrong permission semantics, and look like it worked).
    An OMITTED kind is different — that is a legacy caller, and it means Claude.
    """
    return PROVIDERS[kind or DEFAULT_KIND]
