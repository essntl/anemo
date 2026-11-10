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
scrolling, waiting for text, screenshots and following a link are safe; every other
click, hovering, all typing and all key presses are asked about every time, whatever the
permission settings say (`always_ask`).

browser_current_tab is different: it reads the copy of a tab the user shared on purpose
("Share this tab with Anemo" in the extension; features/extension/shared_tab.py). It
works without browser control, and it is the only way a tab the agent did not open
reaches it. Reading it is a "safe" action under the same "browser.mine" permission.
"""

import asyncio
import base64
import binascii
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app import browser_client
from app.features.attachments import images
from app.features.extension import browser_relay, shared_tab
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
    wait_for: str | None = Field(
        None,
        min_length=1,
        max_length=200,
        description="Wait until this text shows on the page (in its text or as the name of "
        "a button or field; case doesn't matter), then read",
    )
    timeout_s: int = Field(
        10, ge=1, le=30, description="With wait_for: give up after this many seconds"
    )


class BrowserRead(Tool):
    name = "browser_read"
    description = (
        "Read the page that is open in the browser again, optionally after scrolling or "
        "after waiting for a text to appear (wait_for). Use it when the page may have "
        "changed, to see further down, or when content loads late. A wait that times out "
        "returns the page as it is, with a note; it cannot wait for something to disappear."
    )
    capability = CAPABILITY
    Input = ReadInput
    timeout_s = browser_client.ACTION_TIMEOUT_S + 10

    def actions(self, args: ReadInput, ctx: ToolContext) -> list[Action]:
        if args.browser == "my_browser":
            return [_mine_action("Read the page")]
        return [Action(capability=CAPABILITY, summary="Read the page in the browser")]

    async def run(self, args: ReadInput, ctx: ToolContext) -> ToolResult:
        if args.wait_for is None:
            return await _step(ctx, "read", args.browser, scroll=args.scroll)
        waited = await _step(
            ctx, "wait", args.browser, text=args.wait_for, timeout_s=args.timeout_s
        )
        if waited.is_error or args.scroll == "none":
            return waited
        return await _step(ctx, "read", args.browser, scroll=args.scroll)


class ClickInput(WhereInput):
    ref: int = Field(ge=1, le=10_000, description="The number of the element")
    action: Literal["click", "hover"] = Field(
        "click", description="hover: move the pointer onto the element without clicking"
    )


class BrowserClick(Tool):
    name = "browser_click"
    description = (
        "Click an element on the open page (a link, button, checkbox, ...), or with "
        "action='hover' only move the pointer onto it, for menus and tooltips that open on "
        "hover. Returns the page afterwards. It cannot drag, double-click or right-click."
    )
    capability = CAPABILITY
    Input = ClickInput
    idempotent = False  # a click can submit a form or buy something
    timeout_s = browser_client.ACTION_TIMEOUT_S + 10

    def actions(self, args: ClickInput, ctx: ToolContext) -> list[Action]:
        if args.action == "hover":
            if args.browser == "my_browser":
                what = _element(ctx, args.ref, "my_browser")
                return [_mine_action(f"Hover over {what}", "dangerous")]
            summary = f"Hover over {_element(ctx, args.ref)} in the browser"
            return [Action(capability=CAPABILITY, summary=summary)]
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
        return await _step(ctx, args.action, args.browser, ref=args.ref)


# Keys that can be pressed: a named key or one letter or digit, optionally with modifiers.
# The same rule as the sandbox browser's (browser/browserd/app.py) and the extension's.
KEY_NAMES = frozenset(
    {
        "Enter", "Escape", "Tab", "Backspace", "Delete", "Space", "Home", "End", "PageUp",
        "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    }
)  # fmt: skip
KEY_MODIFIERS = ("Control", "Shift", "Alt", "Meta")
_KEY_ALIASES = {
    "esc": "Escape", "return": "Enter", "del": "Delete", "ctrl": "Control", "cmd": "Meta",
    "command": "Meta", "option": "Alt", "up": "ArrowUp", "down": "ArrowDown",
    "left": "ArrowLeft", "right": "ArrowRight", "spacebar": "Space", " ": "Space",
}  # fmt: skip
_KEY_BY_LOWER = {k.lower(): k for k in (*KEY_NAMES, *KEY_MODIFIERS)}


def clean_key(key: str) -> str:
    """ "ctrl+A" → "Control+a". Raises ValueError for anything that is not one key with
    optional modifiers."""
    parts = [p.strip() for p in key.split("+")] if key != "+" else [key]
    names = [_KEY_ALIASES.get(p.lower(), _KEY_BY_LOWER.get(p.lower(), p)) for p in parts]
    *modifiers, last = names
    if len(last) == 1 and last.isascii() and last.isalnum():
        last = last.lower()
    elif last not in KEY_NAMES:
        raise ValueError(
            f"'{key}' is not a key. Keys: {', '.join(sorted(KEY_NAMES))}, or one letter or "
            f"digit; modifiers ({', '.join(KEY_MODIFIERS)}) go in front with '+', e.g. Control+a"
        )
    if any(m not in KEY_MODIFIERS for m in modifiers) or len(set(modifiers)) != len(modifiers):
        raise ValueError(f"'{key}': the modifiers are {', '.join(KEY_MODIFIERS)}, each once")
    return "+".join([*modifiers, last])


class TypeInput(WhereInput):
    ref: int | None = Field(
        None,
        ge=1,
        le=10_000,
        description="The number of the field. Needed with text; with only keys it is "
        "optional (the element to focus first; without it the keys go to whatever has "
        "the focus)",
    )
    text: str | None = Field(
        None, max_length=20_000, description="For a dropdown: the option to choose"
    )
    press_enter: bool = Field(False, description="Press Enter afterwards (submits most forms)")
    keys: list[str] = Field(
        default_factory=list,
        max_length=10,
        description="Keys to press one after the other, after the text if there is any: "
        "Escape, Tab, Enter, Backspace, Delete, Space, Home, End, PageUp, PageDown, "
        "ArrowUp/Down/Left/Right, or a letter or digit with modifiers, e.g. Control+a",
    )

    @field_validator("keys")
    @classmethod
    def _keys(cls, v: list[str]) -> list[str]:
        return [clean_key(k) for k in v]

    @model_validator(mode="after")
    def _something(self) -> "TypeInput":
        if self.text is None and not self.keys:
            raise ValueError("give text (with ref), keys, or both")
        if self.text is not None and self.ref is None:
            raise ValueError("text needs ref: the number of the field to type into")
        if self.text is None and self.press_enter:
            raise ValueError("press_enter goes with text; to press only Enter use keys")
        return self


class BrowserType(Tool):
    name = "browser_type"
    description = (
        "Type into a field on the open page, replacing what is in it, or choose an option "
        "of a dropdown; set press_enter to submit. Or press keys (Escape to close a "
        "dialog, Tab, arrow keys, Control+a, ...) with `keys`, alone or after the text. "
        "Keys go to the page only: no browser shortcuts, and no key held down."
    )
    capability = CAPABILITY
    Input = TypeInput
    idempotent = False
    timeout_s = 2 * browser_client.ACTION_TIMEOUT_S + 10

    def _summary(self, args: TypeInput, what: str | None) -> str:
        parts = []
        if args.text is not None:
            shown = args.text if len(args.text) <= 60 else args.text[:57] + "..."
            enter = " and press Enter" if args.press_enter else ""
            parts.append(f"Type “{shown}” into {what}{enter}")
        if args.keys:
            where = f" in {what}" if what and args.text is None else ""
            parts.append(f"{'p' if parts else 'P'}ress {', '.join(args.keys)}{where}")
        return ", then ".join(parts)

    def actions(self, args: TypeInput, ctx: ToolContext) -> list[Action]:
        if args.browser == "my_browser":
            what = _element(ctx, args.ref, "my_browser") if args.ref else None
            return [_mine_action(self._summary(args, what), "dangerous")]
        what = _element(ctx, args.ref) if args.ref else None
        return [Action(capability=CAPABILITY, risk="moderate", summary=self._summary(args, what))]

    async def run(self, args: TypeInput, ctx: ToolContext) -> ToolResult:
        if args.text is None:
            ref = {"ref": args.ref} if args.ref else {}
            return await _step(ctx, "press", args.browser, keys=args.keys, **ref)
        if args.browser == "my_browser" and args.keys:
            # Two commands: an extension that does not know "press" yet says so, instead
            # of typing and silently leaving the keys out.
            typed = await _step(
                ctx, "type", args.browser, ref=args.ref, text=args.text, press_enter=False
            )
            if typed.is_error:
                return typed
            keys = [*(["Enter"] if args.press_enter else []), *args.keys]
            return await _step(ctx, "press", args.browser, keys=keys)
        return await _step(
            ctx,
            "type",
            args.browser,
            ref=args.ref,
            text=args.text,
            press_enter=args.press_enter,
            **({"keys": args.keys} if args.keys else {}),
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


class CurrentTabInput(BaseModel):
    start: int = Field(0, ge=0, description="Character offset, to continue a long page")
    max_chars: int = Field(15_000, ge=500, le=15_000)


NOTHING_SHARED = (
    "The user has not shared a tab (or shared it more than 12 hours ago). You cannot see "
    "their tabs yourself: ask them to open the page and choose “Share this tab with Anemo” "
    "in the Anemo Companion extension, then try again."
)
_SHARED_WHAT = {
    "page": "the page's main content",
    "selection": "the text the user selected on the page",
    "pdf": "the PDF's text",
    "youtube": "the video's transcript",
}


def _ago(then: datetime) -> str:
    minutes = max(0, int((datetime.now(UTC) - then).total_seconds() // 60))
    if minutes < 1:
        return "just now"
    if minutes < 60:
        return f"{minutes} min ago"
    return f"{minutes // 60} h {minutes % 60} min ago"


class BrowserCurrentTab(Tool):
    name = "browser_current_tab"
    description = (
        "Read the tab the user last shared from their own Chrome with “Share this tab with "
        "Anemo”: its URL, title and readable content. Use it when they ask about “this "
        "page”, “my current tab” or what they are looking at. It is a copy from the moment "
        "they shared it: you cannot click, scroll or reload it, and you cannot list or read "
        "any tab they did not share. If nothing is shared it says so; ask the user to share."
    )
    capability = MINE
    Input = CurrentTabInput

    def actions(self, args: CurrentTabInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=MINE, summary="Read the tab you shared (your Chrome)")]

    async def run(self, args: CurrentTabInput, ctx: ToolContext) -> ToolResult:
        tab = await shared_tab.current()
        if tab is None:
            return ToolResult(content=NOTHING_SHARED, is_error=True)
        text = tab.content[args.start : args.start + args.max_chars]
        end = args.start + len(text)
        lines = [
            f"Page: {tab.title or '(no title)'}",
            f"URL: {tab.url}",
            f"Shared by the user {_ago(tab.shared_at)} ({_SHARED_WHAT[tab.source]}, as it "
            "was then).",
            "",
            f"Text {UNTRUSTED}",
            text or "(no text at this offset)",
        ]
        if end < len(tab.content):
            lines += [
                "",
                f"[Characters {args.start:,}-{end:,} of {len(tab.content):,}. "
                f"Call browser_current_tab again with start={end} for more.]",
            ]
        if tab.truncated:
            lines += ["", "[The page was longer; the middle was left out ([…] marks where).]"]
        return ToolResult(
            content="\n".join(lines),
            data={"browser": {"url": tab.url, "title": tab.title, "where": "shared_tab"}},
        )


BROWSER_TOOLS: list[Tool] = [
    BrowserOpen(),
    BrowserRead(),
    BrowserClick(),
    BrowserType(),
    BrowserScreenshot(),
]
