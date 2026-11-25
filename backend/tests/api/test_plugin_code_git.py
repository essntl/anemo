"""Plugins on the Code page: the `code:read` methods (code.projects, code.gitGraph,
code.gitCommit) carried out by Anemo Desktop on a trusted computer, and the
`code_git_graph` agent tool (docs/device-contracts.md §7.5, §7.6; the plugin guide §6)."""

import uuid
from typing import Any

from app.features.devices import relay
from app.tools.base import ToolContext
from app.tools.builtin import code as code_tools
from tests.api.test_code_control import FakeSend, device_side
from tests.api.test_devices import add
from tests.api.test_devices_ws import roundtrip, welcomed
from tests.api.test_extension_events import WsClient
from tests.api.test_plugins import (
    HELLO,
    approve,
    call,
    code_of,
    install_hello,
    install_zip,
    manifest,
    package_files,
)
from tests.conftest import requires_db

pytestmark = requires_db

__all__ = ["device_side"]  # the fixture, used by name

GRAPH = "artem.git-graph"
HEAD = "a" * 40
BASE = "b" * 40
SIDE = "c" * 40

ANSWER: dict[str, Any] = {
    "head": {"branch": "main", "commit": HEAD, "detached": False},
    "branches": [
        {
            "name": "main",
            "commit": HEAD,
            "remote": False,
            "upstream": "origin/main",
            "ahead": 1,
            "behind": 0,
            "current": True,
        },
        {
            "name": "origin/main",
            "commit": BASE,
            "remote": True,
            "upstream": None,
            "ahead": 0,
            "behind": 0,
            "current": False,
        },
    ],
    "tags": [{"name": "v1.0", "commit": BASE}],
    "commits": [
        {
            "hash": HEAD,
            "parents": [BASE, SIDE],
            "author_name": "Artem",
            "author_email": "a@example.com",
            "date": "2026-11-25T10:00:00+01:00",
            "subject": "Merge branch 'feature'",
            "refs": ["HEAD", "main"],
        },
        {
            "hash": SIDE,
            "parents": [BASE],
            "author_name": "Claude",
            "author_email": "c@example.com",
            "date": "2026-11-25T09:00:00+01:00",
            "subject": "Feature",
            "refs": [],
        },
        {
            "hash": BASE,
            "parents": [],
            "author_name": "Artem",
            "author_email": "a@example.com",
            "date": "2026-11-24T09:00:00+01:00",
            "subject": "First",
            "refs": ["origin/main", "tag: v1.0"],
        },
    ],
    "status": {"dirty": True, "staged": 1, "unstaged": 2, "untracked": 3, "conflicted": 0},
    "remotes": [{"name": "origin", "url": "https://user:ghp_secret@github.com/essntl/anemo.git"}],
    "truncated": False,
}

COMMIT: dict[str, Any] = {
    "hash": SIDE,
    "parents": [BASE],
    "author_name": "Claude",
    "author_email": "c@example.com",
    "date": "2026-11-25T09:00:00+01:00",
    "committer_date": "2026-11-25T09:01:00+01:00",
    "subject": "Feature",
    "body": "Longer text.",
    "files": [
        {"path": "src/app.ts", "status": "M", "additions": 3, "deletions": 1},
        {"path": "logo.png", "status": "A", "additions": None, "deletions": None},
    ],
    "stats": {"files": 2, "additions": 3, "deletions": 1},
    "truncated": False,
}


async def computer(
    authed,
    *,
    git: bool = True,
    remote: bool = True,
    trust: str = "trusted",
    share: bool = True,
) -> tuple[dict[str, Any], WsClient]:
    device = await add(authed, "PC", trust=trust)
    ws, _ = await welcomed(device["token"])
    offer: dict[str, Any] = {
        "type": "device.offer",
        "control": True,
        "shell": False,
        "code": share,
        "code_start": False,
    }
    if git:
        offer["code_git"] = True  # Anemo Desktop 1.5.0
        offer["code_git_remote"] = remote  # 1.6.0
    await ws.send(offer)
    await roundtrip(ws)
    return device, ws


