"""Create, replace, read and delete encrypted secrets.

`reveal()` is for backend code that needs the plaintext (e.g. calling a provider).
It must never be used to build an API response, log line, event or model prompt.
"""

import uuid

from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.crypto import decrypt, encrypt
from app.core.errors import NotFound
from app.features.secrets.models import Secret


def mask(last4: str | None) -> str | None:
    return f"••••{last4}" if last4 else None


async def create(db: AsyncSession, kind: str, plaintext: str) -> Secret:
    secret = Secret(kind=kind, ciphertext=encrypt(plaintext), last4=plaintext[-4:])
    db.add(secret)
    await db.flush()
    return secret


async def replace(db: AsyncSession, secret_id: uuid.UUID, plaintext: str) -> Secret:
    secret = await db.get(Secret, secret_id)
    if secret is None:
        raise NotFound("Secret not found")
    secret.ciphertext = encrypt(plaintext)
    secret.last4 = plaintext[-4:]
    secret.rotated_at = func.now()
    await db.flush()
    return secret


async def reveal(db: AsyncSession, secret_id: uuid.UUID) -> str:
    secret = await db.get(Secret, secret_id)
    if secret is None:
        raise NotFound("Secret not found")
    return decrypt(secret.ciphertext)


async def delete(db: AsyncSession, secret_id: uuid.UUID) -> None:
    secret = await db.get(Secret, secret_id)
    if secret is not None:
        await db.delete(secret)
