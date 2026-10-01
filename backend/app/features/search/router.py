from fastapi import APIRouter, Query

from app.api.deps import Db
from app.core.errors import AppError
from app.features.search import service
from app.features.search.service import KINDS, Kind, Mode, SearchOut

router = APIRouter(tags=["search"])


@router.get("/search", response_model=SearchOut)
async def search(
    db: Db,
    q: str = Query(max_length=300),
    kinds: str | None = Query(None, description="Comma-separated; default: everything"),
    limit: int = Query(5, ge=1, le=50, description="Hits per kind"),
    mode: Mode = Query(
        "keyword", description="hybrid: documents and memories are also found by meaning"
    ),
) -> SearchOut:
    """Search chats, documents, memories, tasks, events, files and automations.
    Hits come grouped by kind."""
    wanted: list[Kind] = list(KINDS)
    if kinds:
        names = [k.strip() for k in kinds.split(",") if k.strip()]
        unknown = [k for k in names if k not in KINDS]
        if unknown:
            raise AppError(f"Unknown kind: {unknown[0]}", code="unknown_kind")
        wanted = [k for k in KINDS if k in names]
    return await service.search(db, q, kinds=wanted, limit=limit, mode=mode)
