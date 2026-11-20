"""Shapes of run data shared by several APIs."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

Outcome = Literal["done", "stopped", "failed"]


class RunTiming(BaseModel):
    """How long an answer took, from the server's records (service.run_timing).

    The duration is `finished_at - started_at - waiting_ms`. While the run waits for
    the user, `waiting_since` says since when; that time isn't part of the duration
    either. Compare the times with the server's clock, not the browser's: every API
    response has it in its `X-Server-Time` header (milliseconds since the epoch)."""

    started_at: datetime  # when the server accepted the message
    finished_at: datetime | None
    outcome: Outcome | None  # None while it runs
    first_text_at: datetime | None
    # The time it had waited for you before its first text: the time to first text
    # is `first_text_at - started_at - first_text_waiting_ms`.
    first_text_waiting_ms: int = 0
    waiting_ms: int
    waiting_since: datetime | None
    tool_calls: int
