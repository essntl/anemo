# Anemo Companion: investigation notes (Step 1)

Written against `main` at `360c8bd` (after the November 2026 refactor and bug-fix PRs
#21–#34). Line references are to that commit. Nothing in Anemo has been changed yet.

Sources: the code itself, `CLAUDE.md`, `docs/architecture.md`, `docs/security.md`,
`docs/deployment.md`, and the refactor audit (`refactor/audit/backend-api.md` has a complete
route table built by introspecting the FastAPI app; I checked the parts below against the code).

---

## 1. API endpoints the extension needs

Everything is under `/api`, JSON, errors are `{"error": {code, message, details}}`.
212 routes; the relevant ones:

### Chat (conversations + runs)
| What | Endpoint | Notes |
|---|---|---|
| List chats | `GET /conversations` | filters, search (`q`), project, tags; `ConversationOut` has `active_run_id` |
| New chat | `POST /conversations` `{title?, model_id?, project_id?, temporary?}` | |
| Rename/pin/archive/model/profile | `PATCH /conversations/{id}` | |
| Messages | `GET /conversations/{id}/messages` | `MessageOut`: text, reasoning, status, attachments, references, questions, versions |
| Send | `POST /conversations/{id}/turns` `{text, model_id?, attachment_ids[≤10], reference_ids[≤5], mode: chat\|agent, profile_id?, skill_id?}` | 202 → `{run_id, user_message, assistant_message}` |
| Regenerate / edit last / branch | `POST …/regenerate`, `…/edit-last`, `…/branch` | |
| Save chat as document | `POST …/save-document` | |
| Stop | `POST /runs/{id}/cancel` | also `pause`, `resume`, `PUT /runs/{id}/plan` |
| Run snapshot | `GET /runs/{id}` | |
| Agent timeline | `GET /runs/{id}/timeline` | tool calls with args, actions, risk, decision, approval |
| Files | `POST /attachments` (multipart; 25 MB, images 10 MB) | PDF/docx/xlsx/pptx text is extracted server-side (`attachments/extract.py`, pypdf) |
| Models, profiles | `GET /models`, `GET /profiles`, `GET /settings` (`models`, `general.default_chat_mode`) | |

**Streaming is SSE everywhere** (there are no WebSocket routes in Anemo):
- `GET /runs/{id}/events`: one run's events from Redis Streams. Every frame has `id:`;
  reconnecting with `Last-Event-ID` resumes exactly; the server replays from the start on a
  fresh connect, so a reducer can rebuild the partial answer. Falls back to DB status polling
  every 2 s when Valkey is down. Event types (`frontend/src/features/chat/runStream.ts`):
  `run.status`, `message.delta`, `reasoning.delta`, `message.question`, `run.model`,
  `run.fallback`, `run.restarted`, `tool.started`, `tool.completed`, `tool.denied`,
  `tool.progress`, `approval.requested`, `approval.resolved`, `plan.updated`,
  `run.pause_requested`, `run.pause_cancelled`, `context.compacted`, `memory.saved`.
- The frontend uses `EventSource`, which can't send an `Authorization` header. The extension
  will read the same streams with `fetch()` + a small SSE parser (sending `Last-Event-ID`
  itself). No server change needed for that.

### Approvals (reuse as-is)
- Created by the policy engine when a tool call is `ask`. Table `approvals`; kinds:
  **`action`** (a tool call), **`plan`** (plan review, editable steps), **`question`** (the
  agent's `ask_user`). The run goes to `waiting_approval`.
- Live signals: run event `approval.requested`/`approval.resolved`, and a **global**
  `approval.requested {run_id, conversation_id}` (`runtime/agent.py:1257`).
- `GET /approvals` (pending, with `conversation_id`, `tool_name`) and
  `POST /approvals/{id}` `{decision: approve|deny, scope: once|run, reason?, plan?, answer?}`
  (`features/runs/agent_router.py:163`). `decide_approval` is the single decision path (the
  push-notification buttons use it too). Unanswered approvals expire after 24 h.
- The extension needs **no server change** here: the panel lists pending approvals, shows the
  tool call details from the timeline, and posts the decision.

### Documents
- Markdown files under `documents/` in the workspace are the source of truth; the DB indexes
  them (`reconcile()` on every list/open). Folders = sub-directories; a project's documents are
  in `documents/<project-slug>/`.
- `GET /documents` (tree + folders), `GET /documents/recent`, `GET /documents/by-path`,
  `POST /documents {title, folder, content?}`, `GET/PUT /documents/{id}` (`PUT` takes
  `base_hash`, 409 on conflict), `POST /documents/{id}/move`, revisions.
- **No append endpoint.** Appending (save selection, YouTube notes, research) would be GET +
  PUT with `base_hash` and retry on 409. I plan a small server-side
  `POST /documents/{id}/append` so concurrent edits in Anemo can't be overwritten.
- Images: `POST /documents/assets` (multipart, png/jpg/gif/webp/svg/avif, 20 MB) stores into
  `documents/_assets/` and returns the workspace path. This is where captured video frames
  would go.
- Daily notes exist: `GET/PUT /daily-notes/{day}`, a document at
  `documents/[<project>/]daily/YYYY-MM-DD.md`. There is no "Inbox" document today.

### Tasks, projects, calendar, reminders
- `POST /tasks` `{title, description, status, priority 0–3, due_date, due_time,
  remind_minutes, rrule, tags, project_id, parent_id, checklist, blocked_by}`; `GET /projects`.
- `GET /calendar/events?start&end` (expanded occurrences), CRUD on events.
- Reminders: `remind_minutes` on an event or task; the worker's 30 s scheduler
  (`features/calendar/reminders.py`) claims each due reminder once and creates a notification
  of kind `reminder`. A date-only task counts as due at 09:00. Since the bug fixes, an invalid
  time zone falls back to UTC instead of stopping reminders.

### Focus timer — runs in the Anemo tab, not on the server
- `docs/architecture.md` §U and `frontend/src/features/focus/timerStore.ts`: **the running
  timer lives in each browser's localStorage** (`anemo-timer`); "each device owns what is
  happening on it". The server stores only finished sessions (`POST/GET /focus/sessions`,
  idempotent by `client_id`) and settings (`/settings/focus`).
- `POST /focus/phase-ended` adds a notification of kind `focus` only if
  `focus.save_to_notifications` is on.
- Global events: `focus.changed` (payload `{}`: "sessions list changed") and `focus.control`
  (agent tool `start_focus` → the most recently used open tab, via presence).
- **There is no endpoint that says "a focus session is running, N minutes left, on task X".**
  Feature 10 needs a decision (see questions).

### Music player — plays in the Anemo tab
- `frontend/src/features/music/player/controller.ts`: one queue per device in localStorage;
  playback through the YouTube IFrame API, the SoundCloud widget or `<audio>` inside the Anemo
  page. The server has the library and playlists (`/music/tracks`, `/music/playlists`).
- The agent's `queue_music` tool sends `music.control {tab, action: "queue", url|playlist,
  replace}` to the most recently used tab. There is no now-playing state on the server and no
  play/pause/skip command.
- **Feature 11 can only control an open Anemo tab** (or needs its own player). Needs a decision.

### Browser tools (for feature 12)
- `tools/builtin/browser.py`: `browser_open(url)`, `browser_read`, `browser_click(ref)`,
  `browser_type(ref, text, submit?)`, `browser_screenshot`; capability `browser.use`
  ("Always ask" by default); click/type rated `moderate`. All go through
  `_act(ctx, action, **fields)` → `browser_client.act()` → `browserd` (Playwright in its own
  container), which returns a state dict `{url, title, text, elements[numbered refs],
  botCheck, scroll, …}` rendered by `render()`. Password values are never echoed
  (`snapshot.js:65`). Bot checks/CAPTCHAs are detected by text + widget selectors
  (`snapshot.js:84-89`) and the model is told not to try.
- `_act` → `browser_client.act` is a clean seam: a `my_browser` backend can return the same
  state dict from the extension, so the tools and their rendering stay the same.

### Notifications
- `notifications.create()` (`features/notifications/service.py:67`) is the one entry point:
  stores a row (pruned after 90 days), queues one `notify.deliver` job per destination whose
  `kinds` include this kind, then publishes a global `notification` event
  `{id, title, body[:300], level, kind, link}`.
- Kinds: `reminder` (event and task reminders, "task ready"), `automation`, `approval`
  (automation approvals; and agent questions via `notify_question`), `agent` (the `notify`
  tool, test), `focus` (phase ended, opt-in). `URGENT_KINDS = ("approval", "reminder")`.
- Destinations: **Discord webhooks** (per-destination list of kinds) and **Web Push**
  (RFC 8291/8292 implemented in `webpush.py`, VAPID key stored encrypted; subscribing needs the
  password again). Push notifications for single approvals carry one-time Allow/Deny tokens.
- In the app: `GET /notifications`, `/summary`, `POST /notifications/read`; the frontend also
  shows browser notifications while a tab is open (`features/chat/agentAlerts.ts` for runs).
- What exists for each extension notification type:

| Feature 9 type | Today |
|---|---|
| Reminders and due tasks | notification `reminder` ✔ |
| Calendar events | notification `reminder` (only if the event has a reminder) ✔ |
| Finished long-running agent job | **no notification row**; only the global `run.status` event (with `kind`) |
| Tool-approval requests | in-chat runs: global `approval.requested` event only (questions also get a notification); automations: notification `approval` |
| Focus session ended | only in the tab running the timer (notification row only if opted in) |

- **No logic skips Discord when the user is present.** Presence (`events/presence.py`) exists
  only to pick a tab for agent commands.

### Global event stream
- `GET /events?tab=<id>` (SSE) relays the `events:global` Redis stream (max 1000 entries,
  replay by `Last-Event-ID`). Events: `notification`, `notifications.changed`, `run.status`,
  `approval.requested`, `conversation.updated`, `conversations.changed`, `tasks.changed`,
  `calendar.changed`, `document.changed`, `memory.changed`, `focus.changed`, `music.changed`,
  `focus.control`, `music.control`, `mcp.changed`, `automations.changed`.
- Open bug `sec-10` (`refactor/BUGS.md`): an open SSE stream keeps streaming after logout or
  session revocation (the session is checked only when it opens). The extension's stream must
  re-check its token, or revoking a token wouldn't cut it off.

---

## 2. Authentication today

- One user from `.env`. Login → cookie `aiw_session` (HttpOnly, SameSite=Lax, Secure per
  `COOKIE_SECURE`, 30 days sliding). Only a SHA-256 of the token is stored (`auth_sessions`).
- Every protected router depends on `require_session` (`api/deps.py:35`), which reads **only
  the cookie**. There are no API tokens or Bearer support.
- `RecentAuth` (password re-entered within 15 min) gates providers, MCP, notification
  destinations, push subscribe, and the sensitive settings sections (`permissions`,
  `workspace`, `web`) plus profile permission changes.
- `OriginCheckMiddleware` (`api/security.py`) rejects any non-GET `/api/` request whose
  `Origin`/`Referer` host isn't the app's own. Requests from the extension carry
  `Origin: chrome-extension://<id>`, so **today every POST from the extension would get 403
  `bad_origin`**.
