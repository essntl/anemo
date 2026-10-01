"""Web & Search settings helpers: status and a test for the SearXNG connection.
Saving goes through PUT /api/settings/web (a security-sensitive section)."""

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api.deps import Db
from app.core.config import get_settings
from app.features.settings import service as settings_service
from app.web.search import SearchError, SearXNG
from app.web.settings import WebSettings

router = APIRouter(prefix="/web", tags=["web"])


class WebStatus(BaseModel):
    search_configured: bool
    env_searxng_url: str | None  # SEARXNG_URL from .env, used when the setting is empty


@router.get("/status", response_model=WebStatus)
async def status(db: Db) -> WebStatus:
    web = await settings_service.get_section(db, WebSettings, "web")
    return WebStatus(
        search_configured=bool(web.search_url()), env_searxng_url=get_settings().searxng_url or None
    )


class SearchTestIn(BaseModel):
    searxng_url: str | None = Field(None, max_length=500)  # test this (unsaved) URL
    query: str = Field("open source", min_length=1, max_length=200)


class SearchTestResult(BaseModel):
    title: str
    url: str


class SearchTestOut(BaseModel):
    ok: bool
    message: str
    results: list[SearchTestResult] = []


@router.post("/test-search", response_model=SearchTestOut)
async def test_search(body: SearchTestIn, db: Db) -> SearchTestOut:
    saved = await settings_service.get_section(db, WebSettings, "web")
    try:
        web = (
            saved.model_copy(
                update={"searxng_url": WebSettings(searxng_url=body.searxng_url or "").searxng_url}
            )
            if body.searxng_url
            else saved
        )
    except ValueError:
        return SearchTestOut(ok=False, message="The URL must start with http:// or https://.")
    url = web.search_url()
    if not url:
        return SearchTestOut(ok=False, message="No SearXNG URL is set.")
    try:
        results = await SearXNG(url, web).search(body.query, max_results=5)
    except SearchError as exc:
        return SearchTestOut(ok=False, message=str(exc))
    if not results:
        return SearchTestOut(
            ok=True,
            message="SearXNG answered, but with no results. Check that search engines are enabled.",
        )
    return SearchTestOut(
        ok=True,
        message=f"Works: {len(results)} results for “{body.query}”.",
        results=[SearchTestResult(title=r.title, url=r.url) for r in results],
    )
