package app.anemo.voice.ml

import app.anemo.voice.settings.WakeWord
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.io.InputStream

/**
 * The openWakeWord model files, kept in the app's private storage ([dir]). They are not in
 * the APK: openWakeWord's pre-trained models are CC BY-NC-SA 4.0, which a GPL-2.0 app
 * can't ship (see android/README.md). The user downloads them from openWakeWord's own
 * release with one tap, or imports a custom word's `.onnx` (the shared melspectrogram and
 * embedding models are downloaded the same way).
 */
class ModelFiles(
    private val dir: File,
    private val client: OkHttpClient,
    private val release: HttpUrl = RELEASE.toHttpUrl(),
) {
    val melspectrogram: File get() = File(dir, MEL)
    val embedding: File get() = File(dir, EMBEDDING)

    fun word(w: WakeWord): File = File(dir, w.file)

    fun present(w: WakeWord): Boolean = melspectrogram.isFile && embedding.isFile && word(w).isFile

    /** Downloads what [w] needs and isn't there yet. Blocking: call off the main thread. */
    @Throws(IOException::class)
    fun download(w: WakeWord) {
        dir.mkdirs()
        val names = buildList {
            add(MEL)
            add(EMBEDDING)
            if (w != WakeWord.Custom) add(w.file)
        }
        for (name in names) {
            val target = File(dir, name)
            if (target.isFile) continue
            val request = Request.Builder().url(release.newBuilder().addPathSegment(name).build()).build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw IOException("Download of $name failed (${response.code})")
                val body = response.body ?: throw IOException("Download of $name was empty")
                save(body.byteStream(), target)
            }
        }
    }

    /** Saves an imported custom wake word model. Blocking. */
    @Throws(IOException::class)
    fun importCustom(input: InputStream) {
        dir.mkdirs()
        save(input, word(WakeWord.Custom))
    }

    private fun save(input: InputStream, target: File) {
        val tmp = File(dir, "${target.name}.part")
        try {
            tmp.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > MAX_BYTES) throw IOException("${target.name} is too large for a wake word model")
                    out.write(buf, 0, n)
                }
                if (total < MIN_BYTES) throw IOException("${target.name} is not a model")
            }
            if (!tmp.renameTo(target)) throw IOException("Could not save ${target.name}")
        } finally {
            tmp.delete()
        }
    }

    companion object {
        /** openWakeWord's release with the ONNX models (github.com/dscripka/openWakeWord). */
        const val RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/"
        const val MEL = "melspectrogram.onnx"
        const val EMBEDDING = "embedding_model.onnx"
        private const val MAX_BYTES = 50L * 1024 * 1024
        private const val MIN_BYTES = 1_024L
    }
}
