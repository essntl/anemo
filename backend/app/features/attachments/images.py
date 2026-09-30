"""Makes images suitable as model input: bounded size, a format every provider accepts.

Photos straight from a phone are often 4000+ px and several MB. Providers downscale
them anyway, but we'd still upload (and on some, pay for) the full image, so large
images are resized here first. The result is always PNG, JPEG, WebP or GIF.
"""

import io
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_INPUT_BYTES = 30 * 1024 * 1024
MAX_EDGE = 1568  # longest side; about what vision models use internally
MAX_OUTPUT_BYTES = 3 * 1024 * 1024  # well under every provider's per-image limit
PASSTHROUGH = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp", "GIF": "image/gif"}

Image.MAX_IMAGE_PIXELS = 60_000_000  # refuse decompression bombs


class NotAnImage(Exception):
    pass


@dataclass
class PreparedImage:
    data: bytes
    mime: str
    width: int
    height: int
    resized: bool  # True when the model sees a scaled-down copy


def prepare(data: bytes) -> PreparedImage:
    """Raises NotAnImage for anything Pillow cannot open as an image."""
    if len(data) > MAX_INPUT_BYTES:
        raise NotAnImage(f"the image is larger than {MAX_INPUT_BYTES // (1024 * 1024)} MB")
    try:
        source = Image.open(io.BytesIO(data))
        fmt = source.format or ""
        source.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, ValueError) as exc:
        raise NotAnImage(str(exc) or "not a readable image") from exc

    width, height = source.size
    fits = max(width, height) <= MAX_EDGE and len(data) <= MAX_OUTPUT_BYTES
    if fits and fmt in PASSTHROUGH and not getattr(source, "is_animated", False):
        return PreparedImage(data, PASSTHROUGH[fmt], width, height, resized=False)

    img = ImageOps.exif_transpose(source)  # phone photos store rotation in EXIF
    img.thumbnail((MAX_EDGE, MAX_EDGE))  # keeps aspect ratio; only ever shrinks
    has_alpha = img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info
    out = io.BytesIO()
    if has_alpha:
        img.convert("RGBA").save(out, "PNG", optimize=True)
        mime = "image/png"
    else:
        img.convert("RGB").save(out, "JPEG", quality=85)
        mime = "image/jpeg"
    resized = img.size != (width, height)
    return PreparedImage(out.getvalue(), mime, img.width, img.height, resized=resized)
