"""Quick capture from the browser extension: save a page or a selection into a document."""

from fastapi import APIRouter

from app.api.deps import Db
from app.features.capture import service
from app.features.capture.schemas import CaptureIn, CaptureStarted, CaptureStatus

router = APIRouter(prefix="/capture", tags=["capture"])


@router.post("", response_model=CaptureStarted, status_code=202)
async def capture(body: CaptureIn, db: Db) -> CaptureStarted:
    """Queue a save. Follow it with the `capture.progress` / `capture.finished` events
    or GET /api/capture/{id}."""
    return CaptureStarted(id=await service.start(db, body))


@router.get("/{capture_id}", response_model=CaptureStatus)
async def capture_status(capture_id: str) -> CaptureStatus:
    return await service.status(capture_id)
