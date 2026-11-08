"""Diagrams, charts and math: the models are told the app draws them, and /diagram."""

from app.features.skills.builtin import BY_SLUG
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.runtime.agent_prompt import build_system_prompt
from app.runtime.chat import SYSTEM_PROMPT, VISUALS_HINT
from tests.api.test_agent import agent_turn, script, setup
from tests.api.test_slash_skills import skills_by_slug, turn
from tests.api.test_stable_prefix import assert_no_volatile_text
from tests.conftest import requires_db


def test_both_prompts_mention_the_blocks_and_stay_stable():
    agent = build_system_prompt(None, [], "never")
    for prompt in (SYSTEM_PROMPT, agent):
        assert VISUALS_HINT in prompt
        assert "```mermaid" in prompt and "```chart" in prompt and "$$" in prompt
        assert_no_volatile_text(prompt)
    # Short: it is sent with every request.
    assert len(VISUALS_HINT) < 1200


@requires_db
async def test_the_hint_reaches_the_model_in_chat_and_agent_mode(authed):
    from tests.api.test_memory import chat_turn

    for mode in ("chat", "agent"):
        FakeAdapter.scripts.clear()
        FakeAdapter.requests.clear()
        cid = await setup(authed)
        script("draw it", [TextDelta("ok"), Done("end")])
        if mode == "agent":
            await agent_turn(authed, cid, "draw it")
        else:
            await chat_turn(authed, cid, "draw it")
        assert "## Diagrams, charts and math" in (FakeAdapter.requests[-1].system or ""), mode


@requires_db
async def test_diagram_is_a_builtin_slash_command(authed):
    skills = await skills_by_slug(authed)
    diagram = skills["diagram"]
    assert diagram["builtin"] and diagram["user_invocable"] and diagram["icon"] == "workflow"
    assert diagram["hint"] == "Show it as a diagram or chart"
    assert diagram["instructions"] == BY_SLUG["diagram"].instructions.strip()
    assert "Mermaid" in diagram["instructions"] and "```chart" in diagram["instructions"]

    # Picking it answers the message with its instructions.
    FakeAdapter.scripts.clear()
    FakeAdapter.requests.clear()
    cid = await setup(authed)
    script("my week as a timeline", [TextDelta("```mermaid\ntimeline\n```"), Done("end")])
    await turn(authed, cid, "my week as a timeline", skill_id=diagram["id"])
    system = FakeAdapter.requests[-1].system or ""
    context = FakeAdapter.requests[-1].messages[-1].content[-1].text
    assert "never invent data" in system + context
