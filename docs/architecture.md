# Architecture — anemo (AI Workspace & Agent Operating Environment)

## Context

The goal is a single-user, self-hosted AI workspace for a Linux homelab, deployed with Docker Compose behind Nginx Proxy Manager (NPM). It covers chat, autonomous agents, persistent memory, documents, files, tasks, calendar, scheduled automations, MCP, browser automation and multi-provider models. The key design principle: **autonomy is a runtime-enforced, user-controlled capability, never something the model gets by default.** The runtime is the product. The UI is only one consumer of it.

---

## A. Current Repository Assessment

- `C:\Users\user\Desktop\AI-workspace` is **empty** and **not a git repository**. There is no code, infra, tests or docs to keep, refactor or replace. Everything is planned from scratch.
- The dev machine is Windows 11 with Docker 29.8, Node 22.23, npm 10.9, Python 3.14 and git 2.55. **pnpm and uv are not installed.**
- Implications:
  - The deploy target is Linux, so all runtime work happens in containers. Local Python 3.14 is only for tooling. Containers pin **Python 3.13** for library compatibility.
  - Use npm for the frontend so no extra tool is needed. Install `uv` for the backend, or run it inside the dev container.
  - Add `.gitattributes` (LF endings for `*.sh`, Dockerfiles and Python). Windows CRLF breaks container entrypoints.
  - In the README, recommend a WSL2 checkout for dev. Docker Desktop bind mounts from NTFS are slow and mangle file permissions.
- Phase 0 step one: `git init`, then the `main` branch.

---

## B. Proposed Architecture

```
                 Internet ──► Nginx Proxy Manager (external, TLS)
                                     │  HTTP :8080 (only exposed port)
┌────────────────────────────────────▼──────────────────────────────────────────────┐
│ app  (FastAPI + built React SPA)                                                   │
│  api/ routers ─► application services ─► repositories (SQLAlchemy)                 │
│  • auth/session  • CRUD  • file mgr  • SSE gateway (reads Redis streams)           │
│  • NEVER calls LLMs for turns; enqueues jobs, returns run_id                       │
└───────┬─────────────────────────────┬────────────────────────────────────────────┘
        │ SQL (jobs, state)           │ XREAD run streams / PUBLISH control signals
┌───────▼────────┐            ┌───────▼────────┐
│ postgres17     │            │ valkey (redis) │  live event streams, cancel/pause
│ + pgvector     │◄──────┐    │                │  signals, rate limits, heartbeats
│ source of truth│       │    └───────▲────────┘
└───────▲────────┘       │            │
        │ LISTEN/NOTIFY  │            │ XADD events
┌───────┴────────────────┴────────────┴─────────────────────────────────────────────┐
│ worker  (same backend image, different entrypoint; N replicas OK)                  │
│  JobRunner (lease/heartbeat) ──► AgentRuntime ──► ContextBuilder ──► ModelRouter    │
│                                     │                                  │           │
│                                     ▼                                  ▼           │
│                               ToolExecutor ──► PolicyEngine      ProviderAdapters   │
│                                     │          (pure, no IO)     (OpenAI/Anthropic/ │
│                                     │                            OAI-compat/...)    │
│  Scheduler loop (advisory-lock leader): automations, reminders, index jobs          │
│  Memory extractor, knowledge indexer, notification dispatcher (outbox)              │
└───────┬───────────────┬──────────────────┬───────────────────┬────────────────────┘
        │ WorkspaceFS   │ HTTP (token)     │ HTTP (token)      │ MCP streamable-HTTP
        ▼ (path guard)  ▼                  ▼                   ▼
   /workspace     ┌──────────────┐  ┌────────────────┐  ┌─────────────────────┐
   (bind mount)   │ sandbox      │  │ browser        │  │ mcp-host (optional) │
        ▲         │ no network   │  │ Playwright +   │  │ runs stdio MCP      │
        │         ├──────────────┤  │ Chromium       │  │ servers, exposes    │
        └─────────│ sandbox-net  │  │ (optional)     │  │ them over HTTP      │
   same mount     │ egress only  │  └────────────────┘  └─────────────────────┘
                  └──────────────┘
   External (user-provided): SearXNG, NPM, LLM provider APIs, local model servers, Discord
```

**Layering, top to bottom:**
Frontend → API routers → Application services → Agent Runtime → Tool System (→ Policy Engine) → External services / Workspace.

Rules:
- Routers are thin: parse input, check auth, call services, map to schemas.
- Services own business logic.
- The runtime depends only on service interfaces, the tool registry and the provider layer. It never depends on HTTP.
- The policy engine is a pure module with zero IO.
- Provider adapters know nothing about runs, tools or DB.

**Key flow (any turn: chat, agent, or automation):**
1. The API creates a `runs` row (queued), inserts a `jobs` row, `NOTIFY jobs`, and returns `{run_id}`.
2. The client opens `GET /api/runs/{id}/events` (SSE).
3. A worker claims the job, loads the run checkpoint and executes. It XADDs events to Redis and persists durable state to Postgres.
4. The SSE gateway relays Redis events to the browser. On reconnect it uses `Last-Event-ID` plus the DB snapshot.

Chat turns go through the worker too. That gives one execution path, one event protocol and one reconnect story, and usage tracking happens in one place. LISTEN/NOTIFY keeps pickup latency to a few milliseconds.

---

## C. Technology Decisions

| Concern | Choice | Why |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite, React Router, **TanStack Query** (server state), **Zustand** (small client stores), **Tailwind CSS v4** (`@tailwindcss/vite`) on top of **CSS custom-property tokens**, Radix UI primitives (a11y dialogs/menus/popovers), lucide-react icons, `clsx` + `tailwind-merge` via a tiny `cn()` helper | Mainstream tools an intermediate developer knows (the user prefers Tailwind); little magic. Tailwind v4's `@theme` maps semantic utilities (`bg-accent`, `text-muted`, `bg-surface`) to CSS variables, so the accent/theme changes at runtime from Settings. The default color palette is disabled so components can only use semantic tokens, never hardcoded colors. Radix is headless and styled with Tailwind. |
| Editors | **TipTap** (ProseMirror) + `@tiptap/markdown` for Markdown round-trip; **CodeMirror 6** for code/text files | TipTap gives Notion-like rich editing with a Markdown source of truth. CodeMirror is light and good for code. |
| Rendering | react-markdown + remark-gfm + Shiki (lazy) | GFM tables and good syntax highlighting |
| Calendar UI | FullCalendar (MIT core) | Month/week/day views are a lot of work to build ourselves; the backend expands recurrences. |
| API types | FastAPI OpenAPI → `openapi-typescript` + `openapi-fetch` | Typed client generated from the backend, with no hand-kept duplicate types |
| Backend | Python 3.13, FastAPI, Pydantic v2, SQLAlchemy 2 (async, asyncpg), Alembic, `uv` | As requested; async fits streaming and IO-heavy agents |
| Database | PostgreSQL 17 (`pgvector/pgvector:pg17`) | One durable store for state, queue, FTS (tsvector), trigram (pg_trgm) and vectors |
| Vector search | pgvector; **untyped `vector` column + `model_key` column**, exact cosine search, optional per-model partial HNSW index | Single-user scale (≤ ~10⁵ chunks) makes exact search fast (tens of ms). Untyped storage survives embedding-model changes without migrations. |
| Job queue | **In-house Postgres queue** (`jobs` table, `FOR UPDATE SKIP LOCKED`, leases + heartbeats, LISTEN/NOTIFY wakeup), ~300 LOC | Durable across restarts with no extra broker semantics. Resumable/suspendable runs need tight control over leases and recovery, which Celery/arq make awkward. Easy to test and read. |
| Scheduler | Worker-embedded loop; leader chosen by `pg_try_advisory_lock`; `croniter` + persisted `next_run_at`; explicit misfire policy | Survives restarts because all timing state is in the DB. No frontend timers, no APScheduler job-store duplication. |
| Live events / control | **Valkey 8** (Redis-compatible, BSD license): Redis Streams per run (replay by ID), pub/sub for cancel/pause | Streams map 1:1 onto SSE `Last-Event-ID`. Postgres NOTIFY's 8 KB payload limit and lack of replay make it wrong for token streams. |
| Streaming to browser | **SSE** (+ REST POST for commands) | Server→client is the dominant direction. Built-in reconnect with `Last-Event-ID`. Plain HTTP/1.1 works through NPM (we send `X-Accel-Buffering: no`). Commands (approve, cancel) are naturally request/response. WebSockets add connection state for no gain. |
| Providers | Own thin adapters on the official `openai` and `anthropic` SDKs, plus `httpx` | LiteLLM is broad but leaky and heavy. Three adapters (OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages) cover OpenAI, Anthropic, OpenRouter, Ollama, vLLM, LM Studio and llama.cpp. |
| MCP | Official `mcp` Python SDK as **client**. Remote servers via Streamable HTTP (SSE legacy supported). stdio servers run in an isolated **mcp-host** container, bridged to HTTP. | stdio servers are arbitrary executables and must not run inside the worker, which holds DB credentials and secrets. |
| Browser automation | Separate **browser** service: Playwright (Python, async) + Chromium, with a small session API | Isolates a heavy, crash-prone component. It can be restarted independently and is optional via Compose profile. |
| Shell execution | **sandbox** containers running a tiny exec daemon (`execd`): no network (`sandbox`) and egress (`sandbox-net`) | Enforces isolation at the infrastructure level. Network access is a network-namespace fact, not a prompt instruction. No docker.sock. |
| Auth | Single user from env (`ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` argon2 — plaintext `ADMIN_PASSWORD` accepted with warning); server-side sessions in DB; HttpOnly+Secure+SameSite=Lax cookie; Origin check on mutations; login rate-limit; "re-auth" for security-sensitive settings | Simple and correct. No registration surface. |
| Secret storage | API keys/webhooks/MCP env **encrypted at rest** (Fernet/AES; key derived via HKDF from `APP_SECRET_KEY` in `.env`); write-only via API (masked, last 4 shown); never given to tools or the model | Keeps plaintext out of DB dumps and backups. Documented: losing `APP_SECRET_KEY` means re-entering secrets. |
| Web fetch | httpx + trafilatura → Markdown; SSRF guard | Readable page text for models |
| Search | `SearchProvider` interface; SearXNG first (JSON API) | Replaceable/complementable |

---

## D. Repository Structure

