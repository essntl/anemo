"""The claude_code adapter's delta logic (acceptance criterion 1): Anemo sends the
whole transcript every time, and only what is new may reach the Claude session."""

from typing import Any

import pytest

from app.providers.adapters import claude_code
from app.providers.adapters.claude_code import ClaudeCodeAdapter
from app.providers.base import (
    ChatRequest,
    Done,
    ImageBlock,
    Message,
    ProviderConfig,
    ProviderError,
    TextBlock,
    TextDelta,
    ToolCall,
    ToolResultBlock,
    ToolSpec,
    ToolUseBlock,
    Usage,
)
from tests.fake_claude_runner import FakeRunner, MemoryStore, call, say

SYSTEM = "You are Anemo."
TOOLS = [
    ToolSpec(name="read_file", description="Read", input_schema={"type": "object"}),
    ToolSpec(name="list_files", description="List", input_schema={"type": "object"}),
]
KEY = "conv:c1:agent"


@pytest.fixture
def fake(monkeypatch) -> FakeRunner:
    runner = FakeRunner()
    runner.install(monkeypatch)
    monkeypatch.setattr(claude_code, "store", MemoryStore())
    return runner


def user(text: str, ctx: str = "<turn_context>\nnow\n</turn_context>") -> Message:
    return Message(role="user", content=[TextBlock(text=text), TextBlock(text=ctx)])


def req(messages: list[Message], key: str | None = KEY, **kw: Any) -> ChatRequest:
    return ChatRequest(
        model=kw.pop("model", "claude-opus-5-5"),
        system=kw.pop("system", SYSTEM),
        tools=kw.pop("tools", TOOLS),
        messages=messages,
        session_key=key,
        **kw,
    )


async def run(r: ChatRequest) -> list[Any]:
    return [
        e async for e in ClaudeCodeAdapter(ProviderConfig("claude_code", None, None)).stream_chat(r)
    ]


def step(events: list[Any]) -> Message:
    """The assistant message the runtime would save for these events."""
    blocks: list[Any] = []
    text = "".join(e.text for e in events if isinstance(e, TextDelta))
    if text:
        blocks.append(TextBlock(text=text))
    blocks += [
        ToolUseBlock(id=e.id, name=e.name, input=e.arguments or {})
        for e in events
        if isinstance(e, ToolCall)
    ]
    return Message(role="assistant", content=blocks)


def results(*pairs: tuple[str, str], extra: list[Any] | None = None) -> Message:
    return Message(
        role="user",
        content=[*[ToolResultBlock(tool_use_id=i, content=c) for i, c in pairs], *(extra or [])],
    )


async def test_tool_results_reach_the_parked_calls(fake: FakeRunner) -> None:
    fake.replies.append([*say("Looking."), call("read_file", "toolu_1", path="a.txt")])
    history = [user("read a.txt")]
    first = await run(req(history))
    assert [e.id for e in first if isinstance(e, ToolCall)] == ["toolu_1"]
    assert isinstance(first[-1], Done) and first[-1].stop_reason == "tool_use"
    # The first request carries the message, its turn context included.
    assert fake.last_input()["type"] == "message"
    assert fake.last_text() == "read a.txt\n<turn_context>\nnow\n</turn_context>"

    fake.replies.append(say("It says hello."))
    history += [step(first), results(("toolu_1", "hello"))]
    second = await run(req(history))
    sent = fake.last_input()
    assert sent["type"] == "tool_results"
    assert sent["results"] == [
        {
            "tool_use_id": "toolu_1",
            "name": "read_file",
            "content": [{"type": "text", "text": "hello"}],
            "is_error": False,
        }
    ]
    # The same session continues (the first request created it).
    assert fake.bodies[0]["claude_session_id"] is None
    assert fake.bodies[-1]["claude_session_id"] in fake.sessions
    assert isinstance(second[-1], Done) and second[-1].stop_reason == "end"


