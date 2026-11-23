"""Claude Code jobs shared by computers: the WebSocket side (code.job / code.events →
code.ack) and the Code page's API (docs/specs/code-sessions.md §5, device-contracts §7)."""

import asyncio
import json
import uuid
from datetime import UTC, datetime
from typing import Any

from redis.exceptions import RedisError
from sqlalchemy import func, select

from app.core.db import get_sessionmaker
from app.events import bus
from app.features.code_sessions import ingest, service
from app.features.code_sessions import router as code_router
from app.features.code_sessions.models import CodeJob, CodeJobEvent
from app.features.devices import relay
from app.features.devices import service as devices_service
from app.features.devices import ws as dws
from app.features.notifications.models import Notification
from tests.api.test_devices import add
from tests.api.test_devices_ws import roundtrip, welcomed
from tests.api.test_extension_events import WsClient
from tests.conftest import requires_db

pytestmark = requires_db

KEY = "20261123-101500-ab12"
SESSION = "8f1c2a3b-0000-4000-8000-000000000001"


def job(key: str = KEY, **fields: Any) -> dict[str, Any]:
    return {
        "id": key,
        "device_job_dir": f"C:\\anemo-bridge\\jobs\\{key}",
        "project": "anemo",
        "dir": "C:\\dev\\anemo",
        "started": "2026-11-23T10:15:00+01:00",
        "prompt": "\n  Fix the login bug  \nThe form forgets the user name.",
        "resume_session": None,
        "model": None,
        "pid": 1234,
        "state": "running",
        "ended": None,
        "branch": None,
        "stderr_tail": None,
        **fields,
    }


def init(session: str = SESSION, model: str = "claude-opus-4-1-20250805") -> dict[str, Any]:
    return {
        "type": "system",
        "subtype": "init",
        "cwd": "C:\\dev\\anemo",
        "session_id": session,
        "model": model,
        "tools": ["Bash", "TodoWrite"],
    }


def say(text: str) -> dict[str, Any]:
    return {
        "type": "assistant",
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
        "parent_tool_use_id": None,
        "session_id": SESSION,
    }


def todo_write(*items: tuple[str, str]) -> dict[str, Any]:
    call = {
        "type": "tool_use",
        "id": f"toolu_{uuid.uuid4().hex[:8]}",
        "name": "TodoWrite",
        "input": {"todos": [{"content": c, "status": s, "activeForm": c + "…"} for c, s in items]},
    }
    return {"type": "assistant", "message": {"role": "assistant", "content": [call]}}