```
ai-workspace/
├─ docker-compose.yml            # production
├─ docker-compose.dev.yml        # hot reload overrides (uvicorn --reload, vite dev)
├─ docker-compose.override.example.yml  # extra workspace mounts, external NPM/SearXNG networks
├─ .env.example   .gitattributes   .editorconfig   Makefile   README.md
├─ docs/  (architecture.md, permissions.md, deployment.md, providers.md, mcp.md, backup.md)
├─ backend/
│  ├─ Dockerfile                 # multi-stage: builds frontend → copies dist into app image
│  ├─ pyproject.toml  uv.lock  alembic.ini
│  ├─ migrations/versions/
│  ├─ app/
│  │  ├─ main_api.py             # FastAPI app factory, static SPA mount
│  │  ├─ main_worker.py          # JobRunner + Scheduler + dispatchers
│  │  ├─ cli.py                  # hash-password, rotate-key, reindex, doctor
│  │  ├─ core/                   # config, db, redis, logging, crypto, ids(uuid7), errors, time
│  │  ├─ api/                    # deps.py (auth, db session), router registry, sse.py
│  │  ├─ jobs/                   # queue.py, runner.py, scheduler.py, handlers registry
│  │  ├─ events/                 # event schemas, publisher (XADD), stream reader
│  │  ├─ providers/              # base.py (Protocol + canonical types), adapters/{openai_responses,openai_chat,anthropic,fake}.py, registry.py, router.py, catalog.json, pricing.py
│  │  ├─ runtime/                # runner.py (state machine), context.py (ContextBuilder), plan.py, signals.py, limits.py, compaction.py, subagents.py
│  │  ├─ policy/                 # models.py (Policy DSL), engine.py (pure), presets.py, summary.py, risk/shell_classifier.py
│  │  ├─ tools/                  # base.py, registry.py, executor.py, results.py, builtin/{fs,shell,web,browser,docs,tasks,calendar,memory,notify,plan,agents,skills,automation_state}.py
│  │  ├─ workspace/              # fs_guard.py (path resolution), roots.py, trash.py, watcher.py
│  │  ├─ sandbox_client/  browser_client/  mcp/ (manager.py, tool_adapter.py)
│  │  ├─ search/                 # base.py, searxng.py, fetch.py (SSRF guard)
│  │  └─ features/               # one folder per domain: models.py, schemas.py, service.py, router.py
│  │     ├─ auth/ settings/ secrets/ conversations/ attachments/ runs/ approvals/
│  │     ├─ memory/ knowledge/ documents/ files/ tasks/ calendar/ profiles/ skills/
│  │     ├─ automations/ notifications/ mcp_servers/ usage/ search/ audit/
│  └─ tests/  unit/ integration/ api/ runtime/ policy/ security/  conftest.py
├─ sandbox/          # Dockerfile (debian-slim + git, python, node, common CLI), execd/ (FastAPI, ~200 LOC)
├─ browser/          # Dockerfile (playwright base), service/ (session API)
├─ mcp-host/         # Dockerfile (node + python + uv), bridge/ (stdio→streamable HTTP)
├─ frontend/
│  ├─ package.json  vite.config.ts  tsconfig.json
│  └─ src/
│     ├─ main.tsx  app/ (router.tsx, AppLayout.tsx, Sidebar/, providers.tsx, RequireAuth.tsx)
│     ├─ api/        # client.ts (openapi-fetch), schema.d.ts (generated), sse.ts (EventSource wrapper)
│     ├─ styles/     # app.css (@import "tailwindcss"; @theme semantic tokens), tokens.css (light/dark CSS vars)
│     ├─ components/ui/   # Button, IconButton, Card, Dialog, Popover, Menu, Tabs, Input, Select, Switch, Badge, Toast, EmptyState, Spinner, CodeBlock, Markdown
│     ├─ features/<feature>/  # chat, runs, approvals, files, documents, tasks, calendar, memory,
│     │                       # agents(profiles/skills), automations, search, notifications, settings, usage, auth
│     │   ├─ pages/  components/  hooks/  api.ts  store.ts? (only if needed)
│     ├─ hooks/  (useDebounce, useHotkey(single), useConfirm)
│     └─ lib/    (format, dates, tokens)
└─ e2e/              # Playwright tests against compose stack with fake provider
```

The backend image serves both `app` and `worker`. `sandbox`, `browser` and `mcp-host` are small separate images.

---

## E. Data Model

IDs are UUIDv7 (time-sortable). All timestamps are `timestamptz`. Rows have `created_at`/`updated_at`. There are no soft-deletes except where noted (trash for files, `archived` for conversations/memories).

**Config & auth**
- `auth_sessions` (id, token_hash UNIQUE, created_at, last_seen_at, expires_at, user_agent, ip, reauth_at)
- `app_settings` (section PK, value jsonb, version). Pydantic-typed sections: general, appearance, model_defaults, search, memory, workspace, limits, advanced.
- `secrets` (id, kind, ciphertext bytea, last4, created_at, rotated_at). Referenced by FK from providers, MCP servers and destinations.
- `audit_log` (id, ts, actor enum user|agent|system, action, target_type, target_id, details jsonb). Index (ts DESC).

**Providers & models**
- `providers` (id, name, type enum openai|openai_responses|anthropic|openai_compatible|openrouter, base_url, secret_id?, headers jsonb, extra jsonb, enabled)
- `models` (id, provider_id FK, model_key, display_name, capabilities jsonb {chat, reasoning, tools, vision, pdf, structured_output, embeddings, streaming}, context_window, max_output, pricing jsonb {input_per_mtok, output_per_mtok, cached...} nullable, embedding_dims?, enabled). UNIQUE(provider_id, model_key).
- Task defaults live in `app_settings.model_defaults`: `{chat, agent, summarization, memory, background, automation, embeddings, title}` → model_id + ordered fallbacks.

**Conversations**
- `conversations` (id, title, default_mode, profile_id?, model_id?, pinned, archived, summary, summary_upto_message_id, last_message_at). Index (archived, pinned, last_message_at DESC); tsvector on title.
- `messages` (id, conversation_id FK, seq, role enum user|assistant|system|tool_note, content jsonb (canonical blocks), text_plain (for FTS), run_id?, model_id?, created_at). UNIQUE(conversation_id, seq); GIN(tsv generated from text_plain).
- `attachments` (id, conversation_id?, message_id?, filename, mime, size, sha256, storage_path, kind enum image|pdf|text|structured|other, extracted_text?, meta jsonb). Index (sha256) for dedupe.

**Runs (unified execution record: chat turn, agent run, automation run, sub-agent)**
- `runs` (id, kind enum chat|agent|automation|subagent, status enum queued|running|paused|waiting_approval|completed|failed|cancelled|interrupted, conversation_id?, automation_id?, profile_id?, parent_run_id?, root_run_id, depth, model_id, request text, effective_policy jsonb (snapshot), toolset jsonb, limits jsonb, plan jsonb, plan_version, checkpoint jsonb (step idx, pending tool calls), context_manifest jsonb, result_summary, error jsonb, attempt, started_at, ended_at, totals jsonb {tokens, cost}).
  Indexes: (status) partial WHERE status IN active states; (conversation_id, created_at); (automation_id, created_at DESC); (parent_run_id); (created_at DESC).
- `run_events` (run_id FK, seq, type, ts, data jsonb). PK(run_id, seq). Durable events only (status, plan, tool lifecycle, approvals, errors, final message). Token deltas are *not* persisted.
- `tool_calls` (id, run_id, step, tool_name, capability, args_redacted jsonb, risk, decision enum allow|ask|deny, decision_reason, matched_rule, approval_id?, status enum pending|running|succeeded|failed|denied|cancelled|interrupted, result_summary jsonb, output_ref?, details jsonb (shell: cmd, cwd, exit_code, stdout/stderr head+tail), started_at, ended_at, duration_ms). Index (run_id, step); (tool_name, started_at).
- `approvals` (id, run_id, tool_call_id, actions jsonb, status enum pending|approved|denied|expired, grant_scope enum once|run|policy, decided_at, expires_at). Partial index WHERE status='pending'.
- `run_file_changes` (id, run_id, tool_call_id, path, op enum create|modify|delete|move, before_hash, after_hash, backup_ref). Drives "files affected" and **one-click revert**.
- `jobs` (id, type, payload jsonb, priority, lane enum interactive|background, status enum queued|leased|done|failed|dead, run_at, attempts, max_attempts, lease_owner, lease_expires_at, last_error, dedupe_key UNIQUE nullable). Index (status, lane, priority DESC, run_at) partial WHERE status='queued'.

**Agents**
- `policies` (id, name, description, document jsonb (Policy DSL), is_builtin, version). The global default policy and the global **ceiling** policy are referenced from settings.
- `agent_profiles` (id, name, description, instructions, default_model_id?, toolset jsonb {categories, tools, mcp}, policy_id FK, workspace_roots uuid[], memory_mode enum off|read|read_write, auto_retrieval bool, limits jsonb, icon/color)
- `skills` (id, slug UNIQUE, name, description, instructions md, required_capabilities text[], tags text[], version, source enum user|imported)
- `profile_skills` (profile_id, skill_id) PK both.

**Memory & knowledge**
- `memories` (id, kind enum preference|fact|profile|project|instruction, content, category, importance 0–1, confidence, status enum active|pending|archived, pinned bool, source_type enum user_explicit|extracted|agent|manual, source_conversation_id?, source_message_id?, superseded_by?, last_used_at, use_count). Index (status, kind); tsvector on content.
- `knowledge_chunks` (id, source_type enum memory|document|file|conversation_summary|run_summary, source_id, chunk_index, content, tsv generated, embedding vector (untyped), model_key, content_hash, updated_at). Indexes: (source_type, source_id); GIN(tsv); partial HNSW per active `model_key` created by maintenance job (`(embedding::vector(D))`). This is the index behind memory retrieval, workspace RAG and semantic global search.

**Workspace**
- `workspace_roots` (id, name, rel_path UNIQUE, agent_access enum none|read|read_write, shell_visible bool (informational, see risks), indexed bool)
- `workspace_files` (id, root_id, rel_path, size, mtime, sha256, mime, indexed_at). UNIQUE(root_id, rel_path); trigram on rel_path for search.
- `documents` (id, root_id, rel_path UNIQUE (the .md file), title, content_hash, frontmatter jsonb, word_count, last_editor enum user|agent|external). tsvector on title.
- `document_revisions` (id, document_id, content text, content_hash, author enum user|agent|external, run_id?, created_at). Pruned to last N / age policy.

