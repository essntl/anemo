# Anemo Desktop: tests by hand on Windows

The automated tests (`tests/`) cover the protocol, the command logic and every refusal with
fakes. These need a real Windows desktop and a running Anemo (the integration branch's
throwaway stack is enough). Do them on a **test VM or a machine you don't mind the agent
using**, with a device made in Settings → Devices.

Note for each: pass / fail, Windows version, x64 or ARM64, display scale.

## Setup and connection

1. Start `Anemo Desktop.exe` with no settings: the Settings window opens; the tray icon is grey.
2. Paste an `http://` (non-local) address: refused with the https sentence. Paste the real
   address and token, save: the icon turns normal; Settings → Devices shows the device online.
3. Open `%APPDATA%\Anemo Desktop\settings.json`: no `anemo_` token in clear, only `protectedToken`.
   Copy the file to another Windows user and start the client there: it asks for a token again
   (DPAPI is per user).
4. Start a second copy of the exe in the same session: "already running", no second icon.
   Log in as another user (fast user switching): it starts there too (one per session).
5. Restart Anemo's containers: the icon goes grey, then normal again within a minute.
   Disconnect the network for 2 minutes, reconnect: same.
6. Delete the device in Anemo: within a minute the icon is grey and a balloon says the token
   was refused; the client stops retrying. Paste a new token: it connects.
7. Start the same token on a second computer: the first one shows "Another copy … connected"
   and stops retrying (4409).
8. Paste a phone's token: the 4400 sentence.
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
23. Press `Control+s`, `Win+r`, `Alt+Space`, `ArrowDown`, `PageDown`: each works. `Control+Alt+Delete`
    is refused.
24. Scroll a list by ref and the front window without ref, in all four directions.
25. `focus_window` on a minimized window: it is restored and in front.
26. `open` "Notepad", "Calculator" (a store app), "Excel"; an ambiguous name ("Visual") gives
    the list; `https://example.com` opens in the default browser; `file:///C:/` is refused.
27. `clipboard_set` then paste by hand: the text is there.
28. With an elevated (Run as administrator) window in front: typing fails with the sentence
    about administrator, nothing hangs.
29. The agent clicks where the Settings window or the Stop button is: refused ("Anemo Desktop's
    own window").

## Stop, pause, control off

30. While the agent types a long text: press **Ctrl+Alt+Shift+S**. Typing stops within a
    character or two; the tool call fails with "The user stopped control"; the tray shows
    "control paused until …"; a new action is refused; looking still works.
31. Same with the indicator's **Stop** button (the button works without taking the focus from
    the window being typed into).
32. While a PowerShell command runs (`Start-Sleep 60` on the VM): Stop ends it at once
    (no `powershell.exe`/`pwsh.exe` left in Task Manager).
33. *Pause control for 1 hour* from the menu, then *Resume control*: actions are refused, then
    allowed again (within 30 s for the server, at once in the client).
34. Untick *Allow control*: actions and PowerShell are refused; looks still work; Anemo shows
    control off for the device. Restart the client: still off.
35. Change the stop key in Settings to `Ctrl+Alt+F9`: the new key works, the old doesn't. Pick a
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
43. A command that would prompt (`Read-Host`): fails fast instead of hanging (`-NonInteractive`).

## The command log

44. After a session: `%APPDATA%\Anemo Desktop\logs\commands-<day>.jsonl` has one line per
    command with action, summary and outcome; no typed text, no clipboard text, no
    PowerShell command, no screenshot. Files older than 7 days are deleted (set a file's
    name to an old date and send one command).

## Platforms

45. All of the above on **Windows 10 22H2 x64**, **Windows 11 x64**, and the ARM64 build on a
    **Windows 11 ARM64** machine (Surface Pro X / Snapdragon laptop / ARM VM).
46. Display scale 100 %, 125 %, 150 %, 200 %: the tray icon, the Settings window and the
    indicator look right; coordinates land right.
