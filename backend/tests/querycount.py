"""Count the SQL statements a piece of code sends: for tests that pin down the number of
queries (a list endpoint without N+1 queries, a run snapshot that reads settings once)."""

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import event

from app.core.db import get_engine


class Statements(list[str]):
    def matching(self, text: str) -> list[str]:
        """The statements that contain `text` (case-insensitive), e.g. a table name."""
        return [s for s in self if text.lower() in s.lower()]

    @property
    def selects(self) -> list[str]:
        return [s for s in self if s.lstrip().upper().startswith("SELECT")]


@contextmanager
def count_statements() -> Iterator[Statements]:
    """Every statement sent through the app's engine inside the block (all sessions)."""
    seen = Statements()
    engine = get_engine().sync_engine

    def record(conn, cursor, statement, parameters, context, executemany):  # type: ignore[no-untyped-def]
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", record)
