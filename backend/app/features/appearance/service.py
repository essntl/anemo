"""Uploads of Settings > Appearance and Profile: store, list, serve and delete them, and
keep the settings that point at them right.

Files go to DATA_PATH/appearance/<asset id>/: `file.<ext>` (what is served), plus
`poster.webp` for an animated picture and `64.webp`/`128.webp` for an avatar (`file.webp`
is its 256 px copy). The checks of the content are in files.py.
"""

import asyncio
import logging
import shutil
import uuid
from pathlib import Path
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError, NotFound
from app.core.ids import uuid7
from app.features.appearance import files
from app.features.appearance.models import AppearanceAsset
from app.features.settings import service as settings_service
from app.features.settings.sections import AppearanceSettings, ProfileSettings

log = logging.getLogger(__name__)

UploadKind = Literal["background", "font"]
MAX_ASSETS = 60  # enough for anyone's experiments; keeps the data folder from filling up


def _root() -> Path:
    return Path(get_settings().data_path) / "appearance"


def asset_dir(asset_id: uuid.UUID) -> Path:
    return _root() / str(asset_id)


def _write_files(folder: Path, named: dict[str, bytes]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for name, data in named.items():
        (folder / name).write_bytes(data)


def _remove_files(asset_id: uuid.UUID) -> None:
    shutil.rmtree(asset_dir(asset_id), ignore_errors=True)


async def _create(
    db: AsyncSession, kind: str, filename: str, prepared: files.Prepared
) -> AppearanceAsset:
    """Write the files and add the row. Part of a bigger change: doesn't commit."""
    count = await db.scalar(select(func.count()).select_from(AppearanceAsset))
    if (count or 0) >= MAX_ASSETS:
        raise AppError(
            f"There can be at most {MAX_ASSETS} uploads; delete some first", code="too_many_assets"
        )
    asset = AppearanceAsset(
        id=uuid7(),
        kind=kind,
        media=prepared.media,
        mime=prepared.mime,
        ext=prepared.ext,
        size=len(prepared.data),
        filename=Path(filename or "file").name[:255] or "file",
        has_poster="poster.webp" in prepared.extras,
    )
    named = {f"file.{prepared.ext}": prepared.data, **prepared.extras}
    await asyncio.to_thread(_write_files, asset_dir(asset.id), named)
    db.add(asset)
    await db.flush()
    return asset


def _prepare(kind: UploadKind, data: bytes) -> files.Prepared:
    if kind == "background":
        return files.prepare_background(data)
    return files.prepare_font(data)


async def upload(db: AsyncSession, kind: UploadKind, filename: str, data: bytes) -> AppearanceAsset:
    """Check and store a background or a font. Raises AppError for a file that can't be
    used (its code says why: svg_not_allowed, unsupported_type, file_too_large, ...)."""
    try:
        prepared = await asyncio.to_thread(_prepare, kind, data)
    except files.InvalidFile as exc:
        raise AppError(str(exc), code=exc.code) from exc
    asset = await _create(db, kind, filename, prepared)
    try:
        await db.commit()
    except Exception:
        await asyncio.to_thread(_remove_files, asset.id)
        raise
    log.info("appearance asset stored", extra={"ctx": {"kind": kind, "media": asset.media}})
    return asset


async def list_assets(db: AsyncSession, kind: str | None = None) -> list[AppearanceAsset]:
    query = select(AppearanceAsset).order_by(AppearanceAsset.created_at.desc())
    if kind:
        query = query.where(AppearanceAsset.kind == kind)
    return list(await db.scalars(query))


async def get(db: AsyncSession, asset_id: uuid.UUID) -> AppearanceAsset:
    asset = await db.get(AppearanceAsset, asset_id)
    if asset is None:
        raise NotFound("Upload not found", code="asset_not_found")
    return asset


def content_path(
    asset: AppearanceAsset, *, poster: bool = False, size: int | None = None
) -> tuple[Path, str]:
    """(file, MIME type) to serve: the file itself, an animated picture's still
    (`poster`), or an avatar at one of files.AVATAR_SIZES (`size`)."""
    folder = asset_dir(asset.id)
    if poster:
        if not asset.has_poster:
            raise NotFound("This upload has no still picture", code="asset_not_found")
        return folder / "poster.webp", "image/webp"
    if size is not None and asset.kind == "avatar" and size != files.AVATAR_SIZES[-1]:
        if size not in files.AVATAR_SIZES:
            raise NotFound("No avatar of that size", code="asset_not_found")
        return folder / f"{size}.webp", "image/webp"
    path = folder / f"file.{asset.ext}"
    if not path.is_file():
        raise NotFound("The upload's file is missing", code="asset_not_found")
    return path, asset.mime


async def _forget_in_settings(db: AsyncSession, asset_id: uuid.UUID) -> None:
    """Put the settings that use this upload back to their defaults. Part of a bigger
    change: doesn't commit."""
    look = await settings_service.get_section(db, AppearanceSettings, "appearance")
    changed = False
    if look.background.asset_id == asset_id:
        look.background.asset_id = None
        look.background.kind = "none"
        changed = True
    if look.ui_font == f"custom:{asset_id}":
        look.ui_font = "default"
        changed = True
    if look.code_font == f"custom:{asset_id}":
        look.code_font = "default"
        changed = True
    if changed:
        await settings_service.put_section(db, "appearance", look)
    profile = await settings_service.get_section(db, ProfileSettings, "profile")
    if profile.avatar_id == asset_id:
        profile.avatar_id = None
        await settings_service.put_section(db, "profile", profile)


async def delete(db: AsyncSession, asset_id: uuid.UUID) -> None:
    asset = await get(db, asset_id)
    await _forget_in_settings(db, asset.id)
    await db.delete(asset)
    await db.commit()
    await asyncio.to_thread(_remove_files, asset_id)


async def set_avatar(
    db: AsyncSession, filename: str, data: bytes, crop: files.Crop
) -> ProfileSettings:
    """Make the cropped picture the avatar; the previous avatar is deleted."""
    try:
        prepared = await asyncio.to_thread(files.prepare_avatar, data, crop)
    except files.InvalidFile as exc:
        raise AppError(str(exc), code=exc.code) from exc
    old = await list_assets(db, "avatar")
    for asset in old:
        await db.delete(asset)
    await db.flush()
    asset = await _create(db, "avatar", filename, prepared)
    profile = await settings_service.get_section(db, ProfileSettings, "profile")
    profile.avatar_id = asset.id
    await settings_service.put_section(db, "profile", profile)
    try:
        await db.commit()
    except Exception:
        await asyncio.to_thread(_remove_files, asset.id)
        raise
    for previous in old:
        await asyncio.to_thread(_remove_files, previous.id)
    return profile


async def remove_avatar(db: AsyncSession) -> ProfileSettings:
    old = await list_assets(db, "avatar")
    for asset in old:
        await db.delete(asset)
    profile = await settings_service.get_section(db, ProfileSettings, "profile")
    profile.avatar_id = None
    await settings_service.put_section(db, "profile", profile)
    await db.commit()
    for previous in old:
        await asyncio.to_thread(_remove_files, previous.id)
    return profile
