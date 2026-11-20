"""Properties: typed, defined metadata on documents (and, later, tasks and events).

Properties are defined, not invented. A definition (Settings > Properties) names a
key, its type, the object types and projects it is for, and for select types the
allowed values: each with a stable slug (what files and rows store) and a label (what
the UI shows). `validate()` is the one place where values are checked and normalised;
everything that sets properties goes through it. The near-duplicate check is here too.

Built-in, global definitions (`type`, `status`, `tags`) are created on first use.
`tags` has an open vocabulary: new tags need no approval, but a tag that is nearly
one that exists ("Website" next to "website", "legl" next to "legal") is refused and
the existing one suggested. Every other select property has a closed list.
"""

import difflib
import re
import unicodedata
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

from sqlalchemy import ColumnElement, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.core.errors import AppError, Conflict, NotFound
from app.core.ids import uuid7
from app.core.refs import ObjectType
from app.features.properties.models import PropertyDefinition, PropertyOption
from app.features.tasks.models import Project

PropertyType = Literal["select", "multi_select", "text", "date", "number", "checkbox"]
PROPERTY_TYPES: tuple[PropertyType, ...] = (
    "select",
    "multi_select",
    "text",
    "date",
    "number",
    "checkbox",
)
SELECT_TYPES = ("select", "multi_select")
# The object types properties apply to (chats have none).
APPLIES_TO: tuple[ObjectType, ...] = ("document", "task", "event")

MAX_TEXT = 2000
# Near-duplicates: two values whose normal forms are this similar (difflib ratio), or
# where one is the first words of the other ("ludmyla" / "ludmyla-doula").
NEAR_RATIO = 0.8
NEAR_MIN_CHARS = 4  # shorter values are only compared exactly ("ui" / "ux" are fine)

KEY_PATTERN = r"^[a-z][a-z0-9_-]{0,59}$"
RESERVED_KEYS = frozenset({"title"})  # front matter keys with another meaning


@dataclass(frozen=True)
class Builtin:
    key: str
    label: str
    type: PropertyType
    options: tuple[tuple[str, str], ...] = ()
    open_vocabulary: bool = False


BUILTINS: tuple[Builtin, ...] = (
    Builtin(
        "type",
        "Type",
        "select",
        (
            ("note", "Note"),
            ("plan", "Plan"),
            ("brief", "Brief"),
            ("spec", "Spec"),
            ("prompt", "Prompt"),
            ("meeting-notes", "Meeting notes"),
            ("reference", "Reference"),
            ("ledger", "Ledger"),
            ("daily", "Daily"),
        ),
    ),
    Builtin(
        "status",
        "Status",
        "select",
        (("draft", "Draft"), ("active", "Active"), ("archived", "Archived")),
    ),
    Builtin("tags", "Tags", "multi_select", open_vocabulary=True),
)
ARCHIVED = ("status", "archived")  # excluded from searches unless asked for


# -- values ------------------------------------------------------------------------------


def normalise(value: str) -> str:
    """A value's normal form: lower case, words joined by hyphens, letters of any
    script kept ("Ludmyla Doula" -> "ludmyla-doula", "Юридичне" -> "юридичне").
    Near-duplicates are compared in this form, and a new value gets it as its slug."""
    text = unicodedata.normalize("NFC", value).strip().lower()
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"[^\w-]+", "", text)
    return re.sub(r"-{2,}", "-", text).strip("-")[:80]


def is_near(a: str, b: str) -> bool:
    """Whether two normal forms name nearly the same thing (not when they are equal)."""
    if a == b:
        return False
    if min(len(a), len(b)) < NEAR_MIN_CHARS:
        return False
    if difflib.SequenceMatcher(None, a, b).ratio() >= NEAR_RATIO:
        return True
    wa, wb = a.split("-"), b.split("-")
    shorter, longer = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
    return longer[: len(shorter)] == shorter


