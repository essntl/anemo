"""Large tool outputs.

A tool result longer than MAX_MODEL_CHARS is not sent to the model in full: the
model gets the beginning and the end, and the complete text is saved under
DATA_PATH/tool-outputs/<run>/<tool call>.txt. The agent can page through it with
the read_tool_output tool, and the user can download it from the run's history.
"""

import shutil
import uuid
from pathlib import Path

from app.core.config import get_settings

MAX_MODEL_CHARS = 16_000
HEAD_CHARS = 11_000
TAIL_CHARS = 4_000
MAX_SAVED_CHARS = 20_000_000


def _root() -> Path:
    return Path(get_settings().data_path) / "tool-outputs"


def output_path(run_id: uuid.UUID, call_id: uuid.UUID) -> Path:
    # Both parts are UUIDs, so the path cannot leave the outputs folder.
    return _root() / str(run_id) / f"{call_id}.txt"


def clip(run_id: uuid.UUID, call_id: uuid.UUID, content: str) -> tuple[str, int | None]:
    """Returns (text for the model, saved length or None when nothing was saved)."""
    if len(content) <= MAX_MODEL_CHARS:
        return content, None
    content = content[:MAX_SAVED_CHARS]
    path = output_path(run_id, call_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    omitted = len(content) - HEAD_CHARS - TAIL_CHARS
    note = (
        f"\n\n[... {omitted:,} characters omitted. The full output ({len(content):,} characters) "
        f'is saved: call read_tool_output with call_id "{call_id}" and an offset to read '
        "more of it.]\n\n"
    )
    return content[:HEAD_CHARS] + note + content[-TAIL_CHARS:], len(content)


def read(run_id: uuid.UUID, call_id: uuid.UUID, offset: int, limit: int) -> tuple[str, int] | None:
    """A slice of a saved output and its total length, or None if there is none."""
    path = output_path(run_id, call_id)
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8")
    return text[offset : offset + limit], len(text)


def delete_for_runs(run_ids: list[uuid.UUID]) -> None:
    for run_id in run_ids:
        shutil.rmtree(_root() / str(run_id), ignore_errors=True)
