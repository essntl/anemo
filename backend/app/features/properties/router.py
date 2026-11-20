"""Property definitions and their values (Settings > Properties)."""

import uuid

from fastapi import APIRouter

from app.api.deps import Db
from app.features.documents import properties as doc_properties
from app.features.documents.models import Document
from app.features.properties import service
from app.features.properties.models import PropertyOption
from app.features.properties.schemas import (
    AppliedOut,
    DefinitionIn,
    DefinitionOut,
    DefinitionPatch,
    MergeIn,
    OptionIn,
    OptionOut,
    OptionPatch,
    ReindexOut,
    RenameIn,
    RewriteOut,
    SuggestionIds,
    SuggestionOut,
    ValidateIn,
    ValidateOut,
)

router = APIRouter(prefix="/properties", tags=["properties"])


def _option_out(o: PropertyOption, counts: dict[str, int]) -> OptionOut:
    return OptionOut(
        id=o.id,
        slug=o.slug,
        label=o.label,
        hub_document_id=o.hub_document_id,
        sort_order=o.sort_order,
        count=counts.get(o.slug, 0),
    )


def _out(prop: service.Prop, counts: dict[str, int], items: int) -> DefinitionOut:
    d = prop.definition
    return DefinitionOut(
        id=d.id,
        key=d.key,
        label=d.label,
        type=d.type,  # type: ignore[arg-type]
        applies_to=d.applies_to,  # type: ignore[arg-type]
        project_ids=[uuid.UUID(p) for p in d.project_ids] if d.project_ids is not None else None,
        open_vocabulary=d.open_vocabulary,
        builtin=d.builtin,
        sort_order=d.sort_order,
        options=[_option_out(o, counts) for o in prop.options],
        count=items,
    )


async def _all(db: Db) -> list[DefinitionOut]:
    props = await service.load(db)
    counts = await service.value_counts(db, Document.properties)
    items = await service.key_counts(db, Document.properties)
    out = [_out(p, dict(counts.get(key, {})), items.get(key, 0)) for key, p in props.items()]
    await db.commit()  # the built-in definitions, on first use
    return out


async def _one(db: Db, definition_id: uuid.UUID) -> DefinitionOut:
    return next(d for d in await _all(db) if d.id == definition_id)


@router.get("", response_model=list[DefinitionOut])
async def list_properties(db: Db) -> list[DefinitionOut]:
    """Every property with its values and how many documents use each."""
    return await _all(db)


@router.post("", response_model=DefinitionOut, status_code=201)
async def create_property(body: DefinitionIn, db: Db) -> DefinitionOut:
    definition = await service.create_definition(
        db,
        key=body.key,
        label=body.label,
        type=body.type,
        applies_to=list(body.applies_to),
        project_ids=body.project_ids,
        options=body.options,
    )
    return await _one(db, definition.id)


@router.patch("/{definition_id}", response_model=DefinitionOut)
async def update_property(definition_id: uuid.UUID, body: DefinitionPatch, db: Db) -> DefinitionOut:
    definition = await service.get_definition(db, definition_id)
    await service.update_definition(
        db,
        definition,
        label=body.label,
        applies_to=list(body.applies_to) if body.applies_to is not None else None,
        project_ids=body.project_ids if "project_ids" in body.model_fields_set else "keep",
        sort_order=body.sort_order,
    )
    if body.model_fields_set & {"label", "applies_to", "project_ids"}:
        await doc_properties.redefined(db, definition)  # search and chunks name it
    return await _one(db, definition_id)


@router.delete("/{definition_id}", status_code=204)
async def delete_property(definition_id: uuid.UUID, db: Db) -> None:
    """Files keep what they say about it; it is no longer indexed or offered."""
    await service.delete_definition(db, await service.get_definition(db, definition_id))


@router.post("/{definition_id}/options", response_model=OptionOut, status_code=201)
async def add_option(definition_id: uuid.UUID, body: OptionIn, db: Db) -> OptionOut:
    definition = await service.get_definition(db, definition_id)
    option = await service.add_option(db, definition, body.label, body.slug)
    return _option_out(option, {})


