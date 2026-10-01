"""Plain-language summary of what an agent may do, shown before and during agent runs."""

from typing import Literal

from pydantic import BaseModel

from app.policy.presets import (
    CATEGORIES,
    LEVEL_LABELS,
    Level,
    PermissionSettings,
    level_for,
)

_RANK: dict[Level, int] = {"autonomous": 0, "workspace": 1, "ask_dangerous": 2, "ask": 3, "deny": 4}

Group = Literal["allowed", "partly", "ask", "never"]


class SummaryItem(BaseModel):
    capability: str
    label: str
    description: str
    level: Level
    level_label: str
    group: Group
    detail: str
    available: bool  # a tool using this capability exists in this version


class PermissionSummary(BaseModel):
    items: list[SummaryItem]
    max_steps: int
    max_tool_calls: int
    max_runtime_s: int
    max_cost_usd: float | None = None
    plan_review: str = "off"


def effective_level(settings: PermissionSettings, cap: str) -> Level:
    """The configured level, capped by the ceiling when that is stricter."""
    level = level_for(settings, cap)
    cap_level = settings.ceiling.get(cap)
    if cap_level and _RANK[cap_level] > _RANK[level]:
        return cap_level
    return level


def summarize(settings: PermissionSettings, available_caps: set[str]) -> PermissionSummary:
    items = []
    for cat in CATEGORIES:
        level = effective_level(settings, cat.cap)
        group: Group
        if level == "autonomous":
            group, detail = "allowed", "Without asking"
        elif level == "workspace":
            group, detail = "partly", "Without asking inside the workspace; asks otherwise"
        elif level == "ask_dangerous":
            group, detail = "partly", "Without asking, except risky actions"
        elif level == "ask":
            group, detail = "ask", "Asks you every time"
        else:
            group, detail = "never", "Not allowed"
        available = any(
            c == cat.cap or (cat.cap.endswith(".*") and c.startswith(cat.cap[:-1]))
            for c in available_caps
        )
        items.append(
            SummaryItem(
                capability=cat.cap,
                label=cat.label,
                description=cat.description,
                level=level,
                level_label=LEVEL_LABELS[level],
                group=group,
                detail=detail,
                available=available,
            )
        )
    return PermissionSummary(
        items=items,
        max_steps=settings.limits.max_steps,
        max_tool_calls=settings.limits.max_tool_calls,
        max_runtime_s=settings.limits.max_runtime_s,
        max_cost_usd=settings.limits.max_cost_usd,
        plan_review=settings.plan_review,
    )
