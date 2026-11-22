# Voice: talk to Anemo from your phone

Say the wake word near your Android phone (or into an earpiece paired with it), say what
you want, and Anemo does it: the recording goes to Anemo, is turned into a clear request,
and an agent run starts in a **Voice** chat. When the run finishes, the phone reads the
answer out loud. Questions the agent asks and approvals it needs come back to the phone
the same way, and you answer by voice or with the buttons on the notification.

It is the dictation pipeline (`04-dictation.md`) with a phone in front and an agent run
behind. The phone is a *device* (`06-desktop-client.md`, `docs/device-contracts.md`): it
logs in with an API token and keeps one WebSocket to Anemo through the same address the
web app uses (Nginx Proxy Manager, with **Websockets Support** on).

## How you use it

- **Install** Anemo Voice (an APK; Android 10 or later), enter the Anemo address and paste
  a token made in **Settings → Devices** (a new kind of token, see "Devices" below).
- **Listening** runs as a foreground service with a permanent notification ("Anemo is
  listening for ‹wake word›") and Pause / Stop buttons. A quick-settings tile switches it
  on and off. Android only lets an app start the microphone while it is in use, so after
  a reboot you open the app or tap the tile once.
- **Wake word**, then speak. A short sound says it heard you; it records until about a
  second of silence (Silero VAD), at most 60 seconds. A second sound says it stopped.
  "Cancel" or "never mind" as the whole recording throws it away.
- **The answer** is spoken with Android's own text-to-speech (`TextToSpeech`, the voice
  set in Android's settings), and shown in the app's list of recent requests with a link
  to the chat in Anemo. Long answers are not read out in full (see "What is spoken").
- **While a run works**, nothing is spoken unless it needs you. Saying the wake word
  again starts a new request; "status" on its own asks what is running.
- **Follow-ups** within 5 minutes of an answer continue the same chat, so "and move it to
  Friday" knows what "it" is. After that, a new request starts a new turn in the Voice
  chat of the day.

## What happens on the server

`POST /api/voice/turns` (multipart; contract in `docs/device-contracts.md` §4):

1. **Transcribe** with the Transcription model, exactly as dictation does (OpenRouter's
   `/audio/transcriptions`, Groq, a local speaches server, … any model with the
   `transcription` capability). The word list from Settings → Dictation applies.
2. **Make a request of it** with the Dictation clean-up model and a new purpose, `voice`:
   the clean-up rules of dictation, plus "it is a spoken request to an assistant that will
   act on it: write it as one clear instruction, keeping every name, time and detail".
   This is the step that keeps "uh, mail Tom, no, Tim, about Friday's thing" from reaching
   the agent as said. The clean-up never answers or acts; if it fails, the transcript goes
   on as heard (as in dictation).
3. **Start an agent turn** in the Voice chat (`TurnIn` with `mode="agent"`, the profile
   from Settings → Voice), with a turn note (inside the turn context, not the system
   prompt) that the user is listening on a phone: answer in one to three spoken
   sentences, no Markdown, no lists or links; put anything longer in a document or task and
   say where. The agent decides itself whether the request is clear; when it isn't, it
   uses `ask_user`, which already pauses the run until the user answers.
4. Return `{run_id, conversation_id, heard, request}` at once (202); the run goes on in the
   worker like any other.

Neither the audio nor the transcript is stored by this endpoint (the request becomes the
user's chat message, which is stored as every chat message is). Usage is recorded for both
models.

### Answers back to the phone

The phone's WebSocket gets the events it needs (contract §3): the run's status, a
`voice.say` event with the text to speak when a Voice run finishes, and the existing
`approval.requested` for approvals and questions of runs it started.

- **What is spoken.** The run's final answer, with Markdown removed, cut at about 600
  characters at a sentence end, followed by "The rest is in the chat." The turn note keeps
  most answers well under that. The server sends the text; the phone does no model work.
- **Questions (`ask_user`).** The phone speaks the question and its options, then listens
  without a wake word for up to 8 seconds. The reply goes to `POST /api/voice/replies`
  with the approval's id: transcribed, and given to the existing
  `POST /api/approvals/{id}` as the answer. "Up to you" leaves the choice to the agent
  (`deny`, as in the chat).
- **Approvals.** The phone speaks the action's summary and "Allow?". The reply is
  transcribed and classified by the clean-up model as *yes*, *no* or *unclear*; only *yes*
  and *no* decide, *unclear* asks once more and then leaves it to the notification. An
  approval with a **dangerous** action is never decided by voice: the phone says "That one
  needs a tap" and the push notification's Allow / Deny buttons (already built) decide it.
  Voice decisions are written to the audit log with `source: "voice"`.
- **Plan reviews.** With "review the plan first" on, the phone says "Here is the plan",
  reads the steps (the first six, then "and N more"), and asks "Go ahead?". Yes accepts
  the plan as proposed, no rejects it; changing the steps is done in the app. It follows
  the "Allow approvals by voice" setting.

## Settings (Settings → Voice)

- Agent profile for voice requests (default: the default agent).
- Follow-up window (default 5 minutes; 0 turns follow-ups off).
- Maximum spoken length (default 600 characters).
- Allow approvals by voice (on by default; dangerous actions always need a tap).
- The Voice chat: one per day (default) or one that keeps going.

On the phone (stored on the phone, not in Anemo): wake word and its sensitivity, the
sounds, whether to use a Bluetooth headset's microphone when one is connected, and which
TTS voice and speed.

## Phone app design

Kotlin, one module, no Google Play services needed. Package `app.anemo.voice`.

- `ListenService`: foreground service, `foregroundServiceType="microphone"`. `AudioRecord`
  at 16 kHz mono 16-bit, 80 ms frames into the wake word detector. On a Bluetooth headset
  it routes input with `AudioManager.setCommunicationDevice` (Android 12+) or SCO before
  that.
- **Wake word**: openWakeWord (code Apache 2.0) run with ONNX Runtime for Android. Its
  pre-trained models are CC BY-NC-SA 4.0, so they are not shipped in the app: it downloads
  them from openWakeWord's release when you choose a word in Settings. A
  pre-trained word to start; a custom one ("Hey Anemo") can be trained with openWakeWord's
  notebook and dropped into the app as a `.onnx` file. Porcupine is the alternative if
  openWakeWord's false wakes are too many; it needs a Picovoice access key.
- **End of speech**: Silero VAD (ONNX), 1 s of silence ends a recording.
- **Upload**: the recording as WAV (16 kHz mono), the format every transcription server
  takes. OkHttp, `Authorization: Bearer <token>`.
- **Connection**: one OkHttp WebSocket to `/api/devices/ws` while the service runs,
  `kind: "phone"`, ping every 20 s, reconnect with back-off, `last_id` to catch up.
- **Speech out**: `android.speech.tts.TextToSpeech`, audio focus taken while it speaks
  (music ducks), `UtteranceProgressListener` to know when to listen for a reply.
- **Storage**: the token in `EncryptedSharedPreferences`; the last 50 requests (heard,
  request, spoken answer, chat link) in Room, for the app's history screen.
- Never records without the notification showing; never uploads anything but a recording
  that followed the wake word, a reply the app asked for, or the status command.

## Backend design

- `features/voice/`: `router.py` (`POST /voice/turns`, `POST /voice/replies`),
  `service.py`. Uses dictation's transcription and clean-up (made public:
  `dictation.service.transcribe()` and `clean_up()`; the `_PURPOSE` table gets `voice` and
  a yes/no classifier prompt). Starts the turn through the conversations service, the same
  call the `/turns` route makes.
- `settings/sections.py`: `VoiceSettings`.
- `features/devices/` (from `06-desktop-client.md`): the device WebSocket forwards
  `voice.say` and the approval events of runs a phone started.
- Runs started by voice carry `source: "voice"` and the device id in the run's
  `options` (`runs.options`), so the timeline shows "Asked by voice from ‹phone›".
- No migration of its own beyond the `devices` table.

## Done when

- Wake word → request → agent run → spoken answer, on a real phone, through NPM.
- A question from `ask_user` is answered by voice; an approval is allowed by voice; a
  dangerous one is not and says why; a plan is read out and accepted by voice.
- A follow-up within the window continues the chat.
- Without a transcription model, the phone says so and names the setting.
- Tests: the voice endpoint (transcribe + request + turn, clean-up failing, no model,
  follow-up window, cancel words), the replies endpoint (answer, yes, no, unclear,
  dangerous refused), the spoken-text shortening, the WebSocket events for a phone.

## Later

- A realtime voice model for real back-and-forth (interrupting, quick clarifications);
  its tools would be "start a run" and "check a run", and Anemo would give the phone a
  short-lived key.
- Voice notes without a run ("note: …" goes straight to the daily note).
- Wear OS tile as a push-to-talk button.