- Sessions are listed and revocable in Settings → General (`GET/DELETE /auth/sessions`).

**Planned:** a new `api_tokens` table (name, SHA-256 hash, prefix for display, created,
last used, revoked) managed from Settings; `require_session` also accepts
`Authorization: Bearer` and returns a session-like principal. Tokens never satisfy
`RecentAuth`, so a stolen extension token can't change providers, permissions or MCP (my
recommendation; see questions).

---

## 3. Frontend stack and design language

- React 19.2, React Router 8, TanStack Query 5, zustand 5, Tailwind CSS 4 (Vite plugin),
  Radix (dialog/popover/select), lucide-react icons, `motion` for animation, Vite 8,
  TypeScript 6, oxlint, vitest + Testing Library, dependency-cruiser.
- Markdown (`components/ui/Markdown.tsx`): `react-markdown` + `remark-gfm` +
  `rehype-highlight` (no auto-detect) + `remark-math`/`rehype-katex` (loaded only when the text
  has `$`), Mermaid and charts in code fences, copy buttons on code blocks, remote images wait
  for a click. react-markdown never renders raw HTML, so it isn't run through DOMPurify;
  DOMPurify is used for Mermaid SVG. KaTeX has `trust` off.
- Tokens (`src/styles/tokens.css`, `app.css`):
  - Accent `--accent: #3478f6` (user-changeable), hover/soft variants via `color-mix`.
  - Light: bg `#f4f5f8`, surface `#ffffff`, surface-2 `#eef0f4`, text `#15171c`,
    muted `#6a7080`, subtle `#9aa0ad`, border `rgb(15 20 30 / .08)`.
  - Dark: bg `#0e1014`, surface `#15181e`, surface-2 `#1c2027`, card `#181b22`,
    text `#eceef2`, muted `#9aa1ae`, border `rgb(255 255 255 / .07)`.
  - Status: success `#1f9d55`/`#3ccf7a`, warning `#d97706`/`#f2a93b`, error `#dc3b3b`/`#f06464`.
  - Radii: control 10 px, card 18 px, panel 22 px. Two soft shadows. Base font 14 px.
  - Fonts: `Inter, MiSans, system-ui, …` and `JetBrains Mono, ui-monospace, …`. **No font
    files are shipped**: Inter is used only when installed locally, otherwise the system font.
  - Code highlight colours in tokens (One Light / One Dark-like).
  - Dark/light: `[data-theme='dark']`, from Settings → Appearance (`light|dark|system`).
    The extension will follow the system as specified, and can take the accent from
    `GET /settings` (appearance).
