"""Image generation for the generate_image tool (tools/builtin/images.py).

  choose_model()     the default image model, or one the call names (only configured ones)
  make_images()      asks the provider (providers/images.py) and returns checked pictures:
                     base64 answers are decoded, URL answers fetched through the guarded
                     client, and only real PNG, JPEG, WebP or GIF images are kept
  plan_files()       where the pictures go in the workspace (never over an existing file)
  sidecar()          the provenance file saved next to each picture
  ask_in_automations()  the policy rule that makes automation runs ask before each call

The tool does the writing (it records the changes in the run's history) and attaches
the pictures to the answer. See docs/specs/10-image-generation.md.
"""

import io
import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import PurePosixPath
from typing import Any

import httpx
from PIL import Image, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.errors import AppError
from app.features.providers.models import Model
from app.features.settings import service as settings_service
from app.features.settings.sections import ImageSettings, ModelDefaults
from app.policy.engine import evaluate
from app.policy.models import Action, Policy, Rule
from app.providers import images as image_api
from app.providers.router import ResolvedModel, to_resolved
from app.web import safe_http
from app.web.settings import WebSettings
from app.workspace import fs_guard

log = logging.getLogger(__name__)

CAPABILITY = "image.generate"
MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024  # one picture from a provider's URL
DOWNLOAD_TIMEOUT_S = 30.0
# What may be saved: Pillow's name for the format -> (MIME type, file extension).
SAVED_FORMATS = {
    "PNG": ("image/png", "png"),
    "JPEG": ("image/jpeg", "jpg"),
    "WEBP": ("image/webp", "webp"),
    "GIF": ("image/gif", "gif"),
}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
DEFAULT_ROOT = "files"  # files/generated/<date>/ outside a project
GENERATED_FOLDER = "generated"

NO_MODEL = (
    "No image model is set up yet. Tell the user: add a provider with an image model "
    "(OpenAI gpt-image-1.5 or gpt-image-2, an OpenRouter image model, or Google Gemini "
    "gemini-2.5-flash-image) in Settings → Providers & Models, and choose it under "
    "Default models → Image generation."
)


class NoImageModel(AppError):
    status_code = 409
    code = "no_image_model"


# --- the model --------------------------------------------------------------------------


async def get_settings(db: AsyncSession) -> ImageSettings:
    return await settings_service.get_section(db, ImageSettings, "images")


async def image_models(db: AsyncSession) -> list[Model]:
    """Enabled models with the image_generation capability, of enabled providers."""
    rows = await db.scalars(
        select(Model).options(selectinload(Model.provider)).order_by(Model.display_name)
    )
    return [
        m
        for m in rows
        if m.enabled
        and m.provider.enabled
        and m.capabilities.get("image_generation")
        and m.provider.type in image_api.IMAGE_PROVIDER_TYPES
    ]


async def has_default_model(db: AsyncSession) -> bool:
    """Whether an image model is chosen (so chat turns offer generate_image)."""
    defaults = await settings_service.get_section(db, ModelDefaults, "models")
    return defaults.image is not None


def _matches(model: Model, name: str) -> bool:
    wanted = name.strip().lower()
    return wanted in (str(model.id), model.model_key.lower(), model.display_name.lower())


async def choose_model(db: AsyncSession, requested: str | None) -> ResolvedModel:
    """The model a call uses: the one it names (if configured), else the default.
    Raises NoImageModel with a message for the model."""
    models = await image_models(db)
    if requested:
        for model in models:
            if _matches(model, requested):
                return await to_resolved(db, model)
        names = ", ".join(f"{m.display_name} ({m.provider.name})" for m in models)
        raise NoImageModel(
            f"There is no image model '{requested}'. "
            + (f"The configured ones are: {names}." if names else NO_MODEL)
        )
    defaults = await settings_service.get_section(db, ModelDefaults, "models")
    chosen = next((m for m in models if m.id == defaults.image), None)
    if chosen is None:
        raise NoImageModel(NO_MODEL)
    return await to_resolved(db, chosen)


# --- the pictures -----------------------------------------------------------------------


@dataclass
class Picture:
    data: bytes
    mime: str
    extension: str
    width: int
    height: int


def check_picture(data: bytes) -> Picture:
    """The picture, if these bytes are a PNG, JPEG, WebP or GIF image. Raises
    ImageError for anything else (whatever the provider said it was)."""
    if not data:
        raise image_api.ImageError("The image model sent an empty image.")
    try:
        with Image.open(io.BytesIO(data)) as img:
            fmt = img.format or ""
            width, height = img.size
            img.verify()  # reads the whole file: a truncated or damaged one fails here
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, ValueError) as exc:
        raise image_api.ImageError("The image model sent something that is not an image.") from exc
    if fmt not in SAVED_FORMATS:
        raise image_api.ImageError(f"The image model sent a {fmt or 'unknown'} file, not saved.")
    mime, extension = SAVED_FORMATS[fmt]
    return Picture(data, mime, extension, width, height)


