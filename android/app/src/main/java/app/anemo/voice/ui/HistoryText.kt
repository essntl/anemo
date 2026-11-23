package app.anemo.voice.ui

import java.text.DateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** The texts of a request card in the history. */
object HistoryText {
    fun heard(heard: String): String = "Heard: “$heard”"

    /** "Today, 12:04", "Yesterday, 18:41", or the short date and time for older ones. */
    fun time(
        createdAt: Long,
        now: Long = System.currentTimeMillis(),
        zone: TimeZone = TimeZone.getDefault(),
        locale: Locale = Locale.getDefault(),
    ): String {
        val days = dayNumber(now, zone) - dayNumber(createdAt, zone)
        val date = Date(createdAt)
        return when (days) {
            0L -> "Today, " + timeFormat(locale, zone).format(date)
            1L -> "Yesterday, " + timeFormat(locale, zone).format(date)
            else -> DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT, locale)
                .apply { timeZone = zone }
                .format(date)
        }
    }

    private fun timeFormat(locale: Locale, zone: TimeZone): DateFormat =
        DateFormat.getTimeInstance(DateFormat.SHORT, locale).apply { timeZone = zone }

    /** Days since the epoch in [zone] (calendar days, so a DST change doesn't move it). */
    private fun dayNumber(millis: Long, zone: TimeZone): Long {
        val c = Calendar.getInstance(zone).apply { timeInMillis = millis }
        val utc = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
            clear()
            set(c.get(Calendar.YEAR), c.get(Calendar.MONTH), c.get(Calendar.DAY_OF_MONTH))
        }
        return Math.floorDiv(utc.timeInMillis, 86_400_000L)
    }
}
