"""`file.created`: a new file written in the workspace through Anemo (an upload, an agent,
the extension, a document).

`app.workspace.files.write_bytes` is synchronous and usually runs in a worker thread
(`asyncio.to_thread`), outside any database transaction, so it calls a hook instead of
`emit`. The hook hands the event to the event loop the process runs on, with who wrote
the file and at what trigger depth (the thread has a copy of the caller's context),
and doesn't wait for it: a lost event never holds up a write.
"""

import asyncio
import logging
from concurrent.futures import Future

from app.core.actor import current_actor
from app.features.triggers import events
from app.workspace import files

log = logging.getLogger(__name__)

_loop: asyncio.AbstractEventLoop | None = None
_in_flight: set[Future[None]] = set()  # kept until done (a task nobody holds may vanish)


def _created(path: str, size: int, mime: str) -> None:
    loop = _loop
    if loop is None or loop.is_closed():
        return
    try:
        coro = events.emit_now(
            "file.created",
            {"path": path, "size": size, "mime": mime},
            subject=path,
            actor=current_actor(),
            depth=events.current_depth(),
        )
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        _in_flight.add(future)
        future.add_done_callback(_in_flight.discard)
    except RuntimeError:  # the loop is shutting down
        log.debug("file event not emitted")


def install(loop: asyncio.AbstractEventLoop) -> None:
    """Emit `file.created` on this loop (the process's own; called once it runs)."""
    global _loop
    _loop = loop
    if _created not in files.created_hooks:
        files.created_hooks.append(_created)