**Tasks & calendar**
- `projects` (id, name, color, archived)
- `tasks` (id, title, description md, status enum todo|in_progress|blocked|done|cancelled, priority smallint 0–3, due_at?, completed_at?, tags text[], project_id?, sort_order, conversation_id?, run_id?, created_by enum user|agent). Indexes: (status, due_at); GIN(tags); (project_id); tsvector.
- `calendar_events` (id, title, description, location, start_at, end_at, all_day, start_date/end_date (all-day), tz, rrule?, task_id?, created_by, run_id?). Index (start_at), (end_at); recurring events are range-expanded in the service via dateutil.
- `event_exceptions` (event_id, original_start, is_cancelled, override jsonb)
- `reminders` (id, target_type enum event|task, target_id, occurrence_start?, remind_at, sent_at?, channel). Partial index (remind_at) WHERE sent_at IS NULL.

**Automations & notifications**
- `automations` (id, name, description, prompt, schedule jsonb {type: cron|interval|once, expr, tz}, enabled, profile_id, model_id?, toolset_override?, policy_id?, workspace_roots?, timeout_s, max_retries, on_ask enum pause_notify|deny_continue|fail, concurrency enum skip|queue, notify_destination_ids uuid[], output jsonb {type: notification|document|conversation|file, target}, state jsonb (key-value the agent can read/write via tool — enables "notify when changed"), next_run_at, last_run_at, last_status). Partial index (next_run_at) WHERE enabled.
- `notification_destinations` (id, type enum discord_webhook|ntfy|… , name, secret_id, config jsonb, enabled)
- `notifications` (id, title, body md, level, source_type, source_id, read_at?, created_at). Index (read_at NULLS FIRST, created_at DESC).
- `notification_deliveries` (outbox: notification_id, destination_id, status, attempts, last_error)

**MCP**
- `mcp_servers` (id, name, transport enum streamable_http|sse|stdio_hosted, url?, command?/args?/env_secret_id?, headers_secret_id?, enabled, status, last_error, last_connected_at)
- `mcp_tools` (id, server_id, name, description, input_schema jsonb, annotations jsonb, schema_hash, risk_override?, enabled). UNIQUE(server_id, name).

**Usage**
- `usage_records` (id, ts, provider_id, model_id, request_kind enum chat|agent|summarize|memory|embedding|automation|title, run_id?, conversation_id?, automation_id?, profile_id?, input_tokens, output_tokens, reasoning_tokens?, cached_tokens?, cost_usd numeric?, cost_source enum provider|estimated|unknown). Indexes (ts), (model_id, ts), (automation_id, ts). NULL means "unknown", never 0.

---

## F. Agent Runtime Design

**Runs are persisted, resumable state machines, not long-lived coroutines.** A worker holds a run only while it is actively executing.

```
queued ─► running ─┬─► completed
   ▲               ├─► failed ──(automation retry)──► queued
   │               ├─► cancelled
   │               ├─► waiting_approval ─(decision)─► queued
   │               ├─► paused ─(resume)─────────────► queued
   └──(lease lost)─┴─► interrupted ─(auto requeue once)─► queued
```

**Lifecycle (`runtime/runner.py`)**
1. **Claim**: JobRunner leases the job (60 s lease, heartbeat every 10 s) and loads the run and its checkpoint.
2. **Resolve**: ModelRouter picks the model and fallbacks. The *effective policy* is computed and **snapshotted onto the run** (policy edits mid-run apply only to new runs, except "run grants" and emergency deny, which is always honoured). Toolset = profile toolset ∩ policy-non-denied ∩ mode (chat mode only gets the memory tools).
3. **Context assembly (`ContextBuilder`)**: budgeted sections are system (profile instructions + skill index + permission summary + env facts), pinned memories, retrieved memories, optional workspace retrieval, compacted history, attachments and current plan. What went in is recorded in `context_manifest` ("why did it know that?").
4. **Plan (agent mode, optional)**: a structured-output call produces `{steps:[{id,title,detail,expected_capabilities}]}`. If `plan_approval` is `required` (or `dangerous_only` and a step expects a dangerous capability), the run moves to `waiting_approval` with plan edit/approve in the UI. During execution the agent updates step status via `plan.update`. User edits while paused create a new `plan_version` plus an injected note. The plan is an execution artifact, not chain-of-thought.
5. **Loop step**: stream model → emit `message.delta` / `reasoning.delta` → if tool calls, run each through **ToolExecutor** → append results → **checkpoint** (messages, tool_calls, plan, counters in one transaction) → check signals and limits → repeat. The run ends when the model returns no tool calls or a limit trips (limits yield a graceful "stopped: limit X" final message).
6. **Finalize**: persist the final assistant message, usage totals and result summary. Trigger memory extraction (debounced job), output destination (automations) and notifications.

**ToolExecutor (the only way a tool runs)**
`validate args (Pydantic; invalid → structured error back to model)` → `tool in run.toolset?` (else denied, logged) → `tool.describe_actions(args, ctx)` → list of `Action(capability, resource, risk, attrs)` computed by **deterministic code** (path resolution, shell classifier, URL host, MCP annotations) → `PolicyEngine.evaluate` → allow / ask (create `approvals` row, emit `approval.requested`, **suspend run**) / deny (structured "denied by policy: rule X" result to model) → execute with timeout + output caps → record `tool_calls` + `run_file_changes`. Tools *also* use guarded primitives (`WorkspaceFS`, `SandboxClient`, `SafeHTTP`) that re-check scope. That's defence in depth.

**Streaming**: every step emits typed events (section K). Token deltas go to Redis only; durable events go to both.

**Cancellation**: `POST /runs/{id}/cancel` sets `cancel_requested` in DB and PUBLISHes `run:{id}:control`. The worker's signal listener cancels the run's asyncio task. The model HTTP stream is closed. The sandbox exec is killed via `DELETE /exec/{id}` (SIGTERM → 5 s → SIGKILL on the process group). The browser session is closed. The in-flight tool call is marked `cancelled` and the run `cancelled`. If no worker holds the run (queued/paused/waiting), the API applies the cancellation directly in DB.

**Pause/Resume**: pause is honoured at the next safe boundary. The current model call finishes (no wasted tokens), no new tool calls start, the run checkpoints to `paused`, and the job is released. Resume re-enqueues and the worker rebuilds from checkpoint. `waiting_approval` uses the same suspend/resume path, so approvals can come hours later (from the UI or after a Discord ping) without tying up a worker.

**Retries**
- Provider: 429/5xx/timeouts use exponential backoff with jitter (3 tries), then fallback models from the router.
- Tool errors: returned to the model as structured `ToolError{code, message, retryable}`. Max 5 consecutive tool errors, then the run fails.
- Automations: whole-run retry up to `max_retries` with backoff.
- Crash recovery: an expired lease makes the job reclaimable, and the run resumes from its last checkpoint. A tool call that was `running` at crash time becomes `interrupted`. **Idempotent tools** (reads, search) are re-executed automatically. **Non-idempotent tools** (shell, writes, HTTP POST, MCP non-readOnly) are *not* re-run. The model receives "interrupted, outcome unknown", and in unattended runs re-execution requires policy `allow` again.

**Limits (`runtime/limits.py`)**: max_steps, max_tool_calls, max_runtime_s, max_cost_usd, max_tokens, max_consecutive_errors, per-tool timeout, output byte caps. They are set by profile/automation and clamped by the ceiling policy.

**Context overflow**: token estimation before each call. Past 75% of the window, older turns are compacted with the summarization model into a rolling summary. Large tool outputs are truncated to head+tail (e.g. 16 KB) with the full output saved as an artifact, readable via `tool_output.read(ref, range)`. A provider "context length" error triggers one forced compaction and a retry.

**Background & scheduled runs** use the identical runner. The only differences: `kind=automation`, the `on_ask` behaviour for unattended approval (default `pause_notify`), and the output destination.

**Sub-agents** (`agent.spawn`, off by default):
- The child run has `parent_run_id`, `root_run_id` and `depth+1`.
- Child effective policy = min(parent effective, child profile policy). A child can never exceed its parent.
- Budget (steps/cost/time) is carved out of the parent's remaining budget.
- Hard caps: depth ≤ settings (default 1, absolute max 3), ≤ 3 concurrent children per run, ≤ 10 descendants per root.
- The parent suspends (`waiting_subagent`, modelled as a checkpoint await) and resumes with the child's result as the tool result. Cancelling a parent cascades to descendants.

---

## G. Permission Architecture

**Capabilities** (hierarchical strings; the tool registry declares them):
`fs.read` `fs.write` `fs.delete` `shell.exec` `shell.network` `net.search` `net.fetch` `browser.use` `http.request` `docs.read` `docs.write` `docs.delete` `tasks.write` `calendar.write` `memory.read` `memory.write` `notify.send` `mcp.<server>.<tool>` `agent.spawn` `automation.state`. `settings.*` and `secrets.*` are **never grantable to agents** (hard floor).

**Risk** is computed per action by deterministic classifiers: `safe | moderate | dangerous`.
- Shell classifier (shlex/bashlex parse): read-only commands are safe; build/dev commands moderate. These are dangerous: `rm -r`, `git push --force`, `git reset --hard`, `chmod -R`, `dd`, pipes into `sh`/`bash`, `eval`, `$(…)` with unknown commands, and anything unparsable. The classifier can only *raise* risk.
- fs: delete, or overwrite outside run-created files, is moderate; recursive delete is dangerous.
- http: GET is safe, mutating methods moderate.
- MCP: `readOnlyHint` → safe, `destructiveHint` → dangerous, else moderate (user override per tool).

**Policy DSL** (Pydantic-validated JSON; presets compile into it):
```jsonc
{
  "name": "Coding Agent — Standard",
  "default": "ask",
  "rules": [
    {"cap": "fs.read",       "decision": "allow", "scope": {"roots": ["projects", "documents"]}, "else": "ask"},
    {"cap": "fs.write",      "decision": "allow", "scope": {"roots": ["projects"]}, "unless_risk": ["dangerous"], "else": "ask"},
    {"cap": "fs.delete",     "decision": "ask"},
    {"cap": "shell.exec",    "decision": "allow", "scope": {"cwd_roots": ["projects"]}, "unless_risk": ["dangerous"], "else": "ask"},
    {"cap": "shell.network", "decision": "ask"},
    {"cap": "net.search",    "decision": "allow"},
    {"cap": "net.fetch",     "decision": "allow", "unless_risk": ["dangerous"]},
    {"cap": "mcp.github.*",  "decision": "ask"},
    {"cap": "agent.spawn",   "decision": "deny"}
  ],
  "plan_approval": "dangerous_only",
  "limits": {"max_steps": 60, "max_runtime_s": 1800, "max_cost_usd": 2.0, "max_subagent_depth": 0}
}
```

