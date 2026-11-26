"""Messages for a running Claude Code job (docs/specs/code-sessions.md §15): handed to a job
that takes them (its echo marks them delivered), "send now", withdrawing, and the follow-up
for a job that can't take them or ends first."""

import uuid
from typing import Any

import pytest
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.code_sessions import inbox, messages
from app.features.code_sessions.models import CodeJob, CodeMessage
from app.features.devices import relay
from app.jobs.models import Job
from tests.api.test_code_control import KEY, FakeSend, error_code, row
from tests.api.test_code_sessions import SESSION, announce, init, result, say, send
from tests.api.test_devices import add
from tests.api.test_devices_ws import roundtrip, welcomed
from tests.api.test_extension_events import WsClient
from tests.conftest import requires_db

pytestmark = requires_db

NEXT = "20261124-111500-st02"


async def computer(authed, *, code_input: bool = True, name: str = "PC") -> tuple[dict, WsClient]:  # type: ignore[no-untyped-def]
    device = await add(authed, name, trust="trusted")
    ws, _ = await welcomed(device["token"])
    await ws.send(
        {
            "type": "device.offer",
            "control": True,
            "shell": False,
            "code": True,
            "code_start": True,
            "code_images": True,
            "code_input": code_input,
        }
    )
    await roundtrip(ws)
    return device, ws


@pytest.fixture
def device_side(monkeypatch: pytest.MonkeyPatch) -> FakeSend:
    fake = FakeSend()
    fake.answers["code_input"] = {"state": "sent"}
    fake.answers["code_input_withdraw"] = {"withdrawn": True}
    fake.answers["code_start"] = {"job_id": NEXT, "dir": "C:\\dev\\anemo", "project": "anemo"}
    monkeypatch.setattr(relay, "send", fake)
    return fake


async def running_job(ws: WsClient, *, takes_input: bool = True) -> None:
    await announce(ws, KEY, input=takes_input)
    await send(ws, (1, init()), (2, say("Working.")), key=KEY)


async def stored(message_id: str) -> CodeMessage:
    async with get_sessionmaker()() as db:
        found = await db.get(CodeMessage, uuid.UUID(message_id))
    assert found is not None
    return found


async def kicked() -> list[dict[str, Any]]:
    async with get_sessionmaker()() as db:
        jobs = await db.scalars(select(Job).where(Job.type == inbox.JOB_TYPE))
        return [j.payload for j in jobs]


def replay(text: str, uuid_: str) -> dict[str, Any]:
    return {
        "type": "user",
        "message": {"role": "user", "content": text},
        "isReplay": True,
        "uuid": uuid_,
        "session_id": SESSION,
    }


async def test_a_job_anemo_starts_takes_messages_where_the_computer_can(authed, device_side):
    device, ws = await computer(authed)
    r = await authed.post(
        "/api/code/jobs", json={"device_id": device["id"], "project": "anemo", "prompt": "Go."}
    )
    assert r.status_code == 201
    (action, fields, _) = device_side.sent[-1]
    assert action == "code_start" and fields["input"] is True
    await ws.disconnect()

    older, ws2 = await computer(authed, code_input=False, name="Old PC")
    await authed.post(
        "/api/code/jobs", json={"device_id": older["id"], "project": "anemo", "prompt": "Go."}
    )
    assert "input" not in device_side.sent[-1][1]
    await ws2.disconnect()


async def test_a_message_goes_to_the_running_job_and_its_echo_marks_it_delivered(
    authed, device_side
):
    _, ws = await computer(authed)
    await running_job(ws)
    job = await row()
    assert job.input_mode and job.input_open

    r = await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "Also the docs."})
    assert r.status_code == 201, r.text
    message = r.json()
    assert (message["state"], message["mode"]) == ("sent", "queue")
    (action, fields, _) = device_side.sent[-1]
    claude_uuid = str((await stored(message["id"])).claude_uuid)
    assert action == "code_input"
    assert fields == {
        "job_id": KEY,
        "message_id": claude_uuid,
        "prompt": "Also the docs.",
        "now": False,
    }

    # Claude Code takes it in at its next step and echoes it.
    await send(ws, (3, replay("Also the docs.", claude_uuid)), (4, say("Doing the docs.")), key=KEY)
    detail = (await authed.get(f"/api/code/jobs/{job.id}")).json()
    (shown,) = detail["messages"]
    assert (shown["state"], shown["delivered_seq"]) == ("delivered", 3)
    assert shown["delivered_at"] is not None
    # A delivered one can't be taken back.
    r = await authed.delete(f"/api/code/messages/{message['id']}")
    assert r.status_code == 409 and error_code(r) == "message_delivered"
    await ws.disconnect()


