"""HTTP API entrypoint: `uvicorn app.main_api:app`.

The API never runs model calls for chat/agent turns itself; it enqueues work
for the worker and streams events back to the browser.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from app.api.router import api_router
from app.api.security import OriginCheckMiddleware
from app.core.config import get_settings
from app.core.db import dispose_engine
from app.core.errors import install_error_handlers
from app.core.logging import configure_logging
from app.core.redis import close_redis
from app.features.auth.service import warn_if_plaintext_password


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    warn_if_plaintext_password()
    yield
    await dispose_engine()
    await close_redis()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)
    app = FastAPI(
        title="anemo",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/api/docs" if settings.env != "production" else None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    install_error_handlers(app)
    app.add_middleware(OriginCheckMiddleware)
    app.include_router(api_router)
    _mount_spa(app, Path(settings.static_dir))
    return app


_ALWAYS_REVALIDATE = {
    "sw.js": "text/javascript",
    "manifest.webmanifest": "application/manifest+json",
}


def _mount_spa(app: FastAPI, static_dir: Path) -> None:
    """Serve the built React app; unknown non-API paths fall back to index.html."""
    static_dir = static_dir.resolve()
    index = static_dir / "index.html"
    if not index.exists():
        return
    if (static_dir / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="assets")

    # Sync handler: FastAPI runs it in a threadpool, so filesystem checks don't block the loop.
    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> Response:
        if path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = (static_dir / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(static_dir):
            if path in _ALWAYS_REVALIDATE:
                # The service worker and manifest must update as soon as a new build ships.
                return FileResponse(
                    candidate,
                    media_type=_ALWAYS_REVALIDATE[path],
                    headers={"Cache-Control": "no-cache"},
                )
            return FileResponse(candidate)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


app = create_app()
