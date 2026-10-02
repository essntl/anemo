"""HTTP API entrypoint: `uvicorn app.main_api:app`.

The API never runs model calls for chat/agent turns itself; it enqueues work
for the worker and streams events back to the browser.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from app import __version__
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
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs" if settings.env != "production" else None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    install_error_handlers(app)
    app.add_middleware(OriginCheckMiddleware)
    # Compress the app's JavaScript and JSON answers (about a third of the size on the
    # wire). Event streams are left alone by this middleware, so they stay live.
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.include_router(api_router)
    _mount_spa(app, Path(settings.static_dir))
    return app


class _ImmutableFiles(StaticFiles):
    """The build's assets have their content hash in the file name, so a browser may
    keep them for good: a new build has new names."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


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
        app.mount("/assets", _ImmutableFiles(directory=static_dir / "assets"), name="assets")

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
        headers = {"Cache-Control": "no-cache"}
        if path.startswith("s/"):
            # A share link: its address is the secret. Keep it out of search engines and
            # out of the Referer sent to sites the shared text links to.
            headers |= {"Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow"}
        return FileResponse(index, headers=headers)


app = create_app()
