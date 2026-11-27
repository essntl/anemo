"""A run's snapshot reads the settings sections in one query, and still sees what was saved."""

import uuid

from app.core.db import get_sessionmaker
from app.features.runs.models import Run
from app.features.settings import service as settings_service
from app.features.settings.sections import FocusSettings, GeneralSettings
from app.runtime.agent_snapshot import snapshot_run
from tests.api.test_agent import setup
from tests.conftest import requires_db
from tests.querycount import count_statements

pytestmark = requires_db


async def test_snapshot_reads_settings_once(authed):
    cid = await setup(authed)
    r = await authed.post(f"/api/conversations/{cid}/turns", json={"text": "hi", "mode": "agent"})
    assert r.status_code == 202, r.text
    run_id = uuid.UUID(r.json()["run_id"])
    async with get_sessionmaker()() as db:
        run = await db.get(Run, run_id)
        assert run is not None
        with count_statements() as sql:
            await snapshot_run(db, run, [])
        assert run.policy is not None
    # Before: one query per section (general, workspace, web, memory, navigation, …).
    assert len(sql.matching("FROM app_settings")) == 1


async def test_get_section_after_load_all(authed):
    r = await authed.put("/api/settings/general", json={"timezone": "Europe/Kyiv"})
    assert r.status_code == 200, r.text
    async with get_sessionmaker()() as db:
        await settings_service.load_all(db)
        with count_statements() as sql:
            general = await settings_service.get_section(db, GeneralSettings, "general")
            focus = await settings_service.get_section(db, FocusSettings, "focus")
        assert general.timezone == "Europe/Kyiv"
        assert focus == FocusSettings()  # no row: the defaults, without a query
        assert sql == []
        # A section saved later in the same session is read back, not taken as missing.
        await settings_service.put_section(db, "focus", FocusSettings(focus_minutes=50))
        focus = await settings_service.get_section(db, FocusSettings, "focus")
        assert focus.focus_minutes == 50
