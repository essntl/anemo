"""Checks and prepares the files of Settings > Appearance and Profile. Pure: bytes in,
bytes out, no disk or database (that is service.py).

Every file is recognised by its content, never by its name or the type the browser
declared: a page planted to look like a picture must not reach the app as something
that runs. SVG in particular is refused, because an SVG is a document that can carry
script. See docs/specs/11-appearance-customisation.md for the table of types and caps.
"""

import io
from dataclasses import dataclass, field
from typing import Literal

from PIL import Image, ImageOps, UnidentifiedImageError

MB = 1024 * 1024
MAX_IMAGE_BYTES = 15 * MB
MAX_VIDEO_BYTES = 40 * MB
MAX_FONT_BYTES = 4 * MB
MAX_AVATAR_BYTES = 10 * MB
# Read at most this much of an upload: the largest cap, plus one byte to notice more.
MAX_UPLOAD_BYTES = MAX_VIDEO_BYTES

MAX_BACKGROUND_EDGE = 3840  # 4K; larger photos are scaled down (they look the same)
AVATAR_SIZES = (64, 128, 256)

Image.MAX_IMAGE_PIXELS = 60_000_000  # refuse decompression bombs (also set in attachments)

Media = Literal["image", "animated", "video", "font"]

# Pillow's format name -> the MIME type we serve it with.
IMAGE_FORMATS = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "WEBP": "image/webp",
    "AVIF": "image/avif",
    "GIF": "image/gif",
}


class InvalidFile(Exception):
    """A file that isn't one of the accepted kinds, or is too large. `code` is the stable
    error code the API returns."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class Prepared:
    """A checked file, ready to store: the bytes to keep, their type, and for an animated
    image or an avatar the extra files that go with it (name -> bytes)."""

    media: Media
    mime: str
    ext: str
    data: bytes
    extras: dict[str, bytes] = field(default_factory=dict)


# -- recognising a file -------------------------------------------------------------------


def looks_like_markup(data: bytes) -> bool:
    """SVG, XML or HTML: text that starts with "<" (after a BOM and white space)."""
    head = data[:512].lstrip(b"\xef\xbb\xbf").lstrip()
    return head.startswith(b"<")


def font_type(data: bytes) -> tuple[str, str] | None:
    """(MIME type, extension) of a WOFF2, WOFF, TrueType or OpenType font, else None."""
    head = data[:4]
    if head == b"wOF2":
        return "font/woff2", "woff2"
    if head == b"wOFF":
        return "font/woff", "woff"
    if head in (b"\x00\x01\x00\x00", b"true"):
        return "font/ttf", "ttf"
    if head == b"OTTO":
        return "font/otf", "otf"
    return None


# ISO base media brands of video files. Images use the same container (AVIF, HEIC), so
# their brands are not on this list and such a file is checked as an image instead.
_MP4_BRANDS = {
    b"isom", b"iso2", b"iso3", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42",
    b"avc1", b"dash", b"M4V ", b"MSNV", b"mmp4",
}  # fmt: skip


def video_type(data: bytes) -> tuple[str, str] | None:
    """(MIME type, extension) of a WebM or MP4 video, else None."""
    # WebM is Matroska (EBML magic) whose header names the "webm" document type.
    if data[:4] == b"\x1a\x45\xdf\xa3" and b"webm" in data[:64]:
        return "video/webm", "webm"
    # MP4: the first box is "ftyp", followed by the major brand.
    if data[4:8] == b"ftyp" and data[8:12] in _MP4_BRANDS:
        return "video/mp4", "mp4"
    return None


def _open_image(data: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Image.DecompressionBombError as exc:
        raise InvalidFile("The image has too many pixels", "image_too_large") from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise InvalidFile(
            "This isn't a picture Anemo can use (PNG, JPEG, WebP, AVIF or GIF)", "unsupported_type"
        ) from exc
    if img.format not in IMAGE_FORMATS:
        raise InvalidFile("Pictures can be PNG, JPEG, WebP, AVIF or GIF", code="unsupported_type")
    return img


def _refuse_markup(data: bytes) -> None:
    if looks_like_markup(data):
        raise InvalidFile(
            "SVG and other markup files can't be used, because they can contain scripts",
            "svg_not_allowed",
        )


def _check_size(data: bytes, cap: int, what: str) -> None:
    if not data:
        raise InvalidFile("The file is empty", "empty_file")
    if len(data) > cap:
        raise InvalidFile(f"{what} can be at most {cap // MB} MB", "file_too_large")


# -- preparing a file ---------------------------------------------------------------------


def _webp(img: Image.Image, quality: int = 86) -> bytes:
    """Encode as WebP, keeping transparency. A new encode carries no EXIF, XMP or ICC
    data, so a phone photo's location and camera details are gone."""
    has_alpha = img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info
    out = io.BytesIO()
    img.convert("RGBA" if has_alpha else "RGB").save(out, "WEBP", quality=quality, method=4)
    return out.getvalue()


