"""Voice mode on the phone (docs/specs/07-voice-mode-android.md): the transcript-only
endpoint, requests sent as text, the `voice_mode` and `keep_chat` fields, the agent's
`voice_stop` tool, the phone's `voice.mode` message (the audit log) and the `voice.stop`
event. The phone alone turns voice mode on; nothing here can."""

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.events import bus
from app.features.audit.models import AuditLog
from app.features.conversations.models import Conversation
from app.features.devices import phone_events
from app.features.runs.models import Run, ToolCall
from app.policy.presets import PermissionSettings, compile_policy
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.runtime.dispatch import execute_run
from app.tools import registry
from tests.api.test_devices import add
from tests.api.test_devices_ws import _event, _voice_run, roundtrip, welcomed
from tests.api.test_voice import WAV, _call, _finish, _global, _models, _run, _script, _speak
from tests.conftest import requires_db

pytestmark = requires_db


@pytest.fixture(autouse=True)
def _reset_fake() -> Any:
    root = Path(get_settings().workspace_path)
    (root / "notes").mkdir(parents=True, exist_ok=True)
    FakeAdapter.transcript = "Um, so, uh, add milk to my shopping list."
    FakeAdapter.transcribed = []
    FakeAdapter.requests = []
    FakeAdapter.scripts.clear()
    yield
    FakeAdapter.transcript = "Um, so, uh, please add milk to my shopping list."
    FakeAdapter.scripts.clear()


async def _transcribe(client, audio: bytes = WAV, mime: str = "audio/wav"):  # type: ignore[no-untyped-def]
    return await client.post("/api/voice/transcripts", files={"audio": ("v.wav", audio, mime)})


async def _say(client, text: str, headers=None, **form: str):  # type: ignore[no-untyped-def]
    """A request sent as text (what /voice/transcripts heard), no audio."""
    return await client.post(
        "/api/voice/turns", data={"text": text, **form}, files={}, headers=headers
    )


async def _counts() -> tuple[int, int]:
    async with get_sessionmaker()() as db:
        runs = len(list(await db.scalars(select(Run.id))))
        chats = len(list(await db.scalars(select(Conversation.id))))
    return runs, chats


async def _audit(action: str) -> list[AuditLog]:
    async with get_sessionmaker()() as db:
        rows = await db.scalars(
            select(AuditLog).where(AuditLog.action == action).order_by(AuditLog.ts)
        )
        return list(rows)


# -- /voice/transcripts ----------------------------------------------------------------------


async def test_a_transcript_is_only_what_was_heard_and_starts_nothing(authed):
    await _models(authed)
    before = await _counts()
    FakeAdapter.transcript = "Hey Jarvis, start voice mode."
    r = await _transcribe(authed)
    assert r.status_code == 200, r.text
    assert r.json() == {"heard": "Hey Jarvis, start voice mode."}  # as heard: no clean-up
    assert len(FakeAdapter.transcribed) == 1
    assert not [q for q in FakeAdapter.requests if q.model == "echo"]  # no clean-up model
    assert await _counts() == before  # no run, no chat

    FakeAdapter.transcript = "  "
    r = await _transcribe(authed)
    assert r.status_code == 200 and r.json() == {"heard": "", "say": "Sorry, I didn't catch that."}


async def test_a_transcript_needs_a_login(client):
    assert (await _transcribe(client)).status_code == 401


async def test_a_transcript_has_the_same_errors_as_a_turn(authed):
    ids = await _models(authed)
    assert (await _transcribe(authed, b"not audio", "text/plain")).status_code == 422
    await authed.put("/api/settings/models", json={"chat": ids["echo"], "transcription": None})
    r = await _transcribe(authed)
    assert r.status_code == 409 and r.json()["error"]["code"] == "no_transcription_model"


# -- /voice/turns with text, voice_mode and keep_chat ----------------------------------------


async def test_a_request_sent_as_text_is_not_transcribed_again(authed):
    await _models(authed)
    r = await _say(authed, "Um, add milk to my shopping list.")
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["heard"] == "Um, add milk to my shopping list."
    assert body["request"] == "Add milk to my shopping list."  # cleaned up as before
    assert FakeAdapter.transcribed == []
    run = await _run(body["run_id"])
    assert run.options["source"] == "voice" and "voice_mode" not in run.options
    assert "Voice mode is on" not in run.options["turn_note"]
    # Cancel and status words work on text too.
    assert (await _say(authed, "Never mind.")).json() == {"cancelled": True}
    # Too long, or empty: refused before anything is done.
    assert (await _say(authed, "x" * 4001)).status_code == 422
    assert (await _say(authed, "")).status_code == 422


