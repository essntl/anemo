# Anemo Voice (Android)

Talk to Anemo from your phone: say the wake word, say what you want, hear the answer.
What it does and why is in `docs/specs/05-voice-android.md`; what it says to the server is
in `docs/device-contracts.md` (§2 the WebSocket, §4 the voice REST calls).

Kotlin, one module, package `app.anemo.voice`, Android 10 (API 29) or later, no Google
Play services.

## Build and test

```
cd android
./gradlew test assembleDebug
```

The debug-signed APK is `app/build/outputs/apk/debug/app-debug.apk`. It needs JDK 17 and
the Android SDK (platform 35, build-tools 35.0.0): set `ANDROID_HOME`, or write
`android/local.properties` with `sdk.dir=<your SDK path>` (forward slashes on Windows;
never committed).

`./gradlew test` runs everything on the JVM, against a fake Anemo (OkHttp's
MockWebServer, `app/src/test/.../net/FakeAnemo.kt`) that speaks the device contract. The
openWakeWord tests in `OnnxModelsTest` run only when `OWW_MODELS` names a folder with the
models and two 16 kHz recordings (`hey_jarvis.wav`, `other.wav`); they are skipped in CI.

What only a phone can check is in `MANUAL-TESTS.md`.

## Cut a release

The `Release` workflow (`.github/workflows/release.yml`) builds the APK, signs it with the
release key from the repository secrets and attaches it to a GitHub Release, on a
`voice-v<version>` tag. The server's images use `v<version>` tags; these are separate.

**The release key, once.** Every release must be signed with the same key, or Android refuses
to install it over the old one. Make the keystore on your own computer (JDK's `keytool`;
choose a long password) and add it to the repository's secrets:

```
keytool -genkeypair -v -keystore anemo-voice.jks -storetype PKCS12 -alias anemo-voice -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Anemo Voice"
```

```
[Convert]::ToBase64String([IO.File]::ReadAllBytes("anemo-voice.jks")) | gh secret set ANDROID_KEYSTORE_BASE64
```

```
gh secret set ANDROID_KEYSTORE_PASSWORD
```

```
gh secret set ANDROID_KEY_ALIAS --body anemo-voice
```

(`ANDROID_KEY_PASSWORD` only for a keystore whose key has a password of its own; a PKCS12
keystore has one password for both.) Keep `anemo-voice.jks` and its password backed up
somewhere safe, outside the repository (`*.jks` is ignored): without them no later version
can update an installed app, which then has to be uninstalled (losing its settings and token).
Until the secrets are set, a tag build fails and publishes nothing.

**Each release.**

1. In a PR, raise `versionName` **and** `versionCode` (by one) in `app/build.gradle.kts`.
   That PR runs the workflow as a dry run: the APK appears under the run's *Artifacts* (signed
   with a throwaway key until the secrets are set), and no Release is made. Merge it once CI
   is green.
2. Tag the merge commit on main and push the tag:

   ```
   git checkout main && git pull
   git tag voice-v1.0.0
   git push origin voice-v1.0.0
   ```

3. The workflow checks that the tag is `voice-v` + `versionName` and is on main (else it
   fails and publishes nothing), then makes the Release `voice-v1.0.0` with `Anemo-Voice.apk`
   and `SHA256SUMS-voice.txt`; its notes give the checksum and the signing certificate's
   SHA-256, which stays the same from one release to the next. A re-run of a failed run adds
   the files to the same Release.

Locally, `./gradlew assembleRelease` with `ANEMO_VOICE_KEYSTORE` (the keystore's path),
`ANEMO_VOICE_KEYSTORE_PASSWORD` and `ANEMO_VOICE_KEY_ALIAS` set gives the same signed APK
(`app/build/outputs/apk/release/app-release.apk`); without them the release build is unsigned.

## Install and set up

1. Install `Anemo-Voice.apk` from the latest `voice-v…` Release (or the APK you built), allowing
   installs from your browser or file manager. A newer release installs over it.
2. In Anemo, **Settings → Devices**: make a phone device and copy its token (shown once).
3. In the app, **Settings**: Anemo's address (the https address you open Anemo with,
   through Nginx Proxy Manager with *Websockets Support* on) and the token. Choose a wake
   word and tap **Download** next to its models. Save.
4. **Start listening**, allow the microphone and notifications. The notification
   "Anemo is listening for ‹wake word›" stays while it listens; a quick-settings tile
   (edit your quick settings to add "Anemo Voice") switches it on and off.

Answers are spoken with the text-to-speech engine chosen in the phone's settings
(*Text-to-speech output*). It needs a voice for the language of the answers: on a phone
without Google's speech services (a Chinese Xiaomi ROM, for example) install another
engine such as RHVoice, download a voice in it, choose it as the preferred engine and
allow it to start by itself (*Autostart* on Xiaomi). When no engine can be started the
app says so on its main screen, and tries again for the next answer.

