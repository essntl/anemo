"""Imports every ORM model so Base.metadata is complete (used by Alembic).

When adding a feature with tables, import its models module here.
"""

from app.db.base import Base
from app.features.attachments import models as attachments_models
from app.features.audit import models as audit_models
from app.features.auth import models as auth_models
from app.features.automations import models as automations_models
from app.features.calendar import models as calendar_models
from app.features.conversations import models as conversations_models
from app.features.documents import models as documents_models
from app.features.mcp import models as mcp_models
from app.features.memory import models as memory_models
from app.features.notifications import models as notifications_models
from app.features.profiles import models as profiles_models
from app.features.providers import models as providers_models
from app.features.runs import models as runs_models
from app.features.secrets import models as secrets_models
from app.features.settings import models as settings_models
from app.features.skills import models as skills_models
from app.features.tasks import models as tasks_models
from app.features.usage import models as usage_models
from app.jobs import models as jobs_models
from app.knowledge import models as knowledge_models

__all__ = [
    "Base",
    "attachments_models",
    "audit_models",
    "auth_models",
    "automations_models",
    "calendar_models",
    "conversations_models",
    "documents_models",
    "jobs_models",
    "knowledge_models",
    "mcp_models",
    "memory_models",
    "notifications_models",
    "profiles_models",
    "providers_models",
    "runs_models",
    "secrets_models",
    "settings_models",
    "skills_models",
    "tasks_models",
    "usage_models",
]
