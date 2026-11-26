"""What the server pulls out of Claude Code's events (docs/specs/code-sessions.md §5.2).
Pure: no IO.

The events are Claude Code's `--output-format stream-json --verbose` lines:
  {"type": "system", "subtype": "init", "session_id", "model", "cwd", ...}
  {"type": "assistant", "message": {"content": [{"type": "text", "text"},
      {"type": "tool_use", "id", "name", "input"}, ...]}, "parent_tool_use_id", ...}
  {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id",
      "content": "<text>" | [{"type": "text", "text"}], "is_error"}]}, "tool_use_result"}
  {"type": "result", "subtype": "success" | "error_…", "is_error", "num_turns",
      "duration_ms", "total_cost_usd", "result", "session_id", ...}
plus {"type": "raw", "text"} for lines that weren't JSON objects. Everything in them is
untrusted: each pull-out checks its type and size.
"""

import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

Kind = Literal["system", "assistant", "user", "result", "raw", "other"]
KINDS: tuple[str, ...] = ("system", "assistant", "user", "result", "raw", "other")

MAX_ID = 100
MAX_MODEL = 100
MAX_BRANCH = 255
MAX_PR_URL = 500
MAX_RESULT_TEXT = 16_000
MAX_SUBTYPE = 60
MAX_TODOS = 100
MAX_TODO_TEXT = 1000
MAX_INT = 2**31 - 1
MAX_COST = Decimal("999999.999999")  # numeric(12, 6)

PR_URL = re.compile(r"https://github\.com/[\w.-]+/[\w.-]+/pull/\d+")

# A branch name as git takes it (simplified): no spaces, quotes or shell characters.
_NAME = r"([\w./+-]+)"
_REF = r"([\w./+:-]+)"  # git push … <local>:<remote>
_GIT = r"\bgit\s+(?:-C\s+\S+\s+)?"
BRANCH_COMMANDS = (
    re.compile(_GIT + r"checkout\s+(?:-b|-B)\s+['\"]?" + _NAME),
    re.compile(_GIT + r"switch\s+(?:-c|-C|--create|--force-create)\s+['\"]?" + _NAME),
    re.compile(_GIT + r"push\s+(?:-u|--set-upstream)\s+\S+\s+['\"]?" + _REF),
)
NEW_BRANCH = re.compile(r"Switched to a new branch '" + _NAME + "'")


@dataclass
class Tokens:
    """A `result` event's `usage`: what the job's turns read and wrote."""

    input: int = 0  # input_tokens (not cached)
    output: int = 0
    cache_read: int = 0
    cache_creation: int = 0

    def as_json(self) -> dict[str, int]:
        return {
            "input": self.input,
            "output": self.output,
            "cache_read": self.cache_read,
            "cache_creation": self.cache_creation,
        }


@dataclass
class Result:
    """The fields of a `result` event."""

    subtype: str | None
    is_error: bool
    num_turns: int | None
    duration_ms: int | None
    cost_usd: Decimal | None
    text: str | None
    session_id: str | None
    tokens: Tokens | None = None

    @property
    def failed(self) -> bool:
        return self.is_error or self.subtype != "success"


@dataclass
class UsageWindow:
    """One window of a Claude subscription's usage limit (`five_hour`, `seven_day`, …)."""

    name: str
    utilization: float | None  # 0.49 = 49 % used; may pass 1 when the limit was hit
    resets_at: datetime | None
    status: str | None  # allowed | allowed_warning | rejected (as Claude Code wrote it)


@dataclass
class RateLimit:
    """A `rate_limit_event`: how much of the subscription's limits is used."""

    status: str | None  # of the window that decides: allowed | allowed_warning | rejected
    limit_type: str | None  # which window that is (`rateLimitType`)
    resets_at: datetime | None  # when that window resets
    windows: list[UsageWindow]

    @property
    def rejected(self) -> bool:
        return self.status == "rejected" or any(w.status == "rejected" for w in self.windows)


@dataclass
class PullOuts:
    """What one event says about its job; None: nothing about that."""

    session_id: str | None = None
    model: str | None = None
    todos: list[dict[str, str]] | None = None
    pr_url: str | None = None
    branch: str | None = None
    result: Result | None = None
    rate_limit: RateLimit | None = None
    # A message Claude Code took in, echoed with `isReplay` and the uuid it was sent with
    # (§15: --replay-user-messages): the proof it was delivered.
    replay_uuid: str | None = None


def kind(event: dict[str, Any]) -> Kind:
    value = event.get("type")
    if value == "system":
        return "system"
    if value == "assistant":
        return "assistant"
    if value == "user":
        return "user"
    if value == "result":
        return "result"
    if value == "raw":
        return "raw"
    return "other"


def _text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:limit] if value else None


def _number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    return math.isfinite(value)  # json.loads takes NaN and Infinity


