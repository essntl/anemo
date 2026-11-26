"""The image generation clients (providers/images.py) and the service helpers that need
no database: request shapes per provider, answers, errors, checks on what is saved.
HTTP is answered by a mock transport: no network, no real keys."""

import base64
import io
import json
from datetime import datetime

import httpx
import pytest
from PIL import Image

from app.features.image_generation import service
from app.policy.engine import evaluate
from app.policy.models import Action, Policy, Rule
from app.providers import images
from app.providers.base import ProviderConfig
from app.providers.catalog import guess_capabilities

KEY = "sk-test-not-a-real-key"


def png(width: int = 8, height: int = 8) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (200, 10, 10)).save(out, "PNG")
    return out.getvalue()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


class Recorder:
    """Answers every request with `response` and keeps the requests."""

    def __init__(self, response: httpx.Response) -> None:
        self.response = response
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        return self.response

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def json(self) -> dict:
        return json.loads(self.last.content)


@pytest.fixture
def answer(monkeypatch):
    """answer(response) installs a recorder that gives this response to every request."""

    def install(response: httpx.Response) -> Recorder:
        recorder = Recorder(response)
        monkeypatch.setattr(images, "transport_override", httpx.MockTransport(recorder))
        return recorder

    return install


def cfg(kind: str, base: str = "https://api.example.test/v1") -> ProviderConfig:
    return ProviderConfig(type=kind, base_url=base, api_key=KEY)


def ok_with(*pictures: bytes, **extra) -> httpx.Response:
    return httpx.Response(200, json={"data": [{"b64_json": b64(p)} for p in pictures], **extra})


# --- OpenAI ------------------------------------------------------------------------------


async def test_openai_generation_request_and_answer(answer):
    rec = answer(ok_with(png(), png(), usage={"input_tokens": 12, "output_tokens": 4160}))
    req = images.ImageRequest(
        model="gpt-image-1.5", prompt="a fox", count=2, aspect_ratio="16:9", quality="high"
    )
    result = await images.generate(cfg("openai"), req)

    assert rec.last.method == "POST"
    assert str(rec.last.url) == "https://api.example.test/v1/images/generations"
    assert rec.last.headers["authorization"] == f"Bearer {KEY}"
    assert rec.json() == {
        "model": "gpt-image-1.5",
        "prompt": "a fox",
        "n": 2,
        "size": "1536x1024",
        "quality": "high",
    }
    assert [i.data for i in result.images] == [png(), png()]
    assert (result.usage.input_tokens, result.usage.output_tokens) == (12, 4160)
    assert result.size == "1536x1024"


@pytest.mark.parametrize(
    ("ratio", "size"),
    [("1:1", "1024x1024"), ("4:3", "1536x1024"), ("3:2", "1536x1024"), ("9:16", "1024x1536")],
)
def test_openai_size_is_the_nearest_supported_one(ratio, size):
    assert images.openai_size(ratio) == size


def test_openai_auto_quality_is_not_sent_and_dalle_asks_for_base64():
    body = images.openai_body(images.ImageRequest(model="gpt-image-2", prompt="x"))
    assert "quality" not in body and "response_format" not in body
    legacy = images.openai_body(images.ImageRequest(model="dall-e-3", prompt="x"))
    assert legacy["response_format"] == "b64_json"


async def test_openai_edit_sends_the_input_images_as_multipart(answer):
    rec = answer(ok_with(png()))
    source = images.InputImage(png(), "image/png", "fox.png")
    req = images.ImageRequest(model="gpt-image-1.5", prompt="darker", input_images=[source])
    await images.generate(cfg("openai"), req)

    assert str(rec.last.url) == "https://api.example.test/v1/images/edits"
    assert rec.last.headers["content-type"].startswith("multipart/form-data")
    body = rec.last.content
    assert b'name="image[]"; filename="fox.png"' in body
    assert b'name="prompt"\r\n\r\ndarker' in body
    assert b'name="model"\r\n\r\ngpt-image-1.5' in body
    assert png() in body