@dataclass
class Prop:
    """A definition with its options, as used for validation and display."""

    definition: PropertyDefinition
    options: list[PropertyOption] = field(default_factory=list)

    @property
    def key(self) -> str:
        return self.definition.key

    @property
    def type(self) -> str:
        return self.definition.type

    def option(self, value: str) -> PropertyOption | None:
        """The option `value` names: its slug, or (in any case) its slug or label."""
        for o in self.options:
            if o.slug == value:
                return o
        folded = value.strip().casefold()
        for o in self.options:
            if folded in (o.slug.casefold(), o.label.strip().casefold()):
                return o
        return None

    def near(self, value: str) -> list[PropertyOption]:
        n = normalise(value)
        return [
            o
            for o in self.options
            if n
            and (
                n in (o.slug, normalise(o.label))
                or is_near(n, o.slug)
                or is_near(n, normalise(o.label))
            )
        ]

    def closest(self, value: str, n: int = 5) -> list[str]:
        """Existing slugs that look like `value`, best first."""
        near = [o.slug for o in self.near(value)]
        by_spelling = difflib.get_close_matches(
            normalise(value), [o.slug for o in self.options], n=n, cutoff=0.4
        )
        return list(dict.fromkeys([*near, *by_spelling]))[:n]

    def label_of(self, slug: str) -> str:
        option = next((o for o in self.options if o.slug == slug), None)
        return option.label if option else slug


async def ensure_builtins(db: AsyncSession) -> None:
    """Create the built-in definitions that are missing (first run). Doesn't commit:
    it is part of whatever the caller does, and safe to repeat."""
    have = set(await db.scalars(select(PropertyDefinition.key).where(PropertyDefinition.builtin)))
    for order, b in enumerate(BUILTINS):
        if b.key in have:
            continue
        definition_id = await db.scalar(
            insert(PropertyDefinition)
            .values(
                id=uuid7(),
                key=b.key,
                label=b.label,
                type=b.type,
                applies_to=list(APPLIES_TO),
                project_ids=None,
                open_vocabulary=b.open_vocabulary,
                builtin=True,
                sort_order=order,
            )
            .on_conflict_do_nothing(index_elements=["key"])
            .returning(PropertyDefinition.id)
        )
        if definition_id is None:
            continue  # someone made it meanwhile (or a user definition has the key)
        for i, (slug, label) in enumerate(b.options):
            db.add(
                PropertyOption(definition_id=definition_id, slug=slug, label=label, sort_order=i)
            )
    await db.flush()


async def load(db: AsyncSession) -> dict[str, Prop]:
    """Every definition with its options, by key."""
    await ensure_builtins(db)
    definitions = list(
        await db.scalars(
            select(PropertyDefinition).order_by(
                PropertyDefinition.sort_order, PropertyDefinition.key
            )
        )
    )
    props = {d.key: Prop(d) for d in definitions}
    by_id = {d.id: props[d.key] for d in definitions}
    for o in await db.scalars(
        select(PropertyOption).order_by(PropertyOption.sort_order, PropertyOption.label)
    ):
        if o.definition_id in by_id:
            by_id[o.definition_id].options.append(o)
    return props


def in_scope(prop: Prop, object_type: str, project_id: uuid.UUID | None) -> bool:
    d = prop.definition
    if object_type not in d.applies_to:
        return False
    return d.project_ids is None or (project_id is not None and str(project_id) in d.project_ids)


@dataclass
class Problem:
    key: str
    value: Any
    message: str
    suggestions: list[str] = field(default_factory=list)


