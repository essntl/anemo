package app.anemo.voice.net

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The Anemo address the user typed (the one the web app uses), and the URLs built from
 * it. The token is never part of a URL.
 */
class Address private constructor(val base: HttpUrl) {
    fun api(path: String): HttpUrl = resolve("api/$path")

    /** OkHttp takes http(s) URLs for WebSockets and upgrades them itself. */
    val deviceSocket: HttpUrl get() = api("devices/ws")

    fun chat(conversationId: String): String = resolve("c/$conversationId").toString()

    private fun resolve(relative: String): HttpUrl {
        val b = base.newBuilder()
        relative.split('/').forEach { b.addPathSegment(it) }
        return b.build()
    }

    override fun toString(): String = base.toString().trimEnd('/')

    companion object {
        /**
         * Parses what the user typed. Without a scheme it is https. A path is kept (Anemo
         * behind a sub-path), a trailing slash, query and fragment are dropped. Returns
         * null when it isn't an address, or when [allowHttp] is false and it is http.
         */
        fun parse(input: String, allowHttp: Boolean = false): Address? {
            val text = input.trim()
            if (text.isEmpty()) return null
            val withScheme = if ("://" in text) text else "https://$text"
            val url = withScheme.toHttpUrlOrNull() ?: return null
            if (!allowHttp && url.scheme != "https") return null
            val segments = url.pathSegments.filter { it.isNotEmpty() }
            val b = url.newBuilder().query(null).fragment(null).encodedPath("/")
            segments.forEach { b.addPathSegment(it) }
            return Address(b.build())
        }
    }
}