A second example, the "Morning News" automation policy (unattended, read-only research):
```jsonc
{ "name": "Research — Unattended", "default": "deny",
  "rules": [ {"cap": "net.search", "decision": "allow"}, {"cap": "net.fetch", "decision": "allow", "unless_risk": ["dangerous"]},
             {"cap": "docs.write", "decision": "allow", "scope": {"roots": ["documents/briefings"]}},
             {"cap": "notify.send", "decision": "allow"} ],
  "limits": {"max_steps": 30, "max_cost_usd": 0.5} }
```

**UI levels → rules** (per category dropdown; an "Advanced" JSON editor for per-tool rules):

| Level | Compiles to |
|---|---|
| Deny | `decision: deny` |
| Always ask | `decision: ask` |
| Ask for dangerous | `allow` unless risk=dangerous → `ask` |
| Allowed in workspace | `allow` if resource ∈ policy scope (roots/cwd) and risk≠dangerous, else `ask` |
| Fully autonomous | `allow` (still bounded by ceiling, hard floor and limits) |

**Evaluation (`policy/engine.py`, pure function)**
`evaluate(action, policies: list[Policy], grants: list[Grant]) -> Decision(result, rule_ref, reason)`
1. **Hard floor** (code, not data): path outside allowed roots → deny. `settings.*`/`secrets.*` → deny. Sub-agent depth over absolute max → deny. Tool not in toolset → deny.
2. Evaluate each layer: **ceiling** (global max autonomy, e.g. "fs.delete never better than ask"), **selected policy** (profile/automation/run), **parent policy** (sub-agents). Within a layer the most specific matching rule wins (exact tool > wildcard > category > default).
3. Combine layers with **most restrictive wins** (deny > ask > allow).
4. If the result is `ask`, check **run grants** ("allow for this run" approvals matching capability + resource pattern). A grant can turn `ask` into `allow` but **never overrides deny or the ceiling**.
5. Unattended runs: `ask` becomes the automation's `on_ask` (pause_notify / deny / fail).

**Approval UX**: Approve once · Approve for this run (creates a scoped grant, e.g. `shell.exec` in `projects/foo`) · Deny (optional reason passed to the model) · "Always allow…" opens the policy editor pre-filled. It is a deliberate user settings change, never done by the agent.

**Permission summary** (`policy/summary.py` + `POST /api/policies/preview`): given profile + policy + roots + toolset, it returns grouped plain-language lines (*Can do without asking / Will ask first / Cannot do / Limits*). It also warns about skills whose `required_capabilities` are denied. It is shown on the chat header chip (agent mode), the run start dialog and the automation editor.

---

## H. Memory Architecture

The distinct stores are:
- **Explicit personal memory**: `memories` rows. The user owns them and they're visible in the UI.
- **Semantic retrieval**: `knowledge_chunks` for memories, documents, files and conversation/run *summaries*.
- **Conversation history**: `messages` with Postgres FTS; not vector-indexed per message.
- **Workspace knowledge**: document and file chunks.

- **Identify**
  - (a) Explicit: in chat *and* agent mode the model has memory tools: `memory.remember`, `memory.update`, `memory.forget`, `memory.search`, `memory.list`. "Remember I prefer TypeScript" becomes a tool call under `memory.write` policy (default: allow with visible toast + undo).
  - (b) Implicit: a debounced `memory.extract` job runs after the conversation is idle for 2 minutes or after N turns. It uses the memory model with structured output. For each candidate it retrieves similar existing memories and decides **ADD / UPDATE(id) / SUPERSEDE(id) / NOOP**. The rules are "durable, user-specific, likely useful later", and it never stores secrets or credentials (regex scrubber too).
  - Extracted memories are `active` or `pending` (review queue), per the Memory settings "auto-save vs. suggest".
- **Store/embed**: row in `memories` plus a chunk in `knowledge_chunks` (embedding model from defaults). On edit, re-embed. On supersede, the old memory is archived with `superseded_by`.
- **Retrieve** (ContextBuilder, per turn)
  - Query = last user message + short rolling summary, used for hybrid search (vector cosine + FTS, reciprocal-rank fusion) over `source_type=memory`.
  - Similarity threshold (default 0.35 distance gate) and top-k ≤ 8.
  - Score = sim × (0.5 + importance) × recency decay.
  - Plus **pinned/profile memories** always included under a small token budget (~400).
  - `last_used_at`/`use_count` are updated. If nothing passes the threshold, nothing is injected.
- **Update/delete**: via UI (direct CRUD), via tools (policy-gated, audit-logged), or conversationally ("forget what you know about my old project" → `memory.search` then `memory.forget` of the matched ids, with an ask-confirmation when >3 items). Deletion is a hard delete of the memory row and its chunks.
- **Settings**: extraction on/off, auto vs suggest, extraction model, max memories injected, retention (archive unused after N days, optional).

---

## I. Provider Architecture

```python
class ProviderAdapter(Protocol):
    async def stream_chat(self, req: ChatRequest) -> AsyncIterator[ProviderEvent]
    async def embed(self, req: EmbedRequest) -> EmbedResult
    async def list_models(self) -> list[DiscoveredModel]
    async def test(self) -> TestResult
```
- **Canonical types**: `ChatRequest` (model_key, system, messages of content blocks `text|image|file|tool_use|tool_result|reasoning`, tools as JSON Schema, tool_choice, response_format, reasoning effort/budget, max_tokens). `ProviderEvent` is `TextDelta | ReasoningDelta | ToolCallDelta | ToolCallDone | Usage(input, output, reasoning, cached, cost?) | Done(stop_reason) | Error`.
- **Adapters**
  - `openai_responses` (OpenAI native; reasoning summaries).
  - `openai_chat` (Chat Completions): OpenAI-compatible, Ollama, vLLM, LM Studio, llama.cpp, and **OpenRouter** as a subtype that adds attribution headers, `usage.include` for provider-reported cost, and `reasoning` fields.
  - `anthropic` (Messages; thinking blocks; prompt caching of system + tools).
  - `fake` (scripted; tests/E2E only, enabled by env flag).
- Tool-call JSON is repaired (one lenient parse); on failure the invalid call goes back to the model as an error, never executed.
- **Attachments**: a normalization layer maps each attachment kind to the model's capabilities.
  - Image → native if vision, else refuse with a clear message.
  - PDF → native if `pdf`, else extracted text (pypdf; OCR deferred until actually needed).
  - Text/code/CSV/JSON → inlined text (truncated with notice).
  - Other → stored and referenced; not sent.
- **Model catalog**: `list_models()` discovery + bundled `catalog.json` (capability/pricing defaults for well-known models) + OpenRouter's model metadata. The user can override capabilities, context window and pricing per model. There's a "Test" button per provider (auth + tiny completion) and per model (capability probe: tools, vision).
- **Routing (`providers/router.py`)**: `resolve(task_type, ctx) -> RoutePlan(primary, fallbacks)`.
  - Chain: explicit per-request model → automation override → profile default → `model_defaults[task_type]` → error.
  - Then **capability filter**: required caps from the request (tools for agent, vision for image attachments, embeddings…). An unsatisfied primary falls through to capable fallbacks, or returns a clear error naming the missing capability.
  - Implemented as an ordered list of `RoutingRule` objects so future rules (cost ceiling, complexity classifier, provider health) plug in without rewrites.
  - Provider health is tracked in Redis (circuit breaker: 3 consecutive failures → skip for 60 s).
- **Usage**: every provider call writes `usage_records`. Cost comes from the provider when reported (OpenRouter), else it's estimated from model pricing (`cost_source=estimated`), else NULL (`unknown`).

---

## J. Frontend Architecture

**Navigation** (chat-centric, shallow):
```
Sidebar:  [+ New chat]  [Search ⌘K]
          Chats (pinned, recent; infinite list)
          ─ Workspace: Files · Documents · Tasks · Calendar
          ─ Agents: Runs (badge: active/awaiting) · Automations · Profiles & Skills
          ─ Memory
          footer: Notifications bell · Settings · theme toggle
```
Settings is a full-page route with a left sub-nav: General, Appearance, Providers & Models, Agent Permissions🛡, Workspace🛡, Search, MCP🛡, Notifications, Memory, Automations, Usage, Advanced🛡. 🛡 means a security-sensitive section: a shield badge, changes require recent re-auth, and changes are audit-logged.

**Key screens**
- **Chat**: header has a **mode segmented control [Chat | Agent]**, profile picker, model picker and (agent) **permission-summary chip**. The message list has markdown, code blocks with copy and an attachment preview. The composer has drag-drop, paste images, and send/stop. An agent turn renders an inline **RunCard**: Plan panel (step statuses), Activity timeline (tool cards with collapsible shell output, diffs for file writes, screenshots for browser), Reasoning section (collapsed, only provider-exposed reasoning), inline **ApprovalCard**, and Final response. Pause/Resume/Cancel controls. An optional right-hand **Run Inspector** drawer.
- **Runs**: filterable table (status, profile, automation, date). Run detail reuses RunCard components plus tabs for Tool calls, Files changed (with revert), Usage and Context manifest.
- **Automations**: list with next run/last status; editor with schedule builder (cron presets + "next 5 runs" preview), profile/model/tools, permission summary, on-ask behaviour, outputs, destinations; history.
- **Files**: two-pane (tree + listing), breadcrumbs, upload by drag-drop, rename/move/delete (to trash), preview (image/pdf/text), CodeMirror editor with save conflict detection.
- **Documents**: tree + TipTap editor (toolbar, slash-menu-lite, tables, code blocks, links, image drop into `_assets/`), autosave (debounced, base-hash conflict), revisions sidebar, "Ask AI about this doc".
- **Tasks**: List / Board (by status) / Today-Upcoming views, sortable, quick-add, filters (project, tag, priority).
- **Calendar**: FullCalendar month/week/day, event dialog (all-day, recurrence presets, reminders, linked task).
- **Memory**: list with kind/category filters, search, pending-review queue, inline edit, delete, source link.
- **Search**: command palette (⌘K) for quick jumps plus a full results page with type filters.

**State boundaries**
- Server state is TanStack Query only, with query keys per feature in `features/x/api.ts`.
- Client state:
  - `useUiStore` (sidebar, panels)
  - `useThemeStore` (mirrors settings)
  - `useRunStreamStore`: a map runId → reduced live state, fed by `useRunStream(runId)`, which loads the snapshot, opens SSE, and applies events through a **pure reducer** (`runReducer.ts`, unit-tested).
