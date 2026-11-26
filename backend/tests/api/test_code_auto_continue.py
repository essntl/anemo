"""Auto continue after the usage limit (docs/specs/code-sessions.md §16): a job that
stopped at the limit resumes its session by itself once the limit resets, as soon as its
computer is there, at most a few times in a row, and never against what the user did."""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select, update

from app.core.db import get_sessionmaker
from app.features.code_sessions import autocontinue, resume
from app.features.code_sessions.models import CodeJob
from app.features.devices import relay
from app.features.notifications.models import Notification
from app.jobs.models import Job
from tests.api.test_code_control import KEY, FakeSend, error_code, row
from tests.api.test_code_messages import NEXT, computer
from tests.api.test_code_sessions import SESSION, announce, init, result, say, send
from tests.api.test_extension_events import WsClient
from tests.conftest import requires_db

pytestmark = requires_db

RESETS = datetime(2030, 1, 1, 17, 0, tzinfo=UTC)


@pytest.fixture
def device_side(monkeypatch: pytest.MonkeyPatch) -> FakeSend:
    fake = FakeSend()
    fake.answers["code_start"] = {"job_id": NEXT, "dir": "C:\\dev\\anemo", "project": "anemo"}
    fake.answers["code_input"] = {"state": "sent"}
    monkeypatch.setattr(relay, "send", fake)
    return fake


def rejected(resets: datetime = RESETS) -> dict[str, Any]:
    at = int(resets.timestamp())
    return {
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "rejected",
            "resetsAt": at,
            "rateLimitType": "five_hour",
            "unifiedWindows": {
                "five_hour": {"utilization": 1.02, "resetsAt": at, "status": "rejected"},
                "seven_day": {"utilization": 0.1, "resetsAt": at + 86400, "status": "allowed"},
            },
        },
    }


def limit_result(text: str = "You've hit your 5-hour limit · resets 6pm (Europe/Berlin)") -> dict:
    return result(
        "success",
        is_error=True,
        api_error_status=429,
        terminal_reason="api_error",
        result=text,
        num_turns=12,
    )


async def stopped_at_limit(ws: WsClient, key: str = KEY, *, with_event: bool = True) -> None:
    await announce(ws, key)
    events: list[tuple[int, dict[str, Any]]] = [(1, init()), (2, say("Working."))]
    if with_event:
        events.append((3, rejected()))
    events.append((len(events) + 1, limit_result()))
    await send(ws, *events, key=key)
    await announce(ws, key, state="failed")


async def continues() -> list[dict[str, Any]]:
    async with get_sessionmaker()() as db:
        jobs = await db.scalars(select(Job).where(Job.type == autocontinue.JOB_TYPE))
        return [j.payload for j in jobs]


