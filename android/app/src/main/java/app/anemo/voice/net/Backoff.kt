package app.anemo.voice.net

import kotlin.random.Random

/** Reconnect delays: doubling from [initialMs] up to [maxMs], with ±20 % jitter. */
class Backoff(
    private val initialMs: Long = 1_000,
    private val maxMs: Long = 60_000,
    private val random: Random = Random.Default,
) {
    private var attempt = 0

    fun next(): Long {
        val base = minOf(maxMs, initialMs shl minOf(attempt, 20))
        attempt++
        val jitter = 0.8 + random.nextDouble() * 0.4
        return (base * jitter).toLong().coerceAtLeast(1)
    }

    fun reset() {
        attempt = 0
    }
}