- Conventions for new Anemo code are in `CLAUDE.md` (routers thin, logic in services, API test
  per endpoint, `make gen-api` + committed `openapi.json`, import-boundary checks).

---

## 4. Deployment, CORS and the network path

- Behind Nginx Proxy Manager, then Cloudflare's proxy. Uvicorn runs with
  `--proxy-headers`; `TRUSTED_PROXIES` → `FORWARDED_ALLOW_IPS`.
- `docs/deployment.md` tells users to set `proxy_buffering off; proxy_read_timeout 1h;` and
  says "**WebSockets are not needed**". So the user's NPM host probably has "Websockets
  Support" off.
- **No CORS handling exists** anywhere. SSE frames already carry `X-Accel-Buffering: no`, and
  keep-alive comments every 15 s (Redis block).
- What the extension needs:
  - **Origin check:** allow `chrome-extension://<configured id>` for Bearer-authenticated
    requests only (cookie requests from that origin stay blocked).
  - **CORS:** extension pages and the service worker are *exempt from CORS* for hosts the
    extension has host permission for, and the Anemo origin is granted at setup. So CORS
    headers aren't technically required. The spec asks for them anyway; see question 3.
  - **WebSocket**, if chosen: NPM's "Websockets Support" toggle must be on. Cloudflare proxies
    WebSockets on all plans, but closes connections idle for ~100 s, so the extension pings
    every 20–25 s.
  - **Cloudflare challenges**: if Bot Fight Mode, "Under Attack" or a WAF challenge fires,
    API calls get an HTML page (403/503, header `cf-mitigated: challenge`). The client
    detects that and says so. Cloudflare Access would need its cookie (fetches from the
    extension send cookies for hosts it has permission for) or a service token.
