"""Browser tools: the agent drives a real (headless) browser, for pages that need
JavaScript, clicking or forms. All of them need the "Browser automation"
permission (browser.use).

After every action the agent gets the page as text plus a numbered list of what
it can click or type into, and uses those numbers for the next action. A
screenshot of each step is kept for the run's timeline.

The browser runs in its own container and its network traffic is filtered there,
so pages cannot reach the user's network (see browser/browserd/guard.py).
Everything a page shows is untrusted data for the model.

`browser="my_browser"` acts in the user's own Chrome instead, through Anemo Companion's
browser control (features/extension/browser_relay.py), in tabs the extension opened in
an "Anemo" tab group. That is its own permission ("browser.mine"): opening, reading,
scrolling, screenshots and following a link are safe; every other click and all typing
are asked about every time, whatever the permission settings say (`always_ask`).
"""

import asyncio
import base64
import binascii
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app import browser_client
from app.features.attachments import images
from app.features.extension import browser_relay
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.builtin.web import UNTRUSTED, _check_url, url_action

CAPABILITY = "browser.use"
MINE = "browser.mine"
Where = Literal["sandbox", "my_browser"]
WHERE_DESCRIPTION = (
    "sandbox (default): Anemo's own browser. my_browser: the user's Chrome (their logins), "
    "only when the user asks for it or the task needs their logged-in browser"
)
MINE_NOT_AVAILABLE = (
    "The user's Chrome can't be used right now ({reason}). Use browser='sandbox' instead, "
    "or ask the user to switch on browser control in Anemo Companion."
)
MINE_BOT_CHECK_NOTE = (
    "Note: this site is checking whether its visitor is a person (a bot check or CAPTCHA). "
    "Stop here: do not try to get past it and do not retry. Ask the user to solve it in "
    "the tab in their Chrome's “Anemo” tab group, then tell you to continue."
)
BOT_CHECK_NOTE = (
    "Note: this site is checking whether its visitor is a person (a bot check or CAPTCHA) "
    "and does not let this browser in. Do not try to get past it and do not retry. Either "
    "use another source (a search result, an official API, a different site), or tell the "
    "user: they can open the Browser panel of this chat, answer the check themselves, and "
    "then ask you to continue (you will find the browser where they left it)."
)


def render(state: dict[str, Any]) -> str:
    """The page as the model reads it."""
    lines = [f"Page: {state.get('title') or '(no title)'}", f"URL: {state.get('url', '')}"]
    if state.get("note"):
        lines.append(f"Note: {state['note']}")
    if state.get("botCheck"):
        lines.append(MINE_BOT_CHECK_NOTE if state.get("mine") else BOT_CHECK_NOTE)
    blocked = state.get("blocked_hosts") or []
    if blocked:
        lines.append(
            "Blocked (on the user's private network; they can allow hosts in Settings > "
            f"Web & Search): {', '.join(blocked[:5])}"
        )
    scroll = state.get("scroll") or {}
    if scroll.get("height", 0) > scroll.get("viewport", 0):
        lines.append(
            f"Scrolled to {scroll.get('y', 0)} of {scroll['height']} px "
            "(elements further down are listed too)."
        )
    text = state.get("text") or ""
    lines += ["", f"Text {UNTRUSTED}", text or "(no text)"]
    if state.get("textCut"):
        lines.append("[... the text was cut off; the page has more]")
    elements = state.get("elements") or []
    lines += ["", "What you can click or type into (use the number as ref):"]
    lines += elements or ["(nothing)"]
    if state.get("moreElements"):
        lines.append(f"(+{state['moreElements']} more not listed)")
    return "\n".join(lines)


