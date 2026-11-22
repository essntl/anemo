"""Voice from a phone, end to end (docs/specs/05-voice-android.md, "Done when";
docs/device-contracts.md §2 and §4).

A fake Anemo Voice connects over a real WebSocket to a live app, sends recordings and
replies over HTTP with its device token, and hears what the server says on its
connection. The agent runs in the job runner (tests/integration/devices_live.py), with
the scripted fake model; nothing between the phone and the worker is replaced.
"""

import uuid
from pathlib import Path
from typing import Any

import pytest

from app.core.config import get_settings
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.providers.base import ToolCall as ModelToolCall
from tests.conftest import requires_db
from tests.integration.devices_live import (
    FakePhone,
    Live,
    models,
    pending_approvals,
    phone,
    timeline,
    wait_status,
)

pytestmark = requires_db


@pytest.fixture(autouse=True)
def _fake_model() -> Any:
    root = Path(get_settings().workspace_path)
    (root / "notes" / "old").mkdir(parents=True, exist_ok=True)
    (root / "notes" / "todo.md").write_text("- buy milk\n")
    (root / "notes" / "old" / "draft.md").write_text("old draft")
    FakeAdapter.scripts.clear()
    FakeAdapter.requests = []
    FakeAdapter.transcribed = []
    yield
    FakeAdapter.scripts.clear()
    FakeAdapter.transcript = "Um, so, uh, please add milk to my shopping list."


def script(request: str, *turns: list) -> None:
    """What the agent does for a request: one list of events per model call."""
    FakeAdapter.scripts[request] = [list(t) for t in turns]


def call(name: str, **args: Any) -> ModelToolCall:
    return ModelToolCall(id=f"c_{uuid.uuid4().hex[:8]}", name=name, arguments=args)


def said(text: str) -> None:
    """What the speech-to-text model hears next."""
    FakeAdapter.transcript = text


async def ask(device: FakePhone, spoken: str, **form: str) -> dict[str, Any]:
    said(spoken)
    r = await device.speak(**form)
    assert r.status_code == 202, r.text
    return dict(r.json())


def of_run(events: list[dict[str, Any]]) -> set[str]:
    return {e["data"]["run_id"] for e in events if "run_id" in e["data"]}


def tool_results_sent_to_model() -> list[str]:
    last = FakeAdapter.requests[-1]
    return [b.content for m in last.messages for b in m.content if b.type == "tool_result"]


# -- request → run → spoken answer; a follow-up --------------------------------------------


async def test_a_spoken_request_is_answered_on_the_phone_and_a_follow_up_continues(
    live: Live,
):
    await models(live.api)
    pixel = await phone(live, "Pixel 8")
    assert pixel.welcome["device"]["name"] == "Pixel 8"
    assert pixel.welcome["device"]["kind"] == "phone"
    assert pixel.welcome["missed"] is False and pixel.welcome["cursor"]
    listed = (await live.api.get("/api/devices")).json()
    assert [(d["name"], d["online"]) for d in listed] == [("Pixel 8", True)]

    script(
        "Add milk to my shopping list.",
        [TextDelta("## Done\n\nI added **milk** to your list."), Done("end")],
        [TextDelta("Oat milk is on the list too."), Done("end")],
    )
    body = await ask(pixel, "Um, so, uh, add milk to my shopping list.")
    assert body["heard"] == "Um, so, uh, add milk to my shopping list."
    assert body["request"] == "Add milk to my shopping list."
    run_id, chat = body["run_id"], body["conversation_id"]

    events = await pixel.events_until("voice.say", run_id)
    assert of_run(events) == {run_id}
    statuses = [e["data"]["status"] for e in events if e["event"] == "run.status"]
    assert statuses[-1] == "completed" and "running" in statuses
    assert all(set(e["data"]) == {"run_id", "status"} for e in events[:-1])
    assert events[-1]["data"] == {
        "run_id": run_id,
        "conversation_id": chat,
        "text": "Done. I added milk to your list.",  # plain text, to be spoken
        "more": False,
    }
    # The run says where it came from; the user's message is the request, not the audio.
    assert (await timeline(live.api, run_id))["origin"] == {
        "source": "voice",
        "device_name": "Pixel 8",
    }
    messages = (await live.api.get(f"/api/conversations/{chat}/messages")).json()
    assert messages[0]["text"] == "Add milk to my shopping list."

    # A follow-up within the window continues the same chat: the model sees the first turn.
    body = await ask(pixel, "And oat milk too.", conversation_id=chat)
    assert body["conversation_id"] == chat
    events = await pixel.events_until("voice.say", body["run_id"])
    assert events[-1]["data"]["text"] == "Oat milk is on the list too."
    sent = FakeAdapter.requests[-1]
    texts = [b.text for m in sent.messages for b in m.content if b.type == "text"]
    assert "Add milk to my shopping list." in texts and "And oat milk too." in texts
    await pixel.close()