async def install_graph(authed, permissions: list[str] | None = None) -> None:
    data = manifest(
        GRAPH,
        permissions=["code:read"] if permissions is None else permissions,
        contributes={
            "ui": [
                {
                    "id": "panel",
                    "slot": "code.panel",
                    "title": "Git graph",
                    "icon": "git-branch",
                    "entry": "ui/panel.html",
                }
            ]
        },
    )
    detail = await install_zip(authed, package_files(data))
    await approve(authed, detail, "1.0.0")


def answering(fake: FakeSend, **answers: Any) -> None:
    fake.answers.update(
        {"code_git_graph": ANSWER, "code_git_commit": COMMIT, "code_projects": PROJECTS} | answers
    )


PROJECTS = {
    "projects": [
        {"name": "anemo", "dir": "C:\\dev\\anemo", "remote": "https://tok@github.com/e/anemo.git"},
        {"name": "notes", "dir": "C:\\dev\\notes", "remote": None},
    ],
    "remote": [{"name": "not-cloned", "url": "https://github.com/e/not-cloned"}],
    "note": None,
}


async def test_the_graph_comes_from_the_computer_in_camel_case(authed, device_side: FakeSend):
    await install_graph(authed)
    _, ws = await computer(authed)
    answering(device_side)

    r = await call(authed, GRAPH, "code.gitGraph", {"device": "pc", "project": "anemo"})

    assert r.status_code == 200, r.text
    graph = r.json()["result"]
    assert graph["head"] == {"branch": "main", "commit": HEAD, "detached": False}
    assert graph["branches"][0] == {
        "name": "main",
        "commit": HEAD,
        "remote": False,
        "upstream": "origin/main",
        "ahead": 1,
        "behind": 0,
        "current": True,
        "pullRequest": None,
    }
    assert [c["hash"] for c in graph["commits"]] == [HEAD, SIDE, BASE]
    assert graph["commits"][0]["parents"] == [BASE, SIDE]
    assert graph["commits"][0]["authorName"] == "Artem"
    assert graph["commits"][2]["refs"] == ["origin/main", "tag: v1.0"]
    assert graph["status"] == {
        "dirty": True,
        "staged": 1,
        "unstaged": 2,
        "untracked": 3,
        "conflicted": 0,
    }
    # A token in a remote's URL never reaches the plugin.
    assert graph["remotes"] == [{"name": "origin", "url": "https://github.com/essntl/anemo.git"}]
    assert graph["truncated"] is False
    # What a 1.5.0 client doesn't send has its default.
    assert (graph["source"], graph["repo"], graph["fetchedAt"]) == ("local", None, None)
    assert (graph["fetchError"], graph["pullRequests"]) == (None, None)
    action, fields, _ = device_side.sent[-1]
    assert action == "code_git_graph"
    assert fields == {"project": "anemo", "limit": 300, "all": True}
    await ws.disconnect()


async def test_limit_and_all_reach_the_computer_and_extra_commits_are_cut(
    authed, device_side: FakeSend
):
    await install_graph(authed)
    _, ws = await computer(authed)
    answering(device_side)

    params = {"device": "PC", "project": "anemo", "limit": 2, "all": False}
    graph = (await call(authed, GRAPH, "code.gitGraph", params)).json()["result"]

    assert device_side.sent[-1][1] == {"project": "anemo", "limit": 2, "all": False}
    assert len(graph["commits"]) == 2 and graph["truncated"] is True
    await ws.disconnect()


