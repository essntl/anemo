"""The permission engine: a pure function from (action, policies, grants) to a decision.

No IO, no globals: easy to test exhaustively (see tests/unit/test_policy_engine.py).

Evaluation order:
  1. Hard floor (code, not configuration): some things are never allowed.
  2. Each policy layer (the selected policy, the global ceiling, and for a
     sub-agent the policy of every agent above it) is evaluated with its most
     specific matching rule.
  3. Layers combine as "most restrictive wins": deny > ask > allow.
  4. An `ask` may become `allow` through a run grant, but only if the ceiling
     itself allows the action. Grants never override deny.
"""

from collections.abc import Iterable

from app.policy.models import Action, Decision, Evaluation, Grant, Policy, Rule

# Capabilities no agent may ever use, whatever the configuration says.
HARD_DENY_PREFIXES = ("settings.", "secrets.", "auth.")

_RANK: dict[Decision, int] = {"allow": 0, "ask": 1, "deny": 2}


def cap_matches(pattern: str, capability: str) -> bool:
    if pattern in ("*", capability):
        return True
    if pattern.endswith(".*"):
        prefix = pattern[:-2]
        return capability == prefix or capability.startswith(prefix + ".")
    return False


def specificity(pattern: str) -> int:
    """Exact names beat wildcards; longer wildcards beat shorter ones."""
    if pattern == "*":
        return 0
    if pattern.endswith(".*"):
        return pattern.count(".")
    return 1000


def in_scope(rule: Rule, action: Action) -> bool:
    if rule.scope is None:
        return True
    if action.resource is None:
        return False
    if "*" in rule.scope.roots:
        return True
    root = action.resource.strip("/").split("/", 1)[0]
    return root in rule.scope.roots


def evaluate_policy(policy: Policy, action: Action) -> Evaluation:
    matching = [r for r in policy.rules if cap_matches(r.cap, action.capability)]
    if not matching:
        return Evaluation(decision=policy.default, reason=f"{policy.name}: default", rule="default")
    # max() keeps the first of equally specific rules, so earlier rules win ties.
    rule = max(matching, key=lambda r: specificity(r.cap))
    if not in_scope(rule, action):
        return Evaluation(
            decision=rule.else_, reason=f"{policy.name}: outside allowed folders", rule=rule.cap
        )
    if action.risk in rule.unless_risk:
        return Evaluation(
            decision=rule.else_, reason=f"{policy.name}: {action.risk} action", rule=rule.cap
        )
    return Evaluation(decision=rule.decision, reason=f"{policy.name}: {rule.cap}", rule=rule.cap)


def grant_matches(grant: Grant, action: Action) -> bool:
    if not cap_matches(grant.capability, action.capability):
        return False
    if grant.resource_prefix is None:
        return True
    if action.resource is None:
        return False
    return action.resource == grant.resource_prefix.rstrip("/") or action.resource.startswith(
        grant.resource_prefix.rstrip("/") + "/"
    )


def evaluate(
    action: Action,
    policy: Policy,
    *,
    ceiling: Policy | None = None,
    parent: Policy | None = None,
    ancestors: Iterable[Policy] = (),
    grants: Iterable[Grant] = (),
) -> Evaluation:
    # 1. Hard floor.
    if action.capability.startswith(HARD_DENY_PREFIXES):
        return Evaluation(
            decision="deny", reason="Agents can never change settings or secrets", rule="hard-floor"
        )
    if action.outside_workspace:
        return Evaluation(
            decision="deny", reason="Path is outside the workspace", rule="hard-floor"
        )
    if action.blocked:
        return Evaluation(decision="deny", reason=action.blocked, rule="hard-floor")

    # 2 + 3. Layers, most restrictive wins.
    results = [evaluate_policy(policy, action)]
    ceiling_eval = evaluate_policy(ceiling, action) if ceiling else None
    if ceiling_eval:
        results.append(ceiling_eval)
    if parent:
        results.append(evaluate_policy(parent, action))
    # A sub-agent may do nothing that an agent above it may not.
    results.extend(evaluate_policy(layer, action) for layer in ancestors)
    worst = max(results, key=lambda e: _RANK[e.decision])

    # 4. Run grants may lift an `ask`, never a deny, and only below the ceiling.
    if worst.decision == "ask" and (ceiling_eval is None or ceiling_eval.decision == "allow"):
        if any(grant_matches(g, action) for g in grants):
            return Evaluation(
                decision="allow", reason="Approved earlier in this run", rule="run-grant"
            )
    return worst


def combine(evaluations: list[Evaluation]) -> Evaluation:
    """A tool call may involve several actions: the most restrictive decides."""
    if not evaluations:
        return Evaluation(decision="allow", reason="No permission needed")
    return max(evaluations, key=lambda e: _RANK[e.decision])
