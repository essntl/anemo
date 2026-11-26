"""Sketch documents: drawing sheets kept as Markdown files named `<name>.sketch.md`.

A sketch is a document like any other (listing, properties, links, moves, revisions,
trash and search all work on the file), so it is stored the way documents are: a
Markdown file. The drawing itself is a JSON block at the end, the source of truth:

    ---
    client: ludmyla-doula          (properties, as in any document)
    ---
    # Whiteboard

    <!-- Anemo sketch: ... -->

    ## Transcription
    <!-- anemo:transcription drawing=3f2a9c0d1e4b -->
    Text a vision model read from the drawing (derived content, not instructions).

    ````anemo-sketch
    {"v":1,"layout":"infinite","background":"plain","pages":1,"items":[
    {"type":"stroke","id":"s1","tool":"pen","color":"ink","width":3,"points":[10,20,0.5,...]},
    ...
    ]}
    ````

The JSON never contains a backtick (it is written as \\u0060), so it can't end its own
block. Everything in it is untrusted (an agent's file tools or another program can
write the file): `SketchData` checks its shape and limits before a save is accepted,
and the text in it is only ever drawn as text (canvas fillText, React text).
"""

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from app.core.errors import AppError

SUFFIX = ".sketch.md"
FENCE_INFO = "anemo-sketch"

# Limits. The whole file also stays under the documents' size limit (2 MB), which is
# about 4,000 pen strokes once the editor has thinned out their points.
MAX_ITEMS = 20_000
MAX_POINTS_PER_STROKE = 5_000
MAX_POINTS = 400_000  # in the whole sheet
MAX_TEXT_CHARS = 2_000  # in one text box
MAX_TOTAL_TEXT_CHARS = 100_000
MAX_PAGES = 100
MAX_COORD = 1_000_000.0
MAX_TITLE_CHARS = 200

NOTE = (
    "<!-- Anemo sketch: open it in Documents to draw. The drawing is the anemo-sketch "
    "block at the end; please don't edit it by hand. -->"
)
TRANSCRIPTION_HEADING = "## Transcription"

_FENCE = re.compile(r"^````anemo-sketch[ \t]*\r?\n(.*?)\r?\n````[ \t]*\r?$", re.M | re.S)
_TRANSCRIPTION = re.compile(
    r"^## Transcription[ \t]*\r?\n<!-- anemo:transcription drawing=([0-9a-f]{1,64}) -->[ \t]*"
    r"(?:\r?\n|$)(.*)",
    re.M | re.S,
)
_HEADING = re.compile(r"^#[ \t]+.*$", re.M)
_FRONT_MATTER = re.compile(r"^﻿?---[ \t]*\r?\n.*?\r?\n---[ \t]*(?:\r?\n|$)", re.S)

