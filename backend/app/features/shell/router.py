"""Shell settings the UI shows: currently the agents' SSH public key.

The key pair is created by the `sandbox-net` container on first start (see
sandbox/execd/app.py) in a volume the app mounts read-only. Only the public half
is ever returned.
"""

import base64
import hashlib
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.config import get_settings

router = APIRouter(prefix="/shell", tags=["shell"])


class SshKeyOut(BaseModel):
    available: bool
    public_key: str | None = None
    fingerprint: str | None = None  # SHA256:..., as `ssh-keygen -lf` prints it


def fingerprint(public_key: str) -> str | None:
    try:
        blob = base64.b64decode(public_key.split()[1])
    except (IndexError, ValueError):
        return None
    digest = base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    return f"SHA256:{digest}"


@router.get("/ssh-key", response_model=SshKeyOut)
def ssh_key() -> SshKeyOut:
    path = Path(get_settings().sandbox_ssh_dir) / "id_ed25519.pub"
    try:
        public_key = path.read_text().strip()
    except OSError:
        return SshKeyOut(available=False)
    return SshKeyOut(available=True, public_key=public_key, fingerprint=fingerprint(public_key))