class _Check:
    """One run of validation: collects problems, creates new values as allowed."""

    def __init__(
        self,
        db: AsyncSession,
        props: dict[str, Prop],
        *,
        create_values: bool,
        from_file: bool,
    ) -> None:
        self.db = db
        self.props = props
        self.create_values = create_values
        self.from_file = from_file
        self.problems: list[Problem] = []

    def fail(
        self, key: str, value: Any, message: str, suggestions: list[str] | None = None
    ) -> None:
        self.problems.append(Problem(key, value, message, suggestions or []))

    async def option(self, prop: Prop, value: Any) -> str | None:
        if not isinstance(value, str) or not value.strip():
            self.fail(prop.key, value, "must be one of its values (a text)", prop.closest(""))
            return None
        found = prop.option(value)
        if found is not None:
            return found.slug
        near = prop.near(value)
        allowed = prop.definition.open_vocabulary or self.create_values
        if near and not self.from_file:
            names = ", ".join(o.slug for o in near)
            self.fail(
                prop.key,
                value,
                f"'{value}' is nearly an existing value: {names}. Use that one",
                [o.slug for o in near],
            )
            return None
        if not allowed:
            self.fail(
                prop.key,
                value,
                f"'{value}' is not one of its values",
                prop.closest(value),
            )
            return None
        slug = normalise(value)
        if not slug:
            self.fail(prop.key, value, "is not a usable value")
            return None
        existing = next((o for o in prop.options if o.slug == slug), None)
        if existing is not None:
            return existing.slug
        option = PropertyOption(
            definition_id=prop.definition.id,
            slug=slug,
            label=value.strip()[:120],
            sort_order=len(prop.options),
        )
        self.db.add(option)
        prop.options.append(option)
        return slug

    async def value(self, prop: Prop, value: Any) -> Any:
        kind = prop.type
        key = prop.key
        if kind == "select":
            return await self.option(prop, value)
        if kind == "multi_select":
            items = value if isinstance(value, list) else [value]
            out: list[str] = []
            for item in items:
                slug = await self.option(prop, item)
                if slug is not None and slug not in out:
                    out.append(slug)
            return out
        if kind == "text":
            if isinstance(value, bool) or not isinstance(value, str | int | float):
                self.fail(key, value, "must be a text")
                return None
            text = str(value).strip()
            if len(text) > MAX_TEXT:
                self.fail(key, value, f"is longer than {MAX_TEXT} characters")
                return None
            return text
        if kind == "number":
            if isinstance(value, bool):
                self.fail(key, value, "must be a number")
                return None
            if isinstance(value, int | float):
                return value
            try:
                number = float(str(value).strip())
            except ValueError:
                self.fail(key, value, "must be a number")
                return None
            return int(number) if number.is_integer() else number
        if kind == "checkbox":
            if isinstance(value, bool):
                return value
            if isinstance(value, str) and value.strip().lower() in ("true", "false", "yes", "no"):
                return value.strip().lower() in ("true", "yes")
            self.fail(key, value, "must be true or false")
            return None
        if kind == "date":
            try:
                return date.fromisoformat(str(value).strip()).isoformat()
            except ValueError:
                self.fail(key, value, "must be a date (YYYY-MM-DD)")
                return None
        self.fail(key, value, f"has an unknown type {kind}")
        return None


async def _project_names(db: AsyncSession, ids: list[str]) -> str:
    uuids = []
    for i in ids:
        try:
            uuids.append(uuid.UUID(i))
        except ValueError:
            continue
    names = (
        list(await db.scalars(select(Project.name).where(Project.id.in_(uuids)))) if uuids else []
    )
    return ", ".join(names) or "other projects"


def _raise(problems: list[Problem]) -> None:
    lines = []
    for p in problems:
        hint = f" (closest: {', '.join(p.suggestions)})" if p.suggestions else ""
        lines.append(f"{p.key}: {p.message}{hint}.")
    raise AppError(
        " ".join(lines),
        code="property_invalid",
        details={
            "errors": [
                {"key": p.key, "value": p.value, "message": p.message, "suggestions": p.suggestions}
                for p in problems
            ]
        },
    )


