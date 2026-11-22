"""Voice: talk to Anemo from a phone (docs/specs/05-voice-android.md).

A recording becomes a request and an agent turn in the Voice chat; a spoken reply
answers a question or decides an approval. This is dictation's transcription and
clean-up (features/dictation) with an agent run behind it. Neither the audio nor the
transcript is stored or logged here: the request becomes the user's chat message, as
any message does, and usage records are kept for both models.
"""

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict, NotFound
from app.features.conversations import service as conversations
from app.features.conversations.models import Conversation
from app.features.devices import service as devices
from app.features.dictation import service as dictation
from app.features.profiles.models import AgentProfile
from app.features.runs.agent_router import DecisionIn, decide_approval
from app.features.runs.models import ACTIVE_STATUSES, Approval, Run, ToolCall
from app.features.settings import service as settings_service
from app.features.settings.sections import DictationSettings, VoiceSettings
from app.features.voice import speech

log = logging.getLogger(__name__)

# The whole recording was one of these: throw it away.
CANCEL_WORDS = frozenset({"cancel", "cancel that", "never mind", "nevermind", "never mind that"})
# The whole recording was this: say what is running.
STATUS_WORDS = frozenset({"status"})
# A question's answer that leaves the choice to the agent (as "deny" does in the chat).
UP_TO_YOU = frozenset(
    {"up to you", "its up to you", "thats up to you", "you decide", "you choose", "your call"}
)

NOT_HEARD = "Sorry, I didn't catch that."
UNCLEAR = "Sorry, was that a yes?"
NEEDS_TAP = "That one needs a tap."
VOICE_APPROVALS_OFF = "Approvals by voice are off; that one needs a tap."
MAX_ANSWER_CHARS = 4000  # as DecisionIn.answer

# The turn note: the user listens; it goes in the turn context, not the system prompt.
TURN_NOTE = (
    "Voice request: the user said this to their phone{device} and will hear your answer "
    "read aloud. Answer in one to three short spoken sentences: no Markdown, no lists, "
    "tables, code or links. If the answer needs more, put it in a document or a task and "
    "say where. If the request is unclear, ask with ask_user."
)


class NeedsTap(Conflict):
    """Voice can't decide this one: the notification's buttons (or the app) do."""

    code = "needs_tap"


class UnsupportedAudio(AppError):
    """A recording that is empty, too large or not audio (dictation's codes, as 422)."""

    status_code = 422
    code = "unsupported_audio"


@dataclass
class VoiceTurn:
    run_id: uuid.UUID | None = None
    conversation_id: uuid.UUID | None = None
    heard: str | None = None
    request: str | None = None
    cancelled: bool | None = None
    say: str | None = None


@dataclass
class VoiceReply:
    decided: Literal["approve", "deny"] | None
    heard: str
    say: str | None = None


def words(text: str) -> str:
    """Lower case, without punctuation: for matching a short spoken command."""
    text = text.lower().replace("’", "'").replace("'", "")
    return " ".join(re.sub(r"[^\w\s]", " ", text).split())


def turn_note(device_name: str | None) -> str:
    return TURN_NOTE.format(device=f" ({device_name})" if device_name else "")


def _check_audio(audio: bytes, content_type: str) -> None:
    """Raises UnsupportedAudio (422) for an empty, too large or unknown recording."""
    if not audio:
        raise UnsupportedAudio("The recording is empty.", code="empty_audio")
    if len(audio) > dictation.MAX_AUDIO_BYTES:
        raise UnsupportedAudio("Recordings can be at most 25 MB.", code="audio_too_large")
    try:
        dictation.audio_extension(content_type)
    except AppError as exc:
        raise UnsupportedAudio(exc.message) from None


async def _heard(db: AsyncSession, audio: bytes, content_type: str) -> tuple[str, list[str]]:
    """The transcript, and the word list (Settings → Dictation applies to voice too)."""
    _check_audio(audio, content_type)
    settings = await settings_service.get_section(db, DictationSettings, "dictation")
    raw = await dictation.transcribe(db, audio, content_type, settings)
    return raw.strip(), settings.vocabulary


# -- requests ----------------------------------------------------------------------------


async def _busy(db: AsyncSession, conversation_id: uuid.UUID) -> bool:
    return (
        await db.scalar(
            select(Run.id)
            .where(Run.conversation_id == conversation_id, Run.status.in_(ACTIVE_STATUSES))
            .limit(1)
        )
    ) is not None


def _usable(conv: Conversation | None) -> bool:
    return (
        conv is not None and conv.automation_id is None and not conv.archived and not conv.temporary
    )


async def _follow_up(
    db: AsyncSession, conversation_id: uuid.UUID | None, settings: VoiceSettings
) -> Conversation | None:
    """The chat a follow-up continues: the one the phone names, when its last message is
    within the follow-up window and it isn't answering something else."""
    if conversation_id is None or settings.follow_up_minutes == 0:
        return None
    conv = await db.get(Conversation, conversation_id)
    if conv is None or not _usable(conv):
        return None
    window = timedelta(minutes=settings.follow_up_minutes)
    if datetime.now(UTC) - conv.last_message_at > window or await _busy(db, conv.id):
        return None
    return conv


