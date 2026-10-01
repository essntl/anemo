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
from app.features.automations.router import router as automations_router
from app.features.browser_router import router as browser_router
from app.features.calendar.router import router as calendar_router
from app.features.conversations.router import router as conversations_router
from app.features.documents.router import router as documents_router
from app.features.files.router import router as files_router
from app.features.mcp.router import router as mcp_router
from app.features.memory.router import router as memory_router
from app.features.notifications.router import router as notifications_router
from app.features.permissions_router import router as permissions_router
from app.features.profiles.router import router as profiles_router
from app.features.providers.router import router as providers_router
from app.features.runs.agent_router import router as agent_router
from app.features.runs.router import router as runs_router
from app.features.settings.router import router as settings_router
from app.features.shell.router import router as shell_router
from app.features.skills.router import router as skills_router
from app.features.tasks.router import router as tasks_router
from app.web.router import router as web_router

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
protected.include_router(web_router)
protected.include_router(memory_router)
protected.include_router(documents_router)
protected.include_router(tasks_router)
protected.include_router(calendar_router)
protected.include_router(notifications_router)
protected.include_router(automations_router)
protected.include_router(mcp_router)
protected.include_router(browser_router)
api_router.include_router(protected)
