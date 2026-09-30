"""UUIDv7 generation (time-ordered ids; stdlib only gains uuid7 in Python 3.14)."""

import os
import time
import uuid


def uuid7() -> uuid.UUID:
    ts_ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big")
    value = (ts_ms & ((1 << 48) - 1)) << 80  # 48-bit timestamp
    value |= 0x7 << 76  # version 7
    value |= ((rand >> 62) & 0xFFF) << 64  # 12 random bits
    value |= 0b10 << 62  # RFC 4122 variant
    value |= rand & ((1 << 62) - 1)  # 62 random bits
    return uuid.UUID(int=value)
