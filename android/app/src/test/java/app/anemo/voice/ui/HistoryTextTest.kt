package app.anemo.voice.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

class HistoryTextTest {
    private val zone = TimeZone.getTimeZone("Europe/Kyiv")

    private fun at(year: Int, month: Int, day: Int, hour: Int, minute: Int): Long =
        Calendar.getInstance(zone).apply {
            clear()
            set(year, month - 1, day, hour, minute)
        }.timeInMillis

    private val now = at(2026, 11, 23, 9, 30)

    private fun time(createdAt: Long) = HistoryText.time(createdAt, now, zone, Locale.UK)

    @Test
    fun `today and yesterday by the calendar day, not 24 hours`() {
        assertEquals("Today, 00:05", time(at(2026, 11, 23, 0, 5)))
        assertEquals("Yesterday, 23:55", time(at(2026, 11, 22, 23, 55)))
        assertEquals("Yesterday, 00:01", time(at(2026, 11, 22, 0, 1)))
    }

    @Test
    fun `older requests show the date and time`() {
        val older = time(at(2026, 11, 20, 18, 41))
        assertTrue(older, !older.startsWith("Today") && !older.startsWith("Yesterday") && older.contains("18:41"))
    }

    @Test
    fun `what was heard is quoted`() = assertEquals("Heard: “add oat milk”", HistoryText.heard("add oat milk"))
}
