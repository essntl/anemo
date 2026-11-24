# Anemo Voice: what only a real phone can test

`./gradlew test` covers the logic against a fake Anemo (see README.md). These need a real
phone (Android 10 or later), a real Anemo with a transcription model, reached through
Nginx Proxy Manager with *Websockets Support* on, and a phone device token from
Settings → Devices. Write down the phone, the Android version and what you saw.

## Setup and the notification

- [ ] Install the debug APK; Settings: address, token, wake word, **Download** next to the
      models (needs internet to github.com); Save. "Models … ready" shows.
- [ ] Start listening: the app asks for the microphone and (Android 13+) notifications.
      With notifications denied, it does **not** listen and says why.
- [ ] The notification "Anemo is listening for Hey Jarvis" shows before anything is heard,
      stays while listening, and the status bar shows Android's microphone indicator only
      while it shows.
- [ ] Pause: the microphone indicator goes away; Resume brings it back. Stop: notification
      and indicator go away.
- [ ] Quick-settings tile: add it, switch on and off; its state follows the app.
- [ ] Android 14+: swipe the app away, then tap the tile: it either starts listening or
      opens the app, and never crashes.
- [ ] Anemo's Settings → Devices shows the phone as connected (WebSocket through NPM).
- [ ] While listening, block the "Listening" channel in Android's app settings: listening
      stops and a "stopped listening" notification says why.
- [ ] While listening, turn all of Anemo Voice's notifications off: listening stops.
- [ ] Android 14+: swipe the listening notification away: listening stops.
- [ ] With the channel blocked, Start listening refuses and says why.
- [ ] Android 15: the main screen, Settings (the Save button) and About are not under the
      status or navigation bar.
- [ ] About (the ⓘ button) shows the notices; "ONNX Runtime notices" too.

## Wake word and recording

- [ ] Say the wake word from 1 m and 3 m: the start sound plays; speak; after about a
      second of silence the stop sound plays.
- [ ] Talk for more than 60 s: it stops at 60 s.
- [ ] Wake word, then say nothing: after 5 s the timeout sound (a low double note) plays
      and nothing is sent (no request in Anemo).
- [ ] False wakes: leave it listening for an hour with a TV or radio on and during a
      conversation; count false starts at each sensitivity (Low / Medium / High).
- [ ] A custom `.onnx` word: import, choose "your own word", name it; the notification
      uses the name, and it wakes on it.
- [ ] "Cancel" / "never mind" as the whole recording: nothing happens, nothing spoken.

## Answers

- [ ] Wake word → "what's on my calendar tomorrow" → a run starts in the Voice chat, the
      answer is spoken, and the history shows heard / request / answer; tapping it opens
      the chat in the browser.
- [ ] Music playing: it ducks while the answer is spoken, and comes back after.
- [ ] Within Anemo's follow-up window (Settings → Voice, 5 minutes by default): "and move it
      to Friday" continues the same chat. After it, a new turn starts.
- [ ] The **Status** button in the app speaks what is running (the notification has
      Pause, Voice mode and Stop since 1.1.0).
- [ ] Anemo without a transcription model: the phone speaks Anemo's message, which names
      the setting.
- [ ] Wake word, then a cough only: Anemo's "Sorry, I didn't catch that." is spoken.
- [ ] TTS voice and speed from Settings are used (try a different voice and 1.5×).

## Questions, approvals and plans by voice

- [ ] A run that uses `ask_user`: the question and its options are spoken, then it listens
      without the wake word (start sound); answer; the run goes on with the answer.
- [ ] An approval (a safe/normal action): "‹summary›. Allow?" → "yes" → allowed; another
      → "no" → denied. The audit log shows `source: "voice"`.
- [ ] Mumble twice: it asks once more ("Sorry, was that a yes?"), then says "Please answer
      on the notification".
- [ ] Silence after "Allow?": after 8 s it stops listening; the notification's buttons
      still decide it.
- [ ] A dangerous action: "‹summary›. That one needs a tap." and it does not listen; the
      push notification's Allow / Deny decides it.
- [ ] Plan review on: "Here is the plan", up to six steps, "and N more", "Go ahead?" →
      "yes" accepts the plan.
- [ ] Decide an approval in the web app while the phone is asking: the phone stops.
- [ ] Two approvals at once: they are asked one after the other, each with the reply
      sound (also with "Start and stop sounds" off).
- [ ] An answer (voice.say) that arrives while you are speaking a request: it is spoken
      after the recording ends.
- [ ] A reply that goes on: it stops 15 s after you started speaking.

## Connection

- [ ] Airplane mode for a minute, then back: it reconnects by itself (notification shows
      "trying again"), and events from the gap still arrive (or the phone says nothing
      wrong).
- [ ] Delete the device in Anemo: within a minute the notification says the token was
      refused, and it stops reconnecting.
- [ ] A second phone install with the same token: the older one says "Another connection
      of this phone took over".
- [ ] A plain `http://` address is refused in Settings.
- [ ] Change the phone's trust level in Anemo while listening: it reconnects at once
      (close code 1012) and keeps working.
- [ ] A recording over the proxy's upload limit (if NPM has one): "Anemo did not accept
      the recording" (not "could not reach").

## The microphone taken away

- [ ] A phone call during listening: listening survives or recovers after the call; no
      speech is spoken over the call.
- [ ] Another app records (a voice recorder, a video call): the notification says when
      Anemo Voice stops, or it recovers afterwards; it never crashes.
