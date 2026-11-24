from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.actor import ActorKind


class ActorOut(BaseModel):
    """Who made or changed something, ready to show: "the assistant in <chat title>"."""

    ref: str = Field(description="The stored actor reference, e.g. chat:<id>")
    kind: ActorKind
    label: str = Field(
        description="The chat's title or the automation's name (looked up when read); "
        "'deleted chat' / 'deleted automation' when it is gone"
    )
    url: str | None = Field(description="Where it leads: the chat, or the automation's run")
    automation_kind: Literal["agent", "script"] | None = Field(
        None, description="For an automation: a prompt (agent) or a script; None otherwise"
    )


class SourceIn(BaseModel):
    """Where a task or event came from, as an automation that syncs it gives it."""

    source: str | None = Field(None, max_length=40, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    external_key: str | None = Field(None, min_length=1, max_length=200)
    source_url: str | None = Field(None, max_length=1000)

    @field_validator("source", "external_key", "source_url", mode="before")
    @classmethod
    def _blank(cls, v: object) -> object:
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v

    @field_validator("source", mode="before")
    @classmethod
    def _slug(cls, v: object) -> object:
        return v.lower() if isinstance(v, str) else v

    @field_validator("source_url")
    @classmethod
    def _url(cls, v: str | None) -> str | None:
        # Shown as a link in the app: only web addresses, never javascript: and the like.
        if v is not None and not v.lower().startswith(("http://", "https://")):
            raise ValueError("source_url must be an http:// or https:// address")
        return v

    def given(self) -> bool:
        return any(v is not None for v in (self.source, self.external_key, self.source_url))