async def download(url: str, web: WebSettings) -> Picture:
    """A picture a provider gave as an address: fetched with the client that cannot reach
    the user's network (unless allowed in Settings > Web & Search), at most
    MAX_DOWNLOAD_BYTES, and only when the server says it is an image and it is one."""
    if not url.startswith(("https://", "http://")):
        raise image_api.ImageError("The image model gave an address that is not a web address.")
    allow = safe_http.parse_allowlist(web.allowed_private_hosts)
    try:
        async with (
            safe_http.client(allow, timeout=DOWNLOAD_TIMEOUT_S) as http,
            http.stream("GET", url) as response,
        ):
            if response.status_code >= 400:
                raise image_api.ImageError(
                    f"The image could not be downloaded from the provider ({response.status_code})."
                )
            kind = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if kind not in {mime for mime, _ in SAVED_FORMATS.values()}:
                raise image_api.ImageError(
                    f"The provider's image address gave {kind or 'no content type'}, not an "
                    "image; nothing was saved."
                )
            data, cut = await safe_http.read_limited(response, MAX_DOWNLOAD_BYTES)
    except safe_http.BlockedAddress as exc:
        raise image_api.ImageError(str(exc)) from exc
    except httpx.HTTPError as exc:
        raise image_api.ImageError(
            f"The image could not be downloaded from the provider: {type(exc).__name__}."
        ) from exc
    if cut:
        raise image_api.ImageError(
            f"The provider's image is larger than {MAX_DOWNLOAD_BYTES // (1024 * 1024)} MB; "
            "nothing was saved."
        )
    return check_picture(data)


async def make_images(
    model: ResolvedModel, request: image_api.ImageRequest, web: WebSettings
) -> tuple[list[Picture], image_api.ImageResult]:
    """Ask the provider and return the checked pictures. Raises ImageError (with `usage`
    set when the provider answered, so what it charged is still recorded)."""
    result = await image_api.generate(model.config, request)
    try:
        if not result.images:
            raise image_api.ImageError(
                "The image model answered without an image (it may have declined the prompt). "
                "Try rewording it."
            )
        pictures = []
        for image in result.images[: request.count]:
            if image.data is not None:
                pictures.append(check_picture(image.data))
            elif image.url:
                pictures.append(await download(image.url, web))
    except image_api.ImageError as exc:
        exc.usage = result.usage
        raise
    return pictures, result


# --- where they go ----------------------------------------------------------------------


def slug(prompt: str, limit: int = 40) -> str:
    """A short file-name part from the prompt: "A red fox, at dawn!" -> "a-red-fox-at-dawn"."""
    words = re.sub(r"[^a-z0-9]+", "-", prompt.lower()).strip("-")
    cut = words[:limit].rsplit("-", 1)[0] if len(words) > limit else words
    return cut.strip("-") or "image"


def default_folder(project_files: str | None, day: datetime) -> str:
    """files/generated/<date>, or <project folder>/generated/<date> in a project's chat."""
    root = project_files or DEFAULT_ROOT
    return f"{root}/{GENERATED_FOLDER}/{day.strftime('%Y-%m-%d')}"


def split_destination(path: str | None, folder: str, prompt: str) -> tuple[str, str]:
    """(folder, base name) for the files: `path` is a folder, or a file name whose
    extension is replaced by the picture's own."""
    if not path:
        return folder, slug(prompt)
    rel = fs_guard.relative(fs_guard.resolve(path)) or "."
    pure = PurePosixPath(rel)
    if pure.suffix.lower() in IMAGE_SUFFIXES:
        parent = str(pure.parent)
        return ("." if parent in ("", ".") else parent), slug(pure.stem, limit=80)
    return rel, slug(prompt)


def plan_files(folder: str, base: str, pictures: list[Picture]) -> list[str]:
    """Workspace paths for the pictures: <base>.<ext> for one, <base>-1, <base>-2, ...
    for several; a taken name moves on to the next number."""
    root = fs_guard.resolve(folder)
    taken: set[str] = set()
    paths = []
    n = 1
    for picture in pictures:
        while True:
            stem = base if len(pictures) == 1 and n == 1 else f"{base}-{n}"
            name = f"{stem}.{picture.extension}"
            n += 1
            sidecar_name = f"{name}.json"
            if (
                name not in taken
                and not (root / name).exists()
                and not (root / sidecar_name).exists()
            ):
                break
        taken.add(name)
        paths.append(name if folder in ("", ".") else f"{folder}/{name}")
    return paths


def sidecar(
    *,
    prompt: str,
    revised_prompt: str | None,
    model: ResolvedModel,
    picture: Picture,
    request: image_api.ImageRequest,
    input_images: list[str],
    created_at: datetime,
    conversation_id: uuid.UUID | None,
    run_id: uuid.UUID,
    made_by: str,
) -> bytes:
    """The provenance saved next to a picture as <file>.json."""
    data: dict[str, Any] = {
        "prompt": prompt,
        "revised_prompt": revised_prompt,
        "model": model.model_key,
        "model_name": model.display_name,
        "provider": model.provider_name,
        "size": f"{picture.width}x{picture.height}",
        "aspect_ratio": request.aspect_ratio,
        "quality": request.quality,
        "resolution": request.resolution,
        "input_images": input_images,
        "created_at": created_at.isoformat(),
        "chat_id": str(conversation_id) if conversation_id else None,
        "run_id": str(run_id),
        "made_by": made_by,
        "tool": "generate_image",
    }
    return (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


# --- permissions --------------------------------------------------------------------------


def ask_in_automations(policy: Policy) -> Policy:
    """The policy of an automation run (or its sub-agent) with "Generate images" made to
    ask, if it would allow it. Only ever stricter: a deny stays a deny, an ask an ask."""
    probe = Action(capability=CAPABILITY, risk="safe")
    if evaluate(probe, policy).decision != "allow":
        return policy
    rule = Rule(cap=CAPABILITY, decision="ask")
    # First, so it wins over the category rule of the same specificity.
    return policy.model_copy(update={"rules": [rule, *policy.rules]})