- [ ] The answer is being spoken when a call comes in: speech stops.

## Bluetooth headset

- [ ] Connect a headset with "Use a Bluetooth headset's microphone" on: the wake word
      works through the headset microphone (Android 12+: `setCommunicationDevice`; Android
      10–11: SCO). Answers play in the headset.
- [ ] Connect and disconnect the headset while listening: input follows it.
- [ ] Disconnect the headset in the middle of a recording: the recording ends or is
      dropped, listening continues on the phone's microphone.
- [ ] Music quality in the headset while listening with the headset microphone (HFP is
      mono and narrow-band): note it; turn the setting off if it is too bad.
- [ ] Setting off: the phone's own microphone is used even with a headset connected.

## The cue and voice mode (Anemo Voice 1.1.0)

Needs an Anemo with this branch's server (`/api/voice/transcripts`). Write down the phone
(Xiaomi: MIUI or HyperOS, global or Chinese ROM), what you heard and felt, and the logcat
lines (`adb logcat -s AnemoVoice`).

1. [ ] **Cue on detection.** Say the wake word: the rising start sound and a buzz come at
       once, before you can start speaking (target: under 150 ms; film the phone with
       sound and count frames, or watch `wake word heard score=…` in logcat against the
       sound). No sound and no buzz = it didn't hear you.
2. [ ] **Media volume at 0.** Turn the media volume all the way down: the cue still plays
       (it follows the ring / system volume). Ring volume at 0 or silent mode: no sound,
       but the buzz.
3. [ ] **Xiaomi.** On the Xiaomi, with normal ring volume: the cues are audible (the
       sonification usage). If they are silent, note it: the fallback is the alarm usage
       (one line in `audio/ToneCues.kt`), Artem decides.
4. [ ] **Headset.** With a Bluetooth headset connected, the cue plays in the headset.
5. [ ] **Ducking.** Play music, say the wake word: the music gets quiet at once and comes
       back after the request (and again while the answer is spoken).
6. [ ] **One breath.** Say "Hey Jarvis what's on tomorrow" without a pause: the request in
       Anemo is "what's on tomorrow" (nothing lost at the start, no wake word in it).
7. [ ] **End and timeout sounds.** After a request: the falling end sound. Wake word and
       silence: the low double timeout sound after 5 s. All three sound different.
8. [ ] **Notification.** While you speak a request the notification's title is
       "Listening"; in voice mode the titles start with "Voice mode · ".
9. [ ] **Sound settings.** "Start and stop sounds" off: no start/end/timeout sounds, but
       the reply sound, the voice mode sounds and the buzz still come. "Vibrate with the
       sounds" off: no buzz at all.
10. [ ] **Voice mode from the tile.** Add the "Voice mode" tile; tap it while listening:
       the three-note "on" sound, the microphone opens. Tap it with listening off: it
       starts listening with voice mode on (or opens the app on Android 14+ if not
       allowed).
11. [ ] **Voice mode from the notification.** The notification's **Voice mode** button turns
       it on, **End voice mode** turns it off.
12. [ ] **"Start voice mode".** Wake word, pause, "start voice mode": voice mode goes on and
       nothing is sent to Anemo (no chat message). Then in one breath: "Hey Jarvis, start
       voice mode". Try a misheard variant ("start voice mood"). With the setting
       "Say “start voice mode”…" off it becomes an ordinary request.
13. [ ] **The conversation.** In voice mode ask something, hear the answer, then the start
       sound and the microphone opens again: ask a follow-up without the wake word. The
       chat stays the same (check in Anemo), also after the 5-minute follow-up window.
14. [ ] **No echo.** With the loudspeaker (no headset) and the volume up: the end of the
       spoken answer is not sent as the next request (look at the chat). Note whether the
       phone has an echo canceller (`AcousticEchoCanceler`).
15. [ ] **"Stop".** In voice mode say "stop": the falling three-note "off" sound, back to
       the wake word. "End voice mode" too. "Stop the music" is a normal request.
16. [ ] **Idle timeout.** In voice mode say nothing: after 45 s the "off" sound. Set 30 s in
       Settings → Voice mode and check again.
17. [ ] **The agent ends it.** In voice mode: "thanks, that's all, goodbye": the agent says
       goodbye and voice mode ends after it (the run's timeline shows `voice_stop`).
18. [ ] **Pause and Stop** end voice mode (the "off" sound).
19. [ ] **Audit log.** Settings → Audit log in Anemo lists each voice mode on/off with its
       cause (tile, notification, phrase, stop_phrase, timeout, voice_stop,
       service_stopped), the phone as the target, `agent` for voice_stop.
20. [ ] **Approvals in voice mode.** In voice mode, a request that needs an approval: it is
       asked with the reply sound, answered, and after the run's answer voice mode listens
       again.
21. [ ] **The wake word in voice mode** still starts a request while waiting for an answer.
22. [ ] **Older server.** With an Anemo without `/api/voice/transcripts`: requests still work
       (the recording is sent as before); voice mode can still be turned on from the tile.

## Reboot and battery

- [ ] Reboot: nothing listens until you open the app or tap the tile (by design).
- [ ] Battery: listen for 8 hours with the screen off; note the battery use shown in
      Android's settings, and whether Android stopped the service (some makers' battery
      savers do: allow "unrestricted" battery for the app if so).
- [ ] Doze: after an hour with the screen off, the wake word still works and the
      WebSocket still delivers answers.
