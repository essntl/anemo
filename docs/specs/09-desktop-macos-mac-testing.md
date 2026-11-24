# Anemo Desktop for macOS: the first run on a real Mac (checklist)

Nothing in the macOS client has run on a Mac yet (`09-desktop-macos.md` §9). Go through
this list in order on an Apple Silicon Mac with macOS 14 or later, and write down for each
step **OK** or what happened (a screenshot, the last lines of the log). Steps marked
**(2nd Mac)** need a second display or a non-Retina display; skip them if there is none.

Before you start:

- An Anemo you can reach from the Mac, a device for it (Settings → Devices → *Add a
  device*, kind computer, **watched** first) and its token.
- The build: the `anemo-desktop-macos` artifact of the pull request's CI run (*Desktop
  (macOS)* job), or build it yourself (`desktop/README.md` → *macOS*).
- Logs: `~/Library/Application Support/Anemo Desktop/logs/`. Keep a Terminal open with
  `tail -f ~/Library/Application\ Support/Anemo\ Desktop/logs/*.log`.
- Use a user account you don't mind giving the agent: every step below lets Anemo look at
  that screen.

## 1. Install and open

1. Unzip, move `Anemo Desktop.app` to `/Applications`.
2. Double-click it. Expected (ad-hoc build): Gatekeeper says it can't check the developer.
   Right-click → **Open** → **Open** (or `xattr -dr com.apple.quarantine "/Applications/Anemo Desktop.app"`).
3. Expected: no Dock icon; an Anemo icon in the menu bar (grey); the **Permissions**
   window opens. Note whether it opens in front.
4. Open the menu bar item: status says not connected / no token.
5. Open it a second time from Finder: expected, no second menu bar icon (one instance).

## 2. Permissions (TCC)

6. Permissions window: both lines say *not allowed yet*.
7. Screen Recording → **Ask macOS**. Expected: macOS's own prompt (once). Choose *Open
   System Settings*, switch on Anemo Desktop. Is **Anemo Desktop** listed (not
   `AnemoMacHelper`)? Write down which name appears.
8. macOS may ask to quit and reopen: use **Quit and reopen** in the window (or quit from
   the menu bar and open again). Expected: Screen Recording now *allowed*.
9. Accessibility → **Ask macOS**. Expected: the system prompt; *Open System Settings*;
   switch on Anemo Desktop. Again note the name in the list. **Check again**: *allowed*
   (no restart should be needed).
10. If in 7 or 9 the helper (`AnemoMacHelper`) showed up instead of the app, or the app
    stays *not allowed* although its switch is on: write it down; this is the main open
    question of the design (§2 of the spec).
11. Close the window; menu bar → **Permissions…** opens it again.

## 3. Settings and connection

12. Menu bar → **Settings…**: paste the address and token, Save. Expected: the icon turns
    normal (connected) within a few seconds; Anemo's Settings → Devices shows the device
    online with version 1.3.0.
13. Keychain Access → login → search "Anemo Desktop": one item, account `device-token`.
    `~/Library/Application Support/Anemo Desktop/settings.json` holds no token (only
    `keychain:v1`).
14. Quit and open again: connects without asking for the token.
15. Turn Wi-Fi off for a minute, on again: reconnects by itself.

## 4. Looking (watched device)

In an agent chat with Anemo, ask it to look at the Mac (`computer_look`).

16. "Look at my Mac": a screenshot of the display with the window in front, and the
    controls of that window (Finder or Safari: buttons, text fields with names). Compare the
    screenshot with the screen: nothing cut off, colours right, Anemo's own windows absent.
