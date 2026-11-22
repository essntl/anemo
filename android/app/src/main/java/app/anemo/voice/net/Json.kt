package app.anemo.voice.net

import org.json.JSONObject

/**
 * A string field, or null when it is missing or JSON `null`. (Android's `optString`
 * turns `null` into the text "null"; this never does.)
 */
internal fun JSONObject.stringOrNull(key: String): String? =
    if (!has(key) || isNull(key)) null else opt(key)?.toString()
