"""Image generation APIs: one small client per request shape.

The `generate_image` tool (tools/builtin/images.py) and its service
(features/image_generation) choose the model; this module only turns an `ImageRequest`
into an HTTP request for the model's provider and the answer into `GeneratedImage`s.
It knows nothing of runs, tools or the workspace.

Which shape a provider speaks depends on its type (checked against the providers'
documentation in November 2026, see docs/specs/10-image-generation.md):

  openai, openai_compatible  POST {base}/images/generations (JSON), or with input images
                             POST {base}/images/edits (multipart, one `image[]` per file)
  openrouter                 POST {base}/images (JSON, input images as data: URLs)
  google                     POST {base}/images/generations on Gemini's OpenAI-compatible
                             endpoint (no edits there)
  fake                       a plain test picture made here (tests and e2e, no network)

Every failure becomes an `ImageError` with a message a person can read; `refused` is set
when the provider's content policy declined the prompt or the picture.
"""

import base64
import io
import json as json_module
import logging
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from app.providers.base import ProviderConfig, Usage

log = logging.getLogger(__name__)

AspectRatio = Literal["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"]
Quality = Literal["auto", "low", "medium", "high"]
Resolution = Literal["1K", "2K", "4K"]

ASPECT_RATIOS: tuple[AspectRatio, ...] = ("1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16")
RESOLUTIONS: tuple[Resolution, ...] = ("1K", "2K", "4K")
# The provider types that can make images, and what each can do.
IMAGE_PROVIDER_TYPES = frozenset({"openai", "openai_compatible", "openrouter", "google", "fake"})
EDIT_PROVIDER_TYPES = frozenset({"openai", "openai_compatible", "openrouter", "fake"})

TIMEOUT_S = 180.0  # an image at high quality can take a minute or two
MAX_RESPONSE_BYTES = 120 * 1024 * 1024  # 10 images of a few MB each, base64-encoded

# Tests replace this to answer requests without a network (like web/safe_http.py).
transport_override: httpx.AsyncBaseTransport | None = None


@dataclass
class InputImage:
    """A picture to edit or vary (already checked and scaled by the caller)."""

    data: bytes
    mime: str
    filename: str


@dataclass
class ImageRequest:
    model: str
    prompt: str
    count: int = 1
    aspect_ratio: AspectRatio = "1:1"
    quality: Quality = "auto"
    resolution: Resolution = "1K"
    input_images: list[InputImage] = field(default_factory=list)


@dataclass
class GeneratedImage:
    """One picture as the provider gave it: its bytes, or an address to fetch them from
    (the caller downloads that safely and checks what it gets)."""

    data: bytes | None = None
    url: str | None = None
    mime: str | None = None  # what the provider says; the caller checks the bytes


@dataclass
class ImageResult:
    images: list[GeneratedImage]
    usage: Usage
    revised_prompt: str | None = None  # the prompt the provider actually used, if it says
    size: str | None = None  # e.g. "1536x1024", when the provider was asked for one


class ImageError(Exception):
    """A failed image request, with a message for the model (and so the user)."""

    def __init__(self, message: str, *, refused: bool = False, status: int | None = None):
        super().__init__(message)
        self.refused = refused
        self.status = status
        # Set when the provider did answer (and may have charged) but the answer was not
        # usable: the caller still records the usage.
        self.usage: Usage | None = None


def can_edit(provider_type: str) -> bool:
    return provider_type in EDIT_PROVIDER_TYPES


async def generate(cfg: ProviderConfig, req: ImageRequest) -> ImageResult:
    """Make the pictures. Raises ImageError."""
    if cfg.type not in IMAGE_PROVIDER_TYPES:
        raise ImageError(f"Providers of type {cfg.type} cannot make images.")
    if req.input_images and not can_edit(cfg.type):
        raise ImageError(
            "This image model cannot edit pictures through its provider's API (Google's "
            "OpenAI-compatible endpoint only creates new ones). Describe the change in the "
            "prompt instead, or use an OpenAI or OpenRouter image model."
        )
    if cfg.type == "fake":
        return _fake(req)
    if cfg.type == "openrouter":
        return await _openrouter(cfg, req)
    if cfg.type == "google":
        return await _google(cfg, req)
    return await _openai(cfg, req)


# --- OpenAI Images API (also OpenAI-compatible servers) ----------------------------------


