"""Permission engine: table-driven cases plus property-based invariants."""

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.policy.engine import cap_matches, combine, evaluate
from app.policy.models import Action, Evaluation, Grant, Policy, Rule, Scope
from app.policy.presets import CATEGORIES, PermissionSettings, compile_ceiling, compile_policy

RANK = {"allow": 0, "ask": 1, "deny": 2}


def P(*rules: Rule, default="ask") -> Policy:
    return Policy(name="test", default=default, rules=list(rules))


def A(cap: str, resource: str | None = None, risk="safe", outside=False) -> Action:
    return Action(capability=cap, resource=resource, risk=risk, outside_workspace=outside)


@pytest.mark.parametrize(
    "pattern,cap,expected",
    [
        ("fs.read", "fs.read", True),
        ("fs.*", "fs.read", True),
        ("fs.*", "fs", True),
        ("fs.*", "fsx.read", False),
        ("mcp.github.*", "mcp.github.create_issue", True),
        ("mcp.github.*", "mcp.gitlab.x", False),
        ("*", "anything.at.all", True),
        ("fs.read", "fs.write", False),
    ],
)
def test_cap_matching(pattern, cap, expected):
    assert cap_matches(pattern, cap) is expected


def test_most_specific_rule_wins():
    policy = P(
        Rule(cap="mcp.*", decision="deny"),
        Rule(cap="mcp.github.*", decision="ask"),
        Rule(cap="mcp.github.read", decision="allow"),
    )
    assert evaluate(A("mcp.github.read"), policy).decision == "allow"
    assert evaluate(A("mcp.github.write"), policy).decision == "ask"
    assert evaluate(A("mcp.slack.post"), policy).decision == "deny"


def test_default_when_no_rule_matches():
    assert evaluate(A("net.fetch"), P(default="deny")).decision == "deny"


def test_scope_and_risk_fall_back_to_else():
    rule = Rule(
        cap="fs.write",
        decision="allow",
        scope=Scope(roots=["projects"]),
        unless_risk=["dangerous"],
        else_="ask",
    )
    policy = P(rule)
    assert evaluate(A("fs.write", "projects/app/x.py"), policy).decision == "allow"
    assert evaluate(A("fs.write", "documents/x.md"), policy).decision == "ask"
    assert evaluate(A("fs.write", None), policy).decision == "ask"
    assert evaluate(A("fs.write", "projects/x", risk="dangerous"), policy).decision == "ask"


def test_hard_floor_cannot_be_configured_away():
    everything = P(Rule(cap="*", decision="allow"), default="allow")
    for cap in ("settings.update", "secrets.read", "auth.sessions"):
        assert evaluate(A(cap), everything).decision == "deny"
    assert evaluate(A("fs.read", "../etc/passwd", outside=True), everything).decision == "deny"


def test_ceiling_restricts_and_grants_respect_it():
    policy = P(Rule(cap="fs.delete", decision="ask"))
    grants = [Grant(capability="fs.delete")]
    assert evaluate(A("fs.delete", "a/b"), policy, grants=grants).decision == "allow"
    ceiling = P(Rule(cap="fs.delete", decision="ask"), default="allow")
    assert evaluate(A("fs.delete", "a/b"), policy, ceiling=ceiling, grants=grants).decision == "ask"
    deny_ceiling = P(Rule(cap="fs.*", decision="deny"), default="allow")
    permissive = P(Rule(cap="fs.*", decision="allow"))
    assert evaluate(A("fs.read", "x"), permissive, ceiling=deny_ceiling).decision == "deny"


def test_grant_is_scoped_to_its_folder():
    policy = P(Rule(cap="fs.read", decision="ask"))
    grants = [Grant(capability="fs.read", resource_prefix="projects/a")]
    assert evaluate(A("fs.read", "projects/a/x.md"), policy, grants=grants).decision == "allow"
    assert evaluate(A("fs.read", "projects/a"), policy, grants=grants).decision == "allow"
    assert evaluate(A("fs.read", "projects/b/x.md"), policy, grants=grants).decision == "ask"
    assert evaluate(A("fs.read", "projects/ab/x.md"), policy, grants=grants).decision == "ask"


