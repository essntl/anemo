"""Uploads for Settings > Appearance (backgrounds, fonts) and Profile (the avatar).

The settings themselves are the `appearance` and `profile` sections of /settings; these
routes only handle the files they point at.
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Form, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.api.deps import Db
from app.core.errors import AppError
from app.features.appearance import files, service
from app.features.appearance.models import AppearanceAsset
from app.features.settings.sections import ProfileSettings

router = APIRouter(prefix="/appearance", tags=["appearance"])

# An id's bytes never change (a new upload is a new id), so browsers may keep them.
_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Cache-Control": "private, max-age=31536000, immutable",
}


class AppearanceAssetOut(BaseModel):
    id: uuid.UUID
    kind: Literal["background", "font", "avatar"]
    media: Literal["image", "animated", "video", "font"]
    mime: str
    size: int
    filename: str
    url: str
    # A still of an animated picture (shown for reduced motion and on phones).
    poster_url: str | None
    created_at: datetime


def _out(asset: AppearanceAsset) -> AppearanceAssetOut:
    url = f"/api/appearance/assets/{asset.id}/content"
    return AppearanceAssetOut(
        id=asset.id,
        kind=asset.kind,  # type: ignore[arg-type]
        media=asset.media,  # type: ignore[arg-type]
        mime=asset.mime,
        size=asset.size,
        filename=asset.filename,
        url=url,
        poster_url=f"{url}?variant=poster" if asset.has_poster else None,
        created_at=asset.created_at,
    )


async def _read(file: UploadFile, cap: int) -> bytes:
    data = await file.read(cap + 1)
    if len(data) > cap:
        raise AppError(f"Files can be at most {cap // files.MB} MB", code="file_too_large")
    return data


@router.get("/assets", response_model=list[AppearanceAssetOut])
async def list_assets(
    db: Db, kind: Literal["background", "font", "avatar"] | None = None
) -> list[AppearanceAssetOut]:
    return [_out(a) for a in await service.list_assets(db, kind)]


@router.post("/assets", response_model=AppearanceAssetOut, status_code=201)
async def upload_asset(
    file: UploadFile, kind: Annotated[Literal["background", "font"], Form()], db: Db
) -> AppearanceAssetOut:
    data = await _read(file, files.MAX_UPLOAD_BYTES)
    return _out(await service.upload(db, kind, file.filename or "file", data))


@router.get("/assets/{asset_id}/content", response_class=FileResponse)
async def asset_content(
    asset_id: uuid.UUID,
    db: Db,
    variant: Literal["poster"] | None = None,
    size: int | None = Query(None, description="An avatar's size in px: 64, 128 or 256"),
) -> FileResponse:
    asset = await service.get(db, asset_id)
    path, mime = service.content_path(asset, poster=variant == "poster", size=size)
    return FileResponse(
        path,
        media_type=mime,
        # Our own name, so nothing from the upload ends up in a header.
        filename=f"{asset.kind}-{asset.id}.{path.suffix.lstrip('.')}",
        content_disposition_type="inline",
        headers=_HEADERS,
    )


@router.delete("/assets/{asset_id}", status_code=204)
async def delete_asset(asset_id: uuid.UUID, db: Db) -> None:
    await service.delete(db, asset_id)


@router.put("/avatar", response_model=ProfileSettings)
async def set_avatar(
    file: UploadFile,
    db: Db,
    crop_x: Annotated[float, Form(ge=0, le=1)] = 0.0,
    crop_y: Annotated[float, Form(ge=0, le=1)] = 0.0,
    crop_size: Annotated[float, Form(gt=0, le=1)] = 1.0,
) -> ProfileSettings:
    """Replace the avatar with the square (crop_x, crop_y, crop_size: fractions of the
    picture's width, height and shorter side) of the uploaded picture."""
    data = await _read(file, files.MAX_AVATAR_BYTES)
    crop = files.Crop(crop_x, crop_y, crop_size)
    return await service.set_avatar(db, file.filename or "avatar", data, crop)


@router.delete("/avatar", response_model=ProfileSettings)
async def remove_avatar(db: Db) -> ProfileSettings:
    return await service.remove_avatar(db)
