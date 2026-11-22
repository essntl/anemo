# Anemo Voice: what only a real phone can test

`./gradlew test` covers the logic against a fake Anemo (see README.md). These need a real
phone (Android 10 or later), a real Anemo with a transcription model, reached through
Nginx Proxy Manager with *Websockets Support* on, and a phone device token from
Settings → Devices. Write down the phone, the Android version and what you saw.

## Setup and the notification

- [ ] Install the debug APK; Settings: address, token, wake word, **Download the wake word
      models** (needs internet to github.com); Save. "Models … ready" shows.
- [ ] Start listening: the app asks for the microphone and (Android 13+) notifications.
      With notifications denied, it does **not** listen and says why.
- [ ] The notification "Anemo is listening for Hey Jarvis" shows before anything is heard,
      stays while listening, and the status bar shows Android's microphone indicator only
      while it shows.
- [ ] Pause: the microphone indicator goes away; Resume brings it back. Stop: notification
      and indicator go away.
- [ ] Quick-settings tile: add it, switch on and off; its state follows the app.
- [ ] Anemo's Settings → Devices shows the phone as connected (WebSocket through NPM).

## Wake word and recording

- [ ] Say the wake word from 1 m and 3 m: the start sound plays; speak; after about a
      second of silence the stop sound plays.
- [ ] Talk for more than 60 s: it stops at 60 s.
- [ ] Wake word, then say nothing: after 5 s it stops and nothing is sent (no request in
      Anemo).
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
- [ ] Within 5 minutes: "and move it to Friday" continues the same chat. After 5 minutes a
      new turn starts.
- [ ] The **Status** button (app or notification) speaks what is running.
- [ ] Anemo without a transcription model: the phone says so and names *Transcription*
      in *Settings, Providers and Models*.
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

## Connection

- [ ] Airplane mode for a minute, then back: it reconnects by itself (notification shows
      "trying again"), and events from the gap still arrive (or the phone says nothing
      wrong).
- [ ] Delete the device in Anemo: within a minute the notification says the token was
      refused, and it stops reconnecting.
- [ ] A second phone install with the same token: the older one says "Another connection
      of this phone took over".
- [ ] A plain `http://` address is refused in Settings.

## Bluetooth headset

- [ ] Connect a headset with "Use a Bluetooth headset's microphone" on: the wake word
      works through the headset microphone (Android 12+: `setCommunicationDevice`; Android
      10–11: SCO). Answers play in the headset.
- [ ] Connect and disconnect the headset while listening: input follows it.
- [ ] Setting off: the phone's own microphone is used even with a headset connected.
- [ ] Note the effect on music quality while listening through the headset (SCO/HFP is
      mono, narrow-band).

## Reboot and battery

- [ ] Reboot: nothing listens until you open the app or tap the tile (by design).
- [ ] Battery: listen for 8 hours with the screen off; note the battery use shown in
      Android's settings, and whether Android stopped the service (some makers' battery
      savers do: allow "unrestricted" battery for the app if so).
- [ ] Doze: after an hour with the screen off, the wake word still works and the
      WebSocket still delivers answers.
