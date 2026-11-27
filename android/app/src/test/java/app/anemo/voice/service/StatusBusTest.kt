package app.anemo.voice.service

import app.anemo.voice.core.ListenState
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class StatusBusTest {
    private val heard = mutableListOf<Status>()
    private val listener: (Status) -> Unit = { heard += it }

    @After
    fun tearDown() {
        StatusBus.forget(listener)
        StatusBus.update { Status() }
    }

    @Test
    fun `listeners hear changes, not repeats of the same status`() {
        StatusBus.update { Status() }
        StatusBus.observe(listener)
        StatusBus.update { it.copy(listen = ListenState.Listening) }
        StatusBus.update { it.copy(listen = ListenState.Listening) } // the same again
        StatusBus.update { it.copy(activeRuns = 0) } // already 0
        StatusBus.update { it.copy(activeRuns = 1) }
        assertEquals(listOf(ListenState.Listening, ListenState.Listening), heard.map { it.listen })
        assertEquals(listOf(0, 1), heard.map { it.activeRuns })
    }
}
