"""Text for the model from files it cannot read natively.

Used for chat attachments (features/attachments/service.py) and for the agent's
read_file on workspace files. Each extractor returns (text, note): the note says
what was left out (a cut, scanned pages, ...) and is shown to the model too.

  pdf          pypdf, text layer only (no OCR)
  document     .docx: paragraphs (headings as Markdown) and tables, in order
  spreadsheet  .xlsx / .xlsm: every sheet as a table of its values
  presentation .pptx: the text of each slide, and its speaker notes
  archive      .zip: the list of files, and the text of small text files in it

Everything here reads untrusted bytes, so sizes are bounded before anything is
decompressed (a small zip can expand to gigabytes).
"""

import csv
import io
import re
import zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET  # noqa: S405 - only parses, see _parse_xml

MAX_CHARS = 120_000
MAX_PDF_PAGES = 300
MAX_SHEET_ROWS = 2_000  # per sheet
MAX_SHEET_COLS = 60
MAX_ZIP_LISTED = 500
MAX_ZIP_TEXT_MEMBER = 200_000  # uncompressed bytes of one text file shown from a zip
MAX_XML_BYTES = 30 * 1024 * 1024  # one part of an Office file, uncompressed

# Office files are zips; their extension says which kind (checked against the content).
OFFICE_SUFFIXES = {
    ".docx": "document",
    ".docm": "document",
    ".xlsx": "spreadsheet",
    ".xlsm": "spreadsheet",
    ".pptx": "presentation",
    ".pptm": "presentation",
}
OFFICE_MARKER = {  # a part every file of that kind has
    "document": "word/document.xml",
    "spreadsheet": "xl/workbook.xml",
    "presentation": "ppt/presentation.xml",
}
TEXT_SUFFIXES = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml",
    ".toml", ".xml", ".html", ".htm", ".css", ".log", ".ini", ".cfg", ".conf",
    ".env.example", ".sql", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".py", ".ipynb",
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".go", ".rs", ".java", ".kt", ".c",
    ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".lua", ".r", ".vue",
    ".svelte", ".dockerfile", ".tex", ".rst", ".srt", ".vtt", ".svg", ".gitignore",
}  # fmt: skip


class ExtractionError(Exception):
    """The file is damaged, encrypted or not what its name says."""


def office_kind(filename: str, data: bytes) -> str | None:
    """'document' | 'spreadsheet' | 'presentation' when this is a real Office file."""
    kind = OFFICE_SUFFIXES.get(PurePosixPath(filename.lower()).suffix)
    if kind is None or not data.startswith(b"PK"):
        return None
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = set(zf.namelist())
    except zipfile.BadZipFile:
        return None
    return kind if OFFICE_MARKER[kind] in names else None


def is_zip(data: bytes) -> bool:
    if not data.startswith(b"PK"):
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            zf.infolist()
    except zipfile.BadZipFile:
        return False
    return True


def looks_like_text(filename: str, head: bytes) -> bool:
    name = filename.lower()
    suffix = PurePosixPath(name).suffix
    known = suffix in TEXT_SUFFIXES or PurePosixPath(name).name in {
        "dockerfile",
        "makefile",
        "readme",
        "license",
    }
    return known and b"\x00" not in head


def extract(kind: str, data: bytes) -> tuple[str, str | None]:
    """(text, note) for a file of a kind decided by the caller."""
    match kind:
        case "pdf":
            text, note = _pdf(data)
        case "document":
            text, note = _docx(data)
        case "spreadsheet":
            text, note = _xlsx(data)
        case "presentation":
            text, note = _pptx(data)
        case "archive":
            text, note = _zip(data)
        case _:
            text, note = data.decode("utf-8", errors="replace"), None
    return _truncate(text, note)


def _truncate(text: str, note: str | None) -> tuple[str, str | None]:
    if len(text) <= MAX_CHARS:
        return text, note
    cut = f"Truncated to the first {MAX_CHARS:,} characters."
    return text[:MAX_CHARS], f"{note} {cut}" if note else cut


# --- PDF ---------------------------------------------------------------------------


