import io

import pytest
from PIL import Image

from app.features.attachments.images import MAX_EDGE, NotAnImage, prepare
from app.providers.base import ImageBlock, Message, TextBlock
from app.runtime.history import estimate_tokens


def encode(img: Image.Image, fmt: str) -> bytes:
    out = io.BytesIO()
    img.save(out, fmt)
    return out.getvalue()


def test_small_png_is_passed_through_unchanged():
    data = encode(Image.new("RGB", (40, 30), "red"), "PNG")
    image = prepare(data)
    assert image.data == data and image.mime == "image/png"
    assert (image.width, image.height, image.resized) == (40, 30, False)


def test_large_photo_is_scaled_down_keeping_aspect_ratio():
    image = prepare(encode(Image.new("RGB", (4000, 2000), "blue"), "JPEG"))
    assert image.mime == "image/jpeg" and image.resized
    assert (image.width, image.height) == (MAX_EDGE, MAX_EDGE // 2)


def test_transparency_is_kept_as_png():
    image = prepare(encode(Image.new("RGBA", (3000, 100), (0, 0, 0, 0)), "PNG"))
    assert image.mime == "image/png" and image.width == MAX_EDGE


def test_other_formats_are_converted():
    image = prepare(encode(Image.new("RGB", (20, 20), "green"), "BMP"))
    assert image.mime == "image/jpeg" and not image.resized
    Image.open(io.BytesIO(image.data)).verify()


def test_garbage_is_rejected():
    with pytest.raises(NotAnImage):
        prepare(b"definitely not an image")


def test_images_count_as_a_fixed_token_cost_not_their_base64_length():
    big = ImageBlock(media_type="image/png", data="A" * 2_000_000)
    tokens = estimate_tokens([Message(role="user", content=[TextBlock(text="hi"), big])])
    assert tokens < 2_000
