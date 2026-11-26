"""The chat recall tools without a database: the permission, how they are offered (also
to automations), their inputs and how a message reads (docs/specs/18-chat-recall.md).
tests/api/test_chat_recall.py runs them against the database."""

import uuid
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.features.conversations.models import ChatMessage
from app.features.runs.models import ToolCall
from app.policy.engine import evaluate
from app.policy.presets import CATEGORY_BY_CAP, PermissionSettings, compile_policy
from app.tools import registry
from app.tools.base import ToolContext, reads_only
from app.tools.builtin import chats

NAMES = {"search_chats", "read_chat"}


async def _noop(*_: object) -> None:
    return None


def make_ctx() -> ToolContext:
    return ToolContext(run_id=uuid.uuid4(), emit=_noop)


def test_read_earlier_chats_is_autonomous_and_both_actions_are_safe() -> None:
    category = CATEGORY_BY_CAP["chats.read"]
    assert category.label == "Read earlier chats" and category.default == "autonomous"
    assert {t.capability for t in chats.CHAT_TOOLS} == {"chats.read"}
    assert all(reads_only(t.capability) and not t.changes(None) for t in chats.CHAT_TOOLS)
    policy = compile_policy(PermissionSettings())
    ctx = make_ctx()
    actions = [
        *chats.SearchChats().actions(chats.SearchChatsInput(query="otters"), ctx),
        *chats.ReadChat().actions(chats.ReadChatInput(chat_id=uuid.uuid4()), ctx),
    ]
    assert [a.risk for a in actions] == ["safe", "safe"]
    assert [evaluate(a, policy).decision for a in actions] == ["allow", "allow"]
    asking = compile_policy(PermissionSettings(levels={"chats.read": "ask"}))
    assert [evaluate(a, asking).decision for a in actions] == ["ask", "ask"]


def test_offered_in_agent_mode_not_in_chat_mode_and_not_when_denied() -> None:
    policy = compile_policy(PermissionSettings())
    assert NAMES <= {t.name for t in registry.toolset_for("agent", policy, None)}
    assert not NAMES & {t.name for t in registry.toolset_for("chat", policy, None)}
    denied = compile_policy(PermissionSettings(levels={"chats.read": "deny"}))
    assert not NAMES & {t.name for t in registry.toolset_for("agent", denied, None)}
    # No page owns chats: turning parts of the app off never removes them.
    assert not NAMES & registry.tools_of(registry.FEATURE_TOOLS)


def test_automations_get_them_only_when_their_list_names_them() -> None:
    tools = registry.all_tools()
    names = lambda ts: {t.name for t in ts}  # noqa: E731
    # Someone's own run, no list: everything.
    assert NAMES <= names(registry.allowed(tools, None))
    # An automation without a list gets the usual tools, but not earlier chats.
    unattended = names(registry.allowed(tools, None, unattended=True))
    assert "list_files" in unattended and not NAMES & unattended
    # Named in its list: given.
    listed = names(registry.allowed(tools, ["search_chats"], unattended=True))
    assert "search_chats" in listed and "read_chat" not in listed


def test_read_chat_takes_one_position_and_limits_the_page() -> None:
    with pytest.raises(ValidationError):
        chats.ReadChatInput(chat_id=uuid.uuid4(), around_seq=3, after_seq=1)
    with pytest.raises(ValidationError):
        chats.ReadChatInput(chat_id=uuid.uuid4(), limit=51)
    with pytest.raises(ValidationError):
        chats.SearchChatsInput(query="")


def _message(**fields) -> ChatMessage:
    defaults = {
        "seq": 4,
        "role": "assistant",
        "content": [],
        "text_plain": "",
        "status": "complete",
        "model_label": None,
        "skill": None,
        "created_at": datetime(2026, 11, 2, 14, 3, tzinfo=UTC),
    }
    return ChatMessage(**{**defaults, **fields})


def test_a_message_reads_as_text_with_one_line_per_tool_call() -> None:
    calls = [
        ToolCall(
            tool_name="web_search",
            actions=[{"summary": "Search the web for otters"}],
            status="succeeded",
        ),
        ToolCall(tool_name="write_file", actions=[{"summary": "write_file"}], status="denied"),
    ]
    text = chats.render_message(
        _message(
            content=[
                {"type": "reasoning", "text": "hidden"},
                {"type": "text", "text": "Otters live in the bay."},
            ],
            text_plain="Otters live in the bay.",
            model_label="Fake",
        ),
        calls,
    )
    assert text.splitlines() == [
        "[seq 4] Assistant (Fake):",
        "[tool web_search: Search the web for otters]",
        "[tool write_file: write_file (denied)]",
        "Otters live in the bay.",
    ]
    user = chats.render_message(
        _message(
            seq=3,
            role="user",
            content=[
                {"type": "attachment", "filename": "photo.png", "kind": "image"},
                {"type": "page", "title": "Otters", "url": "https://example.com/o", "content": "x"},
            ],
            text_plain="x" * (chats.MESSAGE_CHARS + 10),
        ),
        [],
    )
    assert user.startswith("[seq 3] The user, 2026-11-02 14:03 UTC:")
    assert "[attached image: photo.png]" in user
    assert "[attached web page: Otters https://example.com/o]" in user
    assert "[10 more characters left out]" in user