- A global `useAppEvents()` holds one SSE to `/api/events` (notifications, run status, approvals badge) and invalidates queries.
- **No authorization logic in the UI.** The UI only displays decisions from the server.

**Theming (Tailwind v4 + CSS variables)**:
- `tokens.css` defines the raw semantic variables for light mode (`:root`) and dark mode (`[data-theme=dark]`): `--bg, --surface, --surface-2, --card, --text, --text-muted, --border, --accent, --accent-hover, --accent-contrast, --selection, --success, --warning, --error, --tool-running, --tool-ok, --tool-denied`.
- `app.css` uses `@theme` to reset Tailwind's default palette (`--color-*: initial`) and map the tokens to utilities, e.g. `--color-accent: var(--accent)`, `--color-surface: var(--surface)`, plus `--radius-*`, `--shadow-*`, `--font-*`. Components then write `bg-surface text-muted rounded-card shadow-soft hover:bg-accent-hover`.
- `--accent` is set at runtime on `<html>` from Settings. Derived values use `color-mix(in oklch, var(--accent) …)`, so one color drives hover/selection/ring states.
- Repeated patterns (Button variants, Card) live in `components/ui`, not scattered class strings. Long class lists stay readable with `cn()`. System mode uses `prefers-color-scheme`. Appearance is saved server-side and cached in localStorage to avoid a flash. The HyperOS-like look: generous spacing, 14–20 px radii, soft layered shadows, translucent surfaces for overlays, 150–200 ms ease transitions, strong type hierarchy, and a restrained palette where the accent is used sparingly. Density setting: comfortable/compact (spacing scale swap).

**Conventions**:
- Components ≤ ~200 lines.
- Each feature exposes `pages/`, `components/`, `hooks/`, `api.ts`.
- A shared `components/ui` kit.
- No barrel-file magic.
- Comments on non-obvious flows (SSE reducer, reconnect).

**Mobile & installable app** (a homelab assistant is often used from a phone):
- **Mobile-first rule**: every screen must work at phone width (375 px) before its phase counts as done. Tailwind's default breakpoints are used: the unprefixed classes are the phone layout, and `md:` (≥768 px) and `lg:` (≥1024 px) add the desktop layout.
- **Navigation**: below `md` the sidebar becomes an off-canvas drawer (Radix Dialog: focus trap, Esc/scrim closes it, and it closes itself after navigating), opened from a menu button in a slim top bar. From `md` up it is the fixed sidebar.
- **Chat**: full-width messages. The composer is pinned to the bottom and stays above the on-screen keyboard (`100dvh` layout, `env(safe-area-inset-bottom)` padding). The header collapses the mode, model and permission controls into a compact row or menu. Code blocks and tables scroll horizontally inside themselves, never the page.
- **Agent UI**: the approval card, activity list and Revert buttons get touch-sized targets (≥44 px). The run inspector becomes a full-screen sheet.
- **Files**: one pane at a time on phones (browse → open file, with a back button). Hover-only actions (rename, delete) are always visible or live in a "⋯" menu. Uploads use the native file picker, which also offers the camera.
- **Settings**: the sub-navigation becomes a list page that leads into each section, and multi-column forms stack.
- **Dialogs** become bottom sheets or full-screen on phones.
- **Inputs**: font-size ≥16 px on phones, so iOS doesn't zoom in on focus. `viewport-fit=cover` plus safe-area insets for notched phones.
- **Installable (PWA)**: a web app manifest (name "anemo", icons, `display: standalone`, theme colour following the appearance setting) and a minimal service worker. The service worker caches only the app shell (built JS/CSS/icons). It **never caches `/api`** responses or event streams, so there is no stale or private data offline, and it shows a simple "offline" page when the server is unreachable. Add-to-home-screen then opens anemo full-screen without browser bars. Installing requires HTTPS, which NPM provides. On plain-HTTP LAN access it stays a normal website.
- **Push notifications** to the phone remain in Phase 12 (Discord/ntfy first; Web Push is deferred, see S).

---

## K. Streaming / Event Architecture

- **Per-run stream**: `GET /api/runs/{id}/events` (SSE).
  1. The client first fetches `GET /api/runs/{id}` (a snapshot built from DB: messages, tool calls, plan, approvals, status, `last_event_id`).
  2. The client opens SSE with `Last-Event-ID`.
  3. The gateway `XREAD BLOCK`s the Redis stream `run:{id}` from that ID and emits `id: <redis-id>`.
  4. If the stream is trimmed or expired, the snapshot is authoritative: send a `snapshot.required` event and the client refetches.
  5. Heartbeat comment every 15 s (keeps NPM/proxies from timing out).
  6. The stream closes after a terminal status.
  7. Redis streams are `MAXLEN ~ 5000` with a 24 h TTL after completion.
- **Global stream**: `GET /api/events`, for notifications, run status changes, approval requests, automation fired, and memory pending.
- **Envelope**: `{id, run_id, seq, ts, type, data}`.
- **Types**: `run.status`, `run.plan`, `plan.step`, `message.delta`, `message.completed`, `reasoning.delta`, `reasoning.completed`, `tool.started`, `tool.progress` (e.g. shell stdout chunks, throttled to about 10/s), `tool.completed`, `approval.requested`, `approval.resolved`, `file.changed`, `browser.screenshot`, `usage`, `error`, `subrun.started`, `subrun.completed`.
- Reasoning is **only** what the provider exposes (Anthropic thinking, OpenAI reasoning summaries, OpenRouter reasoning). Otherwise the UI shows the tool/plan progress timeline, which is factual execution data. Nothing is fabricated.
- Commands are REST: pause, resume, cancel, approve and edit plan are POST/PUT and return the new state. The events confirm them.

---

## L. Background Jobs & Scheduling