async def test_send_now_interrupts_the_current_step(authed, device_side):
    _, ws = await computer(authed)
    await running_job(ws)
    job = await row()
    r = await authed.post(
        f"/api/code/jobs/{job.id}/messages", json={"prompt": "Stop, this first.", "now": True}
    )
    assert r.json()["mode"] == "now" and r.json()["state"] == "sent"
    assert device_side.sent[-1][1]["now"] is True

    # A queued one can be sent now: withdrawn, then sent again with an interrupt.
    queued = (
        await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "Later."})
    ).json()
    before = (await stored(queued["id"])).claude_uuid
    r = await authed.post(f"/api/code/messages/{queued['id']}/now")
    assert r.status_code == 200 and r.json()["state"] == "sent"
    actions = [a for a, _, _ in device_side.sent]
    assert actions[-2:] == ["code_input_withdraw", "code_input"]
    assert device_side.sent[-2][1]["message_id"] == str(before)
    assert device_side.sent[-1][1]["now"] is True
    assert (await stored(queued["id"])).claude_uuid != before
    await ws.disconnect()


async def test_removing_a_message_withdraws_it_from_the_job(authed, device_side):
    _, ws = await computer(authed)
    await running_job(ws)
    job = await row()
    first = (await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "A"})).json()
    r = await authed.delete(f"/api/code/messages/{first['id']}")
    assert r.status_code == 204
    assert device_side.sent[-1][0] == "code_input_withdraw"
    assert (await authed.get(f"/api/code/jobs/{job.id}")).json()["messages"] == []

    # Claude Code took it in meanwhile: it stays.
    device_side.answers["code_input_withdraw"] = {"withdrawn": False}
    second = (await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "B"})).json()
    r = await authed.delete(f"/api/code/messages/{second['id']}")
    assert r.status_code == 409 and error_code(r) == "message_delivered"
    assert (await stored(second["id"])).state == "sent"
    await ws.disconnect()


async def test_a_job_that_cant_take_messages_gets_them_as_its_follow_up(authed, device_side):
    _, ws = await computer(authed)
    await running_job(ws, takes_input=False)
    job = await row()
    one = (await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "One"})).json()
    two = (await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "Two"})).json()
    assert one["state"] == "queued" and "follow-up" in (one["note"] or "")
    assert all(a != "code_input" for a, _, _ in device_side.sent)

    # The job ends: the worker is kicked, and the messages go as one follow-up.
    await send(ws, (3, result()), key=KEY)
    await announce(ws, KEY, state="done")
    assert await kicked() == [{"thread_id": str(job.thread_id)}]
    await messages.run_job(job.thread_id)
    (action, fields, _) = device_side.sent[-1]
    assert action == "code_start"
    assert fields["prompt"] == "One\n\nTwo"
    assert fields["resume_session"] == SESSION and fields["follow_job_id"] == KEY
    follow = await row(NEXT)
    for sent in (one, two):
        message = await stored(sent["id"])
        assert (message.state, message.follow_up_job_id) == ("followed_up", follow.id)
    await ws.disconnect()


async def test_a_message_for_an_ended_thread_follows_up_at_once(authed, device_side):
    _, ws = await computer(authed)
    await running_job(ws)
    await send(ws, (3, result()), key=KEY)
    await announce(ws, KEY, state="done")
    job = await row()
    r = await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "More."})
    assert r.json()["state"] == "followed_up"
    assert device_side.sent[-1][0] == "code_start"
    await ws.disconnect()


