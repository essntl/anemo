"""Agent file tools: changes are recorded, revertible, and limited by folder access."""

import shutil
import uuid
from pathlib import Path

import pytest

from app.core.config import get_settings
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.runtime.dispatch import execute_run
from tests.api.test_agent import agent_turn, call, script, setup, timeline
from tests.conftest import requires_db

pytestmark = requires_db


@pytest.fixture(autouse=True)
def workspace():
    root = Path(get_settings().workspace_path)
    if root.exists():
        shutil.rmtree(root)
    (root / "notes").mkdir(parents=True)
    (root / "notes" / "todo.md").write_text("- a\n- b\n")
    (root / "private").mkdir()
    (root / "private" / "diary.md").write_text("secret diary")
    (root / "reference").mkdir()
    (root / "reference" / "manual.md").write_text("manual")
    FakeAdapter.scripts.clear()
    yield root


WRITE_ALLOWED = {"fs.write": "autonomous", "fs.delete": "autonomous"}


async def revert(client, run_id, change_id, force=False):
    return await client.post(
        f"/api/runs/{run_id}/files/{change_id}/revert", params={"force": str(force).lower()}
    )


async def test_write_edit_move_delete_are_recorded_and_revertible(authed, workspace):
    cid = await setup(authed, **WRITE_ALLOWED)
    script(
        "organize",
        [
            call("write_file", path="notes/new.md", content="hello"),
            call("edit_file", path="notes/todo.md", old_text="- b", new_text="- b (done)"),
            call("create_folder", path="archive"),
            Done("tool_use"),
        ],
        [
            call("move_path", source="notes/new.md", destination="archive/new.md"),
            call("delete_path", path="notes/todo.md"),
            Done("tool_use"),
        ],
        [TextDelta("Organized."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "organize")
    t = await timeline(authed, run_id)
    assert all(c["status"] == "succeeded" for c in t["tool_calls"]), t["tool_calls"]
    ops = [(c["op"], c["path"]) for c in t["file_changes"]]
    assert ops == [
        ("create", "notes/new.md"),
        ("modify", "notes/todo.md"),
        ("mkdir", "archive"),
        ("move", "notes/new.md"),
        ("delete", "notes/todo.md"),
    ]
    assert (workspace / "archive" / "new.md").read_text() == "hello"
    assert not (workspace / "notes" / "todo.md").exists()

    changes = {c["op"]: c for c in t["file_changes"]}
    # Undo in reverse order: delete, move, modify.
    assert (await revert(authed, run_id, changes["delete"]["id"])).status_code == 200
    assert (workspace / "notes" / "todo.md").read_text() == "- a\n- b (done)\n"
    assert (await revert(authed, run_id, changes["move"]["id"])).status_code == 200
    assert (workspace / "notes" / "new.md").exists()
    assert (await revert(authed, run_id, changes["modify"]["id"])).status_code == 200
    assert (workspace / "notes" / "todo.md").read_text() == "- a\n- b\n"
    again = await revert(authed, run_id, changes["modify"]["id"])
    assert again.status_code == 409 and again.json()["error"]["code"] == "already_reverted"


async def test_revert_refuses_to_discard_later_edits(authed, workspace):
    cid = await setup(authed, **WRITE_ALLOWED)
    script(
        "edit",
        [call("edit_file", path="notes/todo.md", old_text="- a", new_text="- A"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "edit")
    [change] = (await timeline(authed, run_id))["file_changes"]
    (workspace / "notes" / "todo.md").write_text("my own later edit")
    r = await revert(authed, run_id, change["id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "changed_since"
    assert (await revert(authed, run_id, change["id"], force=True)).status_code == 200
    assert (workspace / "notes" / "todo.md").read_text() == "- a\n- b\n"


async def test_write_requires_approval_by_default(authed, workspace):
    cid = await setup(authed)  # default: fs.write = "ask"
    script(
        "write",
        [call("write_file", path="notes/x.md", content="x"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "write")
    assert (await authed.get(f"/api/runs/{run_id}")).json()["status"] == "waiting_approval"
    assert not (workspace / "notes" / "x.md").exists()


async def test_deleting_a_folder_is_dangerous(authed, workspace):
    cid = await setup(authed, **{"fs.delete": "ask_dangerous"})
    script(
        "clean",
        [call("delete_path", path="notes/todo.md"), Done("tool_use")],
        [call("delete_path", path="reference"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "clean")
    calls = (await timeline(authed, run_id))["tool_calls"]
    assert [c["status"] for c in calls] == ["succeeded", "waiting_approval"]
    assert calls[1]["risk"] == "dangerous"
    assert (workspace / "reference").exists()


async def test_folder_access_is_enforced(authed, workspace):
    cid = await setup(authed, **WRITE_ALLOWED)
    r = await authed.put(
        "/api/settings/workspace",
        json={
            "default_agent_access": "read_write",
            "folders": {"private": "none", "reference": "read"},
        },
    )
    assert r.status_code == 200
    script(
        "snoop",
        [
            call("list_files", path="."),
            call("read_file", path="private/diary.md"),
            call("read_file", path="reference/manual.md"),
            call("write_file", path="reference/new.md", content="x"),
            call("find_files", query="diary"),
            Done("tool_use"),
        ],
        [TextDelta("done"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "snoop")
    calls = (await timeline(authed, run_id))["tool_calls"]
    assert [c["status"] for c in calls] == [
        "succeeded",
        "denied",
        "succeeded",
        "denied",
        "succeeded",
    ]
    assert "hidden from agents" in calls[1]["decision_reason"]
    assert "read-only for agents" in calls[3]["decision_reason"]
    sent = str(FakeAdapter.requests[-1].messages)
    assert "private" not in calls[0]["result"]  # hidden folders are not even listed
    assert "secret diary" not in sent
    assert "No files or folders match" in calls[4]["result"]
    assert not (workspace / "reference" / "new.md").exists()


async def test_trash_is_off_limits_for_agents(authed, workspace):
    cid = await setup(authed, **WRITE_ALLOWED)
    script(
        "peek",
        [call("list_files", path=".trash"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "peek")
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["status"] == "denied"


async def test_workspace_settings_are_sensitive(authed):
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import update

    from app.core.db import get_sessionmaker
    from app.features.auth.models import AuthSession

    async with get_sessionmaker()() as db:
        await db.execute(
            update(AuthSession).values(reauth_at=datetime.now(UTC) - timedelta(hours=1))
        )
        await db.commit()
    r = await authed.put("/api/settings/workspace", json={"default_agent_access": "none"})
    assert r.status_code == 403


_ = (uuid, execute_run)


def _png(path: Path, size=(64, 48)) -> None:
    from PIL import Image

    Image.new("RGB", size, "orange").save(path, "PNG")


async def _vision_setup(client, vision: bool) -> str:
    pid = (await client.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    caps = {"tools": True, "vision": vision}
    mid = (
        await client.post(
            "/api/models", json={"provider_id": pid, "model_key": "scripted", "capabilities": caps}
        )
    ).json()["id"]
    await client.put("/api/settings/models", json={"chat": mid})
    return (await client.post("/api/conversations", json={})).json()["id"]


async def test_read_file_shows_images_to_vision_models(authed, workspace):
    from app.providers.base import ImageBlock

    _png(workspace / "notes" / "photo.png")
    cid = await _vision_setup(authed, vision=True)
    script(
        "look at the photo",
        [call("read_file", path="notes/photo.png"), Done("tool_use")],
        [TextDelta("An orange square."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "look at the photo")
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["status"] == "succeeded", c
    image = c["result_data"]["image"]
    assert (image["width"], image["height"]) == (64, 48)

    # The model received the image itself, right after the tool result.
    last = FakeAdapter.requests[-1].messages[-1]
    assert [b.type for b in last.content] == ["tool_result", "text", "image"]
    sent = last.content[2]
    assert isinstance(sent, ImageBlock) and sent.media_type == "image/png"

    # The UI can show a thumbnail from the stored snapshot.
    r = await authed.get(f"/api/attachments/{image['attachment_id']}/content")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"


async def test_read_file_image_without_vision_explains(authed, workspace):
    _png(workspace / "notes" / "photo.png")
    cid = await _vision_setup(authed, vision=False)
    script(
        "look at the photo",
        [call("read_file", path="notes/photo.png"), Done("tool_use")],
        [TextDelta("I can't see it."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "look at the photo")
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert "cannot view images" in c["result"]
    assert all(b.type != "image" for m in FakeAdapter.requests[-1].messages for b in m.content)


async def test_images_respect_folder_access(authed, workspace):
    _png(workspace / "private" / "secret.png")
    cid = await _vision_setup(authed, vision=True)
    access = {"default_agent_access": "read_write", "folders": {"private": "none"}}
    await authed.put("/api/settings/workspace", json=access)
    script(
        "peek",
        [call("read_file", path="private/secret.png"), Done("tool_use")],
        [TextDelta("Blocked."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "peek")
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["status"] == "denied"
    assert all(b.type != "image" for m in FakeAdapter.requests[-1].messages for b in m.content)
