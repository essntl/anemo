package app.anemo.voice.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.progressSemantics
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.anemo.voice.ui.theme.AnemoColors
import app.anemo.voice.ui.theme.AnemoTheme
import app.anemo.voice.ui.theme.LineIcons
import app.anemo.voice.ui.theme.Radius
import kotlin.math.roundToInt

private val CardShape = RoundedCornerShape(Radius.card)
private val ControlShape = RoundedCornerShape(Radius.control)

/**
 * The cards' soft static shadow: light 0 4 14 #121C38 @6% + 0 1 2 @7%; dark 0 1 2 black
 * @30% (the dark card also has a 1 px edge). Drawn with the platform's shadow layer, no blur.
 */
fun Modifier.cardShadow(colors: AnemoColors, radius: Dp = Radius.card): Modifier = drawBehind {
    val r = radius.toPx()
    val layers = if (colors.dark) {
        listOf(Triple(2.dp, 1.dp, Color.Black.copy(alpha = 0.30f)))
    } else {
        listOf(
            Triple(14.dp, 4.dp, Color(0xFF121C38).copy(alpha = 0.06f)),
            Triple(2.dp, 1.dp, Color(0xFF121C38).copy(alpha = 0.07f)),
        )
    }
    drawIntoCanvas { canvas ->
        layers.forEach { (blur, dy, color) ->
            val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                this.color = android.graphics.Color.TRANSPARENT
                // CSS blur is about twice the shadow layer's radius
                setShadowLayer(blur.toPx() / 2f, 0f, dy.toPx(), color.toArgb())
            }
            canvas.nativeCanvas.drawRoundRect(0f, 0f, size.width, size.height, r, r, paint)
        }
    }
}

/** A white (dark: #16181D) floating card. */
@Composable
fun AnemoCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    padding: PaddingValues = PaddingValues(16.dp),
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = AnemoTheme.colors
    var m = modifier
        .cardShadow(c)
        .clip(CardShape)
        .background(c.card)
    if (c.dark) m = m.border(1.dp, c.cardEdge, CardShape)
    if (onClick != null) m = m.clickable(onClick = onClick)
    Column(m.padding(padding), content = content)
}

/** The 44 dp card-style icon button of the headers (settings, about, back). */
@Composable
fun CardIconButton(icon: ImageVector, description: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = AnemoTheme.colors
    val shape = RoundedCornerShape(12.dp)
    var m = modifier
        .size(44.dp)
        .cardShadow(c, 12.dp)
        .clip(shape)
        .background(c.card)
    if (c.dark) m = m.border(1.dp, c.cardEdge, shape)
    Box(
        m.clickable(role = Role.Button, onClickLabel = description, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = description, tint = c.text, modifier = Modifier.size(20.dp))
    }
}

