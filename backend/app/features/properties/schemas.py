import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.features.properties.service import KEY_PATTERN, PropertyType

AppliesTo = Literal["document", "task", "event"]


def _all_types() -> list[AppliesTo]:
    return ["document", "task", "event"]


class OptionOut(BaseModel):
    id: uuid.UUID
    slug: str
    label: str
    hub_document_id: uuid.UUID | None
    sort_order: int
    count: int  # documents (later also tasks and events) with this value


class DefinitionOut(BaseModel):
    id: uuid.UUID
    key: str
    label: str
    type: PropertyType
    applies_to: list[AppliesTo]
    project_ids: list[uuid.UUID] | None  # None: everywhere
    open_vocabulary: bool
    builtin: bool
    sort_order: int
    options: list[OptionOut]
    count: int  # items with any value


class DefinitionIn(BaseModel):
    key: str = Field(pattern=KEY_PATTERN, max_length=60)
    label: str = Field("", max_length=120)
    type: PropertyType
    applies_to: list[AppliesTo] = Field(default_factory=_all_types, min_length=1, max_length=3)
    project_ids: list[uuid.UUID] | None = Field(None, max_length=50)
    options: list[str] = Field(default_factory=list, max_length=200)  # labels of first values


class DefinitionPatch(BaseModel):
    """Only the fields that are sent change; `project_ids: null` makes it global."""

    label: str | None = Field(None, max_length=120)
    applies_to: list[AppliesTo] | None = Field(None, min_length=1, max_length=3)
    project_ids: list[uuid.UUID] | None = Field(None, max_length=50)
    sort_order: int | None = Field(None, ge=0, le=10_000)


class OptionIn(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    slug: str | None = Field(None, max_length=80)  # made from the label when not given


class OptionPatch(BaseModel):
    """Only the fields that are sent change; `hub_document_id: null` removes the hub."""

    label: str | None = Field(None, min_length=1, max_length=120)
    hub_document_id: uuid.UUID | None = None
    sort_order: int | None = Field(None, ge=0, le=10_000)


class RenameIn(BaseModel):
    slug: str = Field(min_length=1, max_length=80)


class MergeIn(BaseModel):
    into_option_id: uuid.UUID


class RewriteOut(BaseModel):
    documents: int  # how many documents were rewritten (one revision each)


class ValidateIn(BaseModel):
    object_type: AppliesTo = "document"
    project_id: uuid.UUID | None = None
    values: dict[str, Any] = Field(max_length=50)


class ValidateOut(BaseModel):
    values: dict[str, Any]  # normalised: slugs, YYYY-MM-DD, numbers, booleans; None removes


class ReindexOut(BaseModel):
    documents: int  # documents whose index was rebuilt


class SuggestionOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    title: str
    path: str
    current: dict[str, Any]  # the document's properties now
    suggested: dict[str, Any]  # what applying sets (None removes)
    actor_ref: str  # who suggested it (chat:<id>, automation:<id>/<run>)


class SuggestionIds(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)


class AppliedOut(BaseModel):
    applied: int
    problems: list[str]  # suggestions that no longer fit, kept for another look