def test_combine_takes_most_restrictive():
    evs = [Evaluation(decision="allow", reason=""), Evaluation(decision="ask", reason="x")]
    assert combine(evs).decision == "ask"
    assert combine([]).decision == "allow"


def test_default_settings_compile_to_documented_behaviour():
    policy = compile_policy(PermissionSettings())
    assert evaluate(A("fs.read", "notes/x.md"), policy).decision == "allow"
    assert evaluate(A("fs.write", "notes/x.md"), policy).decision == "ask"
    assert evaluate(A("net.search"), policy).decision == "allow"
    assert evaluate(A("net.fetch", risk="dangerous"), policy).decision == "ask"
    assert evaluate(A("agent.spawn"), policy).decision == "deny"
    assert evaluate(A("agent.plan"), policy).decision == "allow"
    assert evaluate(A("totally.unknown"), policy).decision == "ask"


def test_ceiling_settings():
    settings = PermissionSettings(levels={"fs.write": "autonomous"}, ceiling={"fs.write": "ask"})
    policy, ceiling = compile_policy(settings), compile_ceiling(settings)
    assert evaluate(A("fs.write", "x/y"), policy).decision == "allow"
    assert evaluate(A("fs.write", "x/y"), policy, ceiling=ceiling).decision == "ask"


# --- properties -------------------------------------------------------------------

caps = st.sampled_from(
    [c.cap.replace(".*", ".tool") for c in CATEGORIES]
    + ["settings.x", "secrets.y", "util.time", "agent.plan"]
)
levels = st.sampled_from(["deny", "ask", "ask_dangerous", "workspace", "autonomous"])
risks = st.sampled_from(["safe", "moderate", "dangerous"])
resources = st.one_of(st.none(), st.sampled_from(["projects/a/x", "documents/y", "z"]))
settings_st = st.builds(
    PermissionSettings,
    levels=st.dictionaries(st.sampled_from([c.cap for c in CATEGORIES]), levels),
    ceiling=st.dictionaries(st.sampled_from([c.cap for c in CATEGORIES]), levels),
)
actions = st.builds(
    Action, capability=caps, resource=resources, risk=risks, outside_workspace=st.booleans()
)
grants_st = st.lists(
    st.builds(
        Grant,
        capability=st.sampled_from(["*", "fs.*", "fs.read"]),
        resource_prefix=st.one_of(st.none(), st.just("projects")),
    )
)


@given(action=actions, settings=settings_st, grants=grants_st)
def test_property_ceiling_never_loosens(action, settings, grants):
    policy, ceiling = compile_policy(settings), compile_ceiling(settings)
    with_ceiling = evaluate(action, policy, ceiling=ceiling)
    without = evaluate(action, policy)
    assert RANK[with_ceiling.decision] >= RANK[without.decision]


@given(action=actions, settings=settings_st, grants=grants_st)
def test_property_grants_never_override_deny(action, settings, grants):
    policy, ceiling = compile_policy(settings), compile_ceiling(settings)
    base = evaluate(action, policy, ceiling=ceiling)
    granted = evaluate(action, policy, ceiling=ceiling, grants=grants)
    if base.decision == "deny":
        assert granted.decision == "deny"
    if base.decision == "allow":
        assert granted.decision == "allow"


@given(action=actions, settings=settings_st, parent_settings=settings_st)
def test_property_child_never_exceeds_parent(action, settings, parent_settings):
    child = compile_policy(settings)
    parent = compile_policy(parent_settings)
    alone = evaluate(action, parent)
    nested = evaluate(action, child, parent=parent)
    assert RANK[nested.decision] >= RANK[alone.decision]


@given(action=actions, settings=settings_st, grants=grants_st)
def test_property_hard_floor_is_unreachable(action, settings, grants):
    result = evaluate(
        action, compile_policy(settings), ceiling=compile_ceiling(settings), grants=grants
    )
    if action.outside_workspace or action.capability.startswith(("settings.", "secrets.")):
        assert result.decision == "deny"
