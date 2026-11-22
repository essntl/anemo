"""Voice: a spoken request becomes an agent turn; spoken replies answer and decide
(docs/specs/05-voice-android.md, docs/device-contracts.md §4)."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.core.redis import get_redis
from app.events import bus
from app.features.audit.models import AuditLog
from app.features.conversations.models import ChatMessage, Conversation
from app.features.runs.models import Run, ToolCall
from app.features.usage.models import UsageRecord
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.providers.base import ToolCall as ModelToolCall
from app.runtime import agent_finalize
from app.runtime.dispatch import execute_run
from tests.conftest import requires_db

pytestmark = requires_db

WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\0" * 64  # the fake model doesn't listen


@pytest.fixture(autouse=True)
def _reset_fake() -> Any:
    root = Path(get_settings().workspace_path)
    (root / "notes").mkdir(parents=True, exist_ok=True)
    (root / "notes" / "todo.md").write_text("- write tests\n")
    FakeAdapter.transcript = "Um, so, uh, add milk to my shopping list."
    FakeAdapter.transcribed = []
    FakeAdapter.requests = []
    FakeAdapter.scripts.clear()
    yield
    FakeAdapter.transcript = "Um, so, uh, please add milk to my shopping list."
    FakeAdapter.scripts.clear()


async def _models(client, chat: str = "echo", **levels: str) -> dict[str, str]:  # type: ignore[no-untyped-def]
    """A fake provider: a chat model, a scripted agent model and a speech-to-text model."""
    pid = (await client.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    ids = {}
    for key in ("echo", "scripted", "whisper"):
        body: dict[str, Any] = {"provider_id": pid, "model_key": key}
        if key == "scripted":
            body["capabilities"] = {"tools": True}
        r = await client.post("/api/models", json=body)
        assert r.status_code == 201, r.text
        ids[key] = r.json()["id"]
    r = await client.put(
        "/api/settings/models",
        json={"chat": ids[chat], "transcription": ids["whisper"], "dictation": ids["echo"]},
    )
    assert r.status_code == 200, r.text
    if levels:
        r = await client.put("/api/settings/permissions", json={"levels": levels})
        assert r.status_code == 200, r.text
    return ids


async def _speak(client, audio: bytes = WAV, mime: str = "audio/wav", headers=None, **form: str):  # type: ignore[no-untyped-def]
    return await client.post(
        "/api/voice/turns", files={"audio": ("voice.wav", audio, mime)}, data=form, headers=headers
    )


async def _reply(client, approval_id: str, said: str):  # type: ignore[no-untyped-def]
    FakeAdapter.transcript = said
    return await client.post(
        "/api/voice/replies",
        files={"audio": ("reply.wav", WAV, "audio/wav")},
        data={"approval_id": approval_id},
    )


async def _run(run_id: str) -> Run:
    async with get_sessionmaker()() as db:
        run = await db.get(Run, uuid.UUID(run_id))
        assert run is not None
        return run


async def _global(kind: str) -> list[dict[str, Any]]:
    entries = await get_redis().xrange(bus.GLOBAL_STREAM)
    decoded = [bus.decode(fields) for _, fields in entries]
    return [data for event_type, data in decoded if event_type == kind]


def _script(request: str, *turns: list) -> None:
    FakeAdapter.scripts[request] = [list(t) for t in turns]


def _call(name: str, **args: Any) -> ModelToolCall:
    return ModelToolCall(id=f"c_{uuid.uuid4().hex[:8]}", name=name, arguments=args)


async def _finish(run_id: str) -> None:
    async with get_sessionmaker()() as db:
        await db.execute(update(Run).where(Run.id == uuid.UUID(run_id)).values(status="completed"))
        await db.commit()


# -- requests ------------------------------------------------------------------------------


async def test_a_spoken_request_starts_an_agent_turn_in_the_voice_chat(authed):
    await _models(authed)
    r = await _speak(authed)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["heard"] == "Um, so, uh, add milk to my shopping list."
    assert body["request"] == "Add milk to my shopping list."
    assert set(body) == {"run_id", "conversation_id", "heard", "request"}
    # The clean-up had the voice purpose: one clear instruction, never an answer.
    clean_up = FakeAdapter.requests[-1]
    assert "spoken request to an assistant that will act on it" in (clean_up.system or "")
    assert FakeAdapter.transcribed[-1]["filename"] == "dictation.wav"

    run = await _run(body["run_id"])
    assert run.kind == "agent" and run.status == "queued"
    assert run.options["source"] == "voice" and "device_id" not in run.options
    assert "read aloud" in run.options["turn_note"]
    conv = (await authed.get(f"/api/conversations/{body['conversation_id']}")).json()
    assert conv["title"].startswith("Voice · ")
    [user, _] = (await authed.get(f"/api/conversations/{body['conversation_id']}/messages")).json()
    assert user["text"] == "Add milk to my shopping list."  # the request, not what was heard
    async with get_sessionmaker()() as db:
        kinds = sorted(u.request_kind for u in await db.scalars(select(UsageRecord)))
    assert kinds == ["dictation", "transcription"]  # usage for both models


async def test_the_listener_note_is_in_the_turn_context_and_the_answer_is_spoken(authed):
    await _models(authed, chat="scripted")
    answer = "## Done\n\nI added **milk**."
    _script("Add milk to my shopping list.", [TextDelta(answer), Done("end")])
    body = (await _speak(authed)).json()
    await execute_run(uuid.UUID(body["run_id"]))
    sent = [r for r in FakeAdapter.requests if r.model == "scripted"][-1]
    assert "read aloud" not in (sent.system or "")
    context = sent.messages[-1].content[-1].text  # type: ignore[union-attr]
    assert context.startswith("<turn_context>") and "read aloud" in context
    [say] = await _global("voice.say")
    assert say == {
        "run_id": body["run_id"],
        "conversation_id": body["conversation_id"],
        "device_id": None,
        "text": "Done. I added milk.",
        "more": False,
    }


async def test_a_long_answer_is_shortened_and_a_failed_run_says_so(authed):
    await _models(authed, chat="scripted")
    await authed.put("/api/settings/voice", json={"max_spoken_chars": 100})
    long = " ".join(f"Point {i} is a fine point." for i in range(30))
    _script("Add milk to my shopping list.", [TextDelta(long), Done("end")])
    body = (await _speak(authed)).json()
    await execute_run(uuid.UUID(body["run_id"]))
    [say] = await _global("voice.say")
    assert say["more"] is True and say["text"].endswith("The rest is in the chat.")
    assert len(say["text"]) <= 100 + len(" The rest is in the chat.")

    # A run that fails or is stopped says so in one sentence.
    body = (await _speak(authed)).json()
    async with get_sessionmaker()() as db:
        run = await db.get(Run, uuid.UUID(body["run_id"]))
        assert run is not None
        await agent_finalize.give_up(db, run, "The model is gone.")
    says = await _global("voice.say")
    assert says[-1]["run_id"] == body["run_id"] and says[-1]["more"] is False
    assert says[-1]["text"] == "Sorry, that didn't work; the details are in the chat."
    body = (await _speak(authed)).json()
    assert (await authed.post(f"/api/runs/{body['run_id']}/cancel")).status_code == 200
    says = await _global("voice.say")
    assert says[-1]["run_id"] == body["run_id"]
    assert says[-1]["text"] == "The request was stopped."


async def test_a_failed_clean_up_sends_the_request_as_heard(authed):
    await _models(authed)
    FakeAdapter.transcript = "Tell the provider it may fail."
    r = await _speak(authed)
    assert r.status_code == 202, r.text
    assert r.json()["request"] == r.json()["heard"] == "Tell the provider it may fail."


async def test_without_a_speech_to_text_model_it_names_the_setting(authed):
    ids = await _models(authed)
    await authed.put("/api/settings/models", json={"chat": ids["echo"], "transcription": None})
    r = await _speak(authed)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "no_transcription_model"
    assert "Settings" in r.json()["error"]["message"]


@pytest.mark.parametrize(
    ("audio", "mime", "code"),
    [
        (b"", "audio/wav", "empty_audio"),
        (WAV, "text/html", "unsupported_audio"),
    ],
)
async def test_bad_recordings_are_refused(authed, audio, mime, code):
    await _models(authed)
    r = await _speak(authed, audio=audio, mime=mime)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == code
    assert FakeAdapter.transcribed == []


async def test_too_large_a_recording_is_refused(authed, monkeypatch):
    from app.features.dictation import service

    monkeypatch.setattr(service, "MAX_AUDIO_BYTES", 100)
    await _models(authed)
    r = await _speak(authed, audio=b"\0" * 101)
    assert r.status_code == 422 and r.json()["error"]["code"] == "audio_too_large"


@pytest.mark.parametrize("said", ["Cancel.", "Never mind!", "nevermind", "  never   mind "])
async def test_cancel_words_throw_the_recording_away(authed, said):
    await _models(authed)
    FakeAdapter.transcript = said
    r = await _speak(authed)
    assert r.status_code == 200
    assert r.json() == {"cancelled": True}
    assert FakeAdapter.requests == []  # not even cleaned up
    async with get_sessionmaker()() as db:
        assert list(await db.scalars(select(Run))) == []


async def test_cancel_inside_a_request_is_a_request(authed):
    await _models(authed)
    FakeAdapter.transcript = "Cancel my dentist appointment."
    r = await _speak(authed)
    assert r.status_code == 202


async def test_status_says_what_is_running(authed):
    await _models(authed)
    r = await authed.post("/api/voice/turns", data={"status": "true"})
    assert r.status_code == 200 and r.json() == {"say": "Nothing is running."}
    assert FakeAdapter.transcribed == []  # no recording needed
    await _speak(authed)
    r = await authed.post("/api/voice/turns", data={"status": "true"})
    assert r.json() == {"say": "One run is working: Add milk to my shopping list."}
    # Said as the whole recording, it is the same.
    FakeAdapter.transcript = "Status."
    r = await _speak(authed)
    assert r.status_code == 200
    assert r.json() == {"say": "One run is working: Add milk to my shopping list."}


async def test_nothing_heard_starts_nothing(authed):
    await _models(authed)
    FakeAdapter.transcript = " "
    r = await _speak(authed)
    assert r.status_code == 200 and r.json() == {"say": "Sorry, I didn't catch that."}


async def _age(conversation_id: str, **values: datetime) -> None:
    async with get_sessionmaker()() as db:
        conv = uuid.UUID(conversation_id)
        await db.execute(update(Conversation).where(Conversation.id == conv).values(**values))
        await db.commit()


async def test_a_follow_up_within_the_window_continues_that_chat(authed):
    await _models(authed)
    now = datetime.now(UTC)
    first = (await _speak(authed)).json()
    chat = first["conversation_id"]
    await _finish(first["run_id"])
    # Yesterday's Voice chat, answered a minute ago: a follow-up continues it.
    await _age(chat, created_at=now - timedelta(days=2), last_message_at=now - timedelta(minutes=1))
    r = await _speak(authed, conversation_id=chat)
    assert r.json()["conversation_id"] == chat
    await _finish(r.json()["run_id"])
    # Too late: the next request starts today's Voice chat.
    await _age(chat, last_message_at=now - timedelta(minutes=6))
    r = await _speak(authed, conversation_id=chat)
    today = r.json()["conversation_id"]
    assert today != chat
    await _finish(r.json()["run_id"])
    # With follow-ups off, never.
    await authed.put("/api/settings/voice", json={"follow_up_minutes": 0})
    await _age(chat, last_message_at=now)
    r = await _speak(authed, conversation_id=chat)
    assert r.json()["conversation_id"] == today
    # Any chat can be continued within the window.
    await authed.put("/api/settings/voice", json={"follow_up_minutes": 5})
    await _finish(r.json()["run_id"])
    other = (await authed.post("/api/conversations", json={})).json()["id"]
    assert (await _speak(authed, conversation_id=other)).json()["conversation_id"] == other


async def test_one_voice_chat_a_day_or_one_that_keeps_going(authed):
    await _models(authed)
    first = (await _speak(authed)).json()
    await _finish(first["run_id"])
    again = (await _speak(authed)).json()
    assert again["conversation_id"] == first["conversation_id"]  # the same day
    await _finish(again["run_id"])
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Conversation)
            .where(Conversation.id == uuid.UUID(first["conversation_id"]))
            .values(created_at=datetime.now(UTC) - timedelta(days=2))
        )
        await db.commit()
    await authed.put("/api/settings/voice", json={"chat": "single"})
    kept = (await _speak(authed)).json()
    assert kept["conversation_id"] == first["conversation_id"]
    await _finish(kept["run_id"])
    await authed.put("/api/settings/voice", json={"chat": "daily"})
    new_day = (await _speak(authed)).json()
    assert new_day["conversation_id"] != first["conversation_id"]


async def test_a_new_request_does_not_wait_for_a_busy_voice_chat(authed):
    await _models(authed)
    first = (await _speak(authed)).json()  # still queued
    second = await _speak(authed)
    assert second.status_code == 202
    assert second.json()["conversation_id"] != first["conversation_id"]


async def test_the_profile_from_settings_runs_the_request(authed):
    await _models(authed)
    r = await authed.post("/api/profiles", json={"name": "Voice helper"})
    assert r.status_code == 201, r.text
    profile = r.json()["id"]
    await authed.put("/api/settings/voice", json={"profile_id": profile})
    run = await _run((await _speak(authed)).json()["run_id"])
    assert str(run.profile_id) == profile


@dataclass
class _Phone:
    id: uuid.UUID
    name: str
    kind: str = "phone"
    trust: str = "watched"


async def test_a_phone_is_named_on_the_run(authed, monkeypatch):
    from app.features.devices import service as devices

    await _models(authed)
    made = (await authed.post("/api/auth/tokens", json={"name": "Pixel"})).json()
    phone = _Phone(uuid.uuid4(), "Pixel 8")
    asked: list[uuid.UUID] = []

    async def by_token_id(db, token_id):  # type: ignore[no-untyped-def]
        asked.append(token_id)
        return phone if str(token_id) == made["id"] else None

    monkeypatch.setattr(devices, "by_token_id", by_token_id)
    from app.main_api import create_app

    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://testserver"
    ) as bare:
        r = await _speak(bare, headers={"Authorization": f"Bearer {made['token']}"})
    assert r.status_code == 202, r.text
    run = await _run(r.json()["run_id"])
    assert run.options["device_id"] == str(phone.id)
    assert "(Pixel 8)" in run.options["turn_note"]
    timeline = (await authed.get(f"/api/runs/{run.id}/timeline")).json()
    assert timeline["origin"] == {"source": "voice", "device_name": "Pixel 8"}
    # From the browser there is no device; a run from the app has no origin.
    browser = (await _speak(authed)).json()
    timeline = (await authed.get(f"/api/runs/{browser['run_id']}/timeline")).json()
    assert timeline["origin"] == {"source": "voice", "device_name": None}
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    typed = await authed.post(f"/api/conversations/{cid}/turns", json={"text": "hi"})
    timeline = (await authed.get(f"/api/runs/{typed.json()['run_id']}/timeline")).json()
    assert timeline["origin"] is None
    assert (await _run(typed.json()["run_id"])).options == {}  # /turns as before


async def test_voice_needs_a_login(client):
    assert (await _speak(client)).status_code == 401
    r = await client.post(
        "/api/voice/replies",
        files={"audio": ("r.wav", WAV, "audio/wav")},
        data={"approval_id": str(uuid.uuid4())},
    )
    assert r.status_code == 401


async def test_voice_settings_have_defaults_and_limits(authed):
    defaults = (await authed.get("/api/settings")).json()["voice"]
    assert defaults == {
        "profile_id": None,
        "follow_up_minutes": 5,
        "max_spoken_chars": 600,
        "approvals_by_voice": True,
        "chat": "daily",
    }
    for bad in (
        {"follow_up_minutes": 61},
        {"max_spoken_chars": 99},
        {"max_spoken_chars": 2001},
        {"chat": "weekly"},
    ):
        assert (await authed.put("/api/settings/voice", json=bad)).status_code == 422


# -- replies ---------------------------------------------------------------------------


async def _waiting(authed, request: str, *turns: list, **levels: str) -> tuple[str, dict]:  # type: ignore[no-untyped-def]
    """A voice run that waits for the user; returns it and its pending approval."""
    await _models(authed, chat="scripted", **levels)
    FakeAdapter.transcript = request
    _script(request, *turns)
    run_id = (await _speak(authed)).json()["run_id"]
    await execute_run(uuid.UUID(run_id))
    assert (await _run(run_id)).status == "waiting_approval"
    [approval] = (await authed.get("/api/approvals")).json()
    FakeAdapter.transcribed = []
    return run_id, approval


async def _audit_details(action: str) -> list[dict]:
    async with get_sessionmaker()() as db:
        rows = await db.scalars(select(AuditLog).where(AuditLog.action == action))
        return [r.details or {} for r in rows]


async def test_a_question_is_answered_with_what_was_said(authed):
    run_id, approval = await _waiting(
        authed,
        "Write a report.",
        [_call("ask_user", question="Short or long?", options=["Short", "Long"]), Done("tool_use")],
        [TextDelta("Short it is."), Done("end")],
    )
    assert approval["kind"] == "question"
    r = await _reply(authed, approval["id"], "The short one, please.")
    assert r.status_code == 200, r.text
    assert r.json() == {"decided": "approve", "heard": "The short one, please."}
    await execute_run(uuid.UUID(run_id))
    assert (await _run(run_id)).status == "completed"
    async with get_sessionmaker()() as db:
        call = await db.scalar(select(ToolCall).where(ToolCall.run_id == uuid.UUID(run_id)))
        assert call is not None and call.args["answer"] == "The short one, please."
    [decided] = await _global("approval.decided")
    assert decided == {"approval_id": approval["id"], "run_id": run_id, "decision": "approve"}
    assert (await _global("voice.say"))[-1]["text"] == "Short it is."


async def test_up_to_you_leaves_the_question_to_the_agent(authed):
    run_id, approval = await _waiting(
        authed,
        "Tidy up.",
        [_call("ask_user", question="Delete old drafts too?"), Done("tool_use")],
        [TextDelta("Kept them."), Done("end")],
    )
    r = await _reply(authed, approval["id"], "Up to you.")
    assert r.json() == {"decided": "deny", "heard": "Up to you."}


async def test_an_approval_is_allowed_by_voice_and_logged(authed):
    run_id, approval = await _waiting(
        authed,
        "Read my todo list.",
        [_call("read_file", path="notes/todo.md"), Done("tool_use")],
        [TextDelta("Read it."), Done("end")],
        **{"fs.read": "ask"},
    )
    r = await _reply(authed, approval["id"], "Yes, go ahead.")
    assert r.json() == {"decided": "approve", "heard": "Yes, go ahead."}
    classify = FakeAdapter.requests[-1]
    assert "yes, no or unclear" in (classify.system or "")
    [details] = await _audit_details("approval.approved")
    assert details["source"] == "voice"
    await execute_run(uuid.UUID(run_id))
    assert (await _run(run_id)).status == "completed"


async def test_no_denies_it(authed):
    run_id, approval = await _waiting(
        authed,
        "Read my todo list.",
        [_call("read_file", path="notes/todo.md"), Done("tool_use")],
        [TextDelta("Skipped."), Done("end")],
        **{"fs.read": "ask"},
    )
    r = await _reply(authed, approval["id"], "No.")
    assert r.json() == {"decided": "deny", "heard": "No."}
    [details] = await _audit_details("approval.denied")
    assert details["source"] == "voice"


async def test_an_unclear_reply_decides_nothing(authed):
    run_id, approval = await _waiting(
        authed,
        "Read my todo list.",
        [_call("read_file", path="notes/todo.md"), Done("tool_use")],
        **{"fs.read": "ask"},
    )
    r = await _reply(authed, approval["id"], "Maybe later, I'm not sure.")
    assert r.status_code == 200
    assert r.json() == {
        "decided": None,
        "heard": "Maybe later, I'm not sure.",
        "say": "Sorry, was that a yes?",
    }
    assert (await authed.get("/api/approvals")).json()[0]["status"] == "pending"
    assert await _global("approval.decided") == []


async def test_a_dangerous_action_needs_a_tap(authed):
    run_id, approval = await _waiting(
        authed,
        "Read my todo list.",
        [_call("read_file", path="notes/todo.md"), Done("tool_use")],
        **{"fs.read": "ask"},
    )
    async with get_sessionmaker()() as db:
        await db.execute(
            update(ToolCall).where(ToolCall.run_id == uuid.UUID(run_id)).values(risk="dangerous")
        )
        await db.commit()
    r = await _reply(authed, approval["id"], "Yes.")
    assert r.status_code == 409 and r.json()["error"]["code"] == "needs_tap"
    assert FakeAdapter.transcribed == []  # not even listened to
    assert (await authed.get("/api/approvals")).json()[0]["status"] == "pending"
    # The app's buttons still decide it.
    r = await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    assert r.status_code == 200
    [decided] = await _global("approval.decided")
    assert decided["decision"] == "approve"
    [details] = await _audit_details("approval.approved")
    assert "source" not in details


async def test_approvals_by_voice_can_be_turned_off(authed):
    run_id, approval = await _waiting(
        authed,
        "Read my todo list.",
        [_call("read_file", path="notes/todo.md"), Done("tool_use")],
        **{"fs.read": "ask"},
    )
    await authed.put("/api/settings/voice", json={"approvals_by_voice": False})
    r = await _reply(authed, approval["id"], "Yes.")
    assert r.status_code == 409 and r.json()["error"]["code"] == "needs_tap"


async def test_questions_are_answered_by_voice_with_approvals_off(authed):
    run_id, approval = await _waiting(
        authed,
        "Write a report.",
        [_call("ask_user", question="Short or long?"), Done("tool_use")],
    )
    await authed.put("/api/settings/voice", json={"approvals_by_voice": False})
    r = await _reply(authed, approval["id"], "Long.")
    assert r.json() == {"decided": "approve", "heard": "Long."}


async def test_a_decided_approval_is_already_decided(authed):
    run_id, approval = await _waiting(
        authed,
        "Read my todo list.",
        [_call("read_file", path="notes/todo.md"), Done("tool_use")],
        **{"fs.read": "ask"},
    )
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "deny"})
    r = await _reply(authed, approval["id"], "Yes.")
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_decided"
    r = await _reply(authed, str(uuid.uuid4()), "Yes.")
    assert r.status_code == 404


async def test_a_plan_is_accepted_as_proposed_by_voice(authed):
    await authed.put("/api/settings/permissions", json={"plan_review": "always"})
    plan = [{"title": "List notes"}, {"title": "Summarize them"}]
    run_id, approval = await _waiting(
        authed,
        "Sum up my notes.",
        [_call("update_plan", steps=plan), Done("tool_use")],
        [_call("update_plan", steps=plan), Done("tool_use")],
        [TextDelta("Summed up."), Done("end")],
    )
    assert approval["kind"] == "plan"
    r = await _reply(authed, approval["id"], "Yes.")
    assert r.json() == {"decided": "approve", "heard": "Yes."}
    async with get_sessionmaker()() as db:
        call = await db.scalar(select(ToolCall).where(ToolCall.run_id == uuid.UUID(run_id)))
        assert call is not None and [s["title"] for s in call.args["steps"]] == [
            "List notes",
            "Summarize them",
        ]
    await execute_run(uuid.UUID(run_id))
    assert (await _run(run_id)).status == "completed"


async def test_neither_audio_nor_transcript_is_kept(authed):
    await _models(authed)
    FakeAdapter.transcript = "Uh, remind me about the zebra sandwich."
    await _speak(authed)
    async with get_sessionmaker()() as db:
        texts = [m.text_plain for m in await db.scalars(select(ChatMessage))]
        audit = [str(a.details) for a in await db.scalars(select(AuditLog))]
    # Only the request is kept, as the chat message; what was heard is nowhere.
    assert texts == ["Remind me about the zebra sandwich.", ""]
    assert not any("Uh," in t for t in texts + audit)
