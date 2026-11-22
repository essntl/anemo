using System;
using System.Threading;
using System.Windows.Forms;
using Anemo.Desktop.UI;

namespace Anemo.Desktop;

internal static class Program
{
    /// <summary>"Local\" makes the name per Windows session: one instance per logged-in user.</summary>
    private const string InstanceMutex = @"Local\Anemo.Desktop.SingleInstance";

    [STAThread]
    private static int Main()
    {
        using var mutex = new Mutex(initiallyOwned: true, InstanceMutex, out var first);
        if (!first)
        {
            MessageBox.Show(
                "Anemo Desktop is already running: look for its icon in the notification area.",
                "Anemo Desktop",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return 0;
        }

        ApplicationConfiguration.Initialize();
        using var app = new TrayApp();
        Application.Run(app);
        return 0;
    }
}