After a reboot, open the app or tap the tile once: Android doesn't let an app start the
microphone from the background, and the app doesn't try to get around that.

## Layout

```
app/src/main/java/app/anemo/voice/
  core/      the logic, plain Kotlin: VoiceController (listen → record → upload → speak →
             reply), VoiceSession (microphone, connection and loop started and stopped
             together, microphone recovery), Endpointer (end of speech), ReplyBudget, Wav,
             Phrases (what the phone says itself), Ports (the interfaces the platform
             implements)
  net/       Address, VoiceApi (POST /api/voice/turns and /replies), DeviceSocket (the
             WebSocket: hello, ping, reconnect with back-off, last_id), Protocol (JSON)
  ml/        OpenWakeWord and SileroVad on ONNX Runtime, ModelFiles (download / import)
  audio/     MicrophoneSource (AudioRecord), AndroidSpeaker (TextToSpeech, audio focus),
             ToneChimes, BluetoothRouting
  history/   Room: the last 50 requests (heard, request, spoken answer, chat link)
  settings/  VoiceSettings, the store (token in EncryptedSharedPreferences), Readiness
  service/   ListenService (foreground, microphone), its notification, the tile,
             VoiceRuntime (wires the platform to the core)
  ui/        Jetpack Compose + Material 3: MainActivity (status, history), SettingsActivity,
             AboutActivity (licences), one *Screen.kt per screen, Components.kt, the pure
             screen logic (ListenCard, SettingsForm, HistoryText); ui/theme/ the tokens and icons
```

## What it never does

- Record without its notification showing: the service puts the notification up before
  it opens the microphone; it doesn't start, and stops, when notifications are off, the
  Listening channel is blocked or the notification is swiped away.
- Upload anything but a recording that followed the wake word, a reply it asked for
  (after speaking a question, an approval or a plan), or the status command (which sends
  no audio).
- Let a run turn it into a listening device: it listens for a reply only after reading
  something out, always with the reply sound, for at most 8 s until you start and 15 s
  once you did, at most 3 times per run and 6 times in all per 5 minutes. A dangerous
  action, or an action that comes without a risk, is never asked by voice.
- Put the token in a URL or a log (nothing in the app logs; `PrivacyRulesTest` checks).
- Write audio or transcripts to storage: recordings stay in memory; the history keeps
  only what was heard, the request, the spoken answer and the chat link.

## Talking to Anemo

- Every request asks to continue the chat of the last spoken answer
  (`conversation_id`); Anemo decides with its own follow-up window (Settings → Voice)
  whether it does.
- When Anemo answers with an error, the phone speaks Anemo's own `message`; its own
  phrases are only for no answer at all ("I could not reach Anemo") and for answers
  without a message, such as a proxy's error page ("Anemo did not accept the recording").
- **Status** (in the app and on the notification) asks what is running; a recording that
  is only "status" is a normal request, which Anemo answers the same way.

## Models and their licences

| File | Where it comes from | Licence | In the APK? |
|---|---|---|---|
| `app/src/main/assets/models/silero_vad.onnx` | [Silero VAD](https://github.com/snakers4/silero-vad) v6.2.3, `src/silero_vad/data/silero_vad.onnx` (sha256 `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`) | MIT | yes |
| `melspectrogram.onnx`, `embedding_model.onnx`, `hey_jarvis_v0.1.onnx`, `alexa_v0.1.onnx`, `hey_mycroft_v0.1.onnx` | [openWakeWord](https://github.com/dscripka/openWakeWord) release [v0.5.1](https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1) | code Apache 2.0; the pre-trained models CC BY-NC-SA 4.0 | **no** |

openWakeWord's pre-trained models are CC BY-NC-SA 4.0 (non-commercial), which can't be
shipped inside a GPL-2.0 program, so the APK doesn't contain them. The app downloads
them from openWakeWord's own release when the user taps **Download** next to the models
(Settings), into its private storage (`files/models/`), and refuses any file whose
sha256 isn't the one pinned in `ml/ModelFiles.kt`. A custom word ("Hey Anemo"), trained
with openWakeWord's notebook, is imported as a `.onnx` file with **Import your own word**;
the import opens it and checks its shapes (N embeddings of 96 in, one score out), and it
still uses the downloaded melspectrogram and embedding models.

The APK carries the notices of everything it includes in
`app/src/main/assets/licenses/` (shown under **About** (the ⓘ button) in the app).

Silero VAD's licence:

```
MIT License

Copyright (c) 2020-present Silero Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

ONNX Runtime (`com.microsoft.onnxruntime:onnxruntime-android`) is MIT; OkHttp, AndroidX
and Room are Apache 2.0.
