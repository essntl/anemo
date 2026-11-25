# 22. Files between devices and the workspace

Status: built (round 4, workstream F). Contract: `docs/device-contracts.md` §8 (and the 1.7.0
line of §6). Owner files: `backend/app/tools/builtin/device_files.py`, `desktop/src/Anemo.Desktop.Core/Files/`.

## What it does

The agent copies a file from a computer that runs Anemo Desktop into the workspace
(`device_file_get`), or a workspace file onto such a computer (`device_file_put`). Typical
uses: "take the PDF in my Downloads and summarise it", "put the finished report on my
desktop", moving a build artefact from the agent's VM into the workspace.

| Tool | Does | Permission | Risk |
|---|---|---|---|
| `device_file_get(device, device_path, workspace_path, overwrite?)` | copies a file from the computer into the workspace | `device.files` + `fs.write` for the workspace path | moderate (the workspace side: safe, moderate when it replaces a file) |
| `device_file_put(device, workspace_path, device_path, overwrite?)` | copies a workspace file onto the computer | `device.files` + `fs.read` for the workspace path | moderate; **dangerous** with `overwrite: true` |

`device.files` is a new permission category, *Files on your computers*, default **Always
ask**. With *Ask for dangerous actions*, copies run without a question but replacing a file
on a computer still asks.

## Who gets the tools

- Only **trusted** computers whose client offers files (`device.offer` `files: true`, which
  Anemo Desktop 1.7.0 sends while *Let Anemo read and write files* is on and it was told it
  is trusted). A watched computer, or one that doesn't offer files, is denied in `actions()`
  without a question (`Action.blocked`, from the per-step device list), and checked again
  live in `run()` before the first command (trust, the fresh offer, the same device id),
  so a change between the decision and the call never lets one through.
- The tools are in the run's toolset under the same gate as the computer tools
  (`has_computer` in `registry.toolset_for`: a computer was online when the run started, and
  for an automation, it lists a computer tool). The turn context's line of a computer says
  `files on` when it takes files, and the section's first sentence names the two tools.
  The per-step device refresh that `actions()` reads only runs when a computer tool is in
  the toolset, which is why the gate is shared.
- **Deviation from the brief, on purpose:** the brief asks that a run without a trusted
  computer offering files not get the tools at all. That needs a flag in the run's
  snapshot (`runtime/agent_snapshot.py`), which belongs to another workstream this round
  (CONTRACTS-round4 §9). Here the tools are offered with the computer tools and refuse every
  other computer before anything is sent. The one-line follow-up: snapshot
  `"device_files": any(d.trust == "trusted" and d.files for d in online_devices)` and pass it
  to `toolset_for` as its own flag. The same change would let an automation that lists only
  the file tools have them (today it also has to list a computer tool).

## Protocol, in short

Chunked over the device's existing WebSocket, one `device.command` at a time through the
relay (`features/devices/relay.py`), like every other device action. No new endpoint, no
new table, no migration.

- **Get:** `file_stat` (size, and the SHA-256 of the whole file) → the size limit →
  `file_read` 1 MB at a time, each chunk with its own SHA-256 → the whole file's SHA-256
  compared with the stat's → `files.write_bytes` → `record_change`.
- **Put:** the workspace file read through `files.read_bytes` (with the limit) →
  `file_write_begin` (path, size, SHA-256, overwrite) → `file_write_chunk`s → `file_write_end`,
  whose SHA-256 must be ours; any failure after the begin sends `file_write_abort`.

Decisions:

- **1 MB chunks** (the client takes up to 4 MB). Base64 makes one about 1.4 MB, far inside
  the 12 MB the server takes as a device's answer and the 16 MB a client takes as a command,
  so no frame limit changes. Bigger chunks would save round trips (a 50 MB file is 50 of
  them, a few seconds), but each passes Valkey's pub/sub and a list whole; 1 MB keeps the
  memory per step small and a retried chunk cheap.
- **SHA-256 per chunk and for the whole file, checked on both ends.** The chunk hash finds
  a damaged frame early (a read asks for the chunk once more, then stops); the whole-file
  hash finds a file that changed between the stat and the last read, and on a write it is
  checked by the client on the bytes as they are on its disk, before the rename.
- **A temporary file beside the target, renamed at the end.** The same folder keeps the
  rename on one drive (atomic), the leading dot keeps it out of normal listings. A partial
  write is therefore never under the final name. If the client is killed mid-copy the
  hidden `.part` file stays behind; it is never mistaken for the real file.
- **The client drops a write after 60 s without a chunk** (and at most 4 are open), so a
  lost abort or a server that went away doesn't leave transfers open.
- **The whole file is held in the worker's memory**, because `app.workspace.files` writes
  bytes atomically (temp + rename, through `safe_fs`) and that module belongs to other
  workstreams this round. Hence the ceiling of 200 MB on the setting.
- **Paths on the computer are opaque**: never parsed by the server (they may be Windows or
  macOS paths), only checked for control characters and length. The rule about where is
  the client's (below).