async def test_an_openai_compatible_server_may_answer_with_a_url(answer):
    answer(httpx.Response(200, json={"data": [{"url": "https://cdn.example.test/1.png"}]}))
    req = images.ImageRequest(model="flux-dev", prompt="x")
    result = await images.generate(cfg("openai_compatible", "http://localai:8080/v1"), req)
    assert result.images[0].url == "https://cdn.example.test/1.png"
    assert result.images[0].data is None


# --- OpenRouter and Google ------------------------------------------------------------------


async def test_openrouter_request_and_cost(answer):
    rec = answer(
        ok_with(png(), usage={"prompt_tokens": 9, "completion_tokens": 1290, "cost": 0.039})
    )
    source = images.InputImage(png(), "image/png", "fox.png")
    req = images.ImageRequest(
        model="google/gemini-2.5-flash-image",
        prompt="a fox",
        aspect_ratio="3:4",
        resolution="2K",
        input_images=[source],
    )
    result = await images.generate(cfg("openrouter", "https://openrouter.ai/api/v1"), req)

    assert str(rec.last.url) == "https://openrouter.ai/api/v1/images"
    assert rec.last.headers["x-title"] == "anemo"
    body = rec.json()
    assert body["aspect_ratio"] == "3:4" and body["resolution"] == "2K"
    assert body["response_format"] == "b64_json"
    assert "n" not in body  # one picture: models that make one at a time refuse n
    assert body["input_references"] == [
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64(png())}"}}
    ]
    assert result.usage.cost_usd == 0.039
    assert result.usage.output_tokens == 1290


def test_openrouter_sends_n_only_for_more_than_one():
    body = images.openrouter_body(images.ImageRequest(model="m", prompt="x", count=3))
    assert body["n"] == 3


async def test_google_uses_the_openai_compatible_endpoint(answer):
    rec = answer(ok_with(png()))
    base = "https://generativelanguage.googleapis.com/v1beta/openai"
    req = images.ImageRequest(model="gemini-2.5-flash-image", prompt="x", aspect_ratio="16:9")
    await images.generate(cfg("google", base), req)
    assert str(rec.last.url) == f"{base}/images/generations"
    assert rec.json() == {
        "model": "gemini-2.5-flash-image",
        "prompt": "x",
        "n": 1,
        "response_format": "b64_json",
        "aspect_ratio": "16:9",
    }


async def test_google_cannot_edit_and_says_so(answer):
    rec = answer(ok_with(png()))
    source = images.InputImage(png(), "image/png", "fox.png")
    req = images.ImageRequest(model="gemini-2.5-flash-image", prompt="x", input_images=[source])
    with pytest.raises(images.ImageError, match="cannot edit"):
        await images.generate(cfg("google"), req)
    assert rec.requests == []  # nothing was sent (or paid for)


async def test_providers_without_images_are_refused():
    with pytest.raises(images.ImageError, match="cannot make images"):
        await images.generate(cfg("anthropic"), images.ImageRequest(model="claude", prompt="x"))


async def test_the_fake_provider_draws_without_a_network():
    result = await images.generate(
        cfg("fake", "x"), images.ImageRequest(model="fake", prompt="x", count=2)
    )
    assert len(result.images) == 2
    assert all(service.check_picture(i.data or b"").mime == "image/png" for i in result.images)


# --- errors ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "body", "refused", "words"),
    [
        (
            400,
            {"error": {"code": "moderation_blocked", "message": "Your request was rejected"}},
            True,
            "content policy",
        ),
        (
            400,
            {"error": {"code": 400, "message": "Prompt flagged by safety system"}},
            True,
            "Change the prompt",
        ),
        (401, {"error": {"message": "Incorrect API key"}}, False, "API key"),
        (402, {"error": {"code": 402, "message": "Insufficient credits"}}, False, "no credit"),
        (404, {"error": {"message": "model not found"}}, False, "model name"),
        (429, {"error": {"message": "slow down"}}, False, "Try again later"),
        (502, {"error": {"code": 502, "message": "Generation failed"}}, False, "Try again later"),
        (400, {"error": {"message": "size must be one of ..."}}, False, "size must be"),
    ],
)
async def test_http_errors_become_readable_messages(answer, status, body, refused, words):
    answer(httpx.Response(status, json=body))
    with pytest.raises(images.ImageError) as caught:
        await images.generate(cfg("openai"), images.ImageRequest(model="gpt-image-1.5", prompt="x"))
    assert caught.value.refused is refused
    assert words in str(caught.value)
    assert KEY not in str(caught.value)


