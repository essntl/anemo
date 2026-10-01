"""Notifications (list, Discord destinations, delivery) and automations (schedules,
unattended agent runs, what happens when approval is needed, results, retries)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.core.redis import get_redis
from app.events import bus
from app.features.automations import service as automations
from app.features.automations.models import Automation
from app.features.notifications import service as notifications
from app.features.notifications.models import NotificationDelivery
from app.features.secrets.models import Secret
from app.jobs.models import Job
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, ProviderError, TextDelta
from app.runtime.dispatch import execute_run
from tests import web_server as hooks
from tests.api.test_agent import (
    call,
    script,
    setup,
    timeline,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.conftest import requires_db
from tests.web_server import web_server

pytestmark = requires_db


async def global_events(kind: str) -> list[dict]:
    entries = await get_redis().xrange(bus.GLOBAL_STREAM)
    decoded = [bus.decode(fields) for _, fields in entries]
    return [data for event_type, data in decoded if event_type == kind]


async def notify(**fields) -> None:
    async with get_sessionmaker()() as db:
        await notifications.create(db, **fields)


async def deliveries() -> list[NotificationDelivery]:
    async with get_sessionmaker()() as db:
        rows = await db.scalars(
            select(NotificationDelivery).order_by(NotificationDelivery.created_at)
        )
        return list(rows)


async def destination(client, url: str, **fields) -> dict:
    r = await client.post(
        "/api/notification-destinations", json={"name": "Discord", "url": url, **fields}
    )
    assert r.status_code == 201, r.text
    return r.json()


# -- notifications ------------------------------------------------------------------------


async def test_notification_list_read_and_delete(authed):
    await notify(title="First", body="one", kind="agent")
    await notify(title="Second", kind="reminder", level="warning", link="/tasks")
    listed = (await authed.get("/api/notifications")).json()
    assert [n["title"] for n in listed] == ["Second", "First"]
    assert listed[0]["link"] == "/tasks" and listed[0]["level"] == "warning"
    assert (await authed.get("/api/notifications/summary")).json() == {"unread": 2}
    live = await global_events("notification")
    assert [e["title"] for e in live] == ["First", "Second"]

    first = listed[1]["id"]
    r = await authed.post("/api/notifications/read", json={"ids": [first]})
    assert r.json() == {"unread": 1}
    unread = (await authed.get("/api/notifications", params={"unread": True})).json()
    assert [n["title"] for n in unread] == ["Second"]
    assert (await authed.post("/api/notifications/read", json={})).json() == {"unread": 0}

    assert (await authed.delete(f"/api/notifications/{first}")).status_code == 204
    assert (await authed.delete(f"/api/notifications/{first}")).status_code == 404
    assert (await authed.delete("/api/notifications")).status_code == 204
    assert (await authed.get("/api/notifications")).json() == []


async def test_old_notifications_are_pruned(authed):
    await notify(title="Old", kind="agent")
    assert await notifications.prune(datetime.now(UTC) + timedelta(days=89)) == 0
    assert await notifications.prune(datetime.now(UTC) + timedelta(days=91)) == 1


async def test_destinations_keep_the_webhook_secret(authed):
    url = "https://discord.com/api/webhooks/123/very-secret-token"
    created = await destination(authed, url)
    assert created["url_hint"] == "••••oken" and "url" not in created
    assert created["kinds"] == ["reminder", "automation", "approval", "agent"]
    assert url not in (await authed.get("/api/notification-destinations")).text
    async with get_sessionmaker()() as db:
        secret = await db.scalar(select(Secret))
        assert secret is not None and b"very-secret" not in secret.ciphertext

    for bad in ("ftp://example.com/x", "not a url", ""):
        r = await authed.post("/api/notification-destinations", json={"name": "B", "url": bad})
        assert r.status_code == 422
    same = await authed.post("/api/notification-destinations", json={"name": "discord", "url": url})
    assert same.status_code == 409

    r = await authed.patch(
        f"/api/notification-destinations/{created['id']}",
        json={"name": "Alerts", "kinds": ["reminder"], "enabled": False},
    )
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["kinds"], r.json()["enabled"]) == (
        "Alerts",
        ["reminder"],
        False,
    )
    assert r.json()["url_hint"] == "••••oken"  # the URL was kept
    r = await authed.patch(
        f"/api/notification-destinations/{created['id']}", json={"url": "https://example.com/abcd"}
    )
    assert r.json()["url_hint"] == "••••abcd"

    assert (
        await authed.delete(f"/api/notification-destinations/{created['id']}")
    ).status_code == 204
    async with get_sessionmaker()() as db:
        assert await db.scalar(select(Secret)) is None  # the URL is gone with it
    audit = [e["action"] for e in (await authed.get("/api/audit")).json()]
    assert "notifications.destination_create" in audit
    assert "notifications.destination_delete" in audit


async def test_destination_test_button(authed):
    async with web_server() as base:
        good = await destination(authed, f"{base}/hook")
        r = await authed.post(f"/api/notification-destinations/{good['id']}/test")
        assert r.json()["ok"] is True
        assert hooks.HOOK_CALLS[-1]["embeds"][0]["title"] == "Test notification"

        r = await authed.patch(
            f"/api/notification-destinations/{good['id']}", json={"url": f"{base}/hook-gone"}
        )
        r = await authed.post(f"/api/notification-destinations/{good['id']}/test")
        assert r.json()["ok"] is False and "no longer exists" in r.json()["message"]
        listed = (await authed.get("/api/notification-destinations")).json()
        assert "no longer exists" in listed[0]["last_error"]


async def test_delivery_to_discord(authed):
    async with web_server() as base:
        await destination(authed, f"{base}/hook")
        await notify(
            title="Backup finished",
            body="All good @everyone",
            kind="agent",
            level="success",
            link="/runs/abc",
        )
        (delivery,) = await deliveries()
        async with get_sessionmaker()() as db:
            job = await db.scalar(select(Job).where(Job.type == "notify.deliver"))
            assert job is not None and job.payload == {"delivery_id": str(delivery.id)}
        await notifications.deliver(delivery.id)

        sent = hooks.HOOK_CALLS[-1]
        embed = sent["embeds"][0]
        assert embed["title"] == "Backup finished"
        assert embed["description"].startswith("All good @everyone")
        assert "[Open in Anemo](http://testserver/runs/abc)" in embed["description"]
        assert sent["allowed_mentions"] == {"parse": []}  # nobody gets pinged
        (delivery,) = await deliveries()
        assert delivery.status == "sent" and delivery.attempts == 1
        await notifications.deliver(delivery.id)  # a repeated job sends nothing
        assert len(hooks.HOOK_CALLS) == 1


async def test_delivery_retries_then_gives_up(authed):
    async with web_server() as base:
        dest = await destination(authed, f"{base}/hook-down")
        await notify(title="Ping", kind="agent")
        (delivery,) = await deliveries()
        for attempt in range(1, notifications.MAX_ATTEMPTS):
            with pytest.raises(notifications.SendError):  # the job queue retries later
                await notifications.deliver(delivery.id)
            assert (await deliveries())[0].attempts == attempt
            assert (await deliveries())[0].status == "pending"
        await notifications.deliver(delivery.id)  # the last attempt gives up quietly
        assert (await deliveries())[0].status == "failed"
        listed = (await authed.get("/api/notification-destinations")).json()
        assert "503" in listed[0]["last_error"]

        # A webhook that no longer exists is not retried at all.
        await authed.patch(
            f"/api/notification-destinations/{dest['id']}", json={"url": f"{base}/hook-gone"}
        )
        await notify(title="Ping 2", kind="agent")
        second = (await deliveries())[1]
        await notifications.deliver(second.id)
        assert (await deliveries())[1].status == "failed"


async def test_destinations_choose_what_they_receive(authed):
    reminders_only = await destination(authed, "https://example.com/a", kinds=["reminder"])
    r = await authed.post(
        "/api/notification-destinations",
        json={"name": "Off", "url": "https://example.com/b", "enabled": False},
    )
    off = r.json()
    await notify(title="From an agent", kind="agent")
    assert await deliveries() == []
    await notify(title="Reminder", kind="reminder")
    assert [d.destination_id for d in await deliveries()] == [uuid.UUID(reminders_only["id"])]
    # Naming destinations overrides their own choice, but never a turned-off one.
    await notify(
        title="Picked",
        kind="agent",
        destination_ids=[uuid.UUID(reminders_only["id"]), uuid.UUID(off["id"])],
    )
    assert len(await deliveries()) == 2
    await notify(title="In the app only", kind="reminder", destination_ids=[])
    assert len(await deliveries()) == 2


async def test_agent_sends_a_notification(authed):
    cid = await setup(authed)
    script(
        "tell me when done",
        [
            *[call("send_notification", title=f"Note {i}", message="Done") for i in range(6)],
            Done("tool_use"),
        ],
        [TextDelta("Sent."), Done("end")],
    )
    r = await authed.post(
        f"/api/conversations/{cid}/turns", json={"text": "tell me when done", "mode": "agent"}
    )
    run_id = r.json()["run_id"]
    await execute_run(uuid.UUID(run_id))
    calls = (await timeline(authed, run_id))["tool_calls"]
    assert [c["status"] for c in calls] == ["succeeded"] * 5 + ["failed"]  # at most 5 per run
    listed = (await authed.get("/api/notifications")).json()
    assert len(listed) == 5 and listed[-1]["title"] == "Note 0"
    assert listed[0]["kind"] == "agent" and listed[0]["link"] == f"/c/{cid}"


# -- automations --------------------------------------------------------------------------

HOURLY = {"kind": "interval", "every_minutes": 60}


async def make(client, **fields) -> dict:
    body = {"name": "Morning news", "prompt": "summarise the news", "schedule": HOURLY, **fields}
    r = await client.post("/api/automations", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def get(client, automation_id: str) -> dict:
    return (await client.get(f"/api/automations/{automation_id}")).json()


async def runs_of(client, automation_id: str) -> list[dict]:
    return (await client.get("/api/runs", params={"automation_id": automation_id})).json()


async def fire(client, automation: dict, *, execute: bool = True) -> str:
    """Let the scheduler start the automation at its due time; returns the run id."""
    due = datetime.fromisoformat((await get(client, automation["id"]))["next_run_at"])
    assert await automations.fire_due(due + timedelta(seconds=1)) == 1
    run_id = (await runs_of(client, automation["id"]))[0]["id"]
    if execute:
        await execute_run(uuid.UUID(run_id))
    return run_id


async def test_create_list_update_and_validate(authed):
    await setup(authed)
    a = await make(authed, schedule={"kind": "cron", "cron": "0 8 * * 1-5", "tz": "Europe/Paris"})
    assert a["schedule_text"] == "At 08:00 on Monday through Friday"
    assert a["enabled"] and a["next_run_at"] and a["last_status"] is None
    assert a["on_ask"] == "pause" and a["notify"] == "always" and a["state"] == {}
    assert [x["name"] for x in (await authed.get("/api/automations")).json()] == ["Morning news"]

    preview = await authed.post(
        "/api/automations/schedule-preview",
        json={"schedule": {"kind": "cron", "cron": "0 8 * * *"}},
    )
    assert preview.json()["text"] == "At 08:00 every day" and len(preview.json()["next_runs"]) == 5
    bad = await authed.post(
        "/api/automations/schedule-preview",
        json={"schedule": {"kind": "cron", "cron": "* * * * *"}},
    )
    assert bad.status_code == 422 and "every 5 minutes" in bad.text

    off = await authed.patch(f"/api/automations/{a['id']}", json={"enabled": False})
    assert off.json()["next_run_at"] is None and off.json()["enabled"] is False
    on = await authed.patch(
        f"/api/automations/{a['id']}", json={"enabled": True, "schedule": HOURLY, "name": "News"}
    )
    assert on.json()["next_run_at"] and on.json()["schedule_text"] == "Every hour"
    assert on.json()["name"] == "News"

    past = {"kind": "once", "at": "2020-01-01T09:00:00Z"}
    assert (await authed.post("/api/automations", json={**a, "schedule": past})).status_code == 400
    missing = str(uuid.uuid4())
    for fields in (
        {"profile_id": missing},
        {"model_id": missing},
        {"destination_ids": [missing]},
    ):
        r = await authed.post(
            "/api/automations", json={"name": "x", "prompt": "y", "schedule": HOURLY, **fields}
        )
        assert r.status_code == 404, r.text
    for path in ("../outside", "notes/{who}"):
        r = await authed.post(
            "/api/automations",
            json={"name": "x", "prompt": "y", "schedule": HOURLY, "document_path": path},
        )
        assert r.status_code == 400, r.text


async def test_scheduled_run_delivers_its_answer(authed):
    await setup(authed)
    a = await make(authed)
    script("summarise the news", [TextDelta("Nothing happened today."), Done("end")])
    run_id = await fire(authed, a)

    run = (await authed.get(f"/api/runs/{run_id}")).json()
    assert run["status"] == "completed" and run["kind"] == "agent"
    assert run["automation_id"] == a["id"] and run["automation_name"] == "Morning news"
    after = await get(authed, a["id"])
    assert after["last_status"] == "completed" and after["last_run_id"] == run_id
    assert after["active_run_id"] is None
    assert datetime.fromisoformat(after["next_run_at"]) > datetime.fromisoformat(a["next_run_at"])

    (note,) = (await authed.get("/api/notifications")).json()
    assert note["title"] == "Morning news" and note["body"] == "Nothing happened today."
    assert note["kind"] == "automation" and note["link"] == f"/c/{run['conversation_id']}"

    # The run has its own conversation, which is not listed with the chats.
    conv = (await authed.get(f"/api/conversations/{run['conversation_id']}")).json()
    assert conv["automation_id"] == a["id"] and conv["title"].startswith("Morning news · ")
    listed = (await authed.get("/api/conversations")).json()
    assert run["conversation_id"] not in [c["id"] for c in listed]
    # It is told that nobody is watching, and gets the tools for notes between runs.
    request = FakeAdapter.requests[-1]
    assert 'unattended run of the automation "Morning news"' in request.system
    names = [t.name for t in request.tools]
    assert "get_automation_state" in names and "set_automation_state" in names
    # No title or memory jobs for scheduled runs.
    async with get_sessionmaker()() as db:
        kinds = set(await db.scalars(select(Job.type)))
    assert kinds == {"run.execute"}


async def test_due_automations_fire_once_and_late_ones_are_skipped(authed):
    await setup(authed)
    a = await make(authed)
    due = datetime.fromisoformat(a["next_run_at"])
    assert await automations.fire_due(due - timedelta(seconds=5)) == 0  # not yet
    assert await automations.fire_due(due + timedelta(seconds=5)) == 1
    assert await automations.fire_due(due + timedelta(seconds=6)) == 0  # not twice
    assert len(await runs_of(authed, a["id"])) == 1

    # The next time comes while the first run is still going: skipped, not stacked.
    assert await automations.fire_due(due + timedelta(hours=1, seconds=5)) == 0
    assert (await runs_of(authed, a["id"]))[0]["status"] == "queued"
    async with get_sessionmaker()() as db:
        row = await db.get(Automation, uuid.UUID(a["id"]))
        assert row is not None and row.last_status == "skipped"
    await execute_run(uuid.UUID((await runs_of(authed, a["id"]))[0]["id"]))

    # The app was off for a day: the missed runs are not caught up.
    assert await automations.fire_due(due + timedelta(days=1)) == 0
    after = await get(authed, a["id"])
    assert after["last_status"] == "missed"
    assert datetime.fromisoformat(after["next_run_at"]) > due + timedelta(days=1)
    assert len(await runs_of(authed, a["id"])) == 1


async def test_once_schedule_turns_itself_off(authed):
    await setup(authed)
    at = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    a = await make(authed, schedule={"kind": "once", "at": at})
    assert a["schedule_text"].startswith("Once on ")
    script("summarise the news", [TextDelta("Done."), Done("end")])
    await fire(authed, a)
    after = await get(authed, a["id"])
    assert after["enabled"] is False and after["next_run_at"] is None
    assert after["last_status"] == "completed"


async def test_run_now_and_delete(authed):
    await setup(authed)
    a = await make(authed, enabled=False)
    r = await authed.post(f"/api/automations/{a['id']}/run")
    assert r.status_code == 202, r.text
    started = r.json()
    assert (await get(authed, a["id"]))["active_run_id"] == started["run_id"]
    assert (await get(authed, a["id"]))["last_status"] == "running"
    assert (await authed.post(f"/api/automations/{a['id']}/run")).status_code == 409
    assert (await authed.delete(f"/api/automations/{a['id']}")).status_code == 409

    script("summarise the news", [TextDelta("Fine."), Done("end")])
    await execute_run(uuid.UUID(started["run_id"]))
    assert (await authed.delete(f"/api/automations/{a['id']}")).status_code == 204
    assert (await authed.get(f"/api/runs/{started['run_id']}")).status_code == 404
    assert (await authed.get(f"/api/conversations/{started['conversation_id']}")).status_code == 404


def write(name: str) -> list:
    """A model turn that tries to create notes/<name> (which needs approval by default)."""
    return [call("write_file", path=f"notes/{name}", content="hello"), Done("tool_use")]


async def test_needing_approval_waits_and_notifies(authed, workspace):  # noqa: F811
    await setup(authed)  # creating files is "always ask" by default
    a = await make(authed, prompt="write a note")
    script("write a note", write("waited.md"), [TextDelta("Written."), Done("end")])
    run_id = await fire(authed, a)

    assert (await authed.get(f"/api/runs/{run_id}")).json()["status"] == "waiting_approval"
    assert (await get(authed, a["id"]))["last_status"] == "waiting"
    (note,) = (await authed.get("/api/notifications")).json()
    assert note["title"] == "Morning news needs your approval" and note["kind"] == "approval"
    assert "notes/waited.md" in note["body"] and note["level"] == "warning"
    assert not (workspace / "notes" / "waited.md").exists()

    approval = (await authed.get("/api/approvals")).json()[0]
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(run_id))
    assert (workspace / "notes" / "waited.md").read_text() == "hello"
    assert (await get(authed, a["id"]))["last_status"] == "completed"
    assert [n["title"] for n in (await authed.get("/api/notifications")).json()] == [
        "Morning news",
        "Morning news needs your approval",
    ]


async def test_needing_approval_can_be_refused_instead(authed, workspace):  # noqa: F811
    await setup(authed)
    a = await make(authed, prompt="write a note", on_ask="deny")
    script(
        "write a note", write("refused.md"), [TextDelta("I could not write the file."), Done("end")]
    )
    run_id = await fire(authed, a)

    assert (await authed.get(f"/api/runs/{run_id}")).json()["status"] == "completed"
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "denied" and "nobody is here to approve" in row["decision_reason"]
    assert "does not wait for it" in tool_results_sent_to_model()[-1]
    assert not (workspace / "notes" / "refused.md").exists()
    assert (await authed.get("/api/approvals")).json() == []
    assert "refused in this run" in FakeAdapter.requests[-1].system


async def test_needing_approval_can_stop_the_run(authed, workspace):  # noqa: F811
    await setup(authed)
    a = await make(authed, prompt="write a note", on_ask="fail", max_retries=3)
    script("write a note", write("stopped.md"), [TextDelta("unreachable"), Done("end")])
    run_id = await fire(authed, a)

    run = (await authed.get(f"/api/runs/{run_id}")).json()
    assert run["status"] == "failed" and "needed your approval" in run["error"]["message"]
    assert not (workspace / "notes" / "stopped.md").exists()
    after = await get(authed, a["id"])
    assert after["last_status"] == "failed"  # not retried: it would stop the same way
    (note,) = (await authed.get("/api/notifications")).json()
    assert note["title"] == "Morning news failed" and note["level"] == "error"
    assert "needed your approval" in note["body"]


async def test_notes_between_runs(authed):
    await setup(authed)
    a = await make(authed, prompt="check the price", notify="never")
    script(
        "check the price",
        [
            call("get_automation_state"),
            call("set_automation_state", key="last_price", value="42"),
            call("set_automation_state", key="temp", value="x"),
            call("set_automation_state", key="temp"),
            Done("tool_use"),
        ],
        [TextDelta("Saved."), Done("end")],
    )
    await fire(authed, a)
    assert "No notes saved yet" in tool_results_sent_to_model()[0]
    assert (await get(authed, a["id"]))["state"] == {"last_price": "42"}
    assert (await authed.get("/api/notifications")).json() == []  # notify: never

    await fire(authed, a)
    assert '"last_price": "42"' in tool_results_sent_to_model()[0]

    # Outside an automation the tools are not offered, and do nothing if called anyway.
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    script("peek", [call("get_automation_state"), Done("tool_use")], [Done("end")])
    r = await authed.post(f"/api/conversations/{cid}/turns", json={"text": "peek", "mode": "agent"})
    await execute_run(uuid.UUID(r.json()["run_id"]))
    assert "get_automation_state" not in [t.name for t in FakeAdapter.requests[-1].tools]
    assert "Unknown tool" in tool_results_sent_to_model()[-1]


async def test_failed_runs_are_retried(authed):
    await setup(authed)
    a = await make(authed, max_retries=1, notify="on_failure")
    script("summarise the news", [ProviderError("boom", retryable=False)])
    await fire(authed, a)
    assert (await get(authed, a["id"]))["last_status"] == "retrying"
    assert (await authed.get("/api/notifications")).json() == []  # not yet: it tries again
    async with get_sessionmaker()() as db:
        job = await db.scalar(select(Job).where(Job.type == "automation.retry"))
        assert job is not None and job.payload == {"automation_id": a["id"], "retry": 1}
        assert job.run_at > datetime.now(UTC) + timedelta(minutes=1)

    await automations.retry_run(uuid.UUID(a["id"]), 1)
    await automations.retry_run(uuid.UUID(a["id"]), 1)  # a repeated job starts nothing
    runs = await runs_of(authed, a["id"])
    assert [r["status"] for r in runs] == ["queued", "failed"]
    await execute_run(uuid.UUID(runs[0]["id"]))  # fails again: no retries left
    assert (await get(authed, a["id"]))["last_status"] == "failed"
    (note,) = (await authed.get("/api/notifications")).json()
    assert note["title"] == "Morning news failed" and "boom" in note["body"]

    # A later run that works stays quiet with notify="on_failure".
    script("summarise the news", [TextDelta("All fine."), Done("end")])
    await fire(authed, a)
    assert (await get(authed, a["id"]))["last_status"] == "completed"
    assert len((await authed.get("/api/notifications")).json()) == 1


async def test_result_saved_as_document(authed, workspace):  # noqa: F811
    await setup(authed)
    a = await make(authed, document_path="briefings/{date}")
    today = datetime.now(UTC).date().isoformat()
    script("summarise the news", [TextDelta("# Briefing\n\nFirst edition."), Done("end")])
    await fire(authed, a)
    path = workspace / "documents" / "briefings" / f"{today}.md"
    assert path.read_text() == "# Briefing\n\nFirst edition."
    docs = (await authed.get("/api/documents")).json()["documents"]
    (doc,) = [d for d in docs if d["path"] == f"documents/briefings/{today}.md"]
    (note,) = (await authed.get("/api/notifications")).json()
    assert note["link"] == f"/documents/{doc['id']}" and note["level"] == "info"

    # The same day again: the document is replaced and keeps its history.
    script("summarise the news", [TextDelta("# Briefing\n\nSecond edition."), Done("end")])
    await fire(authed, a)
    assert "Second edition" in path.read_text()
    revisions = (await authed.get(f"/api/documents/{doc['id']}/revisions")).json()
    assert len(revisions) == 2 and {r["author"] for r in revisions} == {"agent"}


async def test_automation_destinations(authed):
    await setup(authed)
    async with web_server() as base:
        general = await destination(authed, f"{base}/hook")
        r = await authed.post(
            "/api/notification-destinations",
            json={"name": "News channel", "url": f"{base}/hook", "kinds": []},
        )
        news = r.json()
        a = await make(authed, destination_ids=[news["id"]])
        script("summarise the news", [TextDelta("Headlines."), Done("end")])
        await fire(authed, a)
        (delivery,) = await deliveries()
        assert str(delivery.destination_id) == news["id"] != general["id"]
        await notifications.deliver(delivery.id)
        assert hooks.HOOK_CALLS[-1]["embeds"][0]["description"].startswith("Headlines.")