async def _screenshot(ctx: ToolContext, state: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    """Stores the step's screenshot. Returns (attachment id, data for the timeline)."""
    raw = state.get("screenshot") or ""
    if not raw:
        return None, {}
    try:
        image = await asyncio.to_thread(images.prepare, base64.b64decode(raw))
    except (images.NotAnImage, binascii.Error, ValueError):
        return None, {}
    attachment_id = await ctx.add_image("browser.jpg", image)
    shown = {"attachment_id": attachment_id, "width": image.width, "height": image.height}
    return attachment_id, {"image": shown}


def _key(where: Where) -> str:
    return "browser_mine_elements" if where == "my_browser" else "browser_elements"


def _remember(ctx: ToolContext, state: dict[str, Any], where: Where = "sandbox") -> None:
    """Keep the element list, so the next approval can say what is being clicked (and, in
    the user's Chrome, whether a click only follows a link)."""
    names: dict[int, str] = {}
    for line in state.get("elements") or []:
        ref, _, rest = line.partition("] ")
        if ref.startswith("[") and ref[1:].isdigit():
            names[int(ref[1:])] = rest
    ctx.state[_key(where)] = names
    if where == "my_browser":
        links: dict[int, bool] = {}
        for item in state.get("links") or []:
            if isinstance(item, dict) and isinstance(item.get("ref"), int):
                links[item["ref"]] = bool(item.get("follow"))
        ctx.state["browser_mine_links"] = links


def _element(ctx: ToolContext, ref: int, where: Where = "sandbox") -> str:
    names: dict[int, str] = ctx.state.get(_key(where)) or {}
    return names.get(ref, f"element [{ref}]")


def follows_link(ctx: ToolContext, ref: int) -> bool:
    """In the user's Chrome: the element is a plain link to a web page (no download, no
    script), as the extension reported it with the last page."""
    links: dict[int, bool] = ctx.state.get("browser_mine_links") or {}
    return links.get(ref, False)


async def _act(
    ctx: ToolContext, action: str, where: Where = "sandbox", **fields: Any
) -> ToolResult | dict[str, Any]:
    if where == "my_browser":
        if not ctx.my_browser:
            reason = "browser control wasn't on when this message was sent"
            return ToolResult(content=MINE_NOT_AVAILABLE.format(reason=reason), is_error=True)
        try:
            state = await browser_relay.act(ctx.browser_session or ctx.run_id, action, **fields)
        except browser_relay.Unavailable as exc:
            return ToolResult(content=MINE_NOT_AVAILABLE.format(reason=exc), is_error=True)
        except browser_relay.ActionFailed as exc:
            return ToolResult(content=str(exc), is_error=True)
        state["mine"] = True
        _remember(ctx, state, where)
        return state
    try:
        state = await browser_client.act(
            ctx.browser_session or ctx.run_id,
            action,
            allowed_hosts=list(ctx.web.allowed_private_hosts),
            **fields,
        )
    except browser_client.BrowserUnavailable as exc:
        return ToolResult(content=str(exc), is_error=True)
    _remember(ctx, state)
    return state


def _mine_action(summary: str, risk: Literal["safe", "dangerous"] = "safe") -> Action:
    """An action in the user's Chrome. Not "safe": asked about every time."""
    return Action(
        capability=MINE,
        risk=risk,
        summary=f"{summary} (your Chrome)",
        always_ask="a click or typing in your own Chrome" if risk != "safe" else None,
    )


async def _step(
    ctx: ToolContext, action: str, where: Where = "sandbox", **fields: Any
) -> ToolResult:
    """One browser action: the page afterwards for the model, a screenshot for the user."""
    state = await _act(ctx, action, where, **fields)
    if isinstance(state, ToolResult):
        return state
    _, shown = await _screenshot(ctx, state)
    where_data = {"where": "my_browser"} if where == "my_browser" else {}
    return ToolResult(
        content=render(state),
        data={
            "browser": {"url": state.get("url"), "title": state.get("title"), **where_data},
            **shown,
        },
    )


class WhereInput(BaseModel):
    browser: Where = Field("sandbox", description=WHERE_DESCRIPTION)


class OpenInput(WhereInput):
    url: str = Field(max_length=2000)

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        return _check_url(v)


class BrowserOpen(Tool):
    name = "browser_open"
    description = (
        "Open a web page in a real browser. Use it for pages that need JavaScript, "
        "clicking or forms; for plain reading, read_web_page is faster. Returns the "
        "page's text and a numbered list of what can be clicked or typed into."
    )
    capability = CAPABILITY
    Input = OpenInput
    timeout_s = browser_client.ACTION_TIMEOUT_S + 10

    def actions(self, args: OpenInput, ctx: ToolContext) -> list[Action]:
        if args.browser == "my_browser":
            action = url_action(ctx, MINE, args.url, "Open in your Chrome:", "safe")
            return [action.model_copy(update={"resource": None})]
        action = url_action(ctx, CAPABILITY, args.url, "Open in the browser:", "safe")
        # No resource: approving "for this run" then covers the whole browsing session.
        return [action.model_copy(update={"resource": None})]

    async def run(self, args: OpenInput, ctx: ToolContext) -> ToolResult:
        return await _step(ctx, "open", args.browser, url=args.url)


class ReadInput(WhereInput):
    scroll: Literal["none", "down", "up", "top"] = Field(
        "none", description="Scroll first; 'none' just reads the page as it is now"
    )


class BrowserRead(Tool):
    name = "browser_read"
    description = (
        "Read the page that is open in the browser again, optionally after scrolling. "
        "Use it when the page may have changed or to see further down."
    )
    capability = CAPABILITY
    Input = ReadInput
    timeout_s = browser_client.ACTION_TIMEOUT_S + 10

    def actions(self, args: ReadInput, ctx: ToolContext) -> list[Action]:
        if args.browser == "my_browser":
            return [_mine_action("Read the page")]
        return [Action(capability=CAPABILITY, summary="Read the page in the browser")]

    async def run(self, args: ReadInput, ctx: ToolContext) -> ToolResult:
        return await _step(ctx, "read", args.browser, scroll=args.scroll)


class ClickInput(WhereInput):
    ref: int = Field(ge=1, le=10_000, description="The number of the element to click")


class BrowserClick(Tool):
    name = "browser_click"
    description = "Click an element on the open page (a link, button, checkbox, ...)."
    capability = CAPABILITY
    Input = ClickInput
    idempotent = False  # a click can submit a form or buy something
    timeout_s = browser_client.ACTION_TIMEOUT_S + 10

    def actions(self, args: ClickInput, ctx: ToolContext) -> list[Action]:
        if args.browser == "my_browser":
            what = _element(ctx, args.ref, "my_browser")
            if follows_link(ctx, args.ref):
                return [_mine_action(f"Follow the link {what}")]
            return [_mine_action(f"Click {what}", "dangerous")]
        return [
            Action(
                capability=CAPABILITY,
                risk="moderate",
                summary=f"Click {_element(ctx, args.ref)} in the browser",
            )
        ]

    async def run(self, args: ClickInput, ctx: ToolContext) -> ToolResult:
        return await _step(ctx, "click", args.browser, ref=args.ref)


class TypeInput(WhereInput):
    ref: int = Field(ge=1, le=10_000, description="The number of the field")
    text: str = Field(max_length=20_000, description="For a dropdown: the option to choose")
    press_enter: bool = Field(False, description="Press Enter afterwards (submits most forms)")


class BrowserType(Tool):
    name = "browser_type"
    description = (
        "Type into a field on the open page, replacing what is in it, or choose an "
        "option of a dropdown. Set press_enter to submit."
    )
    capability = CAPABILITY
    Input = TypeInput
    idempotent = False
    timeout_s = browser_client.ACTION_TIMEOUT_S + 10

    def actions(self, args: TypeInput, ctx: ToolContext) -> list[Action]:
        shown = args.text if len(args.text) <= 60 else args.text[:57] + "..."
        enter = " and press Enter" if args.press_enter else ""
        if args.browser == "my_browser":
            what = _element(ctx, args.ref, "my_browser")
            return [_mine_action(f"Type “{shown}” into {what}{enter}", "dangerous")]
        return [
            Action(
                capability=CAPABILITY,
                risk="moderate",
                summary=f"Type “{shown}” into {_element(ctx, args.ref)}{enter}",
            )
        ]

    async def run(self, args: TypeInput, ctx: ToolContext) -> ToolResult:
        return await _step(
            ctx, "type", args.browser, ref=args.ref, text=args.text, press_enter=args.press_enter
        )


class ScreenshotInput(WhereInput):
    pass


class BrowserScreenshot(Tool):
    name = "browser_screenshot"
    description = (
        "Look at the open page as an image (what a person would see). Use it when the "
        "text is not enough: layout, charts, images, or to check how something looks."
    )
    capability = CAPABILITY
    Input = ScreenshotInput
    timeout_s = browser_client.ACTION_TIMEOUT_S + 10

    def actions(self, args: ScreenshotInput, ctx: ToolContext) -> list[Action]:
        if args.browser == "my_browser":
            return [_mine_action("Take a screenshot")]
        return [Action(capability=CAPABILITY, summary="Take a screenshot of the browser")]

    async def run(self, args: ScreenshotInput, ctx: ToolContext) -> ToolResult:
        state = await _act(ctx, "screenshot", args.browser)
        if isinstance(state, ToolResult):
            return state
        attachment_id, shown = await _screenshot(ctx, state)
        where = f"{state.get('title') or '(no title)'} ({state.get('url', '')})"
        if attachment_id is None:
            return ToolResult(content=f"No screenshot could be taken of {where}.", is_error=True)
        data = {"browser": {"url": state.get("url"), "title": state.get("title")}, **shown}
        if not ctx.can_view_images:
            return ToolResult(
                content=f"A screenshot of {where} was saved for the user, but the current "
                "model cannot view images. Use browser_read for the page's text.",
                data=data,
            )
        return ToolResult(
            content=f"Screenshot of {where}. {UNTRUSTED}", data=data, images=[attachment_id]
        )


BROWSER_TOOLS: list[Tool] = [
    BrowserOpen(),
    BrowserRead(),
    BrowserClick(),
    BrowserType(),
    BrowserScreenshot(),
]