def prepare_background(data: bytes) -> Prepared:
    """A picture (still or animated) or a video for behind the app."""
    _refuse_markup(data)
    video = video_type(data)
    if video:
        _check_size(data, MAX_VIDEO_BYTES, "Videos")
        return Prepared("video", video[0], video[1], data)

    _check_size(data, MAX_IMAGE_BYTES, "Pictures")
    img = _open_image(data)
    fmt = img.format or ""
    if getattr(img, "is_animated", False):
        # Kept as sent (re-encoding an animation is slow and loses quality); the first
        # frame becomes the still shown for reduced motion and on phones.
        img.seek(0)
        poster = ImageOps.exif_transpose(img.copy())
        poster.thumbnail((MAX_BACKGROUND_EDGE, MAX_BACKGROUND_EDGE))
        ext = "gif" if fmt == "GIF" else fmt.lower()
        return Prepared("animated", IMAGE_FORMATS[fmt], ext, data, {"poster.webp": _webp(poster)})

    still = ImageOps.exif_transpose(img)  # phone photos store their rotation in EXIF
    still.thumbnail((MAX_BACKGROUND_EDGE, MAX_BACKGROUND_EDGE))  # only ever shrinks
    return Prepared("image", "image/webp", "webp", _webp(still))


def prepare_font(data: bytes) -> Prepared:
    _refuse_markup(data)
    _check_size(data, MAX_FONT_BYTES, "Fonts")
    found = font_type(data)
    if not found:
        raise InvalidFile("Fonts can be WOFF2, WOFF, TTF or OTF files", "unsupported_type")
    return Prepared("font", found[0], found[1], data)


@dataclass(frozen=True)
class Crop:
    """The square to keep, as fractions of the picture's width (x, size) and height (y)
    after its EXIF rotation. The browser's cropper sends these."""

    x: float = 0.0
    y: float = 0.0
    size: float = 1.0  # of the shorter side


def crop_box(width: int, height: int, crop: Crop) -> tuple[int, int, int, int]:
    """The pixel box (left, top, right, bottom) of `crop`, always a square inside the
    picture: a box that would stick out is moved back in, one too large is shrunk."""
    short = min(width, height)
    side = max(1, min(short, round(crop.size * short)))
    left = min(max(0, round(crop.x * width)), width - side)
    top = min(max(0, round(crop.y * height)), height - side)
    return left, top, left + side, top + side


def prepare_avatar(data: bytes, crop: Crop) -> Prepared:
    """A square avatar in AVATAR_SIZES, as WebP files named "<size>.webp"."""
    _refuse_markup(data)
    _check_size(data, MAX_AVATAR_BYTES, "Avatars")
    img = _open_image(data)
    img.seek(0)  # an animated picture gives its first frame
    img = ImageOps.exif_transpose(img.copy())
    square = img.crop(crop_box(img.width, img.height, crop))
    files = {}
    for size in AVATAR_SIZES:
        files[f"{size}.webp"] = _webp(square.resize((size, size), Image.Resampling.LANCZOS))
    largest = files.pop(f"{AVATAR_SIZES[-1]}.webp")
    return Prepared("image", "image/webp", "webp", largest, files)
