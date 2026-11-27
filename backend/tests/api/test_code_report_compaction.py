"""code_status says "unchanged" only while the earlier report is still in the model's
context: not after the run's context or the chat was compacted."""

from datetime import UTC, datetime, timedelta

from app.core.db import get_sessionmaker
from app.features.conversations.models import ChatMessage, Conversation
from app.features.runs.models import Run, ToolCall
from app.tools.base import COMPACTED_AT
from app.tools.builtin.code import report_seen
from tests.conftest import requires_db

pytestmark = requires_db

JOB, DIGEST = "job-1", "abc"


async def _run_that_showed_the_report() -> tuple[Run, Conversation]:
    async with get_sessionmaker()() as db:
        conv = Conversation()
        db.add(conv)
        await db.flush()
        run = Run(kind="agent", status="running", conversation_id=conv.id, options={})
        db.add(run)
        await db.flush()
        db.add(
            ToolCall(
                run_id=run.id,
                step=1,
                position=0,
                provider_call_id="c1",
                tool_name="code_status",
                result_data={"code_report": {"job": JOB, "digest": DIGEST}},
                status="succeeded",
            )
        )
        await db.commit()
        return run, conv


async def test_seen_in_the_run_until_its_context_is_compacted():
    run, _ = await _run_that_showed_the_report()
    async with get_sessionmaker()() as db:
        assert await report_seen(db, run.id, JOB, DIGEST)
        row = await db.get(Run, run.id)
        assert row is not None
        later = (datetime.now(UTC) + timedelta(seconds=1)).isoformat()
        row.options = {**row.options, COMPACTED_AT: later}
        await db.commit()
    async with get_sessionmaker()() as db:
        assert not await report_seen(db, run.id, JOB, DIGEST)


async def test_not_seen_after_the_chat_was_compacted():
    run, conv = await _run_that_showed_the_report()
    async with get_sessionmaker()() as db:
        db.add(
            ChatMessage(
                conversation_id=conv.id,
                seq=10,
                role="compaction",
                content=[],
                text_plain="summary",
                status="complete",
                compaction={"kept_from_seq": 10},
                created_at=datetime.now(UTC) + timedelta(seconds=1),
            )
        )
        await db.commit()
    async with get_sessionmaker()() as db:
        assert not await report_seen(db, run.id, JOB, DIGEST)