def _pdf(data: bytes) -> tuple[str, str | None]:
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(data))
        pages = reader.pages
        parts: list[str] = []
        note = None
        for i, page in enumerate(pages):
            if i >= MAX_PDF_PAGES:
                note = f"Only the first {MAX_PDF_PAGES} pages were read."
                break
            parts.append(page.extract_text() or "")
    except Exception as exc:  # noqa: BLE001 - corrupt or encrypted PDFs
        raise ExtractionError(f"Could not read the PDF: {exc}") from exc
    text = "\n\n".join(p.strip() for p in parts if p.strip())
    if not text:
        note = "No text found (the PDF may be scanned images; OCR is not supported yet)."
    return text, note


# --- Office ------------------------------------------------------------------------


def _open_zip(data: bytes) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ExtractionError("The file is damaged or not an Office file") from exc


def _read_member(zf: zipfile.ZipFile, name: str, limit: int = MAX_XML_BYTES) -> bytes | None:
    try:
        info = zf.getinfo(name)
    except KeyError:
        return None
    if info.file_size > limit:
        raise ExtractionError(f"A part of the file is too large to read ({name})")
    with zf.open(info) as f:
        return f.read(limit + 1)[:limit]


def _parse_xml(raw: bytes) -> ET.Element:
    # The stdlib parser does not fetch external entities; refuse DTDs altogether so
    # entity expansion ("billion laughs") cannot blow up memory either.
    if b"<!DOCTYPE" in raw[:4096] or b"<!ENTITY" in raw:
        raise ExtractionError("The file contains a DTD, which is not allowed")
    try:
        return ET.fromstring(raw)  # noqa: S314 - DTDs refused above
    except ET.ParseError as exc:
        raise ExtractionError(f"The file is damaged ({exc})") from exc


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def _w_text(el: ET.Element) -> str:
    out: list[str] = []
    for node in el.iter():
        if node.tag == f"{W}t" and node.text:
            out.append(node.text)
        elif node.tag == f"{W}tab":
            out.append("\t")
        elif node.tag in (f"{W}br", f"{W}cr"):
            out.append("\n")
    return "".join(out)


def _docx(data: bytes) -> tuple[str, str | None]:
    with _open_zip(data) as zf:
        raw = _read_member(zf, "word/document.xml")
        if raw is None:
            raise ExtractionError("Not a Word document (word/document.xml is missing)")
        body = _parse_xml(raw).find(f"{W}body")
    if body is None:
        return "", "The document is empty."
    blocks: list[str] = []
    for child in body:
        if child.tag == f"{W}p":
            text = _w_text(child).strip()
            if not text:
                continue
            style = child.find(f"{W}pPr/{W}pStyle")
            name = (style.get(f"{W}val") or "") if style is not None else ""
            level = re.match(r"(?i)heading\s*(\d)", name) or re.match(r"(?i)title$", name)
            if level:
                depth = int(level.group(1)) if level.groups() else 1
                text = "#" * min(depth, 6) + " " + text
            elif child.find(f"{W}pPr/{W}numPr") is not None:
                text = "- " + text
            blocks.append(text)
        elif child.tag == f"{W}tbl":
            rows = [
                [_w_text(cell).strip().replace("\n", " ") for cell in row.findall(f"{W}tc")]
                for row in child.findall(f"{W}tr")
            ]
            if rows:
                blocks.append(_markdown_table(rows))
    text = "\n\n".join(blocks)
    return text, None if text else "The document has no text."


def _markdown_table(rows: list[list[str]]) -> str:
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]

    def line(cells: list[str]) -> str:
        return "| " + " | ".join(c.replace("|", "\\|") for c in cells) + " |"

    return "\n".join([line(rows[0]), line(["---"] * width), *(line(r) for r in rows[1:])])


