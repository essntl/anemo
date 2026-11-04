"""Files between the user and the agent: Office files and zips as attachments,
save_attachment, read_file on Office files, create_zip / extract_zip and attach_file."""

import io
import shutil
import uuid
import zipfile
from pathlib import Path

import pytest

from app.core.config import get_settings
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.runtime.chat import execute_chat_run
from app.runtime.dispatch import execute_run
from tests.api.test_agent import call, script, setup, timeline
from tests.conftest import requires_db
from tests.office_files import docx, xlsx, zip_of

pytestmark = requires_db

WRITE = {"fs.write": "autonomous"}


@pytest.fixture(autouse=True)
def workspace():
    root = Path(get_settings().workspace_path)
    if root.exists():
        shutil.rmtree(root)
    (root / "reports").mkdir(parents=True)
    (root / "reports" / "summary.md").write_text("# Summary")
    (root / "reports" / "data.csv").write_text("a,b\n1,2\n")
    (root / "private").mkdir()
    (root / "private" / "diary.md").write_text("secret")
    FakeAdapter.scripts.clear()
    yield root


async def upload(client, name, data, mime="application/octet-stream"):
    r = await client.post("/api/attachments", files={"file": (name, data, mime)})
    assert r.status_code == 201, r.text
    return r.json()


async def turn(client, cid, text, attachment_ids=(), mode="agent"):
    r = await client.post(
        f"/api/conversations/{cid}/turns",
        json={"text": text, "mode": mode, "attachment_ids": list(attachment_ids)},
    )
    assert r.status_code == 202, r.text
    return r.json()["run_id"]


def sent_text() -> str:
    """Every text block of the latest request the fake model received."""
    req = FakeAdapter.requests[-1]
    return "\n".join(
        getattr(b, "text", None) or getattr(b, "content", "") or ""
        for m in req.messages
        for b in m.content
    )


