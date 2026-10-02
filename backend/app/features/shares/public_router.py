"""Showing a share link: the ONLY endpoint that gives out data without a session.

It is safe to leave open because of what it can reach: one row of `share_links`,
found by a 256-bit random token, holding a copy the owner chose to share. It reads no
live chat, file or setting, and there is nothing to write to. Links that do not exist,
have expired or were revoked all give the same answer.
"""

from typing import Annotated

from fastapi import APIRouter, Path, Request, Response

from app.api.deps import Db, client_ip
from app.core.errors import NotFound
from app.features.shares import service
from app.features.shares.schemas import SharedOut

router = APIRouter(prefix="/public/shares", tags=["shares"])

Token = Annotated[str, Path(min_length=20, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


@router.get("/{token}", response_model=SharedOut, response_model_exclude_none=True)
async def view_share(token: Token, request: Request, response: Response, db: Db) -> SharedOut:
    ip = client_ip(request)
    await service.check_misses(ip)
    shared = await service.view(db, token)
    if shared is None:
        await service.register_miss(ip)
        raise NotFound("This link is no longer available.", code="share_not_found")
    # Not stored by browsers or proxies, not listed by search engines, and the address
    # (which contains the token) is not passed on to sites the shared text links to.
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    response.headers["Referrer-Policy"] = "no-referrer"
    return shared
