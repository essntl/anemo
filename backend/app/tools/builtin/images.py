"""generate_image: makes pictures with the image model chosen in Settings.

Any chat model can call it (ordinary tool calling): the picture is made by the image
model of a provider (OpenAI, OpenRouter, Google Gemini, an OpenAI-compatible server),
through providers/images.py. The pictures are saved in the workspace with a provenance
file next to each, recorded in the run's history, and attached to the answer so the
chat shows them.

Permission: "Generate images" (`image.generate`, default: allowed without asking; each
call costs money at the provider). Automation runs ask first unless that is switched
off (features/image_generation). Input images need "Read files" for their paths, and
a destination the model chooses needs "Create and edit files"; the default folder
(files/generated/<date>/, or the project's) only needs the folder to be writable for
agents (Settings > Workspace).

See docs/specs/10-image-generation.md.
"""

import asyncio
import logging
from datetime import UTC, datetime
from pathlib import PurePosixPath
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.attachments import images as image_prep
from app.features.attachments import service as attachments
from app.features.image_generation import service as image_generation
from app.features.projects import service as projects
from app.features.settings import service as settings_service
from app.features.tasks.models import Project
from app.features.usage import service as usage
from app.policy.models import Action
from app.providers import images as image_api
from app.providers.base import Usage
from app.providers.router import ResolvedModel
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.builtin.workspace import path_action
from app.workspace import files, fs_guard
from app.workspace.access import access_for, allows

log = logging.getLogger(__name__)

HARD_MAX_COUNT = 10  # what the input accepts; the setting (default 4) is the real cap
MAX_INPUT_IMAGES = 8
MAX_PROMPT_CHARS = 4000
_RESOLUTION_RANK = {r: i for i, r in enumerate(image_api.RESOLUTIONS)}


class GenerateImageInput(BaseModel):
    prompt: str = Field(
        min_length=1,
        max_length=MAX_PROMPT_CHARS,
        description="What to draw, in detail: subject, style, composition, colours, any "
        "text to show. With input_images: what to change.",
    )
    aspect_ratio: image_api.AspectRatio = Field("1:1", description="Shape of the picture")
    count: int = Field(1, ge=1, le=HARD_MAX_COUNT, description="How many pictures to make")
    quality: image_api.Quality = Field(
        "auto", description="Higher quality costs more and takes longer"
    )
    resolution: image_api.Resolution = Field(
        "1K", description="Size class, where the model offers a choice (larger costs more)"
    )
    input_images: list[str] = Field(
        default_factory=list,
        max_length=MAX_INPUT_IMAGES,
        description="Workspace images to edit or to use as references, e.g. a picture made "
        "earlier ('files/generated/2026-11-24/fox.png')",
    )
    path: str | None = Field(
        None,
        description="Where to save: a folder, or a file name such as 'site/hero.png'. "
        "Leave empty for files/generated/<date>/ (in a project's chat: its folder).",
    )
    model: str | None = Field(
        None,
        description="Only if the user asks for a particular image model: its name. "
        "Empty: the default image model.",
    )


