"""A stand-in for the claude-runner container (and the Claude Code CLI behind it),
so the claude_code adapter and the runtime can be tested without either.

It behaves like the real runner as verified in claude-runner/tests: a tool call is
parked until its result is posted; results for calls that are gone (the process
was evicted or restarted) come back as a "calls_gone" note; a new message while
calls are parked interrupts them first. Every request body is recorded, so tests
can check exactly what would reach Claude Code.
"""

import uuid
from collections import deque
from collections.abc import AsyncIterator
from typing import Any

from app import claude_runner_client
from app.providers.adapters import claude_code


def say(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": text}]


def call(name: str, call_id: str | None = None, **args: Any) -> dict[str, Any]:
    return {
        "type": "tool_call",
        "id": call_id or f"toolu_{uuid.uuid4().hex[:10]}",
        "name": name,
        "input": args,
    }


class MemoryStore(claude_code.StateStore):
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}

    async def load(self, key: str) -> dict[str, Any]:
        return dict(self.rows.get(key, {}))

    async def save(self, key: str, state: dict[str, Any]) -> None:
        self.rows[key] = dict(state)


class FakeRunner:
    def __init__(self) -> None:
        self.replies: deque[list[dict[str, Any]]] = deque()
        self.bodies: list[dict[str, Any]] = []  # every /turn body, in order
        self.keys: list[str] = []
        self.parked: dict[str, set[str]] = {}  # claude session id -> parked call ids
        self.sessions: set[str] = set()
        self.interrupts: list[str] = []
        self.oneshots: list[dict[str, Any]] = []
        self.read = 1000  # cache read tokens reported per request (after the first)
        self.fail_next: dict[str, Any] | None = None

    def evict_all(self) -> None:
        """Like the idle window passing: processes end, parked calls are gone."""
        self.parked.clear()

    async def turn(self, key: str, body: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        self.bodies.append(body)
        self.keys.append(key)
        sid = body.get("claude_session_id")
        if body.get("fork"):
            start, sid = "fork", str(uuid.uuid4())
        elif sid and sid in self.sessions:
            start = "warm" if sid in self.parked else "resumed"
        else:
            start, sid = "new", str(uuid.uuid4())
        self.sessions.add(sid)
        yield {"type": "session", "claude_session_id": sid, "start": start, "model": body["model"]}
        yield {
            "type": "init",
            "tools": [f"mcp__anemo__{t['name']}" for t in body["tools"]],
            "mcp_servers": [{"name": "anemo"}],
            "model": body["model"],
            "cli_version": "2.1.308",
        }
        parked = self.parked.setdefault(sid, set())
        data = body["input"]
        if data["type"] == "message":
            parked.clear()  # interrupted, no model request
        else:
            ids = [r["tool_use_id"] for r in data["results"]]
            gone = [i for i in ids if i not in parked]
            if gone:
                yield {"type": "note", "calls_gone": gone}
            parked.clear()
        yield {"type": "accepted"}
        if self.fail_next is not None:
            event, self.fail_next = self.fail_next, None
            yield event
            return
        reply = self.replies.popleft() if self.replies else say("ok")
        calls = []
        for ev in reply:
            if ev["type"] == "tool_call":
                calls.append(ev["id"])
            yield ev
        first = len(self.bodies) == 1
        yield {
            "type": "usage",
            "input_tokens": 5,
            "cache_read_input_tokens": 0 if first else self.read,
            "cache_creation_input_tokens": 200,
            "output_tokens": 20,
            "model": body["model"],
        }
        if calls:
            parked.update(calls)
            yield {"type": "end", "reason": "tool_use", "assistant_uuid": str(uuid.uuid4())}
        else:
            yield {
                "type": "end",
                "reason": "end_turn",
                "cost_usd": 0.01,
                "assistant_uuid": str(uuid.uuid4()),
            }

    async def oneshot(self, body: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        self.oneshots.append(body)
        reply = self.replies.popleft() if self.replies else say("A title")
        for ev in reply:
            yield ev
        yield {
            "type": "usage",
            "input_tokens": 5,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "output_tokens": 3,
            "model": body["model"],
        }
        yield {"type": "end", "reason": "end_turn"}

    async def interrupt(self, key: str) -> None:
        self.interrupts.append(key)

    def install(self, monkeypatch: Any) -> MemoryStore | None:
        monkeypatch.setattr(claude_runner_client, "turn", self.turn)
        monkeypatch.setattr(claude_runner_client, "oneshot", self.oneshot)
        monkeypatch.setattr(claude_runner_client, "interrupt", self.interrupt)
        return None

    # what reached Claude Code
    def last_input(self) -> dict[str, Any]:
        return self.bodies[-1]["input"]

    def last_text(self) -> str:
        return "\n".join(b.get("text", "") for b in self.last_input().get("content", []))
