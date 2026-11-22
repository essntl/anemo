package app.anemo.voice.service

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import ai.onnxruntime.OrtEnvironment
import app.anemo.voice.ml.ModelFiles
import app.anemo.voice.ml.OpenWakeWord
import java.io.IOException
import app.anemo.voice.settings.AndroidSettingsStore
import app.anemo.voice.settings.Problem
import app.anemo.voice.settings.Readiness
import okhttp3.OkHttpClient
import java.io.File

/** Starts and stops [ListenService] from the app and the tile, after checking it can run. */
object Launcher {
    fun problem(context: Context): Problem? {
        val settings = AndroidSettingsStore(context).load()
        val mic = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val notifications = ListenNotification.visible(context)
        return Readiness.check(settings, mic, notifications, modelFiles(context).present(settings.wakeWord))
    }

    fun modelFiles(context: Context) = ModelFiles(
        File(context.filesDir, "models"),
        OkHttpClient(),
        checkCustom = { file ->
            try {
                OpenWakeWord.checkWordModel(OrtEnvironment.getEnvironment(), file.readBytes())
            } catch (e: IllegalArgumentException) {
                throw IOException(e.message)
            }
        },
    )

    /** Throws what `startForegroundService` throws when Android doesn't allow it now. */
    fun start(context: Context) {
        context.startForegroundService(ListenService.intent(context, ListenService.START))
    }

    fun send(context: Context, action: String) {
        if (ListenService.running) context.startService(ListenService.intent(context, action))
    }
}
