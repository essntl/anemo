package app.anemo.voice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceModeTest {
    private val vm = VoiceMode()

    @Test
    fun `each on is a new session`() {
        assertFalse(vm.on)
        assertTrue(vm.turnOn())
        assertFalse(vm.turnOn()) // already on
        val first = vm.session
        assertTrue(vm.turnOff())
        assertFalse(vm.turnOff())
        vm.turnOn()
        assertNotEquals(first, vm.session)
        assertFalse(vm.current(first))
        assertTrue(vm.current(vm.session))
    }

    @Test
    fun `only the awaited run's answer reopens`() {
        vm.turnOn()
        vm.started("r1", vm.session)
        assertEquals(VoiceMode.After.Nothing, vm.answered("other"))
        assertEquals(VoiceMode.After.Reopen, vm.answered("r1"))
        assertEquals(VoiceMode.After.Nothing, vm.answered("r1")) // once
    }

    @Test
    fun `a run of an older session is never awaited`() {
        vm.turnOn()
        val old = vm.session
        vm.turnOff()
        vm.turnOn()
        vm.started("r1", old)
        assertEquals(VoiceMode.After.Nothing, vm.answered("r1"))
    }

    @Test
    fun `voice stop ends after that run's answer`() {
        vm.turnOn()
        vm.started("r1", vm.session)
        vm.stopAfter("r1")
        assertEquals(VoiceMode.After.End, vm.answered("r1"))
    }

    @Test
    fun `voice stop also before the run is known, and never while off`() {
        vm.stopAfter("r1") // off: forgotten
        vm.turnOn()
        vm.started("r1", vm.session)
        assertEquals(VoiceMode.After.Reopen, vm.answered("r1"))
        vm.stopAfter("r2") // before the HTTP answer named it
        vm.started("r2", vm.session)
        assertEquals(VoiceMode.After.End, vm.answered("r2"))
    }

    @Test
    fun `nothing reopens while off`() {
        vm.started("r1", vm.session)
        assertEquals(VoiceMode.After.Nothing, vm.answered("r1"))
        assertFalse(vm.current(vm.session))
    }

    @Test
    fun `every request but the first of a session keeps the chat`() {
        vm.turnOn()
        assertFalse(vm.requestSent())
        assertTrue(vm.requestSent())
        assertTrue(vm.requestSent())
        vm.turnOff()
        vm.turnOn()
        assertFalse(vm.requestSent())
    }

    @Test
    fun `the causes on the wire`() {
        assertEquals(
            listOf("tile", "notification", "phrase", "stop_phrase", "timeout", "voice_stop", "service_stopped"),
            VoiceModeCause.entries.map { it.wire },
        )
    }
}