class GenerateImage(Tool):
    name = "generate_image"
    description = (
        "Make pictures (illustrations, photos, icons, diagrams-as-art, edits of an image) "
        "with the image model the user set up. The pictures are saved in the workspace and "
        "shown to the user under your answer; you get their paths (pass a path to "
        "attach_file, a document, or back here as input_images to change it). You do not "
        "see the picture: describe what you asked for, not what it shows. Each picture "
        "costs money: make one unless asked for more."
    )
    capability = image_generation.CAPABILITY
    extra_capabilities = ("fs.read", "fs.write")
    Input = GenerateImageInput
    idempotent = False  # a repeat makes (and pays for) new pictures
    changes_state = True
    timeout_s = image_api.TIMEOUT_S + 60  # the provider's time, then downloads and saving

    def actions(self, args: GenerateImageInput, ctx: ToolContext) -> list[Action]:
        n = f"{args.count} images" if args.count > 1 else "an image"
        prompt = " ".join(args.prompt.split())
        short = prompt if len(prompt) <= 80 else prompt[:79] + "…"
        actions = [
            Action(
                capability=self.capability,
                resource=args.model,
                risk="moderate" if args.count > 1 or args.quality == "high" else "safe",
                summary=f"Generate {n}: {short}",
            )
        ]
        actions += [
            path_action(ctx, "fs.read", p, "Use as input image:", "read") for p in args.input_images
        ]
        if args.path:
            actions.append(path_action(ctx, "fs.write", args.path, "Save images to", "read_write"))
        return actions

    async def run(self, args: GenerateImageInput, ctx: ToolContext) -> ToolResult:
        try:
            inputs = await asyncio.to_thread(_read_inputs, args.input_images)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)

        async with get_sessionmaker()() as db:
            try:
                model = await image_generation.choose_model(db, args.model)
            except image_generation.NoImageModel as exc:
                return ToolResult(content=exc.message, is_error=True)
            limits = await image_generation.get_settings(db)
            zone = ZoneInfo(await settings_service.user_timezone(db))
            project = await db.get(Project, ctx.project_id) if ctx.project_id else None

        notes: list[str] = []
        count = min(args.count, limits.max_count)
        if count < args.count:
            notes.append(f"made {count}, the most one call may make (Settings)")
        resolution = args.resolution
        if _RESOLUTION_RANK[resolution] > _RESOLUTION_RANK[limits.max_resolution]:
            resolution = limits.max_resolution
            notes.append(f"at {resolution}, the largest allowed (Settings)")

        now = datetime.now(UTC)
        folder = image_generation.default_folder(
            projects.files_path(project) if project else None, now.astimezone(zone)
        )
        try:
            folder, base = image_generation.split_destination(args.path, folder, args.prompt)
        except fs_guard.OutsideWorkspace as exc:
            return ToolResult(content=f"Cannot save there: {exc}", is_error=True)
        if not args.path and not allows(ctx.workspace, folder, "read_write"):
            state = (
                "hidden from" if access_for(ctx.workspace, folder) == "none" else "read-only for"
            )
            return ToolResult(
                content=f"The folder '{folder.split('/', 1)[0]}' is {state} agents (Settings > "
                "Workspace), so the pictures cannot be saved there. Give a `path` in a folder "
                "you may write to.",
                is_error=True,
            )

        request = image_api.ImageRequest(
            model=model.model_key,
            prompt=args.prompt,
            count=count,
            aspect_ratio=args.aspect_ratio,
            quality=args.quality,
            resolution=resolution,
            input_images=[i for _, i in inputs],
        )
        try:
            pictures, result = await image_generation.make_images(model, request, ctx.web)
        except image_api.ImageError as exc:
            log.warning(
                "image generation failed",
                extra={
                    "ctx": {"model": model.model_key, "refused": exc.refused, "status": exc.status}
                },
            )
            if exc.usage is not None:
                await self._record_usage(ctx, model, exc.usage)
            return ToolResult(content=str(exc), is_error=True)
        await self._record_usage(ctx, model, result.usage)

        input_paths = [rel for rel, _ in inputs]
        saved = await self._save(
            ctx, args.prompt, model, request, result, pictures, input_paths, folder, base, now
        )
        if isinstance(saved, ToolResult):
            return saved

        listing = "\n".join(f"- {s['path']} ({s['width']}×{s['height']})" for s in saved)
        lines = [
            f"Made {len(saved)} {'picture' if len(saved) == 1 else 'pictures'} with "
            f"{model.display_name}" + (f" ({'; '.join(notes)})" if notes else "") + ":",
            listing,
        ]
        if len(saved) < count:
            lines.append(f"The model returned {len(saved)} of the {count} asked for.")
        if result.revised_prompt:
            lines.append(f"The model rewrote the prompt as: {result.revised_prompt}")
        lines.append(
            "They are shown to the user under your answer"
            if ctx.message_id
            else "They are in the workspace (no chat to show them in)"
        )
        lines[-1] += "; each has a .json file next to it with the prompt and model."
        return ToolResult(
            content="\n".join(lines),
            data={
                "generated": saved,
                "model": model.display_name,
                "prompt": args.prompt,
                "path": saved[0]["path"],
            },
        )

    async def _record_usage(self, ctx: ToolContext, model: ResolvedModel, used: Usage) -> None:
        """A usage record (kind "image"): the provider's cost, or an estimate from prices."""
        async with get_sessionmaker()() as db:
            usage.record(
                db,
                model,
                used,
                "image",
                run_id=ctx.run_id,
                conversation_id=ctx.conversation_id,
                automation_id=ctx.automation_id,
            )
            await db.commit()

    async def _save(
        self,
        ctx: ToolContext,
        prompt: str,
        model: ResolvedModel,
        request: image_api.ImageRequest,
        result: image_api.ImageResult,
        pictures: list[image_generation.Picture],
        input_paths: list[str],
        folder: str,
        base: str,
        now: datetime,
    ) -> list[dict[str, object]] | ToolResult:
        """Write the pictures and their sidecars, record the changes, attach the copies."""
        try:
            paths = await asyncio.to_thread(image_generation.plan_files, folder, base, pictures)
        except (AppError, fs_guard.OutsideWorkspace) as exc:
            return ToolResult(content=f"Cannot save there: {exc}", is_error=True)
        saved: list[dict[str, object]] = []
        async with get_sessionmaker()() as db:
            for path, picture in zip(paths, pictures, strict=True):
                meta = image_generation.sidecar(
                    prompt=prompt,
                    revised_prompt=result.revised_prompt,
                    model=model,
                    picture=picture,
                    request=request,
                    input_images=input_paths,
                    created_at=now,
                    conversation_id=ctx.conversation_id,
                    run_id=ctx.run_id,
                    made_by=ctx.actor.ref,
                )
                try:
                    _, _, image_hash = await asyncio.to_thread(
                        files.write_bytes, path, picture.data, must_not_exist=True
                    )
                    _, _, meta_hash = await asyncio.to_thread(
                        files.write_bytes, f"{path}.json", meta, must_not_exist=True
                    )
                except AppError as exc:
                    return ToolResult(
                        content=f"Could not save {path}: {exc.message}", is_error=True
                    )
                await ctx.record_change(op="create", path=path, after_hash=image_hash)
                await ctx.record_change(op="create", path=f"{path}.json", after_hash=meta_hash)
                entry: dict[str, object] = {
                    "path": path,
                    "width": picture.width,
                    "height": picture.height,
                    "attachment_id": None,
                }
                if ctx.message_id is not None:
                    att = await attachments.store_output(
                        db,
                        PurePosixPath(path).name,
                        picture.data,
                        conversation_id=ctx.conversation_id,
                        message_id=ctx.message_id,
                        run_id=ctx.answer_run_id,
                        workspace_path=path,
                    )
                    entry["attachment_id"] = str(att.id)
                saved.append(entry)
            await db.commit()
        return saved


def _read_inputs(paths: list[str]) -> list[tuple[str, image_api.InputImage]]:
    """The input images, checked and scaled like images for chat models. Raises AppError."""
    found = []
    for raw in paths:
        path = files.resolve(raw)
        rel = fs_guard.relative(path)
        if not path.is_file():
            raise AppError(f"{raw} does not exist.", code="not_found")
        data = files.read_bytes(rel, image_prep.MAX_INPUT_BYTES)
        try:
            prepared = image_prep.prepare(data)
        except image_prep.NotAnImage as exc:
            raise AppError(f"{rel} is not an image the model can use: {exc}") from exc
        extension = prepared.mime.split("/", 1)[1].replace("jpeg", "jpg")
        name = f"{PurePosixPath(rel).stem}.{extension}"
        found.append((rel, image_api.InputImage(prepared.data, prepared.mime, name)))
    return found
