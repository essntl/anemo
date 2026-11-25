"""The example plugins shipped with Anemo (docs/specs/12-plugins.md §6): each one validates,
installs from the bundled folder, is approved and enabled, shows its UI and commands, and
the calls its code makes work through the plugin API exactly as its frame or script makes
them.

Tests that write workspace documents (word count's document, the weekly review's template
and script) fail with PermissionError in app/workspace/safe_fs.py on the Windows dev VM
(environmental, see .local-env/KNOWN-FAILURES.md); they run on Linux CI.
"""

import re
import shutil
import uuid
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.features.automations.models import Automation
from app.features.documents import service as documents
from app.features.plugins import bundled, package
from app.features.plugins.models import PluginResource
from app.features.settings import service as settings_service
from app.features.tasks.models import Task
from app.runtime import script_sandbox
from app.runtime.dispatch import execute_run
from tests.api.test_scripts import PROGRAMS, STARTS, FakeRunner, Sdk, outcome_of, run_of
from tests.conftest import requires_db

pytestmark = requires_db

WORD_COUNT = "anemo.word-count"
TODAY_BOARD = "anemo.today-board"
WEEKLY_REVIEW = "anemo.weekly-review"
EXAMPLES = [WORD_COUNT, TODAY_BOARD, WEEKLY_REVIEW]


# -- helpers --------------------------------------------------------------------------------


async def install_example(authed, plugin_id: str) -> dict[str, Any]:
    """Install a bundled example, check nothing of it shows yet, then approve the version
    the user reviewed (its hash) and enable it, as Settings > Plugins does."""
    r = await authed.post("/api/plugins/install/bundled", json={"id": plugin_id})
    assert r.status_code == 201, r.text
    detail = r.json()
    assert detail["status"] == "needs_review" and detail["source"]["kind"] == "bundled"
    assert detail["author"]["name"] == "Anemo" and detail["license"] == "MIT"
    assert detail["readme"] and detail["icon_url"]
    shown = (await authed.get("/api/plugins/contributions")).json()
    assert not [u for u in shown["ui"] if u["plugin"] == plugin_id]
    assert not [c for c in shown["commands"] if c["plugin"] == plugin_id]

    [version] = detail["versions"]
    assert version["version"] == "1.0.0" and version["status"] == "pending"
    r = await authed.post(
        f"/api/plugins/{plugin_id}/versions/1.0.0/approve",
        json={"hash": version["hash"], "enable": True},
    )
    assert r.status_code == 200, r.text
    detail = r.json()
    assert detail["status"] == "enabled" and detail["approved_version"] == "1.0.0"
    return detail


async def contributions(authed, plugin_id: str) -> tuple[list[dict], list[dict]]:
    shown = (await authed.get("/api/plugins/contributions")).json()
    return (
        [u for u in shown["ui"] if u["plugin"] == plugin_id],
        [c for c in shown["commands"] if c["plugin"] == plugin_id],
    )


async def frame_bundle(authed, plugin_id: str, ui: str) -> dict[str, Any]:
    """What Anemo's page hands the frame: the entry's HTML with its scripts and styles."""
    r = await authed.get(f"/api/plugins/{plugin_id}/versions/1.0.0/ui/{ui}")
    assert r.status_code == 200, r.text
    return r.json()


async def call(authed, plugin_id: str, ui: str | None, method: str, params: dict[str, Any]):
    """A call as the frame (or a command, `ui` None) sends it; returns the result."""
    body = {"ui": ui, "method": method, "params": params}
    r = await authed.post(f"/api/plugins/{plugin_id}/call", json=body)
    assert r.status_code == 200, r.text
    return r.json()["result"]


async def user_today() -> tuple[date, ZoneInfo]:
    async with get_sessionmaker()() as db:
        zone = ZoneInfo(await settings_service.user_timezone(db))
    return datetime.now(zone).date(), zone


async def new_task(authed, title: str, **fields: Any) -> dict[str, Any]:
    r = await authed.post("/api/tasks", json={"title": title, **fields})
    assert r.status_code == 201, r.text
    return r.json()