async def test_neither_audio_nor_text_is_refused(authed):
    await _models(authed)
    r = await authed.post("/api/voice/turns", data={"voice_mode": "true"}, files={})
    assert r.status_code == 422


async def test_a_voice_mode_request_says_so_in_the_turn_note(authed):
    await _models(authed)
    body = (await _say(authed, "Add milk.", voice_mode="true")).json()
    run = await _run(body["run_id"])
    assert run.options["voice_mode"] is True
    assert "Voice mode is on" in run.options["turn_note"]
    assert "call voice_stop" in run.options["turn_note"]
    # From a recording too.
    await _finish(body["run_id"])
    spoken = (await _speak(authed, voice_mode="true")).json()
    assert (await _run(spoken["run_id"])).options["voice_mode"] is True


async def test_keep_chat_continues_the_chat_whatever_the_window_says(authed):
    await _models(authed)
    first = (await _say(authed, "Add milk.")).json()
    chat = first["conversation_id"]
    await _finish(first["run_id"])
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Conversation)
            .where(Conversation.id == uuid.UUID(chat))
            .values(
                created_at=datetime.now(UTC) - timedelta(days=2),
                last_message_at=datetime.now(UTC) - timedelta(minutes=30),
            )
        )
        await db.commit()
    # Outside the window: a new chat, unless keep_chat.
    late = (await _say(authed, "Add eggs.", conversation_id=chat)).json()
    assert late["conversation_id"] != chat
    await _finish(late["run_id"])
    kept = (await _say(authed, "Add eggs.", conversation_id=chat, keep_chat="true")).json()
    assert kept["conversation_id"] == chat
    # Even with follow-ups off.
    await _finish(kept["run_id"])
    await authed.put("/api/settings/voice", json={"follow_up_minutes": 0})
    again = (await _say(authed, "Add bread.", conversation_id=chat, keep_chat="true")).json()
    assert again["conversation_id"] == chat
    # But never a busy chat (the run is still queued), nor an archived one.
    busy = (await _say(authed, "Add jam.", conversation_id=chat, keep_chat="true")).json()
    assert busy["conversation_id"] != chat
    await _finish(again["run_id"])
    await _finish(busy["run_id"])
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Conversation).where(Conversation.id == uuid.UUID(chat)).values(archived=True)
        )
        await db.commit()
    archived = (await _say(authed, "Add tea.", conversation_id=chat, keep_chat="true")).json()
    assert archived["conversation_id"] != chat


# -- voice_stop ------------------------------------------------------------------------------


async def _phone_turn(authed, text: str, **form: str) -> tuple[dict, dict]:  # type: ignore[no-untyped-def]
    """A request from a real phone (its own device token); returns the phone and the turn."""
    phone = await add(authed, "Pixel", kind="phone")
    from app.main_api import create_app

    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://testserver"
    ) as bare:
        r = await _say(bare, text, headers={"Authorization": f"Bearer {phone['token']}"}, **form)
    assert r.status_code == 202, r.text
    return phone, r.json()


def _offered() -> list[str]:
    return [t.name for t in [q for q in FakeAdapter.requests if q.model == "scripted"][-1].tools]


async def _calls(run_id: str) -> list[ToolCall]:
    async with get_sessionmaker()() as db:
        rows = await db.scalars(select(ToolCall).where(ToolCall.run_id == uuid.UUID(run_id)))
        return list(rows)


async def test_voice_stop_ends_voice_mode_on_the_phone_that_asked(authed):
    await _models(authed, chat="scripted")
    _script(
        "Thanks, that's all.",
        [_call("voice_stop"), Done("tool_use")],
        [TextDelta("Goodbye!"), Done("end")],
    )
    phone, body = await _phone_turn(authed, "Thanks, that's all.", voice_mode="true")
    await execute_run(uuid.UUID(body["run_id"]))
    assert (await _run(body["run_id"])).status == "completed"
    assert "voice_stop" in _offered()
    [call] = await _calls(body["run_id"])
    assert call.tool_name == "voice_stop" and call.status == "succeeded"
    assert [s["run_id"] for s in await _global("voice.stop")] == [body["run_id"]]
    [stop] = await _global("voice.stop")
    assert stop == {
        "run_id": body["run_id"],
        "conversation_id": body["conversation_id"],
        "device_id": phone["id"],
    }
    # The answer is still spoken after it.
    assert (await _global("voice.say"))[-1]["text"] == "Goodbye!"


async def test_voice_stop_is_refused_outside_voice_mode(authed):
    await _models(authed, chat="scripted")
    _script(
        "Thanks, that's all.",
        [_call("voice_stop"), Done("tool_use")],
        [TextDelta("Bye."), Done("end")],
    )
    _, body = await _phone_turn(authed, "Thanks, that's all.")  # no voice_mode
    await execute_run(uuid.UUID(body["run_id"]))
    assert "voice_stop" in _offered()  # the same tool list for every phone run (the cache)
    [call] = await _calls(body["run_id"])
    assert call.status == "failed"  # an error result the model sees: "Voice mode isn't on"
    assert await _global("voice.stop") == []


