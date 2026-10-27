"""Claude Code sessions: one CLI process per session, driven through the Agent SDK.

The process acts as a model. When Claude wants a tool, the CLI calls it on the
in-process "anemo" MCP bridge below, and the call is *parked*: the runner reports
the tool call to the worker and ends that HTTP response. The worker checks and runs
the tool with Anemo's own permission engine and posts the result in its next
request, which resolves the parked call; the CLI then continues (its next model
request) and the runner streams that back. Claude Code never runs anything itself.

What was verified against the pinned CLI (2.1.308) and shaped this code:
- The CLI calls an MCP tool while the response is still streaming, and passes
  Claude's tool_use id in the call's `_meta["claudecode/toolUseId"]`.
- Closing stdin (or cancelling the call) while a call is parked makes the CLI record
  an error result and send one more model request by itself. SIGTERM/SIGKILL does
  not; on the next --resume the CLI records the call as interrupted ("outcome
  unknown"), and the result can then be given as a user message. So a process with
  a parked call is always ended with a signal, never by closing stdin.
- An interrupt also sends no model request (it records the call as rejected).
"""

import asyncio
import contextlib
import hashlib
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    RateLimitEvent,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    ToolUseBlock,
    UserMessage,
)
from claude_agent_sdk.types import McpSdkServerConfig, ToolResultBlock
from mcp import types as mt
from mcp.server import Server

import launch

log = logging.getLogger("claude-runner")

STOP_GRACE_S = 5.0  # SIGTERM -> SIGKILL
DRAIN_TIMEOUT_S = 30.0  # waiting for an interrupted turn to end
EXIT = "_exit"


