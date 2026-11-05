"""The first-run setup (when it is offered) and the update notice (commits on main)."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.features.updates import service
from tests.conftest import requires_db

pytestmark = requires_db

OLD = "a" * 40
NEW = "b" * 40


def commit(sha: str, message: str, date: str = "2026-11-01T10:00:00Z") -> dict:
    return {"sha": sha, "commit": {"message": message, "committer": {"date": date}}}


class FakeGitHub:
    """Answers GitHub's compare API: {"base...head": (status code, body)}."""

    def __init__(self) -> None:
        self.answers: dict[str, tuple[int, dict]] = {}
        self.requests: list[httpx.Request] = []

    def answer(self, base: str, head: str, code: int, body: dict | None = None) -> None:
        self.answers[f"{base}...{head}"] = (code, body or {})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.url.host == "api.github.com"
        key = request.url.path.rsplit("/compare/", 1)[1]
        code, body = self.answers[key]
        page = int(request.url.params.get("page", "1"))
        if "pages" in body:  # {"pages": {1: [...], 2: [...]}, ...}
            body = {**body, "commits": body["pages"][page]}
        return httpx.Response(code, json=body)


@pytest.fixture
def github(monkeypatch):
    fake = FakeGitHub()
    monkeypatch.setattr(service, "transport_override", httpx.MockTransport(fake))
    return fake


@pytest.fixture
def build(monkeypatch):
    """Pretend this build was made from commit `NEW` (prebuilt image)."""
    settings = get_settings()
    monkeypatch.setattr(settings, "app_commit", NEW)
    monkeypatch.setattr(settings, "app_install", "image")
    monkeypatch.setattr(settings, "update_check", True)
    return settings


def ahead(*messages: str) -> dict:
    commits = [
        commit(f"{i:040x}", m, f"2026-11-0{i + 1}T10:00:00Z") for i, m in enumerate(messages)
    ]
    return {"status": "ahead", "ahead_by": len(commits), "commits": commits}


async def set_state(**values) -> None:
    async with get_sessionmaker()() as db:
        state = await service.load(db)
        await service._store(db, state.model_copy(update=values))
        await db.commit()


# -- first-run setup -----------------------------------------------------------------


async def test_setup_is_offered_until_something_is_set_up_or_put_off(authed):
    status = (await authed.get("/api/setup/status")).json()
    assert status["offer_setup"] is True and not status["has_provider"]
    settings = (await authed.get("/api/settings")).json()
    assert settings["setup"] == {"status": "new", "step": None}

    # Left halfway: where it was is kept, and it is still offered.
    r = await authed.put("/api/settings/setup", json={"status": "new", "step": "you"})
    assert r.status_code == 200
    assert (await authed.get("/api/setup/status")).json()["offer_setup"] is True

    # "Not now": not offered again (it stays reachable from Settings > Advanced).
    await authed.put("/api/settings/setup", json={"status": "later", "step": "you"})
    assert (await authed.get("/api/setup/status")).json()["offer_setup"] is False
    await authed.put("/api/settings/setup", json={"status": "new", "step": None})

    # An install that already has a provider (set up by hand, or before the setup
    # existed) is never interrupted by it.
    r = await authed.post("/api/providers", json={"name": "Fake", "type": "fake"})
    assert r.status_code in (200, 201), r.text
    assert (await authed.get("/api/setup/status")).json()["offer_setup"] is False


async def test_setup_rejects_unknown_steps(authed):
    r = await authed.put("/api/settings/setup", json={"status": "new", "step": "elsewhere"})
    assert r.status_code == 422


# -- update notice -------------------------------------------------------------------


def test_commit_titles():
    assert service.commit_title("Fix the timer\n\nLonger text") == "Fix the timer"
    assert (
        service.commit_title(
            "Merge pull request #16 from essntl/branch\n\nDiagrams, charts and math"
        )
        == "Diagrams, charts and math (#16)"
    )
    assert (
        service.commit_title("Merge pull request #3 from x/y") == "Merge pull request #3 from x/y"
    )