async def test_a_commit_and_the_projects(authed, device_side: FakeSend):
    await install_graph(authed)
    _, ws = await computer(authed)
    answering(device_side)

    r = await call(
        authed, GRAPH, "code.gitCommit", {"device": "PC", "project": "anemo", "hash": "ccccccc"}
    )
    assert r.status_code == 200, r.text
    detail = r.json()["result"]
    assert detail["committerDate"] == "2026-11-25T09:01:00+01:00"
    assert detail["files"][1] == {
        "path": "logo.png",
        "status": "A",
        "additions": None,
        "deletions": None,
    }
    assert detail["stats"] == {"files": 2, "additions": 3, "deletions": 1}
    assert device_side.sent[-1][:2] == ("code_git_commit", {"project": "anemo", "hash": "ccccccc"})

    r = await call(authed, GRAPH, "code.projects", {"device": "PC"})
    assert r.status_code == 200, r.text
    assert r.json()["result"] == {
        "projects": [
            {
                "name": "anemo",
                "path": "C:\\dev\\anemo",
                "remote": "https://github.com/e/anemo.git",
                "repo": "e/anemo",
                "cloned": True,
            },
            {
                "name": "notes",
                "path": "C:\\dev\\notes",
                "remote": None,
                "repo": None,
                "cloned": True,
            },
            # On GitHub, not cloned: what code.gitGraph takes as `repo`.
            {
                "name": "not-cloned",
                "path": None,
                "remote": "https://github.com/e/not-cloned",
                "repo": "e/not-cloned",
                "cloned": False,
            },
        ]
    }
    assert device_side.sent[-1][:2] == ("code_projects", {})

    # remote: false — only the projects folder; the computer is told not to ask GitHub.
    r = await call(authed, GRAPH, "code.projects", {"device": "PC", "remote": False})
    assert [p["cloned"] for p in r.json()["result"]["projects"]] == [True, True]
    assert device_side.sent[-1][:2] == ("code_projects", {"local_only": True})
    await ws.disconnect()


async def test_without_code_read_every_method_is_refused(authed, device_side: FakeSend):
    await install_hello(authed)  # documents:read only
    _, ws = await computer(authed)
    answering(device_side)

    for method, params in [
        ("code.projects", {"device": "PC"}),
        ("code.gitGraph", {"device": "PC", "project": "anemo"}),
        ("code.gitCommit", {"device": "PC", "project": "anemo", "hash": "abcdef1"}),
    ]:
        r = await call(authed, HELLO, method, params)
        assert code_of(r) == "permission_denied", (method, r.text)
    assert device_side.sent == []
    await ws.disconnect()


async def test_parameters_are_checked_before_anything_is_sent(authed, device_side: FakeSend):
    await install_graph(authed)
    _, ws = await computer(authed)
    answering(device_side)

    bad: list[tuple[str, dict[str, Any]]] = [
        ("code.gitGraph", {"device": "PC", "project": "../etc"}),
        ("code.gitGraph", {"device": "PC", "project": "C:\\Windows"}),
        ("code.gitGraph", {"device": "PC", "project": "/etc"}),
        ("code.gitGraph", {"device": "PC", "project": ".."}),
        ("code.gitGraph", {"device": "PC", "project": "a/b"}),
        ("code.gitGraph", {"device": "PC", "project": "anemo", "limit": 0}),
        ("code.gitGraph", {"device": "PC", "project": "anemo", "limit": 1001}),
        ("code.gitGraph", {"device": "PC", "project": "anemo", "ref": "main"}),
        ("code.gitGraph", {"project": "anemo"}),
        ("code.gitCommit", {"device": "PC", "project": "anemo", "hash": "HEAD"}),
        ("code.gitCommit", {"device": "PC", "project": "anemo", "hash": "abc12"}),
        ("code.gitCommit", {"device": "PC", "project": "anemo", "hash": "ABCDEF12"}),
        ("code.gitCommit", {"device": "PC", "project": "anemo", "hash": "--output=x"}),
        ("code.gitCommit", {"device": "PC", "project": "anemo", "hash": "a" * 41}),
        # repo: only owner/name, never a URL or a path; exactly one of project and repo.
        ("code.gitGraph", {"device": "PC"}),
        ("code.gitGraph", {"device": "PC", "project": "anemo", "repo": "essntl/anemo"}),
        ("code.gitGraph", {"device": "PC", "repo": "https://evil.example/x/y.git"}),
        ("code.gitGraph", {"device": "PC", "repo": "git@github.com:essntl/anemo"}),
        ("code.gitGraph", {"device": "PC", "repo": "essntl"}),
        ("code.gitGraph", {"device": "PC", "repo": "essntl/anemo/extra"}),
        ("code.gitGraph", {"device": "PC", "repo": "essntl/.."}),
        ("code.gitGraph", {"device": "PC", "repo": "../anemo"}),
        ("code.gitGraph", {"device": "PC", "repo": "-x/anemo"}),
        ("code.gitGraph", {"device": "PC", "repo": "essntl/anemo.git"}),
        ("code.gitGraph", {"device": "PC", "repo": "essntl/--upload-pack=x"}),
        ("code.gitGraph", {"device": "PC", "project": "anemo", "fetch": "yes please"}),
        ("code.gitCommit", {"device": "PC", "repo": "essntl/a b", "hash": "abcdef1"}),
    ]
    for method, params in bad:
        r = await call(authed, GRAPH, method, params)
        assert code_of(r) == "invalid_params", (params, r.text)
    assert device_side.sent == []
    await ws.disconnect()


