"""Daily notes: Home's short notes for a day, kept as documents/daily/<date>.md."""

from datetime import UTC, date, datetime

import pytest

from app.features.daily_notes import service
from tests.api.test_agent import workspace  # noqa: F401 - autouse fixture
from tests.conftest import requires_db

pytestmark = requires_db


@pytest.fixture
def docs(workspace):  # noqa: F811
    import shutil

    folder = workspace / "documents"
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir()
    return folder


@pytest.fixture
def at(monkeypatch):
    """Set the clock: at("2026-11-05T23:30:00Z")."""

    def set_now(iso: str) -> None:
        moment = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(UTC)
        monkeypatch.setattr(service, "_now", lambda: moment)

    return set_now


async def general(client, **changes) -> None:
    current = (await client.get("/api/settings")).json()["general"]
    r = await client.put("/api/settings/general", json={**current, **changes})
    assert r.status_code == 200, r.text


def test_notes_are_read_from_plain_markdown():
    text = (
        "# Day\n\n- [ ] call Sam\n- [x] pay rent\n  - [ ] nested is not a note\n"
        "* [ ] star\n- [ ]   \nplain\n"
    )
    assert service.open_notes(text) == ["call Sam", "star"]
    assert service.heading(date(2026, 11, 5)) == "Thursday, 5 November 2026"
    expected = "# Thursday, 5 November 2026\n\n- [ ] a\n"
    assert service.new_content(date(2026, 11, 5), ["a"]) == expected


async def test_create_tick_and_conflicts(authed, docs, at):
    at("2026-11-05T09:00:00Z")
    r = await authed.get("/api/daily-notes/today")
    assert r.status_code == 200, r.text
    note = r.json()
    assert note["date"] == note["today"] == "2026-11-05"
    assert note["document"] is None and note["path"] == "documents/daily/2026-11-05.md"
    assert note["heading"] == "Thursday, 5 November 2026"
    assert not (docs / "daily").exists()  # looking does not create anything

    first = "# Thursday, 5 November 2026\n\n- [ ] call Sam\n"
    r = await authed.put("/api/daily-notes/2026-11-05", json={"content": first})
    assert r.status_code == 200, r.text
    doc = r.json()["document"]
    assert doc["title"] == "Thursday, 5 November 2026" and doc["folder"] == "daily"
    assert (docs / "daily" / "2026-11-05.md").read_text() == first

    # Saving needs the version that was edited; without it (or with an old one) nothing is written.
    ticked = first.replace("- [ ]", "- [x]")
    unbased = await authed.put("/api/daily-notes/2026-11-05", json={"content": ticked})
    assert unbased.status_code == 409
    r = await authed.put(
        "/api/daily-notes/2026-11-05", json={"content": ticked, "base_hash": doc["hash"]}
    )
    assert r.status_code == 200, r.text
    stale = await authed.put(
        "/api/daily-notes/2026-11-05", json={"content": first, "base_hash": doc["hash"]}
    )
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "conflict_base_hash"
    assert (docs / "daily" / "2026-11-05.md").read_text() == ticked

    # It is an ordinary document: listed, with a history written by "you".
    listed = (await authed.get("/api/documents")).json()["documents"]
    mine = next(d for d in listed if d["path"] == "documents/daily/2026-11-05.md")
    revisions = (await authed.get(f"/api/documents/{mine['id']}/revisions")).json()
    assert {r["author"] for r in revisions} == {"user"}

    assert (await authed.get("/api/daily-notes/2026-13-01")).status_code == 400


async def test_outside_edits_are_kept_and_seen(authed, docs, at):
    at("2026-11-05T09:00:00Z")
    (docs / "daily").mkdir()
    outside = "# My own title\n\nSome thoughts.\n\n- [ ] from the editor\n"
    (docs / "daily" / "2026-11-05.md").write_text(outside)
    note = (await authed.get("/api/daily-notes/today")).json()
    assert note["document"]["content"] == outside  # found, though made outside the app
    # A save that started from that text goes through.
    r = await authed.put(
        "/api/daily-notes/2026-11-05",
        json={"content": outside + "- [ ] more\n", "base_hash": note["document"]["hash"]},
    )
    assert r.status_code == 200, r.text
    # Saving a day that has a note, as if it had none, is refused rather than overwriting.
    r = await authed.put("/api/daily-notes/2026-11-05", json={"content": "# new\n"})
    assert r.status_code == 409


async def test_today_follows_the_time_zone(authed, docs, at):
    await general(authed, timezone="Pacific/Auckland")  # UTC+13 in November
    at("2026-11-05T12:30:00Z")
    note = (await authed.get("/api/daily-notes/today")).json()
    assert note["today"] == "2026-11-06" and note["path"] == "documents/daily/2026-11-06.md"
    await general(authed, timezone="America/Los_Angeles")  # UTC-8
    at("2026-11-05T05:00:00Z")
    assert (await authed.get("/api/daily-notes/today")).json()["today"] == "2026-11-04"


async def test_carry_over(authed, docs, at):
    (docs / "daily").mkdir()
    (docs / "daily" / "2026-11-02.md").write_text("# Mon\n\n- [ ] old, superseded\n")
    (docs / "daily" / "2026-11-03.md").write_text(
        "# Tue\n\n- [x] done\n- [ ] call Sam\n- [ ] book flights\n"
    )
    at("2026-11-05T09:00:00Z")

    # Off by default: today starts empty.
    assert (await authed.get("/api/daily-notes/today")).json()["document"] is None

    await general(authed, carry_over_daily_notes=True)
    note = (await authed.get("/api/daily-notes/today")).json()
    content = note["document"]["content"]
    assert content == "# Thursday, 5 November 2026\n\n- [ ] call Sam\n- [ ] book flights\n"
    # The earlier day keeps its notes.
    assert "- [ ] call Sam" in (docs / "daily" / "2026-11-03.md").read_text()

    # Only once: today's note is not changed again when it is opened again.
    r = await authed.put(
        "/api/daily-notes/2026-11-05",
        json={"content": "# x\n", "base_hash": note["document"]["hash"]},
    )
    assert r.status_code == 200
    assert (await authed.get("/api/daily-notes/today")).json()["document"]["content"] == "# x\n"

    # Looking at another day never carries anything over.
    assert (await authed.get("/api/daily-notes/2026-11-04")).json()["document"] is None

    # Nothing open on the last day with a note: nothing is created.
    at("2026-11-07T09:00:00Z")
    (docs / "daily" / "2026-11-06.md").write_text("# Fri\n\n- [x] all done\n")
    assert (await authed.get("/api/daily-notes/today")).json()["document"] is None


async def test_project_notes_live_in_the_project_folder(authed, docs, at):
    at("2026-11-05T09:00:00Z")
    project = (await authed.post("/api/projects", json={"name": "Thesis"})).json()
    r = await authed.get("/api/daily-notes/today", params={"project_id": project["id"]})
    assert r.json()["path"] == f"documents/{project['slug']}/daily/2026-11-05.md"
    r = await authed.put(
        "/api/daily-notes/today",
        params={"project_id": project["id"]},
        json={"content": "# T\n\n- [ ] read chapter 2\n"},
    )
    assert r.status_code == 200, r.text
    assert (docs / project["slug"] / "daily" / "2026-11-05.md").exists()
    # The note without a project is a different one.
    assert (await authed.get("/api/daily-notes/today")).json()["document"] is None
    missing = await authed.get(
        "/api/daily-notes/today", params={"project_id": "00000000-0000-0000-0000-000000000000"}
    )
    assert missing.status_code == 404