async def test_without_a_known_commit_nothing_is_asked(authed, github, monkeypatch):
    monkeypatch.setattr(get_settings(), "app_commit", "")
    r = (await authed.post("/api/updates/check")).json()
    assert r["commit"] is None and r["status"] is None and not r["notice"]
    assert r["command"].startswith("git pull")  # built from a checkout
    assert github.requests == []


async def test_new_changes_on_main_are_listed_newest_first(authed, github, build):
    github.answer(
        NEW,
        "main",
        200,
        ahead("Fix the timer", "Merge pull request #17 from essntl/x\n\nDocuments: keep new ones"),
    )
    r = (await authed.post("/api/updates/check")).json()
    assert r["status"] == "available" and r["behind_by"] == 2 and r["error"] is None
    assert [c["title"] for c in r["changes"]] == ["Documents: keep new ones (#17)", "Fix the timer"]
    assert r["changes"][0]["date"].startswith("2026-11-02")
    assert r["notice"] is True
    assert r["command"] == "docker compose pull && docker compose up -d"
    assert r["commit"] == NEW and r["install"] == "image"

    # The request says nothing about the user: no cookies, a fixed User-Agent.
    sent = github.requests[-1]
    assert sent.headers["user-agent"] == "Anemo-update-check"
    assert "cookie" not in sent.headers and "authorization" not in sent.headers
    assert sent.url.path == f"/repos/essntl/anemo/compare/{NEW}...main"

    # Put away: gone, and it stays away for the same changes.
    assert (await authed.post("/api/updates/dismiss")).json()["notice"] is False
    assert (await authed.get("/api/updates")).json()["notice"] is False

    # Newer changes: back, but not sooner than a week after it was put away.
    github.answer(NEW, "main", 200, ahead("Fix the timer", "Another", "And one more"))
    await set_state(checked_at=datetime.now(UTC) - timedelta(minutes=5))
    r = (await authed.post("/api/updates/check")).json()
    assert r["behind_by"] == 3 and r["notice"] is False
    await set_state(dismissed_at=datetime.now(UTC) - timedelta(days=8))
    assert (await authed.get("/api/updates")).json()["notice"] is True


async def test_many_changes_show_the_newest(authed, github, build):
    first = [commit(f"{i:040x}", f"Change {i}") for i in range(100)]
    last = [commit(f"{i:040x}", f"Change {i}") for i in range(100, 150)]
    github.answer(
        NEW, "main", 200, {"status": "ahead", "ahead_by": 150, "pages": {1: first, 2: last}}
    )
    r = (await authed.post("/api/updates/check")).json()
    assert r["behind_by"] == 150 and len(r["changes"]) == service.MAX_CHANGES
    assert r["changes"][0]["title"] == "Change 149"
    assert [req.url.params.get("page") for req in github.requests] == [None, "2"]


async def test_up_to_date_and_builds_main_doesnt_know(authed, github, build):
    github.answer(NEW, "main", 200, {"status": "identical", "ahead_by": 0, "commits": []})
    r = (await authed.post("/api/updates/check")).json()
    assert r["status"] == "up_to_date" and r["behind_by"] == 0 and not r["notice"]

    # A fork or a branch with its own commits, none newer on main.
    await set_state(checked_at=datetime.now(UTC) - timedelta(minutes=5))
    github.answer(
        NEW, "main", 200, {"status": "behind", "ahead_by": 0, "behind_by": 3, "commits": []}
    )
    assert (await authed.post("/api/updates/check")).json()["status"] == "up_to_date"

    # A commit GitHub doesn't know (built from something never pushed to that repository).
    await set_state(checked_at=datetime.now(UTC) - timedelta(minutes=5))
    github.answer(NEW, "main", 404, {"message": "Not Found"})
    r = (await authed.post("/api/updates/check")).json()
    assert r["status"] == "unknown_commit" and "can't be compared" in r["error"]
    assert not r["notice"]