async def test_a_computer_that_cant_answer_is_unavailable(authed, device_side: FakeSend):
    await install_graph(authed)
    answering(device_side)
    params = {"device": "PC", "project": "anemo"}

    r = await call(authed, GRAPH, "code.gitGraph", {**params, "device": "Laptop"})
    assert code_of(r) == "not_found"

    device, ws = await computer(authed, git=False)  # Anemo Desktop before 1.5.0
    r = await call(authed, GRAPH, "code.gitGraph", params)
    assert code_of(r) == "unavailable"
    assert "Update Anemo Desktop on “PC”" in r.json()["error"]["message"]
    await ws.disconnect()

    r = await call(authed, GRAPH, "code.gitGraph", params)  # offline now
    assert code_of(r) == "unavailable"
    assert device_side.sent == []
    await authed.delete(f"/api/devices/{device['id']}")

    _, ws = await computer(authed, trust="watched")
    r = await call(authed, GRAPH, "code.gitGraph", params)
    assert code_of(r) == "unavailable" and "watched" in r.json()["error"]["message"]
    assert device_side.sent == []
    await ws.disconnect()


async def test_a_repository_not_cloned_is_read_through_the_computer_s_cache(
    authed, device_side: FakeSend
):
    await install_graph(authed)
    _, ws = await computer(authed)
    remote_answer = {
        **ANSWER,
        "status": None,
        "source": "remote",
        "repo": "essntl/anemo",
        "fetched_at": "2026-11-25T10:00:00Z",
    }
    answering(device_side, code_git_graph=remote_answer)

    r = await call(authed, GRAPH, "code.gitGraph", {"device": "PC", "repo": "essntl/anemo"})

    assert r.status_code == 200, r.text
    graph = r.json()["result"]
    assert (graph["source"], graph["repo"], graph["status"]) == ("remote", "essntl/anemo", None)
    assert graph["fetchedAt"] == "2026-11-25T10:00:00Z"
    action, fields, timeout = device_side.sent[-1]
    assert (action, fields) == (
        "code_git_graph",
        {"repo": "essntl/anemo", "limit": 300, "all": True},
    )
    assert timeout >= 240  # it may have to be cloned first

    r = await call(
        authed, GRAPH, "code.gitCommit", {"device": "PC", "repo": "essntl/anemo", "hash": "ccccccc"}
    )
    assert r.status_code == 200, r.text
    assert device_side.sent[-1][1] == {"repo": "essntl/anemo", "hash": "ccccccc"}
    await ws.disconnect()


async def test_a_1_5_client_reads_local_checkouts_only_and_doesn_t_fetch(
    authed, device_side: FakeSend
):
    await install_graph(authed)
    _, ws = await computer(authed, remote=False)  # Anemo Desktop 1.5.0
    answering(device_side)

    r = await call(authed, GRAPH, "code.gitGraph", {"device": "PC", "repo": "essntl/anemo"})
    assert code_of(r) == "unavailable"
    assert "to 1.6.0 or later" in r.json()["error"]["message"]
    assert device_side.sent == []

    # fetch: read anyway, without it, and say why.
    r = await call(
        authed, GRAPH, "code.gitGraph", {"device": "PC", "project": "anemo", "fetch": True}
    )
    assert r.status_code == 200, r.text
    assert "1.6.0" in r.json()["result"]["fetchError"]
    assert "fetch" not in device_side.sent[-1][1]
    await ws.disconnect()


