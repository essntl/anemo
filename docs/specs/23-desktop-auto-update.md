# 23. Anemo Desktop updates itself

Status: built (round 4, workstream U), Anemo Desktop **1.8.0** on Windows and macOS; review fixes
in **1.8.1** (the Apple-anchored Team ID check, no updates without the app's own signature,
unexpected errors, rollback, restart wait, version checks). Contract:
`docs/specs/CONTRACTS-round4.md` §8. No server change: Anemo's server is not involved at all.
Owner files: `desktop/src/Anemo.Desktop.Core/Updates/`, `desktop/src/Anemo.Desktop/Platform/WindowsUpdates.cs`,
`desktop/src/Anemo.Desktop.Mac/Platform/MacUpdates.cs`, `.github/workflows/release.yml`.

## What it does

Anemo Desktop looks for a new version on GitHub Releases (the `desktop-v<version>` Releases that
`release.yml` and `auto-release.yml` already publish), downloads it, checks it, and installs it
when you quit, or at once from the tray / menu bar item **Update to X ready: Restart to update**,
which waits until the agent is done. It can be switched off.

| | |
|---|---|
| When | a minute after start, then every 6 hours, while *Update automatically* is on (default); **Check now** in Settings at any time, on or off |
| From | `https://api.github.com/repos/<repo>/releases` (unauthenticated, `If-None-Match` with the last ETag), files from `https://github.com/<repo>/releases/download/<tag>/<name>` |
| Picks | the newest release that is not a draft, not a pre-release, has a `desktop-v<x.y.z>` tag (strict semver, no suffix) greater than the running version, and has this computer's file and its checksum file. `voice-v…` and `v…` releases in the same list are skipped |
| This computer's file | `Anemo-Desktop-win-x64.exe` / `Anemo-Desktop-win-arm64.exe` + `SHA256SUMS-desktop.txt`; `Anemo-Desktop-macos-arm64.zip` + `SHA256SUMS-desktop-macos.txt` |
| Checks | the signature over the checksum file (when the build has a key, below), the download's SHA-256 against it, then the platform's checks (below); anything that fails is deleted and said in Settings |
| Installs | at quit (and at Windows sign-out / shutdown); or *Restart to update*, once nothing is running |
| Off | *Update automatically* off: no checks by itself; an update it had fetched by itself is discarded; *Check now* still works, and what it fetched is installed at quit |

Settings → *This computer* → **Updates** (Windows) and the **Updates** section (macOS) have the
switch, a status line ("1.9.0 is ready: it is installed when you quit, or now with Restart to
update", "1.8.0 is the newest version (checked at 14:05)", the reason of a refusal), **Check now**
and **Restart to update**. The tray / menu bar shows **Update to 1.9.0 ready: Restart to update**
when one is downloaded, and the Windows tooltip adds "update to 1.9.0 ready". The texts are
shared (`UpdateText.cs`) so both systems say the same.

## Why no framework

Squirrel.Windows, Velopack, Sparkle and WinSparkle were weighed. Each brings an installer model
the client doesn't have today (Squirrel/Velopack install into `%LOCALAPPDATA%\<app>` with a
`Update.exe` stub and their own release feed format and delta packages; Sparkle is
Objective-C/Swift and wants an appcast and an EdDSA key; Velopack would change how the exe is
shipped and what the release publishes). The client is one self-contained exe and one `.app`,
already published with checksums; what is needed is "fetch the newer file, check it, rename it
into place". That is under 2,000 lines of C# with their comments, most of it shared Core code with
tests that run on Linux, and no new dependency (ECDSA is in .NET on both systems). A framework would earn its
place for delta updates or installs under Program Files; neither is needed now.

## The flow (`Updates/Updater.cs`)

1. **Check.** `GET /releases?per_page=50` with `If-None-Match`. A 304 reuses the list kept in
   memory (a 304 doesn't count against GitHub's 60 unauthenticated requests an hour per address).
   `ReleaseSelection.Pick` chooses the candidate. Nothing newer: *up to date*.
2. **A version that failed to start last time** (`updates/failed`, written by the rollback) is not
   fetched again by itself; *Check now* tries it again.
3. **Signature** (builds with a key): `SHA256SUMS-desktop*.txt` and its `.sig` are fetched (64 KB
   and 1 KB at most) and verified. A release without a `.sig` is refused before anything big is
   downloaded.
4. **Download** to the platform's path (up to 400 MB; 30 minutes), then its SHA-256 compared with
   the checksum file's line for this file (both `sha256sum` formats, `<hex>  name` and
   `<hex> *name`; a name listed twice with different hashes refuses the file). A mismatch deletes
   the download.
