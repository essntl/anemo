"""What the Code page's API answers (docs/specs/code-sessions.md §5.4). The same shapes
travel on the job's live stream (`code.job` {job}, `code.events` {job_id, events})."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.features.code_sessions.models import EventKind, State


class CodeDeviceOut(BaseModel):
    id: uuid.UUID
    name: str
    online: bool  # connected to Anemo now
    last_seen_at: datetime | None
    # From its live offer (false when offline): "Share Claude Code jobs with Anemo" and
    # "Let Anemo start Claude Code jobs" are on in Anemo Desktop.
    share: bool = False
    start: bool = False


class CodeTodoOut(BaseModel):
    content: str
    status: str  # pending | in_progress | completed (as Claude Code wrote it)
    activeForm: str | None = None  # Claude Code's own name for it


class CodeJobOut(BaseModel):
    id: uuid.UUID
    job_key: str  # the job's folder name on its computer
    device: CodeDeviceOut
    project: str
    dir: str
    job_dir: str
    title: str
    prompt: str
    state: State
    started_at: datetime
    ended_at: datetime | None
    last_event_at: datetime | None
    session_id: str | None
    resume_session: str | None
    thread_id: uuid.UUID
    model: str | None
    branch: str | None
    pr_url: str | None
    todos: list[CodeTodoOut]
    num_turns: int | None
    duration_ms: int | None
    cost_usd: float | None  # API-equivalent cost (D13), not money spent
    result_text: str | None
    result_subtype: str | None
    is_error: bool
    stderr_tail: str | None
    last_seq: int  # 1..last_seq are all stored
    event_count: int
    truncated: bool  # some events were trimmed or not stored (the full log is on the computer)
    # The chat and run of the agent tool that started it (None: started on the computer
    # or from the Code page).
    conversation_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    conversation_title: str | None = None


class CodeJobListOut(BaseModel):
    jobs: list[CodeJobOut]  # newest first
    projects: list[str]  # every project with jobs, the one with the newest job first
    has_more: bool


class CodeJobDetailOut(BaseModel):
    job: CodeJobOut
    thread: list[CodeJobOut]  # every job of its thread in start order, the job included


class CodeEventOut(BaseModel):
    seq: int
    kind: EventKind
    event: dict[str, Any]
    trimmed: bool
    dropped: bool  # not stored (the job held 5 MB): `event` is only {"type"}
    created_at: datetime


class CodeEventsOut(BaseModel):
    events: list[CodeEventOut]  # by seq
    last_seq: int
    has_more: bool


# -- phase 2: starting, following up, cancelling ----------------------------------------------

PROJECT = r"^[A-Za-z0-9._-]{1,100}$"  # a folder name, as Anemo Desktop takes it
MODEL = r"^[A-Za-z0-9._\[\]-]{1,100}$"


class CodeProjectOut(BaseModel):
    name: str
    dir: str
    remote: str | None  # its origin remote's URL


class CodeRemoteOut(BaseModel):
    name: str
    url: str


class CodeProjectsOut(BaseModel):
    projects: list[CodeProjectOut]  # folders in the computer's projects folder
    remote: list[CodeRemoteOut]  # the owner's GitHub repositories not cloned there
    note: str | None  # why `remote` couldn't be read, when it couldn't


class CodeJobIn(BaseModel):
    device_id: uuid.UUID
    project: str = Field(pattern=PROJECT, description="A folder name in the projects folder")
    prompt: str = Field(min_length=1, max_length=100_000)
    new: bool = Field(False, description="Make an empty project when there is none")
    model: str | None = Field(None, pattern=MODEL)
    max_turns: int | None = Field(None, ge=1, le=500)

    @field_validator("project")
    @classmethod
    def not_a_path(cls, value: str) -> str:
        if value in (".", ".."):
            raise ValueError("a project is a folder name")
        return value


class CodeFollowUpIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=100_000)
    model: str | None = Field(None, pattern=MODEL)
    max_turns: int | None = Field(None, ge=1, le=500)
