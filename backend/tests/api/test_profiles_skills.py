"""Agent profiles and skills: API rules, and how they shape an agent run."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import update

from app.core.db import get_sessionmaker
from app.features.auth.models import AuthSession
from app.features.skills.service import parse_markdown
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta, ToolCall
from app.runtime.dispatch import execute_run
from tests.api.test_agent import (
    agent_turn,
    reply,
    script,
    setup,
    timeline,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.conftest import requires_db

pytestmark = requires_db

SKILL_MD = """---
name: release-notes
description: Write release notes from a list of changes.
required_capabilities: [fs.read, agent.spawn]
tags: writing
---

# Release notes
1. Group changes by type.
2. Keep each line short.
"""


def skill_call(call_id: str, name: str) -> ToolCall:
    return ToolCall(id=call_id, name="load_skill", arguments={"name": name})


async def expire_reauth() -> None:
    async with get_sessionmaker()() as db:
        await db.execute(
            update(AuthSession).values(reauth_at=datetime.now(UTC) - timedelta(hours=1))
        )
        await db.commit()


def test_parse_markdown_skill():
    fields = parse_markdown(SKILL_MD)
    assert fields["slug"] == "release-notes" and fields["name"] == "release-notes"
    assert fields["required_capabilities"] == ["fs.read", "agent.spawn"]
    assert fields["tags"] == ["writing"] and fields["instructions"].startswith("# Release notes")
    titled = parse_markdown("---\nname: x-y\ntitle: Nice Name\ndescription: d\n---\nbody")
    assert titled["name"] == "Nice Name" and titled["slug"] == "x-y"


async def test_skills_crud_import_export(authed):
    r = await authed.post("/api/skills/import", json={"content": SKILL_MD})
    assert r.status_code == 201, r.text
    skill = r.json()
    assert skill["source"] == "imported" and skill["blocked_capabilities"] == ["agent.spawn"]

    dup = await authed.post("/api/skills/import", json={"content": SKILL_MD})
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "skill_exists"
    replaced = await authed.post(
        "/api/skills/import", json={"content": SKILL_MD.replace("short", "brief"), "replace": True}
    )
    assert replaced.json()["id"] == skill["id"] and replaced.json()["version"] == 2

    bad = await authed.post("/api/skills/import", json={"content": "# no front matter"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_skill"

    exported = await authed.get(f"/api/skills/{skill['id']}/export")
    assert exported.headers["content-disposition"].endswith('release-notes.md"')
    again = parse_markdown(exported.text)
    assert again["slug"] == "release-notes" and "brief" in again["instructions"]

    created = await authed.post(
        "/api/skills", json={"name": "Code Review", "description": "Review a diff."}
    )
    assert created.json()["slug"] == "code-review"
    clash = await authed.put(
        f"/api/skills/{created.json()['id']}",
        json={"slug": "release-notes", "name": "x", "description": "y"},
    )
    assert clash.status_code == 409
    bad_slug = await authed.post(
        "/api/skills", json={"slug": "Bad Slug!", "name": "x", "description": "y"}
    )
    assert bad_slug.status_code == 422
    assert (await authed.delete(f"/api/skills/{created.json()['id']}")).status_code == 204
    assert [s["slug"] for s in (await authed.get("/api/skills")).json()] == ["release-notes"]


async def test_profile_permissions_need_recent_auth(authed):
    r = await authed.post(
        "/api/profiles", json={"name": "Researcher", "permission_levels": {"fs.write": "deny"}}
    )
    assert r.status_code == 201, r.text
    profile = r.json()
    await expire_reauth()

    same = {k: profile[k] for k in ("name", "permission_levels", "skill_mode")}
    ok = await authed.put(
        f"/api/profiles/{profile['id']}", json={**same, "description": "Finds things"}
    )
    assert ok.status_code == 200 and ok.json()["description"] == "Finds things"
    looser = await authed.put(
        f"/api/profiles/{profile['id']}",
        json={**same, "permission_levels": {"fs.write": "autonomous"}},
    )
    assert looser.status_code == 403 and looser.json()["error"]["code"] == "reauth_required"
    create = await authed.post("/api/profiles", json={"name": "Yolo", "limits": {"max_steps": 400}})
    assert create.status_code == 403

    unknown = await authed.post(
        "/api/profiles", json={"name": "X", "permission_levels": {"settings.write": "autonomous"}}
    )
    assert unknown.status_code == 422
    dup = await authed.post("/api/profiles", json={"name": "Researcher"})
    assert dup.status_code == 409
    actions = [e["action"] for e in (await authed.get("/api/audit")).json()]
    assert "profile.create" in actions


async def test_profile_shapes_the_agent_run(authed):
    cid = await setup(authed)
    skill = (await authed.post("/api/skills/import", json={"content": SKILL_MD})).json()
    await authed.post("/api/skills", json={"name": "Other", "description": "Not for this one."})
    profile = (
        await authed.post(
            "/api/profiles",
            json={
                "name": "Writer",
                "instructions": "Always answer in haiku.",
                "permission_levels": {"fs.read": "deny", "shell.exec": "deny"},
                "limits": {"max_steps": 7},
                "skill_mode": "selected",
                "skill_ids": [skill["id"]],
            },
        )
    ).json()
    summary = (
        await authed.get("/api/permissions/summary", params={"profile_id": profile["id"]})
    ).json()
    assert {i["capability"]: i for i in summary["items"]}["fs.read"]["group"] == "never"
    assert summary["max_steps"] == 7

    script(
        "notes please",
        [
            skill_call("s1", "release-notes"),
            Done("tool_use"),
        ],
        [skill_call("s2", "other"), Done("tool_use")],
        [TextDelta("Done in haiku."), Done("end")],
    )
    r = await authed.post(
        f"/api/conversations/{cid}/turns",
        json={"text": "notes please", "mode": "agent", "profile_id": profile["id"]},
    )
    run_id = r.json()["run_id"]
    await execute_run(uuid.UUID(run_id))

    req = FakeAdapter.requests[-1]
    assert req.system and "Always answer in haiku." in req.system
    assert "- release-notes: Write release notes" in req.system and "Other" not in req.system
    tools = {t.name for t in req.tools}
    assert "load_skill" in tools and "read_file" not in tools and "run_shell" not in tools
    results = tool_results_sent_to_model()
    assert "Group changes by type" in results[0] and "There is no skill 'other'" in results[1]
    run = (await authed.get(f"/api/runs/{run_id}")).json()
    assert run["profile_id"] == profile["id"] and run["profile_name"] == "Writer"
    assert run["limits"]["max_steps"] == 7
    assert (await reply(authed, cid))["text"] == "Done in haiku."
    assert (await authed.get(f"/api/conversations/{cid}")).json()["profile_id"] == profile["id"]
    [first, _] = (await timeline(authed, run_id))["tool_calls"]
    assert first["result_data"]["skill"]["slug"] == "release-notes"

    # Deleting the profile keeps the run's history; the conversation falls back to default.
    assert (await authed.delete(f"/api/profiles/{profile['id']}")).status_code == 204
    assert (await authed.get(f"/api/runs/{run_id}")).json()["profile_name"] == "Writer"
    assert (await authed.get(f"/api/conversations/{cid}")).json()["profile_id"] is None


async def test_no_skills_means_no_load_skill_tool(authed):
    cid = await setup(authed)
    script("hello there", [TextDelta("hi"), Done("end")])
    await agent_turn(authed, cid, "hello there")
    assert "load_skill" not in {t.name for t in FakeAdapter.requests[-1].tools}
    unknown = await authed.post(
        f"/api/conversations/{cid}/turns",
        json={"text": "x", "mode": "agent", "profile_id": str(uuid.uuid4())},
    )
    assert unknown.status_code == 404
