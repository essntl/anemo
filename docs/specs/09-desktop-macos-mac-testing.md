# Anemo Desktop for macOS: manual tests on a real Mac

Everything here was **not** tested while the Mac client was built (the build machine is a
Windows VM; CI's macOS runner has no screen permissions). Run it on an Apple Silicon Mac with
macOS 14 or later, logged in, with a second Anemo device you can watch from (the web app in a
browser on another computer or a phone). Note for each step: pass / fail / what happened, the
macOS version and the Mac model. A fail: copy the last lines of
`~/Library/Application Support/Anemo Desktop/logs/connection-<day>.log` (tokens are redacted).

Before you start: in Anemo, **Settings → Devices → Add a device**, kind *computer*, name
`Mac`, trust **watched**. Copy the token. Have the build: the `Anemo-Desktop-macos-arm64.zip`
from the PR's CI run (*Artifacts* → *desktop-macos*), or build it (`desktop/README.md`,
*macOS*).

## A. Install and first start

1. Unzip, move `Anemo Desktop.app` to `/Applications`. Double-click it. An ad-hoc signed build:
   macOS says it can't check it. System Settings → Privacy & Security → *Open Anyway* (or
   right-click → Open). Expected: it starts; no Dock icon; an Anemo mark appears in the menu bar
   (grey).
2. The Settings window opens by itself (no address yet). Paste the Anemo address and the token,
   Save. Expected: the menu bar mark turns dark within a few seconds; in Anemo, Settings →
   Devices shows `Mac` online.
3. The **Permissions** window opens (first start). Expected: it lists *Screen Recording* and
   *Accessibility*, both "not allowed", each with a sentence on what it is for, an *Allow…*
   button and an *Open System Settings* button. Nothing was asked of macOS yet.
