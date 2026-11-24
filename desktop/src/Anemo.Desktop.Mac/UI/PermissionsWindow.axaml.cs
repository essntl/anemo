using Anemo.Desktop.Mac.Platform;
using Avalonia.Controls;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;

namespace Anemo.Desktop.Mac.UI;

/// <summary>Screen Recording and Accessibility: what they are for, and the way to give them (D7).</summary>
public sealed partial class PermissionsWindow : Window
{
    private readonly DispatcherTimer _poll = new() { Interval = TimeSpan.FromSeconds(1.5) };

    public PermissionsWindow()
    {
        AvaloniaXamlLoader.Load(this);
        Icon = Icons.App;
        Control<Button>("AskScreen").Click += (_, _) => Permissions.AskScreenRecording();
        Control<Button>("OpenScreen").Click += (_, _) => Permissions.OpenScreenRecordingSettings();
        Control<Button>("AskAccess").Click += (_, _) => Permissions.AskAccessibility();
        Control<Button>("OpenAccess").Click += (_, _) => Permissions.OpenAccessibilitySettings();
        Control<Button>("Done").Click += (_, _) => Close();

        // The user switches them on in System Settings: show it here as soon as macOS says so.
        _poll.Tick += (_, _) => ShowStates();
        Opened += (_, _) => _poll.Start();
        Closed += (_, _) => _poll.Stop();
        ShowStates();
    }

    private void ShowStates()
    {
        ShowState("ScreenState", "AskScreen", Permissions.ScreenRecording);
        ShowState("AccessState", "AskAccess", Permissions.Accessibility);
    }

    private void ShowState(string state, string ask, bool granted)
    {
        Control<TextBlock>(state).Text = granted ? "Allowed" : "Not allowed";
        Control<Button>(ask).IsEnabled = !granted;
    }

    private T Control<T>(string name)
        where T : Control =>
        this.FindControl<T>(name) ?? throw new InvalidOperationException($"{name} is missing from the window.");
}
