"""The plugins shipped with Anemo: one folder per plugin here, named by its id
(`anemo.word-count/anemo-plugin.json`, ...). They install like any other plugin (as
`needs_review`, approved by the user) with the source "bundled"; only they may use ids
starting with `anemo.`.

`anemo.hello` is a tiny plugin the tests use; the real examples are added next to it.
"""

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.features.plugins import package, permissions
from app.features.plugins.manifest import MANIFEST_FILE
from app.features.plugins.models import Plugin
from app.features.plugins.schemas import BundledListOut, BundledPluginOut

FOLDER = Path(__file__).parent


def ids() -> list[str]:
    """The ids of the shipped plugins (folders with a manifest)."""
    return sorted(p.name for p in FOLDER.iterdir() if p.is_dir() and (p / MANIFEST_FILE).is_file())


def files_of(plugin_id: str) -> dict[str, bytes]:
    """A shipped plugin's files, as an upload would give them."""
    if plugin_id not in ids():  # also keeps the id from naming another folder
        raise NotFound(f"Anemo ships no plugin {plugin_id[:64]}", code="plugin_not_found")
    root = FOLDER / plugin_id
    return {
        p.relative_to(root).as_posix(): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file() and not p.name.startswith(".") and "__pycache__" not in p.parts
    }


async def list_out(db: AsyncSession) -> BundledListOut:
    installed = set(await db.scalars(select(Plugin.plugin_id)))
    plugins: list[BundledPluginOut] = []
    for plugin_id in ids():
        report = package.validate_files(files_of(plugin_id))
        if report.manifest is None:
            continue  # a broken example is a bug: its test says so
        manifest = report.manifest
        plugins.append(
            BundledPluginOut(
                id=manifest.id,
                name=manifest.name,
                description=manifest.description,
                version=manifest.version,
                installed=manifest.id in installed,
                permissions=[permissions.permission_info(p) for p in manifest.permissions],
            )
        )
    return BundledListOut(plugins=plugins)
