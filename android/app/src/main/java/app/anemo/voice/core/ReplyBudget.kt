package app.anemo.voice.core

/**
 * How often a run can make the phone listen without a wake word: at most [perRun] reply
 * windows per run and [total] in all within [windowMs]. Beyond that the phone says
 * "Please answer on the notification" instead, so no run can turn it into a listening
 * device. [clock] is monotonic (`SystemClock.elapsedRealtime` on Android).
 */
class ReplyBudget(
    private val clock: Clock,
    private val perRun: Int = 3,
    private val total: Int = 6,
    private val windowMs: Long = 5 * 60 * 1000L,
) {
    private val opened = ArrayDeque<Pair<String, Long>>()

    /** Takes one reply window for [runId] if there is one left. */
    fun take(runId: String): Boolean {
        val now = clock.nowMillis()
        while (opened.isNotEmpty() && now - opened.first().second >= windowMs) opened.removeFirst()
        if (opened.size >= total || opened.count { it.first == runId } >= perRun) return false
        opened.addLast(runId to now)
        return true
    }
}
