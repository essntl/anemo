# Contracts between Anemo and Anemo Companion (toolset work, Nov 2026)

What the server side of the agent toolset work expects from the browser extension. The
server parts are built and tested; the extension parts are the extension agent's to build
(`extension/`). If one of these has to change, change this file first and say so: the two
sides are developed separately.

Everything below uses routes that exist already: the extension's token on `/api/extension/*`,
and browser-control commands on the extension's WebSocket (`features/extension/router.py`).

## 1. Share this tab with Anemo

**Decision:** the assistant gets a *copy* of the shared tab through a new tool,
`browser_current_tab`. The extension does not move the tab into the "Anemo" tab group.

Why the copy and not the tab group:

- It works in both builds. The tab-group route needs the browser-control build
  (`chrome.debugger`) switched on; sharing a page should not need the debugger.
- The user shares what is on the page at that moment and nothing more. A tab in the group
  can be re-read, scrolled and clicked by the assistant for as long as it stays there, on a
  page the user is using themselves.
- The extension already produces exactly this content for "Include this page"
  (`shared/pageContext.ts`: page, selection, PDF text, YouTube transcript), so the share
  action is a new button on existing code.
- Tabs that were not shared stay invisible by construction: the server only ever holds
  what the extension sent on a click.

It can be combined with the tab group later (acting on a shared tab) without changing this.

### What the extension does

On the user's action (toolbar button and/or context menu "Share this tab with Anemo") — and
only then, never on tab switches or navigation:

```
PUT /api/extension/shared-tab
{ "url": "https://…",            // http(s) only, ≤ 2000 characters
  "title": "…",                  // ≤ 300
  "source": "page" | "selection" | "pdf" | "youtube",
  "content": "…",                // readable text/Markdown, 1 … 130 000 characters
  "truncated": false }           // true when the middle was cut ([…] marks where)
→ 200 { "tab": { "url", "title", "source", "word_count", "truncated", "shared_at" } }
```

The same body as `TurnIn.page`, so `pageContext` output can be sent as it is. Other
endpoints:

```
GET    /api/extension/shared-tab   → { "tab": {…} | null }   what is shared now (no content)
DELETE /api/extension/shared-tab   → 204                      "Stop sharing"
```

Rules on the server: one shared tab at a time (a new share replaces the old one); it is
forgotten 12 hours after it was shared; it lives in Valkey, not the database; the content
is never returned by the API, only given to the assistant by the tool, labelled as
untrusted web content. A 422 means the body broke a limit above; a 503 means Valkey is down.

Suggested UI (the extension's call): show what is shared ("Shared with Anemo: <title>, 5 min
ago") with "Stop sharing", from the GET.

### What the assistant gets

`browser_current_tab(start?, max_chars?)`: URL, title, when it was shared, and the content
in parts of up to 15 000 characters. No approval (a "safe" action of the "Your own Chrome"
permission; "Never" there takes the tool away). With nothing shared it tells the assistant
to ask the user to share. It is not offered to unattended runs (automations).

## 7a. Hover, keys and waiting in the user's Chrome

Three new `action`s on the existing `browser.command` message. The sandbox browser
(`browser/browserd/app.py`) implements the same three; the tests there
(`browser/tests/test_browserd.py`) show the expected behaviour.

| action | fields | does | answer |
|---|---|---|---|
| `hover` | `ref` | Moves the pointer onto element `ref` (no click), waits ~400 ms for menus | the page state, as after `click` |
| `press` | `keys: string[]` (1–10), optional `ref` | Focuses `ref` if given, then presses the keys in order where the focus is | the page state |
| `wait` | `text`, `timeout_s` (1–30) | Waits until `text` shows on the page | the page state; on timeout still `ok: true`, with `state.note` saying it did not appear |

Details:

- **Keys** arrive already checked and spelled the Playwright/DOM way: `Enter`, `Escape`,
  `Tab`, `Backspace`, `Delete`, `Space`, `Home`, `End`, `PageUp`, `PageDown`, `ArrowUp`,
  `ArrowDown`, `ArrowLeft`, `ArrowRight`, or one ASCII letter or digit (lower case),
  optionally with `Control`, `Shift`, `Alt`, `Meta` in front, joined by `+` (`Control+a`,
  `Shift+Tab`). Refuse anything else. Keys go to the page (`Input.dispatchKeyEvent`), never
  to the browser itself.
- **Text with keys** (`browser_type` with both) is sent as two commands in your Chrome:
  `type` (unchanged, `press_enter: false`), then `press` with `Enter` first if `press_enter`
  was set. `type` itself is unchanged.
- **wait** matches case-insensitively with whitespace collapsed, against the page's visible
  text and the names of visible controls (`aria-label`, `placeholder`, `title`, `alt`,
  the value of non-password fields). The timeout note the sandbox uses:
  `“<text>” did not appear within <n> seconds. This is the page as it is now.`
- **Errors** as today: `{ok: false, error}`. An extension that does not know an action
  already answers `Unknown browser action “…”`, which the assistant is shown, so an old
  extension fails loudly rather than silently.
- **Approvals** are decided on the server, nothing to do in the extension: `hover` and
  `press` always ask (like a click or typing), `wait` is free (like reading).

## 3. YouTube transcripts through the user's Chrome (the fallback of `video_transcript`)

The server reads transcripts itself with yt-dlp (`backend/app/web/transcripts.py`). When
that fails for a YouTube link because the site blocked the server, the video is not
available to it, or the read failed for another reason (not when the video simply has no
captions), and browser control was on when the run started, the server asks the extension.
The assistant cannot tell which way a transcript came.

One more `action` on `browser.command`:

```
→ { "type": "browser.command", "id": "…", "session": "…", "action": "transcript",
    "url": "https://www.youtube.com/watch?v=…",     // any YouTube watch/short link form
    "lang": "en" }                                   // optional: the caption language wanted
← { "type": "browser.result", "id": "…", "ok": true,
    "state": { "transcript": {
        "title": "…", "channel": "…",
        "duration_s": 1234,                // whole seconds, or null if unknown
        "upload_date": "2024-05-01",       // YYYY-MM-DD, or null
        "language": "en",                  // the track's language code
        "kind": "manual" | "auto",         // written by a person / auto-generated
        "segments": [ { "start": 0.0, "text": "…" }, … ]   // start in seconds, in order
    } } }
```

- `state` carries only `transcript` here (no page text, elements or screenshot are needed).
- Track choice, to match the server: a written track before an automatic one; with `lang`,
  that language (a regional form counts: `en` → `en-US`); without it the video's own
  language, then English, then what there is.
- It is a read: the server asks for no approval ("safe" under "Your own Chrome"). It must
  not play, pause, seek, like or change anything on the page, and it should not steal
  focus (open the video in the "Anemo" group in the background, or use a tab of that
  video that is open already).
- Errors are `{ok: false, error: "<one sentence>"}`; the sentence is shown to the assistant
  after the server's own reason. Please keep three cases apart in the wording: no captions
  on this video; video unavailable or age-restricted; YouTube changed its page (the
  transcript could not be found where it used to be). An empty `segments` list is treated
  as "the extension returned no transcript", so prefer an error that says why.
- The server waits up to 90 s (the browser-control timeout) and caches a transcript for an
  hour, so a long one that the assistant reads in several parts is fetched once.

`extension/src/shared/youtube.ts` already reads transcripts in this order (decision E84);
what is new is doing it on a command and returning the fields above.
