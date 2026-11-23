package app.anemo.voice.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.anemo.voice.settings.Sensitivity
import app.anemo.voice.settings.WakeWord
import app.anemo.voice.ui.theme.AnemoTheme
import app.anemo.voice.ui.theme.LineIcons

/** What the settings screen shows besides the form. */
data class SettingsView(
    val form: SettingsForm,
    /** A token is saved (it is never shown). */
    val tokenSaved: Boolean,
    val addressError: String?,
    val models: ModelsRow,
    /** The phone's `TextToSpeech` voices (Android's own voice comes first in the list). */
    val voices: List<String>,
    /** The save bar's message, empty for none. */
    val message: String,
)

@Composable
fun SettingsScreen(
    view: SettingsView,
    onChange: (SettingsForm) -> Unit,
    onAddressChange: (String) -> Unit,
    onWordChange: (WakeWord) -> Unit,
    onDownload: () -> Unit,
    onImport: (Uri) -> Unit,
    onSave: () -> Unit,
    onBack: () -> Unit,
) {
    val c = AnemoTheme.colors
    val form = view.form
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) onImport(uri)
    }
    Column(Modifier.fillMaxSize().background(c.ground)) {
        BackHeader(
            "Settings",
            onBack,
            Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)),
        )
        Column(
            Modifier
                .weight(1f)
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
                .verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, bottom = 20.dp),
        ) {
            GroupLabel("Connection")
            AnemoCard {
                FieldLabel("Address")
                AnemoField(
                    value = form.address,
                    onValueChange = onAddressChange,
                    placeholder = "https://anemo.example.com",
                    isError = view.addressError != null,
                    keyboardType = KeyboardType.Uri,
                )
                if (view.addressError != null) {
                    MessageLine(view.addressError, Tone.Err, Modifier.padding(top = 8.dp))
                } else {
                    FieldHint("The one you open Anemo with.")
                }
                Spacer(Modifier.height(16.dp))
                FieldLabel("Token")
                AnemoField(
                    value = form.token,
                    onValueChange = { onChange(form.copy(token = it)) },
                    placeholder = if (view.tokenSaved) "Saved · type to replace it" else "anemo_…",
                    password = true,
                    trailing = if (view.tokenSaved && form.token.isEmpty()) {
                        { StatusChip("Saved", Tone.Ok) }
                    } else {
                        null
                    },
                )
                FieldHint("Settings → Devices in Anemo, add a phone device.")
            }

            GroupLabel("Wake word")
            AnemoCard {
                FieldLabel("Wake word")
                AnemoDropdown(
                    options = WakeWord.entries.map { SettingsTexts.wordLabel(it) },
                    selected = WakeWord.entries.indexOf(form.wakeWord),
                    onSelect = { onWordChange(WakeWord.entries[it]) },
                )
                if (form.wakeWord == WakeWord.Custom) {
                    Spacer(Modifier.height(16.dp))
                    FieldLabel("What you call it")
                    AnemoField(
                        value = form.customWordName,
                        onValueChange = { onChange(form.copy(customWordName = it)) },
                        placeholder = "Hey Anemo",
                    )
                    FieldHint("Shown and spoken by the app, e.g. “Listening for Hey Anemo”.")
                }
                Spacer(Modifier.height(16.dp))
                FieldLabel("Sensitivity")
                SegmentedControl(
                    options = listOf("Low", "Medium", "High"),
                    selected = Sensitivity.entries.indexOf(form.sensitivity),
                    onSelect = { onChange(form.copy(sensitivity = Sensitivity.entries[it])) },
                )
                FieldHint("Low: fewer false wakes. High: hears it more easily.")
                Spacer(Modifier.height(14.dp))
                Hairline()
                Spacer(Modifier.height(14.dp))
                ModelsRowView(view.models, onDownload)
                Spacer(Modifier.height(12.dp))
                ImportRow(onClick = { picker.launch(arrayOf("*/*")) })
                Spacer(Modifier.height(12.dp))
                Text(LICENCE_NOTE, color = c.subtle, fontSize = 12.sp, lineHeight = 17.sp)
            }

            GroupLabel("Sound")
            AnemoCard(padding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp)) {
                SwitchRow(
                    "Start and stop sounds",
                    "A short tone when Anemo starts and stops listening",
                    form.sounds,
                    { onChange(form.copy(sounds = it)) },
                )
                Hairline()
                SwitchRow(
                    "Bluetooth headset microphone",
                    "Used when a headset is connected",
                    form.bluetoothMic,
                    { onChange(form.copy(bluetoothMic = it)) },
                )
                Hairline()
                Spacer(Modifier.height(14.dp))
                FieldLabel("Voice")
                AnemoDropdown(
                    options = listOf(ANDROID_VOICE) + view.voices,
                    selected = view.voices.indexOf(form.voice) + 1,
                    onSelect = { onChange(form.copy(voice = view.voices.getOrNull(it - 1).orEmpty())) },
                )
                Spacer(Modifier.height(16.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    FieldLabel("Speed", Modifier.weight(1f))
                    Text(
                        SettingsForm.speedLabel(form.speedStep),
                        modifier = Modifier.padding(bottom = 8.dp),
                        color = c.accent,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                StepSlider(
                    value = form.speedStep,
                    max = SettingsForm.MAX_SPEED_STEP,
                    onChange = { onChange(form.copy(speedStep = it)) },
                )
                Row {
                    Text(SettingsForm.speedLabel(0), Modifier.weight(1f), color = c.subtle, fontSize = 11.sp)
                    Text(SettingsForm.speedLabel(SettingsForm.MAX_SPEED_STEP), color = c.subtle, fontSize = 11.sp)
                }
            }
        }
        SaveBar(view.message, onSave)
    }
}

