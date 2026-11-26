"""What the Code page's API answers (docs/specs/code-sessions.md §5.4). The same shapes
travel on the job's live stream (`code.job` {job}, `code.events` {job_id, events})."""

import re
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, Field, StringConstraints

from app.features.code_sessions.images import MAX_IMAGES
from app.features.code_sessions.models import EventKind, MessageState, State


class CodeDeviceOut(BaseModel):
    id: uuid.UUID
    name: str
    online: bool  # connected to Anemo now
    last_seen_at: datetime | None
    # From its live offer (false when offline). share: "Share Claude Code jobs with
    # Anemo" is on; cancel: also "Let Anemo start Claude Code jobs"; start: also "Allow
    # control", not paused (§12.5).
    share: bool = False
    start: bool = False
    cancel: bool = False


class CodeTodoOut(BaseModel):
    content: str
    status: str  # pending | in_progress | completed (as Claude Code wrote it)
    activeForm: str | None = None  # Claude Code's own name for it


class CodeImageOut(BaseModel):
    id: uuid.UUID  # the attachment: GET /api/attachments/{id}/content
    name: str  # the file name in the job's folder on the computer (images\\<name>)


class CodeTokensOut(BaseModel):
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_creation: int = 0


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
    # The images sent with its prompt (only for a job Anemo started with images).
    images: list[CodeImageOut] = []
    # The token counts of its last result (None: no result yet, or none given).
    tokens: CodeTokensOut | None = None
    # It takes messages while it runs now (§15).
    input_open: bool = False
    # Auto continue (§16): it stopped at the usage limit, which resets at limit_resets_at;
    # resume_state: None | scheduled | starting | started | cancelled | stopped | failed.
    limit_hit: bool = False
    limit_resets_at: datetime | None = None
    resume_state: str | None = None
    resume_at: datetime | None = None
    resume_note: str | None = None
    resume_attempt: int = 0  # automatic continues in a row that led to this job
    resumed_job_id: uuid.UUID | None = None  # the job its continue started
    resumed_from: uuid.UUID | None = None  # the job whose continue started this one


class CodeUsageWindowOut(BaseModel):
    # five_hour | seven_day | seven_day_opus | … (as Claude Code names them)
    name: str
    utilization: float | None  # 0.49 = 49 % used; past 1 once the limit was hit
    resets_at: datetime | None
    status: str | None  # allowed | allowed_warning | rejected


class CodeUsageOut(BaseModel):
    """The usage of the Claude subscription a computer's jobs run on, as its newest
    `rate_limit_event` said (§14)."""

    device_id: uuid.UUID
    device_name: str
    status: str | None  # of the window that decides (limit_type)
    limit_type: str | None
    resets_at: datetime | None  # when that window resets
    windows: list[CodeUsageWindowOut]
    observed_at: datetime  # when it was true ("as of")
    job_id: uuid.UUID | None  # the job whose event it came from


class CodeUsageListOut(BaseModel):
    usage: list[CodeUsageOut]  # one per computer, the newest first


class CodeJobListOut(BaseModel):
    jobs: list[CodeJobOut]  # newest first
    projects: list[str]  # every project with jobs, the one with the newest job first
    has_more: bool


class CodeMessageOut(BaseModel):
    """A message written for a thread while its job ran (§15)."""

    id: uuid.UUID
    thread_id: uuid.UUID
    job_id: uuid.UUID  # the job it was written for (the thread's running job then)
    prompt: str
    images: list[CodeImageOut] = []
    mode: Literal["queue", "now"]  # queue: at the job's next step; now: interrupting it
    # queued | sending | sent (in the job's hands) | delivered (taken in) |
    # followed_up (sent as a follow-up: follow_up_job_id) | held (note says why)
    state: MessageState
    note: str | None  # why it waits or is held
    created_at: datetime
    sent_at: datetime | None
    delivered_at: datetime | None
    delivered_seq: int | None  # the seq of its echo in the job's events
    follow_up_job_id: uuid.UUID | None


class CodeJobDetailOut(BaseModel):
    job: CodeJobOut
    thread: list[CodeJobOut]  # every job of its thread in start order, the job included
    # The thread's messages (the newest 50), oldest first.
    messages: list[CodeMessageOut] = []