# -- questions, approvals and plans by voice ----------------------------------------------


async def test_a_question_is_answered_by_voice(live: Live):
    await models(live.api)
    pixel = await phone(live)
    script(
        "Write a report.",
        [call("ask_user", question="Short or long?", options=["Short", "Long"]), Done("tool_use")],
        [TextDelta("A short report it is."), Done("end")],
    )
    run_id = (await ask(pixel, "Write a report."))["run_id"]
    events = await pixel.events_until("approval.requested", run_id)
    question = events[-1]["data"]
    assert question == {
        "approval_id": question["approval_id"],
        "run_id": run_id,
        "kind": "question",
        "summary": question["summary"],
        "risk": "safe",
        "question": "Short or long?",
        "options": ["Short", "Long"],
    }

    said("The short one, please.")
    r = await pixel.reply(question["approval_id"])
    assert r.status_code == 200, r.text
    assert r.json() == {"decided": "approve", "heard": "The short one, please."}
    events = await pixel.events_until("voice.say", run_id)
    decided = [e["data"] for e in events if e["event"] == "approval.decided"]
    assert decided == [{"approval_id": question["approval_id"], "decision": "approve"}]
    assert events[-1]["data"]["text"] == "A short report it is."
    assert any("The short one, please." in r for r in tool_results_sent_to_model())
    await pixel.close()


async def test_an_action_is_allowed_by_voice(live: Live):
    await models(live.api, **{"fs.read": "ask"})
    pixel = await phone(live)
    script(
        "Read my todo list.",
        [call("read_file", path="notes/todo.md"), Done("tool_use")],
        [TextDelta("You need to buy milk."), Done("end")],
    )
    run_id = (await ask(pixel, "Read my todo list."))["run_id"]
    events = await pixel.events_until("approval.requested", run_id)
    action = events[-1]["data"]
    assert action["kind"] == "action" and action["risk"] != "dangerous"
    assert "notes/todo.md" in action["summary"]
    assert "question" not in action and "steps" not in action

    said("Yes, go ahead.")
    r = await pixel.reply(action["approval_id"])
    assert r.json() == {"decided": "approve", "heard": "Yes, go ahead."}
    events = await pixel.events_until("voice.say", run_id)
    assert events[-1]["data"]["text"] == "You need to buy milk."
    assert await wait_status(live.api, run_id, "completed") == "completed"
    audit = (await live.api.get("/api/audit")).json()
    [approved] = [a for a in audit if a["action"] == "approval.approved"]
    assert approved["details"]["source"] == "voice"
    await pixel.close()