def bash(command: str) -> dict[str, Any]:
    call = {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": command}}
    return {"type": "assistant", "message": {"role": "assistant", "content": [call]}}


def result(subtype: str = "success", is_error: bool = False, **fields: Any) -> dict[str, Any]:
    return {
        "type": "result",
        "subtype": subtype,
        "is_error": is_error,
        "duration_ms": 272_000,
        "num_turns": 14,
        "result": "Fixed. https://github.com/essntl/anemo/pull/67",
        "session_id": SESSION,
        "total_cost_usd": 1.25,
        **fields,
    }


async def computer(authed, name: str = "PC", trust: str = "trusted") -> tuple[dict, WsClient]:  # type: ignore[no-untyped-def]
    device = await add(authed, name, trust=trust)
    ws, _ = await welcomed(device["token"])
    return device, ws


async def announce(ws: WsClient, key: str = KEY, **fields: Any) -> int:
    """Send code.job; the acked seq."""
    await ws.send({"type": "code.job", "job": job(key, **fields)})
    reply = await ws.json()
    assert reply["type"] == "code.ack" and reply["job_id"] == key, reply
    return int(reply["seq"])


def items(*events: tuple[int, dict[str, Any]], trimmed: bool = False) -> list[dict[str, Any]]:
    return [{"seq": seq, "event": event, "trimmed": trimmed} for seq, event in events]


async def send(ws: WsClient, *events: tuple[int, dict[str, Any]], key: str = KEY) -> int:
    """Send code.events; the acked seq."""
    await ws.send({"type": "code.events", "job_id": key, "events": items(*events)})
    reply = await ws.json()
    assert reply["type"] == "code.ack" and reply["job_id"] == key, reply
    return int(reply["seq"])


async def no_answer(ws: WsClient, message: dict[str, Any] | str) -> None:
    """The message gets no answer (the next one is the pong)."""
    if isinstance(message, str):
        await ws.inbox.put({"type": "websocket.receive", "text": message})
    else:
        await ws.send(message)
    await roundtrip(ws)


async def only_job(authed) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    (one,) = (await authed.get("/api/code/jobs")).json()["jobs"]
    return one


async def notifications() -> list[Notification]:
    async with get_sessionmaker()() as db:
        return list(await db.scalars(select(Notification).order_by(Notification.created_at)))


def event_name(chunk: str) -> str:
    """The event type of one SSE frame."""
    return next(line for line in chunk.split("\n") if line.startswith("event: "))


def frame_data(chunk: str) -> Any:
    return json.loads(chunk.split("data: ", 1)[1])


async def global_notices() -> list[dict[str, Any]]:
    batch = await bus.read({bus.GLOBAL_STREAM: "0-0"}, None, 1000)
    found = []
    for _, entries in batch:
        for _, fields in entries:
            kind, data = bus.decode(fields)
            if kind == "code.job":
                found.append(data)
    return found


# -- the WebSocket ---------------------------------------------------------------------------


async def test_a_trusted_computer_shares_a_job(authed):
    device, ws = await computer(authed)
    assert await announce(ws) == 0
    assert await send(ws, (1, init()), (2, say("Looking.")), (3, bash("git status"))) == 3
    shared = await only_job(authed)
    assert shared["job_key"] == KEY and shared["state"] == "running"
    assert shared["title"] == "Fix the login bug"
    assert shared["device"]["id"] == device["id"] and shared["device"]["name"] == "PC"
    assert shared["device"]["online"] is True
    assert shared["session_id"] == SESSION and shared["model"] == "claude-opus-4-1-20250805"
    assert (shared["last_seq"], shared["event_count"], shared["truncated"]) == (3, 3, False)
    assert shared["started_at"].startswith("2026-11-23T09:15:00")  # stored in UTC
    # Announcing again (a reconnect) answers with what is stored.
    assert await announce(ws) == 3
    # The lists hear about it on the global stream.
    notices = await global_notices()
    assert notices[0] == {
        "job_id": shared["id"],
        "thread_id": shared["id"],
        "state": "running",
        "project": "anemo",
    }
    await ws.disconnect()
    assert (await only_job(authed))["device"]["online"] is False
    assert (await global_notices())[-1] == {"device_id": device["id"], "online": False}


async def test_repeats_are_stored_once_and_a_gap_holds_the_ack(authed):
    _, ws = await computer(authed)
    await announce(ws)
    assert await send(ws, (1, init()), (2, say("a"))) == 2
    assert await send(ws, (1, init()), (2, say("a"))) == 2  # a repeat
    assert await send(ws, (5, say("e")), (6, say("f"))) == 2  # 3 and 4 are missing
    assert await send(ws, (4, say("d")), (4, say("d again"))) == 2
    assert await send(ws, (3, say("c"))) == 6
    shared = await only_job(authed)
    assert (shared["last_seq"], shared["event_count"]) == (6, 6)
    events = (await authed.get(f"/api/code/jobs/{shared['id']}/events")).json()["events"]
    assert [e["seq"] for e in events] == [1, 2, 3, 4, 5, 6]
    assert events[3]["event"]["message"]["content"][0]["text"] == "d"  # the first copy
    assert [e["kind"] for e in events[:2]] == ["system", "assistant"]
    await ws.disconnect()


async def test_what_is_ignored(authed, monkeypatch):
    # A computer that isn't trusted: nothing stored, no ack.
    _, watched = await computer(authed, "Watched", trust="watched")
    await no_answer(watched, {"type": "code.job", "job": job()})
    await no_answer(watched, {"type": "code.events", "job_id": KEY, "events": items((1, init()))})
    await watched.disconnect()
    # A phone, even a trusted one.
    phone = await add(authed, "Phone", kind="phone", trust="trusted")
    ws, _ = await welcomed(phone["token"], kind="phone")
    await no_answer(ws, {"type": "code.job", "job": job()})
    await ws.disconnect()
    assert (await authed.get("/api/code/jobs")).json()["jobs"] == []

    _, ws = await computer(authed)
    # Events of a job never announced.
    await no_answer(ws, {"type": "code.events", "job_id": KEY, "events": items((1, init()))})
    # A malformed job id, a bad state, an empty batch, too many events, a prompt too long.
    await no_answer(ws, {"type": "code.job", "job": job("2026-1-x")})
    await no_answer(ws, {"type": "code.job", "job": job(state="paused")})
    await no_answer(ws, {"type": "code.job", "job": job(prompt="x" * 20_001)})
    await announce(ws)
    await no_answer(ws, {"type": "code.events", "job_id": KEY, "events": []})
    many = items(*((n, say("x")) for n in range(1, 202)))
    await no_answer(ws, {"type": "code.events", "job_id": KEY, "events": many})
    # Frames over the limits: 64 000 characters for code.job, 300 000 for code.events.
    big_job = json.dumps({"type": "code.job", "job": job(), "pad": "x" * 64_000})
    await no_answer(ws, big_job)
    big = say("y" * 300_000)
    await no_answer(
        ws, json.dumps({"type": "code.events", "job_id": KEY, "events": items((1, big))})
    )
    # The larger limits are for code frames only.
    await no_answer(ws, json.dumps({"type": "ping", "pad": "x" * 5000}))
    shared = await only_job(authed)
    assert shared["event_count"] == 0
    # A frame just under the code.events limit is taken.
    assert await send(ws, (1, say("z" * 250_000))) == 1
    await ws.disconnect()


async def test_the_server_trims_what_the_client_did_not(authed):
    _, ws = await computer(authed)
    await announce(ws)
    long = "a" * 1500 + "b" * 30_000 + "c" * 400
    assert await send(ws, (1, say(long))) == 1
    shared = await only_job(authed)
    assert shared["truncated"] is True
    (event,) = (await authed.get(f"/api/code/jobs/{shared['id']}/events")).json()["events"]
    assert event["trimmed"] is True and event["dropped"] is False
    text = event["event"]["message"]["content"][0]["text"]
    assert "[30000 characters trimmed]" in text and len(text) < 2000
    async with get_sessionmaker()() as db:
        (size,) = await db.scalars(select(CodeJobEvent.size))
    assert size <= 16_000
    # The client's own trimmed flag is kept.
    await ws.send(
        {"type": "code.events", "job_id": KEY, "events": items((2, say("cut")), trimmed=True)}
    )
    assert (await ws.json())["seq"] == 2
    events = (await authed.get(f"/api/code/jobs/{shared['id']}/events")).json()["events"]
    assert events[1]["trimmed"] is True
    await ws.disconnect()


async def test_a_result_ends_the_job(authed):
    _, ws = await computer(authed)
    await announce(ws)
    await send(ws, (1, init()), (2, result()))
    done = await only_job(authed)
    assert done["state"] == "done" and done["ended_at"] is not None
    assert (done["num_turns"], done["duration_ms"], done["cost_usd"]) == (14, 272_000, 1.25)
    assert done["result_text"].startswith("Fixed.") and done["result_subtype"] == "success"
    assert done["pr_url"] == "https://github.com/essntl/anemo/pull/67"
    assert done["is_error"] is False

    other = "20261123-111500-cd34"
    await announce(ws, other)
    await send(ws, (1, result("error_max_turns")), key=other)
    async with get_sessionmaker()() as db:
        failed = await db.scalar(select(CodeJob).where(CodeJob.job_key == other))
    assert (
        failed is not None
        and failed.state == "failed"
        and failed.result_subtype == ("error_max_turns")
    )
    third = "20261123-121500-ef56"
    await announce(ws, third)
    await send(ws, (1, result(is_error=True)), key=third)
    async with get_sessionmaker()() as db:
        errored = await db.scalar(select(CodeJob).where(CodeJob.job_key == third))
    assert errored is not None and errored.state == "failed" and errored.is_error is True
    await ws.disconnect()


async def test_state_rules(authed):
    _, ws = await computer(authed)
    # Terminal states are sticky: a stale "running" or another end doesn't change "done".
    await announce(ws)
    await send(ws, (1, result()))
    await announce(ws, state="running")
    await announce(ws, state="failed")
    assert (await only_job(authed))["state"] == "done"
    # The client's "cancelled" always wins.
    await announce(ws, state="cancelled", ended="2026-11-23T10:30:00+01:00")
    cancelled = await only_job(authed)
    assert cancelled["state"] == "cancelled"
    assert cancelled["ended_at"].startswith("2026-11-23T09:30:00")
    # And a result after it doesn't change it.
    await send(ws, (2, result()))
    assert (await only_job(authed))["state"] == "cancelled"
    await ws.disconnect()


async def test_exited_without_result_then_a_late_result(authed):
    _, ws = await computer(authed)
    await announce(ws)
    await send(ws, (1, init()))
    await announce(ws, state="exited_without_result", stderr_tail="Error: aborted")
    gone = await only_job(authed)
    assert gone["state"] == "exited_without_result" and gone["stderr_tail"] == "Error: aborted"
    assert [n.title for n in await notifications()] == ["Claude Code job failed: Fix the login bug"]
    await send(ws, (2, result()))
    assert (await only_job(authed))["state"] == "done"
    assert len(await notifications()) == 1  # once
    await ws.disconnect()


async def test_a_finished_job_notifies_once(authed):
    _, ws = await computer(authed)
    await announce(ws)
    await send(ws, (1, init()), (2, result()))
    await announce(ws, state="done")
    shared = await only_job(authed)
    (note,) = await notifications()
    assert note.title == "Claude Code job finished: Fix the login bug"
    assert (note.kind, note.level, note.link) == ("agent", "success", f"/code/{shared['id']}")
    assert note.body == "anemo · 14 turns · 4 min 32 s · API-equivalent cost $1.25"

    # A failed one.
    other = "20261123-111500-cd34"
    await announce(ws, other)
    await send(ws, (1, result("error_during_execution", is_error=True)), key=other)
    assert (await notifications())[-1].level == "error"
    assert (await notifications())[-1].title.startswith("Claude Code job failed: ")
    await ws.disconnect()


async def test_back_filled_and_cancelled_jobs_dont_notify(authed):
    _, ws = await computer(authed)
    # First seen finished (sharing was just turned on): no notification.
    await announce(ws, state="done", ended="2026-11-23T10:20:00+01:00")
    await send(ws, (1, init()), (2, result()))
    await announce(ws, "20261122-090000-zz99", state="exited_without_result")
    # Cancelled by the user.
    running = "20261123-111500-cd34"
    await announce(ws, running)
    await announce(ws, running, state="cancelled")
    assert await notifications() == []
    await ws.disconnect()


async def test_threads_by_resume_session(authed):
    _, ws = await computer(authed)
    first, follow_up = "20261123-090000-aaaa", "20261123-100000-bbbb"
    await announce(ws, first, started="2026-11-23T09:00:00Z")
    await send(ws, (1, init("s-first")), key=first)
    await announce(ws, follow_up, started="2026-11-23T10:00:00Z", resume_session="s-first")
    jobs = {j["job_key"]: j for j in (await authed.get("/api/code/jobs")).json()["jobs"]}
    assert jobs[follow_up]["thread_id"] == jobs[first]["id"] == jobs[first]["thread_id"]
    detail = (await authed.get(f"/api/code/jobs/{jobs[follow_up]['id']}")).json()
    assert detail["job"]["job_key"] == follow_up
    assert [j["job_key"] for j in detail["thread"]] == [first, follow_up]

    # The parent arrives after its follow-ups: they move into its thread when its
    # session id becomes known, the follow-up's own follow-up with them.
    parent, child, grandchild = (
        "20261124-090000-pppp",
        "20261124-100000-cccc",
        "20261124-110000-gggg",
    )
    await announce(ws, child, started="2026-11-24T10:00:00Z", resume_session="s-parent")
    await send(ws, (1, init("s-child")), key=child)
    await announce(ws, grandchild, started="2026-11-24T11:00:00Z", resume_session="s-child")
    jobs = {j["job_key"]: j for j in (await authed.get("/api/code/jobs")).json()["jobs"]}
    assert jobs[grandchild]["thread_id"] == jobs[child]["id"] == jobs[child]["thread_id"]
    await announce(ws, parent, started="2026-11-24T09:00:00Z")
    await send(ws, (1, init("s-parent")), key=parent)
    jobs = {j["job_key"]: j for j in (await authed.get("/api/code/jobs")).json()["jobs"]}
    root = jobs[parent]["id"]
    assert {jobs[k]["thread_id"] for k in (parent, child, grandchild)} == {root}
    detail = (await authed.get(f"/api/code/jobs/{root}")).json()
    assert [j["job_key"] for j in detail["thread"]] == [parent, child, grandchild]
    # The two threads stay apart.
    assert jobs[first]["thread_id"] != root

    # Another computer's sessions don't count.
    _, other = await computer(authed, "Other")
    await announce(other, "20261124-120000-oooo", resume_session="s-parent")
    async with get_sessionmaker()() as db:
        stranger = await db.scalar(select(CodeJob).where(CodeJob.job_key == "20261124-120000-oooo"))
    assert stranger is not None and stranger.thread_id == stranger.id
    await ws.disconnect()
    await other.disconnect()


async def test_todos_branch_and_model(authed):
    _, ws = await computer(authed)
    await announce(ws, model="opus", branch="main")
    shared = await only_job(authed)
    assert (shared["model"], shared["branch"]) == ("opus", "main")
    await send(ws, (1, init()), (2, todo_write(("Read", "completed"), ("Write", "in_progress"))))
    shared = await only_job(authed)
    assert shared["model"] == "claude-opus-4-1-20250805"  # system/init wins
    assert shared["todos"] == [
        {"content": "Read", "status": "completed", "activeForm": "Read…"},
        {"content": "Write", "status": "in_progress", "activeForm": "Write…"},
    ]
    # A newer list arrives before an older one (seq 5, then seq 4): the newer stays.
    await send(ws, (5, todo_write(("Ship", "pending"))))
    await send(ws, (4, todo_write(("Old", "pending"))))
    assert [t["content"] for t in (await only_job(authed))["todos"]] == ["Ship"]
    # The branch from the events wins over the client's.
    await send(ws, (3, bash("git checkout -b feat/login-fix")))
    await announce(ws, branch="main")
    assert (await only_job(authed))["branch"] == "feat/login-fix"
    await ws.disconnect()


async def test_a_job_over_5_mb_keeps_stubs(authed, monkeypatch):
    monkeypatch.setattr(ingest, "MAX_JOB_BYTES", 1600)  # two of these events fit
    _, ws = await computer(authed)
    await announce(ws)
    await send(ws, (1, say("a" * 600)), (2, say("b" * 600)), (3, say("c" * 600)))
    await send(ws, (4, todo_write(("Keep", "pending"))), (5, result()))
    shared = await only_job(authed)
    assert shared["truncated"] is True and shared["last_seq"] == 5
    assert shared["state"] == "done" and shared["todos"][0]["content"] == "Keep"
    events = (await authed.get(f"/api/code/jobs/{shared['id']}/events")).json()["events"]
    assert [e["dropped"] for e in events] == [False, False, True, False, False]
    assert events[2]["event"] == {"type": "assistant"}
    assert events[3]["event"]["message"]["content"][0]["name"] == "TodoWrite"
    assert events[4]["event"]["type"] == "result"
    await ws.disconnect()


async def test_the_offer_says_whether_jobs_are_shared(authed):
    device, ws = await computer(authed)
    await ws.send({"type": "device.offer", "control": True, "shell": False, "code": True})
    await roundtrip(ws)
    offer = await relay.online(uuid.UUID(device["id"]))
    assert offer == relay.Offer(control=True, shell=False, code=True)
    await ws.send({"type": "device.offer", "control": True, "shell": False})  # an older client
    await roundtrip(ws)
    assert await relay.online(uuid.UUID(device["id"])) == relay.Offer(control=True, shell=False)
    await ws.disconnect()


# -- the HTTP API ----------------------------------------------------------------------------


async def test_listing_and_filters(authed):
    a, wa = await computer(authed, "A")
    _, wb = await computer(authed, "B")
    await announce(wa, "20261120-090000-aaa1", project="anemo", started="2026-11-20T09:00:00Z")
    await announce(wa, "20261121-090000-aaa2", project="site", started="2026-11-21T09:00:00Z")
    await announce(wb, "20261122-090000-bbb1", project="anemo", started="2026-11-22T09:00:00Z")
    await send(wb, (1, result()), key="20261122-090000-bbb1")

    listed = (await authed.get("/api/code/jobs")).json()
    assert [j["job_key"] for j in listed["jobs"]] == [
        "20261122-090000-bbb1",
        "20261121-090000-aaa2",
        "20261120-090000-aaa1",
    ]
    assert listed["projects"] == ["anemo", "site"] and listed["has_more"] is False

    def keys(r: Any) -> list[str]:
        return [j["job_key"] for j in r.json()["jobs"]]

    assert keys(await authed.get("/api/code/jobs?project=site")) == ["20261121-090000-aaa2"]
    assert keys(await authed.get("/api/code/jobs?state=done")) == ["20261122-090000-bbb1"]
    by_device = await authed.get(f"/api/code/jobs?device_id={a['id']}")
    assert keys(by_device) == ["20261121-090000-aaa2", "20261120-090000-aaa1"]
    page = (await authed.get("/api/code/jobs?limit=2")).json()
    assert page["has_more"] is True and len(page["jobs"]) == 2
    rest = await authed.get(
        "/api/code/jobs", params={"limit": 2, "before": page["jobs"][-1]["started_at"]}
    )
    assert keys(rest) == ["20261120-090000-aaa1"] and rest.json()["has_more"] is False
    for bad in ("state=paused", "limit=0", "limit=501", "device_id=nope"):
        assert (await authed.get(f"/api/code/jobs?{bad}")).status_code == 422, bad
    await wa.disconnect()
    await wb.disconnect()


async def test_events_paging_and_not_found(authed):
    _, ws = await computer(authed)
    await announce(ws)
    await send(ws, *((n, say(f"line {n}")) for n in range(1, 6)))
    job_id = (await only_job(authed))["id"]
    page = (await authed.get(f"/api/code/jobs/{job_id}/events?after_seq=2&limit=2")).json()
    assert [e["seq"] for e in page["events"]] == [3, 4]
    assert page["has_more"] is True and page["last_seq"] == 5
    event = page["events"][0]
    assert set(event) == {"seq", "kind", "event", "trimmed", "dropped", "created_at"}
    last = (await authed.get(f"/api/code/jobs/{job_id}/events?after_seq=4")).json()
    assert [e["seq"] for e in last["events"]] == [5] and last["has_more"] is False
    for bad in ("after_seq=-1", "limit=0", "limit=2001"):
        assert (await authed.get(f"/api/code/jobs/{job_id}/events?{bad}")).status_code == 422

    missing = uuid.uuid4()
    for path in ("", "/events", "/stream"):
        r = await authed.get(f"/api/code/jobs/{missing}{path}")
        assert r.status_code == 404, path
        assert r.json()["error"]["code"] == "not_found"
    await ws.disconnect()


class _Request:
    """Stays connected for `rounds` checks."""

    def __init__(self, rounds: int) -> None:
        self.rounds = rounds

    async def is_disconnected(self) -> bool:
        self.rounds -= 1
        return self.rounds < 0


async def test_the_stream_sends_the_job_then_what_is_stored(authed, monkeypatch):
    _, ws = await computer(authed)
    await announce(ws)
    await send(ws, (1, init()))
    job_id = uuid.UUID((await only_job(authed))["id"])
    stream = code_router.stream_frames(job_id, _Request(1), None)  # type: ignore[arg-type]
    assert await anext(stream) == ": connected\n\n"
    snapshot = await anext(stream)
    assert snapshot.startswith("event: code.job\n")  # no id: Last-Event-ID stays
    first = frame_data(snapshot)
    assert first["job"]["id"] == str(job_id) and first["job"]["last_seq"] == 1
    # What is stored after it comes next (the first read doesn't block).
    await send(ws, (2, say("next")))
    rest = [chunk async for chunk in stream]
    assert [event_name(c) for c in rest] == ["event: code.events", "event: code.job"]
    assert all(c.startswith("id: ") for c in rest)
    events = frame_data(rest[0])
    assert events["job_id"] == str(job_id)
    assert [(e["seq"], e["kind"]) for e in events["events"]] == [(2, "assistant")]
    assert frame_data(rest[1])["job"]["last_seq"] == 2

    # Resuming from an id sends what came after it.
    cursor = rest[0].split("\n")[0].removeprefix("id: ")
    resumed = [c async for c in code_router.stream_frames(job_id, _Request(1), cursor)]  # type: ignore[arg-type]
    # The job as it is now, then the code.job stored after that code.events.
    assert [event_name(c) for c in resumed[1:]] == ["event: code.job", "event: code.job"]
    assert not resumed[1].startswith("id: ") and resumed[2].startswith("id: ")

    # Without Valkey: the job from the database, again and again.
    async def down(*args: Any, **kwargs: Any) -> Any:
        raise RedisError("down")

    monkeypatch.setattr(code_router.bus, "read", down)
    monkeypatch.setattr(code_router.bus, "latest_id", down)
    monkeypatch.setattr(code_router, "DEGRADED_POLL_S", 0)
    degraded = [c async for c in code_router.stream_frames(job_id, _Request(2), None)]  # type: ignore[arg-type]
    assert degraded[0] == ": connected\n\n"
    assert [event_name(c) for c in degraded[1:]] == ["event: code.job"] * 3
    await ws.disconnect()


# -- retention and deletion ------------------------------------------------------------------


async def test_old_jobs_are_pruned(authed, monkeypatch):
    _, ws = await computer(authed)
    await announce(ws, "20261001-090000-old1", started="2026-10-01T09:00:00Z")
    await send(ws, (1, init()), key="20261001-090000-old1")
    await announce(ws, "20261120-090000-new1", started="2026-11-20T09:00:00Z")
    now = datetime(2026, 11, 23, tzinfo=UTC)
    assert await service.prune(now) == 1
    assert [j["job_key"] for j in (await authed.get("/api/code/jobs")).json()["jobs"]] == [
        "20261120-090000-new1"
    ]
    async with get_sessionmaker()() as db:
        assert await db.scalar(select(func.count()).select_from(CodeJobEvent)) == 0
    # Settings > code: keep_days.
    settings = (await authed.get("/api/settings")).json()["code"]
    assert settings == {"keep_days": 30}
    assert (await authed.put("/api/settings/code", json={"keep_days": 2})).status_code == 200
    assert await service.prune(now) == 1
    for bad in (0, 366):
        r = await authed.put("/api/settings/code", json={"keep_days": bad})
        assert r.status_code == 422
    # The scheduler's task prunes at most every 10 minutes.
    calls: list[int] = []

    async def counted(now: datetime | None = None) -> int:
        calls.append(1)
        return 0

    monkeypatch.setattr(service, "prune", counted)
    monkeypatch.setattr(service, "_last_prune", None)
    await service.prune_if_due()
    await service.prune_if_due()
    assert len(calls) == 1
    await ws.disconnect()


async def test_deleting_the_device_deletes_its_jobs(authed):
    device, ws = await computer(authed)
    await announce(ws)
    await send(ws, (1, init()), (2, say("x")))
    assert (await authed.delete(f"/api/devices/{device['id']}")).status_code == 204
    assert (await authed.get("/api/code/jobs")).json()["jobs"] == []
    async with get_sessionmaker()() as db:
        assert await db.scalar(select(func.count()).select_from(CodeJobEvent)) == 0
    await ws.closed_with(within=3)


async def test_a_trust_change_needs_a_new_connection(authed):
    # The level at connect counts: a computer made trusted later shares after it
    # reconnects (the server closes it with 1012 when the level changes).
    device, ws = await computer(authed, trust="watched")
    await no_answer(ws, {"type": "code.job", "job": job()})
    await ws.disconnect()
    async with get_sessionmaker()() as db:
        await devices_service.set_trust(db, uuid.UUID(device["id"]), "trusted", ip=None)
    ws, welcome = await welcomed(device["token"])
    assert welcome["device"]["trust"] == "trusted"
    assert await announce(ws) == 0
    await ws.disconnect()


async def test_unstorable_characters_in_a_job_are_replaced(authed):
    # Postgres takes no NUL in text: uncleaned, the insert fails and nothing is acked.
    _, ws = await computer(authed)
    fields = {"prompt": "Fix\x00 it", "stderr_tail": "bad\x00", "branch": "b\ud800"}
    assert await announce(ws, **fields) == 0
    shared = await only_job(authed)
    assert shared["prompt"] == "Fix� it" and shared["title"] == "Fix� it"
    assert shared["stderr_tail"] == "bad�" and shared["branch"] == "b�"
    # The same in an event, keys included.
    assert await send(ws, (1, {"type": "raw", "text": "x\ud800\x00", "k\ud800": 1})) == 1
    events = (await authed.get(f"/api/code/jobs/{shared['id']}/events")).json()["events"]
    assert events[0]["event"] == {"type": "raw", "text": "x��", "k�": 1}
    await ws.disconnect()


async def test_a_lost_trust_change_is_found_by_the_recheck(authed, monkeypatch):
    # The relay's "trust_changed" message is lost (Valkey hiccup): the minute's recheck
    # still closes the connection, so a computer no longer trusted stops sharing.
    monkeypatch.setattr(dws, "RECHECK_S", 0.1)

    async def lost(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(relay, "tell", lost)
    device, ws = await computer(authed)
    assert await announce(ws) == 0
    async with get_sessionmaker()() as db:
        await devices_service.set_trust(db, uuid.UUID(device["id"]), "watched", ip=None)
    for _ in range(40):  # pongs while it is open (2 s at most), then the close
        await ws.send({"type": "ping"})
        message = await ws.next(within=5)
        if message["type"] == "websocket.close":
            break
        assert json.loads(message["text"]) == {"type": "pong"}
        await asyncio.sleep(0.05)
    assert message["type"] == "websocket.close"
    assert message["code"] == dws.CLOSE_TRUST_CHANGED


async def test_paging_keeps_jobs_started_at_the_same_time(authed):
    _, ws = await computer(authed)
    same = "2026-11-20T09:00:00Z"
    for key in ("20261120-090000-aaa1", "20261120-090000-aaa2", "20261120-090000-aaa3"):
        await announce(ws, key, started=same)
    seen: list[str] = []
    params: dict[str, Any] = {"limit": 2}
    while True:
        page = (await authed.get("/api/code/jobs", params=params)).json()
        seen += [j["job_key"] for j in page["jobs"]]
        if not page["has_more"]:
            break
        last = page["jobs"][-1]
        params = {"limit": 2, "before": last["started_at"], "before_id": last["id"]}
    assert sorted(seen) == ["20261120-090000-aaa1", "20261120-090000-aaa2", "20261120-090000-aaa3"]
    assert len(seen) == 3
    await ws.disconnect()


async def test_a_late_older_batch_doesnt_overwrite_newer_pull_outs(authed):
    _, ws = await computer(authed)
    await announce(ws)
    pr = "https://github.com/essntl/anemo/pull/"
    newer = [
        (10, init("s-new", "model-new")),
        (11, bash("git checkout -b feat/new")),
        (12, say(f"Opened {pr}2")),
        (13, result(num_turns=9, result="new", session_id="s-new")),
    ]
    older = [
        (1, init("s-old", "model-old")),
        (2, bash("git checkout -b feat/old")),
        (3, say(f"Opened {pr}1")),
        (4, result("error_max_turns", num_turns=3, result="old", session_id="s-old")),
    ]
    await send(ws, *newer)
    await send(ws, *older)
    shared = await only_job(authed)
    assert (shared["session_id"], shared["model"]) == ("s-new", "model-new")
    assert (shared["branch"], shared["pr_url"]) == ("feat/new", f"{pr}2")
    assert (shared["num_turns"], shared["result_text"], shared["result_subtype"]) == (
        9,
        "new",
        "success",
    )
    assert shared["state"] == "done" and shared["last_seq"] == 4  # 5..9 never came
    await ws.disconnect()
