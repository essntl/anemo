import time

from app.core.ids import uuid7


def test_uuid7_version_and_variant():
    u = uuid7()
    assert u.version == 7
    assert u.variant == "specified in RFC 4122"


def test_uuid7_is_time_ordered():
    a = uuid7()
    time.sleep(0.002)
    b = uuid7()
    assert a < b


def test_uuid7_unique():
    assert len({uuid7() for _ in range(10_000)}) == 10_000
