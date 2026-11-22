package app.anemo.voice.ml

import app.anemo.voice.settings.WakeWord
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest

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
    /** The sha256 every downloaded file must have; a file without one is refused. */
    private val pins: Map<String, String> = SHA256,
    /** Checks an imported custom word before it is kept; throws [IOException] with why not. */
    private val checkCustom: (File) -> Unit = {},
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
                val pin = pins[name] ?: throw IOException("No checksum known for $name")
                save(body.byteStream(), target, pin)
            }
        }
    }

    /** Saves an imported custom wake word model. Blocking. */
    @Throws(IOException::class)
    fun importCustom(input: InputStream) {
        dir.mkdirs()
        save(input, word(WakeWord.Custom), pin = null, check = checkCustom)
    }

    private fun save(input: InputStream, target: File, pin: String?, check: (File) -> Unit = {}) {
        val tmp = File(dir, "${target.name}.part")
        val digest = MessageDigest.getInstance("SHA-256")
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
                    digest.update(buf, 0, n)
                }
                if (total < MIN_BYTES) throw IOException("${target.name} is not a model")
            }
            val hash = digest.digest().joinToString("") { "%02x".format(it) }
            if (pin != null && hash != pin) throw IOException("${target.name} is not the expected file (checksum)")
            check(tmp)
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
        /** sha256 of the release v0.5.1 files. */
        val SHA256 = mapOf(
            MEL to "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
            EMBEDDING to "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
            "hey_jarvis_v0.1.onnx" to "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb",
            "alexa_v0.1.onnx" to "6ff566a01d12670e8d9e3c59da32651db1575d17272a601b7f8a39283dfbae3e",
            "hey_mycroft_v0.1.onnx" to "c2a311e8fa1338de89c31b3b46dc4dffd4af2f9a8d6ddead48893c2d301b1f18",
        )
        private const val MAX_BYTES = 50L * 1024 * 1024
        private const val MIN_BYTES = 1_024L
    }
}
