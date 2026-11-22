"""What the phone says out loud: an answer as plain text, shortened (pure, no IO).

The agent's answer is Markdown, written for the screen. Read out, the marks, links and
code are noise, and a long answer is too long to listen to. So: Markdown out, then cut
at a sentence end near the limit, followed by "The rest is in the chat."
"""

import re
from dataclasses import dataclass

REST_IN_CHAT = "The rest is in the chat."
NOTHING_TO_SAY = "Done. The answer is in the chat."
FAILED = "Sorry, that didn't work; the details are in the chat."
CANCELLED = "The request was stopped."

# A sentence end this far back from the limit, or later, is "near" it.
_NEAR = 0.5

_FENCE = re.compile(r"^\s*(```|~~~).*?^\s*\1[^\n]*$", re.M | re.S)
_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_REF_LINK = re.compile(r"\[([^\]]+)\]\[[^\]]*\]")
_URL = re.compile(r"<?https?://[^\s>)]+>?")
_CITATION = re.compile(r"\[\d+(?:\s*,\s*\d+)*\]")
_HTML = re.compile(r"</?[a-zA-Z][^>]*>")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+", re.M)
_QUOTE = re.compile(r"^\s*>\s?", re.M)
_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?", re.M)
_RULE = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$", re.M)
_TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$", re.M)
_EMPHASIS = re.compile(r"(\*\*|\*|~~)(?=\S)(.+?)(?<=\S)\1")
_UNDERSCORES = re.compile(r"(?<!\w)(__|_)(?=\S)(.+?)(?<=\S)\1(?!\w)")  # not snake_case
_CODE = re.compile(r"`+([^`]*)`+")
_SENTENCE_END = re.compile(r"[.!?…](?:[\"”’)\]]*)(?=\s|$)")


@dataclass(frozen=True)
class Spoken:
    text: str  # plain text to speak
    more: bool  # the answer was shortened (or had parts that can't be read out)


def plain(markdown: str) -> tuple[str, bool]:
    """The Markdown as text to read out, and whether something was left out (code)."""
    text, blocks = _FENCE.subn("", markdown)
    text = _IMAGE.sub("", text)
    text = _LINK.sub(r"\1", text)
    text = _REF_LINK.sub(r"\1", text)
    text = _URL.sub("", text)
    text = _CITATION.sub("", text)
    text = _HTML.sub("", text)
    text = _TABLE_RULE.sub("", text)
    text = _RULE.sub("", text)
    text = _HEADING.sub("", text)
    text = _QUOTE.sub("", text)
    text = _BULLET.sub("", text)
    text = _CODE.sub(r"\1", text)
    for _ in range(2):  # nested emphasis (***bold italic***)
        text = _UNDERSCORES.sub(r"\2", _EMPHASIS.sub(r"\2", text))
    lines = []
    for raw in text.splitlines():
        # A table row is read as its cells, one after the other.
        line = ", ".join(c.strip() for c in raw.strip().strip("|").split("|") if c.strip())
        if not line:
            continue
        # A heading or list item read out needs a pause after it, as a sentence has.
        if not re.search(r"[.!?…:;,][\"”’)\]]*$", line):
            line += "."
        lines.append(line)
    text = re.sub(r"\s+", " ", " ".join(lines)).strip()
    text = re.sub(r"\s+([.,!?;:])", r"\1", text)
    return text, blocks > 0


def _cut(text: str, limit: int) -> str:
    """At most `limit` characters, ending at a sentence end near the limit when there is
    one, else at a word boundary."""
    head = text[: limit + 1]
    ends = [m.end() for m in _SENTENCE_END.finditer(head) if m.end() <= limit]
    if ends and ends[-1] >= limit * _NEAR:
        return text[: ends[-1]].strip()
    words = text[:limit].rsplit(" ", 1)[0].rstrip(" ,;:-–—")
    return words + "…"


def shorten(markdown: str, limit: int) -> Spoken:
    """A completed run's answer as the phone speaks it."""
    text, left_out = plain(markdown)
    if not text:
        return Spoken(NOTHING_TO_SAY, bool(markdown.strip()))
    if len(text) <= limit and not left_out:
        return Spoken(text, False)
    if len(text) > limit:
        text = _cut(text, limit)
    return Spoken(f"{text} {REST_IN_CHAT}", True)


def for_run(status: str, answer: str, limit: int) -> Spoken:
    """What to say when a voice run ends: its answer, or one sentence when it didn't
    complete."""
    if status == "completed":
        return shorten(answer, limit)
    if status == "cancelled":
        return Spoken(CANCELLED, False)
    return Spoken(FAILED, False)