def _int(value: Any) -> int | None:
    if not _number(value):
        return None
    number = int(value)
    return number if 0 <= number <= MAX_INT else None


def _cost(value: Any) -> Decimal | None:
    if not _number(value):
        return None
    try:
        cost = Decimal(str(value)).quantize(Decimal("0.000001"))
    except InvalidOperation:
        return None
    return cost if Decimal(0) <= cost <= MAX_COST else None


def _blocks(event: dict[str, Any]) -> list[dict[str, Any]]:
    message = event.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return []
    return [block for block in content if isinstance(block, dict)]


def tool_calls(event: dict[str, Any]) -> list[dict[str, Any]]:
    """The `tool_use` blocks of an assistant event."""
    if event.get("type") != "assistant":
        return []
    return [b for b in _blocks(event) if b.get("type") == "tool_use"]


def has_todo_write(event: dict[str, Any]) -> bool:
    return any(call.get("name") == "TodoWrite" for call in tool_calls(event))


SUB_AGENT_CALLS = ("Task", "Agent")
SUB_AGENT_STATE = ("task_started", "task_notification", "task_updated")


def holds_sub_agent_state(event: dict[str, Any]) -> bool:
    """Whether the event starts or ends a sub-agent: a Task/Agent call, a sub-agent's
    tool result (`tool_use_result.agentId`), or a background sub-agent's start, end or
    change of state (`system/task_*`). Kept past a job's 5 MB like a result, so the page
    can still list its sub-agents and tell how each ended."""
    if any(call.get("name") in SUB_AGENT_CALLS for call in tool_calls(event)):
        return True
    if event.get("type") == "system":
        return event.get("subtype") in SUB_AGENT_STATE
    details = event.get("tool_use_result")
    return event.get("type") == "user" and isinstance(details, dict) and "agentId" in details


def _tool_result_texts(event: dict[str, Any]) -> list[str]:
    texts: list[str] = []
    for block in _blocks(event):
        if block.get("type") != "tool_result":
            continue
        content = block.get("content")
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            texts.extend(
                item["text"]
                for item in content
                if isinstance(item, dict) and isinstance(item.get("text"), str)
            )
    result = event.get("tool_use_result")
    if isinstance(result, dict):
        texts.extend(result[k] for k in ("stdout", "stderr") if isinstance(result.get(k), str))
    return texts


def _assistant_texts(event: dict[str, Any]) -> list[str]:
    return [
        b["text"]
        for b in _blocks(event)
        if b.get("type") == "text" and isinstance(b.get("text"), str)
    ]


def _todos(call: dict[str, Any]) -> list[dict[str, str]] | None:
    params = call.get("input")
    items = params.get("todos") if isinstance(params, dict) else None
    if not isinstance(items, list):
        return None
    todos: list[dict[str, str]] = []
    for item in items[:MAX_TODOS]:
        if not isinstance(item, dict):
            continue
        content = _text(item.get("content"), MAX_TODO_TEXT)
        status = _text(item.get("status"), 20)
        if content is None or status is None:
            continue
        todo = {"content": content, "status": status}
        active = _text(item.get("activeForm"), MAX_TODO_TEXT)
        if active is not None:
            todo["activeForm"] = active
        todos.append(todo)
    return todos


def _clean_branch(name: str) -> str | None:
    name = name.strip("'\"")
    if ":" in name:  # git push -u origin local:remote
        name = name.rsplit(":", 1)[1]
    name = name.removeprefix("refs/heads/")
    if not name or name.startswith("-") or name == "HEAD" or len(name) > MAX_BRANCH:
        return None
    return name


def _last_branch(texts: list[str], patterns: tuple[re.Pattern[str], ...]) -> str | None:
    found: list[tuple[int, int, str]] = []  # (text index, position, name)
    for index, text in enumerate(texts):
        for pattern in patterns:
            for match in pattern.finditer(text):
                name = _clean_branch(match.group(1))
                if name is not None:
                    found.append((index, match.start(), name))
    return max(found)[2] if found else None


def _result(event: dict[str, Any]) -> Result:
    return Result(
        subtype=_text(event.get("subtype"), MAX_SUBTYPE),
        is_error=event.get("is_error") is True,
        num_turns=_int(event.get("num_turns")),
        duration_ms=_int(event.get("duration_ms")),
        cost_usd=_cost(event.get("total_cost_usd")),
        text=_text(event.get("result"), MAX_RESULT_TEXT),
        session_id=_text(event.get("session_id"), MAX_ID),
        tokens=_tokens(event.get("usage")),
    )


def _tokens(usage: Any) -> Tokens | None:
    if not isinstance(usage, dict):
        return None
    counts = {
        name: _int(usage.get(key)) or 0
        for name, key in (
            ("input", "input_tokens"),
            ("output", "output_tokens"),
            ("cache_read", "cache_read_input_tokens"),
            ("cache_creation", "cache_creation_input_tokens"),
        )
    }
    return Tokens(**counts) if any(counts.values()) else None


