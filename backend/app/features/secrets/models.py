from datetime import datetime

from sqlalchemy import DateTime, LargeBinary, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin


class Secret(Base, IdMixin):
    """An encrypted credential, referenced by id. Plaintext never leaves the backend."""

    __tablename__ = "secrets"

    kind: Mapped[str] = mapped_column(String(40))  # e.g. "provider_api_key", "webhook_url"
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary)
    last4: Mapped[str] = mapped_column(String(4))  # shown masked in the UI: ••••abcd
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    rotated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
