"""Browser control in the user's own Chrome (Anemo Companion): the relay between the
worker's browser tools and the extension's WebSocket, and the permission rules."""

import asyncio
import uuid
from typing import Any

import pytest

from app.features.extension import browser_relay
from app.policy.engine import combine, evaluate
from app.policy.models import Grant
from app.policy.presets import PermissionSettings, compile_policy
from app.tools.base import ToolContext
from app.tools.builtin import browser
from tests.api.test_extension_events import WsClient, _hello, _token
from tests.conftest import requires_db

pytestmark = requires_db

PAGE = {
    "url": "https://example.com/",
    "title": "Example",
    "text": "Hello",
    "elements": ['[1] link "More" → https://example.com/more', '[2] button "Send"'],
    "links": [{"ref": 1, "follow": True}, {"ref": 2, "follow": False}],
}


async def _connected(authed, offer: bool = True) -> WsClient:  # type: ignore[no-untyped-def]
    made = await _token(authed)
    ws = await _hello(made["token"])
    assert (await ws.json())["type"] == "welcome"
    if offer:
        await ws.send({"type": "browser.offer", "enabled": True})
        for _ in range(50):
            if await browser_relay.available():
                break
            await asyncio.sleep(0.02)
    return ws


async def _next_command(ws: WsClient) -> dict[str, Any]:
    while True:
        message = await ws.json()
        if message["type"] == "browser.command":
            return message


async def test_a_command_goes_to_the_extension_and_its_answer_comes_back(authed):
    ws = await _connected(authed)
    assert await browser_relay.available()
    session = uuid.uuid4()
    task = asyncio.create_task(browser_relay.act(session, "open", url="https://example.com/"))
    command = await _next_command(ws)
    assert command["action"] == "open" and command["url"] == "https://example.com/"
    assert command["session"] == str(session)
    # An answer to a command this connection wasn't given is ignored.
    await ws.send({"type": "browser.result", "id": "made-up", "ok": True, "state": {"x": 1}})
    await ws.send({"type": "browser.result", "id": command["id"], "ok": True, "state": PAGE})
    assert await asyncio.wait_for(task, 5) == PAGE

    task = asyncio.create_task(browser_relay.act(session, "open", url="https://bank.example/"))
    command = await _next_command(ws)
    await ws.send(
        {"type": "browser.result", "id": command["id"], "ok": False, "error": "On the blocklist."}
    )
    with pytest.raises(browser_relay.ActionFailed, match="blocklist"):
        await asyncio.wait_for(task, 5)
    await ws.disconnect()
    assert not await browser_relay.available()


async def test_nothing_is_sent_while_browser_control_is_off(authed):
    ws = await _connected(authed, offer=False)
    with pytest.raises(browser_relay.Unavailable):
        await browser_relay.act(uuid.uuid4(), "read")
    await ws.send({"type": "browser.offer", "enabled": True})
    await asyncio.sleep(0.1)
    assert await browser_relay.available()
    await ws.send({"type": "browser.offer", "enabled": False})
    await asyncio.sleep(0.1)
    assert not await browser_relay.available()
    await ws.disconnect()


async def test_no_answer_in_time_is_said_plainly(authed, monkeypatch):
    ws = await _connected(authed)
    monkeypatch.setattr(browser_relay, "ACT_TIMEOUT_S", 1)
    with pytest.raises(browser_relay.Unavailable, match="didn't answer"):
        await browser_relay.act(uuid.uuid4(), "read")
    await ws.disconnect()


async def _no_emit(*_: Any, **__: Any) -> None:
    return None


def _ctx(**kw: Any) -> ToolContext:
    return ToolContext(run_id=uuid.uuid4(), emit=_no_emit, **kw)


def _decide(tool: browser.Tool, args: Any, ctx: ToolContext, level: str, grants=()) -> str:  # type: ignore[no-untyped-def]
    policy = compile_policy(PermissionSettings(levels={"browser.mine": level}))
    actions = tool.actions(args, ctx)
    return combine([evaluate(a, policy, grants=grants) for a in actions]).decision


