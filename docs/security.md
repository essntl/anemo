# Security and permissions

The idea behind Anemo: **what an agent may do is decided by the server, from your
settings, for every single action.** Nothing a model writes can grant a permission,
approve a request or change a setting. This page says what is enforced, where, and
what is not.

## Who can get in

- One user. The name and password come from `.env`; there is no sign-up.
- Sessions last 30 days and are listed (and can be ended) in **Settings → General**.
- Five wrong passwords lock logins for a minute. The counter clears on its own;
  restarting the app does not clear it.
- Sections marked with a shield (providers, agent permissions, workspace, web,
  MCP) ask for your password again if you logged in more than 15 minutes ago.
- Logins, setting changes, approvals and denials are in the security log under
  **Settings → Advanced**.

## Share links

Anemo has one user, but you can let someone **read** a single chat, document or
project by giving them a link (**Share** in the menu of a chat, a document or
a project). This is the only thing reachable without logging in, apart from the login
page itself.

- **A link shows a frozen copy.** The copy is made when you create the link and is
  stored with it. Opening a link reads that copy and nothing else: no live chat, no
  file, no setting. It changes only when you press **Update copy**.
- **What a copy contains.** A chat: the messages, the model's name, and the *names* of
  attached files and referenced chats. A document: its text. A project: the
  sections you tick, which are its tasks and upcoming events (titles and dates) and
  its documents (the text of each, to read in full). Never included: attached files
  and workspace images, the model's reasoning, what an agent did, and a project's
  chats, files and instructions.
- **A visitor can only read.** There is nothing to write to, no model is called and no
  agent or tool can be reached through a link.
- **The address is the secret.** It contains 256 random bits; anyone who has it can read
  the copy, so share it the way you would share the text itself. The page is marked as
  not to be indexed and does not pass its address on to sites it links to.
- **Links end.** They expire after 1, 7 or 30 days (7 by default) unless you choose
  "until I revoke it". **Revoke** stops a link at once, deleting the chat, document or
  project deletes its links, and **Settings → Shared links** lists every link with how
  often it was opened, and can revoke them all. Missing, expired and revoked links
  look the same to a visitor. Wrong addresses are limited to 30 a minute per IP.
- Creating and revoking links is in the security log.

A link only works for people who can reach your server. If Anemo is only on your home
network, so are its links.

## Permission levels

**Settings → Agent Permissions** has one level per kind of action:

| Level | Meaning |
|---|---|
| Never | The agent cannot do it and is told so. |
| Always ask | The run pauses and waits for you every time. |
| Ask for dangerous actions | Routine actions go ahead; risky ones wait for you. |
| Allowed in workspace | Goes ahead inside your workspace; anything else waits for you. |
| Fully autonomous | Goes ahead without asking, still inside the fixed limits below. |

The kinds of action and their defaults:

| Action | Default |
|---|---|
| Read files | Allowed in workspace |
| Create and edit files, delete files | Always ask |
| Run shell commands, shell with network | Always ask |
| Web search | Fully autonomous |
| Read web pages | Ask for dangerous actions |
| Browser, external API calls | Always ask |
| Edit documents | Always ask |
| Manage tasks, manage calendar, send notifications | Ask for dangerous actions |
| Update memory | Fully autonomous |
| MCP tools | Always ask (each tool can be set on its own) |
| Start sub-agents | Never |

Whether an action is "dangerous" is decided by code, not by the model: for
example `rm -r`, `git push --force`, piping a download into a shell, or any
command that cannot be parsed. These checks can only make an action stricter.

### Layers

Several rule sets can apply to one action, and **the strictest one wins**:

1. **Fixed rules** in code: paths outside the workspace, settings and secrets are
   never available to agents, whatever the settings say.
2. **Your ceiling**: the most any agent may ever do.
3. **The profile or automation** the run uses.
4. **The parent run**, for sub-agents: a sub-agent can never do more than the
   agent that started it.

The rules are copied onto a run when it starts. Changing settings affects new runs.

### Approvals

When a run waits for you, you can approve once, approve for the rest of that run
(for that kind of action in that place), or deny, with a reason the agent sees.
An approval for the run never overrides "Never" or the ceiling. Unanswered
requests expire after 24 hours and count as denied. Unattended automations follow
their own setting for this: wait and notify you, skip the action, or stop.

### Limits

Every run has limits on steps, tool calls, running time, cost, repeated errors and
sub-agent depth. When one is reached the run stops and says which.

## What isolates agents

| Part | Boundary |
|---|---|
| File tools | Paths are resolved and must stay inside the workspace; links that point outside are refused. Deletes go to the trash; changed files can be put back from the run. |
| Shell | Runs in a separate container as a non-root user, with a read-only system, no extra privileges and memory/CPU/process limits. The default sandbox has **no network at all**. A second one with internet access is a separate permission. Neither can reach the database. |
| Web pages and API calls | Addresses on your own network, the Docker host and cloud metadata addresses are refused unless you list them in Settings → Web & Search. Redirects are checked again. |
| Browser | Its own container without workspace, database or secrets; the same address rules apply to everything it loads. |
| MCP | Local MCP servers run in their own container without database, workspace or app secrets. Each tool is permission-checked. If a server changes a tool's definition, the tool is switched to "ask" until you review it. |

## Secrets

API keys, webhook addresses and MCP credentials are encrypted in the database with
`APP_SECRET_KEY`. The API never returns them (you see the last four characters),
they are not written to logs or run records, and they are never given to a model
or a tool. The test suite checks this by saving a key, running an agent and then
searching every response, record and stored file for it.

## What this does not protect against

- **The shell sees the whole workspace.** Per-folder access applies exactly to the
  file tools; a shell command can read any file in the mounted workspace. Do not
  keep things in the workspace that an agent with shell access must never see.
- **Text from the web can try to steer a model.** Pages, files and tool results are
  marked as untrusted, but a model can still be misled. What contains the damage
  is the permission check on every action, not the model's judgement. "Fully
  autonomous" shell with network plus web access is the riskiest combination;
  prefer "ask" there.
- **What you approve, runs.** Read approval requests; the exact command or change
  is shown.
- **Websites that block automated browsers.** Anemo does not try to get around bot
  checks or CAPTCHAs. You can take over the agent's browser yourself, or use an
  official API.
- **A stolen `.env` plus a database dump** reveals the saved keys. Protect both.
- **One user only.** There are no roles; whoever has the password has everything.
  Share links (above) are read-only copies, not accounts.
- **A share link in the wrong hands.** Whoever gets the address can read that copy
  until it expires or you revoke it. It is also kept in the browser history of
  whoever opened it, and in your proxy's access log.

## Reporting a problem

Open an issue at https://github.com/essntl/anemo/issues. For something that
should not be public yet, say only that in the issue and ask for a private way to
send the details.
