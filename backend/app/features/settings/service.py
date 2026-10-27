from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.settings.models import AppSetting
from app.features.settings.sections import SECTIONS, GeneralSettings


async def get_section[M: BaseModel](db: AsyncSession, model: type[M], name: str) -> M:
    """Stored values merged over defaults; unknown/old keys are ignored."""
    row = await db.get(AppSetting, name)
    stored = row.value if row else {}
    known = {k: v for k, v in stored.items() if k in model.model_fields}
    try:
        return model.model_validate(known)
    except ValueError:
        # A stored value became invalid (e.g. after an upgrade): fall back to defaults.
        return model()


async def get_all(db: AsyncSession) -> dict[str, BaseModel]:
    rows = {r.section: r.value for r in await db.scalars(select(AppSetting))}
    result: dict[str, BaseModel] = {}
    for name, spec in SECTIONS.items():
        stored = rows.get(name, {})
        known = {k: v for k, v in stored.items() if k in spec.model.model_fields}
        try:
            result[name] = spec.model.model_validate(known)
        except ValueError:
            result[name] = spec.model()
    return result


async def put_section(db: AsyncSession, name: str, value: BaseModel) -> None:
    row = await db.get(AppSetting, name)
    data = value.model_dump(mode="json")
    if row is None:
        db.add(AppSetting(section=name, value=data))
    else:
        row.value = data
    await db.flush()


async def user_timezone(db: AsyncSession) -> str:
    """The time zone from Settings > General (UTC when it is not a valid one)."""
    general = await get_section(db, GeneralSettings, "general")
    try:
        ZoneInfo(general.timezone)
        return general.timezone
    except (ZoneInfoNotFoundError, ValueError):
        return "UTC"
