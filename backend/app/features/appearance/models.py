from sqlalchemy import BigInteger, Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class AppearanceAsset(Base, IdMixin, TimestampMixin):
    """A file uploaded in Settings > Appearance or Profile: a background, a font or the
    avatar. The bytes live under DATA_PATH/appearance/<id>/ (service.asset_dir); they
    never change, so a new upload is a new row."""

    __tablename__ = "appearance_assets"

    # background | font | avatar
    kind: Mapped[str] = mapped_column(String(20), index=True)
    # image | animated | video | font (files.Media)
    media: Mapped[str] = mapped_column(String(20))
    # Set by us from the recognised content, never from the upload's declared type.
    mime: Mapped[str] = mapped_column(String(60))
    ext: Mapped[str] = mapped_column(String(10))
    size: Mapped[int] = mapped_column(BigInteger)
    # The name it was uploaded with, to tell uploads apart in a list.
    filename: Mapped[str] = mapped_column(String(255))
    # An animated picture's first frame, saved as poster.webp.
    has_poster: Mapped[bool] = mapped_column(Boolean, default=False)
