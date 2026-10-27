"""`python -m app.cli claude-code-check`: checks the Claude subscription provider
against the real subscription, and prints the usage of every model request.

Run it in the worker container (`docker compose exec worker python -m app.cli
claude-code-check`). It uses a small amount of subscription quota: an agent
conversation of 8 turns, each reading a different small workspace file, goes
through the normal runtime (the running workers execute it, with your Agent
Permissions). Every model request after the first should read from the prompt
cache; the hit ratio is cache_read / (cache_read + cache_creation + uncached input).

Options:
  --model KEY        which claude_code model (default: the first one added)
  --turns N          number of turns (default 8)
  --approval         one more turn that deletes a file; "Delete files" must be on
                     Always ask. Approve it in the app after the runner's idle
                     window, then the resumed request's cache use is shown
  --restart          pause before the last turn so you can restart the container
                     (`docker compose restart claude-runner`) in another terminal
"""

import argparse
import asyncio
import shutil
import sys
import uuid
from pathlib import Path

from sqlalchemy import select

import app.db.models  # noqa: F401 - every table, so the ORM can resolve foreign keys
from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.features.conversations import service as conversations
from app.features.providers.models import Model, Provider
from app.features.runs.models import TERMINAL_STATUSES, Run
from app.features.usage.models import UsageRecord

FOLDER = "claude-code-check"
WAIT_S = 600


def _ratio(rec: UsageRecord) -> float | None:
    if not rec.input_tokens:
        return None
    return (rec.cached_tokens or 0) / rec.input_tokens


async def _model(key: str | None) -> Model:
    async with get_sessionmaker()() as db:
        stmt = (
            select(Model)
            .join(Provider)
            .where(Provider.type == "claude_code", Model.enabled.is_(True))
            .order_by(Model.created_at)
        )
        if key:
            stmt = stmt.where(Model.model_key == key)
        model = await db.scalar(stmt)
    if model is None:
        raise SystemExit(
            "No Claude subscription model found. Add a 'Claude subscription (Claude Code)' "
            "provider and a model in Settings > Providers & Models first."
        )
    return model


async def _turn(conv_id: uuid.UUID, model_id: uuid.UUID, text: str) -> uuid.UUID:
    async with get_sessionmaker()() as db:
        run, *_ = await conversations.send_turn(db, conv_id, text, model_id, mode="agent")
        return run.id


async def _wait(run_id: uuid.UUID, until: tuple[str, ...] = TERMINAL_STATUSES) -> str:
    for _ in range(WAIT_S * 2):
        async with get_sessionmaker()() as db:
            run = await db.get(Run, run_id)
            assert run is not None
            if run.status in until:
                return run.status
        await asyncio.sleep(0.5)
    raise SystemExit(f"run {run_id} did not finish within {WAIT_S}s (is a worker running?)")


async def _usage(run_id: uuid.UUID) -> list[UsageRecord]:
    async with get_sessionmaker()() as db:
        return list(
            await db.scalars(
                select(UsageRecord).where(UsageRecord.run_id == run_id).order_by(UsageRecord.ts)
            )
        )


def _print(turn: str, records: list[UsageRecord], first_request: bool) -> bool:
    ok = True
    for i, r in enumerate(records):
        ratio = _ratio(r)
        uncached = (r.input_tokens or 0) - (r.cached_tokens or 0) - (r.cache_creation_tokens or 0)
        mark = ""
        if not r.cached_tokens and not (first_request and i == 0):
            mark, ok = "  <- no cache read", False
        print(
            f"{turn:>8} req {i + 1}: input {uncached:>7}  cache_read {r.cached_tokens or 0:>8}  "
            f"cache_creation {r.cache_creation_tokens or 0:>7}  output {r.output_tokens or 0:>6}  "
            f"hit {'-' if ratio is None else f'{ratio:6.1%}'}{mark}"
        )
    return ok


async def check(args: argparse.Namespace) -> int:
    model = await _model(args.model)
    root = Path(get_settings().workspace_path) / FOLDER
    root.mkdir(parents=True, exist_ok=True)
    for n in range(1, args.turns + 2):
        (root / f"note-{n}.txt").write_text(f"Note {n}: the secret word is word-{n * 7}.\n")
    async with get_sessionmaker()() as db:
        conv = await conversations.create_conversation(db, "Claude Code check", model.id, None)
        await db.commit()
        conv_id = conv.id
    print(f"Model {model.model_key}; conversation {conv_id} (delete it when done)\n")
    all_ok = True
    try:
        for n in range(1, args.turns + 1):
            if args.restart and n == args.turns:
                await asyncio.to_thread(
                    input, "Restart the runner (docker compose restart claude-runner), then Enter "
                )
            run_id = await _turn(
                conv_id,
                model.id,
                f"Read {FOLDER}/note-{n}.txt with read_file and tell me the secret word. "
                "Answer in one short sentence.",
            )
            status = await _wait(run_id)
            records = await _usage(run_id)
            all_ok &= _print(f"turn {n}", records, first_request=n == 1)
            if status != "completed":
                print(
                    f"turn {n} ended as {status}; check Settings > Agent Permissions (Read files)"
                )
                return 1
        if args.approval:
            run_id = await _turn(
                conv_id,
                model.id,
                f"Delete the file {FOLDER}/note-{args.turns + 1}.txt with delete_path.",
            )
            status = await _wait(run_id, ("waiting_approval", *TERMINAL_STATUSES))
            if status != "waiting_approval":
                print("The delete did not ask for approval: set Delete files to Always ask.")
            else:
                print(
                    "\nApprove the delete in the app after the runner's idle window "
                    "(default 15 minutes); waiting ..."
                )
                status = await _wait(run_id)
                all_ok &= _print("approval", await _usage(run_id), first_request=False)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print(
        "\nAll requests after the first read from the cache."
        if all_ok
        else "\nSome requests read nothing from the cache (see the worker log for the reason)."
    )
    return 0 if all_ok else 1


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="claude-code-check",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--model")
    parser.add_argument("--turns", type=int, default=8)
    parser.add_argument("--approval", action="store_true")
    parser.add_argument("--restart", action="store_true")
    args = parser.parse_args(argv)
    return asyncio.run(check(args))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
