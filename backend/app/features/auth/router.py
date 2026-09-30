import uuid
from datetime import datetime

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from app.api.deps import CurrentSession, Db, client_ip
from app.core.config import get_settings
from app.core.errors import NotFound, Unauthorized
from app.features.audit import service as audit
from app.features.auth import service as auth

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str = Field(max_length=200)
    password: str = Field(max_length=500)


class PasswordIn(BaseModel):
    password: str = Field(max_length=500)


class MeOut(BaseModel):
    username: str
    session_id: uuid.UUID
    recent_auth: bool


class SessionOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    last_seen_at: datetime
    ip: str | None
    user_agent: str | None
    current: bool


def _set_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(
        auth.COOKIE_NAME,
        token,
        max_age=s.session_days * 86400,
        httponly=True,
        secure=s.cookie_secure,
        samesite="lax",
        path="/",
    )


@router.post("/login", response_model=MeOut)
async def login(body: LoginIn, request: Request, response: Response, db: Db) -> MeOut:
    ip = client_ip(request)
    await auth.check_rate_limit(ip)
    if not auth.credentials_configured():
        raise Unauthorized("No admin credentials are configured on the server (see .env).")
    if not auth.verify_credentials(body.username, body.password):
        await auth.register_failure(ip)
        audit.record(db, "auth.login_failed", ip=ip, details={"username": body.username[:100]})
        await db.commit()
        raise Unauthorized("Wrong username or password")
    await auth.clear_failures(ip)
    session, token = await auth.create_session(
        db, ip=ip, user_agent=request.headers.get("user-agent")
    )
    audit.record(db, "auth.login", ip=ip, target_type="session", target_id=session.id)
    await db.commit()
    _set_cookie(response, token)
    return MeOut(username=get_settings().admin_username, session_id=session.id, recent_auth=True)


@router.post("/logout", status_code=204)
async def logout(session: CurrentSession, response: Response, db: Db) -> None:
    await auth.revoke_session(db, session.id)
    await db.commit()
    response.delete_cookie(auth.COOKIE_NAME, path="/")


@router.get("/me", response_model=MeOut)
async def me(session: CurrentSession) -> MeOut:
    return MeOut(
        username=get_settings().admin_username,
        session_id=session.id,
        recent_auth=auth.has_recent_auth(session),
    )


@router.post("/reauth", response_model=MeOut)
async def reauth(body: PasswordIn, request: Request, session: CurrentSession, db: Db) -> MeOut:
    ip = client_ip(request)
    await auth.check_rate_limit(ip)
    if not auth.verify_password(body.password):
        await auth.register_failure(ip)
        raise Unauthorized("Wrong password", code="wrong_password")
    auth.mark_reauthenticated(session)
    await db.commit()
    return MeOut(username=get_settings().admin_username, session_id=session.id, recent_auth=True)


@router.get("/sessions", response_model=list[SessionOut])
async def sessions(session: CurrentSession, db: Db) -> list[SessionOut]:
    rows = await auth.list_sessions(db)
    return [
        SessionOut(
            id=r.id,
            created_at=r.created_at,
            last_seen_at=r.last_seen_at,
            ip=r.ip,
            user_agent=r.user_agent,
            current=r.id == session.id,
        )
        for r in rows
    ]


@router.delete("/sessions/{session_id}", status_code=204)
async def revoke(session_id: uuid.UUID, session: CurrentSession, db: Db) -> None:
    rows = await auth.list_sessions(db)
    if not any(r.id == session_id for r in rows):
        raise NotFound("Session not found")
    await auth.revoke_session(db, session_id)
    audit.record(db, "auth.session_revoked", target_type="session", target_id=session_id)
    await db.commit()
