import base64
import uuid

from app.runtime.chat import execute_chat_run
from tests.conftest import requires_db

pytestmark = requires_db

# 1x1 transparent PNG
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


def minimal_pdf(text: str) -> bytes:
    """A tiny valid one-page PDF containing `text`."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    return out


async def _upload(client, name, data, mime="application/octet-stream"):
    return await client.post("/api/attachments", files={"file": (name, data, mime)})


async def _setup(client, vision=False):
    pid = (await client.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    body = {"provider_id": pid, "model_key": "echo"}
    if vision:
        body["capabilities"] = {"vision": True}
    mid = (await client.post("/api/models", json=body)).json()["id"]
    await client.put("/api/settings/models", json={"chat": mid})
    return (await client.post("/api/conversations", json={})).json()["id"]


async def test_upload_kinds_and_rejections(authed):
    r = await _upload(authed, "notes.md", b"# Notes\nhello", "text/markdown")
    assert r.status_code == 201 and r.json()["kind"] == "text"
    r = await _upload(authed, "doc.pdf", minimal_pdf("Quarterly report"), "application/pdf")
    assert r.status_code == 201 and r.json()["kind"] == "pdf"
    r = await _upload(authed, "pic.png", PNG, "image/png")
    assert r.json()["kind"] == "image" and r.json()["mime"] == "image/png"
    # Declared type is not trusted: an "image" that is really a zip is rejected.
    r = await _upload(authed, "fake.png", b"PK\x03\x04" + b"\x00" * 20, "image/png")
    assert r.status_code == 415
    assert r.json()["error"]["code"] == "unsupported_file"
    assert (await _upload(authed, "empty.txt", b"", "text/plain")).status_code == 400


async def test_text_and_pdf_reach_the_model(authed):
    cid = await _setup(authed)
    a1 = (await _upload(authed, "todo.txt", b"buy milk", "text/plain")).json()["id"]
    a2 = (await _upload(authed, "r.pdf", minimal_pdf("Quarterly report"), "application/pdf")).json()
    r = await authed.post(
        f"/api/conversations/{cid}/turns",
        json={"text": "summarize", "attachment_ids": [a1, a2["id"]]},
    )
    assert r.status_code == 202
    assert [a["filename"] for a in r.json()["user_message"]["attachments"]] == ["todo.txt", "r.pdf"]
    await execute_chat_run(uuid.UUID(r.json()["run_id"]))

    msgs = (await authed.get(f"/api/conversations/{cid}/messages")).json()
    reply = msgs[1]["text"]  # the fake model echoes all text it received
    assert "buy milk" in reply and "Quarterly report" in reply and "summarize" in reply
    assert len(msgs[0]["attachments"]) == 2

    # An attachment can only be sent once.
    r = await authed.post(
        f"/api/conversations/{cid}/turns", json={"text": "again", "attachment_ids": [a1]}
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "attachment_used"


async def test_image_needs_a_vision_model(authed):
    cid = await _setup(authed, vision=False)
    img = (await _upload(authed, "pic.png", PNG, "image/png")).json()["id"]
    turn = (
        await authed.post(
            f"/api/conversations/{cid}/turns",
            json={"text": "what is this", "attachment_ids": [img]},
        )
    ).json()
    await execute_chat_run(uuid.UUID(turn["run_id"]))
    run = (await authed.get(f"/api/runs/{turn['run_id']}")).json()
    assert run["status"] == "failed" and "vision" in run["error"]["message"]


async def test_image_with_vision_model_and_content_endpoint(authed):
    cid = await _setup(authed, vision=True)
    img = (await _upload(authed, "pic.png", PNG, "image/png")).json()["id"]
    turn = (
        await authed.post(
            f"/api/conversations/{cid}/turns", json={"text": "describe", "attachment_ids": [img]}
        )
    ).json()
    await execute_chat_run(uuid.UUID(turn["run_id"]))
    assert (await authed.get(f"/api/runs/{turn['run_id']}")).json()["status"] == "completed"
    r = await authed.get(f"/api/attachments/{img}/content")
    assert r.status_code == 200 and r.content == PNG
    assert r.headers["x-content-type-options"] == "nosniff"


async def test_non_images_download_instead_of_rendering(authed):
    a = (await _upload(authed, "page.html", b"<script>alert(1)</script>", "text/html")).json()
    r = await authed.get(f"/api/attachments/{a['id']}/content")
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"].startswith("attachment")
