package app.anemo.voice.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The app's colour tokens (the "Native apps v2" design); dynamic colour is off. */
@Immutable
data class AnemoColors(
    val dark: Boolean,
    val ground: Color,
    val card: Color,
    val inset: Color,
    val raised: Color,
    val field: Color,
    val edge: Color,
    val text: Color,
    val muted: Color,
    val subtle: Color,
    val accent: Color,
    val onAccent: Color,
    val accentSoft: Color,
    val ok: Color,
    val okDot: Color,
    val okSoft: Color,
    val warn: Color,
    val warnDot: Color,
    val warnSoft: Color,
    val err: Color,
    val errDot: Color,
    val errSoft: Color,
    /** The card's 1 px edge in the dark theme (none in the light one, which has a shadow). */
    val cardEdge: Color,
)

val LightColors = AnemoColors(
    dark = false,
    ground = Color(0xFFECEEF2),
    card = Color(0xFFFFFFFF),
    inset = Color(0xFFE4E7ED),
    raised = Color(0xFFFFFFFF),
    field = Color(0xFFFFFFFF),
    edge = Color(0xFF0F141E).copy(alpha = 0.13f),
    text = Color(0xFF14161A),
    muted = Color(0xFF3D434E),
    subtle = Color(0xFF555C69),
    accent = Color(0xFF2A6DF4),
    onAccent = Color(0xFFFFFFFF),
    accentSoft = Color(0xFFE3ECFE),
    ok = Color(0xFF1A7F47),
    okDot = Color(0xFF1F9D55),
    okSoft = Color(0xFFE3F4EA),
    warn = Color(0xFFB45309),
    warnDot = Color(0xFFD97706),
    warnSoft = Color(0xFFFCF0DE),
    err = Color(0xFFC42B2B),
    errDot = Color(0xFFDC3B3B),
    errSoft = Color(0xFFFCE8E8),
    cardEdge = Color.Transparent,
)

val DarkColors = AnemoColors(
    dark = true,
    ground = Color(0xFF0B0C10),
    card = Color(0xFF16181D),
    inset = Color(0xFF22262D),
    raised = Color(0xFF2C3038),
    field = Color(0xFF1E2127),
    edge = Color(0xFFFFFFFF).copy(alpha = 0.13f),
    text = Color(0xFFECEEF2),
    muted = Color(0xFFBCC2CD),
    subtle = Color(0xFFA0A7B4),
    accent = Color(0xFF6A9DFF),
    onAccent = Color(0xFF0B1220),
    accentSoft = Color(0xFF1F2C45),
    ok = Color(0xFF3CCF7A),
    okDot = Color(0xFF3CCF7A),
    okSoft = Color(0xFF173126),
    warn = Color(0xFFF2A93B),
    warnDot = Color(0xFFF2A93B),
    warnSoft = Color(0xFF3A2C17),
    err = Color(0xFFF06464),
    errDot = Color(0xFFF06464),
    errSoft = Color(0xFF3D2023),
    cardEdge = Color(0xFFFFFFFF).copy(alpha = 0.06f),
)

val LocalAnemoColors = staticCompositionLocalOf { LightColors }

object AnemoTheme {
    val colors: AnemoColors
        @Composable @ReadOnlyComposable get() = LocalAnemoColors.current
}

/** Cards 16, controls (buttons, fields) 10. */
object Radius {
    val card = 16.dp
    val control = 10.dp
}

@Composable
fun AnemoTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val c = if (dark) DarkColors else LightColors
    val scheme = if (dark) {
        darkColorScheme(
            primary = c.accent, onPrimary = c.onAccent, primaryContainer = c.accentSoft,
            background = c.ground, onBackground = c.text,
            surface = c.card, onSurface = c.text, onSurfaceVariant = c.muted,
            surfaceContainer = c.raised, surfaceVariant = c.inset,
            outline = c.edge, outlineVariant = c.edge,
            error = c.err, errorContainer = c.errSoft,
        )
    } else {
        lightColorScheme(
            primary = c.accent, onPrimary = c.onAccent, primaryContainer = c.accentSoft,
            background = c.ground, onBackground = c.text,
            surface = c.card, onSurface = c.text, onSurfaceVariant = c.muted,
            surfaceContainer = c.raised, surfaceVariant = c.inset,
            outline = c.edge, outlineVariant = c.edge,
            error = c.err, errorContainer = c.errSoft,
        )
    }
    val shapes = Shapes(
        extraSmall = RoundedCornerShape(Radius.control),
        small = RoundedCornerShape(Radius.control),
        medium = RoundedCornerShape(Radius.card),
        large = RoundedCornerShape(Radius.card),
    )
    CompositionLocalProvider(LocalAnemoColors provides c) {
        MaterialTheme(colorScheme = scheme, shapes = shapes) {
            // the system font at its own line height (Material's bodyLarge has 24 sp lines)
            CompositionLocalProvider(
                LocalTextStyle provides TextStyle(color = c.text, fontSize = 15.sp, letterSpacing = 0.sp),
                content = content,
            )
        }
    }
}