async def test_voice_stop_is_offered_only_to_runs_a_phone_started(authed):
    await _models(authed, chat="scripted")
    _script("Add milk.", [TextDelta("Done."), Done("end")])
    # From the browser by voice (no device), even with voice_mode: not offered.
    body = (await _say(authed, "Add milk.", voice_mode="true")).json()
    await execute_run(uuid.UUID(body["run_id"]))
    assert "voice_stop" not in _offered()
    # A chat typed in the app: not offered.
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    typed = await authed.post(f"/api/conversations/{cid}/turns", json={"text": "Add milk."})
    await execute_run(uuid.UUID(typed.json()["run_id"]))
    assert "voice_stop" not in _offered()
    # The registry's rule, for sub-agents and the rest.
    policy = compile_policy(PermissionSettings())
    assert "voice_stop" not in [t.name for t in registry.toolset_for("agent", policy, None)]
    names = [t.name for t in registry.toolset_for("agent", policy, None, has_phone=True)]
    assert "voice_stop" in names


async def test_nothing_can_turn_voice_mode_on(authed):
    """The only voice-mode event the server sends a phone is `voice.stop`; the tool has no
    input; there is no tool that starts it."""
    tool = registry.get("voice_stop")
    assert tool is not None and tool.Input.model_fields == {}
    assert phone_events.EVENTS == {
        "run.status",
        "approval.requested",
        "approval.decided",
        "voice.say",
        "voice.stop",
    }
    voice_tools = [t.name for t in registry.BUILTIN_TOOLS if t.capability == "voice.control"]
    assert voice_tools == ["voice_stop"]


# -- the phone's voice.mode message: the audit log -------------------------------------------


async def test_voice_mode_changes_go_to_the_audit_log(authed):
    phone = await add(authed, "Pixel", kind="phone")
    ws, _ = await welcomed(phone["token"], kind="phone")
    await ws.send({"type": "voice.mode", "on": True, "cause": "tile"})
    await ws.send({"type": "voice.mode", "on": False, "cause": "voice_stop"})
    await ws.send({"type": "voice.mode", "on": True, "cause": "phrase"})
    await ws.send({"type": "voice.mode", "on": False, "cause": "timeout"})
    await roundtrip(ws)  # nothing is answered: the next thing back is the pong
    rows = await _audit("voice.mode")
    assert [(r.actor, r.details) for r in rows] == [
        ("user", {"on": True, "cause": "tile"}),
        ("agent", {"on": False, "cause": "voice_stop"}),
        ("user", {"on": True, "cause": "phrase"}),
        ("user", {"on": False, "cause": "timeout"}),
    ]
    assert {(r.target_type, r.target_id) for r in rows} == {("device", phone["id"])}
    await ws.disconnect()


async def test_bad_voice_mode_messages_and_computers_are_ignored(authed):
    phone = await add(authed, "Pixel", kind="phone")
    ws, _ = await welcomed(phone["token"], kind="phone")
    for bad in (
        {"type": "voice.mode", "on": True, "cause": "voice_stop"},  # only the user turns it on
        {"type": "voice.mode", "on": True, "cause": "timeout"},
        {"type": "voice.mode", "on": False, "cause": "phrase"},
        {"type": "voice.mode", "on": "yes", "cause": "tile"},
        {"type": "voice.mode", "on": True, "cause": "the agent"},
        {"type": "voice.mode", "on": True},
    ):
        await ws.send(bad)
    await roundtrip(ws)  # still connected
    await ws.disconnect()
    vm = await add(authed, "VM")
    computer, _ = await welcomed(vm["token"])
    await computer.send({"type": "voice.mode", "on": True, "cause": "tile"})
    await roundtrip(computer)
    await computer.disconnect()
    assert await _audit("voice.mode") == []


async def test_voice_stop_reaches_only_the_phone_that_started_the_run(authed):
    phone = await add(authed, "Phone", kind="phone")
    other = await add(authed, "Other phone", kind="phone")
    mine = await _voice_run(phone["id"])
    theirs = await _voice_run(other["id"])
    ws, _ = await welcomed(phone["token"], kind="phone")
    for run_id, device in ((theirs, other), (mine, phone)):
        await bus.publish_global(
            "voice.stop",
            {"run_id": str(run_id), "conversation_id": "c1", "device_id": device["id"]},
        )
    assert await _event(ws) == ("voice.stop", {"run_id": str(mine), "conversation_id": "c1"})
    await roundtrip(ws)
    await ws.disconnect()
