"""Images with a Claude Code job's prompt: starting, following up, what the computer gets,
what the page shows, and pruning (docs/specs/code-sessions.md §13)."""

import base64
import io
import uuid
from datetime import UTC, datetime
from typing import Any

from PIL import Image
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.attachments.models import Attachment
from app.features.code_sessions import images, service
from app.features.devices import relay
from tests.api.test_code_control import KEY, STARTED, FakeSend, device_side, error_code
from tests.api.test_code_sessions import announce, days_ago, init, send
from tests.api.test_devices import add
from tests.api.test_devices_ws import roundtrip, welcomed
from tests.api.test_extension_events import WsClient
from tests.conftest import requires_db

pytestmark = requires_db

__all__ = ["device_side"]  # the fixture, used by name


def png(width: int = 8, height: int = 8) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (200, 30, 30)).save(out, "PNG")
    return out.getvalue()


async def upload(authed, name: str, data: bytes, mime: str = "image/png") -> str:  # type: ignore[no-untyped-def]
    r = await authed.post("/api/attachments", files={"file": (name, data, mime)})
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


async def computer(authed, *, takes_images: bool = True) -> tuple[dict[str, Any], WsClient]:  # type: ignore[no-untyped-def]
    device = await add(authed, "PC", trust="trusted")
    ws, _ = await welcomed(device["token"])
    offer = {
        "type": "device.offer",
        "control": True,
        "shell": False,
        "code": True,
        "code_start": True,
    }
    if takes_images:
        offer["code_images"] = True  # Anemo Desktop 1.3.0
    await ws.send(offer)
    await roundtrip(ws)
    return device, ws


async def test_a_job_starts_with_images(authed, device_side: FakeSend):
    device, ws = await computer(authed)
    offered = await relay.online(uuid.UUID(device["id"]))
    assert offered is not None and offered.code_images is True
    shot = await upload(authed, "Screen Shot 1.png", png())
    photo = await upload(authed, "../photo.jpeg", png(), "image/jpeg")  # a PNG, whatever it says
    body = {
        "device_id": device["id"],
        "project": "anemo",
        "prompt": "Make it look like this",
        "image_ids": [shot, photo],
    }
    r = await authed.post("/api/code/jobs", json=body)
    assert r.status_code == 201, r.text
    job = r.json()
    assert job["images"] == [
        {"id": shot, "name": "1-Screen-Shot-1.png"},
        {"id": photo, "name": "2-photo.png"},
    ]
    # The computer gets each image's bytes and the name to write it under.
    action, fields, _ = device_side.sent[-1]
    assert action == "code_start" and fields["prompt"] == "Make it look like this"
    assert [i["name"] for i in fields["images"]] == ["1-Screen-Shot-1.png", "2-photo.png"]
    assert base64.b64decode(fields["images"][0]["data"]).startswith(b"\x89PNG")
    # Its prompt.txt lists the images' paths too: the page keeps the prompt as sent.
    listed = (
        "Make it look like this\n\nAttached images (open each one with the Read tool):\n- C:\\..."
    )
    await announce(ws, KEY, prompt=listed)
    shown = (await authed.get(f"/api/code/jobs/{job['id']}")).json()["job"]
    assert shown["prompt"] == "Make it look like this" and len(shown["images"]) == 2
    await ws.disconnect()


async def test_the_client_may_report_before_the_answer_comes(authed, device_side: FakeSend):
    device, ws = await computer(authed)
    shot = await upload(authed, "a.png", png())
    await announce(ws, KEY, prompt="Fix this\n\nAttached images (…)\n- C:\\jobs\\images\\1-a.png")
    body = {
        "device_id": device["id"],
        "project": "anemo",
        "prompt": "Fix this",
        "image_ids": [shot],
    }
    r = await authed.post("/api/code/jobs", json=body)
    assert r.status_code == 201, r.text
    assert r.json()["prompt"] == "Fix this" and r.json()["title"] == "Fix this"
    await ws.disconnect()


async def test_a_follow_up_with_images(authed, device_side: FakeSend):
    _, ws = await computer(authed)
    first = "20261124-090000-im01"
    await announce(ws, first, state="done")
    await send(ws, (1, init("s-1")), key=first)
    job_id = (await authed.get("/api/code/jobs")).json()["jobs"][0]["id"]
    shot = await upload(authed, "bug.webp", png())
    device_side.answers["code_start"] = {**STARTED, "job_id": "20261124-100000-im02"}
    r = await authed.post(
        f"/api/code/jobs/{job_id}/follow-up", json={"prompt": "And this", "image_ids": [shot]}
    )
    assert r.status_code == 201, r.text
    assert r.json()["images"] == [{"id": shot, "name": "1-bug.png"}]
    _, fields, _ = device_side.sent[-1]
    assert fields["resume_session"] == "s-1" and len(fields["images"]) == 1
    await ws.disconnect()


async def test_what_is_refused(authed, device_side: FakeSend, monkeypatch):
    device, ws = await computer(authed)
    body: dict[str, Any] = {"device_id": device["id"], "project": "anemo", "prompt": "Look"}
    text = await upload(authed, "notes.txt", b"just text", "text/plain")
    r = await authed.post("/api/code/jobs", json={**body, "image_ids": [text]})
    assert (r.status_code, error_code(r)) == (422, "bad_image")
    assert "isn't a PNG, JPEG, WebP or GIF image" in r.json()["error"]["message"]
    r = await authed.post("/api/code/jobs", json={**body, "image_ids": [str(uuid.uuid4())]})
    assert (r.status_code, error_code(r)) == (422, "bad_image")
    shot = await upload(authed, "a.png", png())
    r = await authed.post("/api/code/jobs", json={**body, "image_ids": [shot] * 9})
    assert r.status_code == 422  # more than 8 ids: the request itself is refused
    # Together too large after scaling down.
    big = await upload(authed, "big.png", png())
    monkeypatch.setattr(images, "MAX_TOTAL_BYTES", 10)
    r = await authed.post("/api/code/jobs", json={**body, "image_ids": [big]})
    assert (r.status_code, error_code(r)) == (422, "images_too_large")
    assert device_side.sent == []  # nothing reached the computer
    await ws.disconnect()


async def test_an_older_desktop_gets_no_images(authed, device_side: FakeSend):
    device, ws = await computer(authed, takes_images=False)
    shot = await upload(authed, "a.png", png())
    body = {"device_id": device["id"], "project": "anemo", "prompt": "Look", "image_ids": [shot]}
    r = await authed.post("/api/code/jobs", json=body)
    assert (r.status_code, error_code(r)) == (409, "images_unsupported")
    assert "update it to 1.3.0" in r.json()["error"]["message"]
    # Without images it starts as before.
    r = await authed.post("/api/code/jobs", json={**body, "image_ids": []})
    assert r.status_code == 201 and r.json()["images"] == []
    assert "images" not in device_side.sent[-1][1]
    await ws.disconnect()


async def test_pruning_a_job_deletes_its_images(authed, device_side: FakeSend):
    device, ws = await computer(authed)
    shot = await upload(authed, "a.png", png())
    body = {"device_id": device["id"], "project": "anemo", "prompt": "Look", "image_ids": [shot]}
    assert (await authed.post("/api/code/jobs", json=body)).status_code == 201
    old = days_ago(60)
    await announce(ws, KEY, started=old, state="done", ended=old)
    assert await service.prune(datetime.now(UTC)) == 1
    async with get_sessionmaker()() as db:
        assert await db.scalar(select(Attachment).where(Attachment.id == uuid.UUID(shot))) is None
    await ws.disconnect()