async def test_parallel_tool_calls_go_back_together(fake: FakeRunner) -> None:
    fake.replies.append([call("read_file", "t_a", path="a"), call("list_files", "t_b", path=".")])
    history = [user("look around")]
    first = await run(req(history))
    assert [e.id for e in first if isinstance(e, ToolCall)] == ["t_a", "t_b"]
    image = ImageBlock(media_type="image/png", data="aGk=")
    note = TextBlock(text="[Message from the user while you were working]\nhurry")
    history += [step(first), results(("t_a", "A"), ("t_b", "B"), extra=[note, image])]
    await run(req(history))
    sent = fake.last_input()["results"]
    assert [r["tool_use_id"] for r in sent] == ["t_a", "t_b"]
    assert sent[0]["content"] == [{"type": "text", "text": "A"}]
    # Notes and images that came with the results ride on the last result.
    assert sent[1]["content"][1]["text"].endswith("hurry")
    assert sent[1]["content"][2] == {"type": "image", "media_type": "image/png", "data": "aGk="}


async def test_a_new_message_after_tool_results_sends_only_that_message(fake: FakeRunner) -> None:
    fake.replies.append([call("read_file", "t1", path="a")])
    run1 = [user("first task")]
    s1 = await run(req(run1))
    fake.replies.append(say("Done with the first."))
    await run(req([*run1, step(s1), results(("t1", "x"))]))
    sid = fake.bodies[0]["claude_session_id"]
    # Next run: the history is what Anemo stores - the user text and the final answer.
    history = [
        user("first task"),
        Message.assistant("Done with the first."),
        user("second task", "<turn_context>\nlater\n</turn_context>"),
    ]
    await run(req(history))
    assert fake.last_input()["type"] == "message"
    assert fake.last_text() == "second task\n<turn_context>\nlater\n</turn_context>"
    assert "first task" not in fake.last_text()  # already in the session
    assert fake.bodies[-1]["claude_session_id"] == fake.bodies[1]["claude_session_id"]
    assert sid is None  # the first request asked for a new session


async def test_messages_from_another_mode_are_caught_up_once(fake: FakeRunner) -> None:
    await run(req([user("agent question")]))  # agent session: u1, a1
    # u2/a2 happened in chat mode (another session); now agent mode again.
    history = [
        user("agent question"),
        Message.assistant("ok"),
        user("chat question"),
        Message.assistant("chat answer"),
        user("agent again"),
    ]
    await run(req(history))
    text = fake.last_text()
    assert text.startswith("<earlier_conversation>")
    assert "chat question" in text and "chat answer" in text
    assert "agent question" not in text  # the session saw that one itself
    assert text.endswith("agent again\n<turn_context>\nnow\n</turn_context>")
    # The next turn needs no catch-up any more.
    await run(req([*history, Message.assistant("ok"), user("and again")]))
    assert fake.last_text() == "and again\n<turn_context>\nnow\n</turn_context>"


async def test_an_edited_message_forks_the_session_at_the_last_matching_turn(
    fake: FakeRunner,
) -> None:
    await run(req([user("one")]))
    await run(req([user("one"), Message.assistant("ok"), user("two")]))
    sid = fake.bodies[-1]["claude_session_id"]
    edited = [user("one"), Message.assistant("ok"), user("two, edited")]
    events = await run(req(edited))
    body = fake.bodies[-1]
    assert body["fork"] is not None and body["claude_session_id"] == sid
    assert fake.last_text() == "two, edited\n<turn_context>\nnow\n</turn_context>"
    usage = next(e for e in events if isinstance(e, Usage))
    assert "diverged" in usage.meta["expected_miss"]


async def test_divergence_at_the_first_message_starts_a_new_seeded_session(
    fake: FakeRunner,
) -> None:
    await run(req([user("one")]))
    await run(req([user("one"), Message.assistant("ok"), user("two")]))
    # The very first message no longer matches (say, a branch with different text).
    await run(req([user("ONE"), Message.assistant("ok"), user("three")]))
    body = fake.bodies[-1]
    assert body["claude_session_id"] is None and body["fork"] is None  # a new session
    text = fake.last_text()
    assert (
        "<earlier_conversation>" in text
        and "ONE" in text
        and text.endswith("three\n<turn_context>\nnow\n</turn_context>")
    )


async def test_model_change_means_a_new_session(fake: FakeRunner) -> None:
    await run(req([user("hi")]))
    await run(req([user("hi"), Message.assistant("ok"), user("again")], model="claude-sonnet-5-5"))
    body = fake.bodies[-1]
    assert body["claude_session_id"] is None and body["model"] == "claude-sonnet-5-5"
    assert "hi" in fake.last_text()  # the earlier turn is caught up in the new session