async def test_send_now_for_a_job_that_cant_take_it_cancels_the_job(authed, device_side):
    _, ws = await computer(authed)
    await running_job(ws, takes_input=False)
    job = await row()
    device_side.answers["code_cancel"] = {"job_id": KEY, "state": "cancelled"}
    r = await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "Now!", "now": True})
    assert r.status_code == 201
    actions = [a for a, _, _ in device_side.sent]
    # Cancelled, so the job ended: the message followed it up right away.
    assert actions[-2:] == ["code_cancel", "code_start"]
    assert (await stored(r.json()["id"])).state == "followed_up"
    await ws.disconnect()


async def test_after_a_failed_job_a_message_is_held_until_sent_now(authed, device_side):
    _, ws = await computer(authed)
    await running_job(ws, takes_input=False)
    job = await row()
    sent = (await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "Next"})).json()
    await send(ws, (3, result(is_error=True)), key=KEY)
    await announce(ws, KEY, state="failed")
    await messages.run_job(job.thread_id)
    held = await stored(sent["id"])
    assert held.state == "held" and "didn’t finish" in (held.note or "")
    assert all(a != "code_start" for a, _, _ in device_side.sent)

    r = await authed.post(f"/api/code/messages/{sent['id']}/now")
    assert r.json()["state"] == "followed_up"
    assert device_side.sent[-1][0] == "code_start"
    await ws.disconnect()


async def test_a_job_that_takes_messages_isnt_ended_by_a_result(authed, device_side):
    _, ws = await computer(authed)
    await running_job(ws)
    await send(ws, (3, result()), key=KEY)
    assert (await row()).state == "running"
    # The client says when it ended (its last result); it no longer takes messages then.
    await announce(ws, KEY, state="done", input=False)
    ended = await row()
    assert ended.state == "done" and not ended.input_open
    await ws.disconnect()


async def test_messages_wait_for_the_computer_and_the_scheduler_kicks_them(authed, device_side):
    device, ws = await computer(authed)
    await running_job(ws, takes_input=False)
    job = await row()
    sent = (await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "Later"})).json()
    await send(ws, (3, result()), key=KEY)
    await announce(ws, KEY, state="done")
    await ws.disconnect()  # gone before the worker ran
    await messages.run_job(job.thread_id)
    waiting = await stored(sent["id"])
    assert waiting.state == "queued" and "Waiting for the computer" in (waiting.note or "")

    async with get_sessionmaker()() as db:
        await db.execute(Job.__table__.delete())
        await db.commit()
    await messages.due()
    assert await kicked() == []  # still away
    back, _ = await welcomed(device["token"])
    await back.send(
        {"type": "device.offer", "control": True, "shell": False, "code": True, "code_start": True}
    )
    await roundtrip(back)
    await messages.due()
    assert await kicked() == [{"thread_id": str(job.thread_id)}]
    await messages.run_job(job.thread_id)
    assert (await stored(sent["id"])).state == "followed_up"
    await back.disconnect()


async def test_a_message_takes_the_limits_of_a_prompt(authed, device_side):
    _, ws = await computer(authed)
    await running_job(ws)
    job = await row()
    r = await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": ""})
    assert r.status_code == 422
    r = await authed.post(f"/api/code/jobs/{uuid.uuid4()}/messages", json={"prompt": "Hello"})
    assert r.status_code == 404
    assert (await authed.delete(f"/api/code/messages/{uuid.uuid4()}")).status_code == 404
    await ws.disconnect()


async def test_deleting_the_job_deletes_its_messages(authed, device_side):
    device, ws = await computer(authed)
    await running_job(ws)
    job = await row()
    sent = (await authed.post(f"/api/code/jobs/{job.id}/messages", json={"prompt": "A"})).json()
    await ws.disconnect()
    assert (await authed.delete(f"/api/devices/{device['id']}")).status_code == 204
    async with get_sessionmaker()() as db:
        assert await db.get(CodeMessage, uuid.UUID(sent["id"])) is None
        assert await db.scalar(select(CodeJob).where(CodeJob.job_key == KEY)) is None