- MV3 service-worker lifetime: since Chrome 116, **WebSocket traffic keeps an extension
  service worker alive** (Google's documented pattern: ping at least every 30 s). A streaming
  `fetch` (SSE) does *not* reliably keep it alive, so SSE is fine in the side panel (a normal
  page) but not as the worker's always-on channel.

---

## 5. What the current API supports for each feature

| # | Feature | Supported today | Server work needed | Difficulty / risk |
|---|---|---|---|---|
| 1 | Setup & connection | `/health`, `/auth/me` | API tokens + Bearer + Origin/CORS + token UI in Settings | low |
| 2 | Chat in panel | everything (conversations, turns, SSE, cancel, approvals, models) | none (Bearer only) | low–medium (SSE via fetch, approval cards incl. plan/question) |
| 3 | Page context | nothing | new `page` content block on a turn, wrapped as untrusted when the prompt is built (like `runtime/references.py`), shown in Anemo's UI | medium; PDF and YouTube are the hard parts (§6) |
| 4 | Learning actions | chat turns | none beyond 3 (quiz is a chat with a prompt) | low |
| 5 | Inline translate/explain | nothing | new streaming inline endpoint: no conversation, no memories/docs/project/profile, no tools; a provider call straight from the API process (allowed by the import contracts; memory and model tests already call providers from the API) | **hardest extension-side part**: in-place replacement keeping formatting, re-rendering sites, Shadow DOM on strict-CSP pages |
| 6 | Quick capture | documents, tasks, projects | `POST /documents/{id}/append` (atomic); maybe Inbox creation | low |
| 7 | YouTube notes | documents, assets | none (append helps) | medium–high: transcript access is fragile (§6), SPA navigation, ads |
| 8 | Research sessions | nothing | new storage + endpoints + write-up generation | medium |
| 9 | Notifications | notifications, global SSE, Web Push | authenticated event stream for the extension; optional Discord skip and "agent finished" notification depending on answers | medium (MV3 worker lifetime) |
| 10 | Focus mode | finished sessions only | **the running timer is not on the server** — needs a decision | medium–high depending on the option |
| 11 | Music controls | library, playlists, `music.control` queue command | play/pause/skip/now-playing relay from the Anemo tab, or a player of our own | medium; **can't work with no Anemo tab open** unless the extension gets its own player |
| 12 | Browser control | browser tools and a clean backend seam | backend selection per call, command relay over the event stream, approval rules | high (CDP, tab-group scoping, approvals); built last |

---

## 6. Feasibility of the hard parts

**Readability extraction.** `@mozilla/readability` bundled and injected with
`chrome.scripting.executeScript({files})` into the isolated world, then a function returns
`{title, byline, content(HTML→Markdown), textContent, lang}`. Isolated-world injection isn't
blocked by a page's CSP. Fallbacks: selection, then `document.body.innerText`. Not possible
on `chrome://`, the Chrome Web Store, other extensions' pages or `view-source:`; `file://`
needs the user to tick "Allow access to file URLs".

**PDFs in Chrome's viewer.**
- The selected text *is* available: the context menu's `info.selectionText` works in the PDF
  viewer. That covers Explain (box only) and "Discuss selection".
- Script injection into the viewer itself isn't possible (it's Chrome's own extension), so no
  in-place translation and no page-number detection. The current page isn't exposed; the URL
  has `#page=N` only if the link carried it.
- Full text: the extension fetches the PDF bytes from the tab's URL (with the user's cookies,
  so logged-in PDFs work) and uploads them to `POST /attachments`. Anemo already extracts PDF
  text server-side (pypdf). Per-page text is possible with a small server addition. `file://`
  PDFs need "Allow access to file URLs". Scanned PDFs without a text layer give nothing (no
  OCR).

