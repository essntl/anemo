using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Protocol;

namespace Anemo.Desktop.Core.Connection;

/// <summary>What the Claude Code job sharing gets of one connection.</summary>
public interface ICodeJobsLink
{
    /// <summary>Sends a text message through the connection's send lock, between commands' results.</summary>
    Task SendAsync(string text, CancellationToken ct);

    /// <summary>Drops the connection; the client connects again as after any drop.</summary>
    void Drop();
}

/// <summary>
/// Claude Code jobs on the connection (device-contracts.md §7): the offer's <c>code</c>
/// field, a loop that runs while connected, and the server's <c>code.ack</c>s.
/// </summary>
public interface ICodeJobsHost
{
    /// <summary>The offer's <c>code</c>: sharing is on and the device is trusted.</summary>
    bool Offered(DeviceInfo device);

    /// <summary>Shares jobs over <paramref name="link"/> until cancelled (the connection ended).</summary>
    Task RunAsync(ICodeJobsLink link, DeviceInfo device, CancellationToken ct);

    /// <summary>A <c>code.ack</c> came in (on the receive loop: must return at once).</summary>
    void OnAck(JsonObject msg);
}