/** A 48 dp button: primary (accent) or secondary (inset). */
@Composable
fun AnemoButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    primary: Boolean = false,
    enabled: Boolean = true,
) {
    val c = AnemoTheme.colors
    val bg = if (primary) c.accent else c.inset
    val fg = if (primary) c.onAccent else c.text
    Row(
        modifier
            .height(48.dp)
            .clip(ControlShape)
            .background(if (enabled) bg else bg.copy(alpha = 0.5f))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(
            text,
            color = fg,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** A text-only accent button (the problem row's "Settings"). */
@Composable
fun AccentTextButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = AnemoTheme.colors
    Box(
        modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 8.dp),
    ) {
        Text(text, color = c.accent, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

data class ToneColors(val soft: Color, val dot: Color, val text: Color)

fun AnemoColors.tone(tone: Tone): ToneColors = when (tone) {
    Tone.Neutral -> ToneColors(inset, subtle, muted)
    Tone.Accent -> ToneColors(accentSoft, accent, accent)
    Tone.Ok -> ToneColors(okSoft, okDot, ok)
    Tone.Warn -> ToneColors(warnSoft, warnDot, warn)
    Tone.Err -> ToneColors(errSoft, errDot, err)
}

/** A status chip: a dot and a short text on a soft colour. */
@Composable
fun StatusChip(text: String, tone: Tone, modifier: Modifier = Modifier) {
    val t = AnemoTheme.colors.tone(tone)
    Row(
        modifier
            .clip(RoundedCornerShape(8.dp))
            .background(t.soft)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(t.dot))
        Spacer(Modifier.width(6.dp))
        Text(text, color = t.text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** A square tile with one icon in it (the listen card's state, the model rows). */
@Composable
fun IconTile(
    icon: ImageVector,
    background: Color,
    tint: Color,
    modifier: Modifier = Modifier,
    size: Dp = 52.dp,
    iconSize: Dp = 26.dp,
    radius: Dp = 14.dp,
) {
    Box(
        modifier.size(size).clip(RoundedCornerShape(radius)).background(background),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(iconSize))
    }
}

/** The small grey label above a group of cards ("Connection", "Wake word", "Sound"). */
@Composable
fun GroupLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier.padding(start = 4.dp, top = 16.dp, bottom = 8.dp),
        color = AnemoTheme.colors.subtle,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

/** A field's label, above it. */
@Composable
fun FieldLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier.padding(bottom = 8.dp),
        color = AnemoTheme.colors.text,
        fontSize = 15.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

/** The hint under a field. */
@Composable
fun FieldHint(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier = modifier.padding(top = 6.dp), color = AnemoTheme.colors.subtle, fontSize = 12.sp)
}

/** A line with an icon in the error colour (a field's error, the save bar's message). */
@Composable
fun MessageLine(text: String, tone: Tone, modifier: Modifier = Modifier) {
    val c = AnemoTheme.colors
    val color = when (tone) {
        Tone.Ok -> c.ok
        Tone.Err -> c.err
        Tone.Warn -> c.warn
        Tone.Accent -> c.accent
        Tone.Neutral -> c.muted
    }
    val icon = when (tone) {
        Tone.Ok -> LineIcons.Check
        Tone.Err, Tone.Warn -> LineIcons.Alert
        else -> null
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, color = color, fontSize = 13.sp)
    }
}

/** A one-line text field: white (dark #1E2127) with a 1 px edge, 48 dp tall. */
@Composable
fun AnemoField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    isError: Boolean = false,
    password: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = AnemoTheme.colors
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier
            .fillMaxWidth()
            .height(48.dp)
            .clip(ControlShape)
            .background(c.field)
            .border(if (isError) 1.5.dp else 1.dp, if (isError) c.err else c.edge, ControlShape),
        singleLine = true,
        textStyle = TextStyle(color = c.text, fontSize = 16.sp),
        cursorBrush = SolidColor(c.accent),
        keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else keyboardType),
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        decorationBox = { inner ->
            Row(
                Modifier.fillMaxSize().padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty() && placeholder.isNotEmpty()) {
                        Text(placeholder, color = c.subtle, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    inner()
                }
                if (trailing != null) {
                    Spacer(Modifier.width(8.dp))
                    trailing()
                }
            }
        },
    )
}

/** A field-looking dropdown with a chevron; [options] are shown in a menu as wide as it. */
@Composable
fun AnemoDropdown(
    options: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AnemoTheme.colors
    var expanded by remember { mutableStateOf(false) }
    var widthPx by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    Box(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(48.dp)
                .onSizeChanged { widthPx = it.width }
                .clip(ControlShape)
                .background(c.field)
                .border(1.dp, c.edge, ControlShape)
                .clickable(role = Role.Button) { expanded = true }
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                options.getOrElse(selected) { "" },
                modifier = Modifier.weight(1f),
                color = c.text,
                fontSize = 16.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Icon(LineIcons.ChevronDown, contentDescription = null, tint = c.muted, modifier = Modifier.size(20.dp))
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            modifier = Modifier.width(with(density) { widthPx.toDp() }),
        ) {
            options.forEachIndexed { index, option ->
                DropdownMenuItem(
                    text = {
                        Text(
                            option,
                            color = if (index == selected) c.accent else c.text,
                            fontWeight = if (index == selected) FontWeight.SemiBold else FontWeight.Normal,
                        )
                    },
                    onClick = {
                        expanded = false
                        onSelect(index)
                    },
                )
            }
        }
    }
}

/** A segmented control: an inset track, the chosen segment raised. */
@Composable
fun SegmentedControl(
    options: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AnemoTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .height(44.dp)
            .clip(ControlShape)
            .background(c.inset)
            .padding(4.dp),
    ) {
        options.forEachIndexed { index, option ->
            val on = index == selected
            val shape = RoundedCornerShape(8.dp)
            var m = Modifier.weight(1f).fillMaxHeight()
            if (on) m = m.cardShadow(c, 8.dp).clip(shape).background(c.raised) else m = m.clip(shape)
            Box(
                m.clickable(role = Role.Tab) { onSelect(index) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    option,
                    color = if (on) c.text else c.muted,
                    fontSize = 14.sp,
                    fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** A row with a title, a hint and a switch. */
@Composable
fun SwitchRow(
    title: String,
    hint: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AnemoTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .clickable(role = Role.Switch) { onChange(!checked) }
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = c.text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text(hint, color = c.subtle, fontSize = 12.sp)
        }
        Spacer(Modifier.width(12.dp))
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = c.onAccent,
                checkedTrackColor = c.accent,
                checkedBorderColor = c.accent,
                uncheckedThumbColor = c.card,
                uncheckedTrackColor = c.inset,
                uncheckedBorderColor = c.inset,
            ),
        )
    }
}

/** A hairline between rows of a card. */
@Composable
fun Hairline(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(AnemoTheme.colors.edge.copy(alpha = 0.6f)))
}

