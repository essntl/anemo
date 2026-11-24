"""Scripts: automations whose runs execute code instead of asking a model
(docs/specs/08-automation-scripts.md).

A script is an automation of kind "script". Its code lives in versions
(`ScriptVersion`, never changed once saved); only the version the user approved, by its
hash (`Automation.script_hash`), ever runs.

  save_version()  a new version: approved at once when the user saved it in the app;
                  otherwise (an agent's create_script / update_script) unapproved, and
                  the script is switched off until the user has looked at it
  approve()       the user approves the version they looked at (by its hash)
  discard()       the user throws a pending version away
  script_out()    the approved and the pending version (for the diff), the owner, secrets
  load_approved() the worker loads the version a run executes, checking its hash

Running a script is runtime/script_run.py (worker side).
"""

import hashlib
import json
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError, Conflict, NotFound
from app.features.automations import service
from app.features.automations.models import Automation, ScriptSecret, ScriptVersion
from app.features.automations.schemas import (
    AutomationIn,
    ScriptCode,
    ScriptCreateIn,
    ScriptOut,
    ScriptSecretOut,
    ScriptVersionOut,
)
from app.features.provenance import service as provenance
from app.features.provenance.schemas import ActorOut
from app.features.secrets import service as secrets
from app.features.secrets.models import Secret

# The script tools themselves (tools/builtin/scripts.py): a script never calls them, and
# a think step never gets them.
SCRIPT_TOOL_NAMES = frozenset(
    {"list_scripts", "read_script", "create_script", "update_script", "run_script"}
)
# Tools that need a model, a chat or a person at the screen, or that would let a script
# make schedules: refused when a version is saved (and again by the worker).
NOT_FOR_SCRIPTS = frozenset(
    {
        "ask_user",
        "update_plan",
        "run_subagent",
        "load_skill",
        "read_tool_output",
        "save_attachment",
        "attach_file",
        "browser_current_tab",
        "create_schedule",
        "update_schedule",
        "delete_schedule",
    }
)
SECRET_KIND = "script"  # noqa: S105 - the kind of the secrets rows, not a secret


