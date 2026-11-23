"""Trimming one Claude Code event (docs/specs/code-sessions.md §6). Pure: no IO.

Anemo Desktop trims each event by the same rules before it sends it; the server trims
again, and its result is the one stored (the client can't be trusted to have done it).

  1. Remove known copies: `tool_use_result.originalFile`, `tool_use_result.file.content`
     (Read) and `tool_use_result.content` of a Write (`tool_use_result.type` "create" or
     "update"; the same text is in the tool call's input).
  2. Over LIMIT: every string longer than 2000 characters keeps its first 1500 and last
     400, joined by "\\n… [N characters trimmed] …\\n".
  3. Still over: the same, from the event of step 1, for strings longer than 600
     characters, keeping 400 and 100.
  4. Still over: the event becomes {"type", "subtype"?, "anemo_trimmed": "too large"},
     plus `message.content[].{type, name, id}` of its tool calls.

`clean` is not part of the algorithm: it makes an event storable in Postgres (jsonb
takes no NUL character and no lone surrogate) and is applied before it.
"""

import copy
import json
import re
from typing import Any

LIMIT = 16_000  # bytes of compact UTF-8 JSON

# (strings longer than this, keep this many at the start, this many at the end)
LONG_CUT = (2000, 1500, 400)
SHORT_CUT = (600, 400, 100)

MAX_DEPTH = 100
TOO_DEEP = "[nested too deep]"
WRITE_RESULT_TYPES = ("create", "update")


def size(value: Any) -> int:
    """The UTF-8 bytes of the compact JSON of `value`."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return len(text.encode("utf-8", "surrogatepass"))


_UNSTORABLE = re.compile("[\x00\ud800-\udfff]")  # json.loads joins valid pairs already


def clean_text(text: str) -> str:
    return _UNSTORABLE.sub("�", text)


def clean(value: Any, depth: int = 0) -> Any:
    """A copy of `value` that Postgres can store as jsonb: NUL characters and lone
    surrogates replaced, nesting deeper than MAX_DEPTH replaced by a short text."""
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, dict):
        if depth >= MAX_DEPTH:
            return TOO_DEEP
        return {clean_text(str(k)): clean(v, depth + 1) for k, v in value.items()}
    if isinstance(value, list):
        if depth >= MAX_DEPTH:
            return TOO_DEEP
        return [clean(v, depth + 1) for v in value]
    return value


def _remove_copies(event: dict[str, Any]) -> bool:
    """Step 1, in place. True when something was removed."""
    result = event.get("tool_use_result")
    if not isinstance(result, dict):
        return False
    changed = False
    if "originalFile" in result:
        del result["originalFile"]
        changed = True
    file = result.get("file")
    if isinstance(file, dict) and "content" in file:
        del file["content"]
        changed = True
    if result.get("type") in WRITE_RESULT_TYPES and "content" in result:
        del result["content"]
        changed = True
    return changed


def _cut(value: Any, longer_than: int, head: int, tail: int) -> tuple[Any, bool]:
    if isinstance(value, str):
        if len(value) <= longer_than:
            return value, False
        removed = len(value) - head - tail
        return f"{value[:head]}\n… [{removed} characters trimmed] …\n{value[-tail:]}", True
    if isinstance(value, dict):
        changed = False
        out: dict[str, Any] = {}
        for key, item in value.items():
            out[key], cut = _cut(item, longer_than, head, tail)
            changed = changed or cut
        return out, changed
    if isinstance(value, list):
        changed = False
        items: list[Any] = []
        for item in value:
            new, cut = _cut(item, longer_than, head, tail)
            items.append(new)
            changed = changed or cut
        return items, changed
    return value, False


def _stub(event: dict[str, Any]) -> dict[str, Any]:
    """Step 4: what is left of an event that is still too large."""
    stub: dict[str, Any] = {"type": event.get("type")}
    if "subtype" in event:
        stub["subtype"] = event["subtype"]
    stub["anemo_trimmed"] = "too large"
    message = event.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, list):
        calls = [
            {k: block[k] for k in ("type", "name", "id") if k in block}
            for block in content
            if isinstance(block, dict) and block.get("type") == "tool_use"
        ]
        if calls:
            stub["message"] = {"content": calls}
    return stub


def trim(event: dict[str, Any], limit: int = LIMIT) -> tuple[dict[str, Any], bool]:
    """The event as it is stored, and whether any step changed it. `event` itself is
    not changed."""
    copied = copy.deepcopy(event)
    trimmed = _remove_copies(copied)
    if size(copied) <= limit:
        return copied, trimmed
    longer_than, head, tail = LONG_CUT
    cut, changed = _cut(copied, longer_than, head, tail)
    if size(cut) <= limit:
        return cut, trimmed or changed
    longer_than, head, tail = SHORT_CUT
    cut, changed = _cut(copied, longer_than, head, tail)
    if size(cut) <= limit:
        return cut, trimmed or changed
    return _stub(copied), True
