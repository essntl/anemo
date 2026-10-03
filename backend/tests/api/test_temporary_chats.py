"""Temporary chats: deleted a few minutes after their last message, unless kept."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update

from app.core.db import get_sessionmaker
from app.features.conversations import service
from app.features.conversations.models import Conversation
from app.jobs.models import Job
from tests.api.test_agent import workspace  # noqa: F401 - autouse fixture
from tests.api.test_projects_chats import echo_model, new_chat, say
from tests.conftest import requires_db

pytestmark = requires_db


async def age(cid: str, minutes: float) -> None:
    """Pretend the chat's last message was `minutes` ago."""
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Conversation)
            .where(Conversation.id == uuid.UUID(cid))
            .values(last_message_at=datetime.now(UTC) - timedelta(minutes=minutes))
        )
        await db.commit()


async def exists(client, cid: str) -> bool:
    return (await client.get(f"/api/conversations/{cid}")).status_code == 200


async def test_a_temporary_chat_says_when_it_goes_and_can_be_kept(authed):
    cid = await new_chat(authed, temporary=True)
    chat = (await authed.get(f"/api/conversations/{cid}")).json()
    assert chat["temporary"] is True
    last = datetime.fromisoformat(chat["last_message_at"])
    assert datetime.fromisoformat(chat["expires_at"]) - last == timedelta(minutes=5)
    # It is listed like any chat, marked as temporary.
    listed = (await authed.get("/api/conversations")).json()
    assert [(c["id"], c["temporary"]) for c in listed] == [(cid, True)]

    r = await authed.patch(f"/api/conversations/{cid}", json={"temporary": False})
    assert r.status_code == 200
    assert (r.json()["temporary"], r.json()["expires_at"]) == (False, None)
    # A kept chat is never made temporary again.
    r = await authed.patch(f"/api/conversations/{cid}", json={"temporary": True})
    assert r.status_code == 422

    normal = await new_chat(authed)
    assert (await authed.get(f"/api/conversations/{normal}")).json()["temporary"] is False


async def test_temporary_chats_are_deleted_after_five_quiet_minutes(authed, monkeypatch):
    old = await new_chat(authed, title="Old", temporary=True)
    recent = await new_chat(authed, title="Recent", temporary=True)
    kept = await new_chat(authed, title="Kept", temporary=True)
    normal = await new_chat(authed, title="Normal")
    busy = await new_chat(authed, title="Still answering", temporary=True)
    for cid in (old, kept, normal, busy):
        await age(cid, 6)
    await age(recent, 4)
    await authed.patch(f"/api/conversations/{kept}", json={"temporary": False})

    # An answer still being written in a chat keeps it until it is done.
    real_active_runs = service.active_runs

    async def answering(db, ids):
        found = await real_active_runs(db, ids)
        return found | {uuid.UUID(busy): uuid.uuid4()} if uuid.UUID(busy) in ids else found

    monkeypatch.setattr(service, "active_runs", answering)
    assert await service.delete_expired_temporary() == 1
    assert [await exists(authed, c) for c in (old, recent, kept, normal, busy)] == [
        False,
        True,
        True,
        True,
        True,
    ]
    monkeypatch.setattr(service, "active_runs", real_active_runs)
    assert await service.delete_expired_temporary() == 1
    assert not await exists(authed, busy)


async def test_a_new_message_restarts_the_five_minutes(authed):
    await echo_model(authed)
    cid = await new_chat(authed, temporary=True)
    await age(cid, 4.5)
    await say(authed, cid, "still here")
    await service.delete_expired_temporary(datetime.now(UTC) + timedelta(minutes=1))
    assert await exists(authed, cid)


async def test_nothing_is_learned_from_a_temporary_chat(authed):
    await echo_model(authed)

    async def extraction_jobs(cid: str) -> int:
        async with get_sessionmaker()() as db:
            return int(
                await db.scalar(
                    select(func.count())
                    .select_from(Job)
                    .where(Job.dedupe_key.like(f"memory.extract:{cid}:%"))
                )
                or 0
            )

    normal = await new_chat(authed)
    await say(authed, normal, "I live in Lisbon")
    assert await extraction_jobs(normal) == 1  # the check below means something

    temporary = await new_chat(authed, temporary=True)
    await say(authed, temporary, "I live in Lisbon")
    assert await extraction_jobs(temporary) == 0