async def _check(
    db: AsyncSession,
    object_type: str,
    project_id: uuid.UUID | None,
    values: dict[str, Any],
    *,
    create_values: bool,
    from_file: bool,
) -> tuple[dict[str, Any], list[Problem]]:
    props = await load(db)
    check = _Check(db, props, create_values=create_values, from_file=from_file)
    out: dict[str, Any] = {}
    for key, value in values.items():
        prop = props.get(key)
        if prop is None:
            if from_file:
                continue  # other front matter (title, keys of other programs): not ours
            check.fail(
                key,
                value,
                "is not a defined property",
                difflib.get_close_matches(key, list(props), n=3, cutoff=0.5),
            )
            continue
        if object_type not in prop.definition.applies_to:
            check.fail(key, value, f"is not used for {object_type}s")
            continue
        if not in_scope(prop, object_type, project_id):
            names = await _project_names(db, prop.definition.project_ids or [])
            check.fail(key, value, f"is only for the projects {names}")
            continue
        if value is None or value == [] or value == "":
            out[key] = None  # remove it
            continue
        before = len(check.problems)
        normalised = await check.value(prop, value)
        if len(check.problems) == before:
            out[key] = normalised
    if check.problems:
        return {}, check.problems
    await db.flush()
    return out, []


async def validate(
    db: AsyncSession,
    object_type: str,
    project_id: uuid.UUID | None,
    values: dict[str, Any],
    *,
    create_values: bool = False,
) -> dict[str, Any]:
    """The values, checked and normalised (slugs for select values, "YYYY-MM-DD" dates,
    numbers, booleans). A None (or empty) value means "remove the key" and stays None.

    Raises AppError code "property_invalid", with `details.errors` listing each
    problem and the closest existing values. Unknown keys, values not in a closed
    list (unless `create_values`) and near-duplicates are refused. New values of an
    open vocabulary (`tags`), and with `create_values` of a closed list, are created
    (flushed, not committed: the caller's change commits them)."""
    out, problems = await _check(
        db, object_type, project_id, values, create_values=create_values, from_file=False
    )
    if problems:
        _raise(problems)
    return out


async def from_front_matter(
    db: AsyncSession, object_type: str, project_id: uuid.UUID | None, meta: dict[str, Any]
) -> tuple[dict[str, Any], str | None]:
    """The properties a file's front matter gives, or ({}, why not) when they are not
    valid. Keys without a definition are left alone (other programs' front matter);
    new tags written by hand are added to the vocabulary."""
    out, problems = await _check(
        db, object_type, project_id, meta, create_values=False, from_file=True
    )
    if problems:
        return {}, " ".join(
            f"{p.key}: {p.message}"
            + (f" (closest: {', '.join(p.suggestions)})" if p.suggestions else "")
            + "."
            for p in problems
        )
    return {k: v for k, v in out.items() if v is not None}, None


# -- display -----------------------------------------------------------------------------


def shown(props: dict[str, Prop], values: dict[str, Any]) -> list[tuple[str, str]]:
    """(label, value as shown) for each value, in the definitions' order."""
    out = []
    for key, prop in props.items():
        if key not in values:
            continue
        value = values[key]
        if prop.type == "select":
            text = prop.label_of(str(value))
        elif prop.type == "multi_select":
            text = ", ".join(prop.label_of(str(v)) for v in value)
        elif prop.type == "checkbox":
            text = "yes" if value else "no"
        else:
            text = str(value)
        out.append((prop.definition.label, text))
    return out


def summary(props: dict[str, Prop], values: dict[str, Any]) -> str:
    """The values as the model reads them: `type: brief · tags: website, legal` (slugs,
    so it can filter and set with them)."""
    parts = []
    for key in [k for k in props if k in values] + [k for k in values if k not in props]:
        value = values[key]
        text = ", ".join(map(str, value)) if isinstance(value, list) else str(value)
        if isinstance(value, bool):
            text = "true" if value else "false"
        parts.append(f"{key}: {text}")
    return " · ".join(parts)


