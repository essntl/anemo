# Anemo Companion

A Chromium extension (Chrome, Edge, Brave… version 116 or newer) for your own Anemo
server. It puts Anemo in the browser's side panel: chat about the page you're on, save
pages and selections, translate and explain text on the page, YouTube notes, research
sessions, Anemo's notifications, the focus timer with site blocking, and the music player.

It is a thin client. Everything it shows or does goes through your Anemo server: models,
memories, documents and tools all stay there.

- Technical choices and your answers that shaped them: [DECISIONS.md](DECISIONS.md)
- What was found in Anemo before building: [NOTES.md](NOTES.md)

## What you need

- Anemo at this version or later. It includes the server parts the extension uses: API tokens,
  the extension's live connection, page context, capture, inline translate/explain,
  research sessions and the shared focus timer. Run the migrations (`make migrate`, or a
  normal update).
- Behind a reverse proxy: **WebSockets** allowed for Anemo's address. In Nginx Proxy
  Manager that is the "Websockets Support" switch on the proxy host
  (see `docs/deployment.md`). Cloudflare's proxy passes them through.
- Node.js 22+ to build it.

## Install

```bash
cd extension
npm ci
npm run build
```

Then in Chrome:

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension/dist` folder.
3. Pin "Anemo Companion" from the puzzle-piece menu, so its icon is in the toolbar.

The extension always has the same id (`jpmimgldkledmklijfmfnbaaimmfjaaf`, fixed by the
`key` in `manifest.json`), which Anemo accepts by default. If you load it under another
id, add that id to `EXTENSION_IDS` in Anemo's `.env` and restart Anemo.

After pulling a new version: `npm run build` again, then the reload arrow on the
extension's card in `chrome://extensions`.

## Connect it to Anemo

1. **Create a token in Anemo:** Settings → General → **Extension and device tokens**.
   Give it a name (e.g. "Chrome on my laptop") and click Create. Anemo asks for your
   password again. The token is shown **once**, so copy it now.
2. **Click the extension's icon** (or press Alt+Shift+A). The side panel opens on setup.
3. Enter Anemo's address (e.g. `https://anemo.example.com`) and paste the token, then
   click **Connect**. Chrome asks to let the extension reach that address; allow it.

The token is kept in this browser only (`chrome.storage.local`, never synced). It can do
everything you can do in Anemo except what needs your password again. To revoke it, use
the same card in Anemo; the extension then goes back to its setup screen at once.

## What it does

