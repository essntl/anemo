package app.anemo.voice.service

import ai.onnxruntime.OrtEnvironment
import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.SystemClock
import app.anemo.voice.BuildConfig
import app.anemo.voice.audio.AndroidSpeaker
import app.anemo.voice.audio.BluetoothRouting
import app.anemo.voice.audio.MicrophoneSource
import app.anemo.voice.audio.ToneChimes
import app.anemo.voice.core.DeviceEvent
import app.anemo.voice.core.ExecutorTimer
import app.anemo.voice.core.ListenState
import app.anemo.voice.core.PostingBackend
import app.anemo.voice.core.VoiceController
import app.anemo.voice.core.VoiceSession
import app.anemo.voice.history.HistoryDatabase
import app.anemo.voice.history.RoomHistoryStore
import app.anemo.voice.ml.ModelFiles
import app.anemo.voice.ml.OpenWakeWord
import app.anemo.voice.ml.SileroVad
import app.anemo.voice.net.Address
import app.anemo.voice.net.DeviceSocket
import app.anemo.voice.net.VoiceApi
import app.anemo.voice.settings.VoiceSettings
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Wires the platform to a [VoiceSession]: the microphone (with Bluetooth routing), the
 * wake word and VAD engines, speech, the voice REST client and the WebSocket. Made after
 * the service's notification shows. If building fails half way, everything already made is
 * closed again before the error is thrown.
 */
object VoiceRuntime {
    private const val NO_SPEECH =
        "Android's text-to-speech could not be started, so answers are not spoken. " +
            "Check Settings → System → Text-to-speech output on this phone."

    fun build(
        context: Context,
        settings: VoiceSettings,
        onStatus: ((Status) -> Status) -> Unit,
        onFatal: (String) -> Unit,
    ): VoiceSession {
        val made = ArrayList<() -> Unit>() // undo, in reverse order
        try {
            return assemble(context, settings, onStatus, onFatal, made)
        } catch (e: Exception) {
            made.asReversed().forEach { runCatching(it) }
            throw e
        }
    }

    private fun assemble(
        context: Context,
        settings: VoiceSettings,
        onStatus: ((Status) -> Status) -> Unit,
        onFatal: (String) -> Unit,
        made: MutableList<() -> Unit>,
    ): VoiceSession {
        val address = requireNotNull(Address.parse(settings.address)) { "no valid address" }
        val voice = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "anemo-voice").apply { isDaemon = true } }
        made += { voice.shutdownNow() }
        val socketThread = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "anemo-socket").apply { isDaemon = true } }
        made += { socketThread.shutdownNow() }
        val client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
        val api = VoiceApi(client, address, settings.token)
        made += { api.cancelAll() }

        val env = OrtEnvironment.getEnvironment()
        val models = ModelFiles(File(context.filesDir, "models"), client)
        val wake = OpenWakeWord(
            env,
            models.melspectrogram.readBytes(),
            models.embedding.readBytes(),
            models.word(settings.wakeWord).readBytes(),
            settings.sensitivity.threshold,
        )
        made += { wake.close() }
        val vad = SileroVad(env, context.assets.open(SileroVad.ASSET).use { it.readBytes() })
        made += { vad.close() }
        val chimes = ToneChimes(settings.sounds)
        made += { chimes.release() }
        val speaker = AndroidSpeaker(
            context, settings.ttsVoice, settings.ttsSpeed,
            post = { voice.execute(it) },
            onUnavailable = { onStatus { it.copy(notice = NO_SPEECH) } },
        )
        made += { speaker.shutdown() }
        val audio = context.getSystemService(AudioManager::class.java)
        val microphone = MicrophoneSource(if (settings.bluetoothMic) BluetoothRouting(audio) else null)

        val controller = VoiceController(
            wake = wake,
            vad = vad,
            chimes = chimes,
            speaker = speaker,
            backend = PostingBackend(api, voice),
            history = RoomHistoryStore(HistoryDatabase.get(context).requests()),
            clock = { System.currentTimeMillis() },
            monotonic = { SystemClock.elapsedRealtime() },
            timer = ExecutorTimer(voice),
            chatLink = address::chat,
            listener = object : VoiceController.Listener {
                override fun onStateChanged(state: ListenState) = onStatus { it.copy(listen = state) }
                override fun onHistoryChanged() = StatusBus.historyChanged()
                override fun onActiveRunsChanged(count: Int) = onStatus { it.copy(activeRuns = count) }
            },
        )

        val socket = DeviceSocket(
            client, address.deviceSocket, settings.token, BuildConfig.VERSION_NAME,
            object : DeviceSocket.Listener {
                override fun onConnected(deviceName: String, missed: Boolean) =
                    onStatus { it.copy(connection = Connection.Connected(deviceName)) }

                override fun onEvent(event: DeviceEvent) {
                    try {
                        voice.execute { controller.onEvent(event) }
                    } catch (e: java.util.concurrent.RejectedExecutionException) {
                        // stopped
                    }
                }

                override fun onNotice(text: String) = onStatus { it.copy(notice = text) }
                override fun onDisconnected(retryInMs: Long) =
                    onStatus { it.copy(connection = Connection.Retrying((retryInMs + 999) / 1000)) }

                override fun onStopped(reason: DeviceSocket.StopReason) =
                    onStatus { it.copy(connection = Connection.Refused(refusal(reason))) }
            },
            socketThread,
        )

        lateinit var session: VoiceSession
        // a headset came or went: open the microphone again so input follows it
        val deviceChanges = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = reroute(added)
            override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = reroute(removed)
            private fun reroute(devices: Array<out AudioDeviceInfo>) {
                if (devices.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }) session.reopenMicrophone()
            }
        }

        session = VoiceSession(
            voice = voice,
            controller = controller,
            microphone = microphone,
            connection = object : app.anemo.voice.core.Connection {
                override fun start() = socket.start()
                override fun stop() = socket.stop()
            },
            onFatal = onFatal,
            cleanup = listOf(
                { if (settings.bluetoothMic) audio.unregisterAudioDeviceCallback(deviceChanges) },
                { api.cancelAll() },
                { speaker.shutdown() },
                { chimes.release() },
                { wake.close() },
                { vad.close() },
                { socketThread.shutdown() },
            ),
        )
        if (settings.bluetoothMic) audio.registerAudioDeviceCallback(deviceChanges, null)
        return session
    }

    private fun refusal(reason: DeviceSocket.StopReason): String = when (reason) {
        DeviceSocket.StopReason.BadToken -> "Anemo refused the token (deleted device?). Paste a new one in Settings."
        DeviceSocket.StopReason.BadHello -> "Anemo refused the connection: is this token for a phone?"
        DeviceSocket.StopReason.OriginRefused -> "Anemo refused the connection (Origin header)."
        DeviceSocket.StopReason.Replaced -> "Another connection of this phone took over."
    }
}
