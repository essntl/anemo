using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Control;

namespace Anemo.Desktop.Core;

public enum TrayIcon
{
    /// <summary>Not connected.</summary>
    Grey,

    /// <summary>Connected.</summary>
    Normal,

    /// <summary>The agent is acting on this computer right now.</summary>
    Red,
}

/// <summary>What the tray icon shows (06-desktop-client.md, "The tray icon").</summary>
public static class TrayStatus
{
    /// <summary>NotifyIcon.Text is limited to 127 characters.</summary>
    public const int MaxTooltip = 127;

    public static TrayIcon Icon(ConnectionStatus connection, bool busy) =>
        !connection.IsConnected ? TrayIcon.Grey : busy ? TrayIcon.Red : TrayIcon.Normal;

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
