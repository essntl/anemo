"""Turns model citation markup into Markdown links.

Some models (notably OpenAI's) were trained with a private citation syntax and
use it even when asked not to, e.g.

    ... is doubtful. citeturn0search3turn0search2

The characters U+E200-U+E202 are invisible, so users see "citeturn0search3...".
Web tools label their results with matching refs (turn<N>search<i>, turn<N>fetch0)
and the run keeps the list of sources, so the markers can be replaced by numbered
links ([1](url)) plus a Sources list. Other markup in this syntax (entities, ...)
is reduced to its text or removed.
"""

import json
import re
from typing import Any

START, SEP, END = "", "", ""
_MARKUP = re.compile(f"{START}([^{END}]*){END}")
_DANGLING = re.compile(f"{START}[^{END}]*$")  # cut off at the end (still streaming)
_STRAY = re.compile(f"[{START}{SEP}{END}]")


def _entity_text(parts: list[str]) -> str:
    """entity markup: a JSON array like ["people", "Albert Einstein", "physicist"]."""
    try:
        data = json.loads(SEP.join(parts))
    except ValueError:
        return ""
    if isinstance(data, list) and len(data) > 1 and isinstance(data[1], str):
        return data[1]
    return ""


def render(text: str, sources: list[dict[str, Any]] | None = None) -> str:
    """Replace citation markup in `text`; cited sources are listed at the end."""
    if START not in text and SEP not in text and END not in text:
        return text
    by_ref = {s["ref"]: s for s in sources or [] if s.get("ref") and s.get("url")}
    numbers: dict[str, int] = {}  # url -> number, in order of first citation
    cited: list[dict[str, Any]] = []

    def replace(match: re.Match[str]) -> str:
        kind, *parts = match.group(1).split(SEP)
        if kind == "entity":
            return _entity_text(parts)
        if kind not in ("cite", "filecite"):
            return ""
        links = []
        for ref in parts:
            source = by_ref.get(ref.strip())
            if source is None:
                continue
            url = source["url"]
            if url not in numbers:
                numbers[url] = len(numbers) + 1
                cited.append(source)
            links.append(f"[[{numbers[url]}]]({url})")
        if not links:
            return ""
        # Usually the model put a space before the markup already.
        space = "" if match.start() > 0 and text[match.start() - 1].isspace() else " "
        return space + " ".join(dict.fromkeys(links))

    out = _MARKUP.sub(replace, text)
    out = _STRAY.sub("", _DANGLING.sub("", out))
    # "doubtful [[1]](url) ." -> "doubtful [[1]](url)." (only right after a citation)
    out = re.sub(r"(\[\[\d+\]\]\([^)\s]+\))[ \t]+([.,;:!?])", r"\1\2", out)
    if cited:
        listing = "\n".join(
            f"{numbers[s['url']]}. [{s.get('title') or s['url']}]({s['url']})" for s in cited
        )
        out = f"{out.rstrip()}\n\n**Sources**\n\n{listing}\n"
    return out


def next_turn(sources: list[dict[str, Any]]) -> int:
    """Number for the next web tool call's refs (0, 1, 2, ... within a run)."""
    return max((int(s.get("turn", -1)) for s in sources), default=-1) + 1
