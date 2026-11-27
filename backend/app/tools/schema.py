"""The JSON Schema of a tool's input, in the shape the model gets it.

Pydantic's schema is made for documentation: every property carries a `title` ("Due Date"
for due_date) and every optional field `x: T | None = None` becomes
`{"anyOf": [T, {"type": "null"}], "default": null}`. Sent with every request, that is
thousands of tokens that tell the model nothing. `compact()` drops the titles and writes
such a field as plain T: leaving it out means the same as null.

Only the schema the model sees changes. Arguments are still validated by the tool's
Pydantic model, so an explicit null from a model still validates as before. A field
where an explicit null does something different from leaving the field out (it clears a
stored value) keeps its null: the tool names it in `Tool.null_clears`.

The HTTP API's schema (FastAPI, frontend/src/api/openapi.json) is not touched.
"""

from typing import Any

# Keywords whose value is a dict of name -> schema, or a schema, or a list of schemas.
_SCHEMA_MAPS = ("properties", "$defs", "definitions", "patternProperties")
_SCHEMA_VALUES = ("items", "additionalProperties", "not", "contains", "propertyNames")
_SCHEMA_LISTS = ("anyOf", "oneOf", "allOf", "prefixItems")
_NULL = {"type": "null"}


def compact(schema: dict[str, Any], *, keep_null: frozenset[str] = frozenset()) -> dict[str, Any]:
    """A copy of `schema` without titles, and with `anyOf [T, null]` + `default: null`
    written as T. `keep_null`: top-level properties that keep their null."""
    out = _compact(schema)
    for name, prop in (out.get("properties") or {}).items():
        if name in keep_null:
            original = schema["properties"][name]
            prop.clear()
            prop.update(_compact(original, collapse=False))
    return out


def _compact(schema: Any, *, collapse: bool = True) -> Any:
    if not isinstance(schema, dict):
        return schema
    out: dict[str, Any] = {}
    for key, value in schema.items():
        if key == "title" and isinstance(value, str):
            continue
        if key in _SCHEMA_MAPS and isinstance(value, dict):
            out[key] = {name: _compact(sub) for name, sub in value.items()}
        elif key in _SCHEMA_VALUES:
            if key == "additionalProperties" and value is True:
                continue  # the JSON Schema default: any extra keys
            out[key] = _compact(value)
        elif key in _SCHEMA_LISTS and isinstance(value, list):
            out[key] = [_compact(sub) for sub in value]
        else:
            out[key] = value
    return _without_null(out) if collapse else out


def _without_null(schema: dict[str, Any]) -> dict[str, Any]:
    """`{"anyOf": [T, null], "default": null, ...}` -> `{**T, ...}`: null only meant
    "not given". Anything else is returned as it is."""
    variants = schema.get("anyOf")
    if (
        not isinstance(variants, list)
        or _NULL not in variants
        or "default" not in schema
        or schema["default"] is not None
    ):
        return schema
    rest = [v for v in variants if v != _NULL]
    if len(rest) != 1:
        # T1 | T2 | None: keep the choice, only drop the null.
        merged = {k: v for k, v in schema.items() if k != "default"}
        merged["anyOf"] = rest
        return merged
    inner = rest[0]
    siblings = {k: v for k, v in schema.items() if k not in ("anyOf", "default")}
    if any(k in inner for k in siblings):
        return schema  # would overwrite a keyword of T: leave it as Pydantic wrote it
    return {**inner, **siblings}