@Composable
private fun ModelsRowView(row: ModelsRow, onDownload: () -> Unit) {
    val c = AnemoTheme.colors
    val t = c.tone(row.tone)
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconTile(
            if (row.tone == Tone.Ok) LineIcons.Check else LineIcons.Download,
            t.soft,
            t.text,
            size = 36.dp,
            iconSize = 18.dp,
            radius = 10.dp,
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(row.title, color = c.text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            // while downloading the hint is amber; otherwise plain
            val downloading = !row.canDownload && row.tone != Tone.Ok
            Text(row.hint, color = if (downloading) c.warn else c.subtle, fontSize = 12.sp)
        }
        if (row.canDownload) {
            Spacer(Modifier.width(10.dp))
            AnemoButton("Download", onDownload, primary = true)
        }
    }
}

@Composable
private fun ImportRow(onClick: () -> Unit) {
    val c = AnemoTheme.colors
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconTile(LineIcons.Upload, c.inset, c.muted, size = 36.dp, iconSize = 18.dp, radius = 10.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("Import your own word", color = c.text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text("A .onnx file trained with openWakeWord", color = c.subtle, fontSize = 12.sp)
        }
        Icon(LineIcons.ChevronRight, contentDescription = null, tint = c.muted, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun SaveBar(message: String, onSave: () -> Unit) {
    val c = AnemoTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.card)
            .drawBehind { drawLine(c.edge, Offset(0f, 0f), Offset(size.width, 0f), strokeWidth = 1.dp.toPx()) }
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        if (message.isNotEmpty()) {
            MessageLine(message, SettingsTexts.messageTone(message), Modifier.padding(start = 4.dp, bottom = 10.dp))
        }
        AnemoButton("Save", onSave, Modifier.fillMaxWidth(), primary = true)
    }
}

/** A screen's header: the back button and a 28 sp title. */
@Composable
fun BackHeader(title: String, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val c = AnemoTheme.colors
    Row(
        modifier.fillMaxWidth().height(66.dp).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CardIconButton(LineIcons.ChevronLeft, "Back", onBack)
        Spacer(Modifier.width(12.dp))
        Text(
            title,
            color = c.text,
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

private const val ANDROID_VOICE = "Android's voice"
private const val LICENCE_NOTE =
    "Pre-trained words are licensed CC BY-NC-SA 4.0 (personal, non-commercial use), so they are " +
        "downloaded here, not shipped with the app."
