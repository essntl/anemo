"""Automations: agent runs that start by themselves on a schedule.

  fire_due()         called by the worker every half minute: starts what is due
  start_run()        one firing = a new conversation with the prompt + an agent run
  on_run_finished()  delivers the result (notification, document) and retries failures
  on_needs_approval() tells the user an unattended run is waiting for them

A due automation is claimed with a row lock and its next run time is moved on in
the same transaction, so it fires once even with several workers.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.errors import AppError, Conflict, NotFound
from app.events import bus
from app.features.automations.models import Automation
from app.features.automations.schedule import Schedule, describe, next_run
from app.features.automations.schemas import AutomationIn, AutomationOut, AutomationPatch
from app.features.conversations.models import ChatMessage, Conversation
from app.features.documents import service as documents
from app.features.notifications import service as notifications
from app.features.notifications.models import NotificationDestination
from app.features.profiles.models import AgentProfile
from app.features.providers.models import Model
from app.features.runs.models import ACTIVE_STATUSES, Approval, Run
from app.jobs import queue
from app.workspace import files

log = logging.getLogger(__name__)

GRACE = timedelta(hours=1)  # a run that is later than this (e.g. after downtime) is skipped
RETRY_DELAY = timedelta(minutes=2)  # doubled for every further retry
MAX_STATE_CHARS = 16_000


def _now() -> datetime:
    return datetime.now(UTC)


async def notify_changed() -> None:
    await bus.publish_global("automations.changed", {})


async def get(db: AsyncSession, automation_id: uuid.UUID) -> Automation:
    automation = await db.get(Automation, automation_id)
    if automation is None:
        raise NotFound("Automation not found")
    return automation


async def active_run(db: AsyncSession, automation_id: uuid.UUID) -> Run | None:
    run: Run | None = await db.scalar(
        select(Run)
        .where(Run.automation_id == automation_id, Run.status.in_(ACTIVE_STATUSES))
        .order_by(Run.created_at.desc())
        .limit(1)
    )
    return run


_LIVE_STATUS = {
    "queued": "running",
    "running": "running",
    "waiting_approval": "waiting",
    "paused": "paused",
}


async def automation_out(db: AsyncSession, a: Automation) -> AutomationOut:
    schedule = Schedule.model_validate(a.schedule)
    run = await active_run(db, a.id)
    return AutomationOut(
        id=a.id,
        name=a.name,
        prompt=a.prompt,
        schedule=schedule,
        schedule_text=describe(schedule),
        enabled=a.enabled,
        profile_id=a.profile_id,
        model_id=a.model_id,
        on_ask=a.on_ask,  # type: ignore[arg-type]
        notify=a.notify,  # type: ignore[arg-type]
        destination_ids=[uuid.UUID(d) for d in a.destination_ids]
        if a.destination_ids is not None
        else None,
        document_path=a.document_path,
        max_retries=a.max_retries,
        state={str(k): str(v) for k, v in (a.state or {}).items()},
        next_run_at=a.next_run_at if a.enabled else None,
        last_run_at=a.last_run_at,
        last_status=_LIVE_STATUS[run.status] if run else a.last_status,
        last_run_id=a.last_run_id,
        active_run_id=run.id if run else None,
        created_at=a.created_at,
    )


# -- create and change --------------------------------------------------------------------


def render_path(template: str, now: datetime, tz: str) -> str:
    local = now.astimezone(ZoneInfo(tz))
    return template.replace("{date}", f"{local:%Y-%m-%d}").replace("{time}", f"{local:%H%M}")


async def _check_references(
    db: AsyncSession,
    profile_id: uuid.UUID | None,
    model_id: uuid.UUID | None,
    destination_ids: list[uuid.UUID] | None,
    document_path: str | None,
    tz: str,
) -> None:
    if profile_id is not None and await db.get(AgentProfile, profile_id) is None:
        raise NotFound("Agent profile not found")
    if model_id is not None and await db.get(Model, model_id) is None:
        raise NotFound("Model not found")
    for destination_id in destination_ids or []:
        if await db.get(NotificationDestination, destination_id) is None:
            raise NotFound("Notification destination not found")
    if document_path:
        if "{" in document_path.replace("{date}", "").replace("{time}", ""):
            raise AppError("The document path may only use {date} and {time}", code="invalid_path")
        documents.check_path(render_path(document_path, _now(), tz))  # raises for bad paths


def _reschedule(automation: Automation) -> None:
    schedule = Schedule.model_validate(automation.schedule)
    automation.next_run_at = next_run(schedule, _now()) if automation.enabled else None


async def create(db: AsyncSession, data: AutomationIn) -> Automation:
    document_path = (data.document_path or "").strip() or None
    await _check_references(
        db, data.profile_id, data.model_id, data.destination_ids, document_path, data.schedule.tz
    )
    automation = Automation(
        name=data.name.strip(),
        prompt=data.prompt,
        enabled=data.enabled,
        schedule=data.schedule.model_dump(mode="json"),
        profile_id=data.profile_id,
        model_id=data.model_id,
        on_ask=data.on_ask,
        notify=data.notify,
        destination_ids=[str(d) for d in data.destination_ids]
        if data.destination_ids is not None
        else None,
        document_path=document_path,
        max_retries=data.max_retries,
        state={},
    )
    _reschedule(automation)
    if automation.enabled and automation.next_run_at is None:
        raise AppError("That time has already passed", code="schedule_in_past")
    db.add(automation)
    await db.flush()
    return automation


async def update(db: AsyncSession, automation: Automation, data: AutomationPatch) -> None:
    fields = data.model_fields_set
    if data.name is not None:
        automation.name = data.name.strip()
    if data.prompt is not None:
        automation.prompt = data.prompt
    if data.on_ask is not None:
        automation.on_ask = data.on_ask
    if data.notify is not None:
        automation.notify = data.notify
    if data.max_retries is not None:
        automation.max_retries = data.max_retries
    if "profile_id" in fields:
        automation.profile_id = data.profile_id
    if "model_id" in fields:
        automation.model_id = data.model_id
    if "destination_ids" in fields:
        automation.destination_ids = (
            [str(d) for d in data.destination_ids] if data.destination_ids is not None else None
        )
    if "document_path" in fields:
        automation.document_path = (data.document_path or "").strip() or None
    timing_changed = False
    if data.schedule is not None:
        new = data.schedule.model_dump(mode="json")
        timing_changed = new != automation.schedule
        automation.schedule = new
    if data.enabled is not None and data.enabled != automation.enabled:
        automation.enabled = data.enabled
        timing_changed = True
        if not data.enabled and automation.last_status == "retrying":
            automation.last_status = "failed"  # turning it off also cancels a pending retry
    schedule = Schedule.model_validate(automation.schedule)
    await _check_references(
        db,
        automation.profile_id,
        automation.model_id,
        [uuid.UUID(d) for d in automation.destination_ids]
        if automation.destination_ids is not None
        else None,
        automation.document_path,
        schedule.tz,
    )
    if timing_changed:
        _reschedule(automation)
        if automation.enabled and automation.next_run_at is None:
            raise AppError("That time has already passed", code="schedule_in_past")
    await db.flush()


# -- running ------------------------------------------------------------------------------


async def start_run(
    db: AsyncSession,
    automation: Automation,
    *,
    trigger: str,
    retry: int = 0,
    now: datetime | None = None,
) -> Run:
    """A new conversation holding the prompt, and a queued agent run to answer it.
    Adds to the caller's transaction."""
    now = now or _now()
    schedule = Schedule.model_validate(automation.schedule)
    local = now.astimezone(ZoneInfo(schedule.tz))
    conversation = Conversation(
        title=f"{automation.name} · {local.day} {local:%b %H:%M}"[:200],
        title_is_auto=False,
        default_mode="agent",
        model_id=automation.model_id,
        profile_id=automation.profile_id,
        automation_id=automation.id,
    )
    db.add(conversation)
    await db.flush()
    user = ChatMessage(
        conversation_id=conversation.id,
        seq=1,
        role="user",
        content=[{"type": "text", "text": automation.prompt}],
        text_plain=automation.prompt,
    )
    assistant = ChatMessage(
        conversation_id=conversation.id,
        seq=2,
        role="assistant",
        content=[],
        text_plain="",
        status="streaming",
    )
    db.add_all([user, assistant])
    await db.flush()
    run = Run(
        kind="agent",
        status="queued",
        conversation_id=conversation.id,
        automation_id=automation.id,
        profile_id=automation.profile_id,
        user_message_id=user.id,
        assistant_message_id=assistant.id,
        requested_model_id=automation.model_id,
        request=automation.prompt[:2000],
        options={"automation": {"trigger": trigger, "retry": retry}},
    )
    db.add(run)
    await db.flush()
    assistant.run_id = run.id
    await queue.enqueue(db, "run.execute", {"run_id": str(run.id)}, lane="background")
    automation.last_run_at, automation.last_status, automation.last_run_id = now, "running", run.id
    return run


