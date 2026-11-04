"""Small, valid Office files and zips built in memory for tests."""

import io
import zipfile

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"


def _zip(parts: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in parts.items():
            zf.writestr(name, data)
    return buf.getvalue()


def docx(heading: str, paragraph: str, table: list[list[str]]) -> bytes:
    rows = "".join(
        "<w:tr>"
        + "".join(f"<w:tc><w:p><w:r><w:t>{c}</w:t></w:r></w:p></w:tc>" for c in row)
        + "</w:tr>"
        for row in table
    )
    body = (
        f'<w:document xmlns:w="{W_NS}"><w:body>'
        f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>{heading}</w:t></w:r></w:p>'
        f"<w:p><w:r><w:t>{paragraph}</w:t></w:r></w:p>"
        f"<w:tbl>{rows}</w:tbl>"
        "</w:body></w:document>"
    )
    return _zip({"[Content_Types].xml": "<Types/>", "word/document.xml": body})


def pptx(slides: list[tuple[str, str]]) -> bytes:
    """slides: (slide text, speaker notes)."""
    parts: dict[str, str | bytes] = {
        "[Content_Types].xml": "<Types/>",
        "ppt/presentation.xml": f'<p:presentation xmlns:p="{P_NS}"/>',
    }
    for i, (text, notes) in enumerate(slides, 1):
        parts[f"ppt/slides/slide{i}.xml"] = (
            f'<p:sld xmlns:p="{P_NS}" xmlns:a="{A_NS}">'
            f"<a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:sld>"
        )
        if notes:
            parts[f"ppt/notesSlides/notesSlide{i}.xml"] = (
                f'<p:notes xmlns:p="{P_NS}" xmlns:a="{A_NS}">'
                f"<a:p><a:r><a:t>{notes}</a:t></a:r></a:p><a:p><a:r><a:t>{i}</a:t></a:r></a:p>"
                "</p:notes>"
            )
    return _zip(parts)


def xlsx(sheets: dict[str, list[list[object]]]) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    wb.remove(wb.active)
    for title, rows in sheets.items():
        ws = wb.create_sheet(title)
        for row in rows:
            ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def zip_of(files: dict[str, str | bytes]) -> bytes:
    return _zip(files)
