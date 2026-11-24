using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Core.Protocol;
using Anemo.Desktop.Core.Storage;

namespace Anemo.Desktop.Core.Commands;

public sealed class CommandOptions
{
    /// <summary>The wait after an action before the new state is read, so the screen can catch up.</summary>
    public TimeSpan SettleDelay { get; init; } = TimeSpan.FromMilliseconds(400);

    /// <summary>The wait after <c>open</c>: programs take a moment to show their window.</summary>
    public TimeSpan OpenDelay { get; init; } = TimeSpan.FromMilliseconds(1500);

    /// <summary>PowerShell's working folder when none is set (<c>%USERPROFILE%\AnemoWork</c>).</summary>
    public string DefaultWorkFolder { get; init; } = "AnemoWork";

    /// <summary>The system the client runs on (its texts, its key rules).</summary>
    public DesktopPlatform Platform { get; init; } = DesktopPlatform.Windows;
}

/// <summary>
/// Runs the commands of device-contracts.md §3 on this computer. The client's own rules
/// are checked here, whatever the server sent: acting only while control is allowed,
/// PowerShell only on a trusted device with PowerShell switched on, never typing into a
/// password control, nothing on the secure desktop.
/// </summary>
public sealed partial class CommandProcessor : ICommandExecutor
{
    public const string PasswordMessage = "That is a password field: ask the user to type it.";

    public const string UnknownFocusMessage =
        "Anemo Desktop can't tell which control has the focus, so it doesn't type there. Give the control's ref, or click into it first.";

    public const string OwnWindowMessage =
        "That is Anemo Desktop's own window, which the agent can't use. Ask the user to close it.";

    public const string SecureDesktopMessage =
        "Windows is showing its secure screen (a UAC prompt or the lock screen), where no program can look or act. Ask the user to deal with it first.";

    private static readonly HashSet<string> ActingActions = new(StringComparer.Ordinal)
    {
        "click", "double_click", "right_click", "type", "press", "scroll", "focus_window", "open", "clipboard_set",
    };

    private readonly PlatformServices _platform;
    private readonly ControlState _control;
    private readonly Func<DesktopSettings> _settings;
    private readonly CommandLog? _log;
    private readonly CommandOptions _options;
    private readonly CodeJobs.CodeJobControl? _codeJobs;
    private readonly ControlRefs _refs = new();
    private readonly WindowRefs _windows = new();
    private ScreenCapture? _lastCapture;
    private string _lastMode = "window";

    public CommandProcessor(
        PlatformServices platform,
        ControlState control,
        Func<DesktopSettings> settings,
        CommandLog? log = null,
        CommandOptions? options = null,
        CodeJobs.CodeJobControl? codeJobs = null)
    {
        _platform = platform;
        _control = control;
        _settings = settings;
        _log = log;
        _options = options ?? new CommandOptions();
        _codeJobs = codeJobs;
    }

    private IDesktop Desktop => _platform.Desktop;

    public async Task<CommandOutcome> ExecuteAsync(JsonObject command, DeviceInfo device, CancellationToken ct)
    {
        var action = Wire.Str(command, "action") ?? "";
        var refs = _refs.Take();
        CommandOutcome outcome;
        try
        {
            var state = await RunAsync(action, new Args(command), refs, device, ct);
            outcome = CommandOutcome.Success(state);
        }
        catch (CommandException e)
        {
            outcome = CommandOutcome.Fail(e.Code, e.Message);
        }
        catch (ElementGoneException)
        {
            outcome = CommandOutcome.Fail(ResultCodes.Failed, ControlRefs.StaleMessage);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            _log?.Write(CommandSummary.Action(command), CommandSummary.For(command), false, ResultCodes.Stopped);
            throw;
        }
        catch (Exception e)
        {
            // Anything a platform call threw: a sentence for the agent, never the exception's
            // message (it could hold window text).
            outcome = e is UnauthorizedAccessException or TimeoutException
                ? CommandOutcome.Fail(ResultCodes.Unavailable, $"Windows didn't allow that right now ({e.GetType().Name}).")
                : CommandOutcome.Fail(ResultCodes.Failed, $"Anemo Desktop ran into an error doing that ({e.GetType().Name}).");
        }

        _log?.Write(CommandSummary.Action(command), CommandSummary.For(command, outcome.State), outcome.Ok, outcome.Code);
        return outcome;
    }

    private async Task<JsonNode> RunAsync(
        string action, Args args, IReadOnlyDictionary<string, IUiElement> refs, DeviceInfo device, CancellationToken ct)
    {
        if (action == "look")
        {
            RequireNormalDesktop();
            return Look(args, ct);
        }

        if (action == "shell")
        {
            RequireShellAllowed(device);
            return await ShellAsync(args, ct);
        }

        if (CodeJobs.CodeJobControl.Handles(action))
        {
            return await CodeJobAsync(action, args, device, ct);
        }

        if (!ActingActions.Contains(action))
        {
            throw CommandException.Failed($"Unknown action “{action}”");
        }

        RequireControl();
        if (action == "clipboard_set")
        {
            return ClipboardSet(args);
        }

        RequireNormalDesktop();
        await ActAsync(action, args, refs, ct);
        ct.ThrowIfCancellationRequested();
        await Task.Delay(action == "open" ? _options.OpenDelay : _options.SettleDelay, ct);
        return StateAfterAction(ct);
    }

    private void RequireControl()
    {
        if (_control.RefusalReason() is { } reason)
        {
            throw CommandException.Refused(reason);
        }
    }

    private void RequireShellAllowed(DeviceInfo device)
    {
        RequireControl();
        if (!device.Trusted)
        {
            throw CommandException.Refused($"{_options.Platform.ShellName} is only for trusted devices, and this one is watched.");
        }

        if (!_settings().PowerShellEnabled)
        {
            throw CommandException.Refused($"{_options.Platform.ShellName} is switched off in Anemo Desktop on this computer.");
        }
    }

    private void RequireNormalDesktop()
    {
        if (Desktop.IsSecureDesktop())
        {
            throw CommandException.Unavailable(_options.Platform.SecureScreenMessage);
        }
    }

    private JsonNode ClipboardSet(Args args)
    {
        _platform.Clipboard.SetText(args.String("text", 20_000, allowEmpty: true));
        return new JsonObject();
    }
}
