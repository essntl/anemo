package app.anemo.voice.service

import ai.onnxruntime.OrtEnvironment
import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import app.anemo.voice.BuildConfig
import app.anemo.voice.audio.AndroidSpeaker
import app.anemo.voice.audio.BluetoothRouting
import app.anemo.voice.audio.MicrophoneSource
import app.anemo.voice.audio.ToneChimes
import app.anemo.voice.core.DeviceEvent
import app.anemo.voice.core.ListenState
import app.anemo.voice.core.PostingBackend
import app.anemo.voice.core.VoiceController
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
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Everything the listening service runs, wired together: the microphone, the wake word
 * and VAD engines, speech, the voice loop ([VoiceController], on its own thread) and the
 * WebSocket ([DeviceSocket], on another). Made after the service's notification shows.
 */
class VoiceRuntime(
    private val context: Context,
    private val settings: VoiceSettings,
    private val onStatus: ((Status) -> Status) -> Unit,
) {
    private val voiceThread = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "anemo-voice").apply { isDaemon = true } }
    private val socketThread = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "anemo-socket").apply { isDaemon = true } }
    private val audio = context.getSystemService(AudioManager::class.java)
    private val address = requireNotNull(Address.parse(settings.address)) { "No valid address" }
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private val env = OrtEnvironment.getEnvironment()
    private val models = ModelFiles(java.io.File(context.filesDir, "models"), client)
    private val wake = OpenWakeWord(
        env,
        models.melspectrogram.readBytes(),
        models.embedding.readBytes(),
        models.word(settings.wakeWord).readBytes(),
        settings.sensitivity.threshold,
    )
    private val vad = SileroVad(env, context.assets.open(SileroVad.ASSET).use { it.readBytes() })
    private val chimes = ToneChimes(settings.sounds)
    private val speaker = AndroidSpeaker(context, settings.ttsVoice, settings.ttsSpeed) { voiceThread.execute(it) }
    private val routing = BluetoothRouting(audio)
    private val mic = MicrophoneSource()

    private val controller = VoiceController(
        wake = wake,
        vad = vad,
        chimes = chimes,
        speaker = speaker,
        backend = PostingBackend(VoiceApi(client, address, settings.token), voiceThread),
        history = RoomHistoryStore(HistoryDatabase.get(context).requests()),
        clock = { System.currentTimeMillis() },
        chatLink = address::chat,
        listener = object : VoiceController.Listener {
            override fun onStateChanged(state: ListenState) = onStatus { it.copy(listen = state) }
            override fun onHistoryChanged() = StatusBus.historyChanged()
            override fun onActiveRunsChanged(count: Int) = onStatus { it.copy(activeRuns = count) }
        },
    )

    private val socket = DeviceSocket(
        client, address.deviceSocket, settings.token, BuildConfig.VERSION_NAME,
        object : DeviceSocket.Listener {
            override fun onConnected(deviceName: String, missed: Boolean) =
                onStatus { it.copy(connection = Connection.Connected(deviceName)) }

            override fun onEvent(event: DeviceEvent) = voiceThread.execute { controller.onEvent(event) }
            override fun onNotice(text: String) = onStatus { it.copy(notice = text) }
            override fun onDisconnected(retryInMs: Long) =
                onStatus { it.copy(connection = Connection.Retrying((retryInMs + 999) / 1000)) }

            override fun onStopped(reason: DeviceSocket.StopReason) =
                onStatus { it.copy(connection = Connection.Refused(refusal(reason))) }
        },
        socketThread,
    )

    private val deviceChanges = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = reroute(added)
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = reroute(removed)
    }

    @Volatile private var listening = false

    /** Starts listening. The caller has already put the notification up. */
    fun start() {
        onStatus { it.copy(connection = Connection.Connecting, error = null) }
        socket.start()
        voiceThread.execute { controller.start() }
        if (settings.bluetoothMic) audio.registerAudioDeviceCallback(deviceChanges, null)
        openMicrophone()
    }

    fun pause() {
        closeMicrophone() // the microphone is released while paused
        voiceThread.execute { controller.pause() }
    }

    fun resume() {
        voiceThread.execute { controller.resume() }
        openMicrophone()
    }

    fun status() = voiceThread.execute { controller.requestStatus() }

    fun stop() {
        if (settings.bluetoothMic) audio.unregisterAudioDeviceCallback(deviceChanges)
        closeMicrophone()
        socket.stop()
        voiceThread.execute {
            controller.stop()
            speaker.shutdown()
            chimes.release()
            wake.close()
            vad.close()
        }
        voiceThread.shutdown()
        socketThread.shutdown()
        onStatus { Status() }
    }

    private fun openMicrophone() {
        val headset = if (settings.bluetoothMic) routing.route() else null
        mic.start(headset) { frame -> voiceThread.execute { controller.onFrame(frame) } }
        listening = true
    }

    private fun closeMicrophone() {
        listening = false
        mic.stop()
        routing.release()
    }

    private fun reroute(devices: Array<out AudioDeviceInfo>) {
        if (listening && devices.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }) {
            closeMicrophone()
            openMicrophone()
        }
    }

    private fun refusal(reason: DeviceSocket.StopReason): String = when (reason) {
        DeviceSocket.StopReason.BadToken -> "Anemo refused the token (deleted device?). Paste a new one in Settings."
        DeviceSocket.StopReason.BadHello -> "Anemo refused the connection: is this token for a phone?"
        DeviceSocket.StopReason.OriginRefused -> "Anemo refused the connection (Origin header)."
        DeviceSocket.StopReason.Replaced -> "Another connection of this phone took over."
    }
}
