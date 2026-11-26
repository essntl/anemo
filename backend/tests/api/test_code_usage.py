"""The usage indicator (docs/specs/code-sessions.md §14): a computer's newest
`rate_limit_event`, kept per computer, and a job's token counts."""

from typing import Any

from app.events import bus
from tests.api.test_code_sessions import KEY, announce, computer, init, only_job, result, send
from tests.conftest import requires_db

pytestmark = requires_db

OLD = "20261120-090000-aa11"


def limit(five: float, week: float, resets: int = 1795435800, status: str = "allowed") -> dict:
    return {
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": status,
            "resetsAt": resets,
            "rateLimitType": "five_hour",
            "unifiedWindows": {
                "five_hour": {"utilization": five, "resetsAt": resets, "status": status},
                "seven_day": {"utilization": week, "resetsAt": 1795874400, "status": "allowed"},
            },
        },
    }


async def usage_notices() -> list[dict[str, Any]]:
    batch = await bus.read({bus.GLOBAL_STREAM: "0-0"}, None, 1000)
    return [
        data
        for _, entries in batch
        for _, fields in entries
        for kind, data in [bus.decode(fields)]
        if kind == "code.usage"
    ]


async def test_the_newest_usage_of_a_computer_is_kept(authed):
    device, ws = await computer(authed)
    assert (await authed.get("/api/code/usage")).json() == {"usage": []}
    await announce(ws)
    await send(ws, (1, init()), (2, limit(0.3, 0.2)), (3, limit(0.49, 0.25)))
    (one,) = (await authed.get("/api/code/usage")).json()["usage"]
    assert one["device_id"] == device["id"] and one["device_name"] == "PC"
    assert (one["status"], one["limit_type"]) == ("allowed", "five_hour")
    assert one["resets_at"] == "2026-11-23T12:10:00Z"
    assert [(w["name"], w["utilization"]) for w in one["windows"]] == [
        ("five_hour", 0.49),
        ("seven_day", 0.25),
    ]
    assert one["observed_at"] and one["job_id"] == (await only_job(authed))["id"]
    assert await usage_notices() == [{"device_id": device["id"]}]

    # An older job that ended long ago, sent now (a back-fill): its usage is older.
    await announce(
        ws,
        OLD,
        state="done",
        started="2026-11-20T09:00:00+01:00",
        ended="2026-11-20T10:00:00+01:00",
    )
    await send(ws, (1, limit(0.9, 0.9)), key=OLD)
    (still,) = (await authed.get("/api/code/usage")).json()["usage"]
    assert still["windows"][0]["utilization"] == 0.49
    assert len(await usage_notices()) == 1

    # The running job's next event wins again; the job's end leaves it in place.
    await send(ws, (4, limit(1.02, 0.3, status="rejected")))
    await send(ws, (5, result(usage={"input_tokens": 5, "output_tokens": 70})))
    (latest,) = (await authed.get("/api/code/usage")).json()["usage"]
    assert latest["status"] == "rejected" and latest["windows"][0]["utilization"] == 1.02
    await ws.disconnect()


async def test_a_jobs_tokens(authed):
    _, ws = await computer(authed)
    await announce(ws)
    assert (await only_job(authed))["tokens"] is None
    usage = {
        "input_tokens": 90,
        "cache_creation_input_tokens": 41469,
        "cache_read_input_tokens": 8398746,
        "output_tokens": 23300,
    }
    await send(ws, (1, init()), (2, result(usage=usage)))
    done = await only_job(authed)
    assert done["tokens"] == {
        "input": 90,
        "output": 23300,
        "cache_read": 8398746,
        "cache_creation": 41469,
    }
    assert done["job_key"] == KEY
    await ws.disconnect()


async def test_usage_is_gone_with_its_computer(authed):
    device, ws = await computer(authed)
    await announce(ws)
    await send(ws, (1, limit(0.5, 0.5)))
    await ws.disconnect()
    assert (await authed.delete(f"/api/devices/{device['id']}")).status_code == 204
    assert (await authed.get("/api/code/usage")).json() == {"usage": []}