5. **Platform checks** (`IUpdatePlatform.PrepareAsync`), then *ready*.
6. **Install** at quit, or after *Restart to update* when `DesktopAgent.BusyReason()` is null.

Any failure ends only this attempt. The expected ones say why (a refusal waits for the next
6-hour check; network and file errors retry after an hour); anything else (an antivirus that
blocks the self-test's `Process.Start`, a process that can't be ended, a bug) is logged with its
type and also retries after an hour, with "The update failed unexpectedly" in Settings. The loop
itself catches whatever a look throws, so nothing stops updates until a restart.

Every URL is built from the compiled-in repository, the tag and the file name; nothing from the
API's answer is used as an address. HttpClient follows GitHub's redirect to its storage host and
never from HTTPS to HTTP; the client checks the final address is HTTPS anyway.

### "Never while the agent is working"

`BusyReason()` (Core, `DesktopAgent.cs`) answers why a restart has to wait, in this order: a
device command is running; the last one ended less than **60 s** ago (an agent sends commands one
after another with the model thinking in between; restarting in such a gap would break its task
just the same); a file copy is open (spec 22); a Claude Code job started from Anemo is still being
set up (its clone runs inside the client); a Claude Code job the client shares is running (sharing
would stop until the restart; the job itself is detached and would survive, but the brief asks not
to interrupt it). Only running jobs count: one that ended and whose last events the server hasn't
acknowledged yet doesn't (offline, that ack never comes, and the restart would wait forever; the
restarted client sends the rest). While waiting, Settings says what it waits for ("… once nothing is running (a
Claude Code job is running)"); it looks again every 5 s. **Quit** installs at once: quitting is
the user's own choice, and the swap doesn't stop anything that quitting doesn't.

A long Claude Code job therefore holds *Restart to update* back for as long as it runs. That is on
purpose; *Quit* is the way to update now.

## The swap (`Updates/UpdateInstaller.cs`)

Done by the quitting process **after** its window, tray and single-instance lock are gone
(`Program.Main`, after the UI loop), so the new copy can take the instance:

1. delete the backup of the update before (`Previous`);
2. rename the running version to `Previous` (Windows allows renaming a running exe, not deleting
   it; macOS allows moving a running bundle);
3. rename the staged version to the running one's path. If that fails, step 2 is undone; if even
   that fails, the log says where the old version is (`BROKEN: … rename it back`), and after
   *Restart to update* the old version is started from there (`Anemo Desktop.old.exe` /
   `.Anemo Desktop.old.app`), so the computer isn't left without the client.

The three paths are on one volume, so each step is a rename, not a copy. Nothing needs admin
rights: the client only updates where its user can write (else Settings says so and how to move it).

**Restart to update** then starts the new version with `--updated`. That copy waits up to 30 s for
the old one's instance (mutex / lock file), and once its tray is up writes `updates/started` with
its version. The old process watches for 45 s: the file with the right version means done; the
new copy exiting, or staying silent (then it is ended), means **rollback**: the new version is
deleted (retried while Windows still locks the exe), `Previous` is renamed back, the old version
is started again, and the version goes into `updates/failed`. If `Previous` can't be renamed back,
the old version is started from where it is kept, as above. A stale `started` file is deleted
before the start, so it can't count.

At quit nothing is started, so nothing is watched. What protects that path is the check before the
swap: the new version has already been **run once** with `--self-test` (it prints `Anemo Desktop
<version>` and exits before its instance check), so a file that doesn't start at all is never
swapped in. And `Previous` stays until the next update, so going back by hand is one rename.

**Why a started-file rather than the process alone:** macOS starts the new app through
LaunchServices (`open -n`, so it is its own app for macOS's privacy checks rather than a child of
the old one), which gives no process to watch. The file works the same on both systems.

### Windows (`Platform/WindowsUpdates.cs`)

In the exe's own folder: `Anemo Desktop.download` (being downloaded) → `Anemo Desktop.new.exe`
(checked) → swapped in; the old exe is kept as `Anemo Desktop.old.exe`. The name follows the
running exe's, whatever it was renamed to. Checks: the version resource (`ProductName` *Anemo
Desktop*, `ProductVersion` the release's version exactly, or followed by the `+<commit>` .NET appends; not a
prefix, so `1.8.10` isn't taken for `1.8.1`; as `release.yml` checks it) and the
`--self-test` run. Only the published single-file exe updates: a `dotnet build` output is a
launcher beside `Anemo Desktop.dll`, and replacing only the launcher would break it. A Windows
sign-out or shutdown (`SystemEvents.SessionEnded`) swaps a ready update in like a quit.

