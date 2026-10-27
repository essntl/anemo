"""The volatile per-turn context of a user message.

Prompt caching works on exact prefixes: any byte that changes between two
requests invalidates everything after it. So the system prompt holds only what
is stable for a conversation (instructions, profile, skills, project), and what
changes from one turn to the next (the date and time, the memories that fit this
message) goes into a "turn context" block at the end of the newest user message.

The rendered block is saved with that user message (`messages.turn_context`) and
replayed byte for byte whenever the message is part of a later request's history,
so turn N looks the same in run N and in every run after it.
"""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.providers.base import ContentBlock, Message, TextBlock

OPEN = "<turn_context>"
CLOSE = "</turn_context>"
HEADER = (
    "Context added by the system to this message (not written by the user). "
    "It is true for this turn only."
)


def now_line(tz: str) -> str:
    try:
        now = datetime.now(ZoneInfo(tz))
    except (ZoneInfoNotFoundError, ValueError):
        now, tz = datetime.now(UTC), "UTC"
    return f"Current date and time: {now:%A, %Y-%m-%d %H:%M} ({tz})"


def render(tz: str, *sections: str) -> str:
    """The block for one user message: the date and time, then any sections
    (memories, notes), each already formatted. Empty sections are left out."""
    parts = [HEADER, now_line(tz), *(s.strip() for s in sections if s and s.strip())]
    return f"{OPEN}\n" + "\n\n".join(parts) + f"\n{CLOSE}"


def block(text: str) -> TextBlock:
    return TextBlock(text=text)


def is_context_block(b: ContentBlock) -> bool:
    return isinstance(b, TextBlock) and b.text.startswith(OPEN) and b.text.endswith(CLOSE)


def attach(message: Message, text: str) -> Message:
    """`message` with the context block at its end (once)."""
    if existing(message) == text:
        return message
    return Message(role=message.role, content=[*message.content, block(text)])


def existing(message: Message | None) -> str | None:
    """The context block a (user) message already carries, if any."""
    if message is None:
        return None
    for b in reversed(message.content):
        if is_context_block(b):
            assert isinstance(b, TextBlock)
            return b.text
    return None