/** A slider over the steps 0..[max] with a round, ringed thumb. */
@Composable
fun StepSlider(value: Int, max: Int, onChange: (Int) -> Unit, modifier: Modifier = Modifier) {
    val c = AnemoTheme.colors
    val change by rememberUpdatedState(onChange)
    val thumb = 11.dp
    Canvas(
        modifier
            .fillMaxWidth()
            .height(32.dp)
            .progressSemantics(value.toFloat(), 0f..max.toFloat(), steps = (max - 1).coerceAtLeast(0))
            .pointerInput(max) {
                val r = thumb.toPx()
                fun pick(x: Float): Int {
                    val usable = (size.width - 2 * r).coerceAtLeast(1f)
                    return (((x - r) / usable).coerceIn(0f, 1f) * max).roundToInt()
                }
                detectTapGestures { change(pick(it.x)) }
            }
            .pointerInput(max) {
                val r = thumb.toPx()
                fun pick(x: Float): Int {
                    val usable = (size.width - 2 * r).coerceAtLeast(1f)
                    return (((x - r) / usable).coerceIn(0f, 1f) * max).roundToInt()
                }
                detectHorizontalDragGestures { pointer, _ -> change(pick(pointer.position.x)) }
            },
    ) {
        val r = thumb.toPx()
        val track = 4.dp.toPx()
        val y = size.height / 2
        val usable = size.width - 2 * r
        val x = r + usable * (if (max == 0) 0f else value.toFloat() / max)
        drawRoundRect(
            color = c.inset,
            topLeft = Offset(r, y - track / 2),
            size = Size(usable, track),
            cornerRadius = CornerRadius(track / 2),
        )
        drawRoundRect(
            color = c.accent,
            topLeft = Offset(r, y - track / 2),
            size = Size(x - r, track),
            cornerRadius = CornerRadius(track / 2),
        )
        drawCircle(color = c.card, radius = r, center = Offset(x, y))
        drawCircle(color = c.accent, radius = r - 1.dp.toPx(), center = Offset(x, y), style = Stroke(width = 2.dp.toPx()))
    }
}

/** A row of equal-width children. */
@Composable
fun EqualRow(modifier: Modifier = Modifier, gap: Dp = 10.dp, content: @Composable RowScope.() -> Unit) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), content = content)
}
