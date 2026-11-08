# Anemo backend audit: `app/features/`, `app/api/`, `main_api.py`

Read-only audit for a behaviour-preserving refactor (2026-11-08). Nothing in the repo was changed. Line numbers are against the working tree. The route table was produced by introspecting the real FastAPI app (`create_app()` with a dummy `APP_SECRET_KEY`, `PYTHONDONTWRITEBYTECODE=1`) and walking `_IncludedRouter`s, so it is complete for HTTP routes. There are **no websocket routes** (`grep -rn "websocket\|WebSocket\|add_api_websocket" app` → nothing).

---

## 0. Top findings, serious items first

| Sev | Finding | Where |
|---|---|---|
| **MED (security)** | **Path traversal / directory creation outside the workspace.** `POST /api/documents` hands `body.folder` (any string up to 500 chars, e.g. `../../tmp/x` or `/abs/path`) to `unique_path()`, which runs `(files.root()/"documents"/folder).mkdir(parents=True)` **before** any validation. After that `files.rel()` raises a plain `ValueError`, so the request returns 500 but the directory already exists. An absolute `folder` replaces the base path completely (`Path / "/x"`). | `features/documents/router.py:150-155`, `features/documents/service.py:396-401` |
| **MED (security)** | **Re-auth bypass on agent profiles.** Changing a profile's `plan_review` (e.g. `"off"` when the global setting is `"always"`) needs no recent password. `_security_fields` only compares `permission_levels` and `limits`. `with_profile()` lets the profile's `plan_review` override the global value, and the ceiling does not apply to it. Changing the global `plan_review` does need re-auth, because the `permissions` section is sensitive. | `features/profiles/router.py:85-89,121,153-156`; `features/profiles/service.py:45-55`; `policy/presets.py:103-118` |
| MED (bug) | **An invalid time zone in Settings > General stops all reminders.** `GeneralSettings.timezone` is a free `str` with no validator. `reminders.fire_due` passes it straight to `recurrence.zone()`, which raises `ValueError`, every 30 s; the scheduler logs it and moves on, so no task reminders and no further event reminders are sent. `settings.user_timezone()` exists with a UTC fallback but isn't used here. The same raw read happens in `tools/builtin/events.py:28` and the runtime turn context. | `features/settings/sections.py:23`, `features/calendar/reminders.py:63,73,78,88,96` |
| MED (bug) | **Concurrent `reconcile()` calls race and return 500.** Every documents GET (`/documents`, `/documents/recent`, `/documents/by-path`, daily notes `find`, shares, automations) runs `documents.reconcile()`, which inserts a `Document` for each new `.md` file it finds. Two requests at the same time (Home loads several in parallel) both insert the same `path`, which has a unique constraint, and one fails with an unhandled `IntegrityError` → 500. | `features/documents/service.py:165-213` |
| LOW-MED (security) | **Login lock-out DoS.** A global counter `login:fail:all` (30 per minute) blocks login and re-auth for everyone. An unauthenticated attacker can keep the owner locked out by sending 30 wrong logins a minute. The per-IP check-then-increment is also racy: parallel attempts all read the counter before any increment. | `features/auth/service.py:77-97`, `features/auth/router.py:56-60,93-95` |
| LOW-MED (security) | **Open SSE streams outlive logout or session revocation.** `require_session` runs only once, when the stream opens. `/api/events` (notification titles and bodies, run status) and `/api/runs/{id}/events` keep streaming after `POST /auth/logout` or `DELETE /auth/sessions/{id}`. | `api/sse.py:34-40`, `features/runs/router.py:351-441` |
| LOW-MED (security) | **SSRF without re-auth through "test search".** Saving `searxng_url` is sensitive (re-auth), but `POST /api/web/test-search {searxng_url}` lets the server GET any URL, internal ones included, with plain `httpx` and `follow_redirects=True`. Status codes and JSON shape come back in the error message, which works as an oracle. | `web/router.py:45-74`, `web/search.py:77-91` |
| LOW (security) | Discord webhook delivery uses plain `httpx` with no `safe_http` guard, so any http/https host is accepted, private ones included. Contrast `webpush._client()`, which is guarded. The validator's error message says "must start with https://" but it accepts `http`. Changing destinations does require re-auth. | `features/notifications/service.py:300-323`, `features/notifications/schemas.py:37-42` |
| LOW (security) | `/api/openapi.json` is served without authentication in production too: `openapi_url` is set regardless of `env`; only `docs_url` is gated. | `main_api.py:43-45` |
| LOW (security) | Audit `details` can hold credentials: `provider.create` logs `base_url` (could be `user:pass@host`), and `mcp.server_create` logs `url` and `args` (CLI args often carry tokens). `GET /api/audit` returns them. | `features/providers/router.py:72`, `features/mcp/router.py:43-49` |
| LOW (security) | Share tokens are stored in plaintext (`share_links.token`) and returned by `GET /api/shares`. Session tokens and push tokens, by contrast, are stored as SHA-256 hashes. A DB leak exposes every live share link. | `features/shares/service.py:278`, `features/shares/models.py` |
| LOW (security) | `secrets.last4 = plaintext[-4:]`: for secrets of 4 characters or fewer the whole value is stored in clear and shown masked. | `features/secrets/service.py:22,33` |

No SQL injection was found. Every `text()` or `sql()` call is static or uses bound parameters (`conversations/service.py:310`, `notifications/webpush.py:216`, `system_router.py:84`, `api/health.py:25`). The `OriginCheckMiddleware` is sound for its purpose: it blocks a foreign Origin, or a foreign Referer when Origin is missing, on every non-GET/HEAD/OPTIONS request under `/api/`. Requests with neither header are allowed, and SameSite=Lax covers those. Websockets don't exist, so the websocket scope isn't a gap.

---

## 1. Endpoint inventory

**Totals: 212 `/api` method-routes + 1 SPA catch-all = 213 method routes** (84 GET, 71 POST, 23 PUT, 11 PATCH, 24 DELETE). There are also these non-handler routes:
- `GET /api/openapi.json`: always on, no auth.
- `GET /api/docs` and `/api/docs/oauth2-redirect`: only when `ENV != production`.
- The `/assets` StaticFiles mount (`_ImmutableFiles`, cache-control immutable). Only mounted if `static_dir/assets` exists.
- `GET /{path:path}`: the SPA fallback. Serves a real file if it exists inside `static_dir`; `sw.js` and `manifest.webmanifest` get `no-cache` and the right media type; `s/*` (share pages) get `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`; `api/*` returns 404. Bare `/api` (no slash) falls through and serves `index.html` with 200. The whole SPA mount is skipped if `index.html` is missing (`main_api.py:74-103`).

**Mounting** (`api/router.py`): `api_router = APIRouter(prefix="/api")`. Mounted directly (each route declares its own auth): `health`, `auth`, `shares_public_router` (`/public/shares`), `push_public_router` (`/public/push`). Everything else goes into `protected = APIRouter(dependencies=[Depends(require_session)])`, in this order: settings, audit, providers, conversations, runs, attachments, agent, permissions, links, files, shell, profiles, skills, web (`app/web/router.py`), memory, documents, daily_notes, tasks, projects, shares, calendar, focus, music, notifications, push, automations, mcp, browser, search, usage, stats, system, updates. Middleware: `OriginCheckMiddleware`, then `GZipMiddleware(minimum_size=1024)`. GZip is outermost; it skips `text/event-stream`. `install_error_handlers` maps `AppError` / `HTTPException` / validation errors / unhandled exceptions to `{"error":{code,message,details}}`.

**Re-auth**: 11 routes depend on `RecentAuth` directly. Five more check it inside the handler ("cond."): `PUT /settings/{permissions,workspace,web}`, plus `POST /profiles` and `PUT /profiles/{id}` only when permission levels or limits change.

**Unauthenticated (6 handlers)**: `/api/health`, `/api/ready`, `/api/auth/login`, `/api/public/shares/{token}`, `/api/public/push/actions`, and the SPA catch-all. Plus openapi.json. The auth routes `logout`, `me`, `reauth` and `sessions` take `CurrentSession` as a parameter, so they do require a session.

**Routes defined outside their path's "owner" router** (this matters when splitting routers):
- `links/router.py` defines `/tasks/{id}/files*`, `/tasks/{id}/backlinks`, `/documents/{id}/backlinks`, `/files/links`, `/files/upload-folder`.
- `browser_router.py` defines `/conversations/{id}/browser*`.
- `runs/agent_router.py` defines `/runs/{id}/timeline`, `/runs/{id}/files/{cid}/revert`, `/approvals*`.
- `runs/router.py` defines `/events`, `/presence`, `/runs-summary`.
- `providers/router.py` defines `/models*`, `/provider-types`, `/setup/status`.
- `permissions_router.py` defines `/tools`.
- `notifications/router.py` defines `/notification-destinations*`.

Router include order matters for `/files/links` and `/files/upload-folder`: the links router comes before the files router. There is no path-param clash today.


### 1.1 Route table

Auth: Y = requires a session (the `protected` router or a `CurrentSession` parameter). Reauth: Y = `RecentAuth` dependency; cond. = checked inside the handler. Handler line = the decorator line.