- **The stop key stops copies too.** While control is paused nothing is copied (an abort
  still works). *Allow control* isn't needed: copying files is its own switch, separate
  from clicking and typing.

## Which folders on the computer

Decided by the client (`FileRules`, contract §8.2): the folders listed in Anemo Desktop's
Settings, or the user's home folder when none are; with every link and junction followed
first (repeatedly, so a link inside a link's target is followed too); never a hidden part
below the allowed folder; never the home folder's `AppData` (Windows) or `Library` (macOS);
never Anemo Desktop's own data folder; on Windows no network, device or alternate-stream
paths.

Why this rule: the home folder is where a user's own documents, downloads and desktop are,
so the default is useful without setup. What must not be reachable there is where secrets
and start-up code live, and on both systems those are hidden folders (`.ssh`, `.aws`,
`.gnupg`, `.config`, `.git`'s hooks, the shell's start files) or the one system folder
(`AppData` holds browser profiles, credentials and the Startup folder; `Library` holds
keychains, mail and `LaunchAgents`). Refusing those closes the two obvious abuses: reading
keys, and planting a program that runs at the next sign-in. Listing folders in Settings
narrows it (a VM's shared folder, a project folder) and is the way to reach another drive.
The client's own folder is refused whatever is listed, so the agent can never read the
protected token or rewrite the client's settings.

Links are followed before the check because a symlink or junction in an allowed folder
could otherwise point anywhere. What remains: a link swapped between the check and the
open (a local race on the user's own computer), which is out of scope as for the git reads.

## Workspace side

- A get writes through `app.workspace.files.write_bytes` (`fs_guard`, `safe_fs`, atomic),
  after `path_action` checked the folder access of Settings > Workspace (`fs.write`,
  `read_write`). It refuses an existing workspace file unless `overwrite: true`; with it, the
  old content is backed up and the change recorded as `modify`, otherwise `create`, through
  `ctx.record_change`, so it is in the run's file changes and **revertible** like
  `write_file`.
- A put reads through `files.read_bytes` after `path_action` (`fs.read`, `read`), so a
  folder hidden from agents can't be sent away.
- The tools never show a file's content to the model; it reads the copy with `read_file`,
  where it is untrusted content like any other file.

## Security

- Nothing reaches a computer that isn't trusted, or whose user didn't switch files on;
  both checked by the server (before asking and again live) and by the client.
- Reading the user's files is privacy-relevant, so copying is *moderate* and the category
  asks by default; replacing a file on the computer is *dangerous*, so it asks unless the
  user chose *Fully autonomous* for it.
- Where on the computer: the folder rule above, enforced by the client with links followed.
- Integrity: SHA-256 per chunk and per file, checked on both ends; no partial file under
  the final name.
- Logs: the client's command log has paths, offsets and sizes, never data; the server
  logs nothing of a file.
- `docs/security.md` *Devices* says what the agent can read and write on a computer, and where.

## Limits

- 50 MB by default (Settings → Devices, 1–200 MB, the `files` section's
  `device_file_max_mb`); the client's own ceiling is 200 MB.
- One file per call, no folders (zip them first with `create_zip`, or on the computer).
- Throughput: one chunk per round trip through Valkey; a few MB/s on a LAN.
- The tool has 15 minutes in all.

## Testing

- Server: `backend/tests/api/test_device_files.py`, with a fake computer speaking §8 over a
  fake relay: the category and default, the risks (overwrite on the computer dangerous),
  watched or no-files computers denied without asking and refused live, chunking, a bad
  chunk retried once then refused, a file that changed meanwhile, the size limit (both
  ways, and the setting's bounds), overwrite rules on both sides, an abort after a failed
  chunk, a whole agent run whose copy is reverted through the API, and a client without
  files getting no `files on` line and no command.
- Client: `desktop/tests/Anemo.Desktop.Tests/Commands/FileTests.cs` (real files in a
  temporary home folder: who may, the folder rule incl. a symlink out (skipped where links
  can't be made), chunked reads with hashes, the temporary file and rename, overwrite and a
  file appearing meanwhile, bad chunks and hashes, abort and the 60 s rule, the transfer
  cap, the log, the settings field) and `DesktopAgentTests` (the offer's `files`).
- By hand, on real Windows and macOS: `desktop/MANUAL-TESTS.md` *Files* and
  `docs/specs/09-desktop-macos-mac-testing.md`.

## Not built / later

- The `file.created` event (CONTRACTS-round4 §1.2) for a pulled file: the emit belongs to
  `workspace/files.py`'s owner this round; a get writes through `files.write_bytes`, so
  it is covered wherever that emits.
- Streaming to disk instead of memory (would need a streaming write in `app.workspace.files`).
- Folders, listings of a computer's folders (`device_file_list`), resuming a broken copy.
- A strict "offered only when such a computer is online" gate (see *Who gets the tools*).