async def run_now(db: AsyncSession, automation: Automation) -> Run:
    if await active_run(db, automation.id) is not None:
        raise Conflict("This automation is already running", code="automation_running")
    run = await start_run(db, automation, trigger="manual")
    await db.commit()
    await notify_changed()
    return run


async def fire_due(now: datetime | None = None) -> int:
    """Start every automation whose time has come. Returns how many runs started."""
    now = now or _now()
    started = 0
    async with get_sessionmaker()() as db:
        due = await db.scalars(
            select(Automation)
            .where(Automation.enabled, Automation.next_run_at <= now)
            .with_for_update(skip_locked=True)
        )
        rows = list(due)
        for automation in rows:
            scheduled = automation.next_run_at
            assert scheduled is not None
            try:
                schedule = Schedule.model_validate(automation.schedule)
            except ValueError:
                log.warning("automation has an invalid schedule; turned off")
                automation.enabled, automation.next_run_at = False, None
                continue
            automation.next_run_at = next_run(schedule, now, scheduled)
            if automation.next_run_at is None:
                automation.enabled = False  # a one-time schedule is done
            if now - scheduled > GRACE:
                # The app was off at the time. Catching up hours later would surprise.
                automation.last_status = "missed"
            elif await active_run(db, automation.id) is not None:
                automation.last_status = "skipped"  # the previous run is still going
            else:
                await start_run(db, automation, trigger="schedule", now=now)
                started += 1
        await db.commit()
    if rows:
        await notify_changed()
    return started


