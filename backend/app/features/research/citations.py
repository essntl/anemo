"""Citations in research write-ups.

The model cites sources by number ([S1], [S2, S4], [S1][S3]); code turns those into
Markdown links to the sources and writes the source list itself, so every link points
where it should. A marker for a source that doesn't exist is dropped.
"""

import re
from dataclasses import dataclass

MARKER = re.compile(r"\[(S\d+(?:\s*[,;]\s*S\d+)*)\](?!\()")


@dataclass(frozen=True)
class CitedSource:
    number: int  # 1-based, as the model saw it
    title: str
    url: str
    kind: str = "page"
    note: str = ""
    key: bool = False


def _label(title: str, url: str) -> str:
    text = title.strip() or re.sub(r"^https?://", "", url).split("/")[0] or "source"
    return text.replace("[", "(").replace("]", ")")


def _href(url: str) -> str:
    return url.replace(" ", "%20").replace(")", "%29").replace("(", "%28")


def link(source: CitedSource) -> str:
    return f"[{_label(source.title, source.url)}]({_href(source.url)})"


def cite(text: str, sources: list[CitedSource]) -> str:
    """[S1] → ([Title](url)); [S1, S3] → ([A](u); [B](v)); unknown numbers are dropped."""
    by_number = {s.number: s for s in sources}

    def replace(m: re.Match[str]) -> str:
        numbers = [int(n) for n in re.findall(r"S(\d+)", m.group(1))]
        links = [link(by_number[n]) for n in dict.fromkeys(numbers) if n in by_number]
        return f"({'; '.join(links)})" if links else ""

    out = MARKER.sub(replace, text)
    # Adjacent citations "(a)(b)" read better as one "(a; b)".
    out = re.sub(r"\)\(\[", "; [", out)
    return re.sub(r" +([.,;:])", r"\1", re.sub(r"[ \t]{2,}", " ", out))


def source_list(sources: list[CitedSource]) -> str:
    """The "Sources" section: every source, numbered as in the text, with its note."""
    lines = []
    for s in sorted(sources, key=lambda x: x.number):
        extra = []
        if s.key:
            extra.append("key source")
        if s.kind in ("pdf", "youtube", "selection"):
            extra.append({"pdf": "PDF", "youtube": "video", "selection": "excerpt"}[s.kind])
        tail = f" ({', '.join(extra)})" if extra else ""
        note = f" — {' '.join(s.note.split())}" if s.note.strip() else ""
        lines.append(f"{s.number}. {link(s)}{tail}{note}")
    return "## Sources\n\n" + "\n".join(lines) + "\n"
