"""How long each automation run took, in its run log (spec 03 section 5): every row of
GET /api/automations/{id}/runs carries the same `timing` as the run's answer in the chat
(features/runs/service.run_timing). The duration leaves out the time the run waited for
the user."""

import uuid

from app.providers.base import Done, ProviderError, TextDelta
from app.runtime.dispatch import execute_run
from tests.api.test_agent import (
    call,
    script,
    setup,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_automations_reasoning import create, run_log
from tests.api.test_notifications_automations import fire, global_events
from tests.api.test_run_timing import SLACK, at, duration_ms, wait_longer
from tests.conftest import requires_db

pytestmark = requires_db


async def test_each_run_in_the_log_says_how_long_it_took(authed):
    await setup(authed)
    a = await create(authed, prompt="write a note")
    script(
        "write a note",
        [call("write_file", path="notes/a.md", content="hello"), Done("tool_use")],
        [call("list_tasks"), Done("tool_use")],
        [TextDelta("Outcome: wrote it"), Done("end")],
    )
    run_id = await fire(authed, a)  # waits for the approval of write_file

    (entry,) = await run_log(authed, a["id"])
    waiting = entry["timing"]
    assert waiting["started_at"] == entry["created_at"]
    assert waiting["finished_at"] is None and waiting["outcome"] is None
    assert waiting["waiting_since"] is not None and waiting["tool_calls"] == 1

    await wait_longer(run_id, 30)  # it waited half a minute for the user
    (approval,) = (await authed.get("/api/approvals")).json()
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(run_id))
    # Every change of its status was announced (the app then fetches the run log again),
    # also when it went on after the approval: the log doesn't stay at "waiting for you".
    statuses = [e["status"] for e in await global_events("run.status") if e["run_id"] == run_id]
    after_the_wait = statuses[statuses.index("waiting_approval") + 1 :]
    assert "running" in after_the_wait and after_the_wait[-1] == "completed"
    assert all(e["automation"] for e in await global_events("run.status") if e["run_id"] == run_id)

    (entry,) = await run_log(authed, a["id"])
    timing = entry["timing"]
    assert entry["status"] == "completed" and timing["outcome"] == "done"
    assert timing["started_at"] == entry["created_at"]
    assert timing["finished_at"] == entry["ended_at"]
    assert timing["waiting_since"] is None and timing["tool_calls"] == 2
    assert timing["waiting_ms"] >= 30_000 - SLACK.total_seconds() * 1000
    assert 0 <= duration_ms(timing) < 30_000  # the wait is not part of it
    assert at(timing["first_text_at"]) is not None

    # The same numbers as the run's answer in its chat.
    messages = (await authed.get(f"/api/conversations/{entry['conversation_id']}/messages")).json()
    (answer,) = [m for m in messages if m["role"] == "assistant"]
    assert answer["timing"] == timing


async def test_a_failed_run_is_timed_too(authed):
    await setup(authed)
    a = await create(authed, max_retries=0)
    script("check the bookings", [ProviderError("down", retryable=False)])
    await fire(authed, a)
    (entry,) = await run_log(authed, a["id"])
    timing = entry["timing"]
    assert entry["status"] == "failed" and timing["outcome"] == "failed"
    assert timing["finished_at"] == entry["ended_at"] and timing["tool_calls"] == 0
    assert duration_ms(timing) >= -SLACK.total_seconds() * 1000