# -- counts ------------------------------------------------------------------------------


async def value_counts(
    db: AsyncSession, column: InstrumentedAttribute[Any] | ColumnElement[Any]
) -> dict[str, Counter[str]]:
    """How many rows of a table use each value, per key: {key: {value: count}}.
    Works on any JSONB `properties` column (documents now; tasks and events later)."""
    counts: dict[str, Counter[str]] = {}
    rows: list[dict[str, Any]] = list(await db.scalars(select(column).where(column != {})))
    for values in rows:
        for key, value in (values or {}).items():
            items = value if isinstance(value, list) else [value]
            counter = counts.setdefault(key, Counter())
            for item in items:
                counter[str(item).lower() if isinstance(item, bool) else str(item)] += 1
    return counts


# -- definitions -------------------------------------------------------------------------


async def get_definition(db: AsyncSession, definition_id: uuid.UUID) -> PropertyDefinition:
    definition = await db.get(PropertyDefinition, definition_id)
    if definition is None:
        raise NotFound("Property not found")
    return definition


async def get_option(
    db: AsyncSession, definition: PropertyDefinition, option_id: uuid.UUID
) -> PropertyOption:
    option = await db.get(PropertyOption, option_id)
    if option is None or option.definition_id != definition.id:
        raise NotFound("Value not found")
    return option


def _check_scope(applies_to: list[str], project_ids: list[uuid.UUID] | None) -> None:
    if not applies_to or any(t not in APPLIES_TO for t in applies_to):
        raise AppError("A property applies to documents, tasks or events", code="property_scope")
    if project_ids is not None and not project_ids:
        raise AppError("Choose at least one project, or make it global", code="property_scope")


async def create_definition(
    db: AsyncSession,
    *,
    key: str,
    label: str,
    type: str,
    applies_to: list[str],
    project_ids: list[uuid.UUID] | None,
    options: list[str],
) -> PropertyDefinition:
    """A new property, with its first values (labels; slugs are made from them). Commits."""
    await ensure_builtins(db)
    key = key.strip().lower()
    if not re.match(KEY_PATTERN, key) or key in RESERVED_KEYS:
        raise AppError(
            "A key is a short lower-case name (letters, digits, - or _)", code="property_key"
        )
    if type not in PROPERTY_TYPES:
        raise AppError(f"Unknown property type: {type}", code="property_type")
    _check_scope(applies_to, project_ids)
    if await db.scalar(select(PropertyDefinition.id).where(PropertyDefinition.key == key)):
        raise Conflict(f"A property '{key}' already exists", code="property_exists")
    count = len(list(await db.scalars(select(PropertyDefinition.id))))
    definition = PropertyDefinition(
        key=key,
        label=label.strip() or key,
        type=type,
        applies_to=list(dict.fromkeys(applies_to)),
        project_ids=[str(p) for p in project_ids] if project_ids is not None else None,
        open_vocabulary=False,
        builtin=False,
        sort_order=count,
    )
    db.add(definition)
    await db.flush()
    if type in SELECT_TYPES:
        for label_text in options:
            await _add_option(db, definition, label_text, None)
    await db.commit()
    return definition


async def update_definition(
    db: AsyncSession,
    definition: PropertyDefinition,
    *,
    label: str | None = None,
    applies_to: list[str] | None = None,
    project_ids: list[uuid.UUID] | None | Literal["keep"] = "keep",
    sort_order: int | None = None,
) -> PropertyDefinition:
    """Change what shows and where a property may be used (never its key or type:
    files store them). Built-ins stay global. Commits."""
    if label is not None:
        definition.label = label.strip() or definition.key
    if applies_to is not None:
        _check_scope(applies_to, None)
        definition.applies_to = list(dict.fromkeys(applies_to))
    if project_ids != "keep":
        if definition.builtin and project_ids is not None:
            raise AppError("Built-in properties are for every project", code="property_scope")
        _check_scope(definition.applies_to, project_ids)
        definition.project_ids = [str(p) for p in project_ids] if project_ids is not None else None
    if sort_order is not None:
        definition.sort_order = sort_order
    await db.commit()
    return definition


