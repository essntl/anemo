"""The shared stubs of the fundamentals work: actor context and object references."""

import asyncio
import uuid

import pytest

from app.core.actor import EXTERNAL, USER, Actor, acting_as, current_actor
from app.core.refs import ObjectRef, parse_ref, ref_url

A = uuid.UUID("0196b0a0-0000-7000-8000-000000000001")
B = uuid.UUID("0196b0a0-0000-7000-8000-000000000002")


def test_the_default_actor_is_the_user() -> None:
    assert current_actor() == USER
    assert USER.ref == "user"
    assert USER.is_user


def test_actor_references_round_trip() -> None:
    for actor in (USER, EXTERNAL, Actor.chat(A), Actor.automation(A, B)):
        assert Actor.parse(actor.ref) == actor
    assert Actor.chat(A).ref == f"chat:{A}"
    assert Actor.automation(A, B).ref == f"automation:{A}/{B}"


@pytest.mark.parametrize("ref", ["", "agent", "chat:", "chat:nope", f"automation:{A}", "x:1"])
def test_bad_actor_references_are_refused(ref: str) -> None:
    with pytest.raises(ValueError):
        Actor.parse(ref)


def test_acting_as_sets_and_restores() -> None:
    with acting_as(Actor.chat(A)):
        assert current_actor() == Actor.chat(A)
        with acting_as(Actor.automation(A, B)):
            assert current_actor().kind == "automation"
        assert current_actor() == Actor.chat(A)
    assert current_actor() == USER


def test_tasks_started_inside_inherit_the_actor() -> None:
    async def inner() -> str:
        return current_actor().ref

    async def outer() -> str:
        with acting_as(Actor.chat(A)):
            return await asyncio.create_task(inner())

    assert asyncio.run(outer()) == f"chat:{A}"


def test_object_references_round_trip() -> None:
    for kind in ("document", "task", "event", "chat"):
        ref = ObjectRef(kind, A)  # type: ignore[arg-type]
        assert parse_ref(ref.url) == ref
    assert ref_url("task", A) == f"/tasks?task={A}"
    assert ref_url("event", A) == f"/calendar?event={A}"
    assert ref_url("chat", A) == f"/c/{A}"


def test_parse_ref_accepts_anchors_and_absolute_links() -> None:
    assert parse_ref(f"/documents/{A}#text=price") == ObjectRef("document", A)
    assert parse_ref(f"https://anemo.example/tasks?task={A}") == ObjectRef("task", A)


OTHER_ADDRESSES = ["", "/documents/", f"/documents/{A}/x", f"/tasks?id={A}", "https://x.example/"]


@pytest.mark.parametrize("value", [*OTHER_ADDRESSES, "/c/1"])
def test_parse_ref_rejects_other_addresses(value: str) -> None:
    assert parse_ref(value) is None
