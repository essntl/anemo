using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Protocol;

namespace Anemo.Desktop.Core.Commands;

public sealed partial class CommandProcessor
{
    /// <summary>
    /// The file actions (device-contracts.md §8, 1.7.0). They need the device trusted and "Let
    /// Anemo read and write files" on (checked by <see cref="Files.DeviceFiles"/>), not "Allow
    /// control"; but the stop key stops them too: while control is paused nothing is copied.
    /// </summary>
    private JsonNode FileAction(string action, Args args, DeviceInfo device)
    {
        if (_files is null)
        {
            throw CommandException.Unavailable("Files can't be copied with this copy of Anemo Desktop.");
        }

        if (_control.PausedUntil is { } until && action != "file_write_abort")
        {
            throw CommandException.Refused($"The user paused Anemo Desktop on this computer until {until.ToLocalTime():HH:mm}.");
        }

        return _files.Run(action, args, device);
    }
}
