"""Operational commands: `python -m app.cli <command>`.

hash-password     prompt for a password and print an argon2 hash for ADMIN_PASSWORD_HASH
worker-health     exit 0 if this container's worker heartbeat is fresh (Docker healthcheck)
export-openapi    print the OpenAPI schema (used to generate frontend API types)
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
    if cmd == "export-openapi":
        import json

        from app.main_api import create_app

        print(json.dumps(create_app().openapi(), indent=2))
        return 0
    print(f"Unknown command: {cmd}\n{__doc__}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
