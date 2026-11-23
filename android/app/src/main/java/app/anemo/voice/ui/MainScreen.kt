package app.anemo.voice.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.anemo.voice.core.HistoryEntry
import app.anemo.voice.core.HistoryStore
import app.anemo.voice.ui.theme.AnemoTheme
import app.anemo.voice.ui.theme.LineIcons
import app.anemo.voice.ui.theme.anemoMark

/** The main screen: the listen card and the last requests. */
@Composable
fun MainScreen(
    card: ListenCard,
    problem: ProblemLine?,
    history: List<HistoryEntry>?,
    wakeWord: String,
    onAction: (CardAction) -> Unit,
    onSettings: () -> Unit,
    onAbout: () -> Unit,
    onOpen: (HistoryEntry) -> Unit,
) {
    val c = AnemoTheme.colors
    val bottom = WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom).asPaddingValues().calculateBottomPadding()
    Column(Modifier.fillMaxSize().background(c.ground)) {
        MainHeader(
            onSettings = onSettings,
            onAbout = onAbout,
            modifier = Modifier.windowInsetsPadding(
                WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
            ),
        )
        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 0.dp, bottom = bottom + 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { ListenCardView(card, problem, onAction, onSettings) }
            item { RecentHeader(showLimit = !history.isNullOrEmpty()) }
            if (history != null && history.isEmpty()) {
                item { EmptyHistory(wakeWord) }
            }
            if (history != null) {
                items(history) { entry -> RequestCard(entry, onOpen = { onOpen(entry) }) }
            }
        }
    }
}

@Composable
private fun MainHeader(onSettings: () -> Unit, onAbout: () -> Unit, modifier: Modifier = Modifier) {
    val c = AnemoTheme.colors
    val mark = remember(c.accent) { anemoMark(c.accent) }
    Row(
        modifier.fillMaxWidth().height(66.dp).padding(start = 20.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(rememberVectorPainter(mark), contentDescription = null, modifier = Modifier.size(30.dp))
        Spacer(Modifier.width(10.dp))
        Text(
            "Anemo Voice",
            modifier = Modifier.weight(1f),
            color = c.text,
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        CardIconButton(LineIcons.Sliders, "Settings", onSettings)
        Spacer(Modifier.width(10.dp))
        CardIconButton(LineIcons.Info, "About and licences", onAbout)
    }
}

private data class ActionLook(val label: String, val icon: ImageVector)

private fun look(action: CardAction): ActionLook = when (action) {
    CardAction.Start -> ActionLook("Start listening", LineIcons.Mic)
    CardAction.Stop -> ActionLook("Stop", LineIcons.Stop)
    CardAction.Pause -> ActionLook("Pause", LineIcons.Pause)
    CardAction.Resume -> ActionLook("Resume", LineIcons.Play)
    CardAction.Status -> ActionLook("Status", LineIcons.Volume)
}

@Composable
private fun ListenCardView(
    card: ListenCard,
    problem: ProblemLine?,
    onAction: (CardAction) -> Unit,
    onSettings: () -> Unit,
) {
    val c = AnemoTheme.colors
    AnemoCard(padding = PaddingValues(18.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            when (card.tile) {
                TileKind.Off -> IconTile(LineIcons.MicOff, c.inset, c.subtle)
                TileKind.Listening -> IconTile(LineIcons.Mic, c.accentSoft, c.accent)
                TileKind.Recording -> IconTile(LineIcons.AudioLines, c.accent, c.onAccent)
                TileKind.Speaking -> IconTile(LineIcons.Volume, c.accent, c.onAccent)
                TileKind.Paused -> IconTile(LineIcons.Pause, c.warnSoft, c.warn)
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(card.title, color = c.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                card.chip?.let {
                    Spacer(Modifier.height(6.dp))
                    StatusChip(it.text, it.tone)
                }
                card.detail?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(it.text, color = if (it.tone == Tone.Err) c.err else c.muted, fontSize = 13.sp)
                }
            }
        }
        if (problem != null) {
            Spacer(Modifier.height(16.dp))
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(c.warnSoft)
                    .padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(LineIcons.Alert, contentDescription = null, tint = c.warn, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    problem.text,
                    modifier = Modifier.weight(1f).padding(vertical = 8.dp),
                    color = c.text,
                    fontSize = 14.sp,
                )
                if (problem.opensSettings) AccentTextButton("Settings", onSettings)
            }
        }
        Spacer(Modifier.height(16.dp))
        EqualRow {
            card.buttons.forEach { b ->
                val l = look(b.action)
                AnemoButton(
                    text = l.label,
                    onClick = { onAction(b.action) },
                    modifier = Modifier.weight(1f),
                    icon = l.icon,
                    primary = b.primary,
                )
            }
        }
    }
}

@Composable
private fun RecentHeader(showLimit: Boolean) {
    val c = AnemoTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Text(
            "Recent requests",
            modifier = Modifier.weight(1f),
            color = c.text,
            fontSize = 17.sp,
            fontWeight = FontWeight.Bold,
        )
        if (showLimit) Text("Last ${HistoryStore.LIMIT}", color = c.subtle, fontSize = 12.sp)
    }
}

@Composable
private fun EmptyHistory(wakeWord: String) {
    val c = AnemoTheme.colors
    AnemoCard(padding = PaddingValues(horizontal = 24.dp, vertical = 28.dp)) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            IconTile(LineIcons.Message, c.inset, c.muted, size = 44.dp, iconSize = 22.dp, radius = 12.dp)
            Spacer(Modifier.height(14.dp))
            Text("No requests yet", color = c.text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(6.dp))
            Text(
                ListenCards.emptyHistory(wakeWord),
                color = c.muted,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun RequestCard(entry: HistoryEntry, onOpen: () -> Unit) {
    val c = AnemoTheme.colors
    AnemoCard(onClick = onOpen) {
        Text(entry.request, color = c.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Text(HistoryText.heard(entry.heard), color = c.subtle, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        val answer = entry.answer
        if (answer != null) {
            Text(answer, color = c.muted, fontSize = 13.sp, lineHeight = 19.sp)
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(LineIcons.Refresh, contentDescription = null, tint = c.accent, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(8.dp))
                Text("Working…", color = c.accent, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
        }
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                HistoryText.time(entry.createdAt),
                modifier = Modifier.weight(1f),
                color = c.subtle,
                fontSize = 12.sp,
            )
            Row(
                Modifier.clip(RoundedCornerShape(6.dp)).clickable(onClick = onOpen).padding(2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Open chat", color = c.accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(6.dp))
                Icon(LineIcons.External, contentDescription = null, tint = c.accent, modifier = Modifier.size(13.dp))
            }
        }
    }
}
