package app.anemo.voice.audio

import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

/**
 * Uses a Bluetooth headset's microphone when one is connected (and the setting is on):
 * `setCommunicationDevice` on Android 12 and later, Bluetooth SCO before that.
 */
class BluetoothRouting(private val audio: AudioManager) {
    private var routed = false

    /** Routes input to the headset if there is one; returns its device, or null. */
    fun route(): AudioDeviceInfo? {
        release()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) routeModern() else routeSco()
    }

    private fun routeModern(): AudioDeviceInfo? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        val headset = audio.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
            ?: return null
        routed = audio.setCommunicationDevice(headset)
        return if (routed) headset else null
    }

    @Suppress("DEPRECATION") // the only way before Android 12
    private fun routeSco(): AudioDeviceInfo? {
        val input = audio.getDevices(AudioManager.GET_DEVICES_INPUTS)
            .firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO } ?: return null
        if (!audio.isBluetoothScoAvailableOffCall) return null
        audio.startBluetoothSco()
        audio.isBluetoothScoOn = true
        routed = true
        return input
    }

    @Suppress("DEPRECATION")
    fun release() {
        if (!routed) return
        routed = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audio.clearCommunicationDevice()
        } else {
            audio.isBluetoothScoOn = false
            audio.stopBluetoothSco()
        }
    }
}
