"""Async SQLAlchemy engine and session helpers."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from app.core.config import get_settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine, _sessionmaker
    if _engine is None:
        _engine = create_async_engine(
            get_settings().database_url, pool_size=10, max_overflow=10, pool_pre_ping=True
        )
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    get_engine()
    assert _sessionmaker is not None
    return _sessionmaker


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """Session for code outside request handlers (worker, CLI). Commits on success."""
    async with get_sessionmaker()() as session:
        try:
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


def read_sync[T](
    lookup: Callable[[AsyncSession], Awaitable[T]], *, timeout: float = 1.0
) -> T | None:
    """Run a read-only lookup from code that can't wait for the database (Tool.actions(),
    which builds the approval card): on a short connection of its own, in another
    thread, for at most `timeout` seconds. None when it fails or takes longer: the
    caller then shows what it was given."""

    async def run() -> T:
        engine = create_async_engine(get_settings().database_url, poolclass=NullPool)
        try:
            async with AsyncSession(engine) as db:
                return await lookup(db)
        finally:
            await engine.dispose()

    pool = ThreadPoolExecutor(max_workers=1)
    try:
        return pool.submit(asyncio.run, run()).result(timeout=timeout)
    except Exception:  # noqa: BLE001 - unknown: the caller falls back to the plain value
        return None
    finally:
        pool.shutdown(wait=False, cancel_futures=True)  # a slow lookup doesn't hold the card
