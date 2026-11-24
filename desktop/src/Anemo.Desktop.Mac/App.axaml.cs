using Anemo.Desktop.Mac.UI;
using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;

namespace Anemo.Desktop.Mac;

/// <summary>The Avalonia application: no main window, only the menu bar item (<see cref="MenuBarApp"/>).</summary>
public sealed class App : Application
{
    private MenuBarApp? _menuBar;

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            _menuBar = new MenuBarApp(this, () => desktop.Shutdown());
            desktop.Exit += (_, _) => _menuBar.Dispose();
        }

        base.OnFrameworkInitializationCompleted();
    }
}
