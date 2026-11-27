"""Operational commands: `python -m app.cli <command>`.

hash-password     prompt for a password and print an argon2 hash for ADMIN_PASSWORD_HASH
worker-health     exit 0 if this container's worker heartbeat is fresh (Docker healthcheck)
export-openapi    print the OpenAPI schema (used to generate frontend API types)
claude-code-check run a short agent conversation on the Claude subscription provider
                  and print the prompt-cache use of every model request (uses some
                  subscription quota; `claude-code-check --help` for options)
tool-spec-sizes   print the size of every built-in tool spec as the model receives it
usage-report      tokens per kind of work and per model (uncached, cached, written,
                  output) and the biggest requests (`usage-report --help` for options)
request-size [RUN_ID]  the size of a run's first model request: system prompt, tool
                  specs (the biggest listed), earlier messages, the new message and its
                  turn context (default: the newest chat or agent run)
"""

import asyncio
import getpass
import socket
import sys


def _hash_password() -> int:
    from argon2 import PasswordHasher

    pw = getpass.getpass("Password: ")
    if pw != getpass.getpass("Repeat: "):
        print("Passwords do not match", file=sys.stderr)
        return 1
    # Single quotes stop Docker Compose from interpolating the '$' characters.
    print(f"ADMIN_PASSWORD_HASH='{PasswordHasher().hash(pw)}'")
    return 0


async def _request_size(args: list[str]) -> int:
    import uuid

    import app.db.models  # noqa: F401 - every table, so the ORM can resolve foreign keys
    from app.core.db import get_sessionmaker
    from app.core.errors import NotFound
    from app.runtime.request_size import first_request, report

    try:
        run_id = uuid.UUID(args[0]) if args else None
    except ValueError:
        print(f"Not a run id: {args[0]}", file=sys.stderr)
        return 2
    async with get_sessionmaker()() as db:
        try:
            size = await first_request(db, run_id)
        except NotFound as exc:
            print(exc.message, file=sys.stderr)
            return 1
    print(report(size))
    return 0


async def _worker_health() -> int:
    from app.core.redis import get_redis

    host = socket.gethostname()
    redis = get_redis()
    async for key in redis.scan_iter(match=f"worker:heartbeat:{host}:*"):
        if await redis.exists(key):
            return 0
    return 1


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    if cmd == "hash-password":
        return _hash_password()
    if cmd == "worker-health":
        return asyncio.run(_worker_health())
    if cmd == "claude-code-check":
        from app.claude_code_check import main as check

        return check(argv[2:])
    if cmd == "tool-spec-sizes":
        from app.tools.spec_size import report

        print(report())
        return 0
    if cmd == "usage-report":
        from app.features.usage.report import main as usage_report

        return usage_report(argv[2:])
    if cmd == "request-size":
        return asyncio.run(_request_size(argv[2:]))
    if cmd == "export-openapi":
        import json

        from app.main_api import create_app

        print(json.dumps(create_app().openapi(), indent=2))
        return 0
    print(f"Unknown command: {cmd}\n{__doc__}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