def openai_size(aspect_ratio: AspectRatio) -> str:
    """The size GPT image models accept that is nearest to the aspect ratio."""
    width, height = (int(n) for n in aspect_ratio.split(":"))
    if width == height:
        return "1024x1024"
    return "1536x1024" if width > height else "1024x1536"


def openai_body(req: ImageRequest) -> dict[str, Any]:
    """The fields of a generations request (an edit sends the same ones as form fields)."""
    body: dict[str, Any] = {
        "model": req.model,
        "prompt": req.prompt,
        "n": req.count,
        "size": openai_size(req.aspect_ratio),
    }
    if req.quality != "auto":
        body["quality"] = req.quality
    # Older models answer with a URL by default; GPT image models always send base64
    # and refuse the field.
    if req.model.startswith("dall-e"):
        body["response_format"] = "b64_json"
    return body


async def _openai(cfg: ProviderConfig, req: ImageRequest) -> ImageResult:
    body = openai_body(req)
    if req.input_images:
        form = {k: str(v) for k, v in body.items()}
        files = [("image[]", (i.filename, i.data, i.mime)) for i in req.input_images]
        data = await _post(cfg, "/images/edits", data=form, files=files)
    else:
        data = await _post(cfg, "/images/generations", json=body)
    images = _openai_style_images(data)
    revised = next(
        (d.get("revised_prompt") for d in data.get("data") or [] if d.get("revised_prompt")),
        None,
    )
    return ImageResult(images, _usage(data.get("usage")), revised, body["size"])


def _openai_style_images(data: dict[str, Any]) -> list[GeneratedImage]:
    """`data[]` items with `b64_json` or `url` (OpenAI, OpenRouter and Google all use it)."""
    images = []
    for item in data.get("data") or []:
        mime = item.get("media_type") or item.get("mime_type")
        if item.get("b64_json"):
            images.append(GeneratedImage(data=_b64(item["b64_json"]), mime=mime))
        elif item.get("url"):
            images.append(GeneratedImage(url=str(item["url"]), mime=mime))
    return images


# --- OpenRouter ---------------------------------------------------------------------------


def openrouter_body(req: ImageRequest) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": req.model,
        "prompt": req.prompt,
        "aspect_ratio": req.aspect_ratio,
        "resolution": req.resolution,
        "response_format": "b64_json",
    }
    # Models that make one picture at a time reject n > 1, so it is only sent when needed.
    if req.count > 1:
        body["n"] = req.count
    if req.quality != "auto":
        body["quality"] = req.quality
    if req.input_images:
        body["input_references"] = [
            {"type": "image_url", "image_url": {"url": data_url(i.data, i.mime)}}
            for i in req.input_images
        ]
    return body


async def _openrouter(cfg: ProviderConfig, req: ImageRequest) -> ImageResult:
    data = await _post(cfg, "/images", json=openrouter_body(req), headers={"X-Title": "anemo"})
    return ImageResult(_openai_style_images(data), _usage(data.get("usage")))


# --- Google Gemini (OpenAI-compatible endpoint) ----------------------------------------------


def google_body(req: ImageRequest) -> dict[str, Any]:
    # Fields this endpoint does not know are ignored by it; the aspect ratio is one of its
    # documented extra fields.
    return {
        "model": req.model,
        "prompt": req.prompt,
        "n": req.count,
        "response_format": "b64_json",
        "aspect_ratio": req.aspect_ratio,
    }


async def _google(cfg: ProviderConfig, req: ImageRequest) -> ImageResult:
    data = await _post(cfg, "/images/generations", json=google_body(req))
    return ImageResult(_openai_style_images(data), _usage(data.get("usage")))


# --- The fake provider (tests and e2e) -------------------------------------------------------


FAKE_REFUSAL = "refuse"  # a prompt containing this is refused, to test that path


def _fake(req: ImageRequest) -> ImageResult:
    from PIL import Image  # only the fake provider draws pictures itself

    if FAKE_REFUSAL in req.prompt.lower():
        raise ImageError("The image model refused this prompt (test).", refused=True)
    width, height = (int(n) * 64 for n in req.aspect_ratio.split(":"))
    images = []
    for n in range(req.count):
        out = io.BytesIO()
        shade = (40 + 50 * n) % 256
        Image.new("RGB", (width, height), (shade, 120, 200)).save(out, "PNG")
        images.append(GeneratedImage(data=out.getvalue(), mime="image/png"))
    return ImageResult(images, Usage(input_tokens=len(req.prompt.split()), output_tokens=0))


# --- HTTP ------------------------------------------------------------------------------------