async def retry_run(automation_id: uuid.UUID, retry: int) -> None:
    """Job handler: try a failed automation run again."""
    async with get_sessionmaker()() as db:
        automation = await db.scalar(
            select(Automation).where(Automation.id == automation_id).with_for_update()
        )
        if automation is None or automation.last_status != "retrying":
            return  # deleted, turned off, or started again in the meantime
        if await active_run(db, automation.id) is not None:
            return
        await start_run(db, automation, trigger="retry", retry=retry)
        await db.commit()
    await notify_changed()


# -- results ------------------------------------------------------------------------------


def _destinations(automation: Automation) -> list[uuid.UUID] | None:
    if automation.notify == "never":
        return []  # only the list in the app
    if automation.destination_ids is None:
        return None
    return [uuid.UUID(d) for d in automation.destination_ids]


async def _save_document(
    db: AsyncSession, automation: Automation, run: Run, answer: str
) -> tuple[str | None, str | None]:
    """Returns (link to the document, error)."""
    schedule = Schedule.model_validate(automation.schedule)
    try:
        path = documents.check_path(
            render_path(automation.document_path or "", _now(), schedule.tz)
        )
        existing = await documents.by_path(db, path)
        if existing is None and files.resolve(path).exists():
            await documents.reconcile(db)  # the file exists but is not indexed yet
            existing = await documents.by_path(db, path)
        if existing is not None:
            doc = await documents.save(
                db,
                existing,
                answer,
                base_hash=None,
                author="agent",
                run_id=run.id,
                new_revision=True,
            )
        else:
            doc = await documents.create(db, path, answer, author="agent", run_id=run.id)
    except AppError as exc:
        await db.rollback()
        return None, exc.message
    except OSError as exc:
        await db.rollback()
        return None, str(exc)
    return f"/documents/{doc.id}", None


async def on_run_finished(db: AsyncSession, run: Run, status: str, error: str | None) -> None:
    """Called when an automation's run ends (completed, failed or cancelled)."""
    if run.automation_id is None:
        return
    automation = await db.get(Automation, run.automation_id)
    if automation is None:
        return
    message = (
        await db.get(ChatMessage, run.assistant_message_id) if run.assistant_message_id else None
    )
    answer = (message.text_plain if message else "").strip()
    link = f"/c/{run.conversation_id}" if run.conversation_id else None
    name, notify, destinations = automation.name, automation.notify, _destinations(automation)
    automation.last_status = status
    await db.commit()
    if status == "completed":
        problem = None
        if automation.document_path and answer:
            # (A failed save rolls the session back, hence the values read above.)
            doc_link, problem = await _save_document(db, automation, run, answer)
            link = doc_link or link
        if notify == "always" or problem:
            body = answer or "(The run finished without an answer.)"
            if problem:
                body += f"\n\nThe result could not be saved as a document: {problem}"
            await notifications.create(
                db,
                title=name,
                body=body,
                kind="automation",
                level="warning" if problem else "info",
                link=link,
                destination_ids=destinations,
            )
    elif status == "failed":
        retry = int((run.options.get("automation") or {}).get("retry", 0))
        if not run.options.get("no_retry") and retry < automation.max_retries:
            automation.last_status = "retrying"
            await queue.enqueue(
                db,
                "automation.retry",
                {"automation_id": str(automation.id), "retry": retry + 1},
                run_at=_now() + RETRY_DELAY * (2**retry),
                max_attempts=1,
            )
            await db.commit()
        elif notify != "never":
            await notifications.create(
                db,
                title=f"{name} failed",
                body=error or "The run failed.",
                kind="automation",
                level="error",
                link=link,
                destination_ids=destinations,
            )
    await notify_changed()


async def on_needs_approval(db: AsyncSession, run: Run) -> None:
    """An unattended run stopped to ask: tell the user, wherever they are."""
    if run.automation_id is None:
        return
    automation = await db.get(Automation, run.automation_id)
    if automation is None:
        return
    pending = list(
        await db.scalars(
            select(Approval.summary).where(Approval.run_id == run.id, Approval.status == "pending")
        )
    )
    automation.last_status = "waiting"
    await db.commit()
    await notifications.create(
        db,
        title=f"{automation.name} needs your approval",
        body="\n".join(pending) or "An action is waiting for your approval.",
        kind="approval",
        level="warning",
        link=f"/c/{run.conversation_id}" if run.conversation_id else None,
        destination_ids=_destinations(automation),
    )
    await notify_changed()