async def delete_definition(db: AsyncSession, definition: PropertyDefinition) -> None:
    """Remove a property. Files keep what they say; the key is just no longer indexed."""
    if definition.builtin:
        raise AppError("Built-in properties can't be removed", code="property_builtin")
    await db.delete(definition)
    await db.commit()


async def _add_option(
    db: AsyncSession, definition: PropertyDefinition, label: str, slug: str | None
) -> PropertyOption:
    slug = normalise(slug or label)
    if not slug:
        raise AppError("A value needs a name", code="property_value")
    taken = await db.scalar(
        select(PropertyOption.id).where(
            PropertyOption.definition_id == definition.id, PropertyOption.slug == slug
        )
    )
    if taken:
        raise Conflict(f"The value '{slug}' already exists", code="property_value_exists")
    count = len(
        list(
            await db.scalars(
                select(PropertyOption.id).where(PropertyOption.definition_id == definition.id)
            )
        )
    )
    option = PropertyOption(
        definition_id=definition.id, slug=slug, label=label.strip()[:120] or slug, sort_order=count
    )
    db.add(option)
    await db.flush()
    return option


async def add_option(
    db: AsyncSession, definition: PropertyDefinition, label: str, slug: str | None = None
) -> PropertyOption:
    """A new allowed value (made by the user in Settings: no near-duplicate check, the
    user decides). Commits."""
    if definition.type not in SELECT_TYPES:
        raise AppError("Only select properties have a list of values", code="property_type")
    option = await _add_option(db, definition, label, slug)
    await db.commit()
    return option


async def update_option(
    db: AsyncSession,
    option: PropertyOption,
    *,
    label: str | None = None,
    hub_document_id: uuid.UUID | None | Literal["keep"] = "keep",
    sort_order: int | None = None,
) -> PropertyOption:
    """Change a value's label (touches no files), hub page or place. Commits."""
    if label is not None:
        option.label = label.strip()[:120] or option.slug
    if hub_document_id != "keep":
        option.hub_document_id = hub_document_id
    if sort_order is not None:
        option.sort_order = sort_order
    await db.commit()
    return option


# -- filters -----------------------------------------------------------------------------


async def check_filter(db: AsyncSession, filters: dict[str, Any]) -> dict[str, Any]:
    """A property filter (shape in filters.py) with labels turned into slugs. Unknown
    keys and values are an AppError (code "property_invalid") naming the closest ones:
    a filter on a value nothing can have would silently find nothing."""
    props = await load(db)
    problems: list[Problem] = []

    def one(prop: Prop, value: Any) -> Any:
        if prop.type not in SELECT_TYPES or not isinstance(value, str):
            return value
        option = prop.option(value)
        if option is None:
            problems.append(
                Problem(prop.key, value, f"'{value}' is not one of its values", prop.closest(value))
            )
            return value
        return option.slug

    out: dict[str, Any] = {}
    for key, spec in (filters or {}).items():
        prop = props.get(key)
        if prop is None:
            problems.append(
                Problem(
                    key,
                    spec,
                    "is not a defined property",
                    difflib.get_close_matches(key, list(props), n=3, cutoff=0.5),
                )
            )
            continue
        if isinstance(spec, dict) and len(spec) == 1 and next(iter(spec)) in ("in", "has"):
            op, arg = next(iter(spec.items()))
            out[key] = {
                op: [one(prop, v) for v in arg] if isinstance(arg, list) else one(prop, arg)
            }
        elif isinstance(spec, dict):
            out[key] = spec  # missing (or a shape filters.condition refuses)
        else:
            out[key] = one(prop, spec)
    if problems:
        _raise(problems)
    return out
