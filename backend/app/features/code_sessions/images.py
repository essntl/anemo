"""Images sent with a Claude Code job's prompt (docs/specs/code-sessions.md §13,
docs/device-contracts.md §7.4).

The page uploads each image as an attachment first (POST /api/attachments, as the chat
does) and starts the job, or a follow-up, with their ids. Here they are checked and made
ready for the computer:

  - only PNG, JPEG, WebP and GIF (by their content, not their name), at most
    MAX_IMAGES per message and MAX_IMAGE_BYTES each as uploaded;
  - each is scaled down to what a model looks at (attachments/images.py: at most
    1568 px, 3 MB) and the total kept under MAX_TOTAL_BYTES, so the command that
    carries them stays far below what Anemo Desktop takes in one message (16 MB);
  - each gets a file name made here, never the uploaded one as it is:
    "<n>-<letters, digits, . _ ->.<png|jpg|webp|gif>".

The computer writes them into the job's folder (`images\\`) and adds their paths to the
prompt; Claude Code opens them with its Read tool. They are only ever files to look at.
"""

import asyncio
import base64
import re
import uuid
from dataclasses import dataclass
from pathlib import PurePath
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.features.attachments import service as attachments
from app.features.attachments.images import NotAnImage, prepare
from app.features.attachments.models import Attachment

MAX_IMAGES = 8
MAX_IMAGE_BYTES = 10 * 1024 * 1024  # as uploaded
MAX_TOTAL_BYTES = 8 * 1024 * 1024  # after scaling down, all images of one message
MAX_STEM = 60

EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
# The names the computer accepts (Anemo Desktop checks the same pattern).
NAME = re.compile(r"^\d{1,2}-[A-Za-z0-9._-]{1,80}\.(png|jpg|webp|gif)$")


class BadImage(AppError):
    status_code = 422
    code = "bad_image"


class TooManyImages(AppError):
    status_code = 422
    code = "too_many_images"


class ImagesTooLarge(AppError):
    status_code = 422
    code = "images_too_large"


@dataclass(frozen=True)
class ReadyImage:
    """An image as the computer gets it: the file name to write and its bytes."""

    attachment_id: uuid.UUID
    name: str
    data: bytes

    def command(self) -> dict[str, str]:
        """Its part of the `code_start` command."""
        return {"name": self.name, "data": base64.b64encode(self.data).decode("ascii")}

    def ref(self) -> dict[str, str]:
        """What the job's row keeps (`code_jobs.images`), for the thumbnails."""
        return {"id": str(self.attachment_id), "name": self.name}


def file_name(index: int, filename: str, mime: str) -> str:
    """ "<index>-<stem>.<ext>": the stem keeps only letters, digits, dots, dashes and
    underscores of the uploaded name (no path, no leading dot), the extension comes
    from the image's real type."""
    stem = PurePath(filename.replace("\\", "/")).stem
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem)
    stem = re.sub(r"-{2,}", "-", stem).strip(".-_")[:MAX_STEM].strip(".-_")
    return f"{index}-{stem or 'image'}.{EXTENSIONS[mime]}"


def _label(att: Attachment) -> str:
    """The uploaded name, short, for an error message."""
    name = att.filename.strip() or "image"
    return name if len(name) <= 60 else name[:57] + "…"


async def ready(db: AsyncSession, ids: list[uuid.UUID]) -> list[ReadyImage]:
    """The images `ids` (in that order, each once), checked and scaled down; raises
    BadImage, TooManyImages or ImagesTooLarge with a sentence for the user."""
    unique = list(dict.fromkeys(ids))
    if len(unique) > MAX_IMAGES:
        raise TooManyImages(f"At most {MAX_IMAGES} images can go with one message.")
    out: list[ReadyImage] = []
    total = 0
    for index, attachment_id in enumerate(unique, start=1):
        att = await db.get(Attachment, attachment_id)
        if att is None:
            raise BadImage("An attached image is gone. Remove it and add it again.")
        if att.kind != "image" or att.mime not in EXTENSIONS:
            raise BadImage(f"“{_label(att)}” isn't a PNG, JPEG, WebP or GIF image.")
        if att.size > MAX_IMAGE_BYTES:
            raise BadImage(f"“{_label(att)}” is larger than {MAX_IMAGE_BYTES // 2**20} MB.")
        data = await asyncio.to_thread(attachments.file_path(att).read_bytes)
        try:
            image = await asyncio.to_thread(prepare, data)
        except NotAnImage as exc:
            raise BadImage(f"“{_label(att)}” can't be read as an image.") from exc
        total += len(image.data)
        if total > MAX_TOTAL_BYTES:
            raise ImagesTooLarge(
                f"The images are too large together (at most {MAX_TOTAL_BYTES // 2**20} MB "
                "after scaling down): send fewer of them."
            )
        out.append(ReadyImage(att.id, file_name(index, att.filename, image.mime), image.data))
    return out


def refs(value: Any) -> list[dict[str, str]]:
    """The stored `code_jobs.images`, cleaned up (it is jsonb: never trust its shape)."""
    out: list[dict[str, str]] = []
    for item in value if isinstance(value, list) else []:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            out.append({"id": item["id"], "name": str(item.get("name") or "")})
    return out
