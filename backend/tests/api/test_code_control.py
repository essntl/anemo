"""Phase 2 of the Code page: starting, following up and cancelling Claude Code jobs, the
computers' offers, and the agent tools (docs/specs/code-sessions.md §12)."""

import asyncio
import uuid
from typing import Any

import pytest
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.code_sessions import control
from app.features.code_sessions.models import CodeJob
from app.features.devices import relay
from app.features.notifications.models import Notification
from app.policy.presets import CATEGORY_BY_CAP
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.tools.builtin import code as code_tools
from app.tools.builtin.web import UNTRUSTED
from tests.api.test_agent import agent_turn, call, script, setup, timeline
from tests.api.test_code_sessions import announce, init, result, say, send
from tests.api.test_devices import add
from tests.api.test_devices_ws import roundtrip, welcomed
from tests.api.test_extension_events import WsClient
from tests.conftest import requires_db

pytestmark = requires_db

KEY = "20261124-101500-st01"
STARTED = {"job_id": KEY, "dir": "C:\\dev\\anemo", "project": "anemo"}


async def computer(  # type: ignore[no-untyped-def]
    authed,
    name: str = "PC",
    trust: str = "trusted",
    *,
    share: bool = True,
    start: bool = True,
    control: bool = True,
) -> tuple[dict, WsClient]:
    device = await add(authed, name, trust=trust)
    ws, _ = await welcomed(device["token"])
    await offer(ws, share=share, start=start, control=control)
    return device, ws


async def offer(
    ws: WsClient, *, share: bool = True, start: bool = True, control: bool = True
) -> None:
    await ws.send(
        {
            "type": "device.offer",
            "control": control,  # "Allow control" on and not paused
            "shell": False,
            "code": share,
            "code_start": start,
        }
    )
    await roundtrip(ws)


