"""Encryption for secrets at rest (API keys, webhook URLs, MCP credentials).

A Fernet key is derived from APP_SECRET_KEY with HKDF, so the database alone
never contains usable credentials. Rotating APP_SECRET_KEY requires
re-encrypting (see `app.cli rotate-key`, planned) or re-entering secrets.
"""

import base64
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import get_settings


class DecryptionError(Exception):
    pass


def _derive_key(master: str, info: bytes) -> bytes:
    hkdf = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"ai-workspace", info=info)
    return base64.urlsafe_b64encode(hkdf.derive(master.encode()))


@lru_cache
def _fernet() -> Fernet:
    return Fernet(_derive_key(get_settings().app_secret_key.get_secret_value(), b"secrets-v1"))


def encrypt(plaintext: str) -> bytes:
    return _fernet().encrypt(plaintext.encode())


def decrypt(ciphertext: bytes) -> str:
    try:
        return _fernet().decrypt(ciphertext).decode()
    except InvalidToken as exc:
        raise DecryptionError(
            "Could not decrypt a stored secret. Was APP_SECRET_KEY changed?"
        ) from exc
