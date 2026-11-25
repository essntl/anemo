"""The Code page's Git view: POST /api/code/devices/{id}/git/graph, …/git/commit and
…/git/cache/clear, carried out by Anemo Desktop (docs/device-contracts.md §7.5, §7.6).
The shapes are the plugin methods' (test_plugin_code_git.py); this is the HTTP side."""

from typing import Any

from app.features.devices import relay
from tests.api.test_code_control import FakeSend, device_side, error_code
from tests.api.test_plugin_code_git import ANSWER, COMMIT, HEAD, computer
from tests.conftest import requires_db

pytestmark = requires_db

__all__ = ["device_side"]  # the fixture, used by name


def answering(fake: FakeSend, **answers: Any) -> None:
    fake.answers.update(
        {
            "code_git_graph": ANSWER,
            "code_git_commit": COMMIT,
            "code_git_cache_clear": {"removed": 2, "bytes": 1234},
        }
        | answers
    )


def url(device: dict[str, Any], what: str) -> str:
    return f"/api/code/devices/{device['id']}/git/{what}"


async def test_the_graph_of_a_local_checkout(authed, device_side: FakeSend):
    device, ws = await computer(authed)
    answering(device_side)

    r = await authed.post(url(device, "graph"), json={"project": "anemo"})

    assert r.status_code == 200, r.text
    graph = r.json()
    assert graph["head"] == {"branch": "main", "commit": HEAD, "detached": False}
    assert graph["commits"][0]["authorName"] == "Artem"  # the plugin method's shape
    assert graph["remotes"][0]["url"] == "https://github.com/essntl/anemo.git"
    assert device_side.sent[-1][:2] == (
        "code_git_graph",
        {"project": "anemo", "limit": 300, "all": True},
    )
    await ws.disconnect()


async def test_a_repository_not_cloned_with_fetch_and_its_pull_requests(
    authed, device_side: FakeSend
):
    device, ws = await computer(authed)
    pr = {
        "number": 3,
        "title": "Fix",
        "head_ref": "main",
        "url": "https://github.com/essntl/anemo/pull/3",
        "draft": True,
    }
    remote = {**ANSWER, "status": None, "source": "remote", "repo": "essntl/anemo"}
    answering(device_side, code_git_graph={**remote, "pull_requests": [pr]})

    body = {"repo": "essntl/anemo", "fetch": True, "limit": 50, "all": False}
    r = await authed.post(url(device, "graph"), json=body)

    assert r.status_code == 200, r.text
    graph = r.json()
    assert (graph["source"], graph["status"]) == ("remote", None)
    assert graph["branches"][0]["pullRequest"]["number"] == 3
    assert graph["branches"][0]["pullRequest"]["draft"] is True
    assert device_side.sent[-1][1] == {
        "repo": "essntl/anemo",
        "limit": 50,
        "all": False,
        "fetch": True,
    }
    await ws.disconnect()


async def test_a_commit_and_clearing_the_cache(authed, device_side: FakeSend):
    device, ws = await computer(authed)
    answering(device_side)

    r = await authed.post(url(device, "commit"), json={"repo": "essntl/anemo", "hash": "ccccccc"})
    assert r.status_code == 200, r.text
    assert r.json()["stats"] == {"files": 2, "additions": 3, "deletions": 1}
    assert device_side.sent[-1][:2] == (
        "code_git_commit",
        {"repo": "essntl/anemo", "hash": "ccccccc"},
    )

    r = await authed.post(url(device, "cache/clear"))
    assert r.status_code == 200, r.text
    assert r.json() == {"removed": 2, "bytes": 1234}
    assert device_side.sent[-1][:2] == ("code_git_cache_clear", {})
    await ws.disconnect()


async def test_bodies_are_checked_before_anything_is_sent(authed, device_side: FakeSend):
    device, ws = await computer(authed)
    answering(device_side)

    for body in [
        {},
        {"project": "anemo", "repo": "essntl/anemo"},
        {"project": "../etc"},
        {"repo": "https://evil.example/x/y"},
        {"repo": "essntl/.."},
        {"repo": "essntl/anemo", "limit": 0},
    ]:
        r = await authed.post(url(device, "graph"), json=body)
        assert r.status_code == 422, (body, r.text)
    r = await authed.post(url(device, "commit"), json={"project": "anemo", "hash": "HEAD"})
    assert r.status_code == 422
    assert device_side.sent == []
    await ws.disconnect()


async def test_the_states_the_view_explains(authed, device_side: FakeSend):
    """An old Anemo Desktop, not signed in to GitHub, offline: each its own error code."""
    device, ws = await computer(authed, remote=False)  # Anemo Desktop 1.5.0
    answering(device_side)
    r = await authed.post(url(device, "graph"), json={"repo": "essntl/anemo"})
    assert (r.status_code, error_code(r)) == (409, "git_unsupported")
    assert "to 1.6.0 or later" in r.json()["error"]["message"]
    r = await authed.post(url(device, "cache/clear"))
    assert error_code(r) == "git_unsupported"
    await ws.disconnect()

    r = await authed.post(url(device, "graph"), json={"project": "anemo"})
    assert error_code(r) == "device_offline"

    await authed.delete(f"/api/devices/{device['id']}")
    device, ws = await computer(authed)
    answering(device_side, code_git_graph=relay.Unauthenticated("Sign in to GitHub on “PC”."))
    r = await authed.post(url(device, "graph"), json={"repo": "essntl/anemo"})
    assert (r.status_code, error_code(r)) == (409, "device_unauthenticated")
    await ws.disconnect()


async def test_the_projects_name_their_github_repositories(authed, device_side: FakeSend):
    device, ws = await computer(authed)
    device_side.answers["code_projects"] = {
        "projects": [
            {"name": "anemo", "dir": "C:\\dev\\anemo", "remote": "git@github.com:e/anemo.git"}
        ],
        "remote": [{"name": "site", "url": "https://github.com/e/site"}],
        "note": None,
    }

    r = await authed.get(f"/api/code/devices/{device['id']}/projects")

    assert r.status_code == 200, r.text
    assert r.json()["projects"][0]["repo"] == "e/anemo"
    assert r.json()["remote"][0]["repo"] == "e/site"
    await ws.disconnect()
