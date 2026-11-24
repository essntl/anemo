"""The content checks of appearance uploads (features/appearance/files.py)."""

import io

import pytest
from PIL import Image

from app.features.appearance import files
from app.features.appearance.files import Crop, InvalidFile


def image_bytes(fmt: str, size=(40, 30), colour=(200, 30, 30), **save) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, colour).save(out, fmt, **save)
    return out.getvalue()


def animated_gif() -> bytes:
    frames = [Image.new("RGB", (20, 20), c) for c in [(255, 0, 0), (0, 255, 0), (0, 0, 255)]]
    out = io.BytesIO()
    frames[0].save(out, "GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
    return out.getvalue()


def jpeg_with_gps() -> bytes:
    exif = Image.Exif()
    exif[0x010F] = "PhoneMaker"  # Make
    exif[0x8825] = {1: "N", 2: (51.0, 30.0, 0.0)}  # GPS IFD
    return image_bytes("JPEG", exif=exif.tobytes())


SVG = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
WEBM = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm\x42\x87" + b"\0" * 200
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\0" * 200
AVIF_BOX = b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1miaf" + b"\0" * 200
WOFF2 = b"wOF2" + b"\0" * 100


@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP", "GIF", "AVIF"])
def test_still_pictures_are_re_encoded_as_webp(fmt):
    prepared = files.prepare_background(image_bytes(fmt))
    assert prepared.media == "image" and prepared.mime == "image/webp"
    assert Image.open(io.BytesIO(prepared.data)).format == "WEBP"


def test_re_encoding_drops_exif_and_location():
    data = jpeg_with_gps()
    assert Image.open(io.BytesIO(data)).getexif()  # the test file really has it
    prepared = files.prepare_background(data)
    out = Image.open(io.BytesIO(prepared.data))
    assert not out.getexif() and "exif" not in out.info


def test_large_pictures_are_scaled_down():
    prepared = files.prepare_background(image_bytes("PNG", size=(5000, 1000)))
    assert Image.open(io.BytesIO(prepared.data)).size == (3840, 768)


def test_animated_pictures_are_kept_with_a_still():
    data = animated_gif()
    prepared = files.prepare_background(data)
    assert prepared.media == "animated" and prepared.mime == "image/gif"
    assert prepared.data == data
    poster = Image.open(io.BytesIO(prepared.extras["poster.webp"]))
    assert poster.format == "WEBP" and not getattr(poster, "is_animated", False)


def test_videos_are_recognised_by_their_header():
    assert files.prepare_background(WEBM).mime == "video/webm"
    assert files.prepare_background(MP4).mime == "video/mp4"


@pytest.mark.parametrize(
    "data",
    [SVG, b"  \n<svg onload=alert(1)>", b"\xef\xbb\xbf<svg/>", b"<!doctype html><script>"],
)
def test_svg_and_markup_are_refused(data):
    for prepare in (files.prepare_background, files.prepare_font):
        with pytest.raises(InvalidFile) as exc:
            prepare(data)
        assert exc.value.code == "svg_not_allowed"
    with pytest.raises(InvalidFile):
        files.prepare_avatar(data, Crop())


def test_the_name_and_declared_type_dont_count():
    # A font sent as a "video", or an AVIF still image's container: not a video.
    assert files.video_type(WOFF2) is None
    assert files.video_type(AVIF_BOX) is None
    with pytest.raises(InvalidFile) as exc:
        files.prepare_background(WOFF2)
    assert exc.value.code == "unsupported_type"
    with pytest.raises(InvalidFile):
        files.prepare_background(b"PK\x03\x04 a zip, not a picture")


def test_fonts_by_magic_bytes():
    assert files.font_type(WOFF2) == ("font/woff2", "woff2")
    assert files.font_type(b"wOFF....") == ("font/woff", "woff")
    assert files.font_type(b"\x00\x01\x00\x00....") == ("font/ttf", "ttf")
    assert files.font_type(b"OTTO....") == ("font/otf", "otf")
    assert files.prepare_font(WOFF2).mime == "font/woff2"
    with pytest.raises(InvalidFile) as exc:
        files.prepare_font(image_bytes("PNG"))
    assert exc.value.code == "unsupported_type"


def test_caps():
    with pytest.raises(InvalidFile) as exc:
        files.prepare_font(b"wOF2" + b"\0" * files.MAX_FONT_BYTES)
    assert exc.value.code == "file_too_large"
    with pytest.raises(InvalidFile) as exc:
        files.prepare_background(WEBM + b"\0" * files.MAX_VIDEO_BYTES)
    assert exc.value.code == "file_too_large"
    with pytest.raises(InvalidFile) as exc:
        files.prepare_font(b"")
    assert exc.value.code == "empty_file"


def test_crop_box_stays_a_square_inside_the_picture():
    assert files.crop_box(400, 200, Crop(0, 0, 1)) == (0, 0, 200, 200)
    assert files.crop_box(400, 200, Crop(0.5, 0, 0.5)) == (200, 0, 300, 100)
    # Sticking out on the right and the bottom: moved back in.
    assert files.crop_box(400, 200, Crop(0.9, 0.9, 0.5)) == (300, 100, 400, 200)


def test_avatar_sizes_and_crop():
    # Left half red, right half blue: a crop of the right square is blue.
    img = Image.new("RGB", (200, 100), (255, 0, 0))
    img.paste((0, 0, 255), (100, 0, 200, 100))
    out = io.BytesIO()
    img.save(out, "PNG")
    prepared = files.prepare_avatar(out.getvalue(), Crop(0.5, 0, 1))
    big = Image.open(io.BytesIO(prepared.data)).convert("RGB")
    assert big.size == (256, 256)
    r, g, b = big.getpixel((128, 128))
    assert b > 200 and r < 50
    assert {name: Image.open(io.BytesIO(d)).size for name, d in prepared.extras.items()} == {
        "64.webp": (64, 64),
        "128.webp": (128, 128),
    }
