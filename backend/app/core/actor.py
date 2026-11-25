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
    plugin:<plugin id>@<version>       a plugin's call (docs/specs/CONTRACTS-plugins.md §6.4)

Names and links for display ("the assistant in <chat title>") are looked up when the
item is read, so renaming a chat needs no rewrite. See docs/specs/CONTRACTS.md.
"""

import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Literal

ActorKind = Literal["user", "external", "chat", "automation", "plugin"]

# Longest reference: "plugin:" + 64 + "@" + 40 characters (a plugin id and version at
# their longest; "automation:" + 36 + "/" + 36 is shorter).
ACTOR_REF_LENGTH = 120

# A plugin's id and version as its manifest has them (features/plugins/manifest.py
# checks the same rules, with messages for the user).
PLUGIN_ID = re.compile(r"^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$")
PLUGIN_VERSION = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")


@dataclass(frozen=True)
class Actor:
    kind: ActorKind
    chat_id: uuid.UUID | None = None
    automation_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    plugin_id: str | None = None  # the manifest id, e.g. "anemo.word-count"
    plugin_version: str | None = None

    @classmethod
    def chat(cls, conversation_id: uuid.UUID) -> "Actor":
        return cls("chat", chat_id=conversation_id)

    @classmethod
    def automation(cls, automation_id: uuid.UUID, run_id: uuid.UUID) -> "Actor":
        return cls("automation", automation_id=automation_id, run_id=run_id)

    @classmethod
    def plugin(cls, plugin_id: str, version: str) -> "Actor":
        """A plugin's call, as the version that made it (`plugin:<id>@<version>`)."""
        if not (
            PLUGIN_ID.match(plugin_id)
            and len(plugin_id) <= 64
            and PLUGIN_VERSION.match(version)
            and len(version) <= 40
        ):
            raise ValueError("not a plugin id and version")
        return cls("plugin", plugin_id=plugin_id, plugin_version=version)

    @property
    def ref(self) -> str:
        if self.kind == "chat":
            return f"chat:{self.chat_id}"
        if self.kind == "automation":
            return f"automation:{self.automation_id}/{self.run_id}"
        if self.kind == "plugin":
            return f"plugin:{self.plugin_id}@{self.plugin_version}"
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
        if kind == "plugin":
            plugin_id, _, version = rest.partition("@")
            return cls.plugin(plugin_id, version)
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
