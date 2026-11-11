"""Skills used as slash commands (/study ...), and the built-in ones."""

import uuid

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.conversations.models import ChatMessage
from app.features.skills.builtin import BUILTIN_SKILLS, BY_SLUG
from app.features.skills.service import parse_markdown, to_markdown
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.runtime.dispatch import execute_run
from tests.api.test_agent import script, setup
from tests.conftest import requires_db

pytestmark = requires_db


async def skills_by_slug(client) -> dict[str, dict]:
    return {s["slug"]: s for s in (await client.get("/api/skills")).json()}


async def turn(client, cid: str, text: str, **body) -> dict:
    r = await client.post(f"/api/conversations/{cid}/turns", json={"text": text, **body})
    assert r.status_code == 202, r.text
    await execute_run(uuid.UUID(r.json()["run_id"]))
    return r.json()


def last_context() -> str:
    """The turn context the model got with the newest user message."""
    block = FakeAdapter.requests[-1].messages[-1].content[-1]
    assert block.text.startswith("<turn_context>")
    return block.text


def test_front_matter_round_trip():
    md = (
        "---\nname: explain\ndescription: Explain things.\nicon: graduation-cap\n"
        "hint: Explain a topic\nmode: agent\nuser-invocable: true\n"
        "disable-model-invocation: true\n---\nBe clear."
    )
    fields = parse_markdown(md)
    assert fields["icon"] == "graduation-cap" and fields["hint"] == "Explain a topic"
    assert fields["mode"] == "agent" and fields["user_invocable"] is True
    assert fields["model_invocable"] is False
    odd = parse_markdown("---\nname: x\ndescription: y\nicon: '<b>'\nmode: turbo\n---\n")
    assert odd["icon"] == "sparkles" and odd["mode"] == "any" and odd["model_invocable"]


async def test_builtin_skills(authed):
    skills = await skills_by_slug(authed)
    assert {b.slug for b in BUILTIN_SKILLS} <= set(skills)
    study = skills["study"]
    assert study["builtin"] and study["source"] == "builtin" and not study["customized"]
    assert study["icon"] == "book-open" and study["hint"] == "Learn a new concept"
    assert study["user_invocable"] and not study["model_invocable"]
    assert skills["fact-check"]["mode"] == "agent"
    # Listing again adds nothing twice.
    assert len(await skills_by_slug(authed)) == len(skills)

    # Built-in skills can be switched off and edited, not deleted.
    sid = study["id"]
    assert (await authed.delete(f"/api/skills/{sid}")).json()["error"]["code"] == "builtin_skill"
    edited = {**study, "instructions": "Only ask questions.", "slug": "study"}
    r = await authed.put(f"/api/skills/{sid}", json=edited)
    assert r.status_code == 200 and r.json()["customized"] and r.json()["version"] == 2
    # An edited built-in skill is the user's own: it is not brought up to date any more.
    assert (await skills_by_slug(authed))["study"]["instructions"] == "Only ask questions."

    reset = (await authed.post(f"/api/skills/{sid}/reset")).json()
    assert reset["instructions"] == BY_SLUG["study"].instructions.strip()
    assert not reset["customized"]
    custom = (await authed.post("/api/skills", json={"name": "Mine", "description": "d"})).json()
    assert (await authed.post(f"/api/skills/{custom['id']}/reset")).status_code == 404

    # Switching the slash command off is not editing it.
    r = await authed.put(f"/api/skills/{sid}", json={**reset, "user_invocable": False})
    assert not r.json()["customized"]

    exported = (await authed.get(f"/api/skills/{sid}/export")).text
    assert "icon: book-open" in exported and "user-invocable: false" in exported
    assert "disable-model-invocation: true" in exported


async def test_builtin_text_updates_unless_edited(authed):
    await skills_by_slug(authed)
    async with get_sessionmaker()() as db:
        from app.features.skills.models import Skill

        plan = await db.scalar(select(Skill).where(Skill.slug == "plan"))
        assert plan is not None
        plan.instructions = "an older text"
        await db.commit()
    # Not edited by the user: the text that ships with this version replaces it.
    assert (await skills_by_slug(authed))["plan"]["instructions"].startswith("Help the user")


async def test_user_skill_with_a_builtin_name_wins(authed):
    mine = await authed.post("/api/skills", json={"name": "Study", "description": "Mine."})
    assert mine.status_code == 201
    skills = await skills_by_slug(authed)
    assert skills["study"]["description"] == "Mine." and not skills["study"]["builtin"]
    assert skills["plan"]["builtin"]