async def test_fetch_reaches_the_computer_and_its_failure_is_shown(authed, device_side: FakeSend):
    await install_graph(authed)
    _, ws = await computer(authed)
    failed_fetch = {**ANSWER, "fetch_error": "git fetch took longer than 60 seconds."}
    answering(device_side, code_git_graph=failed_fetch)

    r = await call(
        authed, GRAPH, "code.gitGraph", {"device": "PC", "project": "anemo", "fetch": True}
    )

    assert r.status_code == 200, r.text
    assert r.json()["result"]["fetchError"] == "git fetch took longer than 60 seconds."
    action, fields, timeout = device_side.sent[-1]
    assert fields == {"project": "anemo", "limit": 300, "all": True, "fetch": True}
    assert timeout > 60  # the fetch's own minute comes first
    await ws.disconnect()


async def test_pull_requests_are_attached_to_their_branches(authed, device_side: FakeSend):
    await install_graph(authed)
    _, ws = await computer(authed)
    pr = {
        "number": 90,
        "title": "Code page: git graph",
        "head_ref": "main",
        "url": "https://github.com/essntl/anemo/pull/90",
        "draft": False,
    }
    elsewhere = {**pr, "number": 91, "head_ref": "x", "url": "https://evil.example/pull/91"}
    answering(device_side, code_git_graph={**ANSWER, "pull_requests": [pr, elsewhere]})

    graph = (
        await call(authed, GRAPH, "code.gitGraph", {"device": "PC", "project": "anemo"})
    ).json()["result"]

    shown = {
        "number": 90,
        "title": "Code page: git graph",
        "headRef": "main",
        "url": "https://github.com/essntl/anemo/pull/90",
        "draft": False,
    }
    # A link that isn't a github.com page is left out, not the whole graph.
    assert graph["pullRequests"] == [shown]
    # main and origin/main are both the PR's branch.
    assert [b["pullRequest"] for b in graph["branches"]] == [shown, shown]
    await ws.disconnect()


async def test_not_signed_in_is_unavailable(authed, device_side: FakeSend):
    await install_graph(authed)
    _, ws = await computer(authed)
    answering(
        device_side,
        code_git_graph=relay.Unauthenticated("git on “PC” isn't signed in to GitHub."),
    )

    r = await call(authed, GRAPH, "code.gitGraph", {"device": "PC", "repo": "essntl/anemo"})

    assert code_of(r) == "unavailable"
    assert "signed in" in r.json()["error"]["message"]
    await ws.disconnect()


async def test_sharing_off_is_unavailable(authed, device_side: FakeSend):
    await install_graph(authed)
    answering(device_side)
    _, ws = await computer(authed, share=False)

    r = await call(authed, GRAPH, "code.gitGraph", {"device": "PC", "project": "anemo"})

    assert code_of(r) == "unavailable"
    assert device_side.sent == []
    await ws.disconnect()


async def test_what_the_computer_says_goes_on_as_the_plugin_s_error(authed, device_side: FakeSend):
    await install_graph(authed)
    _, ws = await computer(authed)
    params = {"device": "PC", "project": "anemo", "hash": "abcdef1"}

    answering(device_side, code_git_commit=relay.Missing("There is no commit abcdef1."))
    r = await call(authed, GRAPH, "code.gitCommit", params)
    assert (
        code_of(r) == "not_found" and r.json()["error"]["message"] == "There is no commit abcdef1."
    )

    answering(device_side, code_git_graph=relay.ActionFailed("“anemo” isn't a git repository."))
    r = await call(authed, GRAPH, "code.gitGraph", {"device": "PC", "project": "anemo"})
    assert code_of(r) == "failed" and "isn't a git repository" in r.json()["error"]["message"]

    # An answer that isn't the shape (a hash that isn't one): failed, never passed on.
    broken = {**ANSWER, "commits": [{**ANSWER["commits"][0], "hash": "<script>"}]}
    answering(device_side, code_git_graph=broken)
    r = await call(authed, GRAPH, "code.gitGraph", {"device": "PC", "project": "anemo"})
    assert code_of(r) == "failed"
    await ws.disconnect()