def digest(value: Any) -> str:
    raw = value if isinstance(value, str) else json.dumps(value, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def canonical(args: Any) -> str:
    return json.dumps(args, sort_keys=True, separators=(",", ":"), default=str)


@dataclass(frozen=True)
class ProcessConfig:
    """What a running process is fixed to. A request that needs anything else
    restarts it (with --resume, so the conversation continues)."""

    model: str
    effort: str | None
    tools_hash: str
    persist: bool


class RunnerError(Exception):
    def __init__(self, message: str, kind: str = "unknown", retryable: bool = False) -> None:
        super().__init__(message)
        self.kind = kind
        self.retryable = retryable


def to_mcp_content(blocks: list[dict[str, Any]]) -> list[Any]:
    out: list[Any] = []
    for b in blocks:
        if b.get("type") == "image":
            out.append(
                mt.ImageContent(type="image", data=b["data"], mimeType=b["media_type"])
            )
        else:
            out.append(mt.TextContent(type="text", text=str(b.get("text", ""))))
    return out or [mt.TextContent(type="text", text="")]


def classify_error(text: str, assistant_error: str | None, limit: dict[str, Any] | None) -> RunnerError:
    """Turn what the CLI reported into a kind the worker maps to ProviderError."""
    low = text.lower()
    if (limit and limit.get("status") == "rejected") or (
        assistant_error == "rate_limit" and ("limit" in low and ("usage" in low or "reset" in low))
    ) or "usage limit" in low or "hit your limit" in low:
        resets = (limit or {}).get("resets_at")
        when = f" It resets at {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(resets))}." if resets else ""
        return RunnerError(
            f"The Claude subscription usage limit is reached.{when}", "usage_limit", retryable=False
        )
    if assistant_error == "authentication_failed" or "not logged in" in low or "/login" in low:
        return RunnerError(
            "Claude Code is not signed in. Run `docker compose exec -it claude-runner "
            "claude auth login`.",
            "auth",
        )
    if assistant_error == "billing_error":
        return RunnerError(text or "Billing error", "billing")
    if assistant_error == "rate_limit" or "overloaded" in low or "529" in low:
        return RunnerError(text or "Rate limited", "rate_limit", retryable=True)
    if assistant_error == "server_error":
        return RunnerError(text or "Server error", "server", retryable=True)
    if assistant_error == "invalid_request":
        return RunnerError(text or "Invalid request", "invalid")
    return RunnerError(text or "Claude Code reported an error", "unknown", retryable=True)


class Session:
    """One Claude Code session and (while warm) its CLI process."""

    def __init__(self, key: str) -> None:
        self.key = key
        self.lock = asyncio.Lock()
        self.client: ClaudeSDKClient | None = None
        self.reader: asyncio.Task[None] | None = None
        self.events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.config: ProcessConfig | None = None
        self.claude_session_id: str | None = None
        self.tools: list[dict[str, Any]] = []
        # Tool calls reported to the worker that have no result yet: id -> name.
        self.awaiting: dict[str, str] = {}
        self.parked: dict[str, asyncio.Future[mt.CallToolResult]] = {}
        # Results that arrived before the CLI asked for them (it runs calls one by one).
        self.early: dict[str, mt.CallToolResult] = {}
        self.calls_by_args: dict[str, list[str]] = {}  # fallback matching, name+args -> ids
        self.in_turn = False
        self.last_used = time.monotonic()
        self.init: dict[str, Any] | None = None
        self._rate_limit: dict[str, Any] | None = None
        self._assistant_error: tuple[str, str] | None = None

    # -- the MCP bridge ----------------------------------------------------------

    def _bridge(self) -> McpSdkServerConfig:
        tools = [
            mt.Tool(name=t["name"], description=t.get("description") or t["name"],
                    inputSchema=t.get("input_schema") or {"type": "object"})
            for t in self.tools
        ]

        async def on_list_tools(ctx: Any, params: Any) -> mt.ListToolsResult:
            return mt.ListToolsResult(tools=tools)

        async def on_call_tool(ctx: Any, params: Any) -> mt.CallToolResult:
            meta = getattr(params, "meta", None)
            if meta is not None and not isinstance(meta, dict):
                meta = meta.model_dump()
            call_id = (meta or {}).get("claudecode/toolUseId")
            if not call_id:
                # Older CLIs: match in order by name and arguments.
                ids = self.calls_by_args.get(params.name + canonical(params.arguments or {}), [])
                call_id = ids.pop(0) if ids else f"unmatched-{uuid.uuid4().hex[:8]}"
            if call_id in self.early:
                return self.early.pop(call_id)
            future: asyncio.Future[mt.CallToolResult] = asyncio.get_running_loop().create_future()
            self.parked[call_id] = future
            try:
                return await future  # until the worker posts the result
            finally:
                self.parked.pop(call_id, None)

        server = Server(
            launch.BRIDGE_NAME, version="1", on_list_tools=on_list_tools, on_call_tool=on_call_tool
        )
        return McpSdkServerConfig(type="sdk", name=launch.BRIDGE_NAME, instance=server)

    # -- process lifecycle -------------------------------------------------------

    @property
    def alive(self) -> bool:
        return self.client is not None and self.reader is not None and not self.reader.done()

    async def ensure(
        self,
        *,
        config: ProcessConfig,
        tools: list[dict[str, Any]],
        system: str | None,
        claude_session_id: str | None,
        fork: dict[str, str] | None,
    ) -> dict[str, Any]:
        """A process for this request. Returns the "session" event for the worker."""
        reason = None
        if self.alive:
            if fork is not None:
                reason = "fork"
            elif claude_session_id != self.claude_session_id:
                reason = "other session"
            elif self.config != config:
                assert self.config is not None
                if self.config.tools_hash != config.tools_hash:
                    reason = "tools changed"
                elif self.config.model != config.model:
                    reason = "model changed"
                else:
                    reason = "effort changed"
            else:
                return {"type": "session", "claude_session_id": self.claude_session_id,
                        "start": "warm", "model": config.model}
            log.info("restarting claude session", extra={"ctx": {"key": self.key, "reason": reason}})
            await self.stop(reason)
        self.tools = tools
        self.config = config
        resume = claude_session_id
        new_id = None if (resume and not fork) else str(uuid.uuid4())
        system_file = (
            launch.system_prompt_file(system, digest(system)) if system is not None else None
        )
        kwargs = launch.options_kwargs(
            model=config.model,
            effort=config.effort,
            system_file=system_file,
            persist=config.persist,
            resume=resume,
            fork=fork is not None,
            resume_at=(fork or {}).get("resume_session_at"),
            drops_turn=(fork or {}).get("drops_turn"),
        )
        if new_id and config.persist:
            kwargs["session_id"] = new_id
        mcp = {launch.BRIDGE_NAME: self._bridge()} if tools else {}
        options = ClaudeAgentOptions(
            **kwargs,
            mcp_servers=mcp,  # type: ignore[arg-type]
            env=dict(launch.CHILD_ENV),  # cli_exec.py builds the real environment
            stderr=lambda line: log.debug("cli: %s", line[:500]),
        )
        self.events = asyncio.Queue()
        self.awaiting.clear()
        self.parked.clear()
        self.early.clear()
        self.calls_by_args.clear()
        self.in_turn = False
        client = ClaudeSDKClient(options)
        try:
            await client.connect()
        except Exception as exc:
            text = str(exc)
            if "Resume rejected" in text or "No conversation found" in text:
                raise RunnerError(text[:500], "resume_failed") from exc
            raise RunnerError(f"Claude Code did not start: {text[:500]}", "start", True) from exc
        self.client = client
        self.reader = asyncio.create_task(self._read(client))
        self.claude_session_id = new_id or resume
        return {
            "type": "session",
            "claude_session_id": self.claude_session_id,
            "start": "new" if not resume else ("fork" if fork else "resumed"),
            "restart_reason": reason,
            "model": config.model,
        }

    async def stop(self, reason: str = "") -> None:
        """End the process. With a call parked (or a turn under way) it is signalled
        rather than closed, so the CLI makes no further model request."""
        client, self.client = self.client, None
        reader, self.reader = self.reader, None
        if client is None:
            return
        busy = bool(self.parked or self.awaiting or self.in_turn)
        process = getattr(getattr(client, "_transport", None), "_process", None)
        if busy and process is not None:
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), STOP_GRACE_S)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
        for future in self.parked.values():
            future.cancel()
        try:
            # Idle: closing stdin lets the CLI finish writing its transcript and exit.
            await asyncio.wait_for(client.disconnect(), STOP_GRACE_S * 2)
        except Exception:  # noqa: BLE001
            if process is not None and process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
        if reader is not None:
            reader.cancel()
            with contextlib.suppress(BaseException):
                await reader
        self.parked.clear()
        self.awaiting.clear()
        self.early.clear()
        self.in_turn = False
        log.info("claude process stopped", extra={"ctx": {"key": self.key, "reason": reason}})

    # -- reading the CLI ---------------------------------------------------------

    async def _read(self, client: ClaudeSDKClient) -> None:
        put = self.events.put_nowait
        try:
            async for msg in client.receive_messages():
                if isinstance(msg, StreamEvent):
                    if msg.parent_tool_use_id:
                        continue
                    ev = msg.event
                    kind = ev.get("type")
                    if kind == "message_start":
                        m = ev.get("message") or {}
                        put({"type": "request_start", "usage": m.get("usage") or {},
                             "model": m.get("model")})
                    elif kind == "content_block_delta":
                        delta = ev.get("delta") or {}
                        if delta.get("type") == "text_delta":
                            put({"type": "text", "text": delta.get("text", "")})
                        elif delta.get("type") == "thinking_delta":
                            put({"type": "thinking", "text": delta.get("thinking", "")})
                    elif kind == "message_delta":
                        put({"type": "request_delta", "stop_reason": (ev.get("delta") or {}).get("stop_reason"),
                             "usage": ev.get("usage") or {}})
                    elif kind == "message_stop":
                        put({"type": "request_end"})
                elif isinstance(msg, AssistantMessage):
                    if msg.parent_tool_use_id:
                        continue
                    for block in msg.content:
                        if isinstance(block, ToolUseBlock):
                            put({"type": "tool_use", "id": block.id, "name": block.name,
                                 "input": block.input})
                    if msg.error:
                        text = " ".join(getattr(b, "text", "") for b in msg.content)
                        put({"type": "api_error", "error": msg.error, "text": text})
                    put({"type": "assistant", "uuid": msg.uuid})
                elif isinstance(msg, UserMessage):
                    if isinstance(msg.content, list):
                        for block in msg.content:
                            if isinstance(block, ToolResultBlock):
                                put({"type": "tool_result_seen", "id": block.tool_use_id})
                elif isinstance(msg, SystemMessage):
                    if msg.subtype == "init":
                        put({"type": "init", "data": msg.data})
                    elif msg.subtype == "compact_boundary":
                        put({"type": "compacted"})
                elif isinstance(msg, RateLimitEvent):
                    info = msg.rate_limit_info
                    put({"type": "rate_limit", "status": info.status, "resets_at": info.resets_at,
                         "rate_limit_type": info.rate_limit_type})
                elif isinstance(msg, ResultMessage):
                    put({"type": "result", "subtype": msg.subtype, "is_error": msg.is_error,
                         "stop_reason": msg.stop_reason, "cost": msg.total_cost_usd,
                         "text": (msg.result or "")[:2000], "errors": msg.errors,
                         "status": msg.api_error_status, "terminal": msg.terminal_reason})
        except Exception as exc:  # noqa: BLE001
            log.warning("claude reader ended", extra={"ctx": {"key": self.key, "error": str(exc)[:300]}})
        finally:
            put({"type": EXIT})

    # -- one request from the worker ---------------------------------------------

    async def send_message(self, content: list[dict[str, Any]], prompt_uuid: str | None) -> None:
        """A new user message. Calls still parked from an earlier turn (a run that
        ended without their results) are interrupted first, which costs no request."""
        assert self.client is not None
        if self.in_turn or self.awaiting or self.parked:
            await self.interrupt()
        message: dict[str, Any] = {
            "type": "user",
            "message": {"role": "user", "content": content},
            "parent_tool_use_id": None,
        }
        if prompt_uuid:
            message["uuid"] = prompt_uuid

        async def one() -> AsyncIterator[dict[str, Any]]:
            yield message

        self.in_turn = True
        await self.client.query(one())

    async def interrupt(self) -> None:
        if self.client is None:
            return
        await self.client.interrupt()
        try:
            async with asyncio.timeout(DRAIN_TIMEOUT_S):
                while self.in_turn or self.awaiting:
                    ev = await self.events.get()
                    if ev["type"] in ("result", EXIT):
                        break
        except TimeoutError:
            await self.stop("interrupt did not end the turn")
        self.awaiting.clear()
        self.early.clear()
        self.in_turn = False

    def deliver_results(self, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Resolve parked calls. Returns the results whose call is no longer there
        (the process was restarted since); the caller sends those as a message."""
        gone: list[dict[str, Any]] = []
        delivered: list[str] = []
        for r in results:
            call_id = r["tool_use_id"]
            result = mt.CallToolResult(
                content=to_mcp_content(r.get("content") or []), isError=bool(r.get("is_error"))
            )
            future = self.parked.pop(call_id, None)
            if future is not None and not future.done():
                future.set_result(result)
                delivered.append(call_id)
            elif call_id in self.awaiting:
                self.early[call_id] = result
                delivered.append(call_id)
            else:
                gone.append(r)
            self.awaiting.pop(call_id, None)
        if gone and delivered:
            # Mixed (should not happen): add the rest to the last delivered result.
            target = self.early.get(delivered[-1])
            note = mt.TextContent(type="text", text="\n\n" + render_gone(gone))
            if target is not None:
                target.content.append(note)
            gone = []
        return gone

    async def stream(self) -> AsyncIterator[dict[str, Any]]:
        """Events until the CLI waits for tool results, or its turn ends."""
        usage: dict[str, Any] = {}
        calls: list[str] = []
        stop_reason: str | None = None
        last_assistant: str | None = None
        while True:
            ev = await self.events.get()
            kind = ev["type"]
            if kind == "init":
                self.init = ev["data"]
                yield {"type": "init", "tools": self.init.get("tools", []),
                       "mcp_servers": self.init.get("mcp_servers", []),
                       "model": self.init.get("model"),
                       "cli_version": self.init.get("claude_code_version"),
                       "session_id": self.init.get("session_id")}
                if self.init.get("session_id"):
                    self.claude_session_id = self.init["session_id"]
            elif kind in ("text", "thinking"):
                yield ev
            elif kind == "request_start":
                usage = dict(ev["usage"])
                usage["model"] = ev.get("model")
                calls, stop_reason = [], None
            elif kind == "request_delta":
                stop_reason = ev.get("stop_reason") or stop_reason
                if ev["usage"].get("output_tokens") is not None:
                    usage["output_tokens"] = ev["usage"]["output_tokens"]
            elif kind == "tool_use":
                name = ev["name"]
                if name.startswith(launch.TOOL_PREFIX):
                    self.awaiting[ev["id"]] = name
                    key = name.removeprefix(launch.TOOL_PREFIX) + canonical(ev["input"])
                    self.calls_by_args.setdefault(key, []).append(ev["id"])
                    calls.append(ev["id"])
                    yield {"type": "tool_call", "id": ev["id"],
                           "name": name.removeprefix(launch.TOOL_PREFIX), "input": ev["input"]}
            elif kind == "tool_result_seen":
                # The CLI answered this call itself (e.g. invalid arguments).
                self.awaiting.pop(ev["id"], None)
            elif kind == "assistant":
                last_assistant = ev.get("uuid") or last_assistant
            elif kind == "request_end":
                yield {"type": "usage",
                       "input_tokens": usage.get("input_tokens"),
                       "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
                       "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
                       "output_tokens": usage.get("output_tokens"),
                       "model": usage.get("model")}
                if stop_reason == "tool_use" and any(c in self.awaiting for c in calls):
                    # The CLI now waits for Anemo: hand the calls to the worker.
                    yield {"type": "end", "reason": "tool_use", "assistant_uuid": last_assistant}
                    return
            elif kind == "compacted":
                yield {"type": "compacted"}
            elif kind == "rate_limit":
                self._rate_limit = ev
                yield {"type": "rate_limit", "status": ev["status"], "resets_at": ev["resets_at"]}
            elif kind == "api_error":
                self._assistant_error = (ev["error"], ev["text"])
            elif kind == "result":
                self.in_turn = False
                self.awaiting.clear()
                if ev["is_error"] or self._assistant_error:
                    err, text = self._assistant_error or (None, ev.get("text") or "")
                    problem = classify_error(
                        text or " ".join(ev.get("errors") or []) or ev["subtype"],
                        err,
                        self._rate_limit,
                    )
                    self._assistant_error = None
                    yield {"type": "error", "message": str(problem), "kind": problem.kind,
                           "retryable": problem.retryable,
                           "resets_at": (self._rate_limit or {}).get("resets_at")}
                    return
                yield {"type": "end", "reason": ev.get("stop_reason") or "end_turn",
                       "cost_usd": ev.get("cost"), "assistant_uuid": last_assistant}
                return
            elif kind == EXIT:
                self.in_turn = False
                self.awaiting.clear()
                self.client = None
                yield {"type": "error", "message": "Claude Code stopped unexpectedly.",
                       "kind": "process_exit", "retryable": True}
                return


def render_gone(results: list[dict[str, Any]]) -> str:
    """Results for calls the CLI no longer waits for (its process was restarted, so
    on resume it recorded them as interrupted): given as a user message instead."""
    parts = []
    for r in results:
        text = "\n".join(
            str(b.get("text", "")) if b.get("type") != "image" else "[image]"
            for b in r.get("content") or []
        )
        label = "Error from" if r.get("is_error") else "Result of"
        parts.append(f"{label} {r.get('name') or 'tool'} ({r['tool_use_id']}):\n{text}")
    return (
        "[The tool calls above were completed by the system after an interruption. "
        "Their results:]\n\n" + "\n\n".join(parts)
    )