def _cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _xlsx(data: bytes) -> tuple[str, str | None]:
    from openpyxl import load_workbook

    # A cheap guard before openpyxl decompresses everything.
    with _open_zip(data) as zf:
        if sum(i.file_size for i in zf.infolist()) > 20 * MAX_XML_BYTES:
            raise ExtractionError("The spreadsheet is too large to read")
    try:
        # data_only: the values Excel last calculated (formulas are not evaluated here).
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:  # noqa: BLE001 - damaged or password-protected
        raise ExtractionError(f"Could not read the spreadsheet: {exc}") from exc
    parts: list[str] = []
    notes: list[str] = []
    try:
        for ws in wb.worksheets:
            rows: list[list[str]] = []
            total = 0
            for row in ws.iter_rows(values_only=True):
                total += 1
                if len(rows) >= MAX_SHEET_ROWS:
                    continue
                rows.append([_cell(v) for v in row[:MAX_SHEET_COLS]])
            # Trailing empty rows and columns are formatting, not data.
            while rows and not any(rows[-1]):
                rows.pop()
            width = max(
                (max((i + 1 for i, c in enumerate(r) if c), default=0) for r in rows), default=0
            )
            rows = [r[:width] for r in rows]
            header = f"## Sheet: {ws.title}"
            if not rows:
                parts.append(f"{header}\n(empty)")
                continue
            buf = io.StringIO()
            csv.writer(buf, lineterminator="\n").writerows(rows)
            parts.append(f"{header} ({total} rows x {width} columns, as CSV)\n{buf.getvalue()}")
            if total > MAX_SHEET_ROWS:
                notes.append(f"'{ws.title}': only the first {MAX_SHEET_ROWS:,} of {total:,} rows.")
            if ws.max_column and ws.max_column > MAX_SHEET_COLS:
                notes.append(f"'{ws.title}': only the first {MAX_SHEET_COLS} columns.")
    finally:
        wb.close()
    note = " ".join(notes) or None
    return "\n\n".join(parts), note


def _slide_number(name: str) -> int:
    m = re.search(r"(\d+)\.xml$", name)
    return int(m.group(1)) if m else 0


def _a_text(raw: bytes) -> str:
    root = _parse_xml(raw)
    paragraphs = []
    for p in root.iter(f"{A}p"):
        text = "".join(t.text or "" for t in p.iter(f"{A}t")).strip()
        if text:
            paragraphs.append(text)
    return "\n".join(paragraphs)


def _pptx(data: bytes) -> tuple[str, str | None]:
    with _open_zip(data) as zf:
        names = zf.namelist()
        slides = sorted(
            (n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=_slide_number
        )
        parts = []
        for name in slides:
            n = _slide_number(name)
            text = _a_text(_read_member(zf, name) or b"<x/>")
            notes_raw = _read_member(zf, f"ppt/notesSlides/notesSlide{n}.xml")
            notes = _a_text(notes_raw) if notes_raw else ""
            # Notes slides repeat the slide number as text; keep only real notes.
            notes = "\n".join(line for line in notes.splitlines() if line.strip() != str(n))
            section = f"## Slide {n}\n{text or '(no text)'}"
            if notes:
                section += f"\n\nSpeaker notes:\n{notes}"
            parts.append(section)
    text = "\n\n".join(parts)
    return text, None if parts else "The presentation has no slides."


# --- zip ---------------------------------------------------------------------------


def _size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def _zip(data: bytes) -> tuple[str, str | None]:
    with _open_zip(data) as zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        total = sum(i.file_size for i in infos)
        lines = [f"{len(infos)} files, {_size(total)} uncompressed:"]
        lines += [f"- {i.filename} ({_size(i.file_size)})" for i in infos[:MAX_ZIP_LISTED]]
        note = None
        if len(infos) > MAX_ZIP_LISTED:
            note = f"Only the first {MAX_ZIP_LISTED} of {len(infos)} files are listed."
        # The text of small text files, while there is room.
        budget = MAX_CHARS // 2
        shown: list[str] = []
        for info in infos:
            if budget <= 0:
                break
            if info.flag_bits & 0x1:  # encrypted
                continue
            if info.file_size > MAX_ZIP_TEXT_MEMBER:
                continue
            if not looks_like_text(info.filename, b""):
                continue
            with zf.open(info) as f:
                raw = f.read(MAX_ZIP_TEXT_MEMBER + 1)
            if b"\x00" in raw[:8192]:
                continue
            text = raw.decode("utf-8", errors="replace")[:budget]
            budget -= len(text)
            shown.append(f'<file path="{info.filename}">\n{text}\n</file>')
    body = "\n".join(lines)
    if shown:
        body += "\n\nText files in the archive:\n" + "\n".join(shown)
    return body, note
