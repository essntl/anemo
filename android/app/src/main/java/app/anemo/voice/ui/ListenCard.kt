package app.anemo.voice.ui

import app.anemo.voice.core.ListenState
import app.anemo.voice.service.Connection
import app.anemo.voice.service.Status
import app.anemo.voice.service.StatusText
import app.anemo.voice.settings.Problem

/** How a chip or a line is coloured. */
enum class Tone { Neutral, Accent, Ok, Warn, Err }

/** A short text with its colour (a status chip, a detail line). */
data class Toned(val text: String, val tone: Tone)

/** The listen card's icon tile. */
enum class TileKind { Off, Listening, Recording, Speaking, Paused }

/** What a button of the listen card does. */
enum class CardAction { Start, Stop, Pause, Resume, Status }

data class CardButton(val action: CardAction, val primary: Boolean)

/**
 * The amber row of the listen card: why listening can't start ([fromSetup]: a
 * `Launcher.problem`, with a "Settings" button when [opensSettings]), or another message.
 */
data class ProblemLine(val text: String, val opensSettings: Boolean, val fromSetup: Boolean)

/** Everything the main screen's listen card shows, from the service's [Status]. */
data class ListenCard(
    val title: String,
    val chip: Toned?,
    val detail: Toned?,
    val tile: TileKind,
    val buttons: List<CardButton>,
)

object ListenCards {
    const val PAUSED_DETAIL = "The wake word is off until you resume."

    /**
     * The card for [status]. [wakeWord] is the name the user knows the word by;
     * [notSetUp] is whether `Launcher.problem` found something missing (only asked when
     * not listening).
     */
    fun of(status: Status, wakeWord: String, notSetUp: Boolean): ListenCard {
        if (status.listen == ListenState.Stopped) {
            return ListenCard(
                title = "Not listening",
                chip = if (notSetUp) Toned("Not set up", Tone.Neutral) else null,
                detail = status.error?.let { Toned(it, Tone.Err) },
                tile = TileKind.Off,
                buttons = listOf(CardButton(CardAction.Start, primary = true)),
            )
        }
        val paused = status.listen == ListenState.Paused
        val title = when (status.listen) {
            ListenState.Paused -> "Paused"
            ListenState.Recording -> "Listening to you"
            ListenState.Speaking -> "Anemo is speaking"
            else -> "Listening for “$wakeWord”"
        }
        val tile = when (status.listen) {
            ListenState.Paused -> TileKind.Paused
            ListenState.Recording -> TileKind.Recording
            ListenState.Speaking -> TileKind.Speaking
            else -> TileKind.Listening
        }
        val detail = listOfNotNull(if (paused) PAUSED_DETAIL else null, status.notice)
            .joinToString(" · ")
            .ifEmpty { null }
            ?.let { Toned(it, Tone.Neutral) }
        val buttons = if (paused) {
            listOf(
                CardButton(CardAction.Resume, primary = true),
                CardButton(CardAction.Stop, primary = false),
                CardButton(CardAction.Status, primary = false),
            )
        } else {
            listOf(
                CardButton(CardAction.Stop, primary = false),
                CardButton(CardAction.Pause, primary = false),
                CardButton(CardAction.Status, primary = false),
            )
        }
        return ListenCard(StatusText.withVoiceMode(title, status.voiceMode), chip(status), detail, tile, buttons)
    }

    /** The chip while listening: an error, else what the connection is doing. */
    fun chip(status: Status): Toned {
        status.error?.let { return Toned(it, Tone.Err) }
        val connection = status.connection
        val text = StatusText.connection(connection)
        return when (connection) {
            is Connection.Refused, is Connection.Retrying -> Toned(text.orEmpty(), Tone.Err)
            Connection.Connecting -> Toned(text.orEmpty(), Tone.Neutral)
            is Connection.Connected, Connection.Off ->
                Toned(listOfNotNull("Connected", StatusText.activeRuns(status.activeRuns)).joinToString(" · "), Tone.Ok)
        }
    }

    /** Whether the problem row offers a "Settings" button: the fix is in the app's settings. */
    fun fixedInSettings(problem: Problem): Boolean = when (problem) {
        Problem.NoAddress, Problem.BadAddress, Problem.NoToken, Problem.NoWakeWordModel -> true
        Problem.NoMicrophone, Problem.NoNotifications -> false
    }

    fun problemLine(problem: Problem) = ProblemLine(problem.message, fixedInSettings(problem), fromSetup = true)

    /** The empty history's text. */
    fun emptyHistory(wakeWord: String): String =
        "Say “$wakeWord”, then what you want. Answers are spoken and kept here, with a link to the chat."
}