17. **Retina mapping** (built-in display): ask the agent to click a small, clearly named
    target by **coordinates** (e.g. "click the Apple menu at the top left using x/y, not a
    ref"). Expected: the click lands on it. Write down the `scale` from the tool result
    (expect below 1, e.g. 0.96).
18. "List the open windows" (`what=windows`): your windows with app names; minimized ones
    marked minimized.
19. "Look at the window <title>" (`what=window`): only that window.
20. Revoke Screen Recording in System Settings (switch off), then ask to look again.
    Expected: the tool answers that Screen Recording isn't allowed and asks you to grant
    it; nothing crashes. Switch it back on (maybe quit and reopen).

## 5. Acting (watched: every action is asked in Anemo)

21. Turn on *Allow control* in the menu bar menu. Ask: "open TextEdit". Anemo asks;
    approve. Expected: TextEdit opens (`open -a`).
22. "Type Hello Mac into the new document". Expected: the text appears; umlauts and
    emoji: try "Grüße 👋".
23. "Press Cmd+a then Cmd+c" (or "select all and copy"). Expected: the text is selected
    and copied (paste somewhere to check). This checks `Meta`/`Win` → Command.
24. "Scroll down" in a long web page in Safari: it scrolls.
25. "Click the Bold button" (a ref): Accessibility press works without moving the mouse.
26. "Bring the Finder window to the front" (`focus_window`), also with a minimized window.
27. **Password field:** open a login page in Safari (any site), click into the password
    field yourself, ask the agent to type into it. Expected: refused ("you may not type
    into it"), in the tool result and in the client's command log. Also try with focus
    in a native password field (System Settings → Users & Groups → change password
    dialog, cancel afterwards).
28. **Secure keyboard entry:** Terminal → menu Terminal → *Secure Keyboard Entry* on, focus
    TextEdit, ask the agent to type: expected refused, with the note that secure input is
    on. Switch it off again; typing works again.
29. Revoke Accessibility, ask to click: expected `unavailable` with the sentence to grant
    Accessibility; grant again.
30. Lock the screen (Ctrl+Cmd+Q) while the agent tries to act (ask from your phone, or
    another computer): expected refused (locked screen), no clicks on the lock screen.

## 6. Stop, Pause, control off

31. While the agent is acting (ask it to do something long, like typing a long text),
    press **Control+Option+Shift+S**. Expected: it stops at once, the tool fails with "The
    user stopped control", control is paused for an hour (menu shows Resume).
32. Menu bar → **Stop now** does the same.
33. *Allow control* off: the agent can still look, any act is refused.
34. While a command runs, the menu bar icon is red; back to normal afterwards.

## 7. Shared screen

35. Menu bar → *Share this screen with Anemo*; then in Anemo ask "what's on my shared
    screen" (`computer_shared_screen`). Expected: today's screenshot. Also the share
    hotkey (Control+Option+Shift+A by default).

## 8. Trusted: the shell

In Anemo → Settings → Devices, set the Mac to **trusted** (asks your password). The client
reconnects.

36. The agent's device line (ask "which computers do you see and which shell do they
    have"): expected "computer (macOS, shell: zsh), trusted, …".
37. In the client's Settings switch the **Shell** on. Ask "run `echo $SHELL; which claude
    gh git; echo $PATH` on the Mac". Expected: zsh, exit code 0, and PATH containing
    `/opt/homebrew/bin` and `~/.local/bin` if those exist (the login-shell PATH).
38. "Run `rm -rf ~/AnemoWork/tmp`": Anemo marks it dangerous (asks even when *Commands on
    your computers* is set to ask only for dangerous ones). `diskutil list` is safe-ish;
    `diskutil eraseDisk …` must be dangerous (don't approve it!).
39. A command that waits for input (`read x`) ends at once (stdin is empty), a `sleep 120`
    with timeout 5 is stopped after 5 s, and no `sleep` is left (`pgrep sleep`).
40. With bash as login shell (`chsh -s /bin/bash`, log out and in): the device line says
    bash. Put it back afterwards (`chsh -s /bin/zsh`).

## 9. Claude Code jobs (trusted, Claude Code installed and signed in)

41. Settings: tick *Share Claude Code jobs with Anemo* and *Let Anemo start Claude Code
    jobs*. Jobs folder empty = `~/anemo-bridge/jobs`, projects `~/dev`.
42. Anemo → Code → *New job*: the project list shows the folders in `~/dev` (and your
    GitHub repositories if `gh` is signed in).
43. Start a small job ("list the files and stop") in an existing project. Expected: the
    job appears live on the Code page with its events, then *done*. On the Mac:
    `~/anemo-bridge/jobs/<id>/` has prompt.txt, out.jsonl, err.txt, meta.json.
44. **Detached:** start a longer job ("count to 200 slowly with sleep 1 between"), then
    quit Anemo Desktop. `ps -o pid,pgid,command -ax | grep claude`: the job still runs,
    its pgid equals its pid. Open Anemo Desktop again: the job is still shown running.
45. **Cancel:** cancel it on the Code page. Expected: state *cancelled*; `ps` shows no
    claude (and none of the child processes it started, e.g. `sleep`) of that job.
46. A job in a project that isn't cloned yet (a GitHub repository from the list):
    cloned into `~/dev/<name>` and started.
47. A follow-up on a finished job (Continue): runs in the same folder with `--resume`.
48. **The bridge:** in Terminal: `node ~/path/to/anemo/bridge/cc.mjs projects`,
    `… start --project <name> --prompt "say hi"`, `… status --id <id>`, `… list`, `… cancel
    --id <id>` on a long job: same folder format, and the Code page shows those jobs too.

## 10. Displays (2nd Mac or an external display)

49. **(2nd Mac) Two displays:** put a window on the external display and bring it to the
    front. Look: the screenshot is that display, the note says "Display 2 of 2". Click by
    coordinates on it (as in 17): lands right.
50. **(2nd Mac) Display left of / above the main one** (System Settings → Displays →
    Arrange): repeat 49; coordinates there are negative in macOS, clicks must still land.
51. **(2nd Mac) Non-Retina display** (most external monitors at 1×): `scale` is 1 or above
    (e.g. 1.22 for 1920 px), clicks land.
52. **(2nd Mac) Mixed:** Retina built-in + 1× external, a window moved between them: the
    controls' clicks (refs) work on both.

## 11. Login item and updates

53. Menu bar → *Open at login* on. System Settings → General → Login Items lists Anemo
    Desktop. Log out and in: it starts, connects.
54. *Open at login* off: gone from the list.
55. **Update loses permissions (ad-hoc builds):** build or download a newer build, quit
    the app, replace it in /Applications, open it. Expected with an ad-hoc build: the
    Permissions window says *not allowed* although System Settings may still show the
    switches on. Fix: in System Settings remove Anemo Desktop with **–** from Screen
    Recording and Accessibility, open the app, grant again. Write down exactly what macOS
    showed: this goes into the README.
56. (Only once a Developer ID build exists) the same update keeps the permissions.

## 12. Quit

57. Menu bar → Quit: the icon goes, the device shows offline in Anemo within ~90 s, no
    `AnemoMacHelper` process is left (`pgrep -l AnemoMacHelper`).

Send the notes (and the log folder zipped; it holds no tokens or typed text) back with
the pull request or an issue.