async def test_changed_settings_are_sent_as_a_note(fake: FakeRunner) -> None:
    await run(req([user("hi")]))
    await run(req([user("hi"), Message.assistant("ok"), user("again")], system="New instructions."))
    first = fake.last_input()["content"][0]["text"]
    assert first.startswith("<settings_changed>") and "New instructions." in first
    await run(
        req(
            [
                user("hi"),
                Message.assistant("ok"),
                user("again"),
                Message.assistant("ok"),
                user("third"),
            ],
            system="New instructions.",
        )
    )
    assert "<settings_changed>" not in fake.last_text()  # only once


async def test_a_retry_after_the_runner_took_the_message_does_not_resend_it(
    fake: FakeRunner,
) -> None:
    fake.fail_next = {"type": "error", "kind": "server", "retryable": True, "message": "500"}
    with pytest.raises(ProviderError) as info:
        await run(req([user("hello")]))
    assert info.value.retryable
    await run(req([user("hello")]))
    assert fake.last_text().startswith("[System note: the previous attempt")


async def test_usage_limit_is_not_retried_on_the_same_model(fake: FakeRunner) -> None:
    fake.fail_next = {
        "type": "error",
        "kind": "usage_limit",
        "retryable": False,
        "message": "The Claude subscription usage limit is reached. It resets at 15:00.",
    }
    with pytest.raises(ProviderError) as info:
        await run(req([user("hello")]))
    assert not info.value.retryable and "resets at" in str(info.value)


async def test_results_for_evicted_calls_still_reach_the_session(fake: FakeRunner) -> None:
    fake.replies.append([call("read_file", "t9", path="a")])
    history = [user("read it")]
    first = await run(req(history))
    fake.evict_all()  # the approval took longer than the idle window
    await run(req([*history, step(first), results(("t9", "content"))]))
    # The adapter sends the results as usual; the runner turns them into a message.
    assert fake.last_input()["type"] == "tool_results"


async def test_usage_and_expected_misses(fake: FakeRunner) -> None:
    events = await run(req([user("hi")]))
    usage = next(e for e in events if isinstance(e, Usage))
    assert usage.cached_tokens == 0 and usage.cache_creation_tokens == 200
    assert usage.input_tokens == 205 and usage.output_tokens == 20
    assert usage.meta["expected_miss"] == "new session"
    assert usage.equivalent_cost_usd == 0.01
    events = await run(req([user("hi"), Message.assistant("ok"), user("more")]))
    usage = next(e for e in events if isinstance(e, Usage))
    assert usage.meta["expected_miss"] is None and usage.cached_tokens == 1000
    # A permission change that adds or removes a tool: an expected, logged miss.
    events = await run(
        req(
            [user("hi"), Message.assistant("ok"), user("more"), Message.assistant("ok"), user("x")],
            tools=TOOLS[:1],
        )
    )
    usage = next(e for e in events if isinstance(e, Usage))
    assert "tool list changed" in usage.meta["expected_miss"]


async def test_one_shot_requests_use_no_session(fake: FakeRunner) -> None:
    events = await run(req([Message.user("Write a title")], key=None, tools=[]))
    assert fake.bodies == [] and len(fake.oneshots) == 1
    assert "".join(e.text for e in events if isinstance(e, TextDelta)) == "A title"


async def test_embeddings_are_refused() -> None:
    with pytest.raises(ProviderError):
        await ClaudeCodeAdapter(ProviderConfig("claude_code", None, None)).embed("m", ["x"])


async def test_regenerating_an_answer_forks_before_the_message(fake: FakeRunner) -> None:
    await run(req([user("one")]))
    await run(req([user("one"), Message.assistant("ok"), user("two")]))
    # "Regenerate": the same history again, the answer to "two" was replaced.
    await run(req([user("one"), Message.assistant("ok"), user("two")]))
    body = fake.bodies[-1]
    assert body["fork"] is not None  # the session will not see its old answer
    assert fake.last_text() == "two\n<turn_context>\nnow\n</turn_context>"


async def test_regenerating_the_first_answer_starts_a_new_session(fake: FakeRunner) -> None:
    await run(req([user("only")]))
    await run(req([user("only")]))
    body = fake.bodies[-1]
    assert body["claude_session_id"] is None and body["fork"] is None
