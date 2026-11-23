package app.anemo.voice.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.anemo.voice.ui.theme.AnemoTheme
import app.anemo.voice.ui.theme.LineIcons
import app.anemo.voice.ui.theme.anemoMark

/** About Anemo Voice and the licence texts; [which] is the shown text (0 licences, 1 ONNX Runtime). */
@Composable
fun AboutScreen(
    version: String,
    which: Int,
    fileName: String,
    text: String,
    onWhich: (Int) -> Unit,
    onBack: () -> Unit,
) {
    val c = AnemoTheme.colors
    val clipboard = LocalClipboardManager.current
    val mark = remember { anemoMark(Color.White) }
    Column(Modifier.fillMaxSize().background(c.ground)) {
        BackHeader(
            "About",
            onBack,
            Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)),
        )
        Column(
            Modifier
                .weight(1f)
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom))
                .verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 20.dp),
        ) {
            AnemoCard(padding = PaddingValues(horizontal = 20.dp, vertical = 24.dp)) {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(
                        Modifier.size(72.dp).clip(RoundedCornerShape(18.dp)).background(Color(0xFF15181E)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Image(rememberVectorPainter(mark), contentDescription = null, modifier = Modifier.size(48.dp))
                    }
                    Spacer(Modifier.height(16.dp))
                    Text("Anemo Voice", color = c.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(4.dp))
                    Text("Version $version", color = c.muted, fontSize = 14.sp)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Talk to your Anemo from this phone. Part of Anemo, GNU GPL v2.",
                        color = c.muted,
                        fontSize = 14.sp,
                        textAlign = TextAlign.Center,
                    )
                }
            }
            Spacer(Modifier.height(16.dp))
            SegmentedControl(listOf("Licences", "ONNX Runtime notices"), which, onWhich)
            Spacer(Modifier.height(16.dp))
            AnemoCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        fileName,
                        modifier = Modifier.weight(1f),
                        color = c.muted,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.Monospace,
                    )
                    Box(
                        Modifier
                            .size(36.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .clickable(role = Role.Button, onClickLabel = "Copy") { clipboard.setText(AnnotatedString(text)) },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(LineIcons.Copy, contentDescription = "Copy", tint = c.subtle, modifier = Modifier.size(16.dp))
                    }
                }
                Spacer(Modifier.height(8.dp))
                SelectionContainer {
                    Text(
                        text,
                        color = c.text,
                        fontSize = 11.sp,
                        lineHeight = 16.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }
    }
}
