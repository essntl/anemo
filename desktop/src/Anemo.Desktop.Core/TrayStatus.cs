using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Control;

namespace Anemo.Desktop.Core;

/// <summary>The tray icon's states: the Anemo mark on a tile, its colour or a badge says which.</summary>
public enum TrayIcon
{
    /// <summary>Connecting, or lost and trying again: a grey tile.</summary>
    Grey,

    /// <summary>Connected: the dark tile.</summary>
    Normal,

    /// <summary>The agent is acting on this computer right now: a red tile.</summary>
    Red,

    /// <summary>Connected, control paused: the dark tile with an amber pause badge.</summary>
    Paused,

    /// <summary>Not set up, or refused by Anemo (it waits for new settings): grey with an amber "!".</summary>
    Problem,
}

/// <summary>What the tray icon shows (06-desktop-client.md, "The tray icon").</summary>
public static class TrayStatus
{
    /// <summary>NotifyIcon.Text is limited to 127 characters.</summary>
    public const int MaxTooltip = 127;

    public static TrayIcon Icon(ConnectionStatus connection, bool busy, ControlState control) => connection.Phase switch
    {
        ConnectionPhase.NotConfigured or ConnectionPhase.Refused => TrayIcon.Problem,
        ConnectionPhase.Connected when busy => TrayIcon.Red,
        ConnectionPhase.Connected when control.PausedUntil is not null => TrayIcon.Paused,
        ConnectionPhase.Connected => TrayIcon.Normal,
        _ => TrayIcon.Grey,
    };

    public static string Tooltip(ConnectionStatus connection, bool busy, ControlState control)
    {
        var line = connection.Phase switch
        {
            ConnectionPhase.NotConfigured => "not set up: open Settings",
            ConnectionPhase.Connecting => "connecting…",
            ConnectionPhase.Connected when busy => "the agent is using this computer",
            ConnectionPhase.Connected => "connected",
            ConnectionPhase.Waiting => "not connected, trying again",
            _ => "not connected: " + (connection.Message ?? "see Settings"),
        };

        var controlLine = !control.AllowControl
            ? "control off"
            : control.PausedUntil is { } until
                ? $"control paused until {until.ToLocalTime():HH:mm}"
                : null;

        var text = "Anemo Desktop: " + line + (controlLine is null ? "" : "\n" + controlLine);
        return text.Length <= MaxTooltip ? text : text[..(MaxTooltip - 1)] + "…";
    }
}
