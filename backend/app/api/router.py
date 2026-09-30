"""Aggregates every feature router under /api.

Routers in `protected` require a logged-in session for every endpoint.
Only health checks and the login flow are reachable without one.
"""

from fastapi import APIRouter, Depends

from app.api import health
from app.api.deps import require_session
from app.features.audit.router import router as audit_router
from app.features.auth.router import router as auth_router
from app.features.conversations.router import router as conversations_router
from app.features.providers.router import router as providers_router
from app.features.runs.router import router as runs_router
from app.features.settings.router import router as settings_router

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(auth_router)  # endpoints declare their own session requirement

protected = APIRouter(dependencies=[Depends(require_session)])
protected.include_router(settings_router)
protected.include_router(audit_router)
protected.include_router(providers_router)
protected.include_router(conversations_router)
protected.include_router(runs_router)
api_router.include_router(protected)