The exe isn't Authenticode-signed (no certificate yet), so Windows offers no stronger check. The
download has no *Mark of the Web* (it isn't a browser download), so SmartScreen doesn't ask again:
the trust is the checksum and, with a key, the signature.

### macOS (`Platform/MacUpdates.cs`)

The zip goes to `~/Library/Application Support/Anemo Desktop/updates/`, is unpacked with `ditto -x
-k` into a hidden folder beside the app (`.Anemo Desktop.update/`, same volume), and the bundle is
swapped in; the old one is kept as `.Anemo Desktop.old.app`. Checks:

- `codesign --verify --deep --strict` on the new bundle: every file is as it was signed;
- when the running app has a **Developer ID** signature (a Team ID), `codesign --verify --deep
  --strict -R='anchor apple generic and certificate leaf[subject.OU] = "<TEAM>"'` (arguments as a
  list, no shell): the new bundle's certificate chain must end at Apple's root and its leaf must
  belong to the **same team**. That is the strong check: someone who controls the GitHub release
  but not the Apple Developer certificate can't make a build this client accepts. The requirement
  is needed because `codesign -dv` only reports the Team ID a signature *claims* (a self-made
  certificate can claim any), and `--verify` without `-R` only checks a bundle against its own
  requirement. A Team ID that isn't ten capitals and digits isn't read, as it goes into the
  requirement's text;
- `codesign -dv` of both apps (`MacSignature.cs`): the same bundle identifier (`app.anemo.desktop`)
  always, and the same Team ID (again, after the requirement);
- the `--self-test` run of the new binary.

If the running app's own signature can't be read, there is nothing to compare a download with:
updates are **unavailable** (Settings says why) rather than accepting any signed bundle.

An **ad hoc** build (no Developer ID secrets in the repository, today's case) proves only that the
bundle is intact, not who made it: `codesign --verify` passes for anything anyone signed ad hoc.
And macOS ties Screen Recording and Accessibility to the signature, which is new with every ad
hoc build, so **after every update of an ad hoc build both permissions have to be allowed again**
(remove Anemo Desktop from both lists in System Settings → Privacy & Security, then allow it).
The Settings window says so under the switch, *Restart to update* shows it as a notice, and the
updated app's first notice says so too (its Permissions window opens as at every start without
them). A Developer ID build keeps them. Moving from ad hoc to Developer ID is accepted; back is not.

The download carries no quarantine attribute (it isn't a browser download), so Gatekeeper's
first-start check doesn't run for it; for a Developer ID build that would only repeat what the Team
ID check does. Only Apple Silicon is published, so an Intel Mac says it doesn't update itself.

## Signing (`Updates/UpdateSignature.cs`, release.yml)

**What the checksum alone protects against.** The checksum file comes from the same Release as the
file, over the same HTTPS. It catches a damaged or cut-off download and a wrong file. It does
**not** protect against anyone who can change the Release: they replace the exe and its line in
the checksum file together.

**The release key.** So the release job can also sign each checksum file: ECDSA P-256 with
SHA-256 (`openssl dgst -sha256 -sign`), over the bytes `anemo-desktop-update <tag>\n` followed by
the file, saved as `SHA256SUMS-desktop.txt.sig` / `SHA256SUMS-desktop-macos.txt.sig`. The tag in
the message means a signed file can't be moved to another release (e.g. an old version published
again as a "newer" one). The public key is compiled into the client (`-p:AnemoUpdatePublicKey`,
from the repository variable `DESKTOP_UPDATE_PUBLIC_KEY`, read by `UpdateOptions.FromBuild`). A
client with a key refuses a release without a valid signature; a client without one (a
development build, or before the key is set up) checks the SHA-256 only. ECDSA P-256 rather than
Ed25519/minisign because it is built into .NET 8 on Windows and macOS and into the runner's
openssl: no package, no extra tool.

Cost: an environment, one secret in it and one variable (desktop/README.md, *Signing updates*).
The secret belongs in the **`desktop-release` environment, restricted to `desktop-v*` tags**, not
in the repository's secrets: a repository secret can be read by any workflow run on any branch
(anyone who can push a branch can add a workflow that prints it), whereas an environment secret
only reaches a job that names the environment and runs on a ref the environment allows. Only
release.yml's `sign-desktop` job names it; it runs for a `desktop-v*` tag, after the build jobs
(which fail for a tag that isn't on main), has no write access, checks the signature with the
public key, and hands the `.sig` files to the release job, which publishes. A set public key
without the secret fails the release (instead of publishing one every client would refuse). The
tag restriction is only as strong as who may create `desktop-v*` tags: anyone with write access can
push one on any commit (a tag ruleset can limit that), and a tag's run uses the workflow file of
the tagged commit.

**What the key protects against, honestly:** someone who can edit or replace the Release's files
without being able to run the release workflow with its secrets: a leaked token with release
rights, a GitHub account session that edits a release by hand, tampering at GitHub's storage. It
does **not** protect against someone who controls the repository (write access to `main`, to
workflows, or the right to create `desktop-v*` tags): they can have the workflow sign whatever they
push, or read the secret. The macOS
Team ID check has the same limit, as the Developer ID certificate is a repository secret too
(`MACOS_CERTIFICATE_P12`). Against a repository owner, review of what reaches `main` is the real
boundary. Keeping the private key off GitHub
(signing by hand on a separate machine) would close that gap at the cost of automatic releases;
not done.

**Losing the key:** clients built with it can't update to builds signed with another key: install
the next version by hand once. **Until the key is set**, 1.8.0 checks checksums only; the first
release built with the variable set carries the key for the updates after it.

## Rate limits and privacy

One request every 6 hours per computer (plus *Check now*), mostly answered 304. GitHub sees the
computer's address and `User-Agent: Anemo-Desktop/<version>`; nothing else is sent (no token, no
device name, no Anemo address). A 403/429 says "GitHub's limit … was reached" and tries again in
an hour, as any failure to reach GitHub does.

## Files

| | Windows | macOS |
|---|---|---|
| Download | `<exe folder>\Anemo Desktop.download` | `~/Library/Application Support/Anemo Desktop/updates/Anemo-Desktop-macos-arm64.zip` |
| Staged | `<exe folder>\Anemo Desktop.new.exe` | `<app folder>/.Anemo Desktop.update/Anemo Desktop.app` |
| Previous version | `<exe folder>\Anemo Desktop.old.exe` | `<app folder>/.Anemo Desktop.old.app` |
| Marks | `%APPDATA%\Anemo Desktop\updates\started`, `failed` | `…/Anemo Desktop/updates/started`, `failed` |

A half download or an unused staged copy from an earlier run is removed at the next start (the
staged state isn't kept across runs: it is downloaded again).

## Testing

- `desktop/tests/Anemo.Desktop.Tests/Updates/`: versions (parsing, comparing, tags), release
  selection (drafts, pre-releases, voice and server tags, missing files, the newest wins),
  checksum files (both formats, the real 1.6.1 files, missing and ambiguous lines), signatures
  (right, other tag, other key, garbage, damaged key; and a one-off check that the workflow's
  exact openssl commands verify, done while building this), GitHub's addresses with a fake HTTP
  handler (URL, User-Agent, ETag and 304, size limits, 403/404/no network), the swap on a fake
  file system (moves, each failure and its undo, the broken case, the restart's watch, rollback
  after an exit or silence, a still-locked exe, a stale started-file), the updater (timing, ETag,
  ready, checksum mismatch, refusals, signature required, switched off, discard, failed version,
  retry after an hour, a newer release replacing a ready one, waiting while busy and restarting
  once, an unexpected exception failing one attempt and not the loop), the codesign parsing, the
  Team ID rule and its code requirement, an unknown running signature, product versions; `DesktopAgentTests` (the minute after a
  command; no update host, no update), `SettingsDraftTests` / `SettingsStoreTests` (the switch, an
  old settings file updates).
- `desktop/tests/Anemo.Desktop.Mac.Tests/MacUpdateTests.cs` (CI's macOS job): two tiny ad hoc
  signed bundles through `ditto`, `codesign --verify`, the identifier rule, a tampered bundle, the
  Apple-anchored requirement refusing an ad hoc bundle when the running app has a Team ID (the
  running signature is given by the test: CI has no Developer ID), no updates without the app's own
  signature, the self-test and the swap of bundles. A bundle signed with a self-made certificate
  that claims the team isn't built in CI; the requirement is what refuses it.
- By hand: `desktop/MANUAL-TESTS.md` *Updates* and `docs/specs/09-desktop-macos-mac-testing.md`
  *O*. The `--self-test` of a published win-x64 exe and renaming a running exe were checked on
  this Windows VM.

## Not built / later

- Installing by itself when idle (e.g. at night) without a quit: today a computer that never quits
  updates only when someone clicks *Restart to update*. One line in `Updater.TickAsync` once wanted.
- Authenticode signing of the exe (needs a certificate), delta updates, an Intel Mac build.
- Keeping the release key off GitHub (see *Signing*).
- A watched install at quit (the next start isn't watched; the self-test and `Previous` cover it).
