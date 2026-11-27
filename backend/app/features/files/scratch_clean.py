"""The worker's clean-up of the workspace scratch folder (app/workspace/scratch.py): files
older than Settings > Workspace > "Keep scratch files" go, at most once an hour."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from app.core.db import get_sessionmaker
from app.features.settings import service as settings_service
from app.features.settings.sections import FilesSettings
from app.workspace import scratch

log = logging.getLogger(__name__)

CLEAN_EVERY = timedelta(hours=1)
_last_clean: datetime | None = None


async def clean_if_due() -> None:
    global _last_clean
    now = datetime.now(UTC)
    if _last_clean is not None and now - _last_clean < CLEAN_EVERY:
        return
    _last_clean = now
    async with get_sessionmaker()() as db:
        section = await settings_service.get_section(db, FilesSettings, "files")
    scratch.ensure()
    removed = await asyncio.to_thread(scratch.clean, section.scratch_keep_days)
    if removed:
        log.info("scratch cleaned", extra={"ctx": {"files": removed}})
