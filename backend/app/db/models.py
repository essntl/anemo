"""Imports every ORM model so Base.metadata is complete (used by Alembic).

When adding a feature with tables, import its models module here.
"""

from app.db.base import Base
from app.features.audit import models as audit_models
from app.features.auth import models as auth_models
from app.features.conversations import models as conversations_models
from app.features.providers import models as providers_models
from app.features.runs import models as runs_models
from app.features.secrets import models as secrets_models
from app.features.settings import models as settings_models
from app.features.usage import models as usage_models
from app.jobs import models as jobs_models

__all__ = [
    "Base",
    "audit_models",
    "auth_models",
    "conversations_models",
    "jobs_models",
    "providers_models",
    "runs_models",
    "secrets_models",
    "settings_models",
    "usage_models",
]