async def test_a_preview_reads_without_asking(authed, device_side: FakeSend):
    data = manifest(
        GRAPH,
        permissions=["code:read"],
        contributes={
            "ui": [{"id": "panel", "slot": "code.panel", "title": "Git", "entry": "ui/panel.html"}]
        },
    )
    await install_zip(authed, package_files(data))  # pending, not approved
    _, ws = await computer(authed)
    answering(device_side)

    r = await call(
        authed,
        GRAPH,
        "code.gitGraph",
        {"device": "PC", "project": "anemo"},
        preview_version="1.0.0",
    )

    assert r.status_code == 200, r.text
    await ws.disconnect()


# -- the agent tool ----------------------------------------------------------------------------


async def test_the_agent_tool_summarises_the_graph(authed, device_side: FakeSend):
    _, ws = await computer(authed)
    answering(device_side)
    tool = code_tools.CodeGitGraph()
    ctx = ToolContext(run_id=uuid.uuid4(), emit=None)  # type: ignore[arg-type]

    (action,) = tool.actions(code_tools.GitGraphInput(device="PC", project="anemo"), ctx)
    assert (action.capability, action.risk) == ("code.see", "safe")
    out = await tool.run(code_tools.GitGraphInput(device="PC", project="anemo", limit=10), ctx)

    assert not out.is_error, out.content
    assert code_tools.FROM_COMPUTER in out.content
    text = out.content
    assert "HEAD: on main at aaaaaaa" in text
    assert "uncommitted changes: 1 staged, 2 changed, not staged, 3 untracked" in text
    assert "* main at aaaaaaa, 1 ahead, 0 behind origin/main" in text
    assert (
        "aaaaaaa 2026-11-25 Artem: Merge branch 'feature' (HEAD, main) [merge of bbbbbbb, ccccccc]"
        in text
    )
    assert "ghp_secret" not in text
    assert device_side.sent[-1][1]["limit"] == 10
    await ws.disconnect()


async def test_the_agent_tool_reads_a_repository_not_cloned(authed, device_side: FakeSend):
    _, ws = await computer(authed)
    pr = {
        "number": 7,
        "title": "Add the thing",
        "head_ref": "main",
        "url": "https://github.com/essntl/anemo/pull/7",
    }
    answer = {**ANSWER, "status": None, "source": "remote", "repo": "essntl/anemo"}
    answering(device_side, code_git_graph={**answer, "pull_requests": [pr]})
    tool = code_tools.CodeGitGraph()
    ctx = ToolContext(run_id=uuid.uuid4(), emit=None)  # type: ignore[arg-type]
    args = code_tools.GitGraphInput(device="PC", repo="essntl/anemo", fetch=True)

    (action,) = tool.actions(args, ctx)
    out = await tool.run(args, ctx)

    assert action.resource.endswith("/repo:essntl/anemo")
    assert not out.is_error, out.content
    assert "Working tree: none (read from a cache on the computer" in out.content
    assert "GitHub: essntl/anemo" in out.content
    assert "pull request #7 “Add the thing”" in out.content
    assert device_side.sent[-1][1] == {
        "repo": "essntl/anemo",
        "limit": 30,
        "all": True,
        "fetch": True,
    }
    await ws.disconnect()


async def test_the_agent_tool_refuses_a_watched_computer(authed, device_side: FakeSend):
    _, ws = await computer(authed, trust="watched")
    tool = code_tools.CodeGitGraph()
    ctx = ToolContext(run_id=uuid.uuid4(), emit=None)  # type: ignore[arg-type]

    out = await tool.run(code_tools.GitGraphInput(device="PC", project="anemo"), ctx)

    assert out.is_error and "watched" in out.content
    assert device_side.sent == []
    await ws.disconnect()
