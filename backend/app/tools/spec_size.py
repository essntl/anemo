"""How big the built-in tool specs are as the model receives them.

Every agent request starts with the tool list, so its size is paid on every request
(cached or not). `python -m app.cli request-size --tools` prints it per tool; a unit test
keeps the total under a budget (tests/unit/test_tool_spec_size.py).
"""

import json

from app.tools.registry import all_tools
from app.tools.say_once import say_once

CHARS_PER_TOKEN = 3.3  # a rough average for English text and JSON


def spec_json(tool_spec: dict[str, object]) -> str:
    """Compact JSON of a spec: what a provider adapter puts on the wire, give or take."""
    return json.dumps(tool_spec, ensure_ascii=False, separators=(",", ":"))


def spec_sizes() -> list[tuple[str, int, int, int]]:
    """(name, description chars, schema chars, total chars) of every offered built-in tool,
    all in one request (as a run that may use every tool gets them)."""
    tools = [t for t in all_tools() if not t.hidden]
    offered = frozenset(t.name for t in tools)
    rows = []
    for spec in say_once([t.spec(offered) for t in sorted(tools, key=lambda t: t.name)]):
        total = len(
            spec_json(
                {
                    "name": spec.name,
                    "description": spec.description,
                    "input_schema": spec.input_schema,
                }
            )
        )
        rows.append((spec.name, len(spec.description), len(spec_json(spec.input_schema)), total))
    return rows


def report() -> str:
    rows = sorted(spec_sizes(), key=lambda r: r[3], reverse=True)
    lines = [f"{'tool':<32} {'descr':>7} {'schema':>7} {'total':>7} {'~tokens':>8}"]
    for name, descr, schema, total in rows:
        lines.append(
            f"{name:<32} {descr:>7} {schema:>7} {total:>7} {round(total / CHARS_PER_TOKEN):>8}"
        )
    d = sum(r[1] for r in rows)
    s = sum(r[2] for r in rows)
    t = sum(r[3] for r in rows)
    lines.append(
        f"{f'TOTAL ({len(rows)} tools)':<32} {d:>7} {s:>7} {t:>7} {round(t / CHARS_PER_TOKEN):>8}"
    )
    return "\n".join(lines)
