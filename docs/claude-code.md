# Claude subscription (Claude Code)

Anemo can use your own **Claude subscription** (Pro or Max) as a model provider, so
chats and agent runs count against the subscription instead of API credits. It does
this by driving the official **Claude Code** command-line tool in a separate
container, `claude-runner`.

Claude Code acts only as the model. It has no tool of its own: every tool call it
makes (files, documents, shell, web, browser, tasks, calendar, memory, MCP,
sub-agents, …) comes back to Anemo and goes through **Settings → Agent
Permissions** exactly as with any other provider. Approvals, plan review, limits,
file changes and their revert, the security log and the workspace guard all work
as before.

## Set it up

1. Start the container (about 350 MB):

   ```bash
   docker compose --profile claude up -d
   ```

   This builds the image on your machine. On x86-64 you can pull a prebuilt one
   instead: add `CLAUDE_RUNNER_IMAGE=ghcr.io/essntl/anemo-claude-runner:latest` to
   `.env`, then run `docker compose --profile claude pull claude-runner` before the
   command above. The prebuilt image runs as user id 1000; if your `PUID` is
   different, build it yourself so the worker can read the runner's token. It is
   published by `.github/workflows/claude-runner-image.yml`; each image is also
   tagged with the Claude Code version it contains (`claude-code-2.1.308`).

   To have it start with everything else, add `claude` to `COMPOSE_PROFILES` in
   `.env` (for example `COMPOSE_PROFILES=browser,claude`).

2. Sign in once, with your Claude subscription (not an API key):

   ```bash
   docker compose exec -it claude-runner claude auth login
   ```

   Follow the link it prints, sign in with your Claude account and paste the code
   back. Do not use `--console`: that signs in to API billing instead.

3. In **Settings → Providers & Models**, add a provider of type **Claude
   subscription (Claude Code)**. There is no key or address to enter. The provider
   card shows whether the runner is running and signed in, and the command to fix
   it when it is not. Use **Add models** to pick models (Opus 5.5, Sonnet 5.5, Haiku
   5.5, Fable 5.1), and choose one as a default under *Default models*.

4. Optional: check prompt caching against your subscription. It runs a short agent
   conversation (8 turns, each reading a small file) and prints, for every model
   request, the cache reads and writes. It uses a small amount of your quota:

   ```bash
   docker compose exec worker python -m app.cli claude-code-check
   docker compose exec -it worker python -m app.cli claude-code-check --approval --restart
   ```

   `--approval` adds a turn that deletes a file (with *Delete files* on *Always ask*):
   approve it in the app after the runner's idle window (15 minutes) to see the
   resumed request still read from the cache. `--restart` pauses before the last turn
   so you can run `docker compose restart claude-runner`.

## What it can and cannot do

- **Can:** chat, agent runs with all of Anemo's tools (as your permissions allow),
  images in messages and from tools, reasoning shown as it streams, sub-agents and
  automations, titles and summaries.
- **Cannot:** embeddings (pick another provider for search by meaning). PDFs are
  sent as extracted text. Claude Code's own tools, sub-agents, skills, memory,
  slash commands and your claude.ai connectors are all switched off.
- **Usage limits:** chats, agent runs, **automations and other background work**
  pointed at these models all use your subscription's limits. When a limit is
  reached, the run says so (with the reset time when Claude Code reports it) and
  Anemo moves on to the fallback model you configured, which may be a paid API model.
- **Cost:** usage records show tokens, with the cost as *unknown* (a subscription has
  no per-token price). A run's details show what the same requests would have cost
  on the API, for information.

## How it works

```
worker (any replica)                            claude-runner (one container)
AgentRun loop                                   Claude Code sessions (CLI processes)
  ModelRouter -> ClaudeCodeAdapter -- HTTP -->  session API -> claude (stream-json)
                                                   ^                | calls mcp__anemo__<tool>
  ToolExecutor -> PolicyEngine (unchanged)         |                v
    runs the tool, appends the result              +-- "anemo" bridge: holds ("parks") the
  next request with the results ------------->        call until the worker sends its result
```

- The worker's adapter sends only what is new to a session (a new message, or the
  results for the calls that are waiting), because Claude Code keeps the
  conversation itself. What each session has seen is kept in the database, so any
  worker can continue it.
- One session per conversation and mode (Chat, Agent); sub-agents and automation
  runs get their own. Titles, summaries and memory extraction are one-off requests
  that keep nothing.
