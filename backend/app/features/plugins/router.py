"""Plugins over HTTP (docs/specs/CONTRACTS-plugins.md §7): Settings > Plugins, the
review, and the host of plugin frames in Anemo's page. Login required; installing and
approving also need the password entered in the last 15 minutes (RecentAuth), because a
plugin can get network access and unattended code.

The frame document itself is public: frame_router.py. "Continue building with the
assistant" (POST /{plugin}/chat) is chat_router.py.
"""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request, UploadFile
from fastapi.responses import Response

from app.api.deps import Db, RecentAuth, client_ip
from app.core.errors import AppError
from app.features.plugins import bundled, calls, package, service
from app.features.plugins.models import Plugin
from app.features.plugins.schemas import (
    BundledInstallIn,
    BundledListOut,
    GitInstallIn,
    PluginApproveIn,
    PluginCallIn,
    PluginCallOut,
    PluginContributionsOut,
    PluginDataOut,
    PluginDetailOut,
    PluginDiffOut,
    PluginFrameBundleOut,
    PluginListOut,
    PluginOut,
    PluginPatchIn,
)

router = APIRouter(prefix="/plugins", tags=["plugins"])

MAX_ZIP = 10 * 1024 * 1024  # compressed; what it unpacks to is capped by package.read_zip


def git_fetcher() -> package.GitFetcher:
    """The fetcher Git installs use (tests replace it)."""
    return package.CliGitFetcher()


# Fixed paths first: "/contributions" and "/bundled" are not plugin ids.


@router.get("", response_model=PluginListOut)
async def list_plugins(db: Db) -> PluginListOut:
    return await service.list_out(db)


@router.get("/contributions", response_model=PluginContributionsOut)
async def contributions(db: Db) -> PluginContributionsOut:
    """What the slots render: enabled plugins' approved versions only."""
    return await service.contributions(db)


@router.get("/bundled", response_model=BundledListOut)
async def list_bundled(db: Db) -> BundledListOut:
    return await bundled.list_out(db)


@router.post("/install/zip", response_model=PluginDetailOut, status_code=201)
async def install_zip(file: UploadFile, request: Request, db: Db, _: RecentAuth) -> PluginDetailOut:
    data = await file.read(MAX_ZIP + 1)
    if len(data) > MAX_ZIP:
        raise AppError("A plugin's zip can be at most 10 MB", code="file_too_large")
    version = await service.install_zip(
        db, data, file.filename or "plugin.zip", ip=client_ip(request)
    )
    return await _detail_of(db, version.plugin_id)


@router.post("/install/git", response_model=PluginDetailOut, status_code=201)
async def install_git(
    body: GitInstallIn, request: Request, db: Db, _: RecentAuth
) -> PluginDetailOut:
    version = await service.install_git(
        db, body.url, body.ref, fetcher=git_fetcher(), ip=client_ip(request)
    )
    return await _detail_of(db, version.plugin_id)


@router.post("/install/bundled", response_model=PluginDetailOut, status_code=201)
async def install_bundled(
    body: BundledInstallIn, request: Request, db: Db, _: RecentAuth
) -> PluginDetailOut:
    version = await service.install_bundled(db, body.id, ip=client_ip(request))
    return await _detail_of(db, version.plugin_id)


async def _detail_of(db: Db, plugin_row_id: uuid.UUID) -> PluginDetailOut:
    plugin = await db.get(Plugin, plugin_row_id)
    assert plugin is not None
    return await service.detail(db, plugin)


@router.get("/{plugin}", response_model=PluginDetailOut)
async def get_plugin(plugin: str, db: Db) -> PluginDetailOut:
    return await service.detail(db, await service.get_plugin(db, plugin))


@router.patch("/{plugin}", response_model=PluginOut)
async def switch_plugin(plugin: str, body: PluginPatchIn, request: Request, db: Db) -> PluginOut:
    row = await service.get_plugin(db, plugin)
    await service.set_enabled(db, row, body.enabled, ip=client_ip(request))
    return await service.plugin_out(db, row)


@router.post("/{plugin}/versions/{version}/approve", response_model=PluginDetailOut)
async def approve_version(
    plugin: str, version: str, body: PluginApproveIn, request: Request, db: Db, _: RecentAuth
) -> PluginDetailOut:
    row = await service.get_plugin(db, plugin)
    await service.approve(db, row, version, body.hash, enable=body.enable, ip=client_ip(request))
    return await service.detail(db, row)


@router.delete("/{plugin}/versions/{version}", status_code=204)
async def reject_version(plugin: str, version: str, request: Request, db: Db) -> None:
    row = await service.get_plugin(db, plugin)
    await service.reject(db, row, version, ip=client_ip(request))


@router.get("/{plugin}/versions/{version}/diff", response_model=PluginDiffOut)
async def version_diff(
    plugin: str,
    version: str,
    db: Db,
    against: Annotated[
        str | None, Query(max_length=40, description="Default: the approved one")
    ] = None,
) -> PluginDiffOut:
    return await service.diff(db, await service.get_plugin(db, plugin), version, against)


@router.get(
    "/{plugin}/versions/{version}/files/{path:path}",
    response_class=Response,
    responses={200: {"content": {"text/plain": {}, "image/png": {}, "image/webp": {}}}},
)
async def version_file(plugin: str, version: str, path: str, db: Db) -> Response:
    """One file of a version, for the host and the code view. Never rendered: text is
    text/plain, and nothing in it may run (CSP default-src 'none')."""
    data, media, digest = await service.file_content(
        db, await service.get_plugin(db, plugin), version, path
    )
    return Response(
        data,
        media_type=media,
        headers={
            "Content-Security-Policy": "default-src 'none'",
            "X-Content-Type-Options": "nosniff",
            "X-Plugin-File-Sha256": digest,
            "Cache-Control": "private, no-cache",
        },
    )


@router.get("/{plugin}/versions/{version}/ui/{ui}", response_model=PluginFrameBundleOut)
async def frame_bundle(plugin: str, version: str, ui: str, db: Db) -> PluginFrameBundleOut:
    return await service.frame_bundle(db, await service.get_plugin(db, plugin), version, ui)


@router.get("/{plugin}/data", response_model=PluginDataOut)
async def plugin_data(plugin: str, db: Db) -> PluginDataOut:
    return await service.data_summary(db, await service.get_plugin(db, plugin))


@router.delete("/{plugin}", status_code=204)
async def uninstall(
    plugin: str, request: Request, db: Db, data: Literal["keep", "remove"] = "keep"
) -> None:
    row = await service.get_plugin(db, plugin)
    await service.uninstall(db, row, keep=data == "keep", ip=client_ip(request))


@router.post("/{plugin}/call", response_model=PluginCallOut)
async def plugin_call(plugin: str, body: PluginCallIn, db: Db) -> PluginCallOut:
    """A call from one of the plugin's frames, checked again here (§6.4). An error has
    the contract's code; `confirm_required` carries {token, summary, risk}."""
    row = await service.get_plugin(db, plugin)
    result = await calls.call(
        db,
        row,
        ui=body.ui,
        method=body.method,
        params=body.params,
        confirm_token=body.confirm_token,
        preview_version=body.preview_version,
    )
    return PluginCallOut(result=result)
