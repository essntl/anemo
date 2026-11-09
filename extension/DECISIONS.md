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
