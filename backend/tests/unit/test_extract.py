"""Text extraction from Office files and zips (features/attachments/extract.py)."""

import io
import zipfile

import pytest

from app.features.attachments import extract
from app.features.attachments.service import UnsupportedFile, classify
from tests.office_files import docx, pptx, xlsx, zip_of


def test_docx_headings_paragraphs_and_tables():
    data = docx("Budget", "Numbers for Q3.", [["Item", "Cost"], ["Rent", "1200"]])
    assert extract.office_kind("plan.docx", data) == "document"
    text, note = extract.extract("document", data)
    assert text.startswith("# Budget\n\nNumbers for Q3.")
    assert "| Item | Cost |\n| --- | --- |\n| Rent | 1200 |" in text
    assert note is None


def test_xlsx_every_sheet_as_csv():
    data = xlsx({"Sales": [["Month", "Total"], ["Jan", 10], ["Feb", 12.5]], "Empty": []})
    assert extract.office_kind("q3.xlsx", data) == "spreadsheet"
    text, _ = extract.extract("spreadsheet", data)
    assert "## Sheet: Sales (3 rows x 2 columns, as CSV)\nMonth,Total\nJan,10\nFeb,12.5" in text
    assert "## Sheet: Empty\n(empty)" in text


def test_xlsx_long_sheets_are_cut_with_a_note(monkeypatch):
    monkeypatch.setattr(extract, "MAX_SHEET_ROWS", 3)
    data = xlsx({"Big": [[i] for i in range(10)]})
    text, note = extract.extract("spreadsheet", data)
    assert text.strip().endswith("0\n1\n2")
    assert note and "first 3 of 10 rows" in note


def test_pptx_slides_in_order_with_notes():
    data = pptx([("Welcome", "Say hello"), ("Agenda", "")])
    assert extract.office_kind("deck.pptx", data) == "presentation"
    text, _ = extract.extract("presentation", data)
    assert text == "## Slide 1\nWelcome\n\nSpeaker notes:\nSay hello\n\n## Slide 2\nAgenda"


def test_zip_lists_files_and_shows_small_text_files():
    data = zip_of({"src/app.py": "print('hi')", "logo.bin": b"\x00\x01", "docs/": ""})
    text, _ = extract.extract("archive", data)
    assert "2 files" in text and "- src/app.py" in text and "- logo.bin" in text
    assert "<file path=\"src/app.py\">\nprint('hi')\n</file>" in text
    assert "\x00" not in text


def test_zip_does_not_inflate_large_members(monkeypatch):
    monkeypatch.setattr(extract, "MAX_ZIP_TEXT_MEMBER", 100)
    data = zip_of({"big.txt": "x" * 10_000})
    text, _ = extract.extract("archive", data)
    assert "- big.txt" in text and "xxxx" not in text


def test_damaged_and_hostile_office_files_are_refused():
    with pytest.raises(extract.ExtractionError):
        extract.extract("document", b"PK\x03\x04 not really a zip")
    dtd = (
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]>'
        f'<w:document xmlns:w="{"http://schemas.openxmlformats.org/wordprocessingml/2006/main"}">'
        "<w:body><w:p><w:r><w:t>&a;</w:t></w:r></w:p></w:body></w:document>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("word/document.xml", dtd)
    with pytest.raises(extract.ExtractionError, match="DTD"):
        extract.extract("document", buf.getvalue())


def test_classify():
    assert classify("a.docx", "", docx("H", "p", [["x"]])) == "document"
    assert classify("a.xlsx", "", xlsx({"S": [[1]]})) == "spreadsheet"
    assert classify("a.pptx", "", pptx([("x", "")])) == "presentation"
    assert classify("a.zip", "application/zip", zip_of({"a.txt": "a"})) == "archive"
    # A zip that is not an Office file keeps its own kind, whatever it is called.
    assert classify("fake.docx", "", zip_of({"a.txt": "a"})) == "file"
    assert classify("notes", "", b"plain words, no extension") == "text"
    assert classify("data.sqlite", "", b"SQLite format 3\x00" + b"\x00" * 100) == "file"
    assert classify("song.mp3", "audio/mpeg", b"ID3\x04\x00\x00\x00\x00\x00\xff\xfe") == "file"
    with pytest.raises(UnsupportedFile):
        classify("fake.png", "image/png", b"PK\x03\x04" + b"\x00" * 20)