4. Start it again (double-click the app while it runs). Expected: still one menu bar item (macOS
   brings the running copy forward; from Terminal, `open -n` or the executable prints "already
   running" and quits).
5. Open Keychain Access → login → search `Anemo Desktop`. Expected: one *application password*
   `Anemo Desktop` / `device-token`. `~/Library/Application Support/Anemo Desktop/settings.json`
   contains `"keychain:v1"` and **not** the token.

## B. Permissions: granting

6. In the Permissions window, *Allow…* next to Screen Recording. Expected: macOS's own prompt
   (or System Settings opens at Screen & System Audio Recording). Allow *Anemo Desktop*. macOS
   may say the app must quit and reopen: let it, or quit from the menu and start it again.
7. *Allow…* next to Accessibility. Expected: macOS's prompt "Anemo Desktop would like to control
   this computer using accessibility features" → *Open System Settings* → switch Anemo Desktop
   on (password or Touch ID). Expected: within ~2 s the window shows both as "allowed" without a
   restart (Accessibility doesn't need one).
8. Menu bar → *Permissions…* Expected: the window shows both allowed.

## C. Looking (watched device)

9. In an Anemo chat: "Look at the screen of Mac." Expected: a screenshot of the whole screen in
   the timeline, the window in front named with its app (e.g. `Finder`), a list of controls with
   refs and roles like `button`, `text field`, `menu item`. No question asked (looking is safe).
10. Open TextEdit with a document, "Look at the window in front on Mac." Expected: only that
    window, its text in *Window text*.
11. "List the windows on Mac." Expected: windows with refs, titles and apps; minimised ones
    marked; Anemo Desktop's own windows not listed.

## D. Retina, non-Retina and several displays

12. On the Mac's built-in Retina screen (Display settings: default scaled resolution): ask the
    agent to click a small button by **coordinates** (e.g. "click at the x, y of the Apple menu in
    the last screenshot"). Expected: the click lands on it (the mouse pointer moves there).
    Write down the `scale` the timeline shows (expected about 1.0 on a MacBook Air/Pro at the
    default resolution).
13. Display settings → a *larger text* scaled resolution and another *more space* one; repeat 12
    for each. Expected: the clicks land; the screenshot's size changes with the resolution.
14. With an external non-Retina monitor (1×, e.g. a 1080p screen) attached as a second display:
    "look at the screen". Expected: both displays side by side as arranged in Display settings.
    Click by coordinates on something on **each** display. Expected: both land.
15. Arrange the external display **left of** and then **above** the built-in one (Display
    settings → Arrange). Repeat 14. Expected: still lands (negative coordinates).
16. Make the external display the main one (drag the menu bar to it). Repeat 14.
17. With a window half on each display, "look at the window" and click a control on each half
    by ref. Expected: both work.

## E. Acting (watched: every action is asked)

18. In Anemo, the device is watched. "Open TextEdit on Mac and type Hello." Expected: Anemo asks
    before `open` and before `type`; after approving, TextEdit opens and "Hello" appears.
19. "Press Cmd+a then Cmd+c on Mac." Expected: asked; text selected and copied (check with
    Cmd+V elsewhere). Also `Win+a` behaves as Cmd+a.
20. "Click the Bold button in TextEdit's Format menu" by ref. Expected: the menu opens/acts via
    Accessibility (AXPress) without the pointer moving where possible.
21. Scroll a long web page in Safari: "scroll down 5 on Mac". Expected: it scrolls.
22. "Focus the Safari window" (`focus_window` with a ref from the list). Expected: Safari comes
    to the front, even from another Space only if macOS allows it (write down what happens).
23. "Open https://example.com on Mac." Expected: opens in the default browser. "Open Calculator."
    Expected: Calculator starts. "Open file:///etc/passwd" Expected: refused (only http/https).
24. "Put 'test 123' on the clipboard of Mac." Expected: Cmd+V pastes it.

## F. Passwords and refusals

25. Safari → a login page (e.g. `https://github.com/login`). Click into the password field
    yourself. Ask the agent to type `abc` there by ref and then without a ref. Expected: both
    **refused** ("That is a password field…"); nothing typed. Also "press a" → refused.
    "press Cmd+v" → refused.
26. Terminal → `sudo -v` (password prompt, Secure Keyboard Entry): ask the agent to type into
    Terminal. Expected: refused while the prompt waits (Secure Event Input is on).
27. Ask the agent to press Cmd+Ctrl+Q, Cmd+Option+Esc. Expected: refused.
28. Open System Settings (any page) and keep it in front. Ask the agent to look and to click
    there. Expected: both answered "unavailable" with a sentence about System Settings or a
    prompt being in front (the client doesn't look at or act on it). Same with a password
    prompt (e.g. installing something that asks for your password) in front.
29. Open the Anemo Desktop Settings window; ask the agent to click on it. Expected: refused (its
    own window).

## G. Stop, pause, indicator, Allow control

30. While the agent runs a slow action, press **Ctrl+Option+Shift+S**. Expected: the command is
    answered "stopped", control is paused for an hour (menu shows it), the indicator disappears.
31. Menu → *Resume control*. Then start an action: the indicator ("Anemo is using this computer"
    with Stop) appears top-right while the command runs and the menu bar mark turns red; Stop on
    it does what 30 does.
32. Menu → untick *Allow control*. Ask for a click. Expected: Anemo says control is off; looking
    still works.
33. Ctrl+Option+Shift+A (share). Expected: "Screen shared" notification; in Anemo, the agent can
    read it with `computer_shared_screen`.

## H. Trusted device and the shell

34. In Anemo, set `Mac` to **trusted** (password asked). Expected: the client reconnects (dark
    mark again within seconds).
35. Anemo Desktop Settings → tick *Shell (zsh)*. In a chat: "On Mac, run `uname -a; echo $SHELL;
    which git`". Expected: the turn context said `Mac: computer (macOS, shell: zsh)`; the tool
    shows `Mac% uname -a…`, exit code 0, Darwin and arm64 in the output, `git` found.
36. "On Mac run `rm -rf ~/AnemoWork/x`". Expected: rated **dangerous**, Anemo asks first.
    "`ls ~`" Expected: safe (not asked at the default levels).
37. "On Mac run `sleep 100`" with timeout 5. Expected: stopped after 5 s; `ps aux | grep sleep`
    shows no left-over `sleep`.
38. Untick *Shell*: the tool says the shell is switched off.

## I. Claude Code jobs

Needs `claude` installed and signed in (`claude` once in Terminal), `gh` signed in (`gh auth
login`), git.

39. Settings → tick *Share Claude Code jobs with Anemo* and *Let Anemo start Claude Code jobs*.
    `~/anemo-bridge/jobs` and `~/dev` are the defaults shown.
40. Code page → New job → the project list shows the folders in `~/dev` and the GitHub repos not
    cloned. Start a job in an existing project with "list the files". Expected: the job appears
    running; events stream in; it ends `done`. On the Mac: `~/anemo-bridge/jobs/<id>/` has
    `prompt.txt`, `out.jsonl`, `err.txt`, `meta.json` (with `"dir": "/Users/…/dev/<project>"`).
41. Start a job in a GitHub repo not cloned yet. Expected: cloned into `~/dev/<repo>`, then runs.
42. Start a long job ("count to 1000 slowly using sleep in bash"), then **Cancel** on the Code
    page. Expected: `cancelled` within seconds; `ps -A | grep -i claude` shows no process of
    that job (also not its `sleep`).
43. Quit Anemo Desktop while a job runs. Expected: the job keeps running (`ps`); start Anemo
    Desktop again: the job is still shown running and ends normally.
44. Follow-up: answer in the job's thread. Expected: runs in the same folder with `--resume`.
45. Start Anemo Desktop from Finder (not from Terminal) and repeat 40. Expected: `claude`, `gh`
    and `git` are still found (Homebrew in `/opt/homebrew/bin`, Claude in `~/.local/bin`).
46. The Node bridge: in Terminal, `node <repo>/bridge/cc.mjs start --project <name> --prompt
    "say hi"`, then `… status --id <id>`, `… list`, `… cancel --id <id>` on a long one. Expected:
    the job shows on the Code page as one started by the client does.

## J. Open at login

47. Settings → *Open at login* ticked (default). Expected: System Settings → General → Login
    Items lists Anemo Desktop. Log out and in: it starts.
48. Untick it: removed from Login Items.

## K. Revoking permissions

49. System Settings → Screen & System Audio Recording → switch Anemo Desktop **off**. Ask the
    agent to look. Expected: an answer saying Screen Recording isn't allowed and to ask the user;
    the Permissions window says "not allowed". No crash.
50. Accessibility → switch it **off**. Ask for a click. Expected: unavailable, with the reason;
    looking shows a screenshot with no controls and a note. The Permissions window updates.
51. Switch both on again: everything works again (Screen Recording may need a restart of the app).

## L. Update of an ad-hoc signed build (permissions are lost)

52. With both permissions allowed, install a **newer ad-hoc build** over the old one (quit, replace
    the app in /Applications, start). Expected (this is how macOS works, not a bug): the
    Permissions window shows both "not allowed" although System Settings still lists Anemo
    Desktop switched on. Fix: remove Anemo Desktop from both lists (the − button), then allow
    again (steps 6–7). Write down whether that was the case.
53. (Only once there is a Developer ID build.) Repeat 52 with two Developer ID-signed, notarized
    builds. Expected: the permissions stay.

## M. Removing

54. In Anemo, delete the device. Expected: the client shows "Anemo refused the token" within a
    minute. Quit, delete the app, the Keychain entry and
    `~/Library/Application Support/Anemo Desktop`.

## N. Files between the Mac and the workspace (Anemo Desktop 1.7.0)

The Mac `trusted`; Settings → *Let Anemo read and write files* ticked. Contract:
`docs/device-contracts.md` §8.

55. The turn context's line says `files on`. "Copy `~/Documents/<a 20 MB file>` from Mac to
    `inbox/`". Expected: asked once; the file is in the workspace, `shasum -a 256` on the Mac matches
    `sha256sum` on the server; the run's file changes can revert it.
56. "Put `inbox/<file>` on Mac as `~/Desktop/<file>`". Expected: the file shows on the desktop only
    when complete (Finder hides the `.<name>.anemo-<id>.part` file meanwhile; `ls -a ~/Desktop`
    shows it during a large copy). Again without overwrite: "already exists". With overwrite: asked
    as dangerous, replaced.
57. Refused, each with a sentence: `~/.ssh/id_ed25519`, `~/.zshrc`, `~/Library/LaunchAgents/x.plist`,
    `~/Library/Application Support/Anemo Desktop/settings.json`, `/etc/hosts`, a file through a
    symlink in `~/Documents` to `/etc` (`ln -s /etc ~/Documents/etc`). *Folders for files* set to
    `/Volumes/Shared`: the home folder is refused, that folder works.
58. Names with Unicode (as Finder writes them, e.g. `Grüße.txt`) and spaces: get and put work.
59. Stop key during a large copy: the call fails, the `.part` file goes. Untick the switch: within
    30 s `files on` is gone and a copy is refused.
