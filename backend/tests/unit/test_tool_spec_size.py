"""The tool specs the model gets: compact schemas, and a size budget for all of them."""

import json
from typing import Any

from jsonschema import Draft202012Validator
from pydantic import BaseModel, Field, ValidationError

from app.tools.registry import all_tools, get
from app.tools.schema import compact
from app.tools.spec_size import spec_sizes

# Total characters of every offered built-in tool spec (compact JSON). A bit above the
# size when it was set (106,060 chars, ~32k tokens); raise it on purpose when a new tool
# needs the room, not by accident. `python -m app.cli tool-spec-sizes` shows what is big.
TOTAL_BUDGET = 108_000


class _Item(BaseModel):
    title: str = Field(description="A property that is called title")
    done: bool = False


class _Input(BaseModel):
    name: str | None = Field(None, max_length=10, description="A name")
    item: _Item | None = None
    items: list[_Item] | None = None
    either: int | str | None = None
    required_or_null: int | None
    expires: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


def test_compact_drops_titles_and_not_given_nulls():
    schema = compact(_Input.model_json_schema(), keep_null=frozenset({"expires"}))
    props = schema["properties"]
    assert "title" not in schema and "title" not in schema["$defs"]["_Item"]
    # A property named "title" is a property, not a title keyword.
    assert props["name"] == {"type": "string", "maxLength": 10, "description": "A name"}
    assert schema["$defs"]["_Item"]["properties"]["title"] == {
        "type": "string",
        "description": "A property that is called title",
    }
    assert props["item"] == {"$ref": "#/$defs/_Item"}
    assert props["items"] == {"type": "array", "items": {"$ref": "#/$defs/_Item"}}
    assert props["either"] == {"anyOf": [{"type": "integer"}, {"type": "string"}]}
    # Required, but may be null: the null is the value, so it stays.
    assert {"type": "null"} in props["required_or_null"]["anyOf"]
    # Named in keep_null: an explicit null means something there.
    assert props["expires"] == {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None}
    assert props["extra"] == {"type": "object"}


def test_every_tool_schema_is_valid_and_has_no_titles():
    for tool in all_tools():
        schema = tool.spec().input_schema
        Draft202012Validator.check_schema(schema)
        assert schema.get("type") == "object", tool.name
        assert '"title": "' not in json.dumps(_keywords_only(schema)), tool.name


def _keywords_only(schema: Any) -> Any:
    """The schema with property names replaced, so a property called "title" can't match."""
    if isinstance(schema, dict):
        return {
            k: (
                {f"p{i}": _keywords_only(v) for i, v in enumerate(val.values())}
                if k in ("properties", "$defs")
                else _keywords_only(val)
            )
            for k, val in schema.items()
        }
    if isinstance(schema, list):
        return [_keywords_only(v) for v in schema]
    return schema


def test_an_explicit_null_still_validates_where_the_schema_no_longer_says_so():
    # Models send null for an optional field they don't use; the tool still accepts it.
    checked = 0
    for tool in all_tools():
        raw = tool.Input.model_json_schema().get("properties", {})
        for name, prop in raw.items():
            if {"type": "null"} not in prop.get("anyOf", []) or prop.get("default", 0) is not None:
                continue
            try:
                tool.Input.model_validate({name: None})
            except ValidationError as exc:
                assert not [e for e in exc.errors() if e["loc"][:1] == (name,)], (tool.name, name)
            checked += 1
    assert checked > 100
    args = get("update_task").Input.model_validate({"id": "t1", "title": None, "due_date": None})
    assert args.title is None


def test_fields_whose_null_clears_something_keep_it():
    schedule = get("update_schedule").spec().input_schema["properties"]
    for name in ("tools", "model", "profile", "max_tool_calls", "max_minutes", "retention_days"):
        assert {"type": "null"} in schedule[name]["anyOf"], name
    assert "anyOf" not in schedule["name"]  # null there only means "keep it"
    trigger = get("update_trigger").spec().input_schema["properties"]
    assert {"type": "null"} in trigger["expires_at"]["anyOf"]
    assert "anyOf" not in trigger["note"]


def test_the_tool_specs_stay_within_their_budget():
    total = sum(row[3] for row in spec_sizes())
    assert total <= TOTAL_BUDGET, (
        f"The tool specs grew to {total} chars (budget {TOTAL_BUDGET}); "
        "see `python -m app.cli tool-spec-sizes`"
    )