async def make_due(key: str = KEY) -> None:
    async with get_sessionmaker()() as db:
        await db.execute(
            update(CodeJob)
            .where(CodeJob.job_key == key)
            .values(resume_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await db.commit()


async def test_the_limit_and_its_reset_are_read_and_the_switch_schedules_it(authed, device_side):
    _, ws = await computer(authed)
    await stopped_at_limit(ws)
    job = await row()
    assert job.state == "failed" and job.limit_hit
    assert job.limit_resets_at == RESETS  # the rate_limit_event's, not the text's
    assert job.resume_state is None  # Auto continue is off by default
    async with get_sessionmaker()() as db:
        sent = await db.scalar(select(Notification).order_by(Notification.created_at.desc()))
    assert sent is not None and sent.title.startswith("Claude Code job stopped at the usage limit")
    assert sent.level == "warning"

    r = await authed.put(f"/api/code/jobs/{job.id}/auto-continue", json={"enabled": True})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["limit_hit"] is True and out["resume_state"] == "scheduled"
    assert out["resume_at"] == (RESETS + resume.MARGIN).isoformat().replace("+00:00", "Z")
    r = await authed.put(f"/api/code/jobs/{job.id}/auto-continue", json={"enabled": False})
    assert r.json()["resume_state"] == "cancelled" and r.json()["resume_at"] is None
    await ws.disconnect()


async def test_only_a_job_stopped_at_the_limit_can_continue_by_itself(authed, device_side):
    _, ws = await computer(authed)
    await announce(ws, KEY)
    await send(ws, (1, init()), (2, result()), key=KEY)
    job = await row()
    r = await authed.put(f"/api/code/jobs/{job.id}/auto-continue", json={"enabled": True})
    assert r.status_code == 409 and error_code(r) == "not_limited"
    await ws.disconnect()


async def test_with_the_setting_on_it_continues_at_the_reset_in_the_same_session(
    authed, device_side
):
    assert (await authed.put("/api/settings/code", json={"auto_continue": True})).status_code == 200
    _, ws = await computer(authed)
    await stopped_at_limit(ws)
    job = await row()
    assert job.resume_state == "scheduled" and job.resume_at == RESETS + resume.MARGIN

    await autocontinue.due()
    assert await continues() == []  # not yet
    await make_due()
    await autocontinue.due()
    assert await continues() == [{"job_id": str(job.id)}]
    await autocontinue.run(job.id)
    (action, fields, _) = device_side.sent[-1]
    assert action == "code_start"
    assert fields["prompt"] == autocontinue.PROMPT
    assert fields["resume_session"] == SESSION and fields["follow_job_id"] == KEY
    old, new = await row(), await row(NEXT)
    assert (old.resume_state, old.resumed_job_id) == ("started", new.id)
    assert (new.resumed_from, new.resume_attempt, new.thread_id) == (old.id, 1, old.thread_id)
    # Once only: a second run does nothing.
    await autocontinue.run(job.id)
    assert [a for a, _, _ in device_side.sent].count("code_start") == 1
    await ws.disconnect()


async def test_it_waits_for_the_computer(authed, device_side):
    assert (await authed.put("/api/settings/code", json={"auto_continue": True})).status_code == 200
    _, ws = await computer(authed)
    await stopped_at_limit(ws)
    await ws.disconnect()
    await make_due()
    await autocontinue.due()
    assert await continues() == []
    assert (await row()).resume_state == "scheduled"  # still waiting, for when it is back


async def test_a_computer_busy_at_the_time_is_tried_again(authed, device_side):
    _, ws = await computer(authed)
    await stopped_at_limit(ws)
    job = await row()
    await authed.put(f"/api/code/jobs/{job.id}/auto-continue", json={"enabled": True})
    device_side.answers["code_start"] = relay.Busy("busy")
    await autocontinue.run(job.id)
    assert (await row()).resume_state == "scheduled"
    await ws.disconnect()


async def test_hitting_the_limit_again_at_once_is_tried_once_more_later_and_never_endlessly(
    authed, device_side
):
    _, ws = await computer(authed)
    await stopped_at_limit(ws)
    first = await row()
    await authed.put(f"/api/code/jobs/{first.id}/auto-continue", json={"enabled": True})
    await autocontinue.run(first.id)
    # The continue stopped at the limit again right away, with no reset time known.
    await announce(ws, NEXT, resume_session=SESSION)
    await send(ws, (1, init()), (2, limit_result("You've hit your limit")), key=NEXT)
    async with get_sessionmaker()() as db:
        await db.execute(update(CodeJob).where(CodeJob.job_key == NEXT).values(num_turns=1))
        await db.commit()
    await announce(ws, NEXT, state="failed", resume_session=SESSION)
    again = await row(NEXT)
    assert again.resume_state == "scheduled"  # it goes on by itself, the setting is off
    assert again.resume_at is not None
    assert again.resume_at - datetime.now(UTC) > resume.RETRY_AFTER - timedelta(minutes=1)

    # The third in a row is the last.
    capped = await row(NEXT)
    capped.resume_attempt = resume.MAX_IN_A_ROW
    assert resume.schedule(capped) is False and capped.resume_state == "stopped"
    await ws.disconnect()


async def test_a_message_meanwhile_cancels_it_and_goes_as_the_follow_up(authed, device_side):
    _, ws = await computer(authed)
    await stopped_at_limit(ws)
    job = await row()
    await authed.put(f"/api/code/jobs/{job.id}/auto-continue", json={"enabled": True})
    r = await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "Do X first."})
    # A job that stopped at the limit doesn't hold the message: it follows up.
    assert r.json()["state"] == "followed_up"
    cancelled = await row()
    assert cancelled.resume_state == "cancelled"
    assert cancelled.resume_note == "You sent a message meanwhile."
    assert device_side.sent[-1][1]["prompt"] == "Do X first."
    await ws.disconnect()


