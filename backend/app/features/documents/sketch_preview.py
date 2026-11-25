"""The rendered image of a sketch (its preview): shown where a sketch is embedded, sent to
models that can view images, and read by the transcription.

The editor renders it (the same code that draws the canvas) and uploads it after a
save; it is derived data, so it lives in the app's data folder, not the workspace:
`<data>/sketch-previews/<document id>.png`, with a small JSON file naming the drawing
version it shows. An upload is untrusted: it must be a PNG or WebP image within the size
and dimension limits, and it is decoded and written again as a fresh PNG (no metadata,
nothing but pixels)."""

import io
import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from app.core.config import get_settings
from app.core.errors import AppError

MAX_BYTES = 4 * 1024 * 1024
MAX_EDGE = 4096
FORMATS = {"PNG", "WEBP"}


@dataclass
class PreviewInfo:
    drawing_hash: str  # the drawing version it shows (sketch.drawing_hash)
    width: int
    height: int


def _folder() -> Path:
    return Path(get_settings().data_path) / "sketch-previews"


def _paths(document_id: uuid.UUID) -> tuple[Path, Path]:
    base = _folder() / str(document_id)  # a UUID: no path from outside
    return base.with_suffix(".png"), base.with_suffix(".json")


def clean(data: bytes) -> tuple[bytes, int, int]:
    """The uploaded image as a fresh PNG, with its size. AppError (invalid_preview) for
    anything else: another format, too large, a decompression bomb."""
    if len(data) > MAX_BYTES:
        raise AppError("The preview is larger than 4 MB", code="invalid_preview")
    head = data[:16]
    if not (head.startswith(b"\x89PNG") or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")):
        raise AppError("The preview must be a PNG or WebP image", code="invalid_preview")
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format not in FORMATS:
                raise AppError("The preview must be a PNG or WebP image", code="invalid_preview")
            width, height = source.size
            if not (0 < width <= MAX_EDGE and 0 < height <= MAX_EDGE):
                raise AppError(
                    f"The preview can be at most {MAX_EDGE}×{MAX_EDGE} pixels",
                    code="invalid_preview",
                )
            source.load()
            image = source.convert("RGBA")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, ValueError) as exc:
        raise AppError("The preview is not a readable image", code="invalid_preview") from exc
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue(), width, height


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def store(document_id: uuid.UUID, drawing_hash: str, data: bytes) -> PreviewInfo:
    """Validate and keep the preview of this drawing version (replaces the old one)."""
    png, width, height = clean(data)
    image_path, meta_path = _paths(document_id)
    _write(image_path, png)
    info = PreviewInfo(drawing_hash, width, height)
    _write(meta_path, json.dumps(info.__dict__).encode())
    return info


def info(document_id: uuid.UUID) -> PreviewInfo | None:
    image_path, meta_path = _paths(document_id)
    try:
        raw = json.loads(meta_path.read_text())
        if not image_path.is_file():
            return None
        return PreviewInfo(str(raw["drawing_hash"]), int(raw["width"]), int(raw["height"]))
    except (OSError, ValueError, KeyError, TypeError):
        return None


def image_path(document_id: uuid.UUID) -> Path | None:
    path = _paths(document_id)[0]
    return path if path.is_file() else None


def read(document_id: uuid.UUID) -> bytes | None:
    path = image_path(document_id)
    try:
        return path.read_bytes() if path else None
    except OSError:
        return None


def delete(document_id: uuid.UUID) -> None:
    for path in _paths(document_id):
        path.unlink(missing_ok=True)
