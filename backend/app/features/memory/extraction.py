"""Background memory extraction.

A couple of minutes after a conversation goes quiet, its new messages are read by
the memory model (Settings > Providers & Models > Memory), together with what is
already remembered, and it proposes memories to add or correct. Depending on
Settings > Memory these become suggestions (to approve on the Memory page) or are
saved right away.

Explicit requests ("remember that ...") do not wait for this: the assistant saves
those immediately with its memory tools.
"""

import json
import logging
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.events import bus
from app.features.conversations.models import ChatMessage, Conversation
from app.features.memory import service
from app.features.memory.models import Memory
from app.features.usage import service as usage
from app.jobs import queue
from app.knowledge import index
from app.providers.base import ChatRequest, Message, ProviderError, TextDelta, Usage
from app.providers.registry import make_adapter
from app.providers.router import NoModelAvailable, RouteRequest, resolve

log = logging.getLogger(__name__)

IDLE = timedelta(minutes=2)
MAX_MESSAGES = 40
MAX_CHARS = 16_000
KINDS = {"preference", "fact", "instruction", "project"}

# The prompt starts with this line (the fake test provider recognizes it).
PROMPT = """\
Extract durable memories about the user from the conversation below.

A memory is worth saving only if it is about the user (their preferences, facts about \
them and their life or work, ongoing projects, standing instructions for the assistant), \
is likely to matter in future conversations, and was stated or clearly implied by the \
user. Do not save: one-off requests, the content of the task itself, things the \
assistant said, guesses, or anything secret (passwords, keys, tokens).

Already remembered (do not repeat these; update one if the user corrected it):
{existing}

Reply with only a JSON array (possibly empty). Each item is one of:
  {{"op": "add", "content": "<one self-contained sentence>", "importance": 0.0-1.0,
    "kind": "preference|fact|project|instruction"}}
  {{"op": "update", "id": "<id from the list above>", "content": "<the corrected sentence>"}}

<conversation>
{conversation}
</conversation>"""


async def schedule(db: AsyncSession, conversation_id: uuid.UUID, upto_seq: int) -> None:
    """Called when a run finishes: look at the conversation once it has been idle."""
    settings = await service.get_settings(db)
    if not settings.enabled or settings.extraction == "off":
        return
    key = f"memory.extract:{conversation_id}:{upto_seq}"
    if await db.scalar(select(queue.Job.id).where(queue.Job.dedupe_key == key)):
        return  # e.g. a regenerated answer with the same position
    await queue.enqueue(
        db,
        "memory.extract",
        {"conversation_id": str(conversation_id), "upto_seq": upto_seq},
        run_at=datetime.now(UTC) + IDLE,
        dedupe_key=key,
    )


def parse_operations(text: str) -> list[dict[str, Any]]:
    """The JSON array from the model's reply, tolerating code fences and chatter."""
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return []
    return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []


def _render(messages: list[ChatMessage]) -> str:
    parts = [f"{m.role.upper()}: {m.text_plain.strip()[:3000]}" for m in messages if m.text_plain]
    text = "\n\n".join(parts)
    return text[-MAX_CHARS:]


async def extract(conversation_id: uuid.UUID, upto_seq: int) -> int:
    """Runs one extraction. Returns how many memories were added or changed."""
    async with get_sessionmaker()() as db:
        settings = await service.get_settings(db)
        conv = await db.get(Conversation, conversation_id)
        if conv is None or not settings.enabled or settings.extraction == "off":
            return 0
        latest = await db.scalar(
            select(func.max(ChatMessage.seq)).where(ChatMessage.conversation_id == conv.id)
        )
        if (latest or 0) > upto_seq:
            return 0  # the conversation went on; the job for the newer message handles it
        messages = list(
            await db.scalars(
                select(ChatMessage)
                .where(
                    ChatMessage.conversation_id == conv.id,
                    ChatMessage.seq > conv.memory_extracted_seq,
                    ChatMessage.status.in_(("complete", "cancelled")),
                )
                .order_by(ChatMessage.seq.desc())
                .limit(MAX_MESSAGES)
            )
        )[::-1]
        conv.memory_extracted_seq = upto_seq
        user_text = " ".join(m.text_plain for m in messages if m.role == "user")
        if not user_text.strip():
            await db.commit()
            return 0

        # What is already known and could be related, so the model neither repeats it
        # nor misses a correction.
        known: dict[uuid.UUID, Memory] = {m.id: m for m in await service.always_included(db)}
        for hit in await index.search(
            db, user_text[:2000], service.SOURCE_TYPE, limit=25, min_similarity=0.2
        ):
            memory = await db.get(Memory, hit.source_id)
            if memory is not None and memory.status != "archived":
                known[memory.id] = memory
        existing = "\n".join(f"- [{m.id}] {m.content}" for m in known.values()) or "(nothing yet)"

        try:
            model = (await resolve(db, RouteRequest(task="memory")))[0]
        except NoModelAvailable:
            await db.commit()
            return 0
        req = ChatRequest(
            model=model.model_key,
            messages=[
                Message.user(PROMPT.format(existing=existing, conversation=_render(messages)))
            ],
            max_tokens=1500,
            reasoning_effort="low",
            provider_options=model.provider_options,
        )
        parts: list[str] = []
        used = Usage()
        try:
            async for event in make_adapter(model.config).stream_chat(req):
                if isinstance(event, TextDelta):
                    parts.append(event.text)
                elif isinstance(event, Usage):
                    used = event
        except ProviderError as exc:
            log.warning("memory extraction failed", extra={"ctx": {"error": str(exc)}})
            await db.rollback()  # leave memory_extracted_seq: retried with the next messages
            return 0
        usage.record(db, model, used, "memory", conversation_id=conv.id)
        await db.commit()

        status = "active" if settings.extraction == "auto" else "pending"
        changed = 0
        for op in parse_operations("".join(parts))[:10]:
            content = str(op.get("content") or "").strip()
            if len(content) < 3:
                continue
            try:
                if op.get("op") == "update":
                    target_id = _uuid(op.get("id"))
                    target = known.get(target_id) if target_id else None
                    if target is None or target.content == content:
                        continue
                    if status == "active":
                        await service.update(db, target, content=content)
                    else:
                        # A correction is suggested as a new memory; approving it is up to the user.
                        await _add(
                            db, content, target.kind, target.importance, status, conv.id, target.id
                        )
                    changed += 1
                elif op.get("op") == "add":
                    kind = str(op.get("kind")) if op.get("kind") in KINDS else "fact"
                    importance = _importance(op.get("importance"))
                    if await _add(db, content, kind, importance, status, conv.id):
                        changed += 1
            except AppError:
                continue  # e.g. looked like a secret: skipped
        if changed:
            await bus.publish_global("memory.changed", {"action": "extracted", "count": changed})
        return changed


async def _add(
    db: AsyncSession,
    content: str,
    kind: str,
    importance: float,
    status: str,
    conv_id: uuid.UUID,
    replaces_id: uuid.UUID | None = None,
) -> bool:
    duplicate = await service.find_duplicate(db, content)
    if duplicate is not None and duplicate.id != replaces_id:
        return False
    await service.create(
        db,
        content,
        kind=kind,
        importance=importance,
        status=status,
        source="extracted",
        conversation_id=conv_id,
        replaces_id=replaces_id,
    )
    return True


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


def _importance(value: Any) -> float:
    try:
        return min(1.0, max(0.0, float(value)))
    except (TypeError, ValueError):
        return 0.5