- **Queue**: the `jobs` table.
  - Claim with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`.
  - LISTEN `jobs_new` for instant wakeup, plus a 5 s poll fallback.
  - Lanes: `interactive` (chat/agent turns, reserved slots) vs `background` (automations, extraction, indexing), so automations never starve chat.
  - Worker concurrency `WORKER_CONCURRENCY` (default 4) with 2 interactive-reserved.
- **Leases**: heartbeat extends `lease_expires_at`. A reaper (in the scheduler leader) requeues expired leases and marks their runs `interrupted` → `queued` (once; a second crash sets `failed` with an explanation).
- **Job types**: `run.execute`, `memory.extract`, `knowledge.index`, `notify.deliver`, `reminder.fire`, `workspace.scan`, `maintenance.*` (prune revisions, trash, backups, redis streams, HNSW index).
- **Scheduler** (leader via `pg_try_advisory_lock`, 15 s tick):
  - `SELECT automations WHERE enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED`.
  - One transaction: create run + job (`dedupe_key = automation_id:scheduled_ts`) and advance `next_run_at` via croniter in the automation's timezone.
  - **Misfire policy**: if downtime made several fires due, run **once** if within grace (default 1 h), else skip and log "missed".
  - Concurrency `skip` means no new run while one is active.
  - Reminders and maintenance run in the same loop.
- **Restart survival**: all timing and execution state is in Postgres (`next_run_at`, runs, checkpoints, jobs, approvals). Redis holds only ephemeral streams and signals and can be wiped safely.

---

## M. Security Model

- **Sandboxing**
  - Model-driven code only executes in `sandbox`/`sandbox-net`: non-root user (PUID/PGID), `cap_drop: [ALL]`, `no-new-privileges`, `read_only: true` rootfs with tmpfs `/tmp` and a writable `/home/agent` volume (tool caches), `pids_limit`, `mem_limit`, `cpus`.
  - Only `/workspace` is mounted. No docker.sock, no host network, no secrets in env except the execd token.
  - `sandbox` sits on an `internal: true` network (no egress; only the worker can reach it). `sandbox-net` has egress but still no route to Postgres/Redis (separate networks).
  - Host-level execution is **not provided**. If ever added, it would be an explicitly-labelled advanced opt-in with its own documented threat model.
- **Filesystem**
  - `WorkspaceFS` resolves paths as `realpath(root / rel)` and requires `commonpath` = root. It rejects NUL bytes, absolute paths, `..` escapes and symlinks pointing outside, and re-checks after open (`O_NOFOLLOW` on final component).
  - Per-root `agent_access` is enforced in fs tools.
  - Size caps: read 2 MB to the model, upload 200 MB default, write 10 MB via tool.
  - Delete moves to `.trash/` (retained 30 d). Overwrites and deletes by agents are backed up to `/data/run-backups` for revert.
  - **Tradeoff**: shell commands see the whole sandbox mount. Directories agents must never touch via shell should not be under the workspace mount (see S).
- **Shell**: policy + classifier + cwd scope + infrastructure isolation. Timeouts (default 120 s, max per policy), output caps (stdout/stderr 1 MB stored, 16 KB head+tail to model), process-group kill.
- **Browser**: separate container; ephemeral contexts per session; downloads confined to a per-session dir; Playwright request interception blocks private/link-local/metadata IP ranges unless allowlisted. Stored login sessions (future `browser_profiles`) are an explicit, per-profile policy-gated capability and are never automatic.
- **Network / SSRF**: `SafeHTTP` for `net.fetch`/`http.request` resolves DNS and blocks RFC1918/loopback/link-local/CGNAT/`169.254.169.254`/IPv6 ULA unless a host is on the Settings allowlist (a 🛡 setting), and re-checks on redirects. SearXNG, provider base URLs and MCP URLs are user-configured, so they're exempt.
- **Secrets**: encrypted at rest; never serialised to API responses, logs, run events, tool args or model context. A log/event redaction filter handles known secret values and common token patterns. MCP server env is injected only into mcp-host processes.
- **MCP**: remote servers are called from the worker with user-configured headers. stdio servers run only in `mcp-host` (no DB/Redis network access). Every MCP tool is a registry tool with capability `mcp.<server>.<tool>`, policy-gated. Tool descriptions are treated as untrusted text. A schema-hash change on refresh resets that tool to "ask" until reviewed.
- **Auth**: argon2 hash; sessions (30 d sliding, revocable list in Settings); cookie HttpOnly/Secure (configurable for plain-HTTP LAN)/SameSite=Lax; Origin/Referer check on non-GET; login rate-limit (5/min/IP); re-auth for 🛡 changes; `TRUSTED_PROXIES` for correct client IP behind NPM.
- **Prompt injection**: tool results from web/browser/MCP/files are wrapped as untrusted data in context. The real protection is that **no model output can authorize anything**: approvals come only from the authenticated user via REST, and the agent has no tool that edits policies, settings, secrets or destinations.
- **Dangerous operations** in the UI: confirmation dialogs with explicit wording for bulk deletes, policy upgrades to "Fully autonomous", and enabling `agent.spawn`/`shell.network`.
- **Audit log**: logins, settings/policy/secret changes, approvals, denials, agent file deletes, MCP/tool changes.

---

## N. Docker / Homelab Architecture

| Service | Image | Networks | Ports | Notes |
|---|---|---|---|---|
| `migrate` | backend | core | – | `alembic upgrade head`; one-shot; `app`/`worker` depend on `service_completed_successfully` |
| `app` | backend | core, proxy(opt) | `${APP_PORT:-8080}` (bind addr configurable) | API + SPA; health `/api/health` |
| `worker` | backend | core, sandbox_int, egress | – | runtime + scheduler; health via `cli worker-health` (Redis heartbeat freshness); scalable |
| `postgres` | pgvector/pgvector:pg17 | core | – | volume `pgdata`; `pg_isready` health |
| `valkey` | valkey/valkey:8-alpine | core | – | small AOF volume (optional) |
| `sandbox` | sandbox | sandbox_int (internal) | – | `/workspace` bind; hardened |
| `sandbox-net` | sandbox | sandbox_int, egress | – | same, with egress |
| `browser` | browser | sandbox_int, egress | – | Compose profile `browser` |
| `mcp-host` | mcp-host | sandbox_int, egress | – | Compose profile `mcp` |

- **Volumes**: `pgdata`, `valkey-data`, `appdata` (`/data`: uploads, tool outputs, run backups, screenshots), `sandbox-home`, and bind `${WORKSPACE_PATH:-/srv/ai-workspace}` → `/workspace` (app, worker, sandbox\*). Owned by `PUID:PGID` so files created by agents belong to the host user.
- **Policies**: `restart: unless-stopped` everywhere. Healthchecks with `depends_on: condition: service_healthy`.
- **External (user-provided)**: Nginx Proxy Manager, which proxies to `app:8080`. Either publish the port on LAN, or attach `app` to NPM's external network via the override file. The README gives the NPM snippet: websockets not needed, `proxy_buffering off` recommended though `X-Accel-Buffering` handles it, `proxy_read_timeout 1h`. SearXNG is reached by URL (Settings/`SEARXNG_URL`); JSON format must be enabled in SearXNG's `settings.yml` (the "Test" button checks this). LLM providers and local model servers are reached by URL. Discord webhooks.
- **`.env.example`**: `APP_SECRET_KEY` (generated instruction), `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `POSTGRES_PASSWORD`, `WORKSPACE_PATH`, `PUID/PGID`, `APP_PORT`, `APP_BIND`, `PUBLIC_URL`, `TZ`, `COOKIE_SECURE`, `TRUSTED_PROXIES`, `SEARXNG_URL` (optional), `WORKER_CONCURRENCY`, `SANDBOX_TOKEN`/`BROWSER_TOKEN`/`MCP_HOST_TOKEN` (auto-generated by a first-run init if blank).
- **Workflows**
  - Prod: `cp .env.example .env && docker compose up -d`, then the web first-run wizard (add provider → pick default models → workspace roots → optional SearXNG).
  - Dev: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`: uvicorn reload, Vite dev server with `/api` proxy, source mounts.
  - `make` targets: `dev`, `test`, `lint`, `gen-api`, `migrate`, `backup`.
- **Backup**: documented `pg_dump` + `appdata` + workspace; `scripts/backup.sh`.

---

## O. API Surface (all under `/api`, JSON, typed via OpenAPI)

- **Auth**: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/reauth`, `GET/DELETE /auth/sessions`
- **Settings**: `GET /settings`, `PATCH /settings/{section}`, `GET /setup/status` (first-run)
- **Providers/Models**: `CRUD /providers`, `POST /providers/{id}/test`, `POST /providers/{id}/discover`, `CRUD /models`, `POST /models/{id}/test`, `GET/PUT /model-defaults`
- **Conversations**: `CRUD /conversations`, `GET /conversations/{id}/messages?cursor`, `POST /conversations/{id}/turns` → `{run_id, user_message_id}`, `POST /conversations/{id}/regenerate`
- **Attachments**: `POST /attachments` (multipart) → `{id, kind, supported_by_model}`, `GET /attachments/{id}`
- **Runs**: `GET /runs?filters`, `POST /runs` (standalone agent run), `GET /runs/{id}` (snapshot), `GET /runs/{id}/events` (SSE), `POST /runs/{id}/pause|resume|cancel`, `PUT /runs/{id}/plan`, `GET /runs/{id}/tool-calls`, `GET /runs/{id}/files`, `POST /runs/{id}/files/{change_id}/revert`, `GET /runs/{id}/outputs/{ref}`
- **Approvals**: `GET /approvals?status=pending`, `POST /approvals/{id}` `{decision, scope, reason?}`
- **Global events**: `GET /events` (SSE)
- **Agents**: `CRUD /profiles`, `CRUD /skills`, `POST /skills/import`, `GET /skills/{id}/export`, `GET /tools` (registry catalog with capabilities), `CRUD /policies`, `POST /policies/preview` (permission summary), `GET /capabilities`
- **Automations**: `CRUD /automations`, `POST /automations/{id}/run-now`, `GET /automations/{id}/runs`, `POST /automations/schedule-preview`
- **Workspace/files**: `CRUD /workspace/roots`, `GET /files?root&path`, `GET /files/content`, `PUT /files/content` (base_hash), `POST /files/upload`, `GET /files/download`, `POST /files/move`, `POST /files/mkdir`, `DELETE /files` (→ trash), `GET /files/search`, `GET/POST /files/trash`
- **Documents**: `GET /documents` (tree), `POST /documents`, `GET/PUT /documents/{id}` (base_hash), `POST /documents/{id}/move`, `DELETE /documents/{id}`, `GET /documents/{id}/revisions`, `POST /documents/{id}/revisions/{rid}/restore`, `POST /documents/assets`
- **Tasks/Calendar**: `CRUD /projects`, `CRUD /tasks`, `POST /tasks/reorder`, `GET /calendar/events?start&end` (expanded occurrences), `CRUD /calendar/events`, `PUT /calendar/events/{id}/occurrences/{start}`
- **Memory**: `CRUD /memories`, `GET /memories?q&kind&status`, `POST /memories/{id}/approve`, `GET /memories/export`
- **Search**: `GET /search?q&types&mode=hybrid|keyword`
- **Notifications**: `GET /notifications`, `POST /notifications/read`, `CRUD /notification-destinations`, `POST /notification-destinations/{id}/test`
- **MCP**: `CRUD /mcp/servers`, `POST /mcp/servers/{id}/refresh`, `GET /mcp/servers/{id}/tools`, `PATCH /mcp/tools/{id}`
- **Usage**: `GET /usage/records`, `GET /usage/summary?group_by=day|model|provider|kind|profile|automation&from&to`
- **Ops**: `GET /health`, `GET /ready`, `GET /audit`, `GET /search-providers/test`

**Errors**: a uniform `{error: {code, message, details?}}` with stable codes (`policy_denied`, `conflict_base_hash`, `capability_missing`, …).

---

## P. Implementation Phases

Each phase ends with a green test suite, a working `docker compose up`, and a demoable feature. **From phase 5b on, every new or changed screen must also work at phone width (375 px)** (see J, "Mobile & installable app").

