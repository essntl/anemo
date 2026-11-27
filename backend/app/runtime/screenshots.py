"""Old screenshots out of an agent's requests.

A computer or browser run takes a screenshot for most steps, and each one is sent again
with every later request (~1,600 tokens each): a 40-step run re-sent tens of thousands
of tokens of pictures the model had already acted on. Only the newest ones matter.

Tool images (those in the user turn that carries tool results) older than the newest
KEEP are replaced by a line saying so. They go in batches of BATCH, so the part of the
request before them (a prompt-cache prefix) changes once every BATCH screenshots, not on
every step: between KEEP and KEEP + BATCH - 1 stay. Images the user attached are never
dropped, and the stored transcript and the timeline keep every screenshot.
"""

from app.providers.base import AttachmentRef, Message, TextBlock, ToolResultBlock

KEEP = 3
BATCH = 4

LEFT_OUT = "[An older screenshot is left out to save space: newer ones follow.]"


def _tool_images(transcript: list[Message]) -> list[tuple[int, int]]:
    """(message, block) positions of the images tools returned, oldest first."""
    found = []
    for i, msg in enumerate(transcript):
        if msg.role != "user" or not any(isinstance(b, ToolResultBlock) for b in msg.content):
            continue
        for j, block in enumerate(msg.content):
            if isinstance(block, AttachmentRef) and block.kind == "image":
                found.append((i, j))
    return found


def without_old_screenshots(transcript: list[Message]) -> list[Message]:
    """The transcript to send: tool images older than the newest ones left out (see
    the module docstring). The given messages are not changed."""
    images = _tool_images(transcript)
    drop_count = ((len(images) - KEEP) // BATCH) * BATCH if len(images) > KEEP else 0
    if drop_count <= 0:
        return transcript
    dropped: dict[int, set[int]] = {}
    for i, j in images[:drop_count]:
        dropped.setdefault(i, set()).add(j)
    out = []
    for i, msg in enumerate(transcript):
        if i not in dropped:
            out.append(msg)
            continue
        content = [
            TextBlock(text=LEFT_OUT) if j in dropped[i] else block
            for j, block in enumerate(msg.content)
        ]
        out.append(Message(role=msg.role, content=content))
    return out
