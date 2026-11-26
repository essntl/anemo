package app.anemo.voice.core

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** The microphone: 80 ms frames to [open]'s `onFrame` (any thread), read errors to `onError`. */
interface Microphone {
    /** Throws when it can't be opened. */
    fun open(onFrame: (ShortArray) -> Unit, onError: (String) -> Unit)
    fun close()
}

/** The WebSocket, as the session sees it. */
interface Connection {
    fun start()
    fun stop()
}

/** Runs [Timer] actions on [executor]; after a shutdown nothing is scheduled. */
class ExecutorTimer(private val executor: ScheduledExecutorService) : Timer {
    override fun schedule(delayMs: Long, action: () -> Unit): Cancellable = try {
        val f = executor.schedule(action, delayMs, TimeUnit.MILLISECONDS)
        Cancellable { f.cancel(false) }
    } catch (e: RejectedExecutionException) {
        Cancellable {}
    }
}

/**
 * One listening session: the microphone, the connection and the voice loop, started and
 * stopped together. Everything that touches the controller or the microphone runs on
 * [voice] (one thread).
 *
 * - Frames wait in a small queue ([queueFrames], 2 s); when the engines can't keep up the
 *   oldest frames are dropped.
 * - A microphone read error closes it and opens it again after each of [retryDelaysMs];
 *   after that, or when it can't be opened, or when the wake word or VAD engine fails,
 *   the session stops and [onFatal] gets a sentence for the user.
 * - [stop] runs [cleanup] once, after the controller stopped, and shuts [voice] down. The
 *   connection stops after the controller, so a last message (voice mode off) still goes.
 */
class VoiceSession(
    private val voice: ScheduledExecutorService,
    private val controller: VoiceController,
    private val microphone: Microphone,
    private val connection: Connection,
    private val onFatal: (String) -> Unit,
    private val cleanup: List<() -> Unit> = emptyList(),
    private val retryDelaysMs: List<Long> = listOf(500, 2_000, 5_000),
    queueFrames: Int = 25,
) {
    private val frames = ArrayBlockingQueue<ShortArray>(queueFrames)
    private val draining = AtomicBoolean(false)
    private val stopped = AtomicBoolean(false)

    // voice thread only
    private var micOpen = false
    private var paused = false
    private var failures = 0
    private var framesSinceOpen = 0

    /** Frames dropped because the engines fell behind (for tests and diagnostics). */
    @Volatile var droppedFrames = 0
        private set

    fun start() {
        connection.start()
        onVoice {
            controller.start()
            openMicrophone()
        }
    }

    fun pause() = onVoice {
        paused = true
        closeMicrophone() // the microphone is released while paused
        controller.pause()
    }

    fun resume() = onVoice {
        if (!paused) return@onVoice
        paused = false
        controller.resume()
        openMicrophone()
    }

    fun status() = onVoice { controller.requestStatus() }

    /** The tile or the notification switched voice mode (turning it on also resumes). */
    fun setVoiceMode(on: Boolean, cause: VoiceModeCause) = onVoice {
        if (on && paused) {
            paused = false
            controller.resume()
            openMicrophone()
        }
        controller.setVoiceMode(on, cause)
    }

    /** Re-opens the microphone, e.g. when a Bluetooth headset came or went. */
    fun reopenMicrophone() = onVoice {
        if (!micOpen) return@onVoice
        closeMicrophone()
        openMicrophone()
    }

    fun stop() {
        if (!stopped.compareAndSet(false, true)) return
        val finish = {
            closeMicrophone()
            controller.stop()
            connection.stop()
            cleanup.forEach { runCatching(it) }
        }
        try {
            voice.execute(finish)
            voice.shutdown()
        } catch (e: RejectedExecutionException) {
            finish()
        }
    }

    private fun openMicrophone() {
        if (stopped.get() || paused || micOpen) return
        try {
            microphone.open(::onFrame) { message -> onVoice { microphoneFailed(message) } }
            micOpen = true
            framesSinceOpen = 0
        } catch (e: Exception) {
            fatal("The microphone could not be opened (${e.message ?: e.javaClass.simpleName}).")
        }
    }

    private fun closeMicrophone() {
        if (!micOpen) return
        micOpen = false
        runCatching { microphone.close() }
        frames.clear()
    }

    private fun microphoneFailed(message: String) {
        if (stopped.get() || paused || !micOpen) return
        closeMicrophone()
        if (failures >= retryDelaysMs.size) {
            fatal("The microphone stopped working ($message).")
            return
        }
        val delay = retryDelaysMs[failures++]
        try {
            voice.schedule({ openMicrophone() }, delay, TimeUnit.MILLISECONDS)
        } catch (e: RejectedExecutionException) {
            // stopped meanwhile
        }
    }

    /** On the microphone's thread. */
    private fun onFrame(frame: ShortArray) {
        if (stopped.get()) return
        while (!frames.offer(frame)) {
            frames.poll()
            droppedFrames++
        }
        if (draining.compareAndSet(false, true)) onVoice(::drain)
    }

    private fun drain() {
        while (true) {
            val frame = frames.poll() ?: break
            if (!micOpen) continue
            try {
                controller.onFrame(frame)
            } catch (e: Exception) {
                fatal("The wake word or speech detection failed (${e.message ?: e.javaClass.simpleName}).")
                return
            }
            if (++framesSinceOpen >= HEALTHY_FRAMES) failures = 0
        }
        draining.set(false)
        if (frames.isNotEmpty() && draining.compareAndSet(false, true)) onVoice(::drain)
    }

    private fun fatal(message: String) {
        stop()
        onFatal(message)
    }

    private fun onVoice(block: () -> Unit) {
        try {
            voice.execute(block)
        } catch (e: RejectedExecutionException) {
            // stopped
        }
    }

    private companion object {
        /** 10 s of frames after a reopen: the microphone works again. */
        const val HEALTHY_FRAMES = 125
    }
}