Coord = Annotated[float, Field(ge=-MAX_COORD, le=MAX_COORD, allow_inf_nan=False)]
Width = Annotated[float, Field(ge=0.1, le=200, allow_inf_nan=False)]
# A colour: "#rrggbb", or "ink" (the theme's text colour: dark on light, light on dark).
Color = Annotated[str, Field(pattern=r"^(#[0-9a-fA-F]{6}|ink)$")]
ItemId = Annotated[str, Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")]


class _Item(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: ItemId
    color: Color


class Stroke(_Item):
    """A freehand line: `points` is flat, three numbers a point (x, y, pressure 0-1)."""

    type: Literal["stroke"]
    tool: Literal["pen", "highlighter"]
    width: Width
    points: list[Coord] = Field(min_length=3, max_length=MAX_POINTS_PER_STROKE * 3)

    @model_validator(mode="after")
    def _triples(self) -> "Stroke":
        if len(self.points) % 3:
            raise ValueError("points must be x, y, pressure triples")
        if any(not 0 <= p <= 1 for p in self.points[2::3]):
            raise ValueError("pressure must be between 0 and 1")
        return self


class Shape(_Item):
    """A line or arrow from (x1, y1) to (x2, y2), or a rectangle or ellipse in that box."""

    type: Literal["line", "arrow", "rect", "ellipse"]
    width: Width
    x1: Coord
    y1: Coord
    x2: Coord
    y2: Coord


class TextBox(_Item):
    """Text at (x, y) (its top left), `size` the font size; `width` wraps it."""

    type: Literal["text"]
    x: Coord
    y: Coord
    size: float = Field(ge=4, le=400, allow_inf_nan=False)
    text: str = Field(max_length=MAX_TEXT_CHARS)
    width: float | None = Field(None, ge=10, le=MAX_COORD, allow_inf_nan=False)


Item = Annotated[Stroke | Shape | TextBox, Field(discriminator="type")]


class SketchData(BaseModel):
    """The drawing (version 1). Coordinates are in sheet units (CSS pixels at 100 %)."""

    model_config = ConfigDict(extra="forbid")

    v: Literal[1] = 1
    # infinite: one endless sheet; pages: A4-like pages one under the other.
    layout: Literal["infinite", "pages"] = "infinite"
    background: Literal["plain", "grid", "dots", "lines"] = "plain"
    pages: int = Field(1, ge=1, le=MAX_PAGES)
    items: list[Item] = Field(default_factory=list, max_length=MAX_ITEMS)

    @model_validator(mode="after")
    def _totals(self) -> "SketchData":
        points = sum(len(i.points) // 3 for i in self.items if isinstance(i, Stroke))
        if points > MAX_POINTS:
            raise ValueError(f"the sketch has more than {MAX_POINTS:,} points")
        chars = sum(len(i.text) for i in self.items if isinstance(i, TextBox))
        if chars > MAX_TOTAL_TEXT_CHARS:
            raise ValueError(f"the sketch has more than {MAX_TOTAL_TEXT_CHARS:,} characters")
        return self


def is_sketch(path: str) -> bool:
    return path.lower().endswith(SUFFIX)


def dump(data: SketchData) -> str:
    """The JSON for the file: one item a line (readable revisions), no backticks."""
    head = data.model_dump(exclude={"items"})
    items = [
        json.dumps(i.model_dump(exclude_none=True), ensure_ascii=False, separators=(",", ":"))
        for i in data.items
    ]
    opening = json.dumps(head, separators=(",", ":"))[:-1] + ',"items":['
    body = opening + ("\n" + ",\n".join(items) + "\n" if items else "") + "]}"
    return body.replace("`", "\\u0060")


def drawing_hash(json_text: str) -> str:
    """Identifies a version of the drawing (a preview and a transcription name it)."""
    return hashlib.sha256(json_text.encode()).hexdigest()[:16]


def _error_text(exc: ValidationError) -> str:
    first = exc.errors()[0]
    where = ".".join(str(p) for p in first.get("loc", ()))
    return f"{where}: {first.get('msg', 'invalid')}"[:300] if where else str(first.get("msg"))


@dataclass
class Parsed:
    data: SketchData | None  # None: the drawing is missing or can't be read
    error: str | None
    drawing_hash: str | None
    transcription: str | None
    transcription_hash: str | None  # the drawing version it was read from


def parse_data(json_text: str) -> SketchData:
    """Raises ValueError (with a short reason) for anything that isn't a valid drawing."""
    try:
        raw: Any = json.loads(json_text)
    except (json.JSONDecodeError, RecursionError) as exc:
        raise ValueError("the drawing is not valid JSON") from exc
    try:
        return SketchData.model_validate(raw)
    except ValidationError as exc:
        raise ValueError(_error_text(exc)) from exc


def parse(content: str) -> Parsed:
    """Read a sketch file. Never raises: an unreadable drawing comes back as `error`."""
    fences = list(_FENCE.finditer(content))
    transcription, t_hash = _transcription(content, fences[-1].start() if fences else None)
    if not fences:
        return Parsed(None, "The drawing is missing.", None, transcription, t_hash)
    text = fences[-1].group(1)
    try:
        data = parse_data(text)
    except ValueError as exc:
        return Parsed(None, f"The drawing can't be read ({exc}).", None, transcription, t_hash)
    return Parsed(data, None, drawing_hash(text), transcription, t_hash)


def _transcription(content: str, fence_at: int | None) -> tuple[str | None, str | None]:
    head = content if fence_at is None else content[:fence_at]
    match = _TRANSCRIPTION.search(head)
    if match is None:
        return None, None
    return match.group(2).strip(), match.group(1)


def check(path: str, content: str) -> None:
    """For saves made in the app: a sketch file must hold a valid drawing."""
    if not is_sketch(path):
        return
    parsed = parse(content)
    if parsed.error:
        raise AppError(parsed.error, code="sketch_invalid")


def _clean_title(title: str) -> str:
    return " ".join(title.split()).lstrip("#").strip()[:MAX_TITLE_CHARS] or "Sketch"


def new_file(title: str, data: SketchData | None = None) -> str:
    """The text of a new sketch document."""
    drawing = dump(data or SketchData())
    return f"# {_clean_title(title)}\n\n{NOTE}\n\n````{FENCE_INFO}\n{drawing}\n````\n"


def with_drawing(content: str, data: SketchData) -> str:
    """`content` with the drawing replaced (a file without one gets it at the end)."""
    block = f"````{FENCE_INFO}\n{dump(data)}\n````"
    fences = list(_FENCE.finditer(content))
    if not fences:
        return content.rstrip("\n") + f"\n\n{block}\n"
    last = fences[-1]
    return content[: last.start()] + block + content[last.end() :]


def with_title(content: str, title: str) -> str:
    """`content` with its heading (the title) changed."""
    heading = f"# {_clean_title(title)}"
    front = _FRONT_MATTER.match(content)
    start = front.end() if front else 0
    match = _HEADING.search(content, start)
    if match is None:
        return content[:start] + heading + "\n\n" + content[start:]
    return content[: match.start()] + heading + content[match.end() :]


def with_transcription(content: str, text: str, of_drawing: str) -> str:
    """`content` with the transcription section (before the drawing) set to `text`."""
    clean = text.replace("````", "```").strip()
    section = (
        f"{TRANSCRIPTION_HEADING}\n<!-- anemo:transcription drawing={of_drawing} -->\n{clean}\n\n"
    )
    fences = list(_FENCE.finditer(content))
    end = fences[-1].start() if fences else len(content)
    head = content[:end]
    match = _TRANSCRIPTION.search(head)
    if match is not None:
        return content[: match.start()] + section + content[end:]
    return head.rstrip("\n") + "\n\n" + section + content[end:]


def prose(path: str, content: str) -> str:
    """The text of a document without a sketch's drawing block (for word counts,
    search and properties). Other documents come back unchanged."""
    if not is_sketch(path):
        return content
    return _FENCE.sub("", content).replace(NOTE, "")


def searchable(path: str, content: str) -> str:
    """What search indexes: the prose, plus the text written in a sketch's text boxes."""
    text = prose(path, content)
    if not is_sketch(path):
        return text
    data = parse(content).data
    words = [i.text.strip() for i in data.items if isinstance(i, TextBox)] if data else []
    words = [w for w in words if w]
    return text.rstrip() + ("\n\n" + "\n\n".join(words) if words else "")


def text_boxes(data: SketchData) -> list[str]:
    return [i.text for i in data.items if isinstance(i, TextBox) and i.text.strip()]