async def _voice_chat(db: AsyncSession, settings: VoiceSettings) -> Conversation:
    """The Voice chat: the one the latest voice request went to, while it is today's
    (or always, with one chat that keeps going). A new one when there is none, or when
    it is still answering an earlier request (a new request doesn't wait for it)."""
    tz = ZoneInfo(await settings_service.user_timezone(db))
    today = datetime.now(tz).date()
    latest = await db.scalar(
        select(Conversation)
        .join(Run, Run.conversation_id == Conversation.id)
        .where(Run.options["source"].astext == "voice", Run.parent_run_id.is_(None))
        .order_by(Run.created_at.desc())
        .limit(1)
    )
    if (
        latest is not None
        and _usable(latest)
        and (settings.chat == "single" or latest.created_at.astimezone(tz).date() == today)
        and not await _busy(db, latest.id)
    ):
        return latest
    title = "Voice" if settings.chat == "single" else f"Voice · {today.isoformat()}"
    conv = await conversations.create_conversation(db, title, None, None)
    conv.default_mode = "agent"
    return conv


async def _profile_id(db: AsyncSession, settings: VoiceSettings) -> uuid.UUID | None:
    """The profile from Settings → Voice; the default agent when it was deleted."""
    if settings.profile_id is None or await db.get(AgentProfile, settings.profile_id) is None:
        return None
    return settings.profile_id


async def status_text(db: AsyncSession) -> str:
    """What is running, as one or two sentences to speak."""
    rows = list(
        await db.scalars(
            select(Run)
            .where(Run.status.in_(ACTIVE_STATUSES), Run.parent_run_id.is_(None))
            .order_by(Run.created_at)
        )
    )
    if not rows:
        return "Nothing is running."
    names = [_brief(r.request) for r in rows[:3]]
    if len(rows) > 3:
        names.append(f"and {_number(len(rows) - 3).lower()} more")
    head = "One run is working" if len(rows) == 1 else f"{_number(len(rows))} runs are working"
    text = f"{head}: {'; '.join(names)}."
    waiting = sum(1 for r in rows if r.status == "waiting_approval")
    if waiting and len(rows) == 1:
        text += " It waits for you."
    elif waiting == 1:
        text += " One of them waits for you."
    elif waiting:
        text += f" {_number(waiting)} of them wait for you."
    return text


_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]


def _number(n: int) -> str:
    """A count as said at the start of a sentence ("Two", "12")."""
    word = _NUMBERS[n] if n < len(_NUMBERS) else str(n)
    return word[:1].upper() + word[1:]


def _brief(request: str, limit: int = 80) -> str:
    text = speech.plain(request)[0].rstrip(".!?…") or "a request"
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0] + "…"


async def turn(
    db: AsyncSession,
    audio: bytes | None,
    content_type: str,
    *,
    conversation_id: uuid.UUID | None,
    status: bool,
    token_id: uuid.UUID | None,
) -> VoiceTurn:
    """A spoken request: transcribed, made a clear request, and started as an agent turn
    in the Voice chat. "Cancel" on its own throws it away; "status" (or `status`) says
    what is running. Commits."""
    if status:
        return VoiceTurn(say=await status_text(db))
    heard, vocabulary = await _heard(db, audio or b"", content_type)
    said = words(heard)
    if not said:
        return VoiceTurn(say=NOT_HEARD)
    if said in CANCEL_WORDS:
        return VoiceTurn(cancelled=True)
    if said in STATUS_WORDS:
        return VoiceTurn(say=await status_text(db))
    cleaned = await dictation.clean_up(db, heard, "voice", vocabulary)
    request = cleaned.text.strip() or heard
    settings = await settings_service.get_section(db, VoiceSettings, "voice")
    device = await devices.by_token_id(db, token_id) if token_id is not None else None
    options: dict[str, Any] = {
        "source": "voice",
        "turn_note": turn_note(device.name if device else None),
    }
    if device is not None:
        options["device_id"] = str(device.id)
        options["device_name"] = device.name  # for "Asked by voice from ‹phone›"
    conv = await _follow_up(db, conversation_id, settings) or await _voice_chat(db, settings)
    run, *_ = await conversations.send_turn(
        db,
        conv.id,
        request,
        None,
        mode="agent",
        profile_id=await _profile_id(db, settings),
        options=options,
    )  # commits
    return VoiceTurn(run_id=run.id, conversation_id=conv.id, heard=heard, request=request)


# -- replies -----------------------------------------------------------------------------


async def reply(
    db: AsyncSession, approval_id: uuid.UUID, audio: bytes, content_type: str, *, ip: str
) -> VoiceReply:
    """A spoken reply to a question, an approval or a plan review. Decided through
    `decide_approval`, as the app's buttons are. A dangerous action is never decided by
    voice, nor an approval or plan when approvals by voice are off. Commits."""
    approval = await db.get(Approval, approval_id)
    if approval is None:
        raise NotFound("Approval not found")
    if approval.status != "pending":
        raise Conflict("This request was already answered", code="already_decided")
    call = await db.get(ToolCall, approval.tool_call_id)
    if call is not None and call.risk == "dangerous":
        raise NeedsTap(NEEDS_TAP)
    if approval.kind != "question":
        settings = await settings_service.get_section(db, VoiceSettings, "voice")
        if not settings.approvals_by_voice:
            raise NeedsTap(VOICE_APPROVALS_OFF)
    heard, _ = await _heard(db, audio, content_type)
    body: DecisionIn
    if approval.kind == "question":
        said = words(heard)
        if not said:
            return VoiceReply(None, heard, NOT_HEARD)
        if said in UP_TO_YOU:
            body = DecisionIn(decision="deny")
        else:
            body = DecisionIn(decision="approve", answer=heard[:MAX_ANSWER_CHARS])
    else:
        verdict = await dictation.classify_reply(db, heard)
        if verdict == "unclear":
            return VoiceReply(None, heard, UNCLEAR)
        # A plan: yes accepts it as proposed (no `plan`), no rejects it.
        body = DecisionIn(decision="approve" if verdict == "yes" else "deny", scope="once")
    await decide_approval(db, approval_id, body, ip=ip, via="voice")  # commits
    return VoiceReply(body.decision, heard)
