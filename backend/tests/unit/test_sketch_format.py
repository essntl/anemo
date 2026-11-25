"""Sketch documents: the file format, the drawing's schema and limits, the preview check."""

import io
import json

import pytest
from PIL import Image

from app.core.errors import AppError
from app.features.documents import sketch, sketch_preview


def stroke(i: int = 0, **extra) -> dict:
    return {
        "type": "stroke",
        "id": f"s{i}",
        "tool": "pen",
        "color": "ink",
        "width": 3,
        "points": [0, 0, 0.5, 10, 10, 0.6],
    } | extra


def data(*items: dict, **extra) -> dict:
    return {"v": 1, "layout": "infinite", "items": list(items)} | extra


def test_round_trip_keeps_the_drawing_one_item_a_line():
    d = sketch.SketchData.model_validate(
        data(
            stroke(1),
            {"type": "arrow", "id": "a", "color": "#ff0000", "width": 2, "x1": 0, "y1": 0}
            | {"x2": 5, "y2": 5},
            {"type": "text", "id": "t", "color": "ink", "x": 1, "y": 2, "size": 16, "text": "Hi"},
        )
    )
    content = sketch.new_file("Board", d)
    parsed = sketch.parse(content)
    assert parsed.error is None and parsed.data == d
    assert content.startswith("# Board\n")
    block = content.split("````anemo-sketch\n")[1]
    assert block.count("\n") >= 4  # head, three items, closing line


def test_text_cannot_close_the_block():
    evil = "a\n````\n# Injected\n````anemo-sketch\n{}"
    d = sketch.SketchData.model_validate(
        data({"type": "text", "id": "t", "color": "ink", "x": 0, "y": 0, "size": 12, "text": evil})
    )
    content = sketch.new_file("x", d)
    assert "`" not in content.split("````anemo-sketch\n")[1].split("\n````")[0]
    parsed = sketch.parse(content)
    assert parsed.data is not None and parsed.data.items[0].text == evil  # type: ignore[union-attr]


@pytest.mark.parametrize(
    "bad",
    [
        data(stroke(points=[0, 0, 0.5, 1])),  # not triples
        data(stroke(points=[0, 0, 1.5])),  # pressure out of range
        data(stroke(points=[0, 2e7, 0.5])),  # coordinate out of range
        data(stroke(color="red")),  # not a colour
        data(stroke(color="#fff; background:url(x)")),
        data(stroke(width=0)),
        data(stroke(id="../x")),
        data(stroke(tool="laser")),
        data(stroke(onclick="x")),  # unknown keys
        data(
            {"type": "text", "id": "t", "color": "ink", "x": 0, "y": 0, "size": 12}
            | {"text": "x" * (sketch.MAX_TEXT_CHARS + 1)}
        ),
        data({"type": "image", "id": "i", "color": "ink"}),
        data(stroke(), v=2),
        data(stroke(), layout="spiral"),
        data(stroke(), pages=0),
    ],
)
def test_invalid_drawings_are_refused(bad):
    with pytest.raises(ValueError):
        sketch.parse_data(json.dumps(bad))


def test_nan_and_infinity_are_refused():
    with pytest.raises(ValueError):
        sketch.parse_data(
            '{"v":1,"items":[{"type":"stroke","id":"s","tool":"pen","color":"ink",'
            '"width":1,"points":[NaN,0,0.5]}]}'
        )