class FakeSend:
    """relay.send, answered as a computer would."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, dict[str, Any], float]] = []
        self.answers: dict[str, Any] = {
            "code_start": STARTED,
            "code_cancel": {"job_id": KEY, "state": "cancelled"},
            "code_projects": {"projects": [], "remote": [], "note": None},
        }

    async def __call__(
        self, device_id: uuid.UUID, action: str, fields: dict[str, Any], timeout_s: float = 90
    ) -> dict[str, Any]:
        self.sent.append((action, fields, timeout_s))
        answer = self.answers[action]
        if isinstance(answer, Exception):
            raise answer
        return dict(answer)


@pytest.fixture
def device_side(monkeypatch: pytest.MonkeyPatch) -> FakeSend:
    fake = FakeSend()
    monkeypatch.setattr(relay, "send", fake)
    return fake


def error_code(r: Any) -> str:
    return str(r.json()["error"]["code"])


async def row(key: str = KEY) -> CodeJob:
    async with get_sessionmaker()() as db:
        job = await db.scalar(select(CodeJob).where(CodeJob.job_key == key))
    assert job is not None
    return job


# -- offers and computers --------------------------------------------------------------------


async def test_the_offer_says_whether_anemo_may_start_jobs(authed):
    device, ws = await computer(authed)
    offered = await relay.online(uuid.UUID(device["id"]))
    assert offered == relay.Offer(control=True, shell=False, code=True, code_start=True)
    await ws.send({"type": "device.offer", "control": False, "shell": False, "code": True})
    await roundtrip(ws)  # an older client: no code_start, so off
    offered = await relay.online(uuid.UUID(device["id"]))
    assert offered is not None and offered.code_start is False
    await ws.disconnect()


async def test_the_trusted_computers_and_what_they_offer(authed):
    _, starts = await computer(authed, "A")
    _, shares = await computer(authed, "B", start=False)
    await add(authed, "C", trust="trusted")  # offline
    _, watched = await computer(authed, "W", trust="watched")
    await add(authed, "Phone", kind="phone", trust="trusted")
    listed = (await authed.get("/api/code/devices")).json()
    assert [(d["name"], d["online"], d["share"], d["start"]) for d in listed] == [
        ("A", True, True, True),
        ("B", True, True, False),
        ("C", False, False, False),
    ]
    # A job's device says the same.
    await announce(starts)
    (job,) = (await authed.get("/api/code/jobs")).json()["jobs"]
    assert (job["device"]["share"], job["device"]["start"]) == (True, True)
    assert (job["conversation_id"], job["run_id"], job["conversation_title"]) == (None, None, None)
    for ws in (starts, shares, watched):
        await ws.disconnect()


async def test_projects_through_the_computer(authed):
    device, ws = await computer(authed)
    answer = {
        "projects": [{"name": "anemo", "dir": "C:\\dev\\anemo", "remote": None}],
        "remote": [{"name": "site", "url": "https://github.com/essntl/site"}],
        "note": None,
    }
    asking = asyncio.create_task(authed.get(f"/api/code/devices/{device['id']}/projects"))
    command = await ws.json()
    assert (command["type"], command["action"]) == ("device.command", "code_projects")
    await ws.send({"type": "device.result", "id": command["id"], "ok": True, "state": answer})
    r = await asking
    assert r.status_code == 200, r.text
    assert r.json() == answer
    await ws.disconnect()


async def test_what_a_computer_must_be(authed, device_side):
    _, watched = await computer(authed, "W", trust="watched")
    _, sharing = await computer(authed, "S", start=False)
    _, closed = await computer(authed, "N", share=False, start=False)
    offline = await add(authed, "Off", trust="trusted")
    phone = await add(authed, "Phone", kind="phone", trust="trusted")
    devices = {d["name"]: d["id"] for d in (await authed.get("/api/devices")).json()}

    def start(name: str) -> Any:
        body = {"device_id": devices[name], "project": "anemo", "prompt": "Hi"}
        return authed.post("/api/code/jobs", json=body)

    r = await start("W")
    assert (r.status_code, error_code(r)) == (403, "device_not_trusted")
    r = await start("S")
    assert (r.status_code, error_code(r)) == (409, "code_start_off")
    assert "Let Anemo start Claude Code jobs" in r.json()["error"]["message"]
    r = await start("N")
    assert (r.status_code, error_code(r)) == (409, "code_start_off")
    r = await start("Off")
    assert (r.status_code, error_code(r)) == (409, "device_offline")
    r = await start("Phone")
    assert (r.status_code, error_code(r)) == (404, "not_found")
    # Projects need sharing only.
    r = await authed.get(f"/api/code/devices/{devices['S']}/projects")
    assert r.status_code == 200
    r = await authed.get(f"/api/code/devices/{devices['N']}/projects")
    assert (r.status_code, error_code(r)) == (409, "code_start_off")
    r = await authed.get(f"/api/code/devices/{offline['id']}/projects")
    assert (r.status_code, error_code(r)) == (409, "device_offline")
    r = await authed.get(f"/api/code/devices/{uuid.uuid4()}/projects")
    assert r.status_code == 404
    assert [action for action, _, _ in device_side.sent] == ["code_projects"]
    assert phone
    for ws in (watched, sharing, closed):
        await ws.disconnect()


# -- starting --------------------------------------------------------------------------------


async def test_starting_a_job_through_the_computer(authed):
    device, ws = await computer(authed)
    body = {
        "device_id": device["id"],
        "project": "anemo",
        "prompt": "Fix the login bug\nand add a test",
        "model": "opus",
        "max_turns": 30,
    }
    starting = asyncio.create_task(authed.post("/api/code/jobs", json=body))
    command = await ws.json()
    assert command["action"] == "code_start"
    assert {k: command[k] for k in ("project", "prompt", "new", "resume_session", "model")} == {
        "project": "anemo",
        "prompt": body["prompt"],
        "new": False,
        "resume_session": None,
        "model": "opus",
    }
    assert command["max_turns"] == 30
    await ws.send({"type": "device.result", "id": command["id"], "ok": True, "state": STARTED})
    r = await starting
    assert r.status_code == 201, r.text
    job = r.json()
    assert (job["job_key"], job["state"], job["dir"], job["project"]) == (
        KEY,
        "running",
        "C:\\dev\\anemo",
        "anemo",
    )
    assert (job["title"], job["model"], job["thread_id"]) == (
        "Fix the login bug",
        "opus",
        job["id"],
    )
    # The client's own code.job then fills in the rest; the job notifies when it ends.
    assert await announce(ws, KEY, prompt=body["prompt"]) == 0
    await send(ws, (1, init()), (2, result()), key=KEY)
    async with get_sessionmaker()() as db:
        titles = list(await db.scalars(select(Notification.title)))
    assert titles == ["Claude Code job finished: Fix the login bug"]
    await ws.disconnect()


async def test_start_errors(authed, device_side):
    device, ws = await computer(authed)
    body = {"device_id": device["id"], "project": "anemo", "prompt": "Hi"}
    device_side.answers["code_start"] = relay.ActionFailed(
        "There is no project “anemo” in C:\\dev or on GitHub (essntl)."
    )
    r = await authed.post("/api/code/jobs", json=body)
    assert (r.status_code, error_code(r)) == (422, "device_failed")
    assert r.json()["error"]["message"].startswith("There is no project")
    device_side.answers["code_start"] = relay.Refused("Starting jobs is off.")
    r = await authed.post("/api/code/jobs", json=body)
    assert (r.status_code, error_code(r)) == (403, "device_refused")
    device_side.answers["code_start"] = relay.Unavailable("The device didn't answer in time")
    r = await authed.post("/api/code/jobs", json=body)
    assert (r.status_code, error_code(r)) == (409, "device_offline")
    device_side.answers["code_start"] = {"job_id": "../evil"}
    r = await authed.post("/api/code/jobs", json=body)
    assert (r.status_code, error_code(r)) == (422, "device_failed")
    for bad in (
        {"project": ".."},
        {"project": "a/b"},
        {"project": "."},
        {"prompt": ""},
        {"model": "opus; rm"},
        {"max_turns": 0},
        {"max_turns": 501},
    ):
        r = await authed.post("/api/code/jobs", json={**body, **bad})
        assert r.status_code == 422 and error_code(r) == "validation_error", bad
    assert (await authed.get("/api/code/jobs")).json()["jobs"] == []
    timeouts = {action: timeout for action, _, timeout in device_side.sent}
    assert timeouts == {"code_start": 660.0}
    await ws.disconnect()


async def test_the_starter_is_kept_when_the_client_reports(authed, device_side):
    device, ws = await computer(authed)
    cid = (await authed.post("/api/conversations", json={"title": "Login fixes"})).json()["id"]
    async with get_sessionmaker()() as db:
        started = await control.start_job(
            db,
            device_id=uuid.UUID(device["id"]),
            project="anemo",
            prompt="Fix it",
            conversation_id=uuid.UUID(cid),
        )
    assert str(started.conversation_id) == cid and started.conversation_title is not None
    # The client's code.job and events never replace who started it.
    await announce(ws, KEY, prompt="Fix it")
    await send(ws, (1, init()), (2, say("On it")), key=KEY)
    job = (await authed.get(f"/api/code/jobs/{started.id}")).json()["job"]
    assert job["conversation_id"] == cid and job["conversation_title"] == started.conversation_title
    assert job["started_at"].startswith("2026-11-23T09:15:00")  # the client's time now
    # The client may report first (its scan found the folder before the answer came).
    early = "20261124-111500-st02"
    await announce(ws, early, prompt="Second")
    device_side.answers["code_start"] = {**STARTED, "job_id": early}
    async with get_sessionmaker()() as db:
        second = await control.start_job(
            db,
            device_id=uuid.UUID(device["id"]),
            project="anemo",
            prompt="Second",
            conversation_id=uuid.UUID(cid),
        )
    assert second.job_key == early and str(second.conversation_id) == cid
    assert len((await authed.get("/api/code/jobs")).json()["jobs"]) == 2
    await ws.disconnect()


async def test_follow_ups(authed, device_side):
    device, ws = await computer(authed)
    first = "20261124-090000-fu01"
    await announce(ws, first, started="2026-11-20T09:00:00Z")
    job_id = (await authed.get("/api/code/jobs")).json()["jobs"][0]["id"]
    body = {"prompt": "Now add docs"}
    r = await authed.post(f"/api/code/jobs/{job_id}/follow-up", json=body)
    assert (r.status_code, error_code(r)) == (409, "job_running")
    await announce(ws, first, started="2026-11-20T09:00:00Z", state="exited_without_result")
    r = await authed.post(f"/api/code/jobs/{job_id}/follow-up", json=body)
    assert (r.status_code, error_code(r)) == (409, "no_session")
    await send(ws, (1, init("s-first")), key=first)

    device_side.answers["code_start"] = {**STARTED, "job_id": "20261124-100000-fu02"}
    r = await authed.post(f"/api/code/jobs/{job_id}/follow-up", json={**body, "model": "sonnet"})
    assert r.status_code == 201, r.text
    second = r.json()
    assert second["thread_id"] == job_id and second["resume_session"] == "s-first"
    action, fields, _ = device_side.sent[-1]
    assert action == "code_start"
    assert (fields["project"], fields["resume_session"], fields["model"]) == (
        "anemo",
        "s-first",
        "sonnet",
    )
    # The computer runs it in the folder of the job it follows (§12.5).
    assert fields["follow_job_id"] == first
    # A follow-up of the first job resumes the thread's last one: it is running now.
    r = await authed.post(f"/api/code/jobs/{job_id}/follow-up", json=body)
    assert (r.status_code, error_code(r)) == (409, "job_running")
    detail = (await authed.get(f"/api/code/jobs/{job_id}")).json()
    assert [j["job_key"] for j in detail["thread"]] == [first, "20261124-100000-fu02"]
    r = await authed.post(f"/api/code/jobs/{uuid.uuid4()}/follow-up", json=body)
    assert r.status_code == 404
    await ws.disconnect()


async def test_cancelling(authed, device_side):
    _, ws = await computer(authed)
    await announce(ws, KEY)
    job_id = (await authed.get("/api/code/jobs")).json()["jobs"][0]["id"]
    r = await authed.post(f"/api/code/jobs/{job_id}/cancel")
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "cancelled"
    assert device_side.sent == [("code_cancel", {"job_id": KEY}, 30.0)]
    # An ended job is returned as it is, without asking the computer.
    r = await authed.post(f"/api/code/jobs/{job_id}/cancel")
    assert r.status_code == 200 and r.json()["state"] == "cancelled"
    assert len(device_side.sent) == 1
    # The computer says it had ended already: that state, by the usual rules.
    other = "20261124-121500-cc02"
    await announce(ws, other)
    other_id = next(
        j["id"]
        for j in (await authed.get("/api/code/jobs")).json()["jobs"]
        if j["job_key"] == other
    )
    device_side.answers["code_cancel"] = {"job_id": other, "state": "done"}
    assert (await authed.post(f"/api/code/jobs/{other_id}/cancel")).json()["state"] == "done"
    # A running job on a computer that went offline.
    third = "20261124-131500-cc03"
    await announce(ws, third)
    third_id = next(
        j["id"]
        for j in (await authed.get("/api/code/jobs")).json()["jobs"]
        if j["job_key"] == third
    )
    await ws.disconnect()
    r = await authed.post(f"/api/code/jobs/{third_id}/cancel")
    assert (r.status_code, error_code(r)) == (409, "device_offline")
    assert (await authed.post(f"/api/code/jobs/{uuid.uuid4()}/cancel")).status_code == 404


# -- the agent tools -------------------------------------------------------------------------


def test_the_categories_and_their_defaults():
    assert CATEGORY_BY_CAP["code.see"].label == "See Claude Code jobs"
    assert CATEGORY_BY_CAP["code.run"].label == "Start and cancel Claude Code jobs"
    assert CATEGORY_BY_CAP["code.see"].default == "autonomous"
    assert CATEGORY_BY_CAP["code.run"].default == "autonomous"
    assert {t.capability for t in code_tools.CODE_TOOLS} == set(code_tools.CODE_CAPS)


def test_what_the_calls_would_do():
    ctx = code_tools.ToolContext(run_id=uuid.uuid4(), emit=None)  # type: ignore[arg-type]
    ctx.state["computers"] = {"w": {"id": "x", "name": "W", "trust": "watched"}}
    start = code_tools.CodeStart()
    (action,) = start.actions(
        code_tools.StartInput(device="PC", project="anemo", prompt="x" * 300), ctx
    )
    assert (action.capability, action.resource, action.risk) == (
        "code.run",
        "device:PC/project:anemo",
        "moderate",
    )
    assert action.summary == f"Start a Claude Code job on PC in anemo: “{'x' * 119}…”"
    (watched,) = start.actions(code_tools.StartInput(device="w", project="anemo", prompt="Hi"), ctx)
    assert watched.summary.endswith("(refused: a watched computer)")
    (see,) = code_tools.CodeStatus().actions(code_tools.JobInput(job_id=KEY), ctx)
    assert (see.capability, see.risk) == ("code.see", "safe")


async def test_an_agent_starts_a_job_and_follows_it(authed, device_side):
    device, ws = await computer(authed, "Desk PC")
    cid = await setup(authed)
    script(
        "fix the login",
        [
            call("code_start", device="desk pc", project="anemo", prompt="Fix the login bug"),
            Done("tool_use"),
        ],
        [call("code_status", job_id=KEY), Done("tool_use")],
        [TextDelta("Started."), Done("end")],
    )
    secret_tail = "THE-END-OF-A-LONG-LINE"
    run_id = await agent_turn(authed, cid, "fix the login")
    # The status call ran right after the start; check what the model got.
    calls = (await timeline(authed, run_id))["tool_calls"]
    assert [c["tool_name"] for c in calls] == ["code_start", "code_status"]
    started, status = calls
    assert started["status"] == "succeeded", started
    job = await row()
    assert (job.conversation_id, job.run_id) == (uuid.UUID(cid), uuid.UUID(run_id))
    assert started["result_data"] == {"code_job_id": str(job.id)}
    assert str(job.id) in started["result"]
    assert status["result_data"] == {"code_job_id": str(job.id)}
    assert UNTRUSTED in status["result"]

    # Events arrive; the status shows a summary, never the whole log.
    await announce(ws, KEY, prompt="Fix the login bug")
    long = "x" * 5000 + secret_tail
    await send(
        ws,
        (1, init()),
        (2, say(long)),
        (3, result(result="Fixed in https://github.com/essntl/anemo/pull/9")),
        key=KEY,
    )
    job = await row()
    assert (job.conversation_id, job.run_id) == (uuid.UUID(cid), uuid.UUID(run_id))
    script(
        "how is it",
        [call("code_status", job_id=str(job.id)), Done("tool_use")],
        [TextDelta("Done."), Done("end")],
    )
    run2 = await agent_turn(authed, cid, "how is it")
    (status,) = (await timeline(authed, run2))["tool_calls"]
    content = status["result"]
    assert UNTRUSTED in content and "done" in content and "Wrote: xxx" in content
    assert secret_tail not in content and len(content) < 3000
    assert "Fixed in https://github.com/essntl/anemo/pull/9" in content
    assert "API-equivalent cost $1.25" in content
    await ws.disconnect()


async def test_a_watched_computer_is_refused_never_asked(authed, device_side):
    _, ws = await computer(authed, "Lab", trust="watched")
    cid = await setup(authed)
    script(
        "start it",
        [call("code_start", device="Lab", project="anemo", prompt="Hi"), Done("tool_use")],
        [TextDelta("Refused."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "start it")
    (start,) = (await timeline(authed, run_id))["tool_calls"]
    assert start["status"] == "failed"
    assert "watched computer" in start["result"]
    assert device_side.sent == []
    await ws.disconnect()


async def test_the_tools_go_with_the_page(authed):
    cid = await setup(authed)
    script("hello", [TextDelta("Hi."), Done("end")])
    await agent_turn(authed, cid, "hello")
    offered = {t.name for t in FakeAdapter.requests[-1].tools}
    assert set(code_tools.CODE_TOOL_NAMES) <= offered
    navigation = (await authed.get("/api/settings")).json()["navigation"]
    navigation["more"].remove("code")
    navigation["off"].append("code")
    assert (await authed.put("/api/settings/navigation", json=navigation)).status_code == 200
    script("hello again", [TextDelta("Hi."), Done("end")])
    await agent_turn(authed, cid, "hello again")
    offered = {t.name for t in FakeAdapter.requests[-1].tools}
    assert not offered & set(code_tools.CODE_TOOL_NAMES)


async def test_a_resumed_session_follows_the_job_that_had_it(authed, device_side):
    device, ws = await computer(authed)
    earlier = "20261120-090000-rs01"
    await announce(ws, earlier, started="2026-11-20T09:00:00Z", state="done")
    await send(ws, (1, init("s-known")), key=earlier)
    async with get_sessionmaker()() as db:
        await control.start_job(
            db,
            device_id=uuid.UUID(device["id"]),
            project="anemo",
            prompt="Go on",
            resume_session="s-known",
        )
        _, fields, _ = device_side.sent[-1]
        assert fields["follow_job_id"] == earlier and fields["resume_session"] == "s-known"
        # A session no job of that computer had: no job to follow.
        device_side.answers["code_start"] = {**STARTED, "job_id": "20261124-111500-rs02"}
        await control.start_job(
            db,
            device_id=uuid.UUID(device["id"]),
            project="anemo",
            prompt="Go on",
            resume_session="s-unknown",
        )
        _, fields, _ = device_side.sent[-1]
        assert "follow_job_id" not in fields
        # A new job: none either.
        device_side.answers["code_start"] = {**STARTED, "job_id": "20261124-121500-rs03"}
        await control.start_job(
            db, device_id=uuid.UUID(device["id"]), project="anemo", prompt="New"
        )
        _, fields, _ = device_side.sent[-1]
        assert "follow_job_id" not in fields
    await ws.disconnect()


async def test_a_paused_computer_cancels_but_doesnt_start(authed, device_side):
    # Control off or paused in Anemo Desktop: no new jobs, but a running one can be
    # cancelled (§12.5).
    device, ws = await computer(authed, control=False)
    listed = (await authed.get("/api/code/devices")).json()
    assert [(d["share"], d["start"], d["cancel"]) for d in listed] == [(True, False, True)]
    body = {"device_id": device["id"], "project": "anemo", "prompt": "Hi"}
    r = await authed.post("/api/code/jobs", json=body)
    assert (r.status_code, error_code(r)) == (409, "code_start_off")
    assert "Allow control" in r.json()["error"]["message"]
    first = "20261120-090000-pz01"
    await announce(ws, first, started="2026-11-20T09:00:00Z", state="done")
    await send(ws, (1, init("s-p")), key=first)
    job_id = (await authed.get("/api/code/jobs")).json()["jobs"][0]["id"]
    r = await authed.post(f"/api/code/jobs/{job_id}/follow-up", json={"prompt": "More"})
    assert (r.status_code, error_code(r)) == (409, "code_start_off")
    running = "20261120-100000-pz02"
    await announce(ws, running, started="2026-11-20T10:00:00Z")
    jobs = (await authed.get("/api/code/jobs")).json()["jobs"]
    running_id = next(j["id"] for j in jobs if j["job_key"] == running)
    device_side.answers["code_cancel"] = {"job_id": running, "state": "cancelled"}
    r = await authed.post(f"/api/code/jobs/{running_id}/cancel")
    assert r.status_code == 200 and r.json()["state"] == "cancelled"
    assert [action for action, _, _ in device_side.sent] == ["code_cancel"]
    # Without "Let Anemo start Claude Code jobs" there is no cancelling either.
    await offer(ws, start=False, control=False)
    listed = (await authed.get("/api/code/devices")).json()
    assert [(d["share"], d["start"], d["cancel"]) for d in listed] == [(True, False, False)]
    await ws.disconnect()
