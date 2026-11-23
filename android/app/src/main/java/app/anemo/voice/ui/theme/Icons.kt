package app.anemo.voice.ui.theme

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * The app's line icons (lucide style, 24-grid, stroke only), drawn from SVG path strings so
 * no icon library is needed. They are drawn black: `Icon(tint = …)` colours them.
 */
object LineIcons {
    val Sliders by lazy {
        icon(
            "sliders",
            "M21 4H14", "M10 4H3", "M21 12H12", "M8 12H3", "M21 20H16", "M12 20H3",
            "M14 2V6", "M8 10V14", "M16 18V22",
        )
    }
    val Info by lazy { icon("info", CIRCLE, "M12 16V12", "M12 8H12.01") }
    val Alert by lazy { icon("alert", CIRCLE, "M12 8V12", "M12 16H12.01") }
    val Mic by lazy {
        icon(
            "mic",
            "M12 2A3 3 0 0 0 9 5V12A3 3 0 0 0 15 12V5A3 3 0 0 0 12 2Z",
            "M19 10V12A7 7 0 0 1 5 12V10",
            "M12 19V22",
        )
    }
    val MicOff by lazy {
        icon(
            "mic-off",
            "M2 2L22 22",
            "M18.89 13.23A7.12 7.12 0 0 0 19 12V10",
            "M5 10V12A7 7 0 0 0 17 17",
            "M15 9.34V5A3 3 0 0 0 9.32 3.67",
            "M9 9V12A3 3 0 0 0 14.12 14.12",
            "M12 19V22",
        )
    }
    val AudioLines by lazy {
        icon("audio-lines", "M2 10V13", "M6 6V17", "M10 3V21", "M14 8V15", "M18 5V18", "M22 10V13")
    }
    val Volume by lazy {
        icon("volume", "M11 5L6 9H2V15H6L11 19V5Z", "M15.54 8.46A5 5 0 0 1 15.54 15.54", "M19.07 4.93A10 10 0 0 1 19.07 19.07")
    }
    val Pause by lazy {
        icon(
            "pause",
            "M7 4H9A1 1 0 0 1 10 5V19A1 1 0 0 1 9 20H7A1 1 0 0 1 6 19V5A1 1 0 0 1 7 4Z",
            "M15 4H17A1 1 0 0 1 18 5V19A1 1 0 0 1 17 20H15A1 1 0 0 1 14 19V5A1 1 0 0 1 15 4Z",
        )
    }
    val Play by lazy { icon("play", "M6 3L20 12L6 21V3Z") }
    val Stop by lazy { icon("stop", "M8 6H16A2 2 0 0 1 18 8V16A2 2 0 0 1 16 18H8A2 2 0 0 1 6 16V8A2 2 0 0 1 8 6Z") }
    val Refresh by lazy {
        icon(
            "refresh",
            "M3 12A9 9 0 0 1 12 3A9.75 9.75 0 0 1 18.74 5.74L21 8",
            "M21 3V8H16",
            "M21 12A9 9 0 0 1 12 21A9.75 9.75 0 0 1 5.26 18.26L3 16",
            "M8 16H3V21",
        )
    }
    val External by lazy {
        icon("external", "M15 3H21V9", "M10 14L21 3", "M18 13V19A2 2 0 0 1 16 21H5A2 2 0 0 1 3 19V8A2 2 0 0 1 5 6H11")
    }
    val ChevronLeft by lazy { icon("chevron-left", "M15 18L9 12L15 6") }
    val ChevronRight by lazy { icon("chevron-right", "M9 18L15 12L9 6") }
    val ChevronDown by lazy { icon("chevron-down", "M6 9L12 15L18 9") }
    val Check by lazy { icon("check", "M20 6L9 17L4 12") }
    val Download by lazy {
        icon("download", "M21 15V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V15", "M7 10L12 15L17 10", "M12 15V3")
    }
    val Upload by lazy {
        icon("upload", "M21 15V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V15", "M17 8L12 3L7 8", "M12 3V15")
    }
    val Message by lazy { icon("message", "M21 15A2 2 0 0 1 19 17H7L3 21V5A2 2 0 0 1 5 3H19A2 2 0 0 1 21 5Z") }
    val Copy by lazy {
        icon(
            "copy",
            "M10 8H20A2 2 0 0 1 22 10V20A2 2 0 0 1 20 22H10A2 2 0 0 1 8 20V10A2 2 0 0 1 10 8Z",
            "M4 16C2.9 16 2 15.1 2 14V4C2 2.9 2.9 2 4 2H14C15.1 2 16 2.9 16 4",
        )
    }

    private const val CIRCLE = "M2 12A10 10 0 1 0 22 12A10 10 0 1 0 2 12Z"

    private fun icon(name: String, vararg paths: String): ImageVector {
        val builder = ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        )
        paths.forEach { d ->
            builder.addPath(
                pathData = PathParser().parsePathString(d).toNodes(),
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 1.9f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
        return builder.build()
    }
}

/** The Anemo mark's three strokes (24-grid), as in `res/drawable/ic_launcher_foreground.xml`. */
private val MARK_PATHS = listOf("M5 8H12.5A2.5 2.5 0 1 0 10 5.5", "M1.5 12H17.5A3 3 0 1 1 14.5 15", "M4 16H10.5")

/** The Anemo mark, stroked with [color] fading in from transparent at x = 1 to opaque at x = 13. */
fun anemoMark(color: Color): ImageVector {
    val brush: Brush = Brush.linearGradient(
        colors = listOf(color.copy(alpha = 0f), color),
        start = Offset(1f, 0f),
        end = Offset(13f, 0f),
    )
    val builder = ImageVector.Builder(
        name = "anemo-mark",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    )
    builder.addGroup(name = "mark", translationX = 0.75f, translationY = 1.5f)
    MARK_PATHS.forEach { d ->
        builder.addPath(
            pathData = PathParser().parsePathString(d).toNodes(),
            fill = null,
            stroke = brush,
            strokeLineWidth = 1.7f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        )
    }
    builder.clearGroup()
    return builder.build()
}
