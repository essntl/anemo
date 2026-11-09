# Anemo Companion: decisions

Two kinds: **your answers** to the Step 1 questions (behaviour), and **technical choices** I
made (internal structure, naming, tooling). Anything that changes what you'd experience was
asked first. Question numbers refer to the list sent on 2026-11-09 (also summarised in
`NOTES.md`).

## Your answers (2026-11-09)

You took every recommendation; Cloudflare runs only as a proxy (no Access, Bot Fight Mode
or WAF challenges).

| # | Topic | Decision |
|---|---|---|
| 1 | Panel UI | React 19 + Tailwind 4 (Anemo's stack); in-page UI in plain TS + Shadow DOM |
| 2 | Event transport | WebSocket held by the service worker (Chrome 116+ keeps it alive), `chrome.alarms` check as fallback. Needs NPM "Websockets Support" |
| 3 | CORS | No CORS headers; the Origin check lets Bearer requests from the extension's id through |
| 4 | Token power | Everything except actions that need the password again |
| 5 | Token UI | Settings → General, next to the sessions |
| 6 | Cloudflare | Proxy only; detect challenge/HTML responses anyway |
| 7 | Panel defaults | Follow Anemo's default mode and model, with a picker |
| 8 | Page length | ~30k tokens; cut the middle, keep start and end, with a marker; the chip says "truncated" |
| 9 | Page in Anemo's UI | A chip with title + URL; click shows the attached text |
| 10 | Memories | Page content never used for memory extraction |
| 11 | PDFs | The extension fetches the PDF (your cookies), the server extracts text with page numbers; selection works in the viewer |
| 12 | YouTube transcripts | YouTube's own transcript request from the page, fallback to the transcript panel; say when there are none |
| 13 | Quiz | 5 questions, mixed multiple choice and short answer, one at a time, graded each, summary at the end |
| 14 | Summarize | TL;DR + key points, length adapts |
| 15 | Approvals | action, plan and question cards in the panel; plan editing opens Anemo |
| 16 | Inline model | New "Inline actions" model setting, falls back to the chat model |
| 17 | Inline logging | Usage/cost record only, no text |
| 18 | Multi-paragraph | In place, block by block; ask above ~3,000 words |
| 19 | Translate page | Yes, page context menu entry, progressive, Restore all |
| 20 | Word breakdown | Selections of ≤ 8 words in a language other than the target |
| 21 | Explanation language | The default target language |
| 22 | Save from box | Selection + explanation + source link, to a document you pick |
| 23 | Re-render | Re-apply for 10 s, then show "the site reverted this" |
| 24 | Shortcuts | Alt+Shift+A panel, Alt+Shift+S save selection, Alt+Shift+T quick task, Alt+Shift+R add to research; YouTube note unassigned |
| 25 | Saved pages | Clean Markdown by default, `documents/Web clips/` |
| 26 | Inbox | `documents/Inbox.md`, created when first needed |
| 27 | Quick task | Title from selection/page title, link in description, no due date, last used project |
| 28 | YouTube pause | Pause when you start a note, resume on save/cancel |
| 29 | Explain window | ±60 s |
| 30 | Frames | Optional per note, image in `documents/_assets/`, embedded in the note |
| 31 | Folder | `documents/YouTube/` |
| 32 | Shorts | Explicitly unsupported |
| 33 | Research storage | New entity (sessions + sources with stored content); UI in the extension; write-ups are documents |
| 34 | Write-up | Default structure; pick notes / essay outline / comparison table at the end; `documents/Research/` |
| 35 | Session chat | One conversation per session ("Research: …"), sources attached as untrusted context; summaries when they don't fit |
| 36 | Badge | Focus minutes > research marker > pending approvals |
| 37 | Missed events | Last 24 h shown at startup; more than 3 → one summary |
| 38 | Discord | Skipped while the extension is connected and the computer was used in the last 5 min (adds the `idle` permission) |
| 39 | Focus hold-back | Hold everything except approvals and reminders; summary when focus ends |
| 40 | Agent finished | Agent runs over 2 min or whose chat isn't open; extension only |
| 41 | Focus timer | Running timer moves to the server as one shared state; Anemo keeps a local fallback |
| 42 | Blocking page | Request host access per blocked domain |
| 43 | Distractions | Empty list, focus phases only, no bypass |
| 44 | Music | Control the Anemo player in an Anemo tab in this Chrome; offer to open one |
| 45 | Browser control | `chrome.debugger` (asked again before feature 12 starts) |
| 46 | Auto-off | 10 min |
| 47 | Blocklist | Banking/payment, government/tax, webmail, password managers, accounts.google.com, Chrome Web Store, `chrome://` (editable) |

### Follow-up (2026-11-09): formatting saved content with the inline model

When page or selection content is saved into Anemo, the inline model (your Qwen 27B, 128k
context) formats it instead of pasting raw text. You took every recommendation:

| # | Topic | Decision |
|---|---|---|
| F1 | Which saves | Every save of page/selection content into a document: append to a document, save page as a new document, the explain box's save, the Inbox |
| F2 | What may change | Formatting only (headings, lists, tables, code, links, removing extraction noise); wording kept, nothing summarised |
| F3 | Existing documents | Always appended at the end under a heading with source and date; the model sees only the document's heading outline to match its style |
| F4 | Preview | Saved directly with "Saved · View · Undo" (undo restores the previous revision) |
| F5 | Failure | Falls back to the extension's own clean Markdown, saying "saved without formatting" |
| F6 | Long pages | Split by sections and formatted piece by piece with progress. With a 128k window and output about as long as input, a piece is at most ~40k tokens; shorter pages go in one piece |
| F7 | Setting | "Inline & formatting model" in Settings → Models, falling back to the chat model |

This runs through its own server endpoint (the result goes to Anemo, not into a web page),
separate from the in-page translate/explain endpoint, which keeps its no-personal-context
rule.

## Technical choices

### Server

| # | Choice | Why |
|---|---|---|
| T1 | API tokens live in `features/auth/` (`models.ApiToken`, `tokens.py`, routes under `/api/auth/tokens`), table `api_tokens` (migration 0030). Revoking deletes the row. | Next to sessions, which work the same way (hash only). A deleted row can't be used by mistake; the security log keeps the history. |
| T2 | A token request gets a stand-in `AuthSession` (not stored) with `token_id` set and `reauth_at` empty, from the existing `require_session`. | Every protected route keeps working unchanged, and `RecentAuth` refuses tokens without touching any of the 16 routes that use it. |
| T3 | `BrowserSession` dependency for logout, reauth and the sessions list/revoke: tokens get 403 `session_required`. | A token must not be able to "confirm the password" and so lift its own limit. |
| T4 | A Bearer header wins over the cookie; a bad Bearer header is a 401 even with a valid cookie. | So a revoked token always ends in a 401 (the extension goes back to setup), never silently falls back to a cookie. |
| T5 | Token format `anemo_` + 43 random URL-safe characters (256 bits); the list shows the first 10 characters. | Recognisable in logs and secret scanners; the prefix tells tokens apart. |
| T6 | `last_used_at`/`last_used_ip` written at most every 5 minutes. | Same as sessions: no write per request. |
| T7 | `POST /auth/tokens` needs `RecentAuth`; `DELETE /auth/tokens/current` lets a token revoke itself. | Creating a lasting login is security-sensitive; the extension's "Disconnect" revokes its own token. |
| T8 | `EXTENSION_IDS` env var (default: Anemo Companion's fixed id `jpmimgldkledmklijfmfnbaaimmfjaaf`, pinned by the manifest `key`). | A fixed id makes the default work for everyone loading the unpacked extension; the private key is not kept (not needed for "Load unpacked"). |

### Server: event stream (feature 9)

| # | Choice | Why |
|---|---|---|
| T9 | `features/extension/router.py`: WebSocket `/api/extension/ws`, mounted outside the cookie-protected router; it authenticates itself. Origin must be an allowed extension id (else close 4403); the token comes in a `hello` message within 10 s (4408), never in the URL; it is rechecked every 60 s (4401 when revoked; closes the gap `sec-10` describes for this stream). | Browsers can't put headers on a WebSocket; a token in the URL would land in NPM/Cloudflare access logs. |
| T10 | It relays a fixed list of global events (`FORWARDED`) from the existing Valkey stream, starting at the client's `last_id` (or the newest event); the welcome says `missed` when that id was trimmed, and carries the `cursor` it starts from. | Reuses Anemo's event bus as is; the cursor lets a client resume after a drop even before its first event. |
| T11 | Presence for "Skip Discord" is one Valkey key (`presence:extension`, 90 s expiry) set from the extension's reports; `notifications.create` checks it once per notification with a Discord copy due (default routing only) and records the skipped copy with status `skipped`. | Fails safe: no key (closed browser, Valkey down) means Discord gets everything as before. |

### Server: page context (feature 3)

| # | Choice | Why |
|---|---|---|
| T12 | A `PageRef` content block (`providers/base.py`) on the user message holds url, title, source (page/selection/pdf/youtube), content, word count and a truncated flag; `TurnIn.page` sets it (content ≤ 130,000 characters). `runtime/pages.py` renders it, in `resolve_attachments`, as `<untrusted_page_content source url title>` with a note that it is data, not instructions, and neutralises a closing tag inside the content. | The same path Anemo uses for referenced chats; the block survives edit-last and branch unchanged. |
| T13 | Page content is never in `text_plain`, so memory extraction, search and titles don't see it; memory retrieval reads only typed text blocks; `memory/extraction.without_page_answers` also leaves out the assistant's answer to a message that carried a page. | Your answer 10: an answer quotes the page, so it could carry a planted "memory" too. |
| T14 | `MessageOut.page` (summary, no content) and `GET /conversations/{id}/messages/{mid}/page`; Anemo's chat shows a `PageChip` that opens the text as plain text in a dialog, linking only to http(s) addresses. | Your answer 9. |
| T15 | `POST /api/extension/pdf-text` returns a PDF's text page by page (`attachments.extract.pdf_pages`, shared with attachments; 50 MB, nothing stored). | Your answer 11: the extension fetches the PDF with your cookies; page numbers are kept as `[Page n]`. |

### Server: quick capture (feature 6)

| # | Choice | Why |
|---|---|---|
| T16 | `features/capture/`: `POST /api/capture` queues a `capture.save` job (interactive lane, one attempt) and returns an id; progress and the result come as `capture.progress`/`capture.finished` global events (forwarded to the extension) and `GET /api/capture/{id}` (Valkey, 24 h). | Formatting a long page on a local model can take longer than Cloudflare's 100 s; a job also finishes when the panel is closed. One attempt: a retry could save twice. |
| T17 | New model task `inline` (Settings → Models → "Inline & formatting"; falls back to the chat model). Formatting prompt: keep the wording, fix structure, drop boilerplate, headings start at the target's section level, content fenced as `<untrusted_web_content>`, never follow instructions in it. Summary prompt: TL;DR + key points. Pieces of ≤ 40k tokens split at headings, then paragraphs. No model, or it fails: the content is saved as it came and the result says `formatted: false`. Usage recorded as `format`/`summarize`. | Your answers F1–F7 (128k context, output ≈ input). |
| T18 | New document: `documents/Web clips/<slug>.md` with `# Title`, `Source: [site](url) · Saved <date>` (your time zone). Append: a section at the document's own level (the lowest heading level below its title, default `##`) with `*[site](url) · <date>*`, at the end; re-read and retried up to 3 times if the document changed during formatting. Selections with an explanation: the selection quoted, then the explanation. Inbox: `documents/Inbox.md`, created with `# Inbox` when first needed. | Your answers 25, 26, F3. |
| T19 | Saves are written as author `extension` (Anemo shows "Anemo Companion" in the history, "saved from the browser" in the list) with a new revision; Undo = restore the revision from before the save, or delete a document the save created. | Your answer F4; `last_editor` holds 10 characters. |

### Extension

| # | Choice | Why |
|---|---|---|
| E1 | `extension/` is its own npm package (React 19, Tailwind 4, Vite 8, TypeScript 6, vitest, oxlint, Playwright 1.63), the same versions as `frontend/`. | Same stack and tooling as Anemo; no shared `node_modules`, so neither side can break the other's build. |
| E2 | Build: `scripts/build.mjs` runs Vite three ways: the pages (side panel, focus page) with `vite.config.ts`; the service worker as one ES module (`background.js`); each in-page script as one self-contained IIFE (`inpage/*.js`). `--watch` for `npm run dev`. | `executeScript({files})` needs a classic script with no imports; a worker without chunks starts faster and can't fail on a missing chunk. |
| E3 | Types come straight from Anemo's generated `frontend/src/api/schema.d.ts` (alias `@anemo/schema`) through `openapi-fetch`. | One API contract: a changed Anemo endpoint breaks the extension's typecheck instead of failing at runtime. |
| E4 | Colours: the panel's CSS imports `frontend/src/styles/tokens.css` and repeats Anemo's semantic Tailwind mapping. Light/dark follows the system (`prefers-color-scheme`); the accent comes from Anemo's Appearance setting, cached in `chrome.storage.local`. | Single source of truth for the palette; the user's accent shows in the extension too. |
| E5 | `ApiError.kind` classifies every failure (offline, unreachable, timeout, permission, server_down, challenge, html, not_anemo, unauthorized, origin, http). Cloudflare challenges are recognised by `cf-mitigated: challenge` or the challenge page; 502/503/504/52x as "proxy up, Anemo down". | The setup screen and the connection banner can say what's wrong and what to do. |
| E6 | The connection test runs three steps: `GET /api/health` (is it Anemo), `GET /api/auth/me` (token), `POST /api/permissions/preview` (does the Origin check let the extension in; computes a summary, changes nothing). | Each failure names its step; the POST catches an old Anemo or a wrong `EXTENSION_IDS` before the first real change fails. |
| E7 | A 401 anywhere clears the token (keeps the address) and records `lostReason: 'revoked'`; the panel shows setup with that reason; the worker reacts to the same storage change. | One path back to setup, wherever the 401 happened. |
| E8 | Requests use `credentials: 'omit'`. | Only the token counts; a cookie can't hide a revoked token. |
| E9 | Messages: `classifySender()` accepts a message only from this extension's id; from a tab only if we injected a script there and the type is an in-page type; panel-only types only from our own pages. Web pages can't message the extension (no `externally_connectable`). | The spec's "validate sender on every message", in one tested function. |
| E10 | Optional features: `FEATURE_PERMISSIONS` maps each to its permissions; switching one on requests them from the click, switching off releases them. Features without extra permissions start on. Browser control asks for `https://*/*` + `http://*/*` (equivalent to `<all_urls>` for web pages, and already in `optional_host_permissions`). | Permissions are asked for only when a feature is first enabled. |
| E11 | E2E: Playwright loads `dist-e2e/` (`npm run e2e` builds it) with a mock Anemo (`tests/e2e/mockAnemo.ts`) that checks Bearer, no cookies and the Origin like the real server. The test build alone gets `host_permissions: ["http://127.0.0.1/*"]`, because automation can't click Chrome's permission prompt. `tests/e2e/real-anemo.spec.ts` runs the same flow against a real Anemo when `ANEMO_E2E_URL`/`ANEMO_E2E_TOKEN` are set. | Tests the real extension in a real Chromium; the real-server spec proves the contract end to end. |
| E12 | Debug logging only in `npm run dev` builds (`__DEV__`); log calls take ids and sizes, never tokens or texts. | "Never log tokens or page content in production." |
| E13 | Chat streams run events with `fetch` + an SSE parser (`shared/sse.ts`) in the side panel, resuming with `Last-Event-ID` after a drop (backoff 0.5 s doubling to 30 s), stopping at a terminal status, a 401 or a 404. The reducer mirrors Anemo's `runStream.ts`. | EventSource can't send the token. Same events, same rendering as Anemo. |
| E14 | Server state through TanStack Query with Anemo's query keys; one cache per connection (keyed by server and token). | Same pattern as Anemo; reconnecting never shows the previous server's data. |
| E15 | The open chat and drafts per chat are in `chrome.storage.local` (`chat`); switching chats takes effect at once in memory, the storage write follows. Each chat is a component keyed by its id. | Reopening the panel resumes; nothing typed right after a switch lands in the wrong chat. |
| E16 | Panel Markdown: react-markdown (never inserts raw HTML) + GFM + highlight.js (no auto-detect) + KaTeX (`trust` off, fonts bundled). Links: Anemo paths (`/documents/…`) open in Anemo, http/https/mailto in a new tab, anything else (javascript:, data:, protocol-relative) is dropped. Remote images wait for a click. DOMPurify is used where HTML is produced from Markdown (the in-page box, feature 5); in the panel no HTML string is ever produced, so there is nothing for it to clean. | Same safety as Anemo's own Markdown; the spec's sanitising goal without a step that would do nothing. |
| E17 | Approval cards use `GET /runs/{id}/timeline` (refetched on each tool/approval/plan event) and `POST /approvals/{id}`. Plans can be approved or sent back with feedback; editing steps links to the chat in Anemo. | Your answer 15; Anemo's own decision path. |
| E18 | The chat view keeps itself scrolled to the bottom with a ResizeObserver on its content (unless you scrolled up). | Approval cards and tool calls load a moment after their event; a scroll on each event missed them. |
| E19 | The service worker keeps the event stream (`background/stream.ts`): hello with token and last id, ping every 20 s, presence every 30 s, a 50 s silence watchdog for half-open connections, backoff 1 s doubling to 60 s with jitter; 4401 → back to setup, 4403 → stop. A 1-minute alarm reconnects after the worker was stopped. Socket and timers are injected for tests. | Chrome 116+ keeps the worker alive while a WebSocket is active; the alarm covers the rest. |
| E20 | Notification rules are pure functions (`background/notify.ts`), tested without Chrome: kind/link → type and target; approval questions and live approval requests share one id per chat (one notification); agent runs notify when user-started, completed/failed, and over 2 min or not in view. Texts are clipped to 200 characters. | Your answers 37–40, in one tested place. |
| E21 | Catch-up: replayed events in the 1.5 s after a welcome are collected; if the server says `missed` (or there is no last id), unread notifications and pending approvals since the last event seen are fetched by REST. Only the last 24 h; more than 3 → one summary that opens Anemo's Notifications page. The first connection ever shows nothing old. | Your answer 37. |
| E22 | Clicking a notification opens the panel on the chat (calling `sidePanel.open` before any `await`, while Chrome still counts the click as a user action), with targets kept in memory and in session storage; if Chrome refuses, the chat opens in Anemo in a tab. Tasks and calendar open in Anemo. | `sidePanel.open` only works during a user action. |
| E23 | Held notifications (focus) are kept in `chrome.storage.local` and released as one summary (or the one itself) when `focusState.active` turns false. Feature 10 keeps `focusState` current. | Survives the worker stopping during a long focus session. |
| E24 | The badge is computed from three inputs in priority order (focus minutes, research dot, pending approvals); approvals are counted from `GET /api/approvals` on each approval or run event. | Your answer 36. |
| E25 | Page reading: `inpage/extract.js` is injected on demand (isolated world: the page's scripts can't see it, its CSP doesn't apply) and called by a second `executeScript`; it runs Readability on a clone of the document and converts the article to Markdown there (turndown + GFM; scripts, forms, data URIs and non-http links dropped). Fallbacks: the selection, then the visible text. PDFs (by address or content type) are fetched by the extension with the site's cookies and sent to `/api/extension/pdf-text`. | The worker has no DOM; the page does. Reads only, sends nothing itself. |
| E26 | Length: ~30k tokens (120,000 characters); longer pages keep about 2/3 of the room for the start and 1/3 for the end, cut at paragraph boundaries, with `[… N words left out …]`; the chip says "shortened". | Your answer 8. |
| E27 | "Include this page" is per message (a Globe toggle in the composer); the chip shows title, site, word count and "selection/PDF/shortened" before sending, with re-read and remove. The page is sent as `page`, never pasted into the message. | The spec's per-message toggle and chip. |
| E28 | Learning actions (feature 4): "Summarize this page" and "Quiz me on it" in an empty chat; right-click "Summarize page", "Quiz me on this page" and (on a selection) "Discuss in chat". Summaries and quizzes start a new chat in chat mode with the page attached and a fixed prompt (`shared/learning.ts`); "Discuss" opens a new chat with the page attached and the selection quoted in the box, for you to finish. The worker does the right-click versions (it can read the tab: the click grants access) and the panel follows the chat. | Your answers 13 and 14. |
| E29 | Chrome puts an extension's right-click entries under one submenu named after the extension: "Anemo Companion ▸ Summarize page" rather than "Anemo: Summarize page". | Chrome's behaviour; not configurable. |
| E30 | "The active tab" is the active tab of the last focused normal window (the side panel belongs to it). | Also makes the panel testable when opened as a tab. |
| E31 | Capture view (a "Capture" tab): Save page (formatted page or summary; a new document in Web clips or added to one), Save selection (Inbox by default, or a document), Quick task (title from the selection's first line or the page title, the link and quote in the notes, no due date, the last used project remembered). Saving reads up to 600,000 characters (the server formats long pages in pieces), not the 30k-token chat limit. | Your answers 25–27, F1. |
| E32 | Progress: the worker stores `capture.*` events in session storage; the panel shows them, checking `GET /api/capture/{id}` every 4 s in case an event was missed. Done: "Saved to …", View (opens the document in Anemo), Undo. | Your answer F4. |
| E33 | Right-click "Save page to Anemo", "Save selection to Anemo", "Create a task from this", and the shortcuts Alt+Shift+S (save selection) and Alt+Shift+T (quick task) read the tab (the click/shortcut grants access), then open the panel on the Capture view, filled in; one click saves. | The panel shows where it goes before anything is written. |
| E34 | The panel's view (chat/capture/settings) lives in session storage, so the worker can switch it. | Right-click actions open the right view. |

