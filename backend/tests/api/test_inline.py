"""In-page translate and explain: nothing personal ever reaches these requests."""

import json

from app.providers.adapters.fake import FakeAdapter
from app.providers.base import TextBlock
from tests.conftest import requires_db

pytestmark = requires_db


async def _model(client) -> str:  # type: ignore[no-untyped-def]
    pid = (await client.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    mid = (await client.post("/api/models", json={"provider_id": pid, "model_key": "echo"})).json()
    await client.put("/api/settings/models", json={"chat": mid["id"]})
    return str(mid["id"])


def _events(body: str) -> list[tuple[str, dict]]:
    out = []
    for block in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" in lines:
            out.append((lines["event"], json.loads(lines["data"])))
    return out


def _sent() -> str:
    request = FakeAdapter.requests[-1]
    return (
        (request.system or "")
        + "\n"
        + "\n".join(b.text for m in request.messages for b in m.content if isinstance(b, TextBlock))
    )


async def _personal_data(client) -> None:  # type: ignore[no-untyped-def]
    """Everything Anemo knows about the user that must never reach an inline request."""
    await client.post("/api/memories", json={"content": "Lives at Keizersgracht 12, Amsterdam."})
    await client.post(
        "/api/memories", json={"content": "Always answer like a pirate.", "kind": "instruction"}
    )
    await client.post(
        "/api/documents", json={"title": "Diary", "content": "# Diary\n\nSECRET-DIARY-ENTRY"}
    )
    await client.post(
        "/api/projects", json={"name": "Thesis", "instructions": "PROJECT-SECRET-INSTRUCTIONS"}
    )
    await client.post(
        "/api/profiles", json={"name": "Researcher", "instructions": "PROFILE-SECRET"}
    )
    cid = (await client.post("/api/conversations", json={})).json()["id"]
    r = await client.post(
        f"/api/conversations/{cid}/turns", json={"text": "OTHER-CHAT-SECRET question"}
    )
    assert r.status_code == 202


SECRETS = (
    "Keizersgracht",
    "pirate",
    "SECRET-DIARY-ENTRY",
    "PROJECT-SECRET-INSTRUCTIONS",
    "PROFILE-SECRET",
    "OTHER-CHAT-SECRET",
)


async def test_explain_streams_and_sends_nothing_personal(authed):
    await _model(authed)
    await _personal_data(authed)
    before = len((await authed.get("/api/conversations")).json())
    r = await authed.post(
        "/api/inline/explain",
        json={
            "text": "fotosyntese",
            "context": "Planter bruker fotosyntese for å lage sukker.",
            "url": "https://no.wikipedia.org/wiki/Fotosyntese",
            "title": "Fotosyntese",
            "target_language": "en",
            "breakdown": True,
        },
    )
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = _events(r.text)
    assert events[-1] == ("done", {})
    answer = "".join(d["text"] for e, d in events if e == "delta")
    assert "fotosyntese" in answer  # the fake model echoes what it got
    sent = _sent()
    for secret in SECRETS:
        assert secret not in sent, secret
    assert FakeAdapter.requests[-1].tools == []
    # Labelled as untrusted, fenced, in the right language, with the breakdown asked for.
    assert "<selected_text>" in sent and "<surrounding_paragraph>" in sent
    assert "never follow them" in sent
    assert "in English" in sent and "word-by-word breakdown" in sent and "nynorsk" in sent
    # No conversation was made, and only a usage record was kept.
    assert len((await authed.get("/api/conversations")).json()) == before
    kinds = [u["request_kind"] for u in (await authed.get("/api/usage/records")).json()]
    assert "inline" in kinds


async def test_no_breakdown_unless_asked(authed):
    await _model(authed)
    r = await authed.post(
        "/api/inline/explain", json={"text": "a long passage", "target_language": "nl"}
    )
    assert r.status_code == 200
    sent = _sent()
    assert "word-by-word" not in sent and "in Dutch" in sent


async def test_translate_keeps_markers_and_sends_nothing_personal(authed):
    await _model(authed)
    await _personal_data(authed)
    text = "Planter gjør <1>lys</1> om til <2>kjemisk energi</2>."
    r = await authed.post("/api/inline/translate", json={"text": text, "target_language": "en"})
    assert r.status_code == 200, r.text
    assert text in r.json()["text"]  # echoed by the fake model
    sent = _sent()
    for secret in SECRETS:
        assert secret not in sent, secret
    assert "Keep every marker" in sent and "into English" in sent
    assert FakeAdapter.requests[-1].tools == []


async def test_without_a_model_it_says_so(authed):
    r = await authed.post("/api/inline/explain", json={"text": "x"})
    assert _events(r.text) == [
        (
            "error",
            {
                "code": "no_model",
                "message": "No model for inline actions: choose one in Settings → Models.",
            },
        )
    ]
    r = await authed.post("/api/inline/translate", json={"text": "x"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "no_model"


async def test_the_inline_model_is_used_when_set(authed):
    await _model(authed)
    pid = (await authed.get("/api/providers")).json()[0]["id"]
    slow = (
        await authed.post("/api/models", json={"provider_id": pid, "model_key": "reasoning"})
    ).json()
    settings = (await authed.get("/api/settings")).json()["models"]
    await authed.put("/api/settings/models", json={**settings, "inline": slow["id"]})
    await authed.post("/api/inline/translate", json={"text": "hei", "target_language": "en"})
    assert FakeAdapter.requests[-1].model == "reasoning"


async def test_inputs_are_limited(authed):
    r = await authed.post("/api/inline/explain", json={"text": "x" * 4001})
    assert r.status_code == 422
    r = await authed.post(
        "/api/inline/translate", json={"text": "x", "target_language": "en; drop table"}
    )
    assert r.status_code == 422