**YouTube transcripts.**
- With the optional `https://www.youtube.com/*` permission, the extension can run a function
  in the page's main world: read `ytInitialPlayerResponse`, the current time
  (`video.currentTime`), ad state (`#movie_player.ad-showing`), seek, pause, and draw the
  current frame to a canvas (MSE video isn't cross-origin-tainted, so frame capture works).
- **Transcript text is the fragile part.** The caption track URLs in the player response now
  often need a proof-of-origin token and return empty. The workable route is YouTube's own
  internal `get_transcript` request made from the page context (what the "Show transcript"
  panel does), with a DOM fallback that opens that panel and reads its segments. Both break
  when YouTube changes its page. No captions → no transcript features for that video, and the
  panel says so. A server-side fetch from the homelab is usually blocked by YouTube.
- SPA navigation: with that host permission, `chrome.tabs.onUpdated` reports URL changes on
  YouTube tabs without the `tabs` permission, so the panel follows video changes without a
  persistent content script.

**In-page UI on strict-CSP pages.** Injected with `executeScript` (isolated world, not
subject to page CSP). Styles via constructable stylesheets on the Shadow root (not blocked by
`style-src`). KaTeX fonts can't be declared inside a shadow root (`@font-face` there is
ignored), so the in-page box would register the font faces on the document from
`chrome-extension://` URLs listed as web-accessible resources. Many extensions do this; it
lets a page detect that the extension is installed. Alternatively, math in the in-page box
could fall back to text.

