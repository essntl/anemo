using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Protocol;

namespace Anemo.Desktop.Core.Commands;

public sealed partial class CommandProcessor
{
    /// <summary>
    /// <c>code_projects</c>, <c>code_start</c>, <c>code_cancel</c> (device-contracts.md §7.4).
    /// Starting a job is as strong as PowerShell, so it also needs control allowed and not
    /// paused (the stop key stops Anemo from starting jobs too); listing and cancelling don't.
    /// </summary>
    private async Task<JsonNode> CodeJobAsync(string action, Args args, DeviceInfo device, CancellationToken ct)
    {
        if (_codeJobs is null)
        {
            throw CommandException.Unavailable("Claude Code jobs can't be started from this copy of Anemo Desktop.");
        }

        if (action == "code_start" && _codeJobs.RefusalReason(action, device) is null)
        {
            RequireControl();
        }

        return await _codeJobs.RunAsync(action, args, device, ct);
    }
}
