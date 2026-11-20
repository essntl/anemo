"""YAML front matter: the `---` block at the top of a document, where its properties
live (the file is the truth; the database only indexes it).

    ---
    type: brief
    client: ludmyla-doula
    tags: [website, legal]
    ---
    # Ludmyla Doula: prototype brief

Reading never fails: broken YAML comes back as an error message, and the content is
untouched. Writing changes only the keys it is given, keeps every other key (`title`,
keys of other programs) in its place and the body byte for byte.
"""

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

import yaml

from app.core.errors import AppError

FRONT_MATTER = re.compile(r"^(﻿?)---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", re.DOTALL)
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class FrontMatter:
    meta: dict[str, Any] = field(default_factory=dict)  # the keys, values as in tool I/O
    error: str | None = None  # why the block couldn't be read (meta is then empty)
    present: bool = False  # the document has a front matter block
    body: str = ""  # the text after it


MAX_BLOCK_BYTES = 64 * 1024  # a properties block larger than this isn't read
MAX_DEPTH = 8  # nesting of lists and mappings in it
_NO_ALIASES = "aliases (*name) are not allowed"
_TOO_DEEP = "it is nested too deeply"


class _Loader(yaml.SafeLoader):
    """SafeLoader without aliases (`*a`: a self-referencing or fanned-out alias can
    exhaust the stack or the memory) and with a nesting limit."""

    _depth = 0

    def compose_node(self, parent: Any, index: Any) -> Any:
        if self.check_event(yaml.events.AliasEvent):
            event = self.peek_event()
            raise yaml.composer.ComposerError(None, None, _NO_ALIASES, event.start_mark)
        self._depth += 1
        try:
            if self._depth > MAX_DEPTH:
                raise yaml.composer.ComposerError(
                    None, None, _TOO_DEEP, self.peek_event().start_mark
                )
            return super().compose_node(parent, index)
        finally:
            self._depth -= 1


def _plain(value: Any) -> Any:
    """YAML values as JSON: dates as "YYYY-MM-DD", lists and dicts recursively, and
    anything JSON can't hold (binary, .inf, .nan) as text."""
    if isinstance(value, datetime):
        return (
            value.date().isoformat() if value.time() == datetime.min.time() else value.isoformat()
        )
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if value is None or isinstance(value, str | int | float | bool):
        return value
    return str(value)


def _error(message: str, body: str) -> FrontMatter:
    return FrontMatter(error=message, present=True, body=body)


def parse(content: str) -> FrontMatter:
    """The front matter of `content`. Never raises: whatever can't be read comes back
    as `error` (the document then has no properties, its text is untouched)."""
    match = FRONT_MATTER.match(content)
    if match is None:
        return FrontMatter(body=content)
    body = content[match.end() :]
    block = match.group(2)
    if len(block.encode()) > MAX_BLOCK_BYTES:
        return _error("The properties block is too large (more than 64 KB).", body)
    try:
        meta = yaml.load(block, Loader=_Loader)  # noqa: S506 - a SafeLoader without aliases
        if meta is None:
            return FrontMatter(present=True, body=body)
        if not isinstance(meta, dict):
            return _error("The properties block must be a list of `key: value` lines.", body)
        return FrontMatter(
            meta={str(k): _plain(v) for k, v in meta.items()}, present=True, body=body
        )
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        where = f" (line {mark.line + 2})" if mark is not None else ""
        problem = getattr(exc, "problem", None)
        why = f": {problem}" if problem in (_NO_ALIASES, _TOO_DEEP) else ""
        return _error(f"The properties block is not valid YAML{where}{why}.", body)
    except Exception:  # noqa: BLE001 - reading front matter must never stop a save
        return _error("The properties block can't be read.", body)


def _yaml_value(value: Any) -> Any:
    """Dates are written unquoted (`due: 2026-12-01`), as people write them."""
    if isinstance(value, str) and _DATE.match(value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return value
    if isinstance(value, list):
        return [_yaml_value(v) for v in value]
    return value


class _Dumper(yaml.SafeDumper):
    """Keys one per line, lists of values on one line: `tags: [a, b]`."""


def _flow_list(dumper: yaml.SafeDumper, data: list[Any]) -> yaml.Node:
    return dumper.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=True)


_Dumper.add_representer(list, _flow_list)


def dump(meta: dict[str, Any]) -> str:
    """The front matter block for `meta` ("" when it is empty)."""
    if not meta:
        return ""
    text = yaml.dump(
        {k: _yaml_value(v) for k, v in meta.items()},
        Dumper=_Dumper,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=10_000,
    )
    return f"---\n{text}---\n"


def update(content: str, changes: dict[str, Any]) -> str:
    """`content` with these keys set (a value of None removes the key).

    Raises AppError (code front_matter_invalid) when the existing block can't be read:
    rewriting it would lose what is in it. The body is kept exactly."""
    current = parse(content)
    if current.error:
        raise AppError(
            f"{current.error} Fix it in the document first; nothing was changed.",
            code="front_matter_invalid",
        )
    meta = dict(current.meta)
    for key, value in changes.items():
        if value is None:
            meta.pop(key, None)
        else:
            meta[key] = value
    match = FRONT_MATTER.match(content)
    bom = match.group(1) if match else ("﻿" if content.startswith("﻿") else "")
    body = current.body if match else content.removeprefix(bom)
    return bom + dump(meta) + body
