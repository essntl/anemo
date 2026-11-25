# Anemo Desktop: tests by hand on Windows

The automated tests (`tests/`) cover the protocol, the command logic and every refusal with
fakes. These need a real Windows desktop and a running Anemo (the integration branch's
throwaway stack is enough). Do them on a **test VM or a machine you don't mind the agent
using**, with a device made in Settings → Devices.

Note for each: pass / fail, Windows version, x64 or ARM64, display scale.

## Setup and connection

1. Start `Anemo Desktop.exe` with no settings: the Settings window opens; the tray icon is
   the Anemo mark on grey with an amber “!” (not set up). The exe, the taskbar button and the
   Settings window show the Anemo mark.
2. Paste an `http://` (non-local) address: refused with the https sentence. Paste the real
   address and token, save: the icon turns normal; Settings → Devices shows the device online.
3. Open `%APPDATA%\Anemo Desktop\settings.json`: no `anemo_` token in clear, only `protectedToken`.
   Copy the file to another Windows user and start the client there: it asks for a token again
   (DPAPI is per user).
4. Start a second copy of the exe in the same session: "already running", no second icon.
   Log in as another user (fast user switching): it starts there too (one per session).
5. Restart Anemo's containers: the icon goes grey, then normal again within a minute.
   Disconnect the network for 2 minutes, reconnect: same.
6. Delete the device in Anemo: within a minute the icon is grey with the amber “!” and a balloon
   says the token was refused; the client stops retrying. Paste a new token: it connects.
7. Start the same token on a second computer: the first one shows "Another copy … connected"
   and stops retrying (4409).