**In-place translation keeping formatting.** Inline markup in the selected blocks is
serialised to numbered placeholder tags (`<1>bold</1>`, `<2 href>link</2>`), the model
translates while keeping the tags, and the result is rebuilt from clones of the original
elements. Originals are kept in memory for hover and "Restore". Inputs, textareas and
contenteditable are never replaced (box instead). Same-origin iframes can be handled with
`allFrames`/`frameIds`; cross-origin iframes only where the context-menu click happened
(`info.frameId`). React and similar apps may revert replaced text when they re-render, and
that can only be detected (MutationObserver) and reported or re-applied.

**Focus blocking.** `declarativeNetRequest` dynamic rules (optional permission) redirect
blocked domains to an extension page; rules are removed when the session ends. Each worker
wake-up (alarm every 30 s, startup, event) compares the rules with the session state and
removes stale ones, so a sleeping worker can't leave sites blocked. Catch: a DNR **redirect**
requires host permission for the blocked site; a plain **block** doesn't, but then Chrome
shows its own "blocked by an extension" error page instead of the focus page with the
remaining time. Options are in the questions: request host access per blocked domain when you
add it to the list, or plain blocking.

**Browser control (12).** Feasible with `chrome.debugger` (CDP): Accessibility tree for
refs, `Input.dispatch*` for trusted input, `Page.captureScreenshot`. While attached, Chrome
shows a "started debugging this browser" infobar that can't be hidden. Sites can sometimes
detect an attached debugger. `chrome.scripting` with synthetic events has no infobar but
produces `isTrusted: false` events that many sites ignore.

---

## 7. Things in the spec I'd do differently (raised in the questions)

1. **CORS headers aren't needed** for an extension with host permission; only the Origin
   check must change. Adding CORS headers widens what web pages could attempt, for no gain.
2. **One always-on WebSocket in the worker** needs NPM's WebSocket toggle (the deployment doc
   says it isn't needed today) and keeps the worker awake while Chrome runs. Anemo already has
   Web Push, which wakes the worker without a connection and queues events while Chrome is
   closed. A hybrid could be better (question 2).
3. **Focus and music state live in the Anemo tab**, so "react to Anemo's focus timer" and
   "now playing" need either a new server-side shared state or an open Anemo tab.
4. **Explain, translate and page context use whichever model you pick.** A dedicated
   "inline actions" model (cheap and fast) is worth having.
5. **Page content must not become memories.** Anemo extracts memories from chats after a run;
   a page could otherwise plant a "memory" through prompt injection.
6. **The badge is shared** by focus minutes, the research indicator and possibly unread
   approvals; it needs an order of priority.