- A run that waits for an approval, a plan review, a pause or a sub-agent holds no
  worker, as always. The runner keeps a session's process warm for 15 minutes
  (`CLAUDE_RUNNER_IDLE_S`) and then ends it; the next request continues the same
  session with `--resume`. If a tool call was waiting when the process ended, Claude
  Code records it as interrupted and Anemo's result follows as a message.

## Prompt caching

Subscription limits are the scarce resource, and a cache miss sends the whole
conversation again. So everything is arranged for the cache to hit on every request
after the first:

- The **system prompt** holds only what is stable (instructions, profile, skills,
  project). The **date, time and the memories** for a message are in a "turn
  context" block at the end of that message, saved with it and sent byte for byte
  in every later request. (This applies to every provider; Anthropic API requests
  now also mark cache breakpoints.)
- The **tool list** is sorted and fixed for a session. Changing a permission that
  adds or removes a tool, or the model, costs one expected miss.
- Every Claude Code process starts from the same empty folder with the same flags,
  and the Claude Code version is pinned in the image (the auto-updater is off). A
  new version changes the cached prefix, so upgrades only happen when you rebuild.
- Claude Code's cache lifetime for the conversation is set to 1 hour, the longest
  Anthropic offers (the other choice is 5 minutes). Every request that reads the
  cache starts the hour again, so a conversation stays cached as long as there is
  less than an hour between turns. After a longer break, the first request writes
  the cache again. Anemo does not send keep-alive requests to stretch this: each
  one would read the whole conversation and count against your usage limits.

Each model request is logged by the worker (`model request`, with the cache reads
and writes). A request that reads nothing from the cache is logged as a **warning**
unless the miss was expected: a session's first request, a changed tool list,
model or Claude Code version, edited history, Claude Code compacting the
conversation, or more than an hour without use.

Things that start a new prefix (and so one full cache write):

| What | Why |
|---|---|
| Editing your last message, regenerating an answer | The session is forked at the turn before it (the earlier part still hits) |
| Switching a conversation between Chat and Agent | Each mode has its own session; the other mode's messages are sent once as a summary block |
| Changing the model | A new session |
| Changing profile or project instructions | The session keeps its first system prompt; the new instructions are sent once as a note |

## Security

- **The login stays in the runner.** Claude Code signs itself in and keeps the
  login in the `claude-config` volume, which is mounted in the `claude-runner`
  service only. Anemo never reads, copies, stores, logs or forwards it: there is no
  token in `.env`, the database, the secrets table, logs or backups. The runner's
  health check runs `claude auth status` and passes on only whether you are signed
  in, the sign-in method and the CLI version.
- **One user.** Only the worker can reach the runner (an internal Docker network
  plus a token, like the shell sandbox). Share links and the public pages cannot
  reach it.
- **Clean environment.** The Claude Code process gets an environment built from an
  allowlist. It never sees `ANTHROPIC_API_KEY` (with that set, Claude Code would
  bill the API instead of your subscription), `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL` or any of Anemo's secrets.
- **No tools of its own.** Built-in tools are off (`--tools ""`), only Anemo's bridge
  may be used, no other MCP server loads (`--strict-mcp-config`), no settings files,
  CLAUDE.md, skills, plugins or claude.ai connectors are read, nothing that would
  ask for permission is allowed, and messages are delivered as written (an
  `@/path` in a message is not turned into a file read).
- The container has no workspace, no database access and none of Anemo's secrets;
  it runs as a non-root user with a read-only system, no Linux capabilities and
  memory/CPU limits, with internet access to reach Anthropic.

## Troubleshooting

| Problem | Fix |
|---|---|
| "The claude-runner container is not running" | `docker compose --profile claude up -d` |
| "Not signed in with a Claude subscription" | `docker compose exec -it claude-runner claude auth login` (the card shows the method it found; `oauth_token` or an API key are not a subscription login) |
| A run says the usage limit is reached | Wait for the reset time, or set a fallback model in Settings → Providers & Models |
| Warnings "read nothing from the prompt cache" | Check the reason fields in the log line; restarting the container keeps sessions, rebuilding with another Claude Code version does not keep the cache |
| Sign out | `docker compose exec claude-runner claude auth logout`, or remove the `claude-config` volume |

## Versions

Pinned in `claude-runner/requirements.txt`: `claude-agent-sdk` 0.2.172, which bundles
Claude Code 2.1.308 (checked when the image is built). To upgrade, change the pins,
rebuild (`docker compose --profile claude build claude-runner`) and run the tests in
`claude-runner/tests`; expect one cache write per conversation afterwards.