async def test_a_timeout_and_a_non_json_answer_are_readable(monkeypatch, answer):
    def slow(request):
        raise httpx.ReadTimeout("timed out", request=request)

    monkeypatch.setattr(images, "transport_override", httpx.MockTransport(slow))
    with pytest.raises(images.ImageError, match="did not answer in time"):
        await images.generate(cfg("openai"), images.ImageRequest(model="m", prompt="x"))

    answer(httpx.Response(200, text="<html>oops</html>"))
    with pytest.raises(images.ImageError, match="not JSON"):
        await images.generate(cfg("openai"), images.ImageRequest(model="m", prompt="x"))


async def test_an_answer_without_images_is_an_error(monkeypatch):
    async def no_pictures(cfg, req):
        return images.ImageResult([], images.Usage())

    monkeypatch.setattr(service.image_api, "generate", no_pictures)
    model = type("Model", (), {"config": cfg("fake", "x")})()
    with pytest.raises(images.ImageError, match="without an image"):
        await service.make_images(
            model, images.ImageRequest(model="m", prompt="x"), service.WebSettings()
        )


# --- what is saved -------------------------------------------------------------------------


def test_only_real_images_are_kept():
    assert service.check_picture(png(3, 2)).extension == "png"
    jpeg = io.BytesIO()
    Image.new("RGB", (4, 4)).save(jpeg, "JPEG")
    assert service.check_picture(jpeg.getvalue()).mime == "image/jpeg"
    for bad in (b"", b"<svg xmlns='http://www.w3.org/2000/svg'/>", b"MZ\x90\x00 not a picture"):
        with pytest.raises(images.ImageError):
            service.check_picture(bad)
    tiff = io.BytesIO()
    Image.new("RGB", (4, 4)).save(tiff, "TIFF")
    with pytest.raises(images.ImageError, match="TIFF"):
        service.check_picture(tiff.getvalue())
    with pytest.raises(images.ImageError):
        service.check_picture(png()[:40])  # cut off


def test_file_names_and_folders():
    assert service.slug("A red fox, at dawn!") == "a-red-fox-at-dawn"
    assert service.slug("!!!") == "image"
    assert len(service.slug("word " * 40)) <= 40
    day = datetime(2026, 11, 24, 9, 30)
    assert service.default_folder(None, day) == "files/generated/2026-11-24"
    assert service.default_folder("projects/thesis", day) == "projects/thesis/generated/2026-11-24"


def test_guessing_image_models_by_name():
    for key in (
        "gpt-image-1.5",
        "gpt-image-2",
        "dall-e-3",
        "gemini-2.5-flash-image",
        "gemini-3-pro-image-preview",
        "black-forest-labs/flux-1.1-pro",
    ):
        caps = guess_capabilities(key)
        assert caps["image_generation"] and not caps["chat"] and not caps["tools"], key
    for key in ("gpt-5", "gemini-2.5-flash", "claude-sonnet-5"):
        assert not guess_capabilities(key)["image_generation"], key


def test_automations_ask_only_makes_it_stricter():
    allow = Policy(name="p", rules=[Rule(cap="image.generate", decision="allow")])
    deny = Policy(name="p", rules=[Rule(cap="image.generate", decision="deny")])
    probe = Action(capability="image.generate")
    assert evaluate(probe, service.ask_in_automations(allow)).decision == "ask"
    assert evaluate(probe, service.ask_in_automations(deny)).decision == "deny"
    assert service.ask_in_automations(deny) is deny
