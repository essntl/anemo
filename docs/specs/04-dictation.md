# Dictation: speak, and get clean text

Speak instead of typing. Anemo records what you say, turns it into text with a
speech-to-text model, and then has a chat model tidy it: the "uhm"s, false starts and
repeats go, corrections you make while speaking are applied ("on Tuesday, no, Wednesday"
becomes "on Wednesday"), and a request with several parts comes out as short paragraphs
or a list. The result lands in the text box you were typing in, for you to read before
sending.

## How you use it

- **Double-press Caps Lock** anywhere in the app to start; double-press again to finish.
  Esc cancels. Two presses leave Caps Lock as it was. It works while you type in a field,
  and in dialogs.
- **The microphone button** in the message box does the same.
- While it listens, a small bar at the top centre of the window (clear of the message box)
  shows the time and a level meter, with buttons to finish and cancel; while it works,
  "Writing it down…". The microphone button turns into a red stop button.
- The text goes into the text field that had the focus when you started (the message
  box, a task's notes, a document's editor: any text box or editable area). With no text
  field, it goes into the message box of the chat on screen; with none, a new chat opens
  with the text in its message box.

Only while the Anemo tab has the focus: a web page can't listen to keys in other apps.
On a Mac, a quick tap on Caps Lock may be ignored by macOS ("Caps Lock delay"); press a
little longer, or use the button.

## Models

- **Transcription** (new task in Settings → Providers & Models). A model that can turn
  speech into text: OpenAI's `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` or `whisper-1`,
  or any OpenAI-compatible server with a Whisper model (Groq, a local faster-whisper or
  speaches server, …). Such models are recognised by name (`whisper`, `transcribe`) and get
  the new `transcription` capability; like embeddings, this task never falls back to the
  chat model. Anthropic and the Claude subscription have no speech-to-text.
- **Dictation clean-up** (new task). Tidies the transcript. A small, fast model is ideal;
  unset, it uses the chat model.

## Settings (Settings → Dictation)

- Clean up the text (on by default; off gives the transcript as it was heard).
- Double Caps Lock starts dictation (on by default).
- Language: automatic, or one language (helps short recordings).
- Words to spell right: names, projects and terms (up to 200). They go to both models.

## Privacy

The audio and the text are never stored or logged. Only a usage record (model, tokens or
seconds, cost) is kept, as for the extension's translate and explain. The clean-up model
gets the transcript and the word list, nothing else: no memories, documents or tools.

## Design

**Backend**
- `providers/base.py`: `TranscriptionResult` and `ProviderAdapter.transcribe(model, audio,
  filename, content_type, language, prompt)`. OpenAI-style adapters call
  `audio.transcriptions.create`; Anthropic and Claude Code raise a `ProviderError`; the
  fake adapter returns `FakeAdapter.transcript` for tests.
- `providers/catalog.py`: `transcription` capability, guessed from the model's name.
- `providers/router.py`: tasks that need their own kind of model (embeddings,
  transcription) never fall back to the chat model.
- `settings/sections.py`: `transcription` and `dictation` in `TaskType` and
  `ModelDefaults`; a `DictationSettings` section.
- `features/dictation/`: `POST /api/dictation` (multipart: the audio, and where the text
  goes: `chat` or `text`). The service transcribes with the first transcription model that
  works, then cleans up with the dictation model (fallbacks as for inline). If the
  clean-up fails, the raw transcript comes back with a warning, so nothing said is lost.
  Audio up to 25 MB (the OpenAI limit; a 10-minute recording is 19 MB as WAV).

**Frontend**
- `features/dictation/recorder.ts`: microphone, `MediaRecorder` (Opus in WebM, or MP4 on
  Safari), level meter, a 10-minute limit.
- `features/dictation/wav.ts`: the recording is sent as WAV (16 kHz, mono, 16-bit), the
  one format every server takes: those built on whisper.cpp (Lemonade, for example)
  refuse WebM and MP4. If the browser can't convert it, the recording goes as it is.
- `features/dictation/dictationStore.ts`: idle / starting / recording / working, the
  target field, start, finish, cancel.
- `features/dictation/insert.ts`: puts text into a textarea, input or editable area so
  React and the editor see it as typed (with undo), adding a space where needed.
- `features/dictation/DictationHost.tsx` (in `AppLayout`): the double Caps Lock, Esc, the
  bar at the bottom.
- `hooks/useShortcut.ts`: `useDoublePress(id, run)`. On a Mac, Caps Lock sends only a
  key-down when it turns on and a key-up when it turns off, so both count as a press there.
- `Composer`: the microphone button; the composer registers itself as the fallback target.
- Settings: the two tasks in the model card, the capability chip, a Dictation page.

## Done when

- Double Caps Lock in the message box records, and the cleaned text appears there.
- The button does the same; Esc cancels; a second recording can't start while one runs.
- Without a transcription model, a clear message says where to choose one.
- Tests: the backend endpoint (transcribe + clean-up, clean-up off, clean-up failing, no
  model, too large, wrong type), the catalog and router rules; the frontend double press,
  the text insertion, the store and the button.

## Later

- Live text while you speak (OpenAI Realtime transcription, or a streaming Whisper server).
- Dictation in the browser extension (Anemo Companion), and in other apps through it.
- Voice commands ("send it", "new paragraph").
