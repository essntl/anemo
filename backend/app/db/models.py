"""Imports every ORM model so Base.metadata is complete (used by Alembic).

When adding a feature with tables, import its models module here.
"""

from app.db.base import Base
from app.features.activity import models as activity_models
from app.features.appearance import models as appearance_models
from app.features.attachments import models as attachments_models
from app.features.audit import models as audit_models
from app.features.auth import models as auth_models
from app.features.automations import models as automations_models
from app.features.calendar import models as calendar_models
from app.features.code_sessions import models as code_sessions_models
from app.features.conversations import models as conversations_models
from app.features.devices import models as devices_models
from app.features.documents import models as documents_models
from app.features.focus import models as focus_models
from app.features.links import models as links_models
from app.features.mcp import models as mcp_models
from app.features.memory import models as memory_models
from app.features.music import models as music_models
from app.features.notifications import models as notifications_models
from app.features.plugins import models as plugins_models
from app.features.profiles import models as profiles_models
from app.features.properties import models as properties_models
from app.features.providers import models as providers_models
from app.features.research import models as research_models
from app.features.runs import models as runs_models
from app.features.secrets import models as secrets_models
from app.features.settings import models as settings_models
from app.features.shares import models as shares_models
from app.features.skills import models as skills_models
from app.features.tasks import models as tasks_models
from app.features.trash import models as trash_models
from app.features.triggers import models as triggers_models
from app.features.usage import models as usage_models
from app.features.views import models as views_models
from app.jobs import models as jobs_models
from app.knowledge import models as knowledge_models

__all__ = [
    "Base",
    "activity_models",
    "appearance_models",
    "attachments_models",
    "audit_models",
    "auth_models",
    "automations_models",
    "calendar_models",
    "code_sessions_models",
    "conversations_models",
    "devices_models",
    "documents_models",
    "focus_models",
    "jobs_models",
    "knowledge_models",
    "links_models",
    "mcp_models",
    "memory_models",
    "music_models",
    "notifications_models",
    "plugins_models",
    "profiles_models",
    "properties_models",
    "providers_models",
    "research_models",
    "runs_models",
    "secrets_models",
    "settings_models",
    "shares_models",
    "skills_models",
    "tasks_models",
    "trash_models",
    "triggers_models",
    "usage_models",
    "views_models",
]
