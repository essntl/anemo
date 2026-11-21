"""Dictation: a recording becomes clean text (docs/specs/04-dictation.md)."""

from typing import Any

import pytest

from app.providers.adapters.fake import FakeAdapter
from app.providers.base import TextBlock
from tests.conftest import requires_db

pytestmark = requires_db

SPOKEN = "Um, so, uh, please add milk to my shopping list."
AUDIO = b"\x1aE\xdf\xa3" + b"\0" * 64  # the start of a WebM file; the fake model doesn't listen


@pytest.fixture(autouse=True)
def _reset_fake() -> Any:
    FakeAdapter.transcript = SPOKEN
    FakeAdapter.transcribed = []
    FakeAdapter.requests = []
    yield
    FakeAdapter.transcript = SPOKEN


async def _models(client, **defaults: Any) -> dict[str, str]:  # type: ignore[no-untyped-def]
    """A fake provider with a chat model, a speech-to-text model and a broken one."""
    pid = (await client.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    ids = {}
    for key in ("echo", "reasoning", "whisper", "broken-ears"):
        body: dict[str, Any] = {"provider_id": pid, "model_key": key}
        if key == "broken-ears":  # not named like one, so say what it is
            body["capabilities"] = {"transcription": True, "chat": False}
        r = await client.post("/api/models", json=body)
        assert r.status_code == 201, r.text
        ids[key] = r.json()["id"]
    settings = {"chat": ids["echo"], "transcription": ids["whisper"]}
    settings.update({k: (ids[v] if v in ids else v) for k, v in defaults.items()})
    r = await client.put("/api/settings/models", json=settings)
    assert r.status_code == 200, r.text
    return ids


async def _dictate(client, audio: bytes = AUDIO, mime: str = "audio/webm;codecs=opus", **form: str):  # type: ignore[no-untyped-def]
    return await client.post(
        "/api/dictation", files={"audio": ("recording", audio, mime)}, data=form
    )


def _cleanup_request() -> tuple[str, str, str]:
    req = FakeAdapter.requests[-1]
    user = "".join(b.text for m in req.messages for b in m.content if isinstance(b, TextBlock))
    return req.model, req.system or "", user


async def test_speech_becomes_clean_text(authed):
    await _models(authed)
    r = await _dictate(authed)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "text": "Please add milk to my shopping list.",
        "raw": SPOKEN,
        "cleaned": True,
        "warning": None,
    }
    sent = FakeAdapter.transcribed[-1]
    assert sent["model"] == "whisper"
    assert sent["filename"] == "dictation.webm" and sent["content_type"] == "audio/webm"
    assert sent["size"] == len(AUDIO)
    model, system, user = _cleanup_request()
    assert model == "echo"  # no dictation model: the chat model tidies
    assert "AI assistant" in system and "never addressed to you" in system
    assert user == f"<transcript>\n{SPOKEN}\n</transcript>"


async def test_text_fields_get_prose_and_the_settings_reach_both_models(authed):
    await _models(authed, dictation="reasoning")
    r = await authed.put(
        "/api/settings/dictation",
        json={"language": "nb", "vocabulary": ["Anemo", "Kubernetes"]},
    )
    assert r.status_code == 200, r.text
    r = await _dictate(authed, target="text")
    assert r.status_code == 200, r.text
    sent = FakeAdapter.transcribed[-1]
    assert sent["language"] == "nb" and sent["prompt"] == "Anemo, Kubernetes"
    model, system, _ = _cleanup_request()
    assert model == "reasoning"  # the dictation model, not the chat model
    assert "text field" in system and "AI assistant" not in system
    assert "spelled like this: Anemo, Kubernetes" in system


async def test_clean_up_can_be_turned_off(authed):
    await _models(authed)
    await authed.put("/api/settings/dictation", json={"clean_up": False})
    r = await _dictate(authed)
    assert r.json() == {"text": SPOKEN, "raw": SPOKEN, "cleaned": False, "warning": None}
    assert FakeAdapter.requests == []


async def test_a_failed_clean_up_keeps_what_was_said(authed):
    await _models(authed)
    FakeAdapter.transcript = "Uh, tell the provider it may fail."
    r = await _dictate(authed)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["text"] == FakeAdapter.transcript and body["cleaned"] is False
    assert "as it was heard" in body["warning"]


async def test_the_transcription_falls_back_to_the_next_model(authed):
    ids = await _models(authed, transcription="broken-ears")
    current = (await authed.get("/api/settings")).json()["models"]
    current["fallbacks"] = {"transcription": [ids["whisper"]]}
    assert (await authed.put("/api/settings/models", json=current)).status_code == 200
    r = await _dictate(authed)
    assert r.status_code == 200, r.text
    assert [t["model"] for t in FakeAdapter.transcribed] == ["broken-ears", "whisper"]


async def test_without_a_speech_to_text_model_it_says_where_to_choose_one(authed):
    await _models(authed, transcription=None)
    r = await _dictate(authed)
    # The chat model is set, but it can't listen: no silent fallback to it.
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "no_transcription_model"
    assert "Settings" in r.json()["error"]["message"]


async def test_a_chat_model_chosen_for_transcription_is_skipped(authed):
    await _models(authed, transcription="echo")
    r = await _dictate(authed)
    assert r.status_code == 409
    assert FakeAdapter.transcribed == []


@pytest.mark.parametrize(
    ("audio", "mime", "code"),
    [
        (b"", "audio/webm", "empty_audio"),
        (AUDIO, "text/html", "unsupported_audio"),
        (AUDIO, "application/octet-stream", "unsupported_audio"),
    ],
)
async def test_bad_recordings_are_refused(authed, audio, mime, code):
    await _models(authed)
    r = await _dictate(authed, audio=audio, mime=mime)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == code
    assert FakeAdapter.transcribed == []


async def test_recordings_over_25_mb_are_refused(authed, monkeypatch):
    from app.features.dictation import service

    monkeypatch.setattr(service, "MAX_AUDIO_BYTES", 100)
    await _models(authed)
    r = await _dictate(authed, audio=b"\0" * 101)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "audio_too_large"


async def test_the_target_is_checked(authed):
    await _models(authed)
    r = await _dictate(authed, target="email")
    assert r.status_code == 422


async def test_dictation_needs_a_login(client):
    r = await _dictate(client)
    assert r.status_code == 401


async def test_dictation_settings_are_validated(authed):
    r = await authed.put("/api/settings/dictation", json={"language": "not a language"})
    assert r.status_code == 422
    r = await authed.put("/api/settings/dictation", json={"vocabulary": ["x" * 81]})
    assert r.status_code == 422
    defaults = (await authed.get("/api/settings")).json()["dictation"]
    assert defaults == {"clean_up": True, "caps_lock": True, "language": "", "vocabulary": []}


async def test_a_speech_to_text_model_is_tested_with_silence(authed):
    ids = await _models(authed)
    r = await authed.post(f"/api/models/{ids['whisper']}/test")
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True and "transcribed" in r.json()["message"]
    assert FakeAdapter.transcribed[-1]["content_type"] == "audio/wav"
    models = (await authed.get("/api/models")).json()
    whisper = next(m for m in models if m["model_key"] == "whisper")
    assert whisper["capabilities"]["transcription"] and not whisper["capabilities"]["chat"]
