"""Settings API: GET /settings returns every section; PUT /settings/{section} replaces one.

One PUT route is generated per section so the OpenAPI schema (and therefore the
generated frontend types) is precise for each section.
"""

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, create_model

from app.api.deps import CurrentSession, Db, client_ip, require_recent_auth
from app.features.audit import service as audit
from app.features.settings import service
from app.features.settings.sections import SECTIONS, SectionSpec

router = APIRouter(prefix="/settings", tags=["settings"])

AllSettings = create_model(  # type: ignore[call-overload]
    "AllSettings", **{name: (spec.model, ...) for name, spec in SECTIONS.items()}
)


@router.get("", response_model=AllSettings)
async def get_settings_all(_: CurrentSession, db: Db) -> Any:
    return AllSettings(**await service.get_all(db))


def _make_put(name: str, spec: SectionSpec) -> Callable[..., Awaitable[BaseModel]]:
    model = spec.model

    async def put(body: model, request: Request, session: CurrentSession, db: Db) -> BaseModel:  # type: ignore[valid-type]
        value: BaseModel = body
        if spec.sensitive:
            await require_recent_auth(session)  # raises reauth_required
        await service.put_section(db, name, value)
        if spec.sensitive:
            audit.record(
                db,
                "settings.update",
                target_type="settings",
                target_id=name,
                ip=client_ip(request),
                details={"value": value.model_dump(mode="json")},
            )
        await db.commit()
        return value

    put.__name__ = f"put_{name}_settings"
    return put


for _name, _spec in SECTIONS.items():
    router.add_api_route(
        f"/{_name}",
        _make_put(_name, _spec),
        methods=["PUT"],
        response_model=_spec.model,
        name=f"put_{_name}_settings",
    )
