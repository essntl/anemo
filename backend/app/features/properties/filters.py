"""The property filter, as SQL. One shape everywhere (search_documents, list_documents,
views, and later list_tasks and list_events):

    {
      "client": "ludmyla-doula",             # =   (for a multi_select: has)
      "status": {"in": ["draft", "active"]}, # in
      "tags":   {"has": "legal"},            # has (a multi_select contains it)
      "type":   {"missing": true}            # missing (no value); false: has one
    }

The conditions work on any JSONB `properties` column and use its GIN index
(containment `@>` and key existence `?`). Values are compared as stored: run them
through properties.service.validate_filter first to turn labels into slugs.
"""

from typing import Any

from sqlalchemy import ColumnElement, and_, false, not_, or_, true
from sqlalchemy.orm import InstrumentedAttribute

from app.core.errors import AppError

OPERATORS = ("in", "has", "missing")


def _equals(column: Any, key: str, value: Any) -> ColumnElement[bool]:
    """The key has this value, or (a list) contains it."""
    if isinstance(value, list | dict):
        raise AppError(f"A filter value for {key} must be a single value", code="filter_invalid")
    return or_(column.contains({key: value}), column.contains({key: [value]}))


def condition(column: Any, key: str, spec: Any) -> ColumnElement[bool]:
    """One key's condition. Raises AppError (code filter_invalid) for an unknown shape."""
    if not isinstance(spec, dict):
        return _equals(column, key, spec)
    if len(spec) != 1 or next(iter(spec)) not in OPERATORS:
        raise AppError(
            f"A filter for {key} is a value or one of {{in: [...]}}, {{has: x}}, {{missing: true}}",
            code="filter_invalid",
        )
    op, arg = next(iter(spec.items()))
    if op == "in":
        values = arg if isinstance(arg, list) else [arg]
        return or_(*[_equals(column, key, v) for v in values]) if values else false()
    if op == "has":
        return _equals(column, key, arg)
    if not isinstance(arg, bool):
        raise AppError(f"missing for {key} is true or false", code="filter_invalid")
    exists = column.has_key(key)
    return not_(exists) if arg else exists


def property_conditions(
    column: InstrumentedAttribute[Any] | ColumnElement[Any], filters: dict[str, Any]
) -> list[ColumnElement[bool]]:
    """WHERE conditions for these filters on a JSONB `properties` column (all must hold)."""
    return [condition(column, key, spec) for key, spec in (filters or {}).items()]


def all_of(conditions: list[ColumnElement[bool]]) -> ColumnElement[bool]:
    return and_(*conditions) if conditions else true()