async def test_a_message_started_with_a_skill(authed):
    cid = await setup(authed)
    study = (await skills_by_slug(authed))["study"]
    script(
        "what are objects in javascript",
        [TextDelta("An object is ... Let's check your understanding."), Done("end")],
    )
    first = await turn(authed, cid, "what are objects in javascript", skill_id=study["id"])
    assert first["user_message"]["skill"] == {
        "id": study["id"],
        "slug": "study",
        "name": "Study",
        "icon": "book-open",
    }
    context = last_context()
    assert '<skill name="study" title="Study">' in context
    assert "Let's check your understanding" in context
    # Skills are written in English; the answer follows the language of the message.
    assert "Write your answer in the language of the user's message" in " ".join(context.split())
    # The system prompt stays the same (prompt caching): the skill is in the message.
    assert "check your understanding" not in (FakeAdapter.requests[-1].system or "")

    # The answer to the practice task: the skill's instructions are still in the history.
    script("console.log(timer.remaining)", [TextDelta("Correct"), Done("end")])
    await turn(authed, cid, "console.log(timer.remaining)")
    history = FakeAdapter.requests[-1].messages
    assert "<skill" in history[0].content[-1].text
    assert "<skill" not in last_context()
    messages = (await authed.get(f"/api/conversations/{cid}/messages")).json()
    assert messages[0]["skill"]["slug"] == "study" and messages[2]["skill"] is None

    # Editing the message keeps its skill; a branch copies it.
    script("what are classes", [TextDelta("A class ..."), Done("end")])
    r = await authed.post(f"/api/conversations/{cid}/edit-last", json={"text": "what are classes"})
    assert r.status_code == 202
    branch = (await authed.post(f"/api/conversations/{cid}/branch", json={"upto_seq": 2})).json()
    copied = (await authed.get(f"/api/conversations/{branch['id']}/messages")).json()
    assert copied[0]["skill"]["slug"] == "study"
    exported = (await authed.get(f"/api/conversations/{cid}/export")).text
    assert "_Skill: /study (Study)_" in exported

    # The instructions are kept with the message as they were when it was sent.
    async with get_sessionmaker()() as db:
        row = await db.scalar(
            select(ChatMessage).where(ChatMessage.conversation_id == uuid.UUID(cid))
        )
        assert row is not None and row.skill
        assert "check your understanding" in row.skill["instructions"]


async def test_skill_in_plain_chat_and_agent_mode(authed):
    cid = await setup(authed)
    skills = await skills_by_slug(authed)
    # Without memory, a chat turn is one plain model call (runtime/chat.py).
    await authed.put("/api/settings/memory", json={"enabled": False})
    script("check: water boils at 90C", [TextDelta("False."), Done("end")])
    await turn(authed, cid, "check: water boils at 90C", skill_id=skills["fact-check"]["id"])
    assert FakeAdapter.requests[-1].tools == []
    assert '<skill name="fact-check"' in last_context()

    # In agent mode (the tool loop).
    script("plan my move", [TextDelta("Goal: ..."), Done("end")])
    await turn(authed, cid, "plan my move", mode="agent", skill_id=skills["plan"]["id"])
    assert '<skill name="plan"' in last_context()


async def test_unavailable_skills_are_refused(authed):
    cid = await setup(authed)
    skills = await skills_by_slug(authed)
    review = skills["review"]
    await authed.put(f"/api/skills/{review['id']}", json={**review, "enabled": False})
    r = await authed.post(
        f"/api/conversations/{cid}/turns", json={"text": "x", "skill_id": review["id"]}
    )
    assert r.status_code == 404
    unknown = await authed.post(
        f"/api/conversations/{cid}/turns", json={"text": "x", "skill_id": str(uuid.uuid4())}
    )
    assert unknown.status_code == 404
    # Agents don't see the built-in skills in their index unless that is switched on.
    script("hello", [TextDelta("hi"), Done("end")])
    await turn(authed, cid, "hello", mode="agent")
    assert "load_skill" not in {t.name for t in FakeAdapter.requests[-1].tools}


def test_export_of_a_plain_skill_has_no_extras():
    from app.features.skills.models import Skill

    skill = Skill(
        slug="x",
        name="x",
        description="d",
        instructions="i",
        required_capabilities=[],
        tags=[],
        icon="sparkles",
        hint="",
        mode="any",
        user_invocable=True,
        model_invocable=True,
    )
    md = to_markdown(skill)
    assert "icon" not in md and "invocable" not in md and "mode" not in md