def test_limits_on_points_items_and_text():
    big = stroke(points=[1.0, 1.0, 0.5] * (sketch.MAX_POINTS_PER_STROKE + 1))
    with pytest.raises(ValueError):
        sketch.parse_data(json.dumps(data(big)))
    many = [stroke(i, points=[1, 1, 0.5] * 5000) for i in range(sketch.MAX_POINTS // 5000 + 1)]
    with pytest.raises(ValueError, match="points"):
        sketch.parse_data(json.dumps(data(*many)))
    with pytest.raises(ValueError):
        sketch.parse_data(json.dumps(data(*[stroke(i) for i in range(sketch.MAX_ITEMS + 1)])))
    texts = [
        {"type": "text", "id": f"t{i}", "color": "ink", "x": 0, "y": 0, "size": 12}
        | {"text": "x" * sketch.MAX_TEXT_CHARS}
        for i in range(sketch.MAX_TOTAL_TEXT_CHARS // sketch.MAX_TEXT_CHARS + 1)
    ]
    with pytest.raises(ValueError, match="characters"):
        sketch.parse_data(json.dumps(data(*texts)))


def test_a_few_thousand_strokes_fit_in_a_document():
    # About what a pen stroke has once the editor thinned its points (~30).
    pts = [round(v, 1) for i in range(30) for v in (100 + i * 3.7, 200 + i * 1.3, 0.55)]
    d = sketch.SketchData.model_validate(data(*[stroke(i, points=pts) for i in range(3000)]))
    assert len(sketch.new_file("Dense", d).encode()) < 2 * 1024 * 1024


def test_parse_reports_missing_or_broken_drawings():
    assert sketch.parse("# Just text\n").error == "The drawing is missing."
    broken = sketch.parse("# x\n\n````anemo-sketch\n{not json\n````\n")
    assert broken.data is None and "JSON" in (broken.error or "")
    with pytest.raises(AppError) as exc:
        sketch.check("documents/a.sketch.md", "# x\n")
    assert exc.value.code == "sketch_invalid"
    sketch.check("documents/a.md", "# x\n")  # not a sketch: anything goes


def test_drawing_title_and_transcription_edits_keep_the_rest():
    content = "---\nclient: acme\n---\n" + sketch.new_file("Old")
    d = sketch.SketchData.model_validate(data(stroke()))
    content = sketch.with_drawing(content, d)
    content = sketch.with_title(content, "New # title\nline")
    h = sketch.parse(content).drawing_hash
    assert h is not None
    content = sketch.with_transcription(content, "Buy milk", h)
    content = sketch.with_transcription(content, "Buy milk\nand eggs", h)  # replaced, not added
    assert content.startswith("---\nclient: acme\n---\n# New # title line\n")
    assert content.count("## Transcription") == 1
    parsed = sketch.parse(content)
    assert parsed.data == d
    assert parsed.transcription == "Buy milk\nand eggs" and parsed.transcription_hash == h
    # The drawing changes: the transcription stays, now from an earlier version.
    content = sketch.with_drawing(content, sketch.SketchData.model_validate(data(stroke(2))))
    assert sketch.parse(content).transcription_hash != sketch.parse(content).drawing_hash


def test_search_sees_prose_and_text_boxes_not_the_drawing():
    d = sketch.SketchData.model_validate(
        data(
            stroke(),
            {"type": "text", "id": "t", "color": "ink", "x": 0, "y": 0, "size": 12}
            | {"text": "Quarterly plan"},
        )
    )
    content = sketch.with_transcription(sketch.new_file("Board", d), "Ship it", "abc")
    text = sketch.searchable("documents/b.sketch.md", content)
    assert "Quarterly plan" in text and "Ship it" in text and "Board" in text
    assert "points" not in text and "anemo-sketch" not in text
    assert sketch.searchable("documents/b.md", content) == content


def _png(width: int, height: int, fmt: str = "PNG") -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(out, fmt)
    return out.getvalue()


def test_preview_is_checked_and_written_again():
    png, w, h = sketch_preview.clean(_png(40, 30))
    assert (w, h) == (40, 30) and png.startswith(b"\x89PNG")
    _, w, _ = sketch_preview.clean(_png(20, 10, "WEBP"))
    assert w == 20
    for bad in (
        _png(10, 10, "JPEG"),
        _png(sketch_preview.MAX_EDGE + 1, 2),
        b"<svg xmlns='http://www.w3.org/2000/svg'/>",
        b"\x89PNG\r\n\x1a\n" + b"\x00" * 40,  # says PNG, isn't one
        b"\x89PNG" + b"\x00" * sketch_preview.MAX_BYTES,
    ):
        with pytest.raises(AppError) as exc:
            sketch_preview.clean(bad)
        assert exc.value.code == "invalid_preview"