| # | Method | Path | Handler | Auth | Reauth | Response model | Notes |
|---|---|---|---|---|---|---|---|
| 1 | GET | `/api/health` | `app/api/health.py:13` health | N |  | dict |  |
| 2 | GET | `/api/ready` | `app/api/health.py:19` ready | N |  |  | JSONResponse 200/503 |
| 3 | POST | `/api/auth/login` | `app/features/auth/router.py:53` login | N |  | MeOut |  |
| 4 | POST | `/api/auth/logout` | `app/features/auth/router.py:74` logout | Y |  |  (204) |  |
| 5 | GET | `/api/auth/me` | `app/features/auth/router.py:81` me | Y |  | MeOut |  |
| 6 | POST | `/api/auth/reauth` | `app/features/auth/router.py:90` reauth | Y |  | MeOut |  |
| 7 | GET | `/api/auth/sessions` | `app/features/auth/router.py:102` sessions | Y |  | list |  |
| 8 | DELETE | `/api/auth/sessions/{session_id}` | `app/features/auth/router.py:118` revoke | Y |  |  (204) |  |
| 9 | GET | `/api/public/shares/{token}` | `app/features/shares/public_router.py:23` view_share | N |  | SharedOut | public, rate-limited misses |
| 10 | POST | `/api/public/push/actions` | `app/features/notifications/push_router.py:72` use_action | N |  | PushActionOut | public, token-gated, rate-limited misses |
| 11 | GET | `/api/settings` | `app/features/settings/router.py:25` get_settings_all | Y |  | AllSettings |  |
| 12 | PUT | `/api/settings/general` | `app/features/settings/router.py:33` put_general_settings | Y |  | GeneralSettings |  |
| 13 | PUT | `/api/settings/appearance` | `app/features/settings/router.py:33` put_appearance_settings | Y |  | AppearanceSettings |  |
| 14 | PUT | `/api/settings/models` | `app/features/settings/router.py:33` put_models_settings | Y |  | ModelDefaults |  |
| 15 | PUT | `/api/settings/permissions` | `app/features/settings/router.py:33` put_permissions_settings | Y | cond. | PermissionSettings | reauth inside handler (sensitive) |
| 16 | PUT | `/api/settings/workspace` | `app/features/settings/router.py:33` put_workspace_settings | Y | cond. | WorkspaceSettings | reauth inside handler (sensitive) |
| 17 | PUT | `/api/settings/web` | `app/features/settings/router.py:33` put_web_settings | Y | cond. | WebSettings | reauth inside handler (sensitive) |
| 18 | PUT | `/api/settings/memory` | `app/features/settings/router.py:33` put_memory_settings | Y |  | MemorySettings |  |
| 19 | PUT | `/api/settings/focus` | `app/features/settings/router.py:33` put_focus_settings | Y |  | FocusSettings |  |
| 20 | PUT | `/api/settings/music` | `app/features/settings/router.py:33` put_music_settings | Y |  | MusicSettings |  |
| 21 | PUT | `/api/settings/home` | `app/features/settings/router.py:33` put_home_settings | Y |  | HomeSettings |  |
| 22 | PUT | `/api/settings/files` | `app/features/settings/router.py:33` put_files_settings | Y |  | FilesSettings |  |
| 23 | PUT | `/api/settings/setup` | `app/features/settings/router.py:33` put_setup_settings | Y |  | SetupSettings |  |
| 24 | PUT | `/api/settings/updates` | `app/features/settings/router.py:33` put_updates_settings | Y |  | UpdateSettings |  |
| 25 | GET | `/api/audit` | `app/features/audit/router.py:25` list_audit | Y |  | list |  |
| 26 | GET | `/api/provider-types` | `app/features/providers/router.py:37` provider_types | Y |  | list |  |
| 27 | GET | `/api/providers/claude-code/status` | `app/features/providers/router.py:50` claude_code_status | Y |  | ClaudeRunnerStatus |  |
| 28 | GET | `/api/providers` | `app/features/providers/router.py:58` list_providers | Y |  | list |  |
| 29 | POST | `/api/providers` | `app/features/providers/router.py:63` create_provider | Y | Y | ProviderOut (201) |  |
| 30 | PATCH | `/api/providers/{provider_id}` | `app/features/providers/router.py:78` update_provider | Y | Y | ProviderOut |  |
| 31 | DELETE | `/api/providers/{provider_id}` | `app/features/providers/router.py:97` delete_provider | Y | Y |  (204) |  |
| 32 | POST | `/api/providers/{provider_id}/test` | `app/features/providers/router.py:112` test_provider | Y |  | TestResult |  |
| 33 | GET | `/api/providers/{provider_id}/discover` | `app/features/providers/router.py:117` discover | Y |  | list |  |
| 34 | POST | `/api/providers/{provider_id}/models/import` | `app/features/providers/router.py:133` import_models | Y |  | list |  |
| 35 | GET | `/api/models` | `app/features/providers/router.py:141` list_models | Y |  | list |  |
| 36 | POST | `/api/models` | `app/features/providers/router.py:146` create_model | Y |  | ModelOut (201) |  |
| 37 | PATCH | `/api/models/{model_id}` | `app/features/providers/router.py:153` update_model | Y |  | ModelOut |  |
| 38 | DELETE | `/api/models/{model_id}` | `app/features/providers/router.py:161` delete_model | Y |  |  (204) |  |
| 39 | POST | `/api/models/{model_id}/test` | `app/features/providers/router.py:167` test_model | Y |  | TestResult |  |
| 40 | GET | `/api/setup/status` | `app/features/providers/router.py:186` setup_status | Y |  | SetupStatus |  |
| 41 | GET | `/api/conversations` | `app/features/conversations/router.py:32` list_conversations | Y |  | list |  |
| 42 | POST | `/api/conversations` | `app/features/conversations/router.py:63` create_conversation | Y |  | ConversationOut (201) |  |
| 43 | GET | `/api/conversations/tags` | `app/features/conversations/router.py:74` list_tags | Y |  | list |  |
| 44 | POST | `/api/conversations/bulk` | `app/features/conversations/router.py:79` bulk | Y |  | ChatBulkOut |  |
| 45 | GET | `/api/conversations/{conversation_id}` | `app/features/conversations/router.py:87` get_conversation | Y |  | ConversationOut |  |
| 46 | PATCH | `/api/conversations/{conversation_id}` | `app/features/conversations/router.py:93` update_conversation | Y |  | ConversationOut |  |
| 47 | DELETE | `/api/conversations/{conversation_id}` | `app/features/conversations/router.py:124` delete_conversation | Y |  |  (204) |  |
| 48 | GET | `/api/conversations/{conversation_id}/messages` | `app/features/conversations/router.py:131` list_messages | Y |  | list |  |
| 49 | POST | `/api/conversations/{conversation_id}/turns` | `app/features/conversations/router.py:137` send_turn | Y |  | TurnOut (202) |  |
| 50 | POST | `/api/conversations/{conversation_id}/regenerate` | `app/features/conversations/router.py:158` regenerate | Y |  | TurnOut (202) |  |
| 51 | POST | `/api/conversations/{conversation_id}/messages/{message_id}/version` | `app/features/conversations/router.py:170` select_version | Y |  | MessageOut |  |
| 52 | POST | `/api/conversations/{conversation_id}/edit-last` | `app/features/conversations/router.py:178` edit_last | Y |  | TurnOut (202) |  |
| 53 | POST | `/api/conversations/{conversation_id}/branch` | `app/features/conversations/router.py:191` branch | Y |  | ConversationOut (201) |  |
| 54 | GET | `/api/conversations/{conversation_id}/export` | `app/features/conversations/router.py:197` export | Y |  |  | PlainText markdown download |
| 55 | POST | `/api/conversations/{conversation_id}/save-document` | `app/features/conversations/router.py:209` save_document | Y |  | SavedDocument (201) |  |
| 56 | GET | `/api/runs` | `app/features/runs/router.py:134` list_runs | Y |  | list |  |
| 57 | GET | `/api/runs-summary` | `app/features/runs/router.py:186` runs_summary | Y |  | RunCounts |  |
| 58 | GET | `/api/runs/{run_id}` | `app/features/runs/router.py:205` get_run | Y |  | RunDetail |  |
| 59 | POST | `/api/runs/{run_id}/pause` | `app/features/runs/router.py:229` pause_run | Y |  | RunOut |  |
| 60 | POST | `/api/runs/{run_id}/resume` | `app/features/runs/router.py:253` resume_run | Y |  | RunOut |  |
| 61 | PUT | `/api/runs/{run_id}/plan` | `app/features/runs/router.py:284` edit_plan | Y |  | RunOut |  |
| 62 | GET | `/api/runs/{run_id}/outputs/{tool_call_id}` | `app/features/runs/router.py:307` tool_output | Y |  |  | FileResponse text/plain |
| 63 | POST | `/api/runs/{run_id}/cancel` | `app/features/runs/router.py:319` cancel_run | Y |  | RunOut |  |
| 64 | GET | `/api/runs/{run_id}/events` | `app/features/runs/router.py:387` run_events | Y |  |  | **SSE** (Last-Event-ID resume) |
| 65 | GET | `/api/events` | `app/features/runs/router.py:432` global_events | Y |  |  | **SSE** global stream; ?tab presence |
| 66 | POST | `/api/presence` | `app/features/runs/router.py:448` tab_in_use | Y |  |  (204) |  |
| 67 | POST | `/api/attachments` | `app/features/attachments/router.py:35` upload | Y |  | AttachmentOut (201) |  |
| 68 | GET | `/api/attachments/{attachment_id}/content` | `app/features/attachments/router.py:45` content | Y |  |  | FileResponse (inline only for images) |
| 69 | GET | `/api/runs/{run_id}/timeline` | `app/features/runs/agent_router.py:86` timeline | Y |  | TimelineOut |  |
| 70 | GET | `/api/approvals` | `app/features/runs/agent_router.py:125` list_approvals | Y |  | list |  |
| 71 | POST | `/api/approvals/{approval_id}` | `app/features/runs/agent_router.py:169` decide | Y |  | ApprovalOut |  |
| 72 | POST | `/api/runs/{run_id}/files/{change_id}/revert` | `app/features/runs/agent_router.py:236` revert_change | Y |  | RevertOut |  |
| 73 | GET | `/api/permissions/catalog` | `app/features/permissions_router.py:44` catalog | Y |  | CatalogOut |  |
| 74 | GET | `/api/permissions/summary` | `app/features/permissions_router.py:72` summary | Y |  | PermissionSummary |  |
| 75 | POST | `/api/permissions/preview` | `app/features/permissions_router.py:79` preview | Y |  | PermissionSummary |  |
| 76 | GET | `/api/tools` | `app/features/permissions_router.py:85` tools | Y |  | list | unused (no FE/test/e2e ref) |
| 77 | GET | `/api/tasks/{task_id}/files` | `app/features/links/router.py:24` list_task_files | Y |  | list |  |
| 78 | POST | `/api/tasks/{task_id}/files` | `app/features/links/router.py:30` attach_file | Y |  | list |  |
| 79 | POST | `/api/tasks/{task_id}/files/upload` | `app/features/links/router.py:38` upload_task_files | Y |  | list (201) |  |
| 80 | DELETE | `/api/tasks/{task_id}/files` | `app/features/links/router.py:60` detach_file | Y |  |  (204) |  |
| 81 | GET | `/api/tasks/{task_id}/backlinks` | `app/features/links/router.py:66` task_backlinks | Y |  | Backlinks |  |
| 82 | GET | `/api/documents/{document_id}/backlinks` | `app/features/links/router.py:72` document_backlinks | Y |  | Backlinks |  |
| 83 | GET | `/api/files/links` | `app/features/links/router.py:78` file_backlinks | Y |  | Backlinks |  |
| 84 | GET | `/api/files/upload-folder` | `app/features/links/router.py:85` upload_folder | Y |  | str | GET with side effect (mkdir) |
| 85 | GET | `/api/files` | `app/features/files/router.py:101` list_folder | Y |  | ListingOut |  |
| 86 | GET | `/api/files/search` | `app/features/files/router.py:109` search | Y |  | list |  |
| 87 | GET | `/api/files/content` | `app/features/files/router.py:117` read_content | Y |  | ContentOut |  |
| 88 | PUT | `/api/files/content` | `app/features/files/router.py:123` save_content | Y |  | SaveOut |  |
| 89 | GET | `/api/files/download` | `app/features/files/router.py:135` download | Y |  |  | FileResponse (inline only png/jpeg/gif/webp) |
| 90 | POST | `/api/files/upload` | `app/features/files/router.py:156` upload | Y |  | list (201) |  |
| 91 | POST | `/api/files/folder` | `app/features/files/router.py:178` make_folder | Y |  | EntryOut (201) |  |
| 92 | POST | `/api/files/move` | `app/features/files/router.py:183` move | Y |  | EntryOut |  |
| 93 | POST | `/api/files/copy` | `app/features/files/router.py:195` copy | Y |  | EntryOut (201) |  |
| 94 | POST | `/api/files/trash` | `app/features/files/router.py:202` delete | Y |  | TrashItemOut |  |
| 95 | GET | `/api/files/trash` | `app/features/files/router.py:213` list_trash | Y |  | list |  |
| 96 | POST | `/api/files/trash/{item_id}/restore` | `app/features/files/router.py:218` restore | Y |  | EntryOut |  |
| 97 | DELETE | `/api/files/trash/{item_id}` | `app/features/files/router.py:224` purge | Y |  |  (204) |  |
| 98 | GET | `/api/shell/ssh-key` | `app/features/shell/router.py:35` ssh_key | Y |  | SshKeyOut |  |
| 99 | GET | `/api/profiles` | `app/features/profiles/router.py:111` list_profiles | Y |  | list |  |
| 100 | POST | `/api/profiles` | `app/features/profiles/router.py:117` create_profile | Y | cond. | ProfileOut (201) | POST: reauth only if permission_levels/limits set |
| 101 | GET | `/api/profiles/{profile_id}` | `app/features/profiles/router.py:143` get_profile | Y |  | ProfileOut |  |
| 102 | PUT | `/api/profiles/{profile_id}` | `app/features/profiles/router.py:148` update_profile | Y | cond. | ProfileOut | PUT: reauth only if permission_levels/limits changed |
| 103 | DELETE | `/api/profiles/{profile_id}` | `app/features/profiles/router.py:175` delete_profile | Y |  |  (204) |  |
| 104 | GET | `/api/skills` | `app/features/skills/router.py:96` list_skills | Y |  | list | GET runs ensure_builtins (writes) |
| 105 | POST | `/api/skills` | `app/features/skills/router.py:103` create_skill | Y |  | SkillOut (201) |  |
| 106 | POST | `/api/skills/import` | `app/features/skills/router.py:114` import_skill | Y |  | SkillOut (201) |  |
| 107 | GET | `/api/skills/{skill_id}` | `app/features/skills/router.py:134` get_skill | Y |  | SkillOut |  |
| 108 | PUT | `/api/skills/{skill_id}` | `app/features/skills/router.py:139` update_skill | Y |  | SkillOut |  |
| 109 | DELETE | `/api/skills/{skill_id}` | `app/features/skills/router.py:161` delete_skill | Y |  |  (204) |  |
| 110 | POST | `/api/skills/{skill_id}/reset` | `app/features/skills/router.py:169` reset_skill | Y |  | SkillOut |  |
| 111 | GET | `/api/skills/{skill_id}/export` | `app/features/skills/router.py:180` export_skill | Y |  |  | Response markdown download |
| 112 | GET | `/api/web/status` | `app/web/router.py:21` status | Y |  | WebStatus |  |
| 113 | POST | `/api/web/test-search` | `app/web/router.py:45` test_search | Y |  | SearchTestOut |  |
| 114 | GET | `/api/memories` | `app/features/memory/router.py:39` list_memories | Y |  | list |  |
| 115 | GET | `/api/memories/summary` | `app/features/memory/router.py:65` summary | Y |  | MemorySummary |  |
| 116 | GET | `/api/memories/export` | `app/features/memory/router.py:80` export_memories | Y |  |  | JSONResponse download (no response_model) |
| 117 | POST | `/api/memories/reindex` | `app/features/memory/router.py:107` reindex | Y |  | ReindexOut (202) |  |
| 118 | POST | `/api/memories` | `app/features/memory/router.py:115` create_memory | Y |  | MemoryOut (201) |  |
| 119 | PATCH | `/api/memories/{memory_id}` | `app/features/memory/router.py:121` update_memory | Y |  | MemoryOut |  |
| 120 | POST | `/api/memories/{memory_id}/approve` | `app/features/memory/router.py:134` approve_memory | Y |  | MemoryOut |  |
| 121 | POST | `/api/memories/suggestions` | `app/features/memory/router.py:153` handle_suggestions | Y |  | BulkOut |  |
| 122 | DELETE | `/api/memories/{memory_id}` | `app/features/memory/router.py:165` delete_memory | Y |  |  (204) |  |
| 123 | GET | `/api/documents/recent` | `app/features/documents/router.py:80` recent_documents | Y |  | list | GET runs reconcile (writes) |
| 124 | GET | `/api/documents/by-path` | `app/features/documents/router.py:101` document_by_path | Y |  | DocumentOut | GET runs reconcile (writes) |
| 125 | GET | `/api/documents` | `app/features/documents/router.py:112` list_documents | Y |  | DocumentList | GET runs reconcile (writes) |
| 126 | POST | `/api/documents/assets` | `app/features/documents/router.py:127` upload_asset | Y |  | AssetOut (201) |  |
| 127 | POST | `/api/documents` | `app/features/documents/router.py:149` create_document | Y |  | DocumentContent (201) |  |
| 128 | GET | `/api/documents/{document_id}` | `app/features/documents/router.py:158` get_document | Y |  | DocumentContent |  |
| 129 | PUT | `/api/documents/{document_id}` | `app/features/documents/router.py:169` save_document | Y |  | DocumentContent |  |
| 130 | POST | `/api/documents/{document_id}/move` | `app/features/documents/router.py:181` move_document | Y |  | DocumentOut |  |
| 131 | DELETE | `/api/documents/{document_id}` | `app/features/documents/router.py:194` delete_document | Y |  |  (204) |  |
| 132 | GET | `/api/documents/{document_id}/revisions` | `app/features/documents/router.py:224` list_revisions | Y |  | list |  |
| 133 | GET | `/api/documents/{document_id}/revisions/{revision_id}` | `app/features/documents/router.py:242` get_revision | Y |  | RevisionContent |  |
| 134 | POST | `/api/documents/{document_id}/revisions/{revision_id}/restore` | `app/features/documents/router.py:249` restore_revision | Y |  | DocumentContent |  |
| 135 | GET | `/api/daily-notes/{day}` | `app/features/daily_notes/router.py:50` get_daily_note | Y |  | DailyNoteOut | GET may create today's note (carry-over) |
| 136 | PUT | `/api/daily-notes/{day}` | `app/features/daily_notes/router.py:71` save_daily_note | Y |  | DailyNoteOut | GET may create today's note (carry-over) |
| 137 | GET | `/api/tasks` | `app/features/tasks/router.py:35` list_tasks | Y |  | list |  |
| 138 | GET | `/api/tasks/tags` | `app/features/tasks/router.py:59` list_tags | Y |  | list | FE-unused (tests only) |
| 139 | POST | `/api/tasks` | `app/features/tasks/router.py:64` create_task | Y |  | TaskOut (201) |  |
| 140 | POST | `/api/tasks/reorder` | `app/features/tasks/router.py:69` reorder_tasks | Y |  |  (204) |  |
| 141 | PATCH | `/api/tasks/{task_id}` | `app/features/tasks/router.py:74` update_task | Y |  | TaskOut |  |
| 142 | DELETE | `/api/tasks/{task_id}` | `app/features/tasks/router.py:81` delete_task | Y |  |  (204) |  |
| 143 | GET | `/api/projects` | `app/features/projects/router.py:22` list_projects | Y |  | list | GET mkdirs project folders |
| 144 | POST | `/api/projects` | `app/features/projects/router.py:27` create_project | Y |  | ProjectOut (201) |  |
| 145 | PUT | `/api/projects/{project_id}` | `app/features/projects/router.py:36` update_project | Y |  | ProjectOut |  |
| 146 | DELETE | `/api/projects/{project_id}` | `app/features/projects/router.py:45` delete_project | Y |  |  (204) |  |
| 147 | GET | `/api/shares` | `app/features/shares/router.py:15` list_shares | Y |  | list |  |
| 148 | POST | `/api/shares` | `app/features/shares/router.py:28` create_share | Y |  | ShareOut (201) |  |
| 149 | POST | `/api/shares/{share_id}/refresh` | `app/features/shares/router.py:42` refresh_share | Y |  | ShareOut |  |
| 150 | DELETE | `/api/shares/{share_id}` | `app/features/shares/router.py:50` revoke_share | Y |  |  (204) |  |
| 151 | DELETE | `/api/shares` | `app/features/shares/router.py:64` revoke_all_shares | Y |  | RevokedOut |  |
| 152 | GET | `/api/calendar/events` | `app/features/calendar/router.py:25` list_occurrences | Y |  | list |  |
| 153 | POST | `/api/calendar/events` | `app/features/calendar/router.py:36` create_event | Y |  | EventOut (201) |  |
| 154 | GET | `/api/calendar/events/{event_id}` | `app/features/calendar/router.py:41` get_event | Y |  | EventOut |  |
| 155 | PUT | `/api/calendar/events/{event_id}` | `app/features/calendar/router.py:46` update_event | Y |  | EventOut |  |
| 156 | DELETE | `/api/calendar/events/{event_id}` | `app/features/calendar/router.py:53` delete_event | Y |  |  (204) |  |
| 157 | PUT | `/api/calendar/events/{event_id}/occurrences/{original_start}` | `app/features/calendar/router.py:58` change_occurrence | Y |  |  (204) |  |
| 158 | POST | `/api/focus/sessions` | `app/features/focus/router.py:21` record_session | Y |  | FocusSessionOut (201) |  |
| 159 | GET | `/api/focus/sessions` | `app/features/focus/router.py:28` list_sessions | Y |  | list |  |
| 160 | DELETE | `/api/focus/sessions/{session_id}` | `app/features/focus/router.py:50` delete_session | Y |  |  (204) | FE-unused (tests/e2e only) |
| 161 | POST | `/api/focus/phase-ended` | `app/features/focus/router.py:55` phase_ended | Y |  |  (204) |  |
| 162 | GET | `/api/music/tracks` | `app/features/music/router.py:21` list_tracks | Y |  | list |  |
| 163 | POST | `/api/music/tracks` | `app/features/music/router.py:26` add_tracks | Y |  | list |  |
| 164 | PATCH | `/api/music/tracks/{track_id}` | `app/features/music/router.py:32` update_track | Y |  | TrackOut | FE-unused (tests/e2e only) |
| 165 | DELETE | `/api/music/tracks/{track_id}` | `app/features/music/router.py:39` delete_track | Y |  |  (204) | FE-unused (tests/e2e only) |
| 166 | GET | `/api/music/playlists` | `app/features/music/router.py:45` list_playlists | Y |  | list |  |
| 167 | POST | `/api/music/playlists` | `app/features/music/router.py:50` create_playlist | Y |  | PlaylistOut (201) |  |
| 168 | POST | `/api/music/playlists/reorder` | `app/features/music/router.py:56` reorder_playlists | Y |  |  (204) | FE-unused (tests only) |
| 169 | PATCH | `/api/music/playlists/{playlist_id}` | `app/features/music/router.py:61` rename_playlist | Y |  | PlaylistOut |  |
| 170 | DELETE | `/api/music/playlists/{playlist_id}` | `app/features/music/router.py:68` delete_playlist | Y |  |  (204) |  |
| 171 | PUT | `/api/music/playlists/{playlist_id}/tracks` | `app/features/music/router.py:74` set_playlist_tracks | Y |  | PlaylistOut |  |
| 172 | POST | `/api/music/playlists/{playlist_id}/tracks` | `app/features/music/router.py:84` append_playlist_tracks | Y |  | PlaylistOut |  |
| 173 | GET | `/api/notifications` | `app/features/notifications/router.py:32` list_notifications | Y |  | list |  |
| 174 | GET | `/api/notifications/summary` | `app/features/notifications/router.py:49` summary | Y |  | NotificationSummary |  |
| 175 | POST | `/api/notifications/read` | `app/features/notifications/router.py:54` mark_read | Y |  | NotificationSummary |  |
| 176 | DELETE | `/api/notifications` | `app/features/notifications/router.py:60` clear_notifications | Y |  |  (204) |  |
| 177 | DELETE | `/api/notifications/{notification_id}` | `app/features/notifications/router.py:67` delete_notification | Y |  |  (204) |  |
| 178 | GET | `/api/notification-destinations` | `app/features/notifications/router.py:80` list_destinations | Y |  | list |  |
| 179 | POST | `/api/notification-destinations` | `app/features/notifications/router.py:86` create_destination | Y | Y | DestinationOut (201) |  |
| 180 | PATCH | `/api/notification-destinations/{destination_id}` | `app/features/notifications/router.py:103` update_destination | Y | Y | DestinationOut |  |
| 181 | DELETE | `/api/notification-destinations/{destination_id}` | `app/features/notifications/router.py:121` delete_destination | Y | Y |  (204) |  |
| 182 | POST | `/api/notification-destinations/{destination_id}/test` | `app/features/notifications/router.py:138` test_destination | Y |  | TestOut |  |
| 183 | GET | `/api/push/key` | `app/features/notifications/push_router.py:40` public_key | Y |  | PushKeyOut | GET may create+commit VAPID key |
| 184 | POST | `/api/push/subscriptions` | `app/features/notifications/push_router.py:46` subscribe | Y | Y | DestinationOut |  |
| 185 | GET | `/api/automations` | `app/features/automations/router.py:29` list_automations | Y |  | list |  |
| 186 | POST | `/api/automations/schedule-preview` | `app/features/automations/router.py:35` schedule_preview | Y |  | SchedulePreviewOut |  |
| 187 | POST | `/api/automations` | `app/features/automations/router.py:43` create_automation | Y |  | AutomationOut (201) |  |
| 188 | GET | `/api/automations/{automation_id}` | `app/features/automations/router.py:59` get_automation | Y |  | AutomationOut |  |
| 189 | PATCH | `/api/automations/{automation_id}` | `app/features/automations/router.py:64` update_automation | Y |  | AutomationOut |  |
| 190 | DELETE | `/api/automations/{automation_id}` | `app/features/automations/router.py:83` delete_automation | Y |  |  (204) |  |
| 191 | POST | `/api/automations/{automation_id}/run` | `app/features/automations/router.py:106` run_automation_now | Y |  | RunStarted (202) |  |
| 192 | GET | `/api/mcp/servers` | `app/features/mcp/router.py:27` list_servers | Y |  | list |  |
| 193 | POST | `/api/mcp/servers` | `app/features/mcp/router.py:33` create_server | Y | Y | McpServerOut (201) |  |
| 194 | PATCH | `/api/mcp/servers/{server_id}` | `app/features/mcp/router.py:57` update_server | Y | Y | McpServerOut |  |
| 195 | DELETE | `/api/mcp/servers/{server_id}` | `app/features/mcp/router.py:81` delete_server | Y | Y |  (204) |  |
| 196 | POST | `/api/mcp/servers/{server_id}/refresh` | `app/features/mcp/router.py:97` refresh_server | Y |  | McpServerOut (202) |  |
| 197 | GET | `/api/mcp/servers/{server_id}/tools` | `app/features/mcp/router.py:107` list_tools | Y |  | list |  |
| 198 | PATCH | `/api/mcp/tools/{tool_id}` | `app/features/mcp/router.py:116` update_tool | Y | Y | McpToolOut |  |
| 199 | GET | `/api/browser/status` | `app/features/browser_router.py:85` status | Y |  | BrowserStatus |  |
| 200 | GET | `/api/conversations/{conversation_id}/browser` | `app/features/browser_router.py:90` view | Y |  | BrowserView |  |
| 201 | GET | `/api/conversations/{conversation_id}/browser/stream` | `app/features/browser_router.py:102` stream | Y |  |  | **SSE** browser frames |
| 202 | POST | `/api/conversations/{conversation_id}/browser/input` | `app/features/browser_router.py:113` user_input | Y |  | BrowserView |  |
| 203 | DELETE | `/api/conversations/{conversation_id}/browser` | `app/features/browser_router.py:132` close | Y |  |  (204) |  |
| 204 | GET | `/api/search` | `app/features/search/router.py:11` search | Y |  | SearchOut |  |
| 205 | GET | `/api/usage/summary` | `app/features/usage/router.py:92` summary | Y |  | UsageSummary |  |
| 206 | GET | `/api/usage/records` | `app/features/usage/router.py:142` records | Y |  | list |  |
| 207 | GET | `/api/stats` | `app/features/stats/router.py:16` get_stats | Y |  | StatsOut |  |
| 208 | GET | `/api/system/status` | `app/features/system_router.py:77` status | Y |  | SystemStatus | writes probe files |
| 209 | GET | `/api/updates` | `app/features/updates/router.py:54` get_updates | Y |  | UpdatesOut |  |
| 210 | POST | `/api/updates/check` | `app/features/updates/router.py:59` check_now | Y |  | UpdatesOut |  |
| 211 | POST | `/api/updates/dismiss` | `app/features/updates/router.py:69` dismiss | Y |  | UpdatesOut |  |
| 212 | POST | `/api/updates/whats-new/dismiss` | `app/features/updates/router.py:75` dismiss_whats_new | Y |  | UpdatesOut |  |
| 213 | GET | `/{path:path}` | `app/main_api.py:84` spa | N |  |  | SPA fallback (sync handler); /assets mount; sw.js+manifest no-cache; s/* share pages get no-referrer/noindex |

---

## 2. Feature inventory per domain

### 2.0 Settings sections (`app_settings`, one JSONB row per section, `features/settings/sections.py:SECTIONS`)

`GET /api/settings` returns every section. `PUT /api/settings/{name}` replaces a whole section. Those PUT routes are generated in a loop (`settings/router.py:54-61`); that loop is dynamic registration, so grep finds no route literals for them. Stored values are merged over the defaults, and unknown keys are dropped. If a stored value fails validation, **the whole section silently falls back to its defaults** (`settings/service.py:11-33`; this merge logic is duplicated between `get_section` and `get_all`). Sensitive sections need re-auth and are audit-logged with the full value.

| Section | Model (file) | Sensitive | Fields → default |
|---|---|---|---|
| `general` | `GeneralSettings` (`settings/sections.py:22`) | no | `timezone="UTC"` (str ≤64, **not validated**), `default_chat_mode="chat"` (chat/agent), `confirm_destructive_actions=True`, `start_page="home"` (home/new_chat), `carry_over_daily_notes=False` |
| `appearance` | `AppearanceSettings` (`:107`) | no | `mode="system"` (light/dark/system), `accent="#3478f6"` (hex regex), `density="comfortable"` (comfortable/compact) |
| `models` | `ModelDefaults` (`:118`) | no | `chat`, `agent`, `summarization`, `memory`, `background`, `automation`, `embeddings`, `title`: all `UUID\|None=None`; `fallbacks: dict[TaskType, list[UUID]]={}` |
| `permissions` | `PermissionSettings` (`policy/presets.py:92`) | **yes** | `levels={}`, `ceiling={}`, `extra_rules=[]` (Rule: cap, decision, scope, unless_risk, else), `limits=Limits()`, `plan_review="off"` (off/always). `Limits` (`policy/models.py:34`): `max_steps=25`, `max_tool_calls=100`, `max_runtime_s=1800`, `max_shell_timeout_s=600`, `max_cost_usd=None`, `max_consecutive_errors=5`, `max_subagent_depth=1` |
| `workspace` | `WorkspaceSettings` (`workspace/access.py:17`) | **yes** | `default_agent_access="read_write"`, `folders={}` |
| `web` | `WebSettings` (`web/settings.py:11`) | **yes** | `searxng_url=""`, `search_results=8`, `safesearch="moderate"`, `language="auto"`, `allowed_private_hosts=[]` |
| `memory` | `MemorySettings` (`memory/schemas.py:14`) | no | `enabled=True`, `extraction="suggest"` (off/suggest/auto), `max_injected=8`, `min_similarity=0.3` |
| `focus` | `FocusSettings` (`sections.py:50`) | no | `focus_minutes=25`, `short_break_minutes=5`, `long_break_minutes=15`, `rounds_before_long_break=4`, `auto_start_breaks=True`, `auto_start_focus=False`, `chime="bell"`, `chime_volume=0.6`, `title_countdown=True`, `save_to_notifications=False`, `daily_goal_minutes=120` |
| `music` | `MusicSettings` (`:69`) | no | `blur_backdrop=True`, `track_alerts=True` |
| `home` | `HomeSettings` (`:91`) | no | `layout=[]`, `mobile_layout=[]` (WidgetLayout: `id`, `w=1`, `h=1`, `hidden=False`, `pinned=False`, `options={}`) |
| `files` | `FilesSettings` (`:100`) | no | `show_documents_folder=False` |
| `setup` | `SetupSettings` (`:35`) | no | `status="new"` (new/later/done), `step=None` |
| `updates` | `UpdateSettings` (`:44`) | no | `check=True` |
| *(hidden)* `update_state` | `updates.service.UpdateState` | n/a | Not in SECTIONS; a state row in the same table, written by `updates/service.py:33,94-122`. `get_all` ignores it and no PUT route exists for it. |

Who reads each field on the backend: most fields are frontend-only. Backend readers are `timezone`, `carry_over_daily_notes`, `save_to_notifications`, `show_documents_folder`, `focus_minutes` (stats/tools), `check`, every `models` / `permissions` / `workspace` / `web` / `memory` field, and `setup.status`. `confirm_destructive_actions` has **no consumer anywhere** except its own toggle (see §7).

### 2.1 Domain by domain

**attachments**: chat files (user uploads, plus files the agent attaches to answers). Files: `models.py` (table `attachments`), `service.py` (classify by magic bytes, then MIME, then extension; text extraction; storage at `DATA_PATH/uploads/YYYY/MM/<uuid4>`; `render_blocks` turns an attachment into model input depending on capabilities; `claim_for_message` (single use); `duplicate`, used by branch; `store_output` / `store_image`, used by agent tools), `extract.py` (pdf / docx / xlsx / pptx / zip / text; lazy imports of `pypdf` and `openpyxl`), `images.py`. Routes: upload (25 MB, images 10 MB) and content (inline only for `kind=="image"`, CSP `default-src 'none'`, nosniff). Hidden behaviour:
- Files are written to disk **before** the commit.
- Unclaimed uploads (`message_id IS NULL`) are never cleaned up.
- `delete_files_for_conversation` and `delete_for_message` unlink files before the caller commits.

**audit**: append-only `audit_log`. `record()` adds a row to the caller's transaction without committing. `GET /audit?limit≤500`. Writers: auth, settings (sensitive sections), providers, notifications destinations and push subscribe, mcp, profiles, automations, files trash/purge/revert, approvals, shares.

**auth**: single user from `.env` (argon2 hash, or plaintext with a warning), table `auth_sessions` (only a SHA-256 of the token is stored). Cookie `aiw_session` (HttpOnly, Secure configurable, SameSite=Lax, `session_days`). Sliding expiry, written at most every 5 min, and **commits inside the dependency** (`service.py:125-139`). Re-auth window is 15 min. Rate limit (Redis): 5 failures per IP per minute, 30 globally; the per-IP counter is cleared on success. Login failures are audited; re-auth failures are not. `purge_expired()` is never called, so expired sessions pile up (they are filtered out when read).

**automations**: scheduled, unattended agent runs. Table `automations`; `schedule.py` (cron / interval / once, plus `describe` and `upcoming`), `schemas.py` (`on_ask` pause/deny/fail, `notify` always/... /never). The worker calls `fire_due()` every 30 s: rows are claimed with `FOR UPDATE SKIP LOCKED`; a run more than `GRACE=1h` late is marked "missed"; one that would overlap an active run is "skipped". `start_run` creates a Conversation with `automation_id` set, the user and assistant messages, a Run with `kind="agent"`, and enqueues `run.execute` on the background lane. `on_run_finished`:
- optionally writes the answer to a document at `document_path`, with `{date}` / `{time}` templates (this **overwrites** an existing document, `base_hash=None`);
- sends a notification of kind `automation`;
- on failure, enqueues `automation.retry` with exponential backoff (2 min × 2^n).

`on_needs_approval` sends a notification of kind `approval` and attaches an `approval_id` so push notifications get buttons. Deleting an automation deletes its conversations together with their files (logic in the router, `automations/router.py:83-103`).

**calendar**: tables `calendar_events`, `event_exceptions`, `reminders`. `recurrence.py` expands RRULEs in the event's time zone (DAILY / WEEKLY / MONTHLY / YEARLY, at most 1000 occurrences). `occurrences()` caps a query at 400 days and applies per-occurrence overrides and cancellations. Changing the start, rule, all-day flag or time zone **deletes all exceptions** (`service.py:79-88`). `reminders.fire_due` runs in the worker every 30 s; each reminder is claimed with a unique-insert, committed, then the notification of kind `reminder` is sent, so delivery is at most once. Reminders cover events and also tasks (a date-only task counts as due at 09:00). The `reminders` table is never pruned. FK fields `task_id` and `project_id` are not validated, so an unknown id gives a 500 IntegrityError.

**conversations**: tables `conversations`, `messages` (a generated `tsv` column with a GIN index). `service.py` (759 lines) covers listing (FTS via `websearch_to_tsquery` plus a title ILIKE), bulk actions, sending a turn (row-locks the conversation, refuses while a run is active, claims attachments, adds reference blocks for other chats and the skill invocation, creates the user and assistant messages and a Run, enqueues `run.execute` on the interactive lane), regenerate (keeps answer versions in `messages.versions`), select_version, edit_last (deletes files the agent attached to the old answer), branch (copies messages and duplicates their attachments), export to Markdown, and save as document. Temporary chats are deleted 5 min after their last message by the periodic `delete_expired_temporary`, which publishes `conversations.changed`. Delete also closes the conversation's browser session (a network call **before commit**) and deletes saved tool outputs.

**daily_notes**: no tables. A day's note is a document at `documents/[<project slug>/]daily/YYYY-MM-DD.md`. "today" is computed in the user's validated time zone. The GET for today may **create** the note by carrying over unticked items (`carry_over_daily_notes`). The router imports the private `_content` from `documents.router`.

**documents**: tables `documents`, `document_revisions`. The files are the source of truth; `reconcile()` scans `documents/` on every list or open (renames are detected by content hash, external edits get an `external` revision). Revisions: saves within 10 min by the same author are merged; at most 50 are kept. Search indexing is debounced 30 s through the `document.index` job (dedupe key includes the content hash); the worker handles it via `index_document`. Publishes `document.changed`. Assets go to `documents/_assets/`, which accepts `.svg` (download-only via `/files/download`). Delete moves the file to the workspace trash.

**files**: no tables. The router wraps `app/workspace/files` (path guard via `fs_guard`): list, search, read and write text (`base_hash` optimistic concurrency), download, upload (200 MB per file, all read into memory), mkdir, move (calls `links.on_moved`), copy, trash, restore, purge (audited). `documents/` is hidden in listing and search unless `files.show_documents_folder` is on; this is cosmetic only, since read and download still work on it. Several handlers make **synchronous FS calls on the event loop**: `files.resolve`, `entry`, `list_trash` at `router.py:137-140,161-174,209`.

**focus**: table `focus_sessions`, idempotent by `client_id` (pg `ON CONFLICT DO NOTHING`, explicit `uuid.uuid4()` id). `POST /focus/phase-ended` creates a notification of kind `focus` only if `focus.save_to_notifications`. Publishes `focus.changed`. API quirk: `phase` defaults to `"focus"` and a query string cannot send None, so the endpoint can never list every phase.

**links**: table `task_files` (task ↔ workspace path). Backlinks are found by **reading every document from disk** on each call (`service.py:88-101`). `on_moved` rewrites task attachments, file links in task notes (commits), then document links one revision at a time (each `documents.save` commits), so a failure halfway leaves a partial update. Callers: the files router move and the agent tool `tools/builtin/workspace.py:442`. **Not** called when a document is moved via `POST /documents/{id}/move` (see Bugs). `GET /files/upload-folder` creates the folder (a GET with a side effect). `parse.file_link` is used only by tests.

**mcp**: tables `mcp_servers`, `mcp_tools`. Headers and env vars are stored as encrypted secrets. Every change needs re-auth and is audited. Discovery runs as the `mcp.refresh` job (interactive lane), handled by `service.refresh`. Tools whose hash changed get `needs_review`, which forces "ask". `policy_rules()` compiles per-tool choices into rules. Publishes `mcp.changed`. `service.py` imports the private `schemas._check`.

**memory**: table `memories`, plus `knowledge_chunks` through `app/knowledge/index`. CRUD and approve go through `service.py`, which commits, embeds via `index.index_source` (a provider call inside the request) and rejects text that looks like a secret (`SecretInMemory`, 422). `extraction.py` schedules `memory.extract` after a run, once the chat has been idle, deduped; it calls the "memory" model and writes active memories or suggestions. `memory.reindex` re-embeds everything. Settings section `memory`. Publishes `memory.changed`. The name `service.get_settings` shadows `core.config.get_settings`.

**music**: tables `music_tracks` (unique `(source, ref)`), `music_playlists`, `music_playlist_items`. `add_tracks` upserts one row at a time and improves placeholder titles. Publishes `music.changed`. The frontend never calls `PATCH/DELETE /music/tracks/{id}` (the e2e tests do) or `POST /music/playlists/reorder` (only the API tests do).

**notifications**: tables `notifications` (pruned after 90 days), `notification_destinations` (Discord webhook or webpush; URL or subscription stored as a secret), `notification_deliveries`, `push_action_tokens`. `create()` is the single entry point: it stores the notification, enqueues one `notify.deliver` per matching destination (max 5 attempts), **commits the caller's transaction**, then publishes `notification`. `deliver()` is the job handler; a subscription that answers 404/410 is deleted. `webpush.py` implements RFC 8291 and 8292 by hand; the VAPID key is created lazily under a pg advisory lock and committed, and `GET /push/key` can be what creates it. Push approval buttons: `_action_tokens` creates single-use "approve" and "deny" tokens (stored as hashes); the public `/public/push/actions` endpoint calls `runs.agent_router.decide_approval` and is miss-rate-limited through `shares.check_misses`. Kinds: reminder, automation, approval, agent, focus.

**profiles**: tables `agent_profiles`, `profile_skills`. Overrides for permission levels, limits and `plan_review`, plus skills mode. `effective_settings` = global permissions with `with_profile` applied. Re-auth gap described in §0. Name uniqueness is **case-sensitive** here, unlike projects, notification destinations and MCP servers, which compare lower-cased names.

**projects**: **no `models.py`**: `Project` lives in `tasks/models.py:24`. Folders are `projects/<slug>/` and `documents/<slug>/`; the slug is fixed at creation. `list_out()` calls `ensure_folders` (mkdir) for **every project on every GET**, and `one_out()` (used by agent tools) recomputes the whole list. Delete happens in the router and only unassigns the project. `prompt_section` feeds the system prompt.

**providers**: tables `providers`, `models`, `claude_code_sessions`. The API key and headers are secrets. Create, update and delete need re-auth and are audited; test and discover make outbound calls (GET `/discover` included). The `claude_code` type takes no credentials. Model test records usage of kind `test`. `/setup/status` drives first-run setup. Deleting a model leaves dangling UUIDs in the `models` settings section.

**runs**: tables `runs`, `run_events` (the durable subset of events), `tool_calls`, `approvals`, `run_file_changes`. `router.py` holds list, detail, pause, resume, plan edit and cancel. That is business logic in a router; cancel calls the private `runtime.agent._finalize` through an import inside the function. It also holds the SSE streams (Redis XREAD with a 15 s block; polls the DB status every 2 s if Redis is down) and presence. `agent_router.py` holds the timeline, approvals (`decide_approval` is the single decision path, also used by push) and revert. `service.py` holds `set_status` (commits, then publishes `run.status` to the run stream and to global), `emit` (computes the next durable seq as max+1), and `expire_stale_approvals` (periodic, 24 h TTL, re-enqueues `run.execute`).

**search**: `service.py` searches chats, documents, memories, tasks, events, files and automations. Hybrid mode embeds the query and **commits usage in a GET**. LIKE patterns are escaped properly here (`service.py:76-85`), unlike the other features. Its Pydantic models live in `service.py`.

**secrets**: table `secrets` (Fernet with an HKDF-derived key). `create`, `replace`, `reveal`, `delete`, `mask`. No router.

**settings**: see §2.0. `user_timezone()` is the validated time-zone accessor.

**shares**: table `share_links`. A frozen snapshot of a chat, a document or a project (tasks, events, documents). `relink()` rewrites internal links in the copy. `view()` is public: it increments `view_count` and commits. Uses a Redis miss counter (30 per IP per minute). `create` and `refresh` read documents through `documents.read`, which can **write a revision** as a side effect. Audit records for shares carry no IP, unlike everything else.

**shell**: router only. `GET /shell/ssh-key` reads the public key from `SANDBOX_SSH_DIR`. It is a sync handler, so it runs in the threadpool.

**skills**: table `skills`. `builtin.py` holds the shipped skills; `ensure_builtins` runs **on every `GET /skills`** and can write. Import and export use SKILL.md format. A `customized` flag stops built-ins from being updated. `prompt_section` and `skills_for_profile` serve the runtime.

**stats**: no tables. `compute()` is 194 lines (§5): focus, task, project and agent activity per local day via `func.timezone(tz, col)`.

**tasks**: tables `projects`, `tasks`, `task_dependencies`. Status machine: blockers move tasks between todo and blocked, finishing a parent can finish its subtasks (`409 open_subtasks` otherwise), and RRULE repeats create the next task. `_tell_ready` sends notifications of kind `reminder`. Every mutation commits in the service and publishes `tasks.changed`. `schemas.clean_tags` is reused by conversations.

**updates**: once a day, compares `APP_COMMIT` with GitHub `main` (`check_if_due` is periodic). State lives in the `app_settings` row `update_state`. Uses httpx with `follow_redirects=True`, `trust_env=True`. Two router endpoints (`dismiss`, `whats-new/dismiss`) mutate state.

**usage**: table `usage_records`. `service.record()` (estimated, provider-reported or unknown cost; Claude subscription cost is always NULL). The **query logic lives in the router** (`usage/router.py:92-155`), not the service.

**Top-level modules in `features/`** (they break the one-folder-per-domain rule): `browser_router.py` (agent browser view, SSE and input; reads `web.allowed_private_hosts`), `permissions_router.py` (catalog, summary, preview, `/tools`), `system_router.py` (health page: DB, Redis, workers, disk write probes, parts), `parts.py` (worker-published container status in Redis).

### 2.2 Background jobs (kind → enqueued by → handler)

| Job kind | Enqueued in | Handler (`jobs/runner.py:73-80`) |
|---|---|---|
| `run.execute` | `conversations/service.py:468`, `automations/service.py:277`, `runs/router.py:266`, `runs/agent_router.py:223`, `runs/service.py:124` | runtime |
| `notify.deliver` | `notifications/service.py:104` | `notifications.service.deliver` |
| `document.index` | `documents/service.py:293` | `documents.service.index_document` |
| `memory.extract` | `memory/extraction.py:77` | `memory.extraction.extract` |
| `memory.reindex` | `memory/router.py:110` | `memory.service.reindex_all` |
| `automation.retry` | `automations/service.py:426` | `automations.service.retry_run` |
| `mcp.refresh` | `mcp/service.py:224` | `mcp.service.refresh` |
| `conversation.title` | runtime (out of scope) | runtime |

Periodic tasks (`jobs/scheduler.py:23-30`, every 30 s): `reminders.fire_due`, `automations.fire_due`, `notifications.prune`, `runs.expire_stale_approvals`, `conversations.delete_expired_temporary`, `updates.check_if_due`.

Global SSE events published from `features/`: `automations.changed`, `calendar.changed`, `conversations.changed`, `document.changed`, `focus.changed`, `mcp.changed`, `memory.changed`, `music.changed`, `notifications.changed`, `notification`, `tasks.changed` (both `tasks.notify` and `projects.notify` emit this), `run.status`. The frontend listens to all of them.

Notification kinds by sender: `reminder` (calendar reminders, task reminders, tasks `_tell_ready`), `automation` and `approval` (automations), `focus` (focus phase-ended), `agent` (send_test, plus tools and runtime).

---

## 3. Patterns and inconsistencies

### 3.1 Getting a DB session

| Variant | Count | Where |
|---|---|---|
| A. Request dependency `Db = Annotated[AsyncSession, Depends(get_db)]` (`api/deps.py:19-29`; no auto-commit, rolls back on exception) | every HTTP handler | all routers |
| B. `async with get_sessionmaker()() as db:` (manual, own commit) | **12 in scope** (61 more in the rest of `app/`) | `conversations/service.py:379`, `runs/service.py:112`, `runs/router.py:346` (SSE status poll), `notifications/service.py:141,446`, `mcp/service.py:251`, `calendar/reminders.py:62`, `memory/service.py:160`, `memory/extraction.py:106`, `automations/service.py:295,330`, `updates/service.py:303` |
| C. `core.db.session_scope()` (auto-commit context manager) | **0 users anywhere**; dead (§7) | `core/db.py:36` |
| D. `get_engine().connect()` + raw `text()` | 1 | `api/health.py:24-25` |
| Raw SQL `text()` / `sql()` in queries | 3 | `conversations/service.py:310` (jsonb tag count), `notifications/webpush.py:216` (advisory lock), `system_router.py:84` (alembic_version) |

The DB session is closed explicitly before streaming in `api/sse.py:39`, but only `sse_response` does that. `memory/extraction.py:106-172` holds a pooled connection open for the whole LLM stream, and `search/service.py:339` and memory create/update embed inside a request transaction.

### 3.2 Where commits happen

- `await db.commit()` appears **54 times in router files** (17 routers) and **73 times in service files** (20 modules). Several features mix both styles:
  - conversations: the router commits create, patch, delete and bulk (`conversations/router.py:68,84,119,128`); the service commits send_turn, regenerate, select_version, edit_last and branch (`service.py:541,569,601,647,719`).
  - notifications: `service.create` and `mark_read` commit, while the router commits destination changes.
  - runs: `set_status` commits ("# commits" comments), while the router commits pause, resume and plan otherwise.
- **Services that commit the caller's transaction as a hidden side effect**: `notifications.service.create` (`:107`; called from tasks, calendar, focus and automations), `webpush.vapid_key` (`webpush.py:228`), `auth.resolve_session` (inside the auth dependency, `auth/service.py:138`), `links.attach/detach/on_moved`, every documents operation, `calendar.reminders._claim`, `search.service.search` (a GET), `shares.view` (a public GET).
- Caller-commits contracts that are documented and respected: `audit.record`, `bulk`, `delete_conversations`, `start_run`, `request_refresh`, `create_destination`, `providers.*`.
- **Logic in routers rather than services**: `runs/router.py` (pause, resume, plan, cancel: 10 direct DB accesses), `runs/agent_router.py` (`decide_approval`, which `push_router` also imports), `usage/router.py` (all queries), `memory/router.py` (list, summary, export, bulk: 6), `notifications/router.py` (list, clear, delete: 5), `conversations/router.py:93-121` (patch), `profiles/router.py` (create and update), `skills/router.py` (create, import, update), `mcp/router.py:116-142` (tool patch), `projects/router.py:285-291` (delete), `automations/router.py:83-103` (delete). In total 16 router files query the DB directly.

### 3.3 Error handling

- Custom `core/errors.py` exceptions dominate: `raise NotFound` ×52, `AppError` ×51, `Conflict` ×25, `Unauthorized` ×5, `TooManyRequests` ×3, `Forbidden` ×1. Feature-local subclasses: `UnsupportedFile` (415), `InvalidSkill` (422), `SecretInMemory` (422).
- `HTTPException` appears only once, in the SPA fallback (`main_api.py:87`).
- Plain `ValueError` is raised about 40 times, mostly inside Pydantic validators, where it becomes a 422. Outside validators it leaks as a **500**: `fs_guard.relative` (documents traversal), `recurrence.zone` (reminders), and `mcp/router.py:62-65`, which converts it by hand.
- Integrity errors are never caught. An unknown FK id gives a 500 in conversations PATCH and turns (`model_id`), calendar (`task_id`, `project_id`), profiles (`default_model_id`) and the reconcile race. Projects (`projects/router.py:255-259`) and automations (`_check_references`) validate first.
- "Result objects instead of errors" in a few places: `TestResult(ok=False)` in provider and model tests, `TestOut` / `SearchTestOut` / `PushActionOut(ok=False)`, and `BrowserView(available=False)`. They return 200 with `ok:false`.
- `get_*_or_404` helpers are written again in every service, about 20 copies (`get_provider`, `get_model`, `get_conversation`, `get_run`, `get_task`, `tasks.get_project`, `projects.get`, `get_event`, `get_memory`, `get_destination`, `get_server`, `get_profile`, `get_skill`, `get_playlist`, `get_track`, `automations.get`, `shares.get`, `documents.get`, `attachments.get`), plus inline versions in `focus/service.py:89-92`, `notifications/router.py:67-70`, `mcp/router.py:120-122`, `daily_notes/router.py:36-42`, `documents/router.py:235-239`.

### 3.4 Validation and PATCH semantics

Two incompatible PATCH conventions are in use:
- **"None = leave unchanged"**: conversations (`router.py:99-118`), automations (`service.py:169-216`), memory (`service.py:124-126`), providers, mcp.
- **"None = set to null"**: tasks (`tasks/service.py:201`) and music (`music/service.py:83`) `setattr` every key from `exclude_unset`. Sending `{"title": null}`, `{"status": null}`, `{"priority": null}` or `{"tags": null}` to `PATCH /tasks/{id}` writes NULL into a NOT NULL column and gives a 500. The same happens with `PATCH /music/tracks/{id}`.

`model_fields_set` / `exclude_unset` are used in 14 places. Validators are spread between schemas.py (14 features), routers and services: `ConversationPatch`, `TaskIn._tags`, and so on.

### 3.5 How responses are built

- 14 features have a `schemas.py`.
- 19 router modules define their own Pydantic models: `runs/router.py` 10, `documents/router.py` 10, `files/router.py` 8, `agent_router.py` 7, `memory/router.py` 5, `auth/router.py` 4, and `usage`, `permissions`, `web` with 4 each.
- 2 services define response models (`search/service.py`, `updates/service.py`).
- Builder style varies: `_out()` / `x_out()` helpers, `model_validate(from_attributes=True)`, and `**row.model_dump()` re-spreads (`runs/router.py:176,213`).
- Raw dicts or non-model responses: `health` (dict), `ready` (JSONResponse), `memories/export` (JSONResponse dict), `files/upload-folder` (bare `str`), and the exports (PlainText / Response).

### 3.6 Logging

Only **7 modules** in scope log. All use `logging.getLogger(__name__)` and structured `extra={"ctx": {...}}`; there are no f-string log messages and no `print`. Coverage is thin: approvals, deletions and SSRF-relevant sends are not logged. `automations/service.py:308` logs "invalid schedule" without saying which automation. Unhandled exceptions are logged once in `core/errors.py:92`.

### 3.7 Config access

`get_settings()` is called from 11 modules in scope; there is no `os.environ` / `os.getenv` in scope. Config fields with no Python consumer: `Settings.tz` (only the OS `TZ`) and `Settings.trusted_proxies` (uvicorn reads `FORWARDED_ALLOW_IPS`; compose sets both).

### 3.8 Time and time zones

- `datetime.now(UTC)` is used directly 36 times. `_now()` wrappers are duplicated in `auth/service.py:35`, `daily_notes/service.py:39`, `shares/service.py:54`, `automations/service.py:43` (plus `jobs/queue.py:26`).
- DB-side `func.now()` is assigned to attributes in `conversations/service.py:540,645`, `secrets/service.py:34`, `music/service.py:164`; that value isn't readable until a refresh.
- One `time.time()` in `webpush.py:269`.
- No naive `datetime.now()` / `utcnow()`.
- **Time-zone validation exists five times** with different failure modes:

  | Where | On an invalid zone |
  |---|---|
  | `settings/service.py:46` `user_timezone` | falls back to UTC |
  | `calendar/recurrence.py:20` `zone` | raises `ValueError` |
  | `calendar/schemas.py:31` validator | 422 |
  | `automations/schedule.py` `_zone` | 422 |
  | `usage/router.py:100-103` inline | `AppError` |

  `user_timezone` is used in only 7 places. The raw `general.timezone` is read in `calendar/reminders.py`, `tools/builtin/events.py:28`, `runtime/chat.py:278` and `runtime/agent.py:1317`.

### 3.9 ID generation

`IdMixin.id` defaults to `uuid7()` (`db/base.py:27`). Explicit `uuid.uuid4()` breaks time ordering in:
- `focus/service.py:46` and `music/service.py:42`: Core `insert().values(id=...)`. The column default would apply anyway, so these are unneeded.
- `skills/service.py:202`.
- `attachments/service.py:221,249,309`, where the id is also the file name.
- `notifications/service.py:427` (a transient test notification).

Tokens use `secrets.token_urlsafe(32)` (auth, push, shares). Checklist item ids use `token_hex(4)` (`tasks/schemas.py:61`).

### 3.10 Other inconsistencies

- **LIKE escaping**: `search/service.py:85` escapes `%`, `_` and `\`. These do not: `conversations/service.py:277`, `runs/router.py:171`, `tasks/service.py:63-65`, `memory/router.py:51`, `documents/router.py:89`, `links/service.py:166` (mitigated by `parse.moved`), `projects/service.py:49`. `shares/service.py:165` uses `autoescape=True`.
- **Pagination** comes in three styles: offset (`/conversations`), a `before` timestamp cursor (`/runs`, `/notifications`, `/usage/records`), or fixed caps with no paging (tasks 500, focus 2000, memories 1000, music 2000, audit 500).
- **Unique-name checks**: case-insensitive in projects (`service.py:78`), notifications (`:175`) and mcp (`:132`); **case-sensitive** in profiles (`service.py:22`).
- **Tag normalisation**: `conversations.list` uses `tag.strip().lower()`, `tasks.list_tasks` uses `tag.lower()`, `clean_tags` also strips `#`. Tag listing is raw SQL in conversations (`service.py:310`) but a Python set in tasks (`service.py:457-459`).
- **Sync filesystem work on the event loop** in async handlers: `files/router.py:137-140,161,172-174,209`, `links/router.py:46,54`, `documents/router.py:136-138,152` (`unique_path` here vs `asyncio.to_thread(unique_path)` in `conversations/service.py:758`), `automations/service.py:364`, `daily_notes/service.py:103`.
- **GETs with writes**: `/documents*` (reconcile), `/skills` (ensure_builtins), `/projects` (mkdir), `/daily-notes/today` (create), `/files/upload-folder` (mkdir), `/push/key` (create key), `/search?mode=hybrid` (usage row), `/system/status` (probe file), `/public/shares/{t}` (view count), `/providers/{id}/discover` (outbound call).
- **Cross-router imports**: `runs/agent_router.py:24` imports `PlanIn` from `runs/router.py`; `notifications/push_router.py:34` imports `decide_approval` and `DecisionIn` from `runs/agent_router.py`; `daily_notes/router.py:17` imports the private `_content` and `DocumentContent` from `documents/router.py`.
- **Private symbols used across modules**: `runtime.agent._finalize` (`runs/router.py:330`), `mcp.schemas._check` (`mcp/service.py:24`), `documents.router._content`.
- Run status groups are written as literal tuples in `runs/router.py:161,163` instead of reusing constants next to `ACTIVE_STATUSES`.
- Audit IP is missing for shares (`shares/router.py:29-66`) and `auth.session_revoked` (`auth/router.py:124`).

---

## 4. Duplicated logic

| What | Copies | Notes for the refactor |
|---|---|---|
| **slugify** | `documents/service.py:67` (NFKD→ASCII, `-`, 80 chars, "untitled"), `projects/service.py:41` (no NFKD, so "Über"→"ber"; `-`, 60, "project"), `skills/service.py:47` (NFKD, `-`, 64, "skill"), `mcp/service.py:40` (`_`, 24, "server") | They behave differently, and the outputs are stored as slugs. Unifying them changes behaviour unless the parameters are kept. |
| **Next free name or slug** | `projects._free_slug:47` (`-2`, `-3`), `mcp._unique_slug:122` (`_2`, truncates), `notifications._free_name:235` (` (2)`), `workspace.files.unique_name:204` (` (1)`), `documents.unique_path:396` | Same algorithm, different suffix styles. |
| **Unique-name check (409)** | `notifications._ensure_unique_name:175`, `mcp._ensure_unique_name:132`, `projects._unique_name:78`, `profiles.ensure_unique_name:22` (case-sensitive), `skills.ensure_unique_slug:141` | |
| **get-or-404** | about 20 service functions plus 5 inline copies (§3.3) | A generic `get_or_404(db, Model, id, "X not found")` would fit. |
| **Project lookup** | `tasks/service.py:32 get_project`, `projects/service.py:61 get`, `daily_notes/router.py:36 _project` | Three copies for one model. |
| **SHA-256 token hash** | `auth/service.py:39 hash_token`, `notifications/service.py:331 hash_token` (identical) | |
| **Redis fixed-window counters** | `auth.check_rate_limit/register_failure` (`auth/service.py:77-104`), `shares.check_misses/register_miss` (`shares/service.py:318-334`, also reused by push) | Same incr+expire pattern, same "Redis down = allow" policy. |
| **Multipart upload into the workspace** | `files/router.py:156-175` and `links/router.py:38-57` are nearly identical: name check, `MAX_UPLOAD_BYTES` (200 MB defined twice: `files/router.py:27`, `links/router.py:21`), `unique_name`, `write_bytes`. `documents/router.py:127-140` is a third variant. | |
| **Delete parent, then its secrets** | `providers/service.py:155-160`, `notifications/service.py:227-232`, `mcp/service.py:213-218` | |
| **Run plus messages creation** | `conversations/service.py:446-471` (`_start_run`) plus `send_turn:512-530` vs `automations/service.py:222-279` (`start_run`) | Both build user and assistant `ChatMessage` rows, a `Run`, link `assistant.run_id` and enqueue `run.execute`. |
| **"What was said" selection** (skip assistant messages that aren't complete or cancelled) | `conversations/service.py:731` (export), `shares/service.py:113-116` (share; its comment says "the same selection as Download as Markdown"), `conversations/service.py:665` (branch) | |
| **Settings merge** | `settings/service.py:11-20` (`get_section`) and `:23-33` (`get_all`) | |
| **Time-zone validation** | 5 variants (§3.8) | |
| **`_now()` helpers** | 4 in scope (§3.8) | |
| **`notify()` → `publish_global`** | `tasks/service.py:20` and `projects/service.py:56` (both emit "tasks.changed"), `calendar/service.py:21`, `focus/service.py:23`, `music/service.py:25`, `automations/service.py:47`, `mcp/service.py:33`, `memory/service.py:88` | |
| **Image allow-lists** | `files/router.py:28 INLINE_TYPES`, `attachments/service.py:49-50 IMAGE_TYPES/IMAGE_SUFFIXES`, `documents/router.py:123 IMAGE_SUFFIXES` (adds svg and avif) | |
| **Download headers** (`Content-Disposition` built by hand) | `conversations/router.py:205`, `skills/router.py:187`, `memory/router.py:99` | Safe security headers (nosniff, CSP) are also duplicated: `attachments/router.py:55-58`, `files/router.py:149-152`. |
| **Tag listing** | `conversations/service.py:307-316` (SQL) vs `tasks/service.py:457-459` (Python) | |
| **Search ILIKE** | 6 hand-rolled unescaped versions vs `search.service.contains_all` (§3.10) | |
| **Pydantic `_out` builders** that copy ORM fields one by one | `providers/service.py:52,217`, `conversations/service.py:193`, `profiles/router.py:67`, `automations/service.py:77`, `shares/service.py:234`, `calendar/service.py:97`, `music/service.py:204`, `projects/service.py:191` | `model_validate(from_attributes=True)` is used elsewhere. |

---

## 5. God files and functions (in scope)

**Files over 400 lines:**

| Lines | File | What's in it |
|---|---|---|
| 759 | `features/conversations/service.py` | listing and FTS, CRUD, bulk, delete with cascade, turns, regenerate, versions, edit, branch, export, save-as-doc |
| 480 | `features/notifications/service.py` | notifications, destinations, push subscribe, Discord sending, push tokens, the deliver job |
| 478 | `features/automations/service.py` | |
| 459 | `features/tasks/service.py` | |
| 451 | `features/runs/router.py` | 10 models plus lifecycle logic plus 2 SSE streams |
| 425 | `features/attachments/service.py` | |
| 421 | `features/documents/service.py` | |

Next in size: `attachments/extract.py` 371, `skills/builtin.py` 358 (mostly data), `shares/service.py` 354, `providers/service.py` 352, `search/service.py` 350, `updates/service.py` 337, `mcp/service.py` 329.

**Functions over 80 lines:**

| Lines | Function | Location |
|---|---|---|
| 194 | `compute` | `features/stats/service.py:75` (one function, about 15 queries) |
| 100 | `extract` | `features/memory/extraction.py:104` (DB, embedding search, LLM stream, parsing and writes, all under one session) |

Between 60 and 80 lines: `shares/service.py:139 _project` (74), `conversations/service.py:653 branch` (69), `calendar/service.py:177 occurrences` (62), `conversations/service.py:90 message_out` (61).

---

## 6. Coupling

**Feature → feature import edges** (any module of the source feature importing the target):

```
auth          -> audit
automations   -> audit conversations documents notifications profiles providers runs
calendar      -> notifications settings tasks
conversations -> attachments documents profiles projects runs skills tasks
daily_notes   -> documents settings tasks
files         -> audit links settings
focus         -> notifications settings tasks
links         -> documents tasks
mcp           -> audit secrets
memory        -> conversations settings usage
notifications -> audit runs secrets shares
profiles      -> audit settings skills
projects      -> calendar conversations documents profiles providers tasks
providers     -> audit secrets settings usage
runs          -> audit conversations providers
search        -> automations calendar conversations documents memory tasks
settings      -> audit memory
shares        -> attachments audit calendar conversations documents projects tasks
skills        -> profiles settings
stats         -> documents focus runs settings tasks
tasks         -> calendar notifications settings
updates       -> settings
usage         -> automations profiles runs
browser_router.py    -> conversations settings
permissions_router.py-> mcp profiles
system_router.py     -> settings
(no feature imports) attachments audit documents music secrets shell parts.py
```

**Package-level two-way dependencies.** There are no module-level import cycles: a Tarjan SCC run over top-level imports of all of `app/` found none. These pairs still depend on each other:
- **conversations ↔ runs**: `conversations/service.py:32` → `runs.models`; `runs/router.py:28` → `conversations.models`.
- **conversations ↔ projects**: `conversations/service.py:31`; `projects/service.py:22`.
- **profiles ↔ skills**: `profiles/router.py:21` → `skills.models`; `skills/service.py:31` → `profiles.models.profile_skills`.
- **settings ↔ memory**: `settings/sections.py:16` → `memory.schemas.MemorySettings`; `memory/service.py:16` → `settings.service`.
- **tasks ↔ calendar**: `tasks/schemas.py:8` → `calendar.recurrence`; `calendar/reminders.py:25-26` → `tasks.models` and `tasks.schemas`.
- **features ↔ layer packages**: `app.providers` → features.providers, secrets, settings while `features/providers` → `app.providers`; `app.workspace` → `features.runs` while 10 feature imports go to `app.workspace`; `app.web` → `features.settings` while `settings/sections.py` → `app.web.settings`.

**Model ownership leaks:**
- `Project` lives in `tasks/models.py` and is imported by projects, links, daily_notes, focus and shares.
- `settings/sections.py` pulls section models from `memory`, `policy`, `web` and `workspace`.
- `AppSetting` is also written by `updates/service.py` for its state row.

**Imports inside functions:**

| Location | Import | Why |
|---|---|---|
| `runs/router.py:330` | `from app.runtime.agent import _finalize` | Avoids loading the whole runtime into the API at import time and dodges a potential cycle (runtime.agent imports automations, conversations, notifications, …). It is also a private symbol. |
| `providers/router.py:53`, `providers/service.py:336` | `from app import claude_runner_client` | **No cycle**: `claude_runner_client` imports only `core.config`. Looks unnecessary, maybe for test patching. |
| `updates/service.py:299` | `from app.core.db import get_sessionmaker` | **No cycle.** Unnecessary. |
| `attachments/extract.py:125,246` | `pypdf`, `openpyxl` | Lazy heavy dependencies; intentional. |
| `web/settings.py:32` | `app.web.safe_http` | Commented as "avoid an import cycle". |
| `jobs/scheduler.py:16-21`, `jobs/runner.py` handlers | feature services | Out of scope; avoids cycles at worker start-up. |

---

## 7. Dead-code candidates

Method: a script listed every top-level function, class and UPPER_CASE constant in `app/features/**` and `app/api/*`, then ran `grep -rnw <name> app --include=*.py`. A name counts as dead when the only match is its own definition line. Survivors were then grepped in `backend/tests`, `e2e/`, `docs/` and `frontend/src`, and checked for dynamic use (`getattr` / `importlib` in scope: only attribute copying in skills, providers, tasks and shares, none on these names; job handlers are registered by string in `jobs/runner.py:73-80` and periodic tasks in `jobs/scheduler.py:23-30`, and none of these names are among them). Routes were checked against every `/api/...` literal in `frontend/src` (openapi-fetch paths plus template strings; `PUT /api/settings/${section}` covers the generated settings routes), `frontend/public/sw.js`, `e2e/`, `backend/tests`, and docs.

| Symbol | Location | Proof | Confidence |
|---|---|---|---|
| `purge_expired` | `features/auth/service.py:163` | `grep -rnw purge_expired app tests` matches only the definition. Consequence: `auth_sessions` rows are never deleted. | High (dead; though probably *meant* to be a periodic task) |
| `active_run_for_conversation` | `features/runs/service.py:39` | 1 match (the def) in app, 0 in tests | High |
| `extract_pdf_text` | `features/attachments/service.py:156` | 1 match in app, 0 in tests | High |
| `_uploads_dir` | `features/attachments/service.py:84` | 1 match | High |
| `KIND_LABELS` | `features/attachments/service.py:53` | 1 match in backend (a frontend `KIND_LABELS` in `UsagePage.tsx` is a different symbol) | High |
| `MAX_EXTRACTED_CHARS` | `features/attachments/service.py:46` | 1 match | High |
| `session_scope` | `core/db.py:36` (outside scope; nothing in scope uses it) | 1 match in app and tests; 61+12 places use `get_sessionmaker()()` instead | High |
| `parse.file_link` | `features/links/parse.py:24` | Used only by `tests/api/test_links.py` | Medium (test helper only) |
| Route `GET /api/tools` | `features/permissions_router.py:85` | Not in `frontend/src`, `e2e`, `backend/tests`, or `sw.js`. Only `docs/architecture.md:573` mentions `GET /tools`. | High (unused by clients) |
| Route `GET /api/tasks/tags` | `features/tasks/router.py:59` | Only `tests/api/test_tasks_calendar.py:68` | Medium (API kept for tests or agents?) |
| Route `POST /api/music/playlists/reorder` | `features/music/router.py:56` | Only `tests/api/test_music.py:87` and docs | Medium |
| Routes `PATCH /api/music/tracks/{id}`, `DELETE /api/music/tracks/{id}`, `DELETE /api/focus/sessions/{id}` | `music/router.py:32,39`, `focus/router.py:50` | Not in the frontend; used by e2e clean-up (`e2e/tests/*`) and API tests | Low (keep: e2e depends on them) |
| Setting `general.confirm_destructive_actions` | `features/settings/sections.py:25` | Backend: 0 readers. Frontend: only the toggle itself (`GeneralPage.tsx:62-63`); no code anywhere reads the value. | High (a toggle with no effect) |
| Config `Settings.tz`, `Settings.trusted_proxies` | `core/config.py:35-36` (outside scope) | No Python reader (`grep -rn "get_settings().tz\|\.trusted_proxies"` finds nothing); compose and Dockerfile use the env vars directly | Medium |
| `ApprovalOut.kind` comment / `Approval.kind` doc | `runs/models.py:142` says `"action"\|"plan"`; `"question"` also exists (`agent_router.py:36,197`) | Stale doc, not dead code | n/a |

Checked and **not dead**: `one_out` (`tools/builtin/projects.py:80,137`), `tasks.get_project` (used inside tasks), `find_playlist`, `get_or_create_by_name`, `set_capability`, `store_image` (tools and runtime), `is_occurrence`, `looks_secret`. All global SSE event names published from features are listened for in `frontend/src`.

---

## 8. Bugs found in passing (not fixed)

| # | Sev | Location | What's wrong | Suggested fix |
|---|---|---|---|---|
| B1 | **Med** | `calendar/reminders.py:63-96`, root cause `settings/sections.py:23` | An invalid `general.timezone` (the API accepts any ≤64-char string) makes `recurrence.zone()` raise inside `fire_due`, every tick. All task reminders and the rest of the event reminders stop until the setting is fixed. | Validate `GeneralSettings.timezone` with a validator, and/or use `settings.user_timezone()` in reminders, `tools/builtin/events.py:28` and the runtime turn context. |
| B2 | **Med** | `documents/service.py:165-213` | Two concurrent `reconcile()` calls both insert the same new `Document.path`; the unique index makes one fail with an unhandled IntegrityError → 500. Reconcile runs on almost every documents GET. | Use `INSERT … ON CONFLICT (path) DO NOTHING` or a pg advisory lock around reconcile, and stop reconciling on hot GETs. |
| B3 | **Med** | `documents/router.py:150-155`, `documents/service.py:396-401` | `folder` isn't validated before `mkdir(parents=True)`, so dirs get created outside the workspace and the request then 500s (`ValueError` from `fs_guard.relative`). See §0. | Pass `folder` through `check_path`-style validation (or `files.resolve(f"documents/{folder}")`) **before** mkdir; turn errors into `AppError(invalid_path)`. |
| B4 | Low-Med | `tasks/service.py:201`, `music/service.py:83` | PATCH with an explicit `null` on a NOT NULL field (`title`, `status`, `priority`, `description`, `tags`, `checklist`; music `title`) → IntegrityError 500. | Reject nulls in the schemas, or skip `None` for non-nullable fields as the conversations and automations PATCH handlers do. |
| B5 | Low-Med | `documents/router.py:181-191` / `documents/service.py:404-413` | Moving or renaming a document via the Documents API doesn't call `links.on_moved`, unlike `POST /files/move` (`files/router.py:191`) and the agent tool. `task_files` attachments and path-based links to that `.md` break. | Call `links.on_moved(db, old, new)` after the move. |
| B6 | Low-Med | `conversations/service.py:360-372`, `attachments/service.py:399-425` | Attachment files and saved tool outputs are unlinked, and the browser session is closed, **before** the caller commits. If the transaction then rolls back, the rows point at missing files. | Collect the paths and delete after commit, or with an after-commit hook. |
| B7 | Low | Many: `conversations/router.py:105-106`, `conversations/service.py:505-506`, `calendar/service.py:59-60`, `profiles/router.py:104` | Unknown FK ids (`model_id`, `task_id`, `project_id`, `default_model_id`) aren't checked → 500 instead of 404 or 422. | Validate as `projects/router.py:255-259` does. |
| B8 | Low | `runs/service.py:107-127` | `expire_stale_approvals` selects `FOR UPDATE SKIP LOCKED`, but `set_status` commits inside the loop, which releases the locks on the remaining rows while they are still being iterated. A second worker could pick them up. | Process one approval per transaction (re-select it), or defer the commits. |
| B9 | Low | `runs/service.py:62-65` | The durable `RunEvent.seq` is computed as `max+1`. Concurrent emits for one run (worker plus an API pause or cancel) can collide on the PK. | Use a sequence/identity column, or `ON CONFLICT` retry. |
| B10 | Low | `runs/agent_router.py:224-227` | `approval.resolved` is published **before** `set_status` commits; a client that reloads on that event can still see the approval as pending. `set_status` itself publishes after commit, and its comment explains why that order matters. | Publish after commit. |
| B11 | Low | `runs/router.py:357-368,418-422` | A malformed `Last-Event-ID` makes Redis raise `ResponseError` (a `RedisError`). That is treated as "Redis down", so the stream degrades to polling (run stream) or loops "events unavailable" every 6 s forever (global stream). | Validate the id format (`\d+-\d+` or `$`) and fall back to `0-0` / `$`. |
| B12 | Low | `conversations/service.py:258-278` | The FTS hit list is capped at 200 **before** the archived, project, tag and automation filters, so matching chats can be missing from search results. | Join the FTS subquery with the conversation filters. |
| B13 | Low | `usage/router.py:134-138` | `.order_by("key").limit(400)` is applied before re-sorting by cost, so with more than 400 groups the most expensive can be cut. | Order by cost in SQL for non-day groupings. |
| B14 | Low | `auth/service.py:163` (never called) and `calendar/models.py:75` (`reminders`, never pruned) | Tables grow without bound: expired sessions and reminder claims. Orphan unclaimed `attachments` (and their files) are never cleaned either. | Add periodic purges. |
| B15 | Low | `auth/service.py:77-97` | Check-then-increment rate limiting is racy: N parallel wrong passwords all pass the check. | `INCR` first, then compare. |
| B16 | Low | `focus/router.py:35` | `phase: FocusPhase \| None = "focus"`: a client can't ask for all phases (there's no way to send None in a query string). | Add an `"all"` literal. |
| B17 | Low | `notifications/schemas.py:37-42` | The error message says "must start with https://" but `http://` is accepted. | Pick one. |
| B18 | Low | `links/service.py:151-200` | `on_moved` commits attachments and tasks, then saves each document with its own commit; a failure halfway leaves links half rewritten. | One transaction for the DB part. |
| B19 | Trivial | `main_api.py:86` | `GET /api` (no trailing slash) serves `index.html` with 200 instead of 404. | `path == "api" or path.startswith("api/")`. |
| B20 | Perf | `projects/service.py:150-188` | `GET /projects` mkdirs two folders per project; `one_out` builds the whole list to return one. `links/service.py:88-101` reads **every** document from disk on each backlinks call. | |
| B21 | Low | `providers/router.py:161-164` | Deleting a model leaves its UUID in the `models` settings section (defaults and fallbacks) and in projects' `default_model_id` (FK SET NULL handles that one). Routing has to cope. | Clean up `ModelDefaults` on delete. |
| B22 | Low | `skills/router.py` (`GET /skills` → `ensure_builtins`) and similar GET-with-write endpoints | Writes inside GETs can race between tabs: two parallel first loads could both insert built-ins. Worth checking `ensure_builtins` for `ON CONFLICT`. | |

---

## 9. Security smells (full list; serious ones are repeated in §0)

| Sev | Issue | Location |
|---|---|---|
| **Med** | Directory creation outside the workspace via `POST /api/documents {folder}` (relative `../` or absolute paths) | `documents/service.py:396-401` |
| **Med** | Re-auth bypass: profile `plan_review` override isn't treated as security-sensitive and can disable the global "always review plans" | `profiles/router.py:85-89,153-156`, `profiles/service.py:45-55` |
| Low-Med | Unauthenticated login lock-out through the global failure counter (30/min); racy per-IP counter | `auth/service.py:26-27,77-97` |
| Low-Med | Logout or revocation doesn't end open SSE streams (global notification stream keeps flowing) | `api/sse.py`, `runs/router.py:398-441`, `browser_router.py:102-110` |
| Low-Med | SSRF through `POST /api/web/test-search` (arbitrary URL, follows redirects, unguarded httpx, no re-auth although saving that URL needs re-auth) | `web/router.py:45-74`, `web/search.py:77-91` |
| Low | Discord webhook sends: unguarded httpx, any http/https host including private ones (needs re-auth to configure) | `notifications/service.py:314` |
| Low | Provider `base_url` SSRF, by design for local LLMs (needs re-auth); `discover` runs on GET | `providers/service.py:163-171` |
| Low | `/api/openapi.json` is public in production | `main_api.py:45` |
| Low | Credentials may land in the audit log (`base_url`, MCP `url` and `args`); the full sensitive-settings value is logged too (no secrets in those sections today) | `providers/router.py:72`, `mcp/router.py:43-49`, `settings/router.py:39-46` |
| Low | Share tokens are stored and listed in plaintext (session and push tokens are hashed) | `shares/service.py:278`, `shares/schemas.py` (`ShareOut.token`) |
| Low | `secrets.last4` reveals short secrets completely | `secrets/service.py:22,33` |
| Low | Uploads have no quota; unclaimed attachments persist forever (disk-fill by an authenticated user) | `attachments/router.py:35-42` |
| Info | Origin check: allows requests with neither Origin nor Referer (relies on SameSite=Lax); compares with the `Host` header, which is fine for CSRF. Only `/api/` paths are checked. No websocket routes exist. | `api/security.py:24-61` |
| Info | `decide_approval` (the only way an `ask` becomes yes) needs a session, or for push a single-use 256-bit token bound to one approval, "approve once" only, TTL ≤24 h, miss rate-limited. Looks sound. | `runs/agent_router.py:175-228`, `notifications/push_router.py:72-102` |
| Info | File downloads: attachments and workspace files are served inline only for raster images, with `nosniff` and CSP `default-src 'none'`; SVG is always a download. Document assets accept `.svg`, which is still served as a download. Looks sound. | `attachments/router.py:45-59`, `files/router.py:135-153` |
| Info | Push subscription endpoints are checked against private hosts on every connection (`safe_http.GuardedTransport`); redirects aren't followed. Good, but it is the only guarded outbound client in scope. | `notifications/webpush.py:93-106,239-247` |

No SQL injection, no secrets written to log lines, and no authorization gaps between routers (every non-public router sits under `protected`) were found.

---

## 10. Where `docs/architecture.md` doesn't match the code

- **§D Repository structure**:
  - It lists `features/approvals/`, `features/knowledge/` and `features/mcp_servers/`. Approvals live in `runs/agent_router.py`, knowledge is `app/knowledge/`, and the MCP feature is `features/mcp/`.
  - Missing from the doc: `daily_notes`, `focus`, `links`, `music`, `projects`, `shares`, `shell`, `stats`, `updates`, `providers` (feature), and the top-level `browser_router.py`, `permissions_router.py`, `system_router.py`, `parts.py`.
  - `core/time` doesn't exist. `search/` is `app/web/`.
- **§O API surface**:
  - `PATCH /settings/{section}` is actually **PUT**.
  - `POST /providers/{id}/discover` is actually **GET**; `GET/PUT /model-defaults` is `PUT /settings/models`.
  - `GET /attachments/{id}` is `/attachments/{id}/content`.
  - These don't exist: `POST /runs` (standalone run), `GET /runs/{id}/tool-calls` and `/runs/{id}/files` (there is `/runs/{id}/timeline`), `CRUD /policies`, `POST /policies/preview` (actually `/permissions/preview`), `GET /capabilities`.
  - `POST /automations/{id}/run-now` is `/run`; `GET /automations/{id}/runs` is `GET /runs?automation_id=`.
  - `CRUD /workspace/roots` doesn't exist. `POST /files/mkdir` is `/files/folder`; `DELETE /files` is `POST /files/trash`.
  - `GET /search-providers/test` is `POST /web/test-search`.
  - Usage takes `start` / `end` (and `tz`), not `from` / `to`. Search takes `kinds`, not `types`.
  - Not documented at all: shares (and the public share page), daily-notes, browser, system/status, updates, push and public push, permissions catalog and summary, provider-types, providers/claude-code/status, models/import, conversations bulk / tags / branch / export / save-document / edit-last / version, runs-summary, notifications/summary, shell/ssh-key, web/status, documents/{id}/revisions/{rid} GET, attachments content.
- `Approval.kind` comment (`runs/models.py:142`) omits `"question"`.