def data_url(data: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _b64(value: str) -> bytes:
    if value.startswith("data:"):  # some servers send a data: URL in this field
        value = value.split(",", 1)[-1]
    try:
        return base64.b64decode(value, validate=False)
    except ValueError as exc:
        raise ImageError("The image model sent an image that could not be decoded.") from exc


def _usage(raw: Any) -> Usage:
    """OpenAI reports input/output tokens; OpenRouter prompt/completion tokens and a cost."""
    if not isinstance(raw, dict):
        return Usage()

    def number(*keys: str) -> int | None:
        for key in keys:
            if isinstance(raw.get(key), int):
                return int(raw[key])
        return None

    cost = raw.get("cost")
    return Usage(
        input_tokens=number("input_tokens", "prompt_tokens"),
        output_tokens=number("output_tokens", "completion_tokens"),
        cost_usd=float(cost) if isinstance(cost, (int, float)) else None,
    )


def _client(cfg: ProviderConfig, headers: dict[str, str] | None) -> httpx.AsyncClient:
    """A client for the address the user configured for the provider (not one a model
    chose, so not the SSRF-guarded one; image URLs in answers are, see the service)."""
    all_headers = {**cfg.headers, **(headers or {})}
    if cfg.api_key:
        all_headers["Authorization"] = f"Bearer {cfg.api_key}"
    return httpx.AsyncClient(
        base_url=(cfg.base_url or "").rstrip("/"),
        headers=all_headers,
        timeout=min(cfg.timeout_s, TIMEOUT_S),
        transport=transport_override,
        trust_env=False,
    )


async def _post(
    cfg: ProviderConfig,
    path: str,
    *,
    json: dict[str, Any] | None = None,
    data: dict[str, str] | None = None,
    files: list[tuple[str, tuple[str, bytes, str]]] | None = None,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    if not cfg.base_url:
        raise ImageError("The provider has no address (base URL) set.")
    try:
        async with _client(cfg, headers) as http:
            response = await http.post(path, json=json, data=data, files=files)
            body = response.content[:MAX_RESPONSE_BYTES]
    except httpx.TimeoutException as exc:
        raise ImageError("The image model did not answer in time. Try again later.") from exc
    except httpx.HTTPError as exc:
        raise ImageError(f"Could not reach the image provider: {type(exc).__name__}.") from exc
    try:
        parsed = json_module.loads(body)
    except ValueError:
        parsed = None
    if response.status_code >= 400:
        raise error_for(response.status_code, parsed)
    if not isinstance(parsed, dict):
        raise ImageError("The image provider sent an answer that is not JSON.")
    return parsed


# Codes and words providers use when their content policy declines a request.
_REFUSAL_MARKERS = (
    "moderation_blocked",
    "content_policy",
    "content policy",
    "safety",
    "prohibited",
)


def error_for(status: int, body: Any) -> ImageError:
    """A readable ImageError for an HTTP error answer (body: the parsed JSON, if any)."""
    error = body.get("error") if isinstance(body, dict) else None
    message = ""
    code = ""
    if isinstance(error, dict):
        message = str(error.get("message") or "")
        code = str(error.get("code") or error.get("type") or "")
    elif isinstance(error, str):
        message = error
    detail = _short(message) or f"HTTP {status}"
    text = f"{code} {message}".lower()
    if status in (400, 403, 422) and any(m in text for m in _REFUSAL_MARKERS):
        return ImageError(
            f"The image model refused this request (content policy): {detail}. Change the "
            "prompt; asking again with the same prompt will be refused again.",
            refused=True,
            status=status,
        )
    if status == 401:
        return ImageError(
            "The image provider did not accept the API key. Check it in Settings → "
            "Providers & Models.",
            status=status,
        )
    if status == 402:
        return ImageError(
            f"The image provider says there is no credit left: {detail}.", status=status
        )
    if status == 404:
        return ImageError(
            f"The image provider does not know this model or endpoint: {detail}. Check the "
            "model name in Settings → Providers & Models.",
            status=status,
        )
    if status == 429:
        return ImageError(
            f"The image provider is rate-limiting requests: {detail}. Try again later.",
            status=status,
        )
    if status >= 500:
        return ImageError(
            f"The image provider had an error ({status}): {detail}. Try again later.",
            status=status,
        )
    return ImageError(
        f"The image provider refused the request ({status}): {detail}.", status=status
    )


def _short(text: str, limit: int = 300) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit] + "…"
