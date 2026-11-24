# Voice mode on Android, and a wake-word cue you can trust

Round 3, workstream B (`CONTRACTS-round3.md`). Builds on `05-voice-android.md`: the phone
listens for a wake word, records one request, and speaks the answer. Two things change:

- **B1. The cue.** Today it is not always clear whether the wake word was heard. After
  this change: *no cue means not heard*. The cue (a sound and a buzz) comes the moment
  the wake word is detected, and the request can follow the wake word in one breath.
- **B2. Voice mode.** A conversation without saying the wake word each time: after every
  answer the microphone opens again, until voice mode is turned off. Only the user turns
  it on; nothing the model says or does can.

## 1. The cue (B1)

### What happens when the wake word is detected

All of it happens in the voice loop on the frame in which openWakeWord's score reaches the
threshold (`VoiceController.onFrame`), before the next frame is read:

1. **Duck**: the phone asks for transient audio focus that lets others duck
   (`AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`, `USAGE_ASSISTANT`), so music gets quiet. The
   focus is given back when the recording ends (the answer takes its own focus while it
   is spoken, as before).
2. **Cue**: the start sound plays and the phone vibrates (`ToneCues`: a short PCM tone
   made in code, played from a static `AudioTrack`, and a `VibrationEffect`).
3. **Record from the detection on**: the frame that fired and the one before it
   (`Timing.preRollFrames = 2`, 160 ms) go into the recording first; then every frame
   after it. So "Hey Jarvis what's on tomorrow" said without a pause loses nothing.
   Those first frames are not given to the end-of-speech detector, so the wake word
   itself never counts as the request's speech (otherwise "Hey Jarvis" and silence would
   be uploaded instead of timing out).
4. **Log** the detection with its score (logcat: `wake word heard score=0.83`). Nothing
   else of the audio is logged.

Latency: a frame is 80 ms and the three ONNX models take a few ms each on a phone, so the
cue starts within one frame of the detection; a static `AudioTrack` starts in a few tens
of ms (a `ToneGenerator` on the music stream did too, but it can't be given an
`AudioAttributes` usage, see below). Target under 150 ms from the score crossing the
threshold. When the engines fall behind the microphone (the 2 s frame queue of
`VoiceSession`), the cue is late by that much; that is the only case and it is visible
in Android's profiler, not in the app. Measuring it needs a phone (`MANUAL-TESTS.md`).

### The sounds

Generated in code (`core/CueTones.kt`, pure, unit-tested: lengths, distinctness), no
sound files. Each sound has its own vibration pattern.

| Cue | When | Sound | Buzz | Plays with "Start and stop sounds" off? |
|---|---|---|---|---|
| start | wake word detected | two rising notes, 140 ms | one short | no |
| end | the recording ended: the input was taken, Anemo is thinking | two falling notes, 140 ms | one short | no |
| timeout | wake word heard, but no speech came within 5 s | one low note twice, 260 ms | two short | no |
| reply | the phone listens for a reply to a question, approval or plan (unchanged rule) | the start notes, higher | one short | **yes**: the microphone opens without a wake word |
| reopen | voice mode: the microphone opens again after an answer | the start sound | one short | **yes** |
| voice mode on | voice mode starts | three rising notes, 300 ms | long, short | **yes** |
| voice mode off | voice mode ends (any cause) | three falling notes, 300 ms | two long | **yes** |

"Vibrate with the sounds" (on by default) switches the buzz off; the setting "Start and
stop sounds" (existing) keeps switching off only the first three.

### Which stream the cues play on

The cue must not follow the media volume (music at 0 must not silence it), and it should
play where the user is listening (the headset when one is connected).

