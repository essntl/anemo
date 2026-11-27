"""trim_to_budget measures each message once but must keep exactly what the old
re-measuring loop kept."""

import random

from app.providers.base import AttachmentRef, Message, TextBlock
from app.runtime.history import estimate_tokens, trim_to_budget


def _reference(history: list[Message], max_tokens: int) -> list[Message]:
    # The previous implementation, kept here as the definition of the result.
    trimmed = list(history)
    while len(trimmed) > 1 and estimate_tokens(trimmed) > max_tokens:
        trimmed.pop(0)
        while trimmed and trimmed[0].role != "user":
            trimmed.pop(0)
    return trimmed


def _history(rng: random.Random, n: int) -> list[Message]:
    out = []
    for i in range(n):
        role = "user" if i % 2 == 0 or rng.random() < 0.2 else "assistant"
        blocks: list = [TextBlock(text="x" * rng.randint(1, 4000))]
        if rng.random() < 0.1:
            blocks.append(
                AttachmentRef(attachment_id="00000000-0000-0000-0000-000000000001", kind="image")
            )
        out.append(Message(role=role, content=blocks))  # type: ignore[arg-type]
    return out


def test_same_result_as_the_re_measuring_loop() -> None:
    rng = random.Random(7)
    for _ in range(200):
        history = _history(rng, rng.randint(0, 40))
        budget = rng.randint(0, 30_000)
        assert trim_to_budget(history, budget) == _reference(history, budget)


def test_fits_already_returns_a_copy() -> None:
    history = [Message.user("hi"), Message(role="assistant", content=[TextBlock(text="hello")])]
    trimmed = trim_to_budget(history, 1_000)
    assert trimmed == history
    assert trimmed is not history


def test_starts_on_a_user_turn() -> None:
    history = [
        Message.user("a" * 4000),
        Message(role="assistant", content=[TextBlock(text="b" * 4000)]),
        Message.user("c"),
    ]
    assert trim_to_budget(history, 500) == [history[2]]