async def test_cancel_and_a_follow_up_by_hand_cancel_it_too(authed, device_side):
    _, ws = await computer(authed)
    await stopped_at_limit(ws)
    job = await row()
    await authed.put(f"/api/code/jobs/{job.id}/auto-continue", json={"enabled": True})
    r = await authed.post(f"/api/code/jobs/{job.id}/cancel")
    assert r.json()["resume_state"] == "cancelled"

    await authed.put(f"/api/code/jobs/{job.id}/auto-continue", json={"enabled": True})
    r = await authed.post(f"/api/code/jobs/{job.id}/follow-up", json={"prompt": "Go on."})
    assert r.status_code == 201
    assert (await row()).resume_note == "You continued the thread yourself."
    await ws.disconnect()


async def test_without_a_rejected_event_the_reset_is_read_from_the_text(authed, device_side):
    _, ws = await computer(authed)
    await stopped_at_limit(ws, with_event=False)
    job = await row()
    assert job.limit_hit and job.limit_resets_at is not None
    # "resets 6pm (Europe/Berlin)": 17:00 UTC in winter, the next one after now.
    assert job.limit_resets_at.astimezone(UTC).hour in (16, 17)
    assert job.limit_resets_at > datetime.now(UTC) - timedelta(minutes=1)
    await ws.disconnect()


async def test_a_newer_job_in_the_thread_cancels_it(authed, device_side):
    _, ws = await computer(authed)
    await stopped_at_limit(ws)
    job = await row()
    await authed.put(f"/api/code/jobs/{job.id}/auto-continue", json={"enabled": True})
    # A job of the same session started elsewhere (cc.ps1) joins the thread.
    await announce(ws, NEXT, resume_session=SESSION)
    await make_due()
    await autocontinue.due()
    assert await continues() == []
    assert (await row()).resume_note == "A newer job ran in this thread."
    await ws.disconnect()


async def test_code_status_tells_the_agent_where_a_limited_job_stands(authed, device_side):
    from app.core.db import get_sessionmaker as sessions
    from app.features.code_sessions import service
    from app.tools.builtin import code as code_tools

    _, ws = await computer(authed)
    await stopped_at_limit(ws)
    job = await row()
    async with sessions()() as db:
        shaped = await service.one_out(db, job.id)
    assert shaped is not None
    assert code_tools.limit_line(shaped) == (
        "It stopped at the Claude subscription's usage limit, which resets at "
        "2030-01-01T17:00+00:00. Auto continue is off: follow it up when the limit has reset."
    )
    await authed.put(f"/api/code/jobs/{job.id}/auto-continue", json={"enabled": True})
    async with sessions()() as db:
        shaped = await service.one_out(db, job.id)
    assert shaped is not None
    assert code_tools.limit_line(shaped).endswith(
        "It continues by itself at 2030-01-01T17:02+00:00."
    )
    await ws.disconnect()


async def test_messages_written_before_the_stop_go_with_the_continue(authed, device_side):
    from tests.api.test_code_messages import running_job, stored

    assert (await authed.put("/api/settings/code", json={"auto_continue": True})).status_code == 200
    _, ws = await computer(authed)
    await running_job(ws)  # takes messages
    job = await row()
    sent = (
        await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "And X."})
    ).json()
    assert sent["state"] == "sent"
    # Claude Code stops at the limit before it took the message in.
    await send(ws, (3, rejected()), (4, limit_result()), key=KEY)
    await announce(ws, KEY, state="failed", input=False)
    from app.features.code_sessions import messages

    await messages.run_job(job.thread_id)  # the kick of the job's end
    waiting = await stored(sent["id"])
    assert waiting.state == "sent" and "continue" in (waiting.note or "")
    assert [a for a, _, _ in device_side.sent].count("code_start") == 0

    await make_due()
    await autocontinue.run(job.id)
    (action, fields, _) = device_side.sent[-1]
    assert action == "code_start"
    assert fields["prompt"] == f"{autocontinue.PROMPT}\n\nAnd X."
    message = await stored(sent["id"])
    assert (message.state, message.follow_up_job_id) == ("followed_up", (await row(NEXT)).id)
    await ws.disconnect()