| Usage | Volume it follows | Why not / why |
|---|---|---|
| `USAGE_MEDIA`, `USAGE_ASSISTANT` (today's `STREAM_MUSIC`) | media | the problem we have |
| `USAGE_ASSISTANCE_ACCESSIBILITY` | media, unless an accessibility service is on | same problem on most phones |
| `USAGE_ALARM` | alarm | plays on the loudspeaker even with a headset, and through Do Not Disturb: too loud and too public for a cue |
| `USAGE_VOICE_COMMUNICATION` | call | may go to the earpiece and puts some phones into call audio mode |
| `USAGE_NOTIFICATION_EVENT` | notification (ring on older phones) | silenced by Do Not Disturb; notification-type sounds get the OEM's "notification" treatment (MIUI/HyperOS can delay or batch them) |
| **`USAGE_ASSISTANCE_SONIFICATION`** | **system sounds** (aliased to the ring volume on phones) | the usage Android documents for "user interface sounds"; follows the current route (headset); not media |

**Chosen: `USAGE_ASSISTANCE_SONIFICATION` with `CONTENT_TYPE_SONIFICATION`.** On a phone in
silent or vibrate mode, or with the system/ring volume at 0, the sound is silent: that is
what the buzz is for, and it is why the buzz is on by default. On Xiaomi phones (MIUI and
HyperOS, including Chinese ROMs) the "System" sounds volume follows the ring slider, and
the Chinese ROMs don't change how `AudioTrack` playback with this usage is routed; but
this can't be checked without the phone (`MANUAL-TESTS.md`). If it turns out silent there
in normal mode, the fallback is `USAGE_ALARM` (one line in `audio/ToneCues.kt`); Artem
decides after the manual test.

Vibration: `Vibrator.vibrate(VibrationEffect, VibrationAttributes(USAGE_ACCESSIBILITY))`
on Android 13+ (accessibility vibrations are the ones Android keeps when "touch feedback"
is off), `vibrate(VibrationEffect, AudioAttributes(SONIFICATION))` before. Needs the
`VIBRATE` permission (a normal permission, granted at install).

### The notification

While recording, the notification's title is **"Listening"** (it was "Anemo is
listening to you"); in voice mode "Voice mode · Listening". The other states keep their
titles ("Anemo is listening for ‹wake word›", "Anemo is speaking", "Anemo is paused"),
with "Voice mode · …" in front while voice mode is on.

### Echo

The phone never records while it speaks (the voice loop drops every frame in the
*Speaking* state, as before), so the spoken answer can't be transcribed as a request. What
is new: the microphone may open right after speech (voice mode). So:

- the first 240 ms of a voice-mode reopen are not recorded (`Timing.reopenSkipFrames`):
  the reopen cue itself and the last of the speech in the speaker's buffer;
- the `AudioRecord` gets Android's `AcousticEchoCanceler` when the phone has one
  (`AcousticEchoCanceler.isAvailable()`); the input source stays `VOICE_RECOGNITION`
  (tuned for speech recognition and the wake word). `VOICE_COMMUNICATION` would bring the
  call-grade echo canceller on more phones but changes gain and noise suppression for the
  wake word and may switch some phones into call audio mode; it stays the source only for
  a Bluetooth headset, as today.
- Barge-in (speaking over the answer stops it) is **not** built: it needs the microphone
  open while the phone speaks, and it can only be tuned on a phone. Listed under *Later*.

## 2. Voice mode (B2)

### What the user sees

- **Turn on**: the quick-settings tile **"Voice mode"** (a second tile next to the
  listening one), the notification's **Voice mode** button, or saying **"start voice
  mode"** (after the wake word; also in the same breath: "Hey Jarvis, start voice
  mode"). The spoken phrase can be switched off in the app's settings (on by default).
  The tile also starts listening when it isn't running.
- **While on**: the voice-mode-on sound, then the microphone is open (no wake word). Say
  your request; the end sound; the answer is spoken; the start sound; the microphone is
  open again. The notification says "Voice mode · …". The chat stays the same while voice
  mode is on (whatever the follow-up window says). Questions, approvals and plan reviews
  work as before; the wake word still works.
- **Turn off**: the tile or the notification's **End voice mode**; saying **"stop"** or
  **"end voice mode"** (only when that is all that was said); nobody speaking for 45 s
  (30, 45, 60 or 90 s in settings) after the microphone reopened; or the agent ending it
  when the conversation is clearly over (`voice_stop`, below). Pause and Stop end it too.
  Every one plays the voice-mode-off sound and goes back to waiting for the wake word.
- There is **no automatic follow-up window** on the phone: the microphone reopens only in
  voice mode. Outside voice mode one wake word is one answered turn, as today; the
  server's follow-up window (Settings → Voice) still continues the last chat.

### States

The voice loop (`VoiceController`) keeps its states (*Waiting* for the wake word,
*Recording*, *Speaking*, *Paused*, *Stopped*). Voice mode is a separate small state
machine (`core/VoiceMode.kt`, pure) that the loop asks at three moments: after a
recording is transcribed, after an answer is spoken, and when a recording without wake
word got no speech.

```
            tile / notification / "start voice mode"
   Off ──────────────────────────────────────────────▶ On(session n)
    ▲                                                    │
    │  tile / notification   "stop", "end voice mode"    │ enter sound, microphone opens
    │  idle timeout          voice.stop + answer spoken  ▼
    │  pause / stop                                   Listening (no wake word, idle timer)
    │◀──────────────── leave sound ──────────────────    │ speech, then 1 s silence: end sound
    │                                                    ▼
    │                                           Transcribed: a command? ── "stop" ─▶ Off
    │                                                    │ no
    │                                                    ▼
    │                                           Waiting for the run's answer
    │                                           (wake word, approvals as usual)
    │                                                    │ voice.say of that run, spoken
    │                                                    ▼
    └──── voice.stop came for that run ───────── reopen: start sound, Listening again
```

Rules the loop keeps:

- Each "on" is a new *session* number. An answer, a transcript or a timer from an older
  session never reopens the microphone.
- The microphone reopens only after the answer of the run the last voice-mode request
  started (or after the phone's own reply to it: "Sorry, I didn't catch that", a status,
  an error). Answers of other runs are spoken, nothing more.
- A reopen waits until nothing else is queued to be said (an approval read out first gets
  its own reply window, as before).
- The idle timeout counts from the reopen: no speech (Silero VAD) within it ends voice
  mode. Once speech starts the normal limits apply (1 s of silence ends it, 60 s at most).
- Leaving throws away what voice mode was recording (a request after the wake word goes
  on and is sent as an ordinary request); leaving while speaking lets the speech finish
  and doesn't reopen.
- Turning voice mode on while a request after the wake word is being recorded lets that
  recording go on: it is sent in voice mode and its answer opens the microphone.
- The first opening after voice mode goes on plays no start sound of its own: the "on"
  sound was the cue.

### The commands, and why the model can never open the microphone

The phone does no speech-to-text itself; the server's transcription model does. The
command phrases are matched **on the phone, on the raw transcript**, by plain code
(`core/Commands.kt`), never by a language model:

1. The phone uploads every request recording (after the wake word or in voice mode) to
   **`POST /api/voice/transcripts`**, which only transcribes it and answers
   `{"heard": "…"}`: no clean-up model, no run.
2. The phone matches `heard`. A command acts on the phone and nothing more is sent.
3. Anything else goes to `POST /api/voice/turns` as **`text`** (the transcript, with a
   leading wake word removed) instead of audio: the server cleans it up and starts the run
   exactly as for a recording (cancel and status words included). It isn't transcribed a
   second time. When only the wake word was heard, nothing is sent and the phone says
   "Sorry, I didn't catch that."

*Changed while building:* the first draft sent a recording in one call when no command
could apply (voice mode off, the phrase switched off). It now always takes the two steps:
one code path, and the wake word, which the recording now starts with (pre-roll), is
always taken off the request on the phone instead of hoping the clean-up model drops it.
The extra round trip costs one small HTTP request; the transcription is done once either
way. When `/voice/transcripts` answers 404 (an Anemo older than this app), the recording
goes to `/voice/turns` as before, so an updated phone keeps working with an old server
(without the spoken commands).

Why this design: the phone is the only thing that can switch its microphone, and the only
input to the matcher is what the transcription model heard the user say in a recording
the phone made after the wake word or a voice-mode reopen. The clean-up model's request,
a run's answer, `voice.say`, approvals, questions and anything else the agent writes
never reach the matcher. And the phone drops every microphone frame while it speaks, so
an answer that *says* "Hey Jarvis, start voice mode" out loud can't wake it either. A
server-side matcher would also have worked (it isn't a model), but then the server would
decide when the phone's microphone opens; this way the rules live in one place, on the
device that acts on them, and the server learns no phrase list.

Matching (`Commands.match`), on the whole utterance only:

- lower case, apostrophes dropped, everything that isn't a letter or digit is a space;
- leading words that are the wake word ("hey jarvis", "jarvis"; one letter off is fine
  for words of 5 letters or more) and filler words anywhere ("please", "ok", "okay",
  "um", "uh", "the", "now", "anemo") are dropped;
- the rest is compared with each phrase word by word. A phrase of three or more words
  matches with **one** misheard word, if that word is close (at most half its letters
  different: "mood" for "mode", "choice" for "voice", not "memo" or "recording", so "start
  voice memo" stays a request); a shorter phrase must match exactly. The closest phrase of
  either kind wins, *before* it is checked whether that kind counts now, so "stop voice
  mode" said while voice mode is off is never taken for "start voice mode"; a tie between
  a start and a stop phrase matches nothing.
- the end of the wake word also counts as the wake word when it is the first word ("…vis,
  start voice mode": the recording begins a little before the detection).
- Start phrases: "start voice mode", "turn on voice mode", "voice mode on", "enable voice
  mode", "begin voice mode". Stop phrases (only while voice mode is on): "stop", "stop
  voice mode", "end voice mode", "exit voice mode", "turn off voice mode", "voice mode
  off". Not "that's all" or "thanks": ordinary words must not end it by accident (the
  agent's `voice_stop` covers a conversation that is clearly over).
- "start voice mode" said while voice mode is on reopens the microphone (nothing sent);
  "stop" said while it is off is an ordinary request (as today).

### `voice_stop`: the agent may end it, never start it

A tool in `tools/builtin/voice.py`, capability `voice.control` (category "Voice mode",
default "Fully autonomous": ending voice mode can do no harm; actions are `safe`):

- **Input**: none.
- **Offered** only to runs a phone started (`runs.options.source == "voice"` with a
  `device_id`, top-level runs). Why not to every run: in any other chat it would be a tool
  that can do nothing, read by the model on every turn. Why not only when voice mode is
  on: the tool list is part of the prompt cache and fixed for a session
  (`docs/claude-code.md`): toggling it per turn would miss the cache on every switch. A
  Voice chat is spoken to from the phone, so its runs keep one tool list; a turn typed
  into a Voice chat in the web app costs one expected cache miss ("changed tool list"),
  like a computer coming online does today. Whether voice mode is on is said in the turn
  note (the turn context, after the cached prefix), not in the tool list.
- **Runs**: in a run that wasn't started with voice mode on (`runs.options.voice_mode`),
  it returns an error result ("Voice mode isn't on"). Otherwise it publishes the global
  event `voice.stop` `{run_id, conversation_id, device_id}`; the device WebSocket passes
  it on to the phone that started the run (`phone_events.py`, like `voice.say`). Idempotent.
- **The phone**: remembers that run; when its answer has been spoken, voice mode ends
  (cause `voice_stop`) instead of reopening. A `voice.stop` while voice mode is off, or
  for a run of an older session, does nothing.
- The turn note of a voice-mode turn adds: "Voice mode is on: after your answer is read
  out, the phone listens again for the user's next request. When the conversation is
  clearly over (the user says that's all, thanks you and says goodbye), call voice_stop;
  never call it otherwise."

There is no tool, event, setting or response by which anything on the server turns voice
mode on or opens the microphone.

### Recording on/off: the audit log

Anemo has no activity log (`CONTRACTS-round3.md` §1). Each change is:

- sent by the phone on its WebSocket: `{"type": "voice.mode", "on": bool, "cause": …}`
  with cause `tile`, `notification`, `phrase`, `stop_phrase`, `timeout`, `voice_stop` or
  `service_stopped` (pause and stop); the server validates it and writes
  `audit.record(db, "voice.mode", actor="agent" for voice_stop else "user",
  target_type="device", target_id=<device id>, details={"on", "cause"})`. Settings →
  Audit log shows it. A message that doesn't validate is ignored; computers' are ignored.
  Messages made while the socket is down wait (at most 20) and go after the next welcome.
- logged on the phone (logcat, tag `AnemoVoice`: `voice mode on cause=tile`). The phone's
  stop sends it before the WebSocket closes (`VoiceSession.stop` stops the connection
  after the voice loop).

*Changed while building:* the first draft also put a line into the app's history list.
That list is a Room table of requests (run, chat link, answer); a second kind of row
needs a schema migration and new screen code for a line the audit log already shows. Left
out; the history stays requests only.

`Logcat.kt` is the only file that logs (the privacy test allowed no logging at all; it
now allows that one file and checks that its functions take no text, so no token,
transcript or answer can reach the log). It logs the wake word's score on each detection
(`wake word heard score=0.83`) and voice mode on/off with the cause.

## 3. Wire changes (`docs/device-contracts.md`, phone sections)

All additive; an older phone keeps working with the new server.

- §2 *Messages from a phone* (new table): `voice.mode` as above.
- §2 *Events a phone gets*: `voice.stop` `{run_id, conversation_id}`.
- §4 `POST /api/voice/transcripts` (multipart `audio`): `200 {"heard"}`; nothing heard:
  `200 {"heard": "", "say": "Sorry, I didn't catch that."}`; errors as `/voice/turns`
  (409 `no_transcription_model`, 422 audio codes, 400 `transcription_failed`). Stores
  nothing, starts nothing.
- §4 `POST /api/voice/turns` gets optional form fields:
  - `text` (1–4000 characters): the transcript from `/voice/transcripts`, used instead of
    `audio` (one of the two is needed unless `status`);
  - `voice_mode` (`true`): voice mode is on; the turn note says so and `voice_stop` may
    end it (stored in `runs.options.voice_mode`);
  - `keep_chat` (`true`): continue `conversation_id` whatever the follow-up window says
    (still not an archived, temporary, automation or busy chat). The phone sends it for
    the second and later requests of one voice mode session, so the chat stays the same
    while voice mode is on; the first request of a session uses the window as usual.

The phone app's version becomes 1.1.0. A 1.1.0 phone with an older server: the
`/voice/transcripts` call gets 404, which the phone speaks as an error; the server must
be updated first (the PR says so).

## 4. What is where

**Phone** (`android/`):

- `core/Commands.kt`: normalisation, wake word removal, phrase matching (pure).
- `core/VoiceMode.kt`: on/off, sessions, the run awaited, `voice.stop`s, causes (pure).
- `core/CueTones.kt`: the cue sounds as PCM, and the vibration patterns (pure).
- `core/VoiceController.kt`: pre-roll, ducking, the new cues, the transcript step, voice
  mode reopen and idle timeout, `voice.stop`.
- `core/Ports.kt`, `Model.kt`: `Chimes` becomes `play(Cue)`; new `AudioFocus`;
  `VoiceBackend` gets `transcribe` and `sendText`; `WakeWordDetector.lastScore`; the
  controller's `Listener` gets `onWakeWord(score)` and `onVoiceModeChanged(on, cause)`.
- `audio/ToneCues.kt` (replaces `ToneChimes.kt`): `AudioTrack` + `Vibrator`.
  `audio/AudioDucking.kt`: the focus request. `audio/MicrophoneSource.kt`: echo canceller.
- `net/VoiceApi.kt`, `net/Protocol.kt`, `net/DeviceSocket.kt` (`send`, queued until
  welcome).
- `service/`: `ListenService` (voice-mode actions), `ListenNotification` (titles, the
  Voice mode button), `VoiceModeTileService` (new tile), `VoiceRuntime` (wiring),
  `Logcat.kt` (the only file that logs; typed functions, no free text).
  Android shows at most three notification buttons, so the notification becomes Pause /
  **Voice mode** (or **End voice mode**) / Stop; **Status** stays on the app's main
  screen (it was on both).
- `settings/`: `vibrate`, `voiceModePhrase`, `voiceModeIdleSeconds`; the settings screen.
- `AndroidManifest.xml`: `VIBRATE`, the second tile.

**Server** (`backend/`):

- `features/voice/router.py`, `service.py`: `/voice/transcripts`, `text`, `voice_mode`,
  `keep_chat`, the voice-mode turn note; `features/voice/mode.py`: the `voice.mode`
  message (validation and audit entry).
- `tools/builtin/voice.py`: `voice_stop`; `tools/registry.py`: appended to
  `BUILTIN_TOOLS`, and `toolset_for(…, has_phone=…)` (one condition);
  `runtime/agent.py`: passes `has_phone` (one line).
- `policy/presets.py`: the `voice.control` category (appended).
- `features/devices/ws.py`: `voice.mode` handed to `features/voice/mode.py` (one branch);
  `features/devices/phone_events.py`: `voice.stop` passed on.

No migration (phone settings live on the phone; the audit table exists).

## 5. Settings

On the phone (Settings → Sound and a new *Voice mode* group): "Vibrate with the sounds"
(on), "Say “start voice mode” to turn it on" (on), "End voice mode after silence" (30 /
**45** / 60 / 90 s). Nothing new on the server: the voice settings of Settings → Voice
apply; `voice_stop` follows Settings → Agent permissions → "Voice mode".

## 6. Done when

- The wake word gives the start sound and a buzz on detection (measured on a phone:
  under 150 ms), with media at 0; music ducks; "wake word + request" in one breath
  arrives whole; silence after the wake word gives the timeout sound; the end of a
  request gives the end sound; the notification says "Listening".
- Voice mode turns on from the tile, the notification and "start voice mode" (also right
  after the wake word), and off from the tile, the notification, "stop", "end voice
  mode", the idle timeout and `voice_stop`; each plays its sound, goes back to the wake
  word and appears in Settings → Audit log with its cause.
- The answer is not transcribed as the next request; the chat stays the same.
- One-shot requests, the follow-up window, questions, approvals and plan reviews by voice
  and the Status button work as before.
- Tests: JVM unit tests for `Commands`, `VoiceMode`, `CueTones`, the controller flows
  (pre-roll, cues, ducking, voice mode on/off for every cause, reopen, idle timeout,
  `voice.stop`, nothing on the wire turns it on), `VoiceApi` and `DeviceSocket` against
  the fake Anemo; backend API tests for `/voice/transcripts`, `text`, `voice_mode`,
  `keep_chat`, the `voice_stop` tool (offered only to phone runs, event sent, refused
  outside voice mode), the `voice.mode` message (audit entry, actor, bad messages and
  computers ignored) and the `voice.stop` event reaching only its phone.

## 7. What this VM can't test

Nothing here runs on a phone: there is no Android device or emulator on the VM. The JVM
tests cover the logic with fakes. Not tested at all, only written to the Android
documentation: the cue latency, `AudioTrack` with the sonification usage (and how loud it
is on the Xiaomi), the vibration, audio focus and ducking, `AcousticEchoCanceler`, the
second tile, the notification button, and how well the transcription model hears "start
voice mode" right after a wake word. `android/MANUAL-TESTS.md` lists these checks.

## Later

- Barge-in: listen while speaking (echo canceller on), and stop speaking when the user
  talks.
- A per-phone choice of the cue stream if sonification turns out wrong on some phones.
