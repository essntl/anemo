namespace Anemo.Desktop.Core.Updates;

/// <summary>The words both clients show for the updater, so Windows and macOS say the same.</summary>
public static class UpdateText
{
    /// <summary>The line in Settings under "Update automatically".</summary>
    public static string Status(UpdateState state, bool automatic, string currentVersion) => state.Phase switch
    {
        UpdatePhase.Unavailable => state.Message ?? "This copy doesn't update itself.",
        UpdatePhase.Idle => automatic
            ? "Checks GitHub for a new version at start and every 6 hours."
            : "Automatic updates are off. Check now looks once.",
        UpdatePhase.Checking => "Checking for a new version…",
        UpdatePhase.UpToDate => $"{currentVersion} is the newest version{Checked(state)}.",
        UpdatePhase.Downloading => $"Downloading {state.Version}…",
        UpdatePhase.Ready => $"{state.Version} is ready: it is installed when you quit, or now with Restart to update.",
        UpdatePhase.WaitingToRestart => state.Message is { } why
            ? $"Restarting to update to {state.Version} once nothing is running ({why})."
            : $"Restarting to update to {state.Version}…",
        UpdatePhase.Failed => state.Message ?? "The last check failed.",
        _ => "",
    };

    /// <summary>The tray or menu bar item: "Update to X ready…" when there is one, else null (no item).</summary>
    public static string? MenuItem(UpdateState state) => state.Phase switch
    {
        UpdatePhase.Ready => $"Update to {state.Version} ready: Restart to update",
        UpdatePhase.WaitingToRestart => $"Update to {state.Version}: restarting when the agent is done…",
        _ => null,
    };

    /// <summary>A short line for the tray tooltip, or null.</summary>
    public static string? Tooltip(UpdateState state) => state.Phase switch
    {
        UpdatePhase.Ready or UpdatePhase.WaitingToRestart => $"update to {state.Version} ready",
        _ => null,
    };

    private static string Checked(UpdateState state) =>
        state.CheckedAt is { } at ? $" (checked at {at.ToLocalTime():HH:mm})" : "";
}