def version_hash(code: ScriptCode | ScriptVersion) -> str:
    """The hash of everything the user reviews: the code and what it may use."""
    content = {
        "code": code.code,
        "tools": list(code.tools),
        "hosts": list(code.hosts),
        "secrets": list(code.secrets),
        "think_tools": list(code.think_tools),
    }
    raw = json.dumps(content, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def folder(automation_id: uuid.UUID) -> Path:
    """The script's own folder, the only one its code can read and write (kept between
    runs, outside the workspace, deleted with the automation)."""
    return Path(get_settings().data_path) / "scripts" / str(automation_id)


def _unique(names: list[str]) -> list[str]:
    return list(dict.fromkeys(n.strip() for n in names))


def _cleaned(code: ScriptCode) -> ScriptCode:
    return ScriptCode(
        code=code.code,
        tools=_unique(code.tools),
        hosts=_unique(code.hosts),
        secrets=_unique(code.secrets),
        think_tools=_unique(code.think_tools),
    )


async def _known_tools(db: AsyncSession) -> set[str]:
    # Imported here: the tool registry imports the script tools, which import this module.
    from app.tools import mcp_tool, registry
    from app.tools.builtin.browser import BROWSER_TOOLS
    from app.tools.builtin.computer import COMPUTER_TOOLS

    refs, _ = await mcp_tool.snapshot(db)
    names = {t.name for t in registry.all_tools()} | {
        t.name for t in await mcp_tool.for_run(db, refs)
    }
    # The browser and the computers need a session and a device the run sets up.
    return names - {t.name for t in [*BROWSER_TOOLS, *COMPUTER_TOOLS]}


async def check_code(db: AsyncSession, code: ScriptCode) -> None:
    """Refuse tools a script can't use (unknown ones, the script tools, those that need
    a model or a person). Raises AppError."""
    known = await _known_tools(db)
    for field, names in (("tools", code.tools), ("think_tools", code.think_tools)):
        refused = sorted(n for n in names if n in SCRIPT_TOOL_NAMES or n in NOT_FOR_SCRIPTS)
        if refused:
            raise AppError(
                f"A script can't use these tools: {', '.join(refused)}",
                code="script_tool_refused",
                details={"field": field, "tools": refused},
            )
        unknown = sorted(n for n in names if n not in known)
        if unknown:
            raise AppError(
                f"Unknown tools: {', '.join(unknown)}",
                code="unknown_tool",
                details={"field": field, "tools": unknown},
            )


def remove_folder(automation_id: uuid.UUID) -> None:
    """After the automation is deleted: its folder goes too."""
    shutil.rmtree(folder(automation_id), ignore_errors=True)


# -- versions -----------------------------------------------------------------------------


async def versions(db: AsyncSession, automation_id: uuid.UUID) -> list[ScriptVersion]:
    rows = await db.scalars(
        select(ScriptVersion)
        .where(ScriptVersion.automation_id == automation_id)
        .order_by(ScriptVersion.number)
    )
    return list(rows)


def _approved_of(automation: Automation, found: list[ScriptVersion]) -> ScriptVersion | None:
    for version in reversed(found):
        if version.hash == automation.script_hash and version.approved_at is not None:
            return version
    return None


def _pending_of(found: list[ScriptVersion], approved: ScriptVersion | None) -> ScriptVersion | None:
    """The newest version, when it is newer than the approved one."""
    newest = found[-1] if found else None
    if newest is None or (approved is not None and newest.number <= approved.number):
        return None
    return newest


async def approved_and_pending(
    db: AsyncSession, automation: Automation
) -> tuple[ScriptVersion | None, ScriptVersion | None]:
    found = await versions(db, automation.id)
    approved = _approved_of(automation, found)
    return approved, _pending_of(found, approved)


async def save_version(
    db: AsyncSession, automation: Automation, code: ScriptCode, *, by: str, approve: bool
) -> ScriptVersion:
    """Save a new version (`by`: who, as an actor reference). `approve`: the user saved it
    in the app. Otherwise it waits for review and the script is switched off at once.
    Saving the same as the newest version again adds nothing. Adds to the caller's
    transaction (the caller commits)."""
    if automation.kind != "script":
        raise AppError("This automation is not a script", code="not_a_script")
    code = _cleaned(code)
    await check_code(db, code)
    digest = version_hash(code)
    found = await versions(db, automation.id)
    newest = found[-1] if found else None
    if newest is not None and newest.hash == digest:
        version = newest
    else:
        version = ScriptVersion(
            automation_id=automation.id,
            number=(newest.number + 1) if newest else 1,
            code=code.code,
            tools=code.tools,
            hosts=code.hosts,
            secrets=code.secrets,
            think_tools=code.think_tools,
            hash=digest,
            created_by=by,
        )
        db.add(version)
    if approve:
        version.approved_at = version.approved_at or datetime.now(UTC)
        automation.script_hash = version.hash
    elif automation.script_hash != version.hash:
        # Code nobody has looked at yet: nothing runs until the user approves it.
        automation.enabled, automation.next_run_at = False, None
    await db.flush()
    return version


async def create(
    db: AsyncSession, data: ScriptCreateIn, *, by: str, approve: bool, created_by: str
) -> Automation:
    """A new script automation, switched off, with its first version. `created_by`:
    "user" or "agent" (as for schedules). Adds to the caller's transaction."""
    body = AutomationIn(
        name=data.name,
        prompt=data.description.strip() or data.name,
        schedule=data.schedule,
        enabled=False,
        profile_id=data.profile_id,
        model_id=data.model_id,
        project_id=data.project_id,
        on_ask=data.on_ask,
        notify=data.notify,
        max_retries=data.max_retries,
        max_tool_calls=data.max_tool_calls,
        max_runtime_s=data.max_runtime_s,
        chat_retention_days=data.chat_retention_days,
    )
    automation = await service.create(db, body, created_by=created_by)
    automation.kind = "script"
    await save_version(db, automation, data, by=by, approve=approve)
    return automation


async def approve(
    db: AsyncSession, automation: Automation, digest: str, *, enable: bool
) -> ScriptVersion:
    """The user approves the pending version they looked at (`digest`: its hash). Refused
    when a newer one arrived meanwhile. Adds to the caller's transaction."""
    approved, pending = await approved_and_pending(db, automation)
    if pending is None:
        if approved is not None and approved.hash == digest:
            version = approved  # already approved (a second click)
        else:
            raise Conflict("There is no change waiting for review", code="no_pending_script")
    elif pending.hash != digest:
        raise Conflict(
            "The script was changed again in the meantime: review the new version",
            code="script_changed",
        )
    else:
        version = pending
        version.approved_at = datetime.now(UTC)
        automation.script_hash = version.hash
    if enable and not automation.enabled:
        automation.enabled = True
        service.reschedule(automation)
    await db.flush()
    return version


async def discard(db: AsyncSession, automation: Automation) -> None:
    """Throw away what waits for review (every version newer than the approved one). A
    script that was never approved keeps its versions: there would be nothing left."""
    approved, pending = await approved_and_pending(db, automation)
    if pending is None:
        raise Conflict("There is no change waiting for review", code="no_pending_script")
    if approved is None:
        raise Conflict(
            "This script has no approved version to go back to: delete it instead",
            code="nothing_to_go_back_to",
        )
    await db.execute(
        delete(ScriptVersion).where(
            ScriptVersion.automation_id == automation.id,
            ScriptVersion.number > approved.number,
        )
    )
    await db.flush()


async def load_approved(
    db: AsyncSession, automation_id: uuid.UUID, digest: str
) -> ScriptVersion | None:
    """The approved version with this hash, if its content still has that hash (worker)."""
    version = await db.scalar(
        select(ScriptVersion).where(
            ScriptVersion.automation_id == automation_id,
            ScriptVersion.hash == digest,
            ScriptVersion.approved_at.is_not(None),
        )
    )
    if version is None or version_hash(version) != digest:
        return None
    return version


# -- secrets ------------------------------------------------------------------------------


async def set_secret(db: AsyncSession, automation: Automation, name: str, value: str) -> None:
    """Set the value of one of the script's named secrets (stored encrypted). Adds to the
    caller's transaction."""
    row = await db.scalar(
        select(ScriptSecret).where(
            ScriptSecret.automation_id == automation.id, ScriptSecret.name == name
        )
    )
    if row is not None:
        await secrets.replace(db, row.secret_id, value)
        return
    secret = await secrets.create(db, SECRET_KIND, value)
    db.add(ScriptSecret(automation_id=automation.id, name=name, secret_id=secret.id))
    await db.flush()


async def clear_secret(db: AsyncSession, automation: Automation, name: str) -> None:
    """Adds to the caller's transaction."""
    row = await db.scalar(
        select(ScriptSecret).where(
            ScriptSecret.automation_id == automation.id, ScriptSecret.name == name
        )
    )
    if row is None:
        raise NotFound("This secret is not set")
    await db.delete(row)
    await secrets.delete(db, row.secret_id)
    await db.flush()


async def forget_secrets(db: AsyncSession, automation_id: uuid.UUID) -> None:
    """Before an automation is deleted: its secrets' encrypted values go too. Adds to the
    caller's transaction."""
    ids = list(
        await db.scalars(
            select(ScriptSecret.secret_id).where(ScriptSecret.automation_id == automation_id)
        )
    )
    for secret_id in ids:
        await secrets.delete(db, secret_id)
    await db.flush()


async def secret_values(
    db: AsyncSession, automation_id: uuid.UUID, names: list[str]
) -> dict[str, str]:
    """The values of these secrets (worker only: never logged, never shown, never given to
    a model). A secret that is not set is left out."""
    rows = await db.scalars(
        select(ScriptSecret).where(
            ScriptSecret.automation_id == automation_id, ScriptSecret.name.in_(names)
        )
    )
    return {row.name: await secrets.reveal(db, row.secret_id) for row in list(rows)}


# -- for the app --------------------------------------------------------------------------


def _version_out(version: ScriptVersion, actors: dict[str, ActorOut]) -> ScriptVersionOut:
    return ScriptVersionOut(
        number=version.number,
        hash=version.hash,
        code=version.code,
        tools=list(version.tools),
        hosts=list(version.hosts),
        secrets=list(version.secrets),
        think_tools=list(version.think_tools),
        created_by=actors.get(version.created_by),
        created_at=version.created_at,
        approved_at=version.approved_at,
    )


async def script_out(db: AsyncSession, automation: Automation) -> ScriptOut:
    if automation.kind != "script":
        raise NotFound("This automation is not a script")
    found = await versions(db, automation.id)
    approved = _approved_of(automation, found)
    pending = _pending_of(found, approved)
    first = found[0] if found else None
    actors = await provenance.describe(db, [v.created_by for v in found])
    rows = await db.execute(
        select(ScriptSecret.name, Secret.last4)
        .join(Secret, Secret.id == ScriptSecret.secret_id)
        .where(ScriptSecret.automation_id == automation.id)
    )
    hints = {name: secrets.mask(last4) for name, last4 in rows.all()}
    declared = [*(approved.secrets if approved else []), *(pending.secrets if pending else [])]
    return ScriptOut(
        automation_id=automation.id,
        approved=_version_out(approved, actors) if approved else None,
        pending=_version_out(pending, actors) if pending else None,
        owner=actors.get(first.created_by) if first else None,
        secrets=[ScriptSecretOut(name=n, value_hint=hints.get(n)) for n in dict.fromkeys(declared)],
    )


async def status(db: AsyncSession, automation: Automation) -> tuple[bool, bool]:
    """(has an approved version, has a change waiting for review)."""
    approved, pending = await approved_and_pending(db, automation)
    return approved is not None, pending is not None
