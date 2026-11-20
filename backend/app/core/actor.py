"""Who is acting: the user, the assistant in a chat, or an automation run.

Provenance (who created or last changed a document, task or event) is recorded from
this, never from anything the model passes. The worker sets it around every tool call
(`runtime/agent.py`); everything else, including every HTTP request, acts as the user.

    with acting_as(Actor.automation(automation_id, run_id)):
        ...  # services read current_actor() when they write

An actor is stored as its reference string:

    user
    external                           a file changed outside Anemo (shell, sync)
    chat:<conversation id>
    automation:<automation id>/<run id>

Names and links for display ("the assistant in <chat title>") are looked up when the
item is read, so renaming a chat needs no rewrite. See docs/specs/CONTRACTS.md.
"""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Literal

ActorKind = Literal["user", "external", "chat", "automation"]

# Longest reference: "automation:" + 36 + "/" + 36 characters.
ACTOR_REF_LENGTH = 120


@dataclass(frozen=True)
class Actor:
    kind: ActorKind
    chat_id: uuid.UUID | None = None
    automation_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None

    @classmethod
    def chat(cls, conversation_id: uuid.UUID) -> "Actor":
        return cls("chat", chat_id=conversation_id)

    @classmethod
    def automation(cls, automation_id: uuid.UUID, run_id: uuid.UUID) -> "Actor":
        return cls("automation", automation_id=automation_id, run_id=run_id)

    @property
    def ref(self) -> str:
        if self.kind == "chat":
            return f"chat:{self.chat_id}"
        if self.kind == "automation":
            return f"automation:{self.automation_id}/{self.run_id}"
        return self.kind

    @property
    def is_user(self) -> bool:
        return self.kind == "user"

    @classmethod
    def parse(cls, ref: str) -> "Actor":
        """The actor a stored reference names. Raises ValueError for anything else."""
        if ref in ("user", "external"):
            return cls(ref)  # type: ignore[arg-type]
        kind, _, rest = ref.partition(":")
        if kind == "chat":
            return cls.chat(uuid.UUID(rest))
        if kind == "automation":
            automation_id, _, run_id = rest.partition("/")
            return cls.automation(uuid.UUID(automation_id), uuid.UUID(run_id))
        raise ValueError(f"not an actor reference: {ref!r}")


USER = Actor("user")
EXTERNAL = Actor("external")

_current: ContextVar[Actor] = ContextVar("actor", default=USER)


def current_actor() -> Actor:
    """Who the code running now acts for (the user unless something set otherwise)."""
    return _current.get()


@contextmanager
def acting_as(actor: Actor) -> Iterator[Actor]:
    token = _current.set(actor)
    try:
        yield actor
    finally:
        _current.reset(token)