async def test_a_dangerous_action_needs_a_tap_and_a_decision_in_the_app_reaches_the_phone(
    live: Live,
):
    await models(live.api)
    pixel = await phone(live)
    script(
        "Clear out my old notes.",
        [call("delete_path", path="notes/old"), Done("tool_use")],
        [TextDelta("I left them alone."), Done("end")],
    )
    run_id = (await ask(pixel, "Clear out my old notes."))["run_id"]
    events = await pixel.events_until("approval.requested", run_id)
    action = events[-1]["data"]
    assert action["kind"] == "action" and action["risk"] == "dangerous"

    FakeAdapter.transcribed = []
    said("Yes.")
    r = await pixel.reply(action["approval_id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "needs_tap"
    assert FakeAdapter.transcribed == []  # not even listened to
    [still] = await pending_approvals(live.api)
    assert still["id"] == action["approval_id"]

    # The notification's (or the app's) Deny decides it; the phone stops asking.
    r = await live.api.post(f"/api/approvals/{action['approval_id']}", json={"decision": "deny"})
    assert r.status_code == 200, r.text
    events = await pixel.events_until("voice.say", run_id)
    decided = [e["data"] for e in events if e["event"] == "approval.decided"]
    assert decided == [{"approval_id": action["approval_id"], "decision": "deny"}]
    assert events[-1]["data"]["text"] == "I left them alone."
    assert (Path(get_settings().workspace_path) / "notes" / "old" / "draft.md").exists()
    await pixel.close()


async def test_a_plan_is_read_out_and_accepted_by_voice(live: Live):
    await models(live.api)
    r = await live.api.put("/api/settings/permissions", json={"plan_review": "always"})
    assert r.status_code == 200, r.text
    pixel = await phone(live)
    plan = [{"title": "List notes"}, {"title": "Summarize them"}]
    script(
        "Sum up my notes.",
        [call("update_plan", steps=plan), Done("tool_use")],
        [call("update_plan", steps=plan), Done("tool_use")],
        [TextDelta("Summed up."), Done("end")],
    )
    run_id = (await ask(pixel, "Sum up my notes."))["run_id"]
    events = await pixel.events_until("approval.requested", run_id)
    review = events[-1]["data"]
    assert review["kind"] == "plan" and review["risk"] == "safe"
    assert review["steps"] == ["List notes", "Summarize them"]

    said("Yes.")
    r = await pixel.reply(review["approval_id"])
    assert r.json() == {"decided": "approve", "heard": "Yes."}
    events = await pixel.events_until("voice.say", run_id)
    assert events[-1]["data"]["text"] == "Summed up."
    plan_now = (await timeline(live.api, run_id))["plan"]
    assert [s["title"] for s in plan_now] == ["List notes", "Summarize them"]
    await pixel.close()


# -- no model; whose events; catching up ---------------------------------------------------


async def test_without_a_transcription_model_the_phone_is_told_which_setting(live: Live):
    ids = await models(live.api)
    r = await live.api.put(
        "/api/settings/models", json={"chat": ids["scripted"], "transcription": None}
    )
    assert r.status_code == 200, r.text
    pixel = await phone(live)
    r = await pixel.speak()
    assert r.status_code == 409
    error = r.json()["error"]
    assert error["code"] == "no_transcription_model"
    assert "Transcription" in error["message"]
    assert "Settings → Providers & Models" in error["message"]
    await pixel.roundtrip()  # no run started, so nothing to hear
    await pixel.close()


async def test_only_the_runs_a_phone_started_reach_it(live: Live):
    await models(live.api)
    script("What time is it?", [TextDelta("It is noon."), Done("end")])
    first = await phone(live, "Pixel")
    second = await phone(live, "Tablet")

    mine = (await ask(first, "What time is it?"))["run_id"]
    events = await first.events_until("voice.say", mine)
    assert of_run(events) == {mine}

    # From the browser (no device), and from the other phone.
    said("What time is it?")
    r = await live.api.post(
        "/api/voice/turns", files={"audio": ("v.wav", b"RIFF" + b"\0" * 64, "audio/wav")}
    )
    assert r.status_code == 202, r.text
    browser = r.json()["run_id"]
    await wait_status(live.api, browser, "completed")
    theirs = (await ask(second, "What time is it?"))["run_id"]
    events = await second.events_until("voice.say", theirs)
    assert of_run(events) == {theirs}  # neither the first phone's run nor the browser's

    # Whatever the first phone gets next is of its own next run: nothing in between.
    again = (await ask(first, "What time is it?"))["run_id"]
    events = await first.events_until("voice.say", again)
    assert of_run(events) == {again}
    await first.close()
    await second.close()


async def test_a_phone_that_reconnects_with_its_last_id_hears_what_it_missed(live: Live):
    await models(live.api)
    script(
        "Remind me to call Tim.",
        [TextDelta("I made a reminder."), Done("end")],
        [TextDelta("It is at five."), Done("end")],
    )
    pixel = await phone(live)
    body = await ask(pixel, "Remind me to call Tim.")
    events = await pixel.events_until("voice.say", body["run_id"])
    last_id = events[-1]["id"]
    await pixel.close()

    # While the phone is away, a follow-up it sent just before dropping runs to the end.
    said("When is it?")
    r = await pixel.speak(conversation_id=body["conversation_id"])
    assert r.status_code == 202, r.text
    away = r.json()["run_id"]
    await wait_status(live.api, away, "completed")

    welcome = await pixel.hello(last_id=last_id)
    assert welcome["missed"] is False
    events = await pixel.events_until("voice.say", away)
    assert of_run(events) == {away}  # nothing from before last_id again
    assert events[-1]["data"]["text"] == "It is at five."
    assert "completed" in [e["data"].get("status") for e in events]
    await pixel.close()