0. **Foundation**: git init, repo skeleton, `.gitattributes`, backend app factory, config, logging, uuid7, Alembic baseline, Compose (migrate/app/worker/postgres/valkey) with health checks, frontend Vite shell, Tailwind v4 + `tokens.css` + light/dark/system + accent, UI kit basics, CI (ruff, mypy, pytest, eslint, tsc, vitest), OpenAPI→TS generation.
1. **Auth, settings, secrets**: login page, sessions, re-auth, settings framework + Appearance/General pages, encrypted secrets, audit log, first-run wizard skeleton.
2. **Providers & models**: adapters (openai_chat, openai_responses, anthropic, fake), discovery, catalog, test buttons, model defaults, router with capability filter + fallbacks, usage recording.
3. **Jobs, runs, streaming, chat**: jobs queue + worker + leases, runs table, event publisher, SSE gateway with reconnect, conversations/messages, chat mode end-to-end (streaming, reasoning display, markdown/code, stop = cancel), titles, conversation FTS, basic text/image attachments with capability check. **← First milestone**
4. **Policy engine + tool framework + approvals**: pure engine with exhaustive tests, presets, DSL validation, ceiling, grants, permission summary; ToolExecutor; approvals suspend/resume; Agent Permissions settings UI; mode switch with Agent mode, initially with harmless tools (`plan.update`, `workspace.list`).
5. **Workspace & files**: roots, WorkspaceFS guard, file manager UI, fs tools (read/write/edit/move/delete→trash), `run_file_changes` + revert, watcher/scan.
5b. **Mobile & installable app** (inserted before phase 6, while there are few screens): responsive app shell (drawer sidebar + top bar below `md`), mobile chat (keyboard-safe composer, compact header, scrollable code/tables), touch-sized agent UI (approvals, activity, revert), one-pane Files on phones, stacked Settings, dialogs as sheets, safe-area/viewport fixes; PWA manifest + icons + app-shell-only service worker; Playwright checks at phone size.
6. **Sandbox & shell**: execd, sandbox/sandbox-net, shell classifier, `shell.exec` tool with streaming output, timeouts/kill, shell history UI.
7. **Agent runtime completion**: plans (+approval/edit), pause/resume/cancel hardening, crash recovery/interrupted semantics, limits, compaction, tool output artifacts, profiles, skills (+`load_skill`), Runs history UI. *Done.* As built: plan review is `off | always` (global setting, profile override); the agent proposes via `update_plan`, the call becomes a `plan` approval that the user can edit, and other tools are refused until a plan is approved (changed step titles are reviewed again). Pause is a DB flag honoured before each model call and each tool call; resume re-queues with optional user notes injected after the latest tool results; plans can be edited while paused. Profiles override permission levels, limits and plan review (ceiling still applies; permission changes need re-auth) and choose skills (`all | selected | none`); runs snapshot profile, skills and system prompt. Limits add `max_cost_usd` and `max_consecutive_errors`; working time is summed across worker segments; hitting a limit (except cost) triggers one tool-less wrap-up answer. Compaction summarizes the transcript before an assistant message when it passes 75 % of the budget (and once more on a provider context-length error). Tool results over 16k characters are clipped to head + tail and saved under `DATA_PATH/tool-outputs/`, readable with `read_tool_output`. Duplicate `run.execute` jobs are ignored while another worker holds a live lease.
8. **Web**: SearXNG provider + settings test, `net.fetch` with SSRF guard, `http.request`. *Done.* As built: tools `web_search` (offered only when a SearXNG URL is set), `read_web_page` (trafilatura → Markdown; PDF/text/JSON; paged with `start`) and `http_request`. `app/web/safe_http.py` plugs a guarded httpcore network backend into httpx: every connection (redirects included) resolves the host, requires every answer to be a global address unless allowlisted (host names, IPs, CIDRs in the sensitive `web` settings section), then connects to the checked IP (no DNS rebinding); TLS still verifies the original host name. Literal private hosts are blocked already at the policy step (allowlisted ones are rated moderate). Web settings are snapshotted per run like permissions.
9. **Memory & knowledge index**: embeddings, `knowledge_chunks`, memory tools (chat + agent), extraction job, retrieval in ContextBuilder, Memory UI + pending queue. *Done.* As built: adapters gained `embed()`; `knowledge_chunks` (untyped pgvector column + `model_key`, tsvector) with hybrid search in `app/knowledge/index.py` (vector + OR keyword query, reciprocal rank fusion; keyword-only when no embedding model). `memories` are indexed there; tools `remember`, `update_memory`, `forget_memory`, `search_memory`. Chat turns run through the agent loop with only the memory tools they may use without approval (when the chat model supports tools; otherwise one plain call), so explicit memory works in chat. Per run, pinned memories, instructions and relevant ones (rescored by importance and recency) are added to the system prompt and recorded on the run. `memory.extract` jobs run 2 minutes after an answer (skipped if the conversation went on) and add suggestions (`pending`, corrections carry `replaces_id`) or active memories per the `memory` settings; a regex scrubber refuses secrets.
10. **Documents**: file-backed documents, TipTap editor with markdown round-trip, autosave/conflicts, revisions, doc tools, indexing; PDF extraction for attachments reuses this parsing. *Done.* As built: documents are `.md` files under `documents/` in the workspace (no separate roots table); the `documents` table is an index (id, path, title, hash, size/mtime) reconciled with the folder whenever documents are listed or opened (new files, deletions, renames matched by content hash, outside changes get an `external` revision). `document_revisions` keep full text, coalescing same-author saves within 10 minutes, max 50 per document. Saves carry `base_hash` (409 `conflict_base_hash`). The editor is TipTap v3 with `@tiptap/markdown` (round-trip covered by tests; documents with raw HTML or footnotes open in the CodeMirror source view); image paths are stored relative to the document and mapped to download URLs in the editor. Agent tools: `list_documents`, `read_document`, `search_documents` (fs.read) and `write_document`, `edit_document` (docs.write), recorded as revisions and as revertible file changes. `document.index` jobs chunk by headings/paragraphs into `knowledge_chunks`. PDF text extraction for attachments already existed from phase 4.
11. **Tasks & Calendar**: CRUD, views, recurrence expansion, reminders, tools. *Done.* As built: `tasks` use `due_date` + optional `due_time` (wall-clock in the user's time zone) instead of one instant, tags as JSONB, `sort_order` per status for the board (`POST /tasks/reorder`). `calendar_events` store instants plus `tz`; all-day events are local midnights; `rrule` (RFC 5545, FREQ daily..yearly) is expanded with dateutil in local wall time (`features/calendar/recurrence.py`), `repeat_until` lets range queries skip finished series; `event_exceptions` cancel or override single occurrences (`PUT /calendar/events/{id}/occurrences/{original_start}`). Reminders are `remind_minutes` on the event or task; a 30 s scheduler loop in the worker (`jobs/scheduler.py`) claims each due reminder with a unique `reminders` row (safe with several workers, no leader needed) and publishes a global `reminder` event, shown as an in-app notice until phase 12 adds notifications. The UI uses FullCalendar 6 (month/week/day/agenda), with tasks overlaid on their due dates. Agent tools: `list/create/update/delete_task` and `list/create/update/delete_event`; reading is always allowed, deleting is rated dangerous. The agent prompt now states the user's local time and zone.
12. **Notifications + Automations**: in-app + browser notifications, Discord destination + outbox; scheduler, automations UI, `on_ask`, output destinations, automation state tool, retries. *Done.* As built: `notifications.create()` is the one way to notify: it stores the row, publishes a global `notification` event, and adds one `notification_deliveries` row plus a `notify.deliver` job per destination (sent with retries; 404 is not retried). Destinations are Discord webhooks (URL stored as an encrypted secret, changes need re-auth) with a list of the kinds they receive (`reminder`, `automation`, `approval`, `agent`); messages are sent with `allowed_mentions: {parse: []}`. Browser notifications are a per-browser setting in localStorage, shown only while a tab is open (Web Push is still deferred). Reminders now create notifications. Automations (`features/automations/`): the schedule is `{kind: cron|interval|once, tz}` (cron via `cronsim`, at most every 5 minutes); `fire_due()` runs in the worker's 30 s scheduler loop and claims due rows with `FOR UPDATE SKIP LOCKED` while advancing `next_run_at` in the same transaction (no leader lock needed). Misfires older than 1 h are skipped (`missed`), and a still-active run blocks the next (`skipped`). A firing creates a hidden conversation (`conversations.automation_id`) and an ordinary `kind=agent` run with `runs.automation_id` (instead of a separate run kind), in the background lane. `on_ask` is `pause` (waiting_approval + an `approval` notification), `deny` (the call is refused, the run continues) or `fail`; plan review is off for automations. Output: the final answer as a notification (`notify`: always | on_failure | never, optional per-automation destinations) and optionally saved to a document path with `{date}`/`{time}`. `get/set_automation_state` tools keep notes in `automations.state`. Failed runs are retried by an `automation.retry` job with backoff (not for `on_ask=fail` stops). There is no per-automation policy or toolset override: the profile decides.
13. **MCP**: remote servers, mcp-host for stdio, discovery UI, registry integration, per-tool policy. *Done.* As built: the official `mcp` SDK (v2) is the client (`app/mcp/client.py`); every list/call opens a fresh connection (no sessions to keep alive across pauses). Remote servers use Streamable HTTP or SSE with user-set headers. Local (stdio) servers run in the optional `mcp-host` container (Compose profile `mcp`; its own internal network to the worker plus egress; no DB, workspace or secrets). Its daemon `mcp-host/hostd` has a small JSON API (`/tools`, `/call`) rather than re-exposing MCP: the worker sends the command, args and env with each request, the daemon starts the process on first use, reuses it, and stops it when idle. Only the worker talks to MCP servers: discovery is the `mcp.refresh` job, and the API just queues it (status `checking` → `ok`/`error`). `mcp_servers` keep headers/env as encrypted secrets (names only are returned); `mcp_tools` keep the last seen schema, `schema_hash`, `enabled`, `permission` (ask/allow/deny, null = category level), `risk_override` and `needs_review`. A tool is a runtime `Tool` built per run (`tools/mcp_tool.py`), named `mcp__<slug>__<tool>` with capability `mcp.<slug>.<tool>`; arguments are validated against its JSON Schema. Risk comes from the server's hints (read-only → safe, destructive → dangerous, else moderate) unless overridden. Per-tool choices are compiled into exact-name rules in the run's policy snapshot; the snapshot also records tool ids and hashes, so a tool that changes mid-run is dropped from that run. New or changed tools after first discovery get `needs_review` (forced `ask`). MCP tools are offered in agent mode only, and not at all when `mcp.*` is `deny`. Image/audio results are named, not passed to the model.
14. **Browser automation**: browser service, tools, screenshots in timeline, SSRF interception. *Done.* As built: the optional `browser` container (Compose profile `browser`, own internal network to the worker plus egress, read-only, no capabilities) runs `browser/browserd`: Playwright with headless Chromium and one endpoint, `POST /sessions/{id}/act` (open, read, click, type, screenshot), which returns the page after the action. A session is a fresh browser context named after the run, created on first use, closed when the run ends or after 10 idle minutes; downloads and service workers are off. Instead of Playwright request interception, every session gets its own forward proxy (`guard.py`) that resolves names itself, refuses non-public addresses unless allowlisted (the run's `web.allowed_private_hosts` snapshot) and connects to the address it checked, which also covers redirects, subresources, WebSockets and DNS rebinding; Chromium is told to proxy loopback too and not to use non-proxied WebRTC. The page is described by an injected script (`snapshot.js`): visible text plus numbered interactive elements (`data-anemo-ref`), which the agent refers to; password values are never echoed. Tools (`tools/builtin/browser.py`): `browser_open/read/click/type/screenshot`, all `browser.use`; click and type are rated moderate; actions carry no resource so one run grant covers the session. They are offered only while the browser container runs (its token file exists, snapshotted per run). Every step stores a screenshot as an attachment for the timeline; only `browser_screenshot` shows the image to a vision model. Sessions belong to the conversation (not the run) and stay open between turns (30 min idle), so the user can step in: the Browser panel (`features/browser/`, side panel in a chat or `/browser/:conversationId` on its own) polls `GET /conversations/{id}/browser` for a screenshot and sends clicks, typing, keys, scrolling and addresses to `POST /conversations/{id}/browser/input`, which the app passes to browserd's `/view` and `/input` (the app therefore joins the browser's internal network). Bot checks and CAPTCHAs are detected in the page description and the agent is told not to attempt them but to ask the user to answer them in the panel. Stored logins (browser profiles) are not implemented. browserd is tested with a real Chromium in its own image (`browser/tests`), the guard and the worker side in the backend suite.
15. **Global search + Usage views**: hybrid search API + palette/results page; usage summary/filter UI. *Done.* As built: `GET /search?q&kinds&limit&mode` (`features/search/`) runs one small search function per kind (chat, document, memory, task, event, file, automation) and returns hits grouped by kind with `has_more`. Chats use message full-text search plus titles; documents and memories use the knowledge index (keywords with all words required; plus vectors in `mode=hybrid`, the query embedded once for both) and fall back to title/content matching; tasks, events and automations match every word across their text fields; files match names (workspace file contents are still not indexed). The Ctrl+K palette (`CommandPalette`) uses `mode=keyword` so typing never calls an embedding model, and also matches page names; `/search` uses hybrid. Deep links were added for hits: `/tasks?task=<id>`, `/calendar?date=`. Usage: `GET /usage/summary?group_by=day|model|provider|kind|profile|automation&start&end&tz` and `GET /usage/records` (`features/usage/router.py`); day buckets use the browser's time zone; profile and automation come from the run a call belonged to; unknown costs are counted separately (`unknown_cost_requests`) and never summed as zero. The page is Settings > Usage with a CSS bar chart (no chart library).
16. **Sub-agents**: `agent.spawn`, budgets, depth caps, cascade cancel, nested run UI. *Done.* As built: the `run_subagent(task, profile?)` tool (capability `agent.spawn`, category default `deny`) is handled by the agent loop, not run as a tool: `subagents.spawn()` creates a child run (`runs.parent_run_id`, `root_run_id`, `depth`; same conversation so images and the browser are shared; no chat message; transcript = the task) and the tool call stays in status `waiting_child` with `result_data.child_run_id`. When a step has waiting calls the parent goes to the new run status `waiting_subagent` and releases its worker. A child's `_finalize` calls `subagents.wake_parent()`, which locks the parent row and re-queues it once no child is still working (the parent calls it too right after it starts waiting, so no wake-up is lost); on resume the parent turns each finished child into the call's result and charges its steps, tool calls, time and cost to its own totals. Permissions: the child's snapshot stores the policies of all ancestors and `policy.engine.evaluate(..., ancestors=)` takes the most restrictive of all layers; tools an ancestor denies are not offered. Budget: the child's limits are its profile's clamped to the parent's remainder (`clamp_limits`). Caps: depth ≤ `Limits.max_subagent_depth` (default 1, absolute 3), 3 working children per run, 10 descendants per root. Ending a run in any way cancels its children (`_stop_subagents`), recursively. A sub-agent under an automation inherits its `on_ask`. UI: the tool call shows the child run nested (`SubagentRun`, polling), including its approval requests; runs lists hide children (`GET /runs?parent_run_id=` lists them).
17. **Hardening & release**: failure-injection tests, backup script, docs, performance pass, E2E suite, `v1.0` tag.

---

## Q. Testing Strategy

- **Unit (pytest)**
  - Policy engine table-driven + **Hypothesis** property tests. Invariants: most-restrictive-wins; grants never override deny or the ceiling; child ≤ parent; hard floor unreachable.
  - Shell classifier corpus: 300+ commands incl. obfuscations (`r''m -rf`, `$(echo rm)`, `\rm`, env/xargs tricks). Must be ≥ expected risk.
  - WorkspaceFS fuzzing: `..`, encoded, absolute, symlink loops/escapes, NUL, Windows-style separators, unicode normalization.
  - Also: cron/misfire math, recurrence expansion, memory scoring, token budgeting, run reducer.
- **Integration** (real Postgres+pgvector+Valkey via testcontainers / compose test profile): job leasing/reaping, scheduler leader election, SSE replay from Redis ID, snapshot fallback, memory retrieval, FTS/hybrid search, document conflict flow.
- **API tests** (httpx AsyncClient): auth required on every router (auto-generated test iterating the OpenAPI routes), CSRF/Origin, re-auth for 🛡 endpoints, secret fields never in responses, schema contracts.
- **Agent runtime** with the **ScriptedProvider** (deterministic tool-call scripts):
  - Happy path, invalid JSON tool args, unknown tool, tool not in toolset, `ask` → suspend → approve/deny → resume.
  - Cancel during stream/tool, pause at boundary.
  - Worker killed mid-tool → `interrupted` semantics.
  - Limits, compaction trigger, fallback model on 5xx.
  - Sub-agent escalation attempt.
- **Permission-bypass suite (security/)**, where the model output is adversarial:
  - Path traversal in every fs arg.
  - Shell trying to reach network in the no-net sandbox.
  - Agent calling nonexistent `settings.update`.
  - Hallucinated MCP tool names.
  - Prompt-injected web page instructing tool use (must still hit policy).
  - Automation with `ask` running unattended (must pause, never auto-allow).
  - Grant-scope overreach (grant for `projects/a` used on `projects/b`).
  - Policy edited mid-run (snapshot semantics).
- **Mobile (Playwright, phone viewport 375×812 with touch)**: no horizontal page scroll on any screen; the sidebar drawer opens and closes; a chat can be sent and an approval answered; a file can be opened in Files; the manifest and service worker are served, and the service worker never serves `/api` from cache.
- **Frontend (Vitest + RTL)**: run reducer, useRunStream reconnect logic (mock EventSource), ApprovalCard, theme/accent application, forms validation, editor markdown round-trip fixtures.
- **E2E (Playwright)** against compose with the fake provider: login → chat stream → refresh mid-stream reconnects → agent run with approval → file created visible in file manager → automation run-now → notification → memory created and visible.
- **Deployment tests** (CI job): `docker compose up` from clean, wait healthy, run migrations twice (idempotent), smoke E2E, `docker compose restart worker` during a run → run completes or is correctly `interrupted`/resumed; image size budget check.

---

## R. Failure Modes

| Failure | Behaviour |
|---|---|
| Provider unavailable / 429 / 5xx | Backoff retries → fallback model → circuit breaker → run `failed` with clear error; chat shows "Retry" |
| Invalid tool call (bad JSON / schema) | One lenient repair; else structured error to model; 5 consecutive → fail |
| Hallucinated tool | Denied, logged, error to model |
| Tool timeout | Process killed; `ToolError{timeout}` to model; recorded |
| Worker crash | Lease expiry → reaper requeues → resume from checkpoint; in-flight non-idempotent tool = `interrupted`, not re-run |
| Cancelled midway | Kill in-flight ops, keep completed work, file changes listed and revertible |
| Process restart during automation | Same as worker crash; scheduler dedupe_key prevents double-fire; misfire policy for missed schedules |
| Browser crash | Session marked lost; tool error; browser service restarts (Docker); new session on next call |
| SearXNG unavailable | Tool error "search provider unreachable" + Settings health badge; agent can continue with other tools |
| DB unavailable | `/ready` fails; app returns 503; worker pauses claiming with backoff; no state lost |
| Redis unavailable | Live streaming degrades: SSE falls back to polling snapshot every 2 s; cancel falls back to DB flag polling (checked each step) |
| Context exceeded | Pre-emptive compaction; on provider error forced compaction + one retry; else fail with explanation |
| Malformed MCP server | Connection/listing error stored on server row, server marked `error`, its tools excluded; other tools unaffected |
| MCP tool schema changed | Tool reset to "ask" pending review |
| Permission denied | Structured denial to model (it may choose alternatives); visible in timeline |
| Approval never answered | `expires_at` (default 24 h interactive, automation setting) → denied/expired, run continues or fails per config |
| Disk full / workspace unmounted | WorkspaceFS health check; fs tools error; Settings banner |
| Embedding model changed | Old chunks remain queryable by old key; background re-index job; search uses active key |
| Document externally modified during edit | base_hash conflict → 409 → UI offers reload / overwrite / view diff |

---

## S. Risks / Tradeoffs

1. **Scope is very large.** Phasing and a strict "done = tested + deployable" rule are the mitigation. Some features (sub-agents, browser, MCP stdio) may ship minimal first.
2. **Shell filesystem boundary is the whole workspace mount.** Per-root agent restrictions are exact for fs tools but not for shell. Mitigations: document it clearly, and allow additional sandbox mount configurations via the override file. A future option is per-root sandbox mounts (requires compose regeneration) or bubblewrap (needs user namespaces, which are often unavailable in Docker).
3. **In-house job queue** is less battle-tested than Celery. It's kept small and heavily tested. Procrastinate is the fallback if it grows.
4. **TipTap Markdown round-trip fidelity** (tables, nested lists, HTML blocks). Needs fixture tests. Documents with unsupported constructs open in a source/CodeMirror mode.
5. **Files-as-source-of-truth documents** need reconciliation with external edits (watcher + hash). External renames appear as delete+create (revisions of the old path are orphaned but kept).
6. **Reasoning availability differs per provider.** The UI must handle "none" gracefully.
7. **Shell classifier is heuristic.** It only escalates risk. Real boundaries are the container, network namespace and policy.
8. **Prompt injection cannot be eliminated.** It is contained by policy, approvals and isolation. "Fully autonomous + network + shell" is inherently risky, and the UI warns explicitly.
9. **Untyped pgvector column** gives up ANN index convenience. Fine at single-user scale; dynamic partial HNSW mitigates it.
10. **Windows dev vs Linux prod**: file permissions, line endings and bind-mount performance. WSL2 is recommended; PUID/PGID are handled in images.
11. **Image sizes**: the browser image is ~1.5 GB, which is why it's optional via Compose profile.
12. **Memory extraction costs tokens.** It's debounced, configurable, and can target a cheap/local model.
13. **Web Push** (notifications while no tab is open) is deferred. Discord/ntfy cover the offline case initially.
14. The **ceiling + policy + grants** model may feel complex. The UI presents presets first and the raw rules as "Advanced". This may need UX iteration.

---

## T. Recommended First Milestone (Phases 0–3)

**"Streaming chat through the real runtime, deployable with one command."**
- `docker compose up -d` brings up migrate → postgres/valkey → app + worker, all healthy.
- Login with env credentials; persistent session; logout.
- Settings: Appearance (light/dark/system + accent color, applied everywhere via tokens), Providers & Models (add OpenAI-compatible/OpenRouter/Anthropic/OpenAI provider, encrypted key, discover/test models, set chat default).
- New chat → message is enqueued as a `run` → worker streams via the provider adapter → Redis → SSE. Reasoning shown separately when the provider exposes it. Stop button cancels at runtime level. **Refreshing mid-response reconnects and continues.**
- Conversations persist, are listed in the sidebar, and are searchable by keyword. Usage records are written with cost or "unknown".
- Tests: unit (router, reducer, crypto), integration (queue leasing, SSE replay), E2E with fake provider (login → stream → refresh → resume).

This proves the backbone every later feature depends on: jobs, runs, events, providers and auth. It uses no throwaway code. Phase 4 (policy engine + tools) builds directly on it.

---

## Verification (per phase and for milestone 1)

- `make test` runs ruff, mypy, pytest (unit+integration with containers), eslint, tsc and vitest. It must pass.
- `docker compose up -d` from a clean clone plus `.env` makes all services healthy (`docker compose ps`), and `curl :8080/api/health` → 200.
- Manual: log in, configure a real provider (or the fake provider with `ENABLE_FAKE_PROVIDER=1`), send a chat, verify streaming in the built-in browser pane, refresh mid-stream, cancel, check `usage_records`.
- `npx playwright test` in `e2e/` against the running stack, including the phone-viewport project.
- Manual: check each new or changed screen at phone width in the browser pane (mobile preset) and in dark mode.
- Resilience: `docker compose restart worker` during a streaming run results in a correct `interrupted` → resumed/failed state and a UI that recovers.