8. Paste a phone's token: after three tries, the 4400 sentence.
8a. **Through Nginx Proxy Manager** (the proxy host with *Websockets Support* on): the client
    connects; leave it idle for 5 minutes and check it stays connected (pings every 20 s keep
    it open past NPM's 60 s idle timeout) and the device stays online in Anemo.
8b. **Trust change while connected**: switch the device from watched to trusted in Settings →
    Devices. The client is closed with 1012, reconnects within seconds, and PowerShell works
    without restarting the client (and stops working when switched back to watched).
9. `%APPDATA%\Anemo Desktop\logs\connection-*.log`: no token anywhere (search for `anemo_`
   followed by more than the ellipsis).
10. Reboot: the client starts with Windows (`shell:startup\Anemo Desktop.lnk`). Switch "Start
    with Windows" off in Settings: the shortcut is gone.

## Looking (UI Automation and screenshots)

Ask the agent to look (`computer_look`) at each; check the screenshot, the refs and the text:

11. **Excel** (or LibreOffice Calc): the ribbon buttons, the name box and the cell grid appear
    as controls; the sheet's visible cells are readable in `text`.
12. **Word**: the document's text appears (TextPattern), up to 10 000 characters.
13. **A browser** (Edge and Chrome): a long page is cut at 300 controls / 40 000 characters
    with `truncated: true`; the look takes under ~6 seconds.
14. **Explorer**: folder items are list items with names; the address bar is an edit.
15. A window behind others (`look` with a `window_ref` from `windows`): a screenshot of that
    window, not of what covers it (PrintWindow).
16. Two monitors with different scaling (100 % and 150 %), one left of the primary:
    `what: "screen"` shows both; a click by `x, y` lands where the screenshot shows it on
    both monitors.
17. A 4K screen at 150 %: the screenshot is ≤ 1568 px wide; `scale` is about 2.45; clicks by
    coordinates land right.
18. The indicator ("Anemo is using this computer") never shows in the screenshots.

## Acting

19. Click a ref on a button (Notepad's menu, Excel's Bold): it works with the window moved or
    partly covered (Invoke). Click a ref on a control without Invoke: the window comes to the
    front and the mouse clicks its middle.
20. Click a button that opens a modal dialog (Notepad → Save As): the command returns within
    ~3 seconds and the next look shows the dialog.
21. Type into a ref (an edit with Value): the text replaces the field's content. Type with no
    ref into Notepad: the text appears where the cursor is, including line breaks, tabs, `é`,
    `ß`, `ж`, emoji.
22. Type into a password field (Windows sign-in dialog of an app, a browser login form): refused
    with "That is a password field…", nothing typed. Same with the focus in a password field
    and no ref.
22a. The ways around it, each refused with nothing entered in the password field:
    - click the password box, then `press ["s","e","c","r","e","t"]`;
    - `clipboard_set "secret"`, click the password box, `press ["Control+v"]`;
    - focus the user-name box of a login form, then `type "alice\tSecret!"` (the user name is
      typed, the Tab moves into the password field, the rest is refused);
    - `press ["Tab", "s"]` from the user-name box.
22b. A window whose controls UI Automation can't read (some games, remote-desktop windows):
    typing without a ref is refused with "can't tell which control has the focus".
23. Press `Control+s`, `Win+r`, `Alt+Space`, `ArrowDown`, `PageDown`: each works. `Control+Alt+Delete`
    is refused.
24. Scroll a list by ref and the front window without ref, in all four directions.
25. `focus_window` on a minimized window: it is restored and in front.
26. `open` "Notepad", "Calculator" (a store app), "Excel"; an ambiguous name ("Visual") gives
    the list; `https://example.com` opens in the default browser; `file:///C:/` is refused.
27. `clipboard_set` then paste by hand: the text is there.
28. With an elevated (Run as administrator) window in front: typing fails with the sentence
    about administrator, nothing hangs. A look at the elevated window (Task Manager run as
    administrator) still gives a screenshot; its controls may be missing (UI Automation can't
    read a higher integrity level): the look must not fail or hang.
29. The agent clicks where the Settings window or the Stop button is: refused ("Anemo Desktop's
    own window").

## Stop, pause, control off

30. While the agent types a long text: press **Ctrl+Alt+Shift+S**. Typing stops within a
    character or two; the tool call fails with "The user stopped control"; the tray icon gets an
    amber pause badge and its tooltip says "control paused until …"; a new action is refused; looking still works.
31. Same with the indicator's **Stop** button (the button works without taking the focus from
    the window being typed into).
32. While a PowerShell command runs (`Start-Sleep 60` on the VM): Stop ends it at once
    (no `powershell.exe`/`pwsh.exe` left in Task Manager).
33. *Pause control for 1 hour* from the menu, then *Resume control*: actions are refused, then
    allowed again (within 30 s for the server, at once in the client); the pause badge comes
    and goes with it.
34. Untick *Allow control*: actions and PowerShell are refused; looks still work; Anemo shows
    control off for the device. Restart the client: still off.
34a. Press the stop key, then quit and start the client again within the hour: control is still
    paused (the tray menu shows "Resume control (paused until …)"), actions are refused.
34b. Make `settings.json` read-only (or damage it) and start the client: a balloon says it
    started with control off; with the file read-only, the stop key still stops a command at once.
35. Change the stop key in Settings → This computer (click the key field, press `Ctrl+Alt+F9`;
    Esc keeps the old one): the new key works, the old doesn't. Pick a
    key another program has registered: a balloon says so.

## Shared screen

36. Menu *Share this screen with Anemo* and Ctrl+Alt+Shift+A with Excel in front: a balloon
    says shared; `computer_shared_screen` gives the screenshot and Excel's text (not the
    taskbar's).
37. With a UAC prompt open: sharing says the secure screen can't be read.

## Secure desktop

38. Trigger a UAC prompt, then let the agent look and click: `unavailable` with the secure-screen
    sentence; nothing is clicked. Same on the lock screen (Win+L).

## PowerShell (on the VM only)

39. Watched device, PowerShell on: `computer_shell` is refused by the client too (try by
    sending it from a test server or by switching the device's trust while connected).
40. Trusted device, PowerShell off: refused. On: `Get-ChildItem` runs in `%USERPROFILE%\AnemoWork`
    (or the folder in Settings), with pwsh when installed, else Windows PowerShell 5.1.
41. Output with Unicode (`'Grüße ✓'`) comes back intact. A command printing 100 000 lines comes
    back with head, marker and tail, `truncated: true`.
42. `Start-Sleep 30` with `timeout_s: 5`: fails after ~5 s with the timeout sentence; no process left.
42a. **Quit while PowerShell runs**: start `Start-Sleep 300` (and a child: `Start-Process notepad;
    Start-Sleep 300`), choose *Quit* in the tray menu (or end the client in Task Manager): no
    `pwsh.exe`/`powershell.exe` or its children are left (job object, kill on close).
43. A command that would prompt (`Read-Host`): fails fast instead of hanging (`-NonInteractive`).

## The command log

44. After a session: `%APPDATA%\Anemo Desktop\logs\commands-<day>.jsonl` has one line per
    command with action, summary and outcome; no typed text, no clipboard text, no
    PowerShell command, no screenshot. Files older than 7 days are deleted (set a file's
    name to an old date and send one command).

## The VM

47. The VM is used through a **console session** (Hyper-V/VMware/Proxmox console, or an RDP
    session that stays connected). Disconnect the RDP session (close the RDP window without
    signing out): screenshots come back black or fail and input is ignored, because Windows has
    no interactive desktop for a disconnected session. Check that looks then fail with a clear
    sentence or a black screenshot rather than hanging, and that it works again after
    reconnecting (or after `tscon <session id> /dest:console` from an elevated prompt in the VM).

## Screenshots: Windows.Graphics.Capture and the GDI fallback

48. On Windows 11: looks show no yellow border. On Windows 10: a yellow border flashes briefly
    around the screen or window during each look (Windows draws it; it can't be switched off
    there). Note whether that is acceptable.
49. A window behind others (`look` with a `window_ref`): Chrome, Edge, a video player and a game
    in windowed mode show their real content, not black.
50. In a VM without a GPU (WARP) and over RDP: looks still work (Windows.Graphics.Capture on WARP,
    or the GDI fallback).

## Claude Code jobs (Anemo Desktop 1.1.0, the Code page)

Needs `C:\anemo-bridge\cc.ps1` and Claude Code on the computer, and an Anemo with the Code page.

51. **Off by default**: a fresh client's Settings window shows "Share Claude Code jobs with
    Anemo" switched off (Settings → Claude Code), with the sentence about what is sent. Start a job with `cc.ps1`: nothing
    appears on the Code page; `connection-*.log` has no "code job" line.
52. **Trusted device, sharing on**: make the device trusted in Settings → Devices, tick the
    box, save (no restart). Within a few seconds the jobs of the last 3 days appear on the Code
    page (older ones don't; none of them notifies). Start a job with `cc.ps1`: it appears as
    running within ~2 s, its tool calls and todo list fill in live, the branch shows (from
    `.git\HEAD`, also in a `git worktree` folder); when it ends the state becomes done (or
    failed) with turns, duration and cost, and one notification arrives.
53. A job that writes a lot (ask it to read a large file or print 50 000 lines): the page keeps
    up; big tool results show "trimmed"; `out.jsonl` on the computer is complete and untouched.
54. **Watched device**: switch the device to watched in Settings → Devices (the client reconnects
    by itself). Start a job: nothing new on the Code page; the device's offer has `code: false`.
    Switch back to trusted: the job appears and catches up, without restarting the client.
55. **Reconnect mid-job**: start a long job (`cc.ps1` with "count slowly to 200, one Bash
    `Start-Sleep 1` per number"), then pull the network (or restart Anemo's containers) for a
    minute. When it is back, the job goes on where it stopped: no missing and no doubled tool
    calls. Quit and start the client during a job: same.
56. **The job ends while the client is closed**: quit the client, let a job finish, start the
    client: the job shows done with all its events; the notification arrives once.
57. **Cancelled / crashed**: create `cancelled` in a running job's folder and end its `cmd.exe`
    in Task Manager: the state becomes cancelled (no notification). End another job's `cmd.exe`
    without the marker: "exited without result", with the end of `err.txt`, and a notification.
58. **Sharing off**: untick the box and save: running jobs stop updating on the page within
    seconds, no reconnect; stored jobs stay. Tick it again: jobs of the last 3 days are sent
    again, already-finished ones are not sent twice.
59. **A changed jobs folder**: set "Jobs folder" to another folder with a copied job: it appears
    without a restart.
60. `%APPDATA%\Anemo Desktop\code-jobs.json`: per job only `acked_seq`, `acked_offset`,
    `sent_state`, `settled` (no prompt, no output). Damage the file (type garbage into it) and
    restart: the client starts, jobs carry on from Anemo's acks, nothing is lost or doubled.
    `connection-*.log` has only "code job discovered/ended: <id>" lines, no prompts or output.

## Starting Claude Code jobs (Anemo Desktop 1.2.0)

Needs Claude Code (`claude`) on PATH, `gh` signed in (`gh auth status`), git, and an Anemo
with the Code page's phase 2.

61. **Off by default**: the Settings window shows "Let Anemo start Claude Code jobs" switched
    off with the bypassPermissions sentence; it is greyed out while sharing is off, and so are
    the Projects folder and GitHub owner while it is off. In Anemo,
    the Code page offers no "New job" for this computer; an agent's `code_start` is refused.
62. **Turn it on** (trusted device, sharing on): tick it, save (no restart). The Code page's
    "New job" lists this computer, its folders in `C:\dev` (with their GitHub remotes) and the
    owner's repositories not cloned yet. Without `gh` on PATH (rename it for a moment): only
    local projects, and a note saying why.
63. **Start from the Code page** in an existing project: within a few seconds the job shows
    running; no console window opens; `C:\anemo-bridge\jobs\<id>\` holds `prompt.txt` (UTF-8,
    the prompt with its line breaks and non-ASCII text intact), `meta.json` (with `pid`,
    `model`), `out.jsonl`, `err.txt`. Task Manager shows `cmd.exe` → `claude` (node). Quit
    Anemo Desktop: the job keeps running; start it again: it catches up.
64. **Follow-up**: on a finished job, send a follow-up: a new job starts with
    `--resume <session>` (see `meta.json`'s `resume`), in the earlier job's folder (also one
    outside `C:\dev`, e.g. a job `cc.ps1` started elsewhere), and joins the thread on the page.
    Delete or rename that folder and follow up again: "The folder of job … is gone.", nothing
    cloned or made.
65. **Cancel**: cancel a running job from the page: `cmd.exe` and `claude` are gone within a
    second or two, the `cancelled` file exists, the page shows cancelled and no notification
    arrives. Cancel a job that already finished: the page keeps its state; nothing is killed.
66. **Clone**: start a job in a large repository of the owner that isn't in `C:\dev`: the page
    shows the job running within seconds (the job folder holds `starting` and a `meta.json`
    without pid) while it is cloned (with `gh`; with `gh` off PATH, with `git clone
    https://github.com/<owner>/<name>.git`), then the job runs in it and `starting` goes.
    Cancel a second one while it is still cloning: the clone stops, no half clone is left, the
    job is cancelled. A name that isn't a repository and "new project" unticked: the job ends
    "exited without result" with "There is no project … in C:\dev or on GitHub (…)" as its
    stderr tail, and no folder is left behind.
66a. **No owner**: clear "GitHub owner" in Settings: the owner is the account `gh auth status`
    shows. Sign out of gh (`gh auth logout`): the page lists no repositories and says to sign
    in or set an owner; starting a job in a project that isn't in `C:\dev` (not new) fails at
    once, nothing is cloned.
66b. **A repository with its own claude.cmd**: put a `claude.cmd` that writes a file into a
    project's root and start a job there: the real Claude Code runs, the file isn't written.
    In Task Manager (command line column), cmd.exe names claude by its full path.
67. **New project**: "new project" ticked with a new name: `C:\dev\<name>` is made with
    `git init`, and the job runs in it.
68. **Claude missing**: take `claude` off PATH (rename its folder in PATH for a moment) and
    start a job: "Claude Code (claude) isn't on this computer's PATH.", nothing cloned or made.
69. **Paused / watched / off**: press the stop key, then start a job: refused (cancelling still
    works). Make the device watched: listing, starting and cancelling are refused. Untick
    starting: the page's "New job" goes within 30 s; starting and cancelling are refused,
    listing still works.
70. Hostile values from a test server (`project` `..\Windows`, `nul.txt`, `...`, `model` `opus & calc`, a
    prompt with `" & calc & "` and `%PATH%`): the bad fields are refused with a sentence;
    the prompt runs as text (Claude Code sees it literally), no calculator opens.
    `logs\commands-<day>.jsonl` has `code_start` with the job id and the prompt's length only.

## Files between the computer and the workspace (Anemo Desktop 1.7.0)

On the VM (trusted) and on a watched PC. In Anemo, *Files on your computers* at its default
(*Always ask*). The contract is `docs/device-contracts.md` §8.

71. *Let Anemo read and write files* off (the default): the turn context's line of the computer
    has no `files on`; asking the agent to fetch a file is denied without a question, no command
    reaches the client (`logs\commands-<day>.jsonl` has no `file_*` line). Tick it and Save: within
    30 s the line says `files on`.
72. **Get**: "Copy `C:\Users\<you>\Documents\<a 20 MB PDF>` from VM to `inbox/`": asked once
    (*Copy … from VM to the workspace*); the file appears in Files with the same size; its SHA-256
    (`Get-FileHash`) matches the server's (`sha256sum` in the workspace). The run's file changes
    list it; *Revert* moves it to the trash.
73. **Put**: "Put `inbox/report.pdf` on VM as `C:\Users\<you>\Desktop\report.pdf`": asked; the
    file appears on the desktop only at the end (during a large copy only a hidden
    `.report.pdf.anemo-xxxxxxxx.part` is there: show hidden files in Explorer), same hash. Again
    without overwrite: refused, "already exists". With overwrite: asked as **dangerous**, the file
    is replaced.
74. **Folders**: try `C:\Users\<you>\.ssh\id_ed25519`, a `.bat` in
    `C:\Users\<you>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`,
    `%APPDATA%\Anemo Desktop\settings.json`, `C:\Windows\win.ini`, `\\server\share\x`,
    `C:\Users\<you>\x.txt:stream`: each refused with a sentence, nothing written. A junction in
    Documents pointing at `C:\Windows` (`mklink /J`): a file through it is refused. Set *Folders for
    files* to `D:\Shared`: the home folder is refused, `D:\Shared` works; a relative folder can't be
    saved.
75. **Size**: Settings → Devices → *Largest file* 1 MB: a 2 MB file is refused before any chunk
    (one `file_stat` in the command log). Back to 50.
76. **Broken copy**: during a 150 MB put (largest file 200 MB) quit Anemo Desktop: no file under the
    final name; the hidden `.part` file stays (delete it by hand). During one, pull the network:
    within a minute the `.part` file is gone (the 60 s rule) and the agent's call failed.
77. **Stop**: press the stop key during a large copy: the call fails ("stopped"), the `.part` file
    goes; copies are refused until the pause ends. *Allow control* off alone doesn't stop copies.
78. **Watched**: on the watched PC with the switch on: denied without asking, and the client
    refuses too (send `file_stat` from a test server).
79. Unicode names (`Grüße ✓.txt`), a 0-byte file and a file open in Word (read: works; replacing it
    with overwrite: Windows may refuse, a sentence comes back) behave.
80. The command log: `file_*` lines have paths, offsets and sizes, never contents.

## Platforms

45. All of the above on **Windows 10 22H2 x64**, **Windows 11 x64**, and the ARM64 build on a
    **Windows 11 ARM64** machine (Surface Pro X / Snapdragon laptop / ARM VM).
46. Display scale 100 %, 125 %, 150 %, 200 %: the tray icon, the tray menu, the Settings window
    and the indicator look right; coordinates land right.
46a. Switch Windows between light and dark (Settings → Personalisation → Colours): an open
    Settings window follows at once; the tray menu follows the taskbar the next time it opens;
    the indicator follows the apps' mode the next time it shows. Windows 10: square corners and
    a painted red edge on the indicator; Windows 11: rounded corners.
