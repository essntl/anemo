using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;
using Anemo.Desktop.Tests.Fakes;

namespace Anemo.Desktop.Tests.Commands;

/// <summary>A command processor on fake platform services, with helpers to send commands.</summary>
public sealed class ProcessorFixture : IDisposable
{
    public static readonly DeviceInfo Watched = new("dev-1", "Desk PC", "computer", "watched");
    public static readonly DeviceInfo Trusted = new("dev-2", "VM", "computer", "trusted");

    private readonly string _folder = Path.Combine(Path.GetTempPath(), "anemo-desktop-tests", Guid.NewGuid().ToString("N"));

    public ProcessorFixture(DesktopPlatform? platform = null)
    {
        Control = new ControlState(Time, allow: true, pausedUntil: null);
        Log = new CommandLog(_folder, Time);
        Processor = new CommandProcessor(
            Platform.Services,
            Control,
            () => Settings,
            Log,
            new CommandOptions { SettleDelay = TimeSpan.Zero, OpenDelay = TimeSpan.Zero, DefaultWorkFolder = @"C:\Users\me\AnemoWork", Platform = platform ?? DesktopPlatform.Windows });
        Save = new FakeElement { Desktop = Platform.Desktop };
        Name = new FakeElement { CanInvoke = false, Desktop = Platform.Desktop, Point = new ScreenPoint(640, 220) };
        Pass = new FakeElement { Password = true, Desktop = Platform.Desktop };
        Platform.Desktop.Tree = _ => new UiTree(
        [
            new UiNode(0, "window", "Book1 - Excel", null, true, false, false, null),
            new UiNode(1, "button", "Save", null, true, false, true, Save),
            new UiNode(1, "edit", "Name", "Ada", true, false, true, Name),
            new UiNode(1, "edit", "Password", "hunter2", true, true, true, Pass),
            new UiNode(1, "text", "Welcome back", null, true, false, false, null),
        ], false);

        // An ordinary field has the focus unless a test says otherwise.
        Platform.Desktop.Focused = Name;
    }

    public FakePlatform Platform { get; } = new();

    public ManualTime Time { get; } = new();

    public ControlState Control { get; }

    public CommandLog Log { get; }

    public string LogFolder => _folder;

    public CommandProcessor Processor { get; }

    public DesktopSettings Settings { get; set; } = new();

    /// <summary>c1 in the default tree: a button with Invoke.</summary>
    public FakeElement Save { get; }

    /// <summary>c2: an edit without Invoke.</summary>
    public FakeElement Name { get; }

    /// <summary>c3: a password field.</summary>
    public FakeElement Pass { get; }

    public Task<CommandOutcome> Run(string action, JsonObject? fields = null, DeviceInfo? device = null, CancellationToken ct = default)
    {
        var command = new JsonObject { ["type"] = "device.command", ["id"] = Guid.NewGuid().ToString(), ["action"] = action };
        foreach (var (key, value) in fields ?? new JsonObject())
        {
            command[key] = value?.DeepClone();
        }

        return Processor.ExecuteAsync(command, device ?? Watched, ct);
    }

    public async Task<JsonObject> Ok(string action, JsonObject? fields = null, DeviceInfo? device = null)
    {
        var outcome = await Run(action, fields, device);
        Assert.True(outcome.Ok, $"{action} failed: {outcome.Code}: {outcome.Error}");
        return (JsonObject)outcome.State!;
    }

    public async Task<CommandOutcome> Fails(string action, JsonObject? fields, string code, DeviceInfo? device = null)
    {
        var outcome = await Run(action, fields, device);
        Assert.False(outcome.Ok, $"{action} should have failed");
        Assert.Equal(code, outcome.Code);
        return outcome;
    }

    public void Dispose()
    {
        if (Directory.Exists(_folder))
        {
            Directory.Delete(_folder, recursive: true);
        }
    }
}
