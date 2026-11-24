"""generate_image end to end: the agent (or a chat) calls the tool, the image provider is
answered by a mock transport (no network, no real key), and the pictures land in the
workspace with their provenance, under the answer, in the usage records.

See docs/specs/10-image-generation.md."""

import base64
import io
import json
import shutil
import uuid
from pathlib import Path

import httpx
import pytest
from PIL import Image
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.usage.models import UsageRecord
from app.providers import images
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.runtime.dispatch import execute_run
from app.web import safe_http
from tests.api.test_agent import (
    agent_turn,
    call,
    script,
    setup,
    timeline,
    tool_results_sent_to_model,
)
from tests.api.test_notifications_automations import fire, make
from tests.conftest import requires_db

pytestmark = requires_db

KEY = "sk-image-secret-key-0042"


def png(color=(220, 60, 20), size=(16, 12)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, "PNG")
    return out.getvalue()


class Provider:
    """A stand-in for the image provider's HTTP API: answers with `pictures` and keeps
    what it was sent."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.status = 200
        self.body: dict | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        if self.body is not None:
            return httpx.Response(self.status, json=self.body)
        n = 1
        if request.headers.get("content-type", "").startswith("application/json"):
            n = json.loads(request.content).get("n", 1)
        data = [{"b64_json": base64.b64encode(png((40 * i, 90, 160))).decode()} for i in range(n)]
        return httpx.Response(
            200, json={"data": data, "usage": {"input_tokens": 20, "output_tokens": 1000}}
        )

    def json(self) -> dict:
        return json.loads(self.requests[-1].content)


@pytest.fixture
def provider(monkeypatch):
    fake = Provider()
    monkeypatch.setattr(images, "transport_override", httpx.MockTransport(fake))
    return fake


@pytest.fixture(autouse=True)
def workspace():
    from app.core.config import get_settings

    root = Path(get_settings().workspace_path)
    if root.exists():
        shutil.rmtree(root)
    (root / "art").mkdir(parents=True)
    (root / "art" / "fox.png").write_bytes(png())
    (root / "art" / "notes.txt").write_text("not a picture")
    FakeAdapter.scripts.clear()
    FakeAdapter.requests.clear()
    yield root


async def image_model(client, *, model_key="gpt-image-1.5", kind="openai", default=True) -> str:
    """An OpenAI provider with a key and an image model (capabilities guessed by name)."""
    r = await client.post(
        "/api/providers", json={"name": f"Images {kind}", "type": kind, "api_key": KEY}
    )
    assert r.status_code == 201, r.text
    r = await client.post(
        "/api/models", json={"provider_id": r.json()["id"], "model_key": model_key}
    )
    assert r.status_code == 201, r.text
    model = r.json()
    assert model["capabilities"]["image_generation"] and not model["capabilities"]["chat"]
    if default:
        current = (await client.get("/api/settings")).json()["models"]
        r = await client.put("/api/settings/models", json={**current, "image": model["id"]})
        assert r.status_code == 200, r.text
    return model["id"]


async def answer(client, cid) -> dict:
    return (await client.get(f"/api/conversations/{cid}/messages")).json()[-1]


async def test_agent_generates_saves_and_shows_pictures(authed, provider, workspace):
    cid = await setup(authed)
    await image_model(authed)
    script(
        "draw a fox",
        [
            call(
                "generate_image",
                prompt="A red fox at dawn, watercolour",
                count=2,
                aspect_ratio="16:9",
            ),
            Done("tool_use"),
        ],
        [TextDelta("Here are two foxes."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "draw a fox")
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "succeeded", row
    assert row["decision"] == "allow"  # "Generate images" is allowed by default

    # The provider got the request built from the call.
    sent = provider.json()
    assert sent["model"] == "gpt-image-1.5" and sent["n"] == 2 and sent["size"] == "1536x1024"
    assert provider.requests[-1].headers["authorization"] == f"Bearer {KEY}"

    # Saved under files/generated/<date>/, with a provenance file next to each.
    folder = next((workspace / "files" / "generated").iterdir())
    names = sorted(p.name for p in folder.iterdir())
    stem = "a-red-fox-at-dawn-watercolour"
    assert names == [f"{stem}-1.png", f"{stem}-1.png.json", f"{stem}-2.png", f"{stem}-2.png.json"]
    meta = json.loads((folder / f"{stem}-1.png.json").read_text())
    assert meta["prompt"] == "A red fox at dawn, watercolour"
    assert meta["model"] == "gpt-image-1.5" and meta["provider"] == "Images openai"
    assert meta["size"] == "16x12" and meta["aspect_ratio"] == "16:9"
    assert meta["chat_id"] == cid and meta["run_id"] == run_id
    assert meta["made_by"] == f"chat:{cid}"

    # The model was told where they are; the UI gets the paths and the attachments.
    rel = f"files/generated/{folder.name}/{stem}-1.png"
    assert rel in row["result"] and "shown to the user" in row["result"]
    data = row["result_data"]
    assert [i["path"] for i in data["generated"]] == [rel, rel.replace("-1.png", "-2.png")]

    # Under the answer, linked to the workspace file.
    reply = await answer(authed, cid)
    assert reply["text"] == "Here are two foxes."
    assert [(a["kind"], a["path"]) for a in reply["attachments"]] == [
        ("image", rel),
        ("image", rel.replace("-1.png", "-2.png")),
    ]
    assert [a["id"] for a in reply["attachments"]] == [
        i["attachment_id"] for i in data["generated"]
    ]
    content = await authed.get(f"/api/attachments/{reply['attachments'][0]['id']}/content")
    assert content.content == (workspace / rel).read_bytes()

    # Recorded in the run's history (revertible) and in the usage.
    t = await timeline(authed, run_id)
    assert [(c["op"], c["path"]) for c in t["file_changes"]][:2] == [
        ("create", rel),
        ("create", f"{rel}.json"),
    ]
    async with get_sessionmaker()() as db:
        rec = await db.scalar(select(UsageRecord).where(UsageRecord.request_kind == "image"))
    assert rec is not None and rec.model_key == "gpt-image-1.5"
    assert (rec.input_tokens, rec.output_tokens) == (20, 1000)
    assert str(rec.run_id) == run_id

    # The key never reached the model.
    everything = json.dumps([r.model_dump(mode="json") for r in FakeAdapter.requests])
    assert KEY not in everything and KEY not in json.dumps(t)


async def test_count_and_resolution_are_capped_by_the_settings(authed, provider):
    cid = await setup(authed)
    await image_model(authed, model_key="google/gemini-2.5-flash-image", kind="openrouter")
    r = await authed.put(
        "/api/settings/images",
        json={"max_count": 2, "max_resolution": "1K", "ask_in_automations": True},
    )
    assert r.status_code == 200, r.text
    script(
        "many",
        [call("generate_image", prompt="cats", count=9, resolution="4K"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "many")
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "succeeded", row
    assert provider.json()["n"] == 2 and provider.json()["resolution"] == "1K"
    assert "made 2, the most one call may make" in row["result"]
    assert "at 1K, the largest allowed" in row["result"]
    # More than the hard cap is refused before anything is sent.
    assert (await authed.put("/api/settings/images", json={"max_count": 11})).status_code == 422


async def test_in_a_project_chat_and_to_a_chosen_path(authed, provider, workspace):
    await setup(authed, **{"fs.write": "autonomous"})
    await image_model(authed)
    project = (await authed.post("/api/projects", json={"name": "Thesis"})).json()
    cid = (await authed.post("/api/conversations", json={"project_id": project["id"]})).json()["id"]
    script(
        "cover",
        [call("generate_image", prompt="a cover"), Done("tool_use")],
        [call("generate_image", prompt="a hero", path="site/hero.webp"), Done("tool_use")],
        [call("generate_image", prompt="again", path="site/hero.png"), Done("tool_use")],
        [TextDelta("done"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "cover")
    rows = (await timeline(authed, run_id))["tool_calls"]
    assert [r["status"] for r in rows] == ["succeeded"] * 3, rows
    day = next((workspace / "projects" / "thesis" / "generated").iterdir()).name
    assert rows[0]["result_data"]["path"] == f"projects/thesis/generated/{day}/a-cover.png"
    # A file name keeps its name (with the picture's own extension); a taken one gets -2.
    assert rows[1]["result_data"]["path"] == "site/hero.png"
    assert rows[2]["result_data"]["path"] == "site/hero-2.png"
    assert (workspace / "site" / "hero.png.json").is_file()


async def test_a_chosen_path_needs_file_writing(authed, provider, workspace):
    cid = await setup(authed, **{"fs.write": "deny"})
    await image_model(authed)
    script(
        "save",
        [call("generate_image", prompt="x", path="site/x.png"), Done("tool_use")],
        [call("generate_image", prompt="y"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "save")
    first, second = (await timeline(authed, run_id))["tool_calls"]
    assert first["status"] == "denied"
    assert len(provider.requests) == 1  # only the second call reached the provider
    # The default folder only needs the "Generate images" permission.
    assert second["status"] == "succeeded", second


async def test_a_read_only_folder_is_not_written(authed, provider, workspace):
    cid = await setup(authed)
    await image_model(authed)
    r = await authed.put("/api/settings/workspace", json={"folders": {"files": "read"}})
    assert r.status_code == 200, r.text
    script(
        "ro", [call("generate_image", prompt="x"), Done("tool_use")], [TextDelta("ok"), Done("end")]
    )
    run_id = await agent_turn(authed, cid, "ro")
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "failed" and "read-only for agents" in row["result"]
    assert provider.requests == []


async def test_editing_sends_the_input_images(authed, provider, workspace):
    cid = await setup(authed, **{"fs.read": "autonomous"})
    await image_model(authed)
    script(
        "edit",
        [
            call("generate_image", prompt="make it blue", input_images=["art/fox.png"]),
            Done("tool_use"),
        ],
        [call("generate_image", prompt="x", input_images=["art/notes.txt"]), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "edit")
    first, second = (await timeline(authed, run_id))["tool_calls"]
    assert first["status"] == "succeeded", first
    assert str(provider.requests[0].url).endswith("/images/edits")
    assert b'filename="fox.png"' in provider.requests[0].content
    meta_path = workspace / (first["result_data"]["path"] + ".json")
    assert json.loads(meta_path.read_text())["input_images"] == ["art/fox.png"]
    assert second["status"] == "failed" and "not an image" in second["result"]
    assert len(provider.requests) == 1


async def test_model_override_only_among_configured_image_models(authed, provider):
    cid = await setup(authed)
    await image_model(authed)
    await image_model(authed, model_key="gpt-image-2", default=False)
    script(
        "pick",
        [call("generate_image", prompt="x", model="gpt-image-2"), Done("tool_use")],
        [call("generate_image", prompt="x", model="scripted"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "pick")
    first, second = (await timeline(authed, run_id))["tool_calls"]
    assert first["status"] == "succeeded" and "gpt-image-2" in first["result"]
    assert provider.json()["model"] == "gpt-image-2"
    # A chat model (or anything else) cannot be named.
    assert second["status"] == "failed"
    assert "no image model 'scripted'" in second["result"] and "gpt-image-1.5" in second["result"]
    assert len(provider.requests) == 1


async def test_without_an_image_model_the_tool_says_what_to_set_up(authed, provider):
    cid = await setup(authed)
    script(
        "draw",
        [call("generate_image", prompt="x"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "draw")
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "failed"
    assert "Settings → Providers & Models" in row["result"] and "Image generation" in row["result"]
    assert provider.requests == []


@pytest.mark.parametrize(
    ("status", "body", "words"),
    [
        (
            400,
            {"error": {"code": "moderation_blocked", "message": "rejected by the safety system"}},
            "content policy",
        ),
        (
            401,
            {"error": {"message": "Incorrect API key provided: sk-...0042"}},
            "did not accept the API key",
        ),
        (200, {"data": []}, "without an image"),
        (200, {"data": [{"b64_json": base64.b64encode(b"<html>").decode()}]}, "not an image"),
    ],
)
async def test_provider_errors_are_readable_tool_results(
    authed, provider, workspace, status, body, words
):
    cid = await setup(authed)
    await image_model(authed)
    provider.status, provider.body = status, body
    script(
        "fail",
        [call("generate_image", prompt="x"), Done("tool_use")],
        [TextDelta("sorry"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "fail")
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "failed" and words in row["result"]
    assert words in tool_results_sent_to_model()[-1]
    assert (await answer(authed, cid))["status"] == "complete"  # the run went on
    assert not (workspace / "files").exists()
    # A provider that answered may have charged: that is recorded, an error answer is not.
    async with get_sessionmaker()() as db:
        records = list(
            await db.scalars(select(UsageRecord).where(UsageRecord.request_kind == "image"))
        )
    assert len(records) == (1 if status == 200 else 0)


async def test_url_answers_are_downloaded_only_when_they_are_images(
    authed, provider, workspace, monkeypatch
):
    served: dict[str, httpx.Response] = {
        "https://cdn.example.test/ok.png": httpx.Response(
            200, content=png(), headers={"content-type": "image/png"}
        ),
        "https://cdn.example.test/page": httpx.Response(
            200, content=b"<html>hi</html>", headers={"content-type": "text/html"}
        ),
        "https://cdn.example.test/lie.png": httpx.Response(
            200, content=b"MZ not a png", headers={"content-type": "image/png"}
        ),
    }
    monkeypatch.setattr(
        safe_http, "transport_override", httpx.MockTransport(lambda r: served[str(r.url)])
    )
    cid = await setup(authed)
    await image_model(authed, model_key="flux-dev", kind="openai_compatible")
    script(
        "urls",
        [call("generate_image", prompt="ok"), Done("tool_use")],
        [call("generate_image", prompt="page"), Done("tool_use")],
        [call("generate_image", prompt="lie"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )

    def by_prompt(request: httpx.Request) -> httpx.Response:
        provider.requests.append(request)
        name = {"ok": "ok.png", "page": "page", "lie": "lie.png"}[
            json.loads(request.read())["prompt"]
        ]
        return httpx.Response(200, json={"data": [{"url": f"https://cdn.example.test/{name}"}]})

    monkeypatch.setattr(images, "transport_override", httpx.MockTransport(by_prompt))
    run_id = await agent_turn(authed, cid, "urls")
    ok, page, lie = (await timeline(authed, run_id))["tool_calls"]
    assert ok["status"] == "succeeded", ok
    assert (workspace / ok["result_data"]["path"]).read_bytes() == png()
    assert page["status"] == "failed" and "text/html" in page["result"]
    assert lie["status"] == "failed" and "not an image" in lie["result"]


async def test_a_private_address_in_an_answer_is_not_fetched(authed, workspace, monkeypatch):
    monkeypatch.setattr(
        images,
        "transport_override",
        httpx.MockTransport(
            lambda r: httpx.Response(200, json={"data": [{"url": "http://192.168.1.1/x.png"}]})
        ),
    )
    cid = await setup(authed)
    await image_model(authed, model_key="flux-dev", kind="openai_compatible")
    script(
        "lan",
        [call("generate_image", prompt="x"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "lan")
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "failed" and "private network" in row["result"]


async def test_chat_mode_offers_it_when_allowed_without_asking(authed, provider):
    cid = await setup(authed)
    await authed.put("/api/settings/memory", json={"enabled": False})
    await image_model(authed)
    script(
        "a cat please",
        [call("generate_image", prompt="a cat"), Done("tool_use")],
        [TextDelta("Here is a cat."), Done("end")],
    )
    r = await authed.post(
        f"/api/conversations/{cid}/turns", json={"text": "a cat please", "mode": "chat"}
    )
    await execute_run(uuid.UUID(r.json()["run_id"]))
    # An image model is set: chat uses the tool loop even with memory off.
    assert [t.name for t in FakeAdapter.requests[0].tools] == ["generate_image"]
    reply = await answer(authed, cid)
    assert reply["text"] == "Here is a cat." and reply["attachments"][0]["kind"] == "image"

    # "Always ask": chat has no approval step, so it is not offered there.
    await authed.put("/api/settings/permissions", json={"levels": {"image.generate": "ask"}})
    script("another", [TextDelta("no tool"), Done("end")])
    r = await authed.post(
        f"/api/conversations/{cid}/turns", json={"text": "another", "mode": "chat"}
    )
    await execute_run(uuid.UUID(r.json()["run_id"]))
    assert FakeAdapter.requests[-1].tools == []


async def test_automations_ask_first_unless_switched_off(authed, provider, workspace):
    await setup(authed)
    await image_model(authed)
    a = await make(authed, prompt="daily picture")
    script(
        "daily picture",
        [call("generate_image", prompt="sunrise"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await fire(authed, a)
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "waiting_approval" and row["decision"] == "ask", row
    assert provider.requests == []

    r = await authed.put("/api/settings/images", json={"ask_in_automations": False})
    assert r.status_code == 200, r.text
    b = await make(authed, name="Evening", prompt="evening picture")
    script(
        "evening picture",
        [call("generate_image", prompt="sunset"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await fire(authed, b)
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "succeeded", row


async def test_never_takes_the_tool_away(authed):
    cid = await setup(authed, **{"image.generate": "deny"})
    script("x", [TextDelta("ok"), Done("end")])
    await agent_turn(authed, cid, "x")
    assert "generate_image" not in [t.name for t in FakeAdapter.requests[-1].tools]


async def test_testing_an_image_model_costs_nothing(authed, provider):
    mid = await image_model(authed, default=False)
    r = await authed.post(f"/api/models/{mid}/test")
    assert r.status_code == 200, r.text
    assert r.json()["ok"] and "costs money" in r.json()["message"]
    assert provider.requests == []