async def new_event(authed, title: str, **fields: Any) -> dict[str, Any]:
    r = await authed.post("/api/calendar/events", json={"title": title, **fields})
    assert r.status_code == 201, r.text
    return r.json()


async def script_of(plugin_id: str, item_id: str) -> Automation:
    async with get_sessionmaker()() as db:
        row = await db.scalar(
            select(PluginResource).where(
                PluginResource.kind == "scripts", PluginResource.item_id == item_id
            )
        )
        assert row is not None, f"{plugin_id} has no script {item_id}"
        automation = await db.get(Automation, row.object_id)
        assert automation is not None
        return automation


async def document_text(path: str) -> str | None:
    async with get_sessionmaker()() as db:
        doc = await documents.by_path(db, path)
        return await documents.read(db, doc) if doc is not None else None


# -- every example --------------------------------------------------------------------------


@pytest.mark.parametrize("plugin_id", EXAMPLES)
async def test_the_example_is_a_valid_package(plugin_id):
    files = bundled.files_of(plugin_id)
    report = package.validate_files(files)
    assert report.ok, report.errors
    manifest = report.manifest
    assert manifest is not None
    assert manifest.id == plugin_id and manifest.version == "1.0.0"
    assert manifest.author.name == "Anemo" and manifest.license == "MIT"
    assert manifest.icon == "icon.png" and files["icon.png"].startswith(b"\x89PNG")
    assert manifest.readme == "README.md"


async def test_the_examples_are_listed_as_bundled(authed):
    listed = {p["id"]: p for p in (await authed.get("/api/plugins/bundled")).json()["plugins"]}
    assert set(EXAMPLES) <= set(listed)
    assert [p["name"] for p in listed[TODAY_BOARD]["permissions"]] == [
        "tasks:read",
        "events:read",
        "tasks:write",
        "projects:read",
    ]
    assert not any(listed[p]["installed"] for p in EXAMPLES)


# -- word count -----------------------------------------------------------------------------


async def test_word_count(authed):
    detail = await install_example(authed, WORD_COUNT)
    [version] = detail["versions"]
    assert [p["name"] for p in version["permissions"]] == ["documents:read"]

    [ui], commands = await contributions(authed, WORD_COUNT)
    assert (ui["id"], ui["slot"], ui["objects"], ui["title"]) == (
        "panel",
        "object.panel",
        ["document"],
        "Word count",
    )
    assert commands == []
    bundle = await frame_bundle(authed, WORD_COUNT, "panel")
    assert bundle["entry"] == "ui/panel.html" and 'id="words"' in bundle["html"]
    assert [s["path"] for s in bundle["scripts"]] == ["ui/panel.js"]
    assert [s["path"] for s in bundle["styles"]] == ["ui/panel.css"]
    assert "documents.get" in bundle["scripts"][0]["text"]

    # What the panel reads: the document it is shown next to (writes a workspace file).
    text = "---\nstatus: draft\n---\n# Essay\n\nFirst paragraph.\n\n```\ncode\n```\n"
    r = await authed.post("/api/documents", json={"title": "Essay", "content": text})
    assert r.status_code == 201, r.text
    doc_id = r.json()["id"]
    doc = await call(authed, WORD_COUNT, "panel", "documents.get", {"id": doc_id})
    assert doc["id"] == doc_id and doc["title"] == "Essay"
    assert (
        doc["markdown"].startswith("---\nstatus: draft") and "First paragraph." in doc["markdown"]
    )

    # documents:read only: it can't change a document.
    r = await authed.post(
        f"/api/plugins/{WORD_COUNT}/call",
        json={
            "ui": "panel",
            "method": "documents.update",
            "params": {"id": doc_id, "markdown": ""},
        },
    )
    assert r.status_code == 403 and r.json()["error"]["code"] == "permission_denied"


# -- today board ----------------------------------------------------------------------------


