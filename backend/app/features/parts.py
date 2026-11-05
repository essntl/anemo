"""Which optional containers are running, as the worker sees them.

The sandboxes, the MCP host and the Claude runner write an access token into a volume
that only the worker mounts, so only a worker can tell whether they have started. It
puts what it sees into Redis every few seconds; Settings > Advanced and the first-run
setup read it from there.
"""

import json
import logging
from pathlib import Path

from app.core.config import get_settings
from app.core.redis import get_redis

log = logging.getLogger(__name__)

PARTS_KEY = "system:parts"  # Redis: {"sandbox": true, ...}, as last seen by a worker
PARTS_TTL_S = 120


def local_parts() -> dict[str, bool]:
    """What this process can see (in the worker: all of them)."""
    s = get_settings()
    files = {
        "sandbox": s.sandbox_token_file,
        "sandbox_net": s.sandbox_net_token_file,
        "mcp_host": s.mcp_host_token_file,
        "browser": s.browser_token_file,
        "claude_runner": s.claude_runner_token_file,
    }
    return {name: Path(path).is_file() for name, path in files.items()}


async def publish() -> None:
    """Called by the worker every few seconds."""
    await get_redis().set(PARTS_KEY, json.dumps(local_parts()), ex=PARTS_TTL_S)


async def read() -> dict[str, bool] | None:
    """For the app: what a worker saw last, or None (no worker reported lately)."""
    try:
        raw = await get_redis().get(PARTS_KEY)
    except Exception:  # noqa: BLE001 - no Redis: unknown
        log.debug("no parts status", exc_info=True)
        return None
    if not raw:
        return None
    data = json.loads(raw)
    return {k: bool(v) for k, v in data.items()} if isinstance(data, dict) else None