| | Feature | Where |
|---|---|---|
| 1 | **Setup & connection**: address + token, a clear message for each way the connection can fail (offline, wrong address, Cloudflare challenge, revoked token…) | first start, Settings tab |
| 2 | **Chat**: Anemo's chats in the panel, streaming, with chat/agent mode, model picker, approvals, plan and question cards; the chat list is Anemo's own | Chat tab |
| 3 | **Page context**: the globe button attaches the page you're on (readable text, a PDF's text, a YouTube transcript), marked as untrusted, to your next message; it shows as a chip in Anemo too | Chat tab |
| 4 | **Learning actions**: Summarize, Quiz me (5 questions, one at a time), Discuss a selection | Chat tab, right-click menu |
| 5 | **Translate & explain on the page**: select text, right-click, Explain or Translate; Translate page; Restore all. Uses Anemo's "inline" model, with no memories, documents or tools | right-click menu |
| 6 | **Quick capture**: save the page or the selection to a document (formatted by Anemo's inline model, with Undo), or make a task | Capture tab, right-click, Alt+Shift+S / Alt+Shift+T |
| 7 | **YouTube notes**: timestamped notes per video in `documents/YouTube/`, optional frame, "Explain this moment" | Notes tab |
| 8 | **Research sessions**: a question, sources you add by hand, a chat across them, a cited write-up in `documents/Research/` | Research tab, right-click, Alt+Shift+R |
| 9 | **Notifications**: reminders, calendar, finished agent runs, approvals, focus over; per-type switches; caught up after the browser was closed; Discord skipped while you're here (optional) | Settings tab |
| 10 | **Focus mode**: Anemo's focus timer (the same timer as in Anemo), minutes left on the badge, distraction sites blocked during focus | Focus tab |
| 11 | **Music**: what's playing in your Anemo tab; play, pause, skip; add a link or the YouTube/SoundCloud tab you're on to the end of the queue | Focus tab |
| 12 | **Browser control** (Anemo's agent using your Chrome) | not built yet |

### Keyboard shortcuts

| Keys | Does |
|---|---|
| Alt+Shift+A | Open the panel |
| Alt+Shift+S | Save the selection to Anemo |
| Alt+Shift+T | Make a task from the page or selection |
| Alt+Shift+R | Add the page (or the selection) to the research session |
| (none) | Add a YouTube note: set a key at `chrome://extensions/shortcuts` |

## Permissions, and why

Always:

| Permission | Why |
|---|---|
| `sidePanel` | The extension lives in Chrome's side panel. |
| `storage` | The address, token and preferences (this computer only), and the panel's state. |
| `activeTab` | Reading the page you're on, only after you click the toolbar icon, a right-click entry or a shortcut on that tab. |
| `scripting` | Running our page reader and the translate/explain box in that tab (only then); our music relay in Anemo's own tabs. |
| `contextMenus` | The right-click entries. |
| `alarms` | Waking up to reconnect, and to end focus blocking on time. |
| `notifications` | Anemo's notifications as Chrome notifications. |

Asked for when needed (Chrome asks you; switching a feature off gives it back):

| Permission | When | Why |
|---|---|---|
| Your Anemo address | Setup | Talking to your server, and the music relay in its tabs. |
| `idle` | "Skip Discord while I'm here" | Telling Anemo whether this computer is in use. |
| `declarativeNetRequest` | "Block distractions during focus" | The blocking rules. |
| Each site you add to the distraction list | Adding it | Chrome only lets an extension redirect a site it has access to. |
| `https://www.youtube.com/*` | "YouTube notes" | Reading the video's time, pausing, frames, transcripts. |
| `debugger`, `tabs`, `tabGroups`, all sites | Browser control (not built yet) | |

The extension has no access to any site until you click on it, add it to a list, or switch on
a feature that needs it. Nothing runs on web pages by itself.

## Privacy and security

- Page content leaves the browser only when you act: attach, save, add to research,
  translate, explain or summarize. It goes only to your Anemo server.
- Page content sent to Anemo is marked as untrusted data: the model is told it isn't
  instructions. Pages can't trigger anything in the extension: nothing that changes
  something happens without your click in the panel or a right-click entry.
- What the extension shows inside a web page (the translate/explain box) never contains
  anything personal (memories, documents, other chats, the token), since the page's own
  scripts can read it.
- No tokens or page contents in logs. No remote code, `eval` or inline scripts.

## Known limitations

- **The panel can't read a tab you haven't clicked on.** Chrome gives an extension access
  to a tab only after you click its icon, use a right-click entry or a shortcut on that tab.
  Buttons in the panel ("Include this page", "Add this page", "Save page") on a tab you
  just switched to say so. Clicking the toolbar icon on that tab makes them work.
  (How this should work is still being decided.)
- **Chrome's PDF viewer** can't show the translate/explain box: on a PDF, the result
  shows in the side panel instead. Saving and chatting about PDFs works.
- **Chrome's own pages** (`chrome://…`, the Web Store, the new-tab page) can't be read or
  blocked by any extension.
- **YouTube transcripts** use YouTube's own internal transcript request. YouTube can change
  it at any time. When that happens, notes still work, but "Explain this moment" and
  transcripts as page context don't. Shorts aren't supported.
- **Focus blocking** applies when a page loads. A tab already open on a blocked site
  stays as it is, including moving within a site that doesn't load new pages (YouTube,
  Reddit). Reloading it or opening the site shows the focus page.
- **Music** controls the player in an Anemo tab in this Chrome: no tab, no music (the
  panel offers to open one). If the browser blocks autoplay in a tab you haven't used,
  press play in that tab once.
- **Chrome 116–119** wake the extension at most once a minute (newer: every 30 s). The
  badge's focus minutes update a little less often there; blocking still ends on time.
- **Translation in place** can be undone by sites that redraw their text. The extension
  reapplies for 10 seconds, then says the site reverted it.
- **Browser control** (feature 12) isn't built yet. When it is, use it in a **separate
  Chrome profile** with only the logins the agent should have: it acts with whatever the
  browser is signed in to.

## Development

```bash
npm run dev         # rebuild dist/ on change (reload the extension to pick it up)
npm run typecheck
npm run lint
npm test            # unit tests (vitest)
npm run e2e         # Playwright: the built extension in Chromium against a mock Anemo
```

The e2e build (`dist-e2e/`) adds a few host permissions so the tests don't hit Chrome's
permission prompts, which automation can't click. To also run the end-to-end tests
against a real Anemo, use a throwaway install with the fake model provider
(`ENABLE_FAKE_PROVIDER=true` and `e2e/scripts/seed-fake.mjs`), reachable at a
`127.0.0.1` address:

```bash
ANEMO_E2E_URL=http://127.0.0.1:8099 ANEMO_E2E_TOKEN=anemo_… npm run e2e
```

The extension imports two things from Anemo's frontend at build time: the API types
(`frontend/src/api/schema.d.ts`) and the focus timer's rules
(`frontend/src/features/focus/timer.ts`). After changing Anemo's API, run `make gen-api`
first.