async def test_today_board(authed):
    detail = await install_example(authed, TODAY_BOARD)
    [ui], [command] = await contributions(authed, TODAY_BOARD)
    assert (ui["id"], ui["slot"], ui["title"], ui["icon"]) == (
        "today",
        "page",
        "Today",
        "calendar-check",
    )
    assert command["title"] == "Open Today board"
    assert command["action"] == {"type": "openPage", "page": "today"}
    bundle = await frame_bundle(authed, TODAY_BOARD, "today")
    assert bundle["entry"] == "ui/today.html" and 'id="timeline"' in bundle["html"]
    assert [s["path"] for s in bundle["scripts"]] == ["ui/today.js"]
    assert [s["path"] for s in bundle["styles"]] == ["ui/today.css"]
    assert detail["status"] == "enabled"

    today, zone = await user_today()
    tomorrow = today + timedelta(days=1)
    work = (await authed.post("/api/projects", json={"name": "Work"})).json()
    late = await new_task(
        authed,
        "Send the invoice",
        due_date=str(today - timedelta(days=2)),
        project_id=work["id"],
        priority=3,
    )
    due = await new_task(authed, "Call the plumber", due_date=str(today), due_time="14:00")
    await new_task(authed, "Later", due_date=str(tomorrow))
    await new_task(authed, "Already done", due_date=str(today), status="done")
    await new_task(authed, "Someday")

    def at(day: date, hour: int) -> str:
        return datetime(day.year, day.month, day.day, hour, tzinfo=zone).isoformat()

    await new_event(authed, "Standup", start_at=at(today, 9), end_at=at(today, 10))
    await new_event(authed, "Holiday", all_day=True, start_date=str(today), end_date=str(today))
    await new_event(authed, "Tomorrow's meeting", start_at=at(tomorrow, 9), end_at=at(tomorrow, 10))

    # The three reads the page makes at once.
    listed = await call(
        authed, TODAY_BOARD, "today", "tasks.list", {"due": str(today), "limit": 200}
    )
    tasks = {t["title"]: t for t in listed["tasks"]}
    assert set(tasks) == {"Send the invoice", "Call the plumber"}
    assert tasks["Send the invoice"]["projectId"] == work["id"]
    assert tasks["Send the invoice"]["priority"] == 3
    assert tasks["Call the plumber"]["dueDate"] == str(today)
    assert tasks["Call the plumber"]["dueTime"] == "14:00"

    listed = await call(
        authed, TODAY_BOARD, "today", "events.list", {"from": str(today), "to": str(today)}
    )
    events = {e["title"]: e for e in listed["events"]}
    assert set(events) == {"Standup", "Holiday"}
    assert events["Holiday"]["allDay"] is True and events["Standup"]["allDay"] is False
    assert datetime.fromisoformat(events["Standup"]["start"]) == datetime.fromisoformat(
        at(today, 9)
    )

    listed = await call(authed, TODAY_BOARD, "today", "projects.list", {})
    assert {"id": work["id"], "name": "Work", "color": work["color"]} in listed["projects"]

    # Ticking a task off.
    done = await call(
        authed, TODAY_BOARD, "today", "tasks.update", {"id": due["id"], "status": "done"}
    )
    assert done["status"] == "done" and done["completedAt"]
    listed = await call(authed, TODAY_BOARD, "today", "tasks.list", {"due": str(today)})
    assert [t["id"] for t in listed["tasks"]] == [late["id"]]
    async with get_sessionmaker()() as db:
        task = await db.get(Task, uuid.UUID(due["id"]))
        assert task is not None and task.updated_by_ref == "plugin:anemo.today-board@1.0.0"


# -- weekly review --------------------------------------------------------------------------

SCRIPT_FILE = "scripts/weekly-review.ts"


def script_code() -> str:
    return bundled.files_of(WEEKLY_REVIEW)[SCRIPT_FILE].decode()


@pytest.fixture
def fake_sandbox():
    previous = script_sandbox.set_runner(FakeRunner())
    STARTS.clear()
    yield
    script_sandbox.set_runner(previous)