@router.patch("/{definition_id}/options/{option_id}", response_model=OptionOut)
async def update_option(
    definition_id: uuid.UUID, option_id: uuid.UUID, body: OptionPatch, db: Db
) -> OptionOut:
    """A new label touches no files (the index and search follow); the hub document is
    the value's own page."""
    definition = await service.get_definition(db, definition_id)
    option = await service.get_option(db, definition, option_id)
    relabelled = body.label is not None and body.label.strip() != option.label
    await service.update_option(
        db,
        option,
        label=body.label,
        hub_document_id=(
            body.hub_document_id if "hub_document_id" in body.model_fields_set else "keep"
        ),
        sort_order=body.sort_order,
    )
    if relabelled:
        await doc_properties.relabel(db, option)
    count = await doc_properties.option_in_use(db, definition, option.slug)
    return _option_out(option, {option.slug: count})


@router.delete("/{definition_id}/options/{option_id}", status_code=204)
async def delete_option(definition_id: uuid.UUID, option_id: uuid.UUID, db: Db) -> None:
    """Only a value nothing uses; merge it into another to replace it everywhere."""
    definition = await service.get_definition(db, definition_id)
    await doc_properties.delete_option(
        db, definition, await service.get_option(db, definition, option_id)
    )


@router.post("/{definition_id}/options/{option_id}/rename", response_model=RewriteOut)
async def rename_option(
    definition_id: uuid.UUID, option_id: uuid.UUID, body: RenameIn, db: Db
) -> RewriteOut:
    """Give a value a new slug: every document with it is rewritten (a revision each)."""
    definition = await service.get_definition(db, definition_id)
    option = await service.get_option(db, definition, option_id)
    return _rewritten(await doc_properties.rename_value(db, definition, option, body.slug))


@router.post("/{definition_id}/options/{option_id}/merge", response_model=RewriteOut)
async def merge_option(
    definition_id: uuid.UUID, option_id: uuid.UUID, body: MergeIn, db: Db
) -> RewriteOut:
    """Replace this value by another everywhere (a revision each) and remove it."""
    definition = await service.get_definition(db, definition_id)
    option = await service.get_option(db, definition, option_id)
    into = await service.get_option(db, definition, body.into_option_id)
    return _rewritten(await doc_properties.merge_values(db, definition, option, into))


def _rewritten(r: doc_properties.Rewritten) -> RewriteOut:
    return RewriteOut(
        documents=r.documents, views=r.views, folder_defaults=r.folder_defaults, failed=r.failed
    )


@router.post("/validate", response_model=ValidateOut)
async def validate(body: ValidateIn, db: Db) -> ValidateOut:
    """Check values without saving anything (the UI asks before adding a tag). Errors
    come back as 400 property_invalid with the closest existing values."""
    values = await service.validate(db, body.object_type, body.project_id, body.values)
    await db.rollback()  # a new tag is only made when it is used
    return ValidateOut(values=values)


@router.post("/reindex", response_model=ReindexOut)
async def reindex(db: Db) -> ReindexOut:
    """Re-read every document whose index is out of date (changed outside Anemo)."""
    return ReindexOut(documents=await doc_properties.reindex_stale(db))


@router.get("/suggestions", response_model=list[SuggestionOut])
async def list_suggestions(db: Db) -> list[SuggestionOut]:
    """Properties the assistant suggested for documents, waiting to be applied or dismissed."""
    return [
        SuggestionOut(
            id=s.id,
            document_id=d.id,
            title=d.title,
            path=d.path,
            current=d.properties or {},
            suggested=s.properties,
            actor_ref=s.actor_ref,
        )
        for s, d in await doc_properties.suggestions(db)
    ]


@router.post("/suggestions/apply", response_model=AppliedOut)
async def apply_suggestions(body: SuggestionIds, db: Db) -> AppliedOut:
    """Write the chosen suggestions into their documents (a revision each)."""
    applied, problems = await doc_properties.apply_suggestions(db, body.ids)
    return AppliedOut(applied=applied, problems=problems)


@router.post("/suggestions/dismiss", status_code=204)
async def dismiss_suggestions(body: SuggestionIds, db: Db) -> None:
    await doc_properties.dismiss_suggestions(db, body.ids)
