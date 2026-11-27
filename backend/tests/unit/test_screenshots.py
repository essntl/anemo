"""Old screenshots are left out of an agent's requests, the newest kept."""

from app.providers.base import (
    AttachmentRef,
    Message,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
)
from app.runtime.history import estimate_tokens
from app.runtime.screenshots import BATCH, KEEP, LEFT_OUT, without_old_screenshots


def _run(steps: int) -> list[Message]:
    """A computer run: each step a computer_look call and its screenshot."""
    out = [Message.user("Book the train ticket")]
    for i in range(steps):
        out.append(
            Message(
                role="assistant",
                content=[ToolUseBlock(id=f"c{i}", name="computer_look", input={})],
            )
        )
        out.append(
            Message(
                role="user",
                content=[
                    ToolResultBlock(tool_use_id=f"c{i}", content=f"window {i}"),
                    TextBlock(text=f"[Image from computer_look: shot{i}.png]"),
                    AttachmentRef(attachment_id=f"a{i}", filename=f"shot{i}.png", kind="image"),
                ],
            )
        )
    return out


def _images(transcript: list[Message]) -> list[str]:
    return [
        b.attachment_id
        for m in transcript
        for b in m.content
        if isinstance(b, AttachmentRef) and b.kind == "image"
    ]


def test_a_short_run_keeps_every_screenshot() -> None:
    run = _run(KEEP + BATCH - 1)
    assert without_old_screenshots(run) is run


def test_older_screenshots_go_in_batches_the_newest_stay() -> None:
    run = _run(20)
    sent = without_old_screenshots(run)
    kept = _images(sent)
    assert KEEP <= len(kept) < KEEP + BATCH
    assert kept == [f"a{i}" for i in range(20 - len(kept), 20)]  # the newest
    assert sum(1 for m in sent for b in m.content if b == TextBlock(text=LEFT_OUT)) == 20 - len(
        kept
    )
    assert len(_images(run)) == 20  # the stored transcript is not changed
    # 20 screenshots: ~32k tokens of pictures in every request, now ~8k.
    assert estimate_tokens(run) - estimate_tokens(sent) > 15 * 1_500


def test_the_prefix_changes_only_once_per_batch() -> None:
    # Two consecutive steps inside one batch send the same earlier messages.
    a = without_old_screenshots(_run(KEEP + BATCH))
    b = without_old_screenshots(_run(KEEP + BATCH + 1))
    assert b[: len(a)] == a


def test_images_the_user_attached_are_kept() -> None:
    user_photo = Message(
        role="user",
        content=[
            TextBlock(text="What is on this photo?"),
            AttachmentRef(attachment_id="photo", filename="p.jpg", kind="image"),
        ],
    )
    run = [user_photo, *_run(20)[1:]]
    assert "photo" in _images(without_old_screenshots(run))