async def test_weekly_review_contributions_and_its_script(authed):
    await install_example(authed, WEEKLY_REVIEW)
    ui, commands = await contributions(authed, WEEKLY_REVIEW)
    assert ui == []
    # (An action's optional fields come as null.)
    actions = {
        c["id"]: (c["title"], {k: v for k, v in c["action"].items() if v is not None})
        for c in commands
    }
    assert actions == {
        "run-review": ("Run weekly review", {"type": "runScript", "script": "weekly-review"}),
        "new-review": (
            "New weekly review from template",
            {"type": "newFromTemplate", "template": "weekly-review"},
        ),
    }
    shown = (await authed.get("/api/plugins/contributions")).json()
    assert [t["id"] for t in shown["templates"] if t["plugin"] == WEEKLY_REVIEW] == [
        "weekly-review"
    ]

    # The script became a script automation, approved with the plugin version.
    automation = await script_of(WEEKLY_REVIEW, "weekly-review")
    assert automation.kind == "script" and automation.created_by == "plugin"
    assert automation.enabled is True and automation.script_hash is not None
    r = await authed.get(f"/api/automations/{automation.id}/script")
    assert r.status_code == 200, r.text
    script = r.json()
    assert script["pending"] is None
    assert script["approved"]["hash"] == automation.script_hash
    assert script["approved"]["code"] == script_code()
    assert script["approved"]["tools"] == ["list_tasks", "list_events", "write_document"]


async def test_weekly_review_template(authed):
    """templates.apply writes a workspace document (fails on the Windows VM, see above)."""
    await install_example(authed, WEEKLY_REVIEW)
    made = await call(authed, WEEKLY_REVIEW, None, "templates.apply", {"template": "weekly-review"})
    assert made["type"] == "document"
    r = await authed.get(f"/api/documents/{made['id']}")
    assert r.status_code == 200, r.text
    text = await document_text(r.json()["path"])
    assert text is not None and text.startswith("---\ntags: [review]\n---\n# Weekly review")
    for section in ("## Wins", "## Open loops", "## Next week"):
        assert section in text


async def test_weekly_review_run_with_the_fake_sandbox(authed, fake_sandbox):
    """The approved code is what reaches the sandbox, and the calls it makes (the tools of
    its manifest, with the script's arguments) are allowed and write the review. The real
    TypeScript runs in the Deno test below."""
    await install_example(authed, WEEKLY_REVIEW)
    await new_task(authed, "Plan the trip")
    seen: dict[str, str] = {}

    async def weekly_review(input: dict[str, Any], anemo: Sdk) -> Any:
        assert input["input"] == {"date": "2026-11-18"}
        seen["tasks"] = (await anemo.call("list_tasks"))["content"]
        seen["events"] = (await anemo.call("list_events", start="2026-11-16", end="2026-11-22"))[
            "content"
        ]
        # Week 47: the tests share one workspace, and the Deno test writes week 48.
        path = "documents/Reviews/Week 2026-W47.md"
        await anemo.call("write_document", path=path, content="# Week 2026-W47\n\n## Wins\n")
        return {"outcome": "Wrote the review of week 2026-W47.", "path": path}

    PROGRAMS[script_code()] = weekly_review
    automation = await script_of(WEEKLY_REVIEW, "weekly-review")
    # As the command "Run weekly review" starts it (scripts.run), with an input.
    started = await call(
        authed,
        WEEKLY_REVIEW,
        None,
        "scripts.run",
        {"script": "weekly-review", "input": {"date": "2026-11-18"}},
    )
    await execute_run(uuid.UUID(started["runId"]))
    run = await run_of(authed, started["runId"])
    assert run["status"] == "completed", run
    assert STARTS == [script_code()]
    assert "Plan the trip" in seen["tasks"] and "No events" in seen["events"]
    assert await outcome_of(authed, str(automation.id), started["runId"]) == (
        "Wrote the review of week 2026-W47."
    )
    text = await document_text("documents/Reviews/Week 2026-W47.md")
    assert text is not None and text.startswith("# Week 2026-W47")