@pytest.mark.parametrize("code", [403, 429])
async def test_rate_limits_are_quiet_and_retried_later(authed, github, build, code):
    github.answer(NEW, "main", code, {"message": "API rate limit exceeded"})
    r = (await authed.post("/api/updates/check")).json()
    assert r["status"] == "error" and "limit" in r["error"] and not r["notice"]
    # The worker doesn't ask again right away (only after a few hours).
    asked = len(github.requests)
    await service.check_if_due()
    assert len(github.requests) == asked
    await set_state(checked_at=datetime.now(UTC) - service.RETRY_AFTER_ERROR)
    github.answer(NEW, "main", 200, {"status": "identical", "ahead_by": 0, "commits": []})
    await service.check_if_due()
    assert len(github.requests) == asked + 1


async def test_no_network_is_said_plainly(authed, build, monkeypatch):
    def offline(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    monkeypatch.setattr(service, "transport_override", httpx.MockTransport(offline))
    r = (await authed.post("/api/updates/check")).json()
    assert r["status"] == "error" and r["error"].startswith("Couldn't reach GitHub")


async def test_the_worker_checks_about_once_a_day(authed, github, build):
    github.answer(NEW, "main", 200, ahead("One"))
    await service.check_if_due()
    await service.check_if_due()
    assert len(github.requests) == 1
    await set_state(checked_at=datetime.now(UTC) - service.CHECK_EVERY)
    await service.check_if_due()
    assert len(github.requests) == 2
    # Check now, twice in a row: the second is refused instead of asking again.
    await set_state(checked_at=datetime.now(UTC) - timedelta(minutes=5))
    assert (await authed.post("/api/updates/check")).status_code == 200
    assert (await authed.post("/api/updates/check")).status_code == 429


async def test_switched_off_asks_nothing(authed, github, build, monkeypatch):
    r = await authed.put("/api/settings/updates", json={"check": False})
    assert r.status_code == 200
    out = (await authed.post("/api/updates/check")).json()
    assert out["enabled"] is False and out["status"] is None and github.requests == []
    await service.check_if_due()
    assert github.requests == []

    await authed.put("/api/settings/updates", json={"check": True})
    monkeypatch.setattr(get_settings(), "update_check", False)  # UPDATE_CHECK=false
    out = (await authed.get("/api/updates")).json()
    assert out["enabled"] is False and out["env_disabled"] is True
    await service.check_if_due()
    assert github.requests == []


async def test_whats_new_after_an_update(authed, github, build):
    github.answer(NEW, "main", 200, {"status": "identical", "ahead_by": 0, "commits": []})
    # The first version that runs here: nothing to show.
    r = (await authed.post("/api/updates/check")).json()
    assert r["whats_new"] is None

    # Then OLD ran here before NEW (an update was installed).
    await set_state(seen_commit=OLD, checked_at=datetime.now(UTC) - timedelta(minutes=5))
    github.answer(OLD, NEW, 200, ahead("Shortcut sheet", "Daily note"))
    r = (await authed.post("/api/updates/check")).json()
    news = r["whats_new"]
    assert news["from_commit"] == OLD and news["to_commit"] == NEW and news["total"] == 2
    assert [c["title"] for c in news["changes"]] == ["Daily note", "Shortcut sheet"]
    # Once: put away, it doesn't come back for this version.
    assert (await authed.post("/api/updates/whats-new/dismiss")).json()["whats_new"] is None
    await set_state(checked_at=datetime.now(UTC) - timedelta(minutes=5))
    assert (await authed.post("/api/updates/check")).json()["whats_new"] is None


async def test_the_state_is_not_a_settings_section(authed, github, build):
    github.answer(NEW, "main", 200, ahead("One"))
    await authed.post("/api/updates/check")
    settings = (await authed.get("/api/settings")).json()
    assert "update_state" not in settings and settings["updates"] == {"check": True}
    async with get_sessionmaker()() as db:
        assert (await service.load(db)).behind_by == 1
    assert json.loads(json.dumps(settings))  # plain JSON