class CodeEventOut(BaseModel):
    seq: int
    kind: EventKind
    event: dict[str, Any]
    trimmed: bool
    # not stored (the job held 5 MB): `event` is only its type and the ids that place it
    # (parent_tool_use_id, tool_use_id, status, its tool calls and results: trim.stub_of)
    dropped: bool
    created_at: datetime


class CodeEventsOut(BaseModel):
    events: list[CodeEventOut]  # by seq
    last_seq: int
    has_more: bool


# -- phase 2: starting, following up, cancelling ----------------------------------------------

PROJECT = r"^[A-Za-z0-9._-]{1,100}$"  # a folder name, as Anemo Desktop takes it
MODEL = r"^[A-Za-z0-9._\[\]-]{1,100}$"
_WINDOWS_DEVICE = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$", re.IGNORECASE)


def project_name(value: str) -> str:
    """A name Windows takes as a folder of its own: not only dots, not ending with a dot
    (Windows drops it), not a device name such as CON or COM1, even with an extension
    (§12.5; Anemo Desktop checks the same)."""
    if value.strip(".") == "" or value.endswith(".") or _WINDOWS_DEVICE.match(value):
        raise ValueError("not a name a project folder can have")
    return value


ProjectName = Annotated[str, StringConstraints(pattern=PROJECT), AfterValidator(project_name)]

# One of the owner's GitHub repositories, `owner/name` (docs/device-contracts.md §7.6).
REPO = r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$"
_GITHUB_URL = re.compile(
    r"^(?:https://(?:[^@/]+@)?github\.com/|ssh://git@github\.com/|git@github\.com:)"
    r"([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100}?)(?:\.git)?/?$",
    re.IGNORECASE,
)


def repo_name(value: str) -> str:
    """`owner/name` whose name is a real one: not `.` or `..`, not ending in `.git`."""
    name = value.split("/", 1)[1]
    if name in (".", "..") or name.lower().endswith(".git"):
        raise ValueError("not the name of a GitHub repository")
    return value


RepoName = Annotated[str, StringConstraints(pattern=REPO), AfterValidator(repo_name)]


def github_repo(url: str | None) -> str | None:
    """`owner/name` of a github.com remote URL (https, ssh or scp style), else None."""
    found = _GITHUB_URL.match(url.strip()) if url else None
    if found is None:
        return None
    repo = f"{found.group(1)}/{found.group(2)}"
    try:
        return repo_name(repo)
    except ValueError:
        return None


class CodeProjectOut(BaseModel):
    name: str
    dir: str
    remote: str | None  # its origin remote's URL
    repo: str | None = None  # owner/name when origin is on GitHub


class CodeRemoteOut(BaseModel):
    name: str
    url: str
    repo: str | None = None  # owner/name (from the URL): what the git reads take as `repo`


class CodeProjectsOut(BaseModel):
    projects: list[CodeProjectOut]  # folders in the computer's projects folder
    remote: list[CodeRemoteOut]  # the owner's GitHub repositories not cloned there
    note: str | None  # why `remote` couldn't be read, when it couldn't


class CodeJobIn(BaseModel):
    device_id: uuid.UUID
    project: ProjectName = Field(description="A folder name in the projects folder")
    prompt: str = Field(min_length=1, max_length=100_000)
    new: bool = Field(False, description="Make an empty project when there is none")
    model: str | None = Field(None, pattern=MODEL)
    max_turns: int | None = Field(None, ge=1, le=500)
    image_ids: list[uuid.UUID] = Field(
        default_factory=list,
        max_length=MAX_IMAGES,
        description="Uploaded images (POST /api/attachments) to send with the prompt",
    )


class CodeAutoContinueIn(BaseModel):
    enabled: bool


class CodeMessageIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=100_000)
    image_ids: list[uuid.UUID] = Field(
        default_factory=list,
        max_length=MAX_IMAGES,
        description="Uploaded images (POST /api/attachments) to send with the message",
    )
    now: bool | None = Field(
        None, description="Interrupt the job's current step and send it at once (default: queue)"
    )


class CodeFollowUpIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=100_000)
    model: str | None = Field(None, pattern=MODEL)
    max_turns: int | None = Field(None, ge=1, le=500)
    image_ids: list[uuid.UUID] = Field(
        default_factory=list,
        max_length=MAX_IMAGES,
        description="Uploaded images (POST /api/attachments) to send with the prompt",
    )