async def test_weekly_review_writes_on_the_plugins_own_permissions(authed, fake_sandbox):
    """As its README says: a plugin's script acts on the plugin's permissions, not on the
    agent levels. Even with "Edit documents" set to Never, the approved plugin (granted
    documents:write) writes its review without asking."""
    await install_example(authed, WEEKLY_REVIEW)
    r = await authed.put("/api/settings/permissions", json={"levels": {"docs.write": "deny"}})
    assert r.status_code == 200, r.text

    async def weekly_review(input: dict[str, Any], anemo: Sdk) -> Any:
        await anemo.call("list_tasks")
        await anemo.call("write_document", path="documents/Reviews/Week 2026-W46.md", content="#")
        return {"outcome": "Wrote it."}

    PROGRAMS[script_code()] = weekly_review
    started = await call(authed, WEEKLY_REVIEW, None, "scripts.run", {"script": "weekly-review"})
    await execute_run(uuid.UUID(started["runId"]))
    assert (await run_of(authed, started["runId"]))["status"] == "completed"
    assert await document_text("documents/Reviews/Week 2026-W46.md") is not None


DENO = shutil.which(get_settings().deno_path)


@pytest.mark.skipif(DENO is None, reason="Deno is not installed (DENO_PATH)")
async def test_weekly_review_runs_in_deno(authed):
    """The real script, in the real sandbox: it lists the tasks and events of the week of
    25 November 2026 and writes documents/Reviews/Week 2026-W48.md once."""
    previous = script_sandbox.set_runner(script_sandbox.DenoRunner(DENO))
    try:
        await install_example(authed, WEEKLY_REVIEW)
        _, zone = await user_today()
        work = (await authed.post("/api/projects", json={"name": "Work"})).json()
        await new_task(authed, "Send the invoice", due_date="2026-11-20", project_id=work["id"])
        await new_task(authed, "Call the plumber (again)", due_date="2026-11-27", due_time="14:00")
        await new_task(authed, "Someday")
        await new_task(authed, "Finished", status="done")
        start = datetime(2026, 11, 24, 9, 30, tzinfo=zone)
        await new_event(
            authed,
            "Standup",
            start_at=start.isoformat(),
            end_at=(start + timedelta(minutes=15)).isoformat(),
            location="Room 1",
        )
        await new_event(
            authed,
            "December planning",
            start_at="2026-12-01T09:00:00+00:00",
            end_at="2026-12-01T10:00:00+00:00",
        )
        automation = await script_of(WEEKLY_REVIEW, "weekly-review")

        async def run() -> str:
            started = await call(
                authed,
                WEEKLY_REVIEW,
                None,
                "scripts.run",
                {"script": "weekly-review", "input": {"date": "2026-11-25"}},
            )
            await execute_run(uuid.UUID(started["runId"]))
            run = await run_of(authed, started["runId"])
            assert run["status"] == "completed", run
            outcome = await outcome_of(authed, str(automation.id), started["runId"])
            assert outcome is not None
            return outcome

        assert await run() == "Wrote the review of week 2026-W48: 3 open tasks, 1 event."
        text = await document_text("documents/Reviews/Week 2026-W48.md")
        assert text is not None
        assert text.startswith("---\ntags: [review]\n---\n# Week 2026-W48\n")
        assert "23–29 November 2026" in text
        assert "- 09:30–09:45 · Standup (Room 1)" in text
        assert "December planning" not in text  # next week's event
        assert re.search(r"### Overdue \(1\)\n\n- Send the invoice \(due Fri 20 Nov, Work\)", text)
        assert "- Call the plumber (again) (due Fri 27 Nov 14:00)" in text
        assert "Someday" in text and "Finished" not in text

        # A second run leaves the review (and what the user wrote in it) alone.
        assert await run() == "The review of week 2026-W48 exists already; it was left as it is."
    finally:
        script_sandbox.set_runner(previous)
