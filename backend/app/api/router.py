"""Aggregates every feature router under /api.

Routers in `protected` require a logged-in session for every endpoint.
Only health checks and the login flow are reachable without one.
"""

from fastapi import APIRouter, Depends

from app.api import health
from app.api.deps import require_session
from app.features.attachments.router import router as attachments_router
from app.features.audit.router import router as audit_router
from app.features.auth.router import router as auth_router
from app.features.conversations.router import router as conversations_router
from app.features.files.router import router as files_router
from app.features.permissions_router import router as permissions_router
from app.features.profiles.router import router as profiles_router
from app.features.providers.router import router as providers_router
from app.features.runs.agent_router import router as agent_router
from app.features.runs.router import router as runs_router
from app.features.settings.router import router as settings_router
from app.features.shell.router import router as shell_router
from app.features.skills.router import router as skills_router

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(auth_router)  # endpoints declare their own session requirement

protected = APIRouter(dependencies=[Depends(require_session)])
protected.include_router(settings_router)
protected.include_router(audit_router)
protected.include_router(providers_router)
protected.include_router(conversations_router)
protected.include_router(runs_router)
protected.include_router(attachments_router)
protected.include_router(agent_router)
protected.include_router(permissions_router)
protected.include_router(files_router)
protected.include_router(shell_router)
protected.include_router(profiles_router)
protected.include_router(skills_router)
api_router.include_router(protected)