def test_in_your_chrome_reading_and_links_are_free_other_clicks_and_typing_always_ask():
    ctx = _ctx(my_browser=True)
    browser._remember(ctx, PAGE, "my_browser")
    mine = "my_browser"
    open_ = browser.BrowserOpen()
    read = browser.BrowserRead()
    click = browser.BrowserClick()
    type_ = browser.BrowserType()
    shot = browser.BrowserScreenshot()
    default = "ask_dangerous"
    assert (
        _decide(open_, browser.OpenInput(url="https://example.com/", browser=mine), ctx, default)
        == "allow"
    )
    assert _decide(read, browser.ReadInput(scroll="down", browser=mine), ctx, default) == "allow"
    assert _decide(shot, browser.ScreenshotInput(browser=mine), ctx, default) == "allow"
    assert _decide(click, browser.ClickInput(ref=1, browser=mine), ctx, default) == "allow"
    # A button, an unknown element, typing: asked every time, even when fully autonomous
    # and after "allow for this run"; a "Never" setting still wins.
    grants = [Grant(capability="browser.mine")]
    for level in ("ask_dangerous", "autonomous"):
        assert _decide(click, browser.ClickInput(ref=2, browser=mine), ctx, level, grants) == "ask"
        assert _decide(click, browser.ClickInput(ref=9, browser=mine), ctx, level) == "ask"
        typed = browser.TypeInput(ref=3, text="hi", browser=mine)
        assert _decide(type_, typed, ctx, level, grants) == "ask"
    assert _decide(read, browser.ReadInput(browser=mine), ctx, "deny") == "deny"
    assert _decide(click, browser.ClickInput(ref=2, browser=mine), ctx, "deny") == "deny"
    # The sandbox is untouched: its own permission, as before.
    sandbox_open = open_.actions(browser.OpenInput(url="https://example.com/"), ctx)
    assert sandbox_open[0].capability == "browser.use"
    # The approval says where and what.
    summary = click.actions(browser.ClickInput(ref=2, browser=mine), ctx)[0].summary
    assert summary == 'Click button "Send" (your Chrome)'


async def test_the_tools_use_your_chrome_only_when_offered(monkeypatch):
    calls: list[tuple[str, dict[str, Any]]] = []

    async def act(session: uuid.UUID, action: str, **fields: Any) -> dict[str, Any]:
        calls.append((action, fields))
        return {**PAGE, "botCheck": action == "read"}

    monkeypatch.setattr(browser_relay, "act", act)
    off = await browser.BrowserOpen().run(
        browser.OpenInput(url="https://example.com/", browser="my_browser"), _ctx()
    )
    assert off.is_error and "browser='sandbox'" in off.content and calls == []

    ctx = _ctx(my_browser=True)
    page = await browser.BrowserOpen().run(
        browser.OpenInput(url="https://example.com/", browser="my_browser"), ctx
    )
    assert not page.is_error and "Page: Example" in page.content
    assert page.data and page.data["browser"]["where"] == "my_browser"
    read = await browser.BrowserRead().run(browser.ReadInput(browser="my_browser"), ctx)
    assert "solve it in the tab in their Chrome" in read.content

    async def failing(session: uuid.UUID, action: str, **fields: Any) -> dict[str, Any]:
        raise browser_relay.Unavailable("your Chrome didn't answer in time")

    monkeypatch.setattr(browser_relay, "act", failing)
    late = await browser.BrowserRead().run(browser.ReadInput(browser="my_browser"), ctx)
    assert late.is_error and "didn't answer in time" in late.content


async def test_an_agent_reads_freely_in_your_chrome_and_asks_before_a_click(authed, monkeypatch):
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.features.runs.models import Run
    from tests.api.test_agent import agent_turn, call, run_status, script, setup, timeline

    done: list[str] = []

    async def available() -> bool:
        return True

    async def act(session: uuid.UUID, action: str, **fields: Any) -> dict[str, Any]:
        done.append(action)
        return PAGE

    monkeypatch.setattr(browser_relay, "available", available)
    monkeypatch.setattr(browser_relay, "act", act)
    cid = await setup(authed)
    script(
        "check my inbox",
        [call("browser_open", url="https://example.com/", browser="my_browser")],
        [call("browser_click", ref=1, browser="my_browser")],
        [call("browser_click", ref=2, browser="my_browser")],
    )
    run_id = await agent_turn(authed, cid, "check my inbox")
    async with get_sessionmaker()() as db:
        run = await db.scalar(select(Run).where(Run.id == uuid.UUID(run_id)))
        assert run is not None and run.policy["my_browser"] is True
        assert "The user's own Chrome" in run.policy["system"]
    # Opening and following the link happened; the button waits for the user.
    assert done == ["open", "click"]
    assert await run_status(authed, run_id) == "waiting_approval"
    calls = (await timeline(authed, run_id))["tool_calls"]
    waiting = calls[-1]
    assert waiting["approval"]["summary"] == 'Click button "Send" (your Chrome)'
    assert waiting["actions"][0]["always_ask"]


async def test_runs_without_browser_control_switched_on_get_no_access(authed, monkeypatch):
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.features.runs.models import Run
    from tests.api.test_agent import agent_turn, setup

    async def unavailable() -> bool:
        return False

    monkeypatch.setattr(browser_relay, "available", unavailable)
    cid = await setup(authed)
    run_id = await agent_turn(authed, cid, "hello")
    async with get_sessionmaker()() as db:
        run = await db.scalar(select(Run).where(Run.id == uuid.UUID(run_id)))
        assert run is not None and run.policy["my_browser"] is False
        assert "The user's own Chrome" not in run.policy["system"]
