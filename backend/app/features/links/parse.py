"""Links between documents, tasks and files, as written in Markdown.

  [Draft](/files?path=projects/thesis/draft.pdf)          a file chip
  ![Photo](/api/files/download?path=files/photo.jpg)      an image shown inline
  [Plan](/documents/<id>)   [Call Anna](/tasks?task=<id>)  documents and tasks

Paths are URL-encoded in links; matching decodes them, so any encoding works.
"""

import re
import uuid
from urllib.parse import quote, unquote

FILE_LINK = re.compile(r"(\((/files\?path=|/api/files/download\?path=))([^)\s#&]+)")
DOC_LINK = re.compile(r"\(/documents/([0-9a-fA-F-]{36})\)")
TASK_LINK = re.compile(r"\(/tasks\?task=([0-9a-fA-F-]{36})\)")


def encode_path(path: str) -> str:
    return quote(path, safe="/")


def file_link(path: str) -> str:
    return f"/files?path={encode_path(path)}"


def files_in(text: str) -> set[str]:
    return {unquote(m.group(3)) for m in FILE_LINK.finditer(text or "")}


def doc_ids_in(text: str) -> set[uuid.UUID]:
    return {uuid.UUID(m.group(1)) for m in DOC_LINK.finditer(text or "")}


def task_ids_in(text: str) -> set[uuid.UUID]:
    return {uuid.UUID(m.group(1)) for m in TASK_LINK.finditer(text or "")}


def moved(path: str, old: str, new: str) -> str | None:
    """Where `path` is after `old` moved to `new` (a file, or a folder and what is in it)."""
    if path == old:
        return new
    if path.startswith(old.rstrip("/") + "/"):
        return new.rstrip("/") + path[len(old.rstrip("/")) :]
    return None


def rewrite_file_links(text: str, old: str, new: str) -> str:
    """The text with links to `old` (or into it, for a folder) pointing at `new`."""

    def repl(m: re.Match[str]) -> str:
        target = moved(unquote(m.group(3)), old, new)
        return m.group(1) + encode_path(target) if target is not None else m.group(0)

    return FILE_LINK.sub(repl, text)


def mentions_file(text: str, path: str) -> bool:
    return any(p == path for p in files_in(text))
