"""Each long field description once per request.

Many tools share fields with the same words: the properties of a task and of an event,
`create_value`, a synced item's `source_url`, the `browser` of every browser tool, the
`device` of every computer tool. Every request sends all of them. `say_once` goes through
the request's tool specs in their order (sorted by name, see runtime/agent.py) and keeps
a long description (`MIN_CHARS` or more) only where it comes first:

- the same text later becomes "As in <tool>." (or "As in <tool> (<field>)." when the
  field there has another name);
- a text that *starts* with an earlier one (update_task's `properties` says what
  create_task's says, and then "Only the keys given change; null removes one.") keeps
  only what it adds: "As in create_task. Only the keys given change; …".

The tool that keeps the words is always in the same request (it is one of `specs`), so
the model can read them there. Types, limits and enums are never touched, only
descriptions inside the input schemas; tool descriptions stay as they are. The result
depends only on the list, so the same toolset gives the same bytes on every request
(a prompt-cache prefix).
"""

from typing import Any

from app.providers.base import ToolSpec

MIN_CHARS = 60

# Where sub-schemas are, as in tools/schema.py.
_SCHEMA_MAPS = ("properties", "$defs", "definitions", "patternProperties")
_SCHEMA_VALUES = ("items", "additionalProperties", "not", "contains", "propertyNames")
_SCHEMA_LISTS = ("anyOf", "oneOf", "allOf", "prefixItems")


class _Seen:
    def __init__(self) -> None:
        # original text -> (tool, field) where it was first said
        self.first: dict[str, tuple[str, str]] = {}
        # original text -> where later copies point (tool, field) and what they add
        self.later: dict[str, tuple[str, str, str]] = {}

    def rewrite(self, text: str, tool: str, field: str) -> str:
        if len(text) < MIN_CHARS:
            return text
        if text not in self.later:
            base = self._longest_prefix(text)
            if base is None:
                self.first[text] = (tool, field)
                self.later[text] = (tool, field, "")
                return text
            # Later copies of this text point to the same place, with the same addition.
            self.later[text] = (*self.first[base], text[len(base) :])
        owner, owner_field, addition = self.later[text]
        return self._pointer(owner, owner_field, field) + addition

    def _longest_prefix(self, text: str) -> str | None:
        best = None
        for earlier in self.first:
            if (
                len(earlier) < len(text)
                and text.startswith(earlier)
                and text[len(earlier)] == " "
                and (best is None or len(earlier) > len(best))
            ):
                best = earlier
        return best

    @staticmethod
    def _pointer(tool: str, owner_field: str, field: str) -> str:
        where = tool if owner_field == field else f"{tool} ({owner_field})"
        return f"As in {where}."


def _walk(node: Any, seen: _Seen, tool: str, field: str) -> Any:
    """A copy of a schema node with its descriptions rewritten. `field`: the name of
    the property (or definition) the node describes."""
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "description" and isinstance(value, str):
            out[key] = seen.rewrite(value, tool, field)
        elif key in _SCHEMA_MAPS and isinstance(value, dict):
            out[key] = {name: _walk(sub, seen, tool, name) for name, sub in value.items()}
        elif key in _SCHEMA_VALUES:
            out[key] = _walk(value, seen, tool, field)
        elif key in _SCHEMA_LISTS and isinstance(value, list):
            out[key] = [_walk(sub, seen, tool, field) for sub in value]
        else:
            out[key] = value
    return out


def say_once(specs: list[ToolSpec]) -> list[ToolSpec]:
    """The specs of one request with every long field description said once."""
    seen = _Seen()
    return [
        ToolSpec(
            name=spec.name,
            description=spec.description,
            input_schema=_walk(spec.input_schema, seen, spec.name, ""),
        )
        for spec in specs
    ]
