"""Auto continue after the usage limit (docs/specs/code-sessions.md §16).

A job that stopped at the Claude subscription's usage limit (limits.py) gets a "Limit
reached" panel on the Code page. With Auto continue on (the panel's switch, its default in
Settings → Devices, `code.auto_continue`), the server resumes the job's session shortly
after the limit resets: a follow-up with a short prompt, so Claude Code goes on with its
context and prompt cache instead of starting over.

  scheduled   resume_at is set; the scheduler (every 30 s) starts it once it is due and the
              computer is there (it waits for the computer, as long as it is on)
  starting    claimed by a worker
  started     resumed_job_id is the follow-up
  cancelled   turned off, or the user did something in the thread meanwhile (resume_note)
  stopped     MAX_IN_A_ROW automatic continues in a row: the user continues by hand
  failed      the follow-up couldn't be started (resume_note)

A resumed job that hits the limit again is scheduled again (resume_attempt + 1); one that
did nothing before hitting it again (the reset time was read wrong, or the limit wasn't
reset yet) is tried once more RETRY_AFTER later. Never more than MAX_IN_A_ROW in a row.

This module holds the rules (ingestion and control use them); autocontinue.py the switch,
the scheduler's task and the worker's job.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.features.code_sessions.models import TERMINAL, CodeJob
from app.features.settings import service as settings_service
from app.features.settings.sections import CodeSettings

MARGIN = timedelta(minutes=2)  # after the reset time, so the limit has surely reset
RETRY_AFTER = timedelta(minutes=30)
UNKNOWN_RESET = timedelta(hours=1)  # when no reset time could be read
MAX_IN_A_ROW = 3


def _due_time(job: CodeJob, now: datetime) -> datetime:
    """When to continue: the limit's reset plus MARGIN; RETRY_AFTER from now when this was
    an automatic continue that hit the limit again at once (its reset already passed or
    unknown); UNKNOWN_RESET from now when no reset time is known."""
    resets = job.limit_resets_at
    did_nothing = job.resume_attempt > 0 and (job.num_turns or 0) <= 1
    if did_nothing and (resets is None or resets <= now):
        return now + RETRY_AFTER
    if resets is None:
        return now + UNKNOWN_RESET
    return max(resets + MARGIN, now + MARGIN)


def schedule(job: CodeJob, now: datetime | None = None) -> bool:
    """Schedule the job's continue (part of the caller's change). False when it has had
    MAX_IN_A_ROW in a row already: then it is `stopped`."""
    now = now or datetime.now(UTC)
    if job.resume_attempt >= MAX_IN_A_ROW:
        job.resume_state = "stopped"
        job.resume_at = None
        job.resume_note = f"Stopped after {MAX_IN_A_ROW} automatic continues in a row."
        return False
    job.resume_state = "scheduled"
    job.resume_at = _due_time(job, now)
    job.resume_note = None
    return True


def cancel(job: CodeJob, note: str) -> bool:
    """Cancel a scheduled continue (part of the caller's change); True when there was one.
    (One a worker is starting already goes on.)"""
    if job.resume_state != "scheduled":
        return False
    job.resume_state = "cancelled"
    job.resume_at = None
    job.resume_note = note
    return True


async def on_change(db: AsyncSession, job: CodeJob, *, old_state: str | None) -> None:
    """Ingestion: the job just ended at the usage limit; with Auto continue on by default,
    schedule its continue. Part of the caller's change: doesn't commit."""
    if not (old_state == "running" and job.state in TERMINAL and job.limit_hit):
        return
    if job.state == "cancelled" or job.resume_state is not None:
        return
    settings = await settings_service.get_section(db, CodeSettings, "code")
    if job.resume_attempt > 0 or settings.auto_continue:
        # An automatic continue that hit the limit again goes on by itself (up to the cap).
        schedule(job)