async def test_office_files_and_any_file_can_be_attached(authed):
    pid = (await authed.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    mid = (await authed.post("/api/models", json={"provider_id": pid, "model_key": "echo"})).json()
    await authed.put("/api/settings/models", json={"chat": mid["id"]})
    cid = (await authed.post("/api/conversations", json={})).json()["id"]

    doc = await upload(authed, "plan.docx", docx("Roadmap", "Ship in May.", [["A", "B"]]))
    sheet = await upload(authed, "q3.xlsx", xlsx({"Sales": [["Month", "Total"], ["Jan", 42]]}))
    bundle = await upload(authed, "src.zip", zip_of({"main.py": "print('zipped')"}))
    blob = await upload(authed, "db.sqlite", b"SQLite format 3\x00" + b"\x00" * 64)
    assert [doc["kind"], sheet["kind"], bundle["kind"], blob["kind"]] == [
        "document",
        "spreadsheet",
        "archive",
        "file",
    ]
    assert sheet["mime"].endswith("spreadsheetml.sheet")

    run_id = await turn(
        authed, cid, "what is in these", [doc["id"], sheet["id"], bundle["id"], blob["id"]], "chat"
    )
    await execute_chat_run(uuid.UUID(run_id))
    reply = (await authed.get(f"/api/conversations/{cid}/messages")).json()[1]["text"]
    assert "# Roadmap" in reply and "Ship in May." in reply
    assert "Jan,42" in reply and "print('zipped')" in reply
    assert "cannot be shown as text" in reply  # the sqlite file: name, type and size only
    # Chat mode has no tools, so it is not told about save_attachment.
    assert "save_attachment" not in sent_text()


async def test_agent_saves_reads_zips_and_attaches_files(authed, workspace):
    cid = await setup(authed, **WRITE)
    sheet = await upload(authed, "q3.xlsx", xlsx({"Sales": [["Month", "Total"], ["Jan", 42]]}))
    script(
        "make the report",
        [
            call("save_attachment", attachment_id=sheet["id"], path="inbox/q3.xlsx"),
            Done("tool_use"),
        ],
        [call("read_file", path="inbox/q3.xlsx"), Done("tool_use")],
        [
            call("create_zip", paths=["reports", "inbox/q3.xlsx"], destination="out/bundle.zip"),
            Done("tool_use"),
        ],
        [call("attach_file", paths=["out/bundle.zip", "reports/data.csv"]), Done("tool_use")],
        [TextDelta("Here is the bundle."), Done("end")],
    )
    run_id = await turn(authed, cid, "make the report", [sheet["id"]])
    await execute_run(uuid.UUID(run_id))
    t = await timeline(authed, run_id)
    assert [c["status"] for c in t["tool_calls"]] == ["succeeded"] * 4, t["tool_calls"]

    # The agent was told the attachment's id and how to get at the file.
    assert f'id="{sheet["id"]}"' in sent_text() and "save_attachment" in sent_text()
    # save_attachment copied the real file; read_file shows its sheets.
    assert (workspace / "inbox" / "q3.xlsx").read_bytes()[:2] == b"PK"
    assert "Month,Total\nJan,42" in t["tool_calls"][1]["result"]
    # The zip has both, named relative to the folder they share.
    with zipfile.ZipFile(workspace / "out" / "bundle.zip") as zf:
        assert sorted(zf.namelist()) == [
            "inbox/q3.xlsx",
            "reports/data.csv",
            "reports/summary.md",
        ]
    assert [(c["op"], c["path"]) for c in t["file_changes"]] == [
        ("create", "inbox/q3.xlsx"),
        ("create", "out/bundle.zip"),
    ]

    # The attached files are on the answer, and download as they were.
    answer = (await authed.get(f"/api/conversations/{cid}/messages")).json()[-1]
    assert answer["text"] == "Here is the bundle."
    files = {a["filename"]: a for a in answer["attachments"]}
    assert set(files) == {"bundle.zip", "data.csv"}
    assert files["bundle.zip"]["kind"] == "archive"
    r = await authed.get(f"/api/attachments/{files['data.csv']['id']}/content")
    assert r.content == b"a,b\n1,2\n"
    assert r.headers["content-disposition"].startswith("attachment")
    assert t["tool_calls"][3]["result_data"]["files"][0]["filename"] == "bundle.zip"


async def test_attaching_again_replaces_the_earlier_copy(authed, workspace):
    cid = await setup(authed)
    script(
        "attach twice",
        [call("attach_file", paths=["reports/summary.md"]), Done("tool_use")],
        [call("attach_file", paths=["reports/summary.md"]), Done("tool_use")],
        [TextDelta("Done."), Done("end")],
    )
    run_id = await authed.post(
        f"/api/conversations/{cid}/turns", json={"text": "attach twice", "mode": "agent"}
    )
    await execute_run(uuid.UUID(run_id.json()["run_id"]))
    answer = (await authed.get(f"/api/conversations/{cid}/messages")).json()[-1]
    assert [a["filename"] for a in answer["attachments"]] == ["summary.md"]


async def test_attach_file_respects_folder_access_and_refuses_folders(authed, workspace):
    cid = await setup(authed)
    r = await authed.put(
        "/api/settings/workspace",
        json={"default_agent_access": "read_write", "folders": {"private": "none"}},
    )
    assert r.status_code == 200, r.text
    script(
        "attach things",
        [
            call("attach_file", paths=["private/diary.md"]),
            call("attach_file", paths=["reports"]),
            Done("tool_use"),
        ],
        [TextDelta("Could not."), Done("end")],
    )
    run_id = await turn(authed, cid, "attach things")
    await execute_run(uuid.UUID(run_id))
    t = await timeline(authed, run_id)
    hidden, folder = t["tool_calls"]
    assert hidden["status"] == "denied" and "hidden" in hidden["decision_reason"]
    assert folder["is_error"] and "create_zip" in folder["result"]
    answer = (await authed.get(f"/api/conversations/{cid}/messages")).json()[-1]
    assert answer["attachments"] == []


async def test_save_attachment_only_from_this_chat(authed, workspace):
    cid = await setup(authed, **WRITE)
    other = (await authed.post("/api/conversations", json={})).json()["id"]
    elsewhere = await upload(authed, "notes.txt", b"from another chat")
    await authed.post(
        f"/api/conversations/{other}/turns",
        json={"text": "hi", "attachment_ids": [elsewhere["id"]]},
    )
    script(
        "steal",
        [
            call("save_attachment", attachment_id=elsewhere["id"], path="x.txt"),
            Done("tool_use"),
        ],
        [TextDelta("No."), Done("end")],
    )
    run_id = await turn(authed, cid, "steal")
    await execute_run(uuid.UUID(run_id))
    (only,) = (await timeline(authed, run_id))["tool_calls"]
    assert only["is_error"] and "No attachment" in only["result"]
    assert not (workspace / "x.txt").exists()


async def test_extract_zip_unpacks_into_a_new_folder_and_refuses_unsafe_paths(authed, workspace):
    (workspace / "in").mkdir()
    (workspace / "in" / "good.zip").write_bytes(zip_of({"a/b.txt": "hello", "c.txt": "c"}))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("../../escape.txt", "nope")
    (workspace / "in" / "evil.zip").write_bytes(buf.getvalue())
    cid = await setup(authed, **WRITE)
    script(
        "unpack",
        [
            call("extract_zip", path="in/good.zip", destination="unpacked"),
            call("extract_zip", path="in/evil.zip", destination="evil"),
            call("extract_zip", path="in/good.zip", destination="reports"),
            Done("tool_use"),
        ],
        [TextDelta("Unpacked."), Done("end")],
    )
    run_id = await turn(authed, cid, "unpack")
    await execute_run(uuid.UUID(run_id))
    good, evil, taken = (await timeline(authed, run_id))["tool_calls"]
    assert good["status"] == "succeeded", good
    assert (workspace / "unpacked" / "a" / "b.txt").read_text() == "hello"
    assert evil["is_error"] and "unsafe path" in evil["result"]
    assert not (workspace / "evil").exists()
    assert not (workspace.parent / "escape.txt").exists()
    assert taken["is_error"] and "not empty" in taken["result"]
    t = await timeline(authed, run_id)
    assert [(c["op"], c["path"]) for c in t["file_changes"]] == [("mkdir", "unpacked")]


async def test_regenerated_answers_keep_their_own_files(authed, workspace):
    cid = await setup(authed)
    script(
        "give me the csv",
        [call("attach_file", paths=["reports/data.csv"]), Done("tool_use")],
        [TextDelta("Here."), Done("end")],
    )
    first = await turn(authed, cid, "give me the csv")
    await execute_run(uuid.UUID(first))
    script(
        "give me the csv",
        [call("attach_file", paths=["reports/summary.md"]), Done("tool_use")],
        [TextDelta("Here again."), Done("end")],
    )
    r = await authed.post(f"/api/conversations/{cid}/regenerate", json={})
    assert r.status_code == 202, r.text
    await execute_run(uuid.UUID(r.json()["run_id"]))
    answer = (await authed.get(f"/api/conversations/{cid}/messages")).json()[-1]
    assert [a["filename"] for a in answer["attachments"]] == ["summary.md"]
    by_text = {v["text"]: [a["filename"] for a in v["attachments"]] for v in answer["versions"]}
    assert by_text == {"Here.": ["data.csv"], "Here again.": ["summary.md"]}