# -- usage limits (rate_limit_event) ---------------------------------------------------------

MAX_WINDOWS = 8
_WINDOW_NAME = re.compile(r"^[a-z0-9_]{1,40}$")
# Seconds since 1970 between 2001 and 2286; larger numbers are taken as milliseconds.
_EPOCH_S_MAX = 10_000_000_000


def epoch_time(value: Any) -> datetime | None:
    """A time Claude Code wrote: seconds (or milliseconds) since 1970, or ISO 8601 text
    (without an offset: UTC). None when it is none of these or out of range."""
    if _number(value):
        seconds = float(value)
        if seconds >= _EPOCH_S_MAX:
            seconds /= 1000
        if not 1_000_000_000 <= seconds < _EPOCH_S_MAX:
            return None
        return datetime.fromtimestamp(seconds, UTC)
    if isinstance(value, str) and 0 < len(value) <= 40:
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def _utilization(value: Any) -> float | None:
    if not _number(value):
        return None
    return min(max(float(value), 0.0), 10.0)


def _window(name: str, data: Any) -> UsageWindow | None:
    if not isinstance(data, dict):
        return None
    window = UsageWindow(
        name=name,
        utilization=_utilization(data.get("utilization")),
        resets_at=epoch_time(data.get("resetsAt")),
        status=_text(data.get("status"), 40),
    )
    if window.utilization is None and window.resets_at is None and window.status is None:
        return None
    return window


def rate_limit(event: dict[str, Any]) -> RateLimit | None:
    """The usage a `rate_limit_event` reports, or None for any other event. Claude Code
    writes `rate_limit_info` with the window that decides (`rateLimitType`, `status`,
    `resetsAt`, sometimes `utilization`) and `unifiedWindows` ({name: {utilization,
    resetsAt, status}}); either may be missing, and unknown fields are ignored."""
    if event.get("type") != "rate_limit_event":
        return None
    info = event.get("rate_limit_info")
    if not isinstance(info, dict):
        return None
    limit_type = _text(info.get("rateLimitType"), 40)
    windows: list[UsageWindow] = []
    unified = info.get("unifiedWindows")
    if isinstance(unified, dict):
        for name, data in list(unified.items())[: MAX_WINDOWS * 2]:
            if isinstance(name, str) and _WINDOW_NAME.match(name):
                window = _window(name, data)
                if window is not None and len(windows) < MAX_WINDOWS:
                    windows.append(window)
    if limit_type and _WINDOW_NAME.match(limit_type) and all(w.name != limit_type for w in windows):
        # An older shape: only the deciding window, at the top level.
        window = _window(limit_type, info)
        if window is not None:
            windows.insert(0, window)
    found = RateLimit(
        status=_text(info.get("status"), 40),
        limit_type=limit_type,
        resets_at=epoch_time(info.get("resetsAt")),
        windows=windows,
    )
    if not windows and found.status is None and found.resets_at is None:
        return None
    return found


def pull_outs(event: dict[str, Any]) -> PullOuts:
    """What `event` says about its job: the session id and model (`system/init`, the
    session also from `result`), the todo list of its last TodoWrite call, the last
    GitHub pull request URL in its text, tool results or result, the branch it made or
    pushed (D12) and the result's fields."""
    out = PullOuts()
    kind_ = kind(event)
    texts: list[str] = []
    if kind_ == "system" and event.get("subtype") == "init":
        out.session_id = _text(event.get("session_id"), MAX_ID)
        out.model = _text(event.get("model"), MAX_MODEL)
    elif kind_ == "assistant":
        texts = _assistant_texts(event)
        calls = tool_calls(event)
        for call in calls:
            if call.get("name") == "TodoWrite":
                todos = _todos(call)
                if todos is not None:
                    out.todos = todos
        commands = [
            call["input"]["command"]
            for call in calls
            if call.get("name") == "Bash"
            and isinstance(call.get("input"), dict)
            and isinstance(call["input"].get("command"), str)
        ]
        out.branch = _last_branch(commands, BRANCH_COMMANDS)
    elif kind_ == "user":
        if event.get("isReplay") is True:
            out.replay_uuid = _text(event.get("uuid"), MAX_ID)
        texts = _tool_result_texts(event)
        out.branch = _last_branch(texts, (NEW_BRANCH,))
    elif kind_ == "other":
        out.rate_limit = rate_limit(event)
    elif kind_ == "result":
        out.result = _result(event)
        out.session_id = out.result.session_id
        texts = [out.result.text] if out.result.text else []
    urls = [url for text in texts for url in PR_URL.findall(text) if len(url) <= MAX_PR_URL]
    if urls:
        out.pr_url = urls[-1]
    return out
